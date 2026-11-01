<?php
require_once __DIR__ . '/session.php';
header('Content-Type: application/json');

function out($ok, $msg = '', $data = null, $code = null) {
    echo json_encode(['success' => $ok, 'message' => $msg, 'data' => $data, 'code' => $code], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
// Logged-in users (valid signed cookie) also get the technical reason, so problems can be diagnosed from the screen.
set_exception_handler(function ($e) { error_log('xmas: ' . $e->getMessage()); out(false, 'Something went wrong on the server. Please try again.' . (!empty($_SESSION['uid']) ? ' [' . substr($e->getMessage(), 0, 300) . ']' : '')); });

$pdo = db();
$action = $_GET['action'] ?? '';
$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) $in = [];

function q($sql, $p = []) { global $pdo; $s = $pdo->prepare($sql); $s->execute($p); return $s; }


function user() {
    static $u = false;
    if ($u !== false) return $u;
    $u = null;
    if (!empty($_SESSION['uid'])) {
        $r = q('SELECT id, username, full_name, role, committee_id, status, password FROM users WHERE id = ?', [$_SESSION['uid']])->fetch();
        if ($r && $r['status'] === 'active' && hash_equals(pw_fp($r['password']), (string)($_SESSION['fp'] ?? ''))) { unset($r['password']); $u = $r; }
    }
    return $u;
}
function need() { $u = user(); if (!$u) out(false, 'Your session has expired. Please log in again.', null, 'auth'); return $u; }
/** Run $fn inside a transaction (all or nothing). */
function tx(callable $fn) {
    global $pdo;
    $pdo->beginTransaction();
    try { $r = $fn(); $pdo->commit(); return $r; }
    catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $e; }
}
/** App settings stored in the `settings` table (season dates). Falls back to defaults if a row is missing. */
function settings() {
    $s = ['season_start' => '2026-11-01', 'season_end' => '2026-12-24'];
    try { foreach (q('SELECT k, v FROM settings')->fetchAll() as $r) if (array_key_exists($r['k'], $s)) $s[$r['k']] = $r['v']; }
    catch (Throwable $e) { error_log('settings: ' . $e->getMessage()); }
    return $s;
}
/** Location choices for schedules (the `locations` table). */
function locations() {
    try { return q('SELECT id, name FROM locations ORDER BY sort_order, id')->fetchAll(); }
    catch (Throwable $e) { error_log('locations: ' . $e->getMessage()); return []; }
}
/** All committees; `can_merge` marks the ones that can share a merged practice. */
function committees() {
    try { return q('SELECT id, name, color, can_merge FROM committees ORDER BY sort_order')->fetchAll(); }
    catch (Throwable $e) { error_log('committees: ' . $e->getMessage()); return q('SELECT id, name, color FROM committees ORDER BY sort_order')->fetchAll(); }
}
function meData($u) {
    $u['committee_name'] = $u['committee_id'] ? q('SELECT name FROM committees WHERE id = ?', [$u['committee_id']])->fetchColumn() : null;
    return ['user' => $u, 'committees' => committees(), 'settings' => settings(), 'locations' => locations()];
}
function isSec($u) { return $u['role'] === 'secretariat'; }
function needSec() { $u = need(); if (!isSec($u)) out(false, 'Only the Secretariat can do this.'); return $u; }
/** null = Secretariat (everything), otherwise the leader's committee id */
function scope($u) {
    if (isSec($u)) return null;
    if (!$u['committee_id']) out(false, 'No committee is assigned to your account. Ask the Secretariat.');
    return (int)$u['committee_id'];
}
function validDate($d) { return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) !== false; }
function cleanTime($t) { $t = trim((string)$t); return preg_match('/^\d{2}:\d{2}/', $t) ? substr($t, 0, 5) . ':00' : null; }
function cut($s, $n) { $s = trim((string)$s); return function_exists('mb_substr') ? mb_substr($s, 0, $n) : substr($s, 0, $n); }
function scholarOf($v) {
    $s = strtolower(preg_replace('/[^a-z]/i', '', (string)$v));
    if ($s === 'shs' || strpos($s, 'seniorhigh') !== false || strpos($s, 'shs') === 0) return 'shs';
    if (strpos($s, 'college') !== false) return 'college';
    return 'none';
}
/** 'leader' for values like Leader / Head / Committee head, otherwise 'member' */
function roleOf($v) {
    $s = strtolower(preg_replace('/[^a-z]/i', '', (string)$v));
    return (strpos($s, 'lead') !== false || strpos($s, 'head') !== false) ? 'leader' : 'member';
}
function norm($s) { return strtolower(preg_replace('/[^a-z0-9]/i', '', (string)$s)); }
/** Find a committee id from a typed name: exact match first, otherwise a single committee whose name contains (or is contained in) the text. */
function committeeByName($name) {
    static $map = null;
    if ($map === null) { $map = []; foreach (q('SELECT id, name FROM committees')->fetchAll() as $c) $map[(int)$c['id']] = norm($c['name']); }
    $n = norm($name);
    if (strlen($n) < 3) return null;
    $hit = array_keys($map, $n, true);
    if (count($hit) === 1) return (int)$hit[0];
    $hit = [];
    foreach ($map as $id => $cn) if ($cn !== '' && (strpos($cn, $n) !== false || strpos($n, $cn) !== false)) $hit[] = $id;
    return count($hit) === 1 ? (int)$hit[0] : null;
}

/** SQL test: is member alias $m expected at event alias $e? An event with no committee rows is for the whole group. */
function expectedSql($e = 'e', $m = 'm') {
    return "(NOT EXISTS (SELECT 1 FROM event_committees x WHERE x.event_id = $e.id) OR EXISTS (SELECT 1 FROM event_committees x WHERE x.event_id = $e.id AND x.committee_id = $m.committee_id))";
}
/** committee ids an event is for, [] = whole group */
function eventCommittees($eventId) {
    return array_map('intval', q('SELECT committee_id FROM event_committees WHERE event_id = ? ORDER BY committee_id', [(int)$eventId])->fetchAll(PDO::FETCH_COLUMN));
}

/** Events visible to $u with present/total/marked counts. $extra is appended to WHERE (trusted SQL). */
function eventList($u, $extra = '', $params = []) {
    $sc = scope($u);
    $vis = $sc ? " AND (NOT EXISTS (SELECT 1 FROM event_committees v WHERE v.event_id = e.id) OR EXISTS (SELECT 1 FROM event_committees v WHERE v.event_id = e.id AND v.committee_id = $sc))" : '';
    $ms = $sc ? " AND m.committee_id = $sc" : '';
    $cnt = [];
    foreach (q("SELECT m.committee_id cid, COUNT(*) c FROM members m WHERE m.status = 'active'$ms GROUP BY m.committee_id")->fetchAll() as $r) $cnt[(int)$r['cid']] = (int)$r['c'];
    $all = array_sum($cnt);
    $att = [];
    foreach (q("SELECT a.event_id, SUM(a.status = 'present') p, COUNT(*) t FROM attendance a JOIN members m ON m.id = a.member_id WHERE 1=1$ms GROUP BY a.event_id")->fetchAll() as $r) $att[(int)$r['event_id']] = [(int)$r['p'], (int)$r['t']];
    $links = [];
    foreach (q('SELECT event_id, committee_id FROM event_committees ORDER BY committee_id')->fetchAll() as $r) $links[(int)$r['event_id']][] = (int)$r['committee_id'];
    $rows = q("SELECT e.id, e.title, e.event_date, e.event_time, e.end_time, e.location, e.kind, e.created_by, u.full_name AS added_by
        FROM events e LEFT JOIN users u ON u.id = e.created_by
        WHERE 1=1$vis $extra ORDER BY e.event_date, e.event_time", $params)->fetchAll();
    foreach ($rows as &$r) {
        $ids = $links[(int)$r['id']] ?? [];
        $a = $att[(int)$r['id']] ?? [0, 0];
        $r['committee_ids'] = $ids;
        $r['total'] = $ids ? array_sum(array_map(fn($c) => $cnt[$c] ?? 0, $ids)) : $all;
        $r['present'] = $a[0]; $r['marked'] = $a[1];
        $r['can_edit'] = (isSec($u) || ($r['kind'] === 'custom' && (int)$r['created_by'] === (int)$u['id'])) ? 1 : 0;
    }
    unset($r);
    return $rows;
}
function eventFor($u, $id) {
    $e = q('SELECT * FROM events WHERE id = ?', [(int)$id])->fetch();
    if (!$e) out(false, 'Event not found.');
    unset($e['committee_id']);
    $e['committee_ids'] = eventCommittees($e['id']);
    $sc = scope($u);
    if ($sc && $e['committee_ids'] && !in_array($sc, $e['committee_ids'], true)) out(false, 'You do not have access to this event.');
    return $e;
}
/** SQL fragment limiting members (alias m) to those $u may see for event $e: a leader only ever gets their own committee. */
function memberScope($u, $e) {
    $sc = scope($u);
    if ($sc) return " AND m.committee_id = $sc";
    return $e['committee_ids'] ? ' AND m.committee_id IN (' . implode(',', $e['committee_ids']) . ')' : '';
}

/** Every active leader login account is also a "Leader" member of their committee (so they appear in attendance, members and records). */
function syncLeaders() {
    $us = q("SELECT full_name, committee_id FROM users WHERE role = 'leader' AND status = 'active' AND committee_id IS NOT NULL")->fetchAll();
    foreach ($us as $lu) {
        $name = trim($lu['full_name']);
        if ($name === '') continue;
        $m = q('SELECT id, member_role FROM members WHERE LOWER(TRIM(full_name)) = ? AND committee_id = ?', [strtolower($name), $lu['committee_id']])->fetch();
        if (!$m) q("INSERT INTO members (full_name, committee_id, ministry, member_role, scholar_type, status) VALUES (?,?,?,?,?,?)", [cut($name, 100), $lu['committee_id'], '', 'leader', 'none', 'active']);
        elseif ($m['member_role'] !== 'leader') q("UPDATE members SET member_role = 'leader' WHERE id = ?", [$m['id']]);
    }
}

/** Creates anything the app needs that the database lacks. Additive only; runs once per server instance. */
function ensureSchema($force = false) {
    global $pdo;
    $errs = [];
    $flag = sys_get_temp_dir() . '/mq_schema_v2';
    if (!$force && is_file($flag)) return $errs;
    $hasTable = fn($t) => (bool)q('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [$t])->fetchColumn();
    $hasCol = fn($t, $c) => (bool)q('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [$t, $c])->fetchColumn();
    $run = function ($sql) use ($pdo, &$errs) { try { $pdo->exec($sql); } catch (Throwable $e) { error_log('schema: ' . $e->getMessage() . ' :: ' . $sql); $errs[] = substr($sql, 0, 80) . ' => ' . $e->getMessage(); } };

    $freshLinks = !$hasTable('event_committees');
    $run("CREATE TABLE IF NOT EXISTS event_committees (event_id BIGINT NOT NULL, committee_id BIGINT NOT NULL, PRIMARY KEY (event_id, committee_id))");
    $run("CREATE TABLE IF NOT EXISTS locations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, sort_order INT NOT NULL DEFAULT 0)");
    $run("CREATE TABLE IF NOT EXISTS settings (k VARCHAR(50) NOT NULL PRIMARY KEY, v VARCHAR(255) NOT NULL)");
    $run("CREATE TABLE IF NOT EXISTS rate_limits (id INT AUTO_INCREMENT PRIMARY KEY, rkey VARCHAR(150) NOT NULL, hit_at INT NOT NULL, KEY k1 (rkey, hit_at))");

    // old single-committee column -> new link table
    if ($hasCol('events', 'committee_id')) {
        if ($freshLinks) $run('INSERT IGNORE INTO event_committees (event_id, committee_id) SELECT id, committee_id FROM events WHERE committee_id IS NOT NULL AND committee_id > 0');
        $run('ALTER TABLE events MODIFY committee_id INT NULL');
    }
    foreach ([
        ['committees', 'can_merge', 'TINYINT NOT NULL DEFAULT 0'],
        ['events', 'kind', "VARCHAR(10) NOT NULL DEFAULT 'fixed'"],
        ['events', 'end_time', 'TIME NULL'],
        ['events', 'location', 'VARCHAR(150) NULL'],
        ['events', 'created_by', 'BIGINT NULL'],
        ['members', 'member_role', "VARCHAR(10) NOT NULL DEFAULT 'member'"],
        ['members', 'scholar_type', "VARCHAR(10) NOT NULL DEFAULT 'none'"],
        ['members', 'ministry', 'VARCHAR(100) NULL'],
        ['attendance', 'time_in', 'TIME NULL'],
        ['attendance', 'reason', 'VARCHAR(255) NULL'],
        ['attendance', 'marked_by', 'BIGINT NULL'],
        ['attendance', 'marked_at', 'DATETIME NULL'],
    ] as [$t, $c, $ddl]) if (!$hasCol($t, $c)) $run("ALTER TABLE `$t` ADD COLUMN `$c` $ddl");

    // att_save relies on this unique key (ON DUPLICATE KEY UPDATE); without it, saving twice creates duplicate rows
    if (!q("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND NON_UNIQUE = 0 AND COLUMN_NAME = 'event_id' LIMIT 1")->fetchColumn())
        $run('ALTER TABLE attendance ADD UNIQUE KEY uq_att (member_id, event_id)');
    @file_put_contents($flag, '1');
    return $errs;
}
try { ensureSchema(); } catch (Throwable $e) { error_log('ensureSchema: ' . $e->getMessage()); }

if ($action === 'ping') { q('SELECT 1'); out(true, 'ok'); }
if ($action !== 'login') need();

switch ($action) {

    case 'login': {
        $un = trim((string)($in['username'] ?? ''));
        $pw = (string)($in['password'] ?? '');
        if ($un === '' || $pw === '') out(false, 'Enter your username and password.');
        $key = substr(($_SERVER['REMOTE_ADDR'] ?? 'x') . '|' . strtolower($un), 0, 150);
        $n = (int)q('SELECT COUNT(*) FROM rate_limits WHERE rkey = ? AND hit_at > ?', [$key, time() - 900])->fetchColumn();
        if ($n >= 5) out(false, 'Too many failed attempts. Please wait 15 minutes.');
        $r = q('SELECT * FROM users WHERE username = ?', [$un])->fetch();
        if (!$r || !password_verify($pw, $r['password'])) {
            q('INSERT INTO rate_limits (rkey, hit_at) VALUES (?,?)', [$key, time()]);
            if (random_int(1, 40) === 1) q('DELETE FROM rate_limits WHERE hit_at < ?', [time() - 86400]);
            out(false, 'Wrong username or password.');
        }
        if ($r['status'] !== 'active') out(false, 'This account is disabled. Ask the Secretariat.');
        if ($n) q('DELETE FROM rate_limits WHERE rkey = ?', [$key]);
        set_login((int)$r['id'], $r['password']);
        if ($r['role'] === 'secretariat') { try { syncLeaders(); } catch (Throwable $e) { error_log('syncLeaders: ' . $e->getMessage()); } }
        $lu = ['id' => $r['id'], 'username' => $r['username'], 'full_name' => $r['full_name'], 'role' => $r['role'], 'committee_id' => $r['committee_id'], 'status' => $r['status']];
        out(true, 'Welcome!', meData($lu));
    }

    case 'logout': { clear_login(); out(true); }

    /* Secretariat-only health check: open  /api.php?action=diag  in the browser while logged in. */
    case 'diag': {
        $u = needSec();
        $r = ['php' => PHP_VERSION, 'database' => $pdo->query('SELECT DATABASE()')->fetchColumn(), 'schema_errors' => ensureSchema(true), 'tables' => [], 'steps' => []];
        foreach (['users', 'committees', 'members', 'events', 'attendance', 'event_committees', 'locations', 'settings', 'rate_limits'] as $t) {
            try {
                $cols = q('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [$t])->fetchAll(PDO::FETCH_COLUMN);
                $r['tables'][$t] = $cols ? ['columns' => implode(', ', $cols), 'rows' => (int)$pdo->query("SELECT COUNT(*) FROM `$t`")->fetchColumn()] : 'MISSING';
            } catch (Throwable $e) { $r['tables'][$t] = 'ERROR: ' . $e->getMessage(); }
        }
        $today = date('Y-m-d');
        $steps = [
            'eventList' => fn() => count(eventList($u, 'AND e.event_date >= ?', [$today])),
            'rate_query' => fn() => count(q("SELECT m.committee_id cid, SUM(a.status = 'present') p, SUM(a.id IS NOT NULL) t
                FROM events e CROSS JOIN members m LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
                WHERE m.status = 'active' AND " . expectedSql() . " AND e.event_date <= ? GROUP BY m.committee_id", [$today])->fetchAll()),
            'committees_query' => fn() => count(q("SELECT c.id, c.name, c.color, (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.id AND m.status = 'active') AS members FROM committees c ORDER BY c.sort_order")->fetchAll()),
            'committees()' => fn() => count(committees()),
            'settings()' => fn() => json_encode(settings()),
            'records_query' => fn() => count(q("SELECT e.id FROM events e CROSS JOIN members m JOIN committees c ON c.id = m.committee_id
                LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
                WHERE " . expectedSql() . " AND e.event_date BETWEEN ? AND ? AND (m.status = 'active' OR a.id IS NOT NULL) LIMIT 5", [$today, $today])->fetchAll()),
        ];
        foreach ($steps as $k => $fn) {
            try { $r['steps'][$k] = 'ok: ' . $fn(); } catch (Throwable $e) { $r['steps'][$k] = 'ERROR: ' . $e->getMessage(); }
        }
        out(true, '', $r);
    }

    case 'me': { out(true, '', meData(need())); }

    case 'dashboard': {
        $u = need(); $sc = scope($u); $today = date('Y-m-d');
        $ms = $sc ? " AND committee_id = $sc" : '';
        $members = (int)q("SELECT COUNT(*) FROM members WHERE status = 'active'$ms")->fetchColumn();
        $evs = eventList($u, 'AND e.event_date >= ?', [$today]);
        $todayEv = array_values(array_filter($evs, fn($e) => $e['event_date'] === $today));
        $upcoming = array_slice(array_values(array_filter($evs, fn($e) => $e['event_date'] > $today)), 0, 6);
        $mw = $sc ? " AND m.committee_id = $sc" : '';
        $rate = [];
        foreach (q("SELECT m.committee_id cid, SUM(a.status = 'present') p, SUM(a.id IS NOT NULL) t
            FROM events e CROSS JOIN members m
            LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
            WHERE m.status = 'active' AND " . expectedSql() . "$mw AND e.event_date <= ?
            GROUP BY m.committee_id", [$today])->fetchAll() as $r) $rate[$r['cid']] = [(int)$r['p'], (int)$r['t']];
        $cw = $sc ? "WHERE c.id = $sc" : '';
        $coms = q("SELECT c.id, c.name, c.color, (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.id AND m.status = 'active') AS members FROM committees c $cw ORDER BY c.sort_order")->fetchAll();
        foreach ($coms as &$c) { $rt = $rate[$c['id']] ?? [0, 0]; $c['rate'] = $rt[1] ? round($rt[0] / $rt[1] * 100) : null; }
        unset($c);
        out(true, '', ['members' => $members, 'today' => $todayEv, 'present_today' => array_sum(array_column($todayEv, 'present')), 'upcoming' => $upcoming, 'committees' => $coms]);
    }

    /* ---------------- Events / schedule ---------------- */
    case 'events_list': { out(true, '', eventList(need())); }

    case 'event_save': {
        $u = need();
        $id = (int)($in['id'] ?? 0);
        $title = cut($in['title'] ?? '', 120);
        $time = ($in['event_time'] ?? '') === '' ? null : cleanTime($in['event_time']);
        $end  = ($in['end_time'] ?? '') === '' ? null : cleanTime($in['end_time']);
        $loc = cut($in['location'] ?? '', 150);
        $dates = $id ? [$in['event_date'] ?? ''] : (is_array($in['dates'] ?? null) ? $in['dates'] : [$in['event_date'] ?? '']);
        $dates = array_values(array_unique(array_map('strval', $dates)));
        if ($title === '') out(false, 'Please type what the schedule is.');
        if (!$dates || count($dates) > 62) out(false, 'Pick at least one date (up to 62).');
        foreach ($dates as $d) if (!validDate($d)) out(false, 'One of the dates is invalid.');
        if ($end && !$time) out(false, 'Add a start time too.');
        if ($end && $time && $end <= $time) out(false, 'End time must be after the start time.');
        if ($loc !== '') { // must be one of the saved locations (an unchanged old value on an existing schedule is also accepted)
            $okLoc = q('SELECT 1 FROM locations WHERE name = ?', [$loc])->fetchColumn();
            if (!$okLoc && $id) $okLoc = q('SELECT 1 FROM events WHERE id = ? AND location = ?', [$id, $loc])->fetchColumn();
            if (!$okLoc) out(false, 'Choose a location from the list.');
        }
        if (isSec($u)) {
            $cids = array_values(array_unique(array_filter(array_map('intval', (array)($in['committee_ids'] ?? [])))));
            if ($cids) {
                $ph = implode(',', array_fill(0, count($cids), '?'));
                if ((int)q("SELECT COUNT(*) FROM committees WHERE id IN ($ph)", $cids)->fetchColumn() !== count($cids)) out(false, 'Invalid committee.');
                if (count($cids) > 1 && (int)q("SELECT COUNT(*) FROM committees WHERE can_merge = 1 AND id IN ($ph)", $cids)->fetchColumn() !== count($cids)) out(false, 'Only committees set up for merged practice can be combined.');
            }
            $kind = $cids ? 'custom' : 'fixed';
        } else {
            $cids = [scope($u)]; $kind = 'custom';
        }
        $link = function ($eid) use ($cids) { foreach ($cids as $c) q('INSERT INTO event_committees (event_id, committee_id) VALUES (?,?)', [$eid, $c]); };
        if ($id) {
            $e = q('SELECT * FROM events WHERE id = ?', [$id])->fetch();
            if (!$e) out(false, 'Event not found.');
            if (!isSec($u) && !($e['kind'] === 'custom' && (int)$e['created_by'] === (int)$u['id'])) out(false, 'You can only edit schedules you added.');
            tx(function () use ($title, $dates, $time, $end, $loc, $kind, $id, $link) {
                q('UPDATE events SET title=?, event_date=?, event_time=?, end_time=?, location=?, kind=? WHERE id=?', [$title, $dates[0], $time, $end, $loc, $kind, $id]);
                q('DELETE FROM event_committees WHERE event_id = ?', [$id]);
                $link($id);
            });
            out(true, 'Schedule updated.');
        }
        try {
            tx(function () use ($dates, $title, $time, $end, $loc, $kind, $u, $link, $pdo) {
                $ins = $pdo->prepare('INSERT INTO events (title, event_date, event_time, end_time, location, kind, created_by) VALUES (?,?,?,?,?,?,?)');
                foreach ($dates as $d) { $ins->execute([$title, $d, $time, $end, $loc, $kind, $u['id']]); $link((int)$pdo->lastInsertId()); }
            });
        } catch (Throwable $ex) {
            error_log('event_save: ' . $ex->getMessage());
            out(false, 'Could not save the schedule. Please try again.');
        }
        out(true, count($dates) . (count($dates) > 1 ? ' schedules added.' : ' schedule added.'));
    }

    case 'event_delete': {
        $u = need();
        $e = q('SELECT * FROM events WHERE id = ?', [(int)($in['id'] ?? 0)])->fetch();
        if (!$e) out(false, 'Event not found.');
        if (!isSec($u) && !($e['kind'] === 'custom' && (int)$e['created_by'] === (int)$u['id'])) out(false, 'You can only delete schedules you added.');
        tx(function () use ($e) {
            q('DELETE FROM attendance WHERE event_id = ?', [$e['id']]);
            q('DELETE FROM event_committees WHERE event_id = ?', [$e['id']]);
            q('DELETE FROM events WHERE id = ?', [$e['id']]);
        });
        out(true, 'Schedule and its attendance deleted.');
    }

    case 'events_bulk_delete': {
        needSec();
        if (($in['confirm'] ?? '') !== 'CONFIRM') out(false, 'Type CONFIRM to delete.');
        $ids = array_values(array_unique(array_filter(array_map('intval', (array)($in['ids'] ?? [])))));
        if (!$ids) out(false, 'Select at least one schedule.');
        if (count($ids) > 500) out(false, 'Too many selected at once (max 500).');
        $ph = implode(',', array_fill(0, count($ids), '?'));
        try {
            $pdo->beginTransaction();
            $da = $pdo->prepare("DELETE FROM attendance WHERE event_id IN ($ph)"); $da->execute($ids);
            $pdo->prepare("DELETE FROM event_committees WHERE event_id IN ($ph)")->execute($ids);
            $de = $pdo->prepare("DELETE FROM events WHERE id IN ($ph)"); $de->execute($ids);
            $pdo->commit();
        } catch (Throwable $ex) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('events_bulk_delete: ' . $ex->getMessage());
            out(false, 'Could not delete the schedules. Please try again.');
        }
        $ne = $de->rowCount(); $na = $da->rowCount();
        out(true, "$ne schedule" . ($ne === 1 ? '' : 's') . " and $na attendance record" . ($na === 1 ? '' : 's') . ' deleted.');
    }

    /* ---------------- Attendance ---------------- */
    case 'att_get': {
        $u = need(); $e = eventFor($u, $in['event_id'] ?? 0); $w = memberScope($u, $e);
        // Leaders always first, then by committee, then by name
        $rows = q("SELECT m.id AS member_id, m.full_name, m.ministry, m.scholar_type, m.member_role, m.committee_id, c.name AS committee_name, a.status, a.time_in, a.reason
            FROM members m JOIN committees c ON c.id = m.committee_id
            LEFT JOIN attendance a ON a.member_id = m.id AND a.event_id = ?
            WHERE (m.status = 'active' OR a.id IS NOT NULL)$w ORDER BY (m.member_role = 'leader') DESC, c.sort_order, m.full_name", [$e['id']])->fetchAll();
        out(true, '', ['event' => $e, 'members' => $rows]);
    }

    case 'att_save': {
        $u = need(); $e = eventFor($u, $in['event_id'] ?? 0); $w = memberScope($u, $e);
        $allowed = array_flip(array_map('intval', q("SELECT m.id FROM members m WHERE 1=1$w")->fetchAll(PDO::FETCH_COLUMN)));
        $recs = is_array($in['records'] ?? null) ? $in['records'] : [];
        $clean = []; $del = [];
        foreach ($recs as $r) {
            $mid = (int)($r['member_id'] ?? 0);
            if (!isset($allowed[$mid])) continue;
            if (($r['status'] ?? '') === 'clear') { $del[] = $mid; continue; } // un-marked: remove the saved record
            $st = in_array($r['status'] ?? '', ['present', 'absent', 'excused'], true) ? $r['status'] : 'absent';
            $reason = $st === 'excused' ? cut($r['reason'] ?? '', 255) : null;
            if ($st === 'excused' && $reason === '') out(false, 'Please type a reason for every excused member.');
            $t = $st === 'present' ? (cleanTime($r['time_in'] ?? '') ?: date('H:i:s')) : null;
            $clean[] = [$mid, $st, $t, $reason];
        }
        if (!$clean && !$del) out(false, 'There are no members to save.');
        try {
            $pdo->beginTransaction();
            $dl = $pdo->prepare('DELETE FROM attendance WHERE member_id = ? AND event_id = ?');
            foreach ($del as $mid) $dl->execute([$mid, $e['id']]);
            $ins = $pdo->prepare('INSERT INTO attendance (member_id, event_id, status, time_in, reason, marked_by, marked_at) VALUES (?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE status = VALUES(status), time_in = VALUES(time_in), reason = VALUES(reason), marked_by = VALUES(marked_by), marked_at = VALUES(marked_at)');
            foreach ($clean as [$mid, $st, $t, $reason]) $ins->execute([$mid, $e['id'], $st, $t, $reason, $u['id'], date('Y-m-d H:i:s')]);
            $pdo->commit();
        } catch (Throwable $ex) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('att_save: ' . $ex->getMessage());
            out(false, 'Could not save attendance. Please try again.');
        }
        out(true, 'Attendance saved.');
    }

    /* ---------------- Members ---------------- */
    case 'members_list': {
        $u = need(); $sc = scope($u);
        $w = $sc ? "WHERE m.committee_id = $sc" : '';
        out(true, '', q("SELECT m.*, c.name AS committee_name FROM members m JOIN committees c ON c.id = m.committee_id $w ORDER BY (m.member_role = 'leader') DESC, c.sort_order, m.full_name")->fetchAll());
    }

    case 'member_save': {
        $u = need(); $sc = scope($u);
        $id = (int)($in['id'] ?? 0);
        $name = cut($in['full_name'] ?? '', 100);
        $cid = $sc ?: (int)($in['committee_id'] ?? 0);
        $min = cut($in['ministry'] ?? '', 100);
        $sch = in_array($in['scholar_type'] ?? '', ['none', 'shs', 'college'], true) ? $in['scholar_type'] : 'none';
        $role = ($in['member_role'] ?? '') === 'leader' ? 'leader' : 'member';
        $st = ($in['status'] ?? '') === 'inactive' ? 'inactive' : 'active';
        if ($name === '') out(false, 'Name is required.');
        if (!$cid || !q('SELECT id FROM committees WHERE id = ?', [$cid])->fetch()) out(false, 'Choose a committee.');
        $dup = q('SELECT id FROM members WHERE LOWER(TRIM(full_name)) = ? AND committee_id = ? AND id <> ?', [strtolower($name), $cid, $id])->fetch();
        if ($dup) out(false, 'That name is already in this committee.');
        if ($id) {
            $m = q('SELECT committee_id FROM members WHERE id = ?', [$id])->fetch();
            if (!$m) out(false, 'Member not found.');
            if ($sc && (int)$m['committee_id'] !== $sc) out(false, 'You can only edit members of your committee.');
            q('UPDATE members SET full_name=?, committee_id=?, ministry=?, member_role=?, scholar_type=?, status=? WHERE id=?', [$name, $cid, $min, $role, $sch, $st, $id]);
            out(true, 'Member updated.');
        }
        q('INSERT INTO members (full_name, committee_id, ministry, member_role, scholar_type, status) VALUES (?,?,?,?,?,?)', [$name, $cid, $min, $role, $sch, $st]);
        out(true, 'Member added.');
    }

    case 'member_delete': {
        needSec();
        $id = (int)($in['id'] ?? 0);
        tx(function () use ($id) {
            q('DELETE FROM attendance WHERE member_id = ?', [$id]);
            q('DELETE FROM members WHERE id = ?', [$id]);
        });
        out(true, 'Member and their attendance deleted.');
    }

    case 'members_import': {
        needSec();
        $rows = is_array($in['rows'] ?? null) ? array_slice($in['rows'], 0, 1500) : [];
        $added = 0; $skipped = 0; $bad = [];
        $chk = $pdo->prepare('SELECT id FROM members WHERE LOWER(TRIM(full_name)) = ? AND committee_id = ?');
        $ins = $pdo->prepare('INSERT INTO members (full_name, committee_id, ministry, member_role, scholar_type, status) VALUES (?,?,?,?,?,?)');
        foreach ($rows as $i => $r) {
            $name = cut($r['full_name'] ?? '', 100);
            if ($name === '') continue;
            $cid = committeeByName($r['committee'] ?? '');
            if (!$cid) { $bad[] = $name . ' (committee "' . cut($r['committee'] ?? '', 30) . '")'; continue; }
            $chk->execute([strtolower($name), $cid]);
            if ($chk->fetch()) { $skipped++; continue; }
            $ins->execute([$name, $cid, cut($r['ministry'] ?? '', 100), roleOf($r['role'] ?? ''), scholarOf($r['scholar'] ?? ''), 'active']);
            $added++;
        }
        $msg = "$added added, $skipped already existed";
        if ($bad) $msg .= ', ' . count($bad) . ' skipped (unknown committee): ' . implode('; ', array_slice($bad, 0, 5));
        out(true, $msg . '.');
    }

    case 'members_bulk': {
        $u = need(); $sc = scope($u);
        $cid = $sc ?: (int)($in['committee_id'] ?? 0);
        if (!$cid || !q('SELECT id FROM committees WHERE id = ?', [$cid])->fetch()) out(false, 'Choose a committee.');
        $rows = is_array($in['rows'] ?? null) ? array_slice($in['rows'], 0, 500) : [];
        $added = 0; $skipped = 0; $seen = [];
        $chk = $pdo->prepare('SELECT id FROM members WHERE LOWER(TRIM(full_name)) = ? AND committee_id = ?');
        $ins = $pdo->prepare('INSERT INTO members (full_name, committee_id, ministry, member_role, scholar_type, status) VALUES (?,?,?,?,?,?)');
        foreach ($rows as $r) {
            $name = cut($r['full_name'] ?? '', 100);
            if ($name === '') continue;
            $k = strtolower($name);
            if (isset($seen[$k])) { $skipped++; continue; }
            $seen[$k] = true;
            $chk->execute([$k, $cid]);
            if ($chk->fetch()) { $skipped++; continue; }
            $ins->execute([$name, $cid, cut($r['ministry'] ?? '', 100), roleOf($r['role'] ?? ''), scholarOf($r['scholar'] ?? ''), 'active']);
            $added++;
        }
        if (!$added && !$skipped) out(false, 'Type at least one full name.');
        out(true, "$added member" . ($added === 1 ? '' : 's') . " added" . ($skipped ? ", $skipped skipped (already in the list)" : '') . '.');
    }

    /* ---------------- Records ---------------- */
    case 'records': {
        $u = need(); $sc = scope($u);
        $from = $in['from'] ?? ''; $to = $in['to'] ?? '';
        if (!validDate($from) || !validDate($to)) out(false, 'Choose a valid date range.');
        if ($from > $to) out(false, 'The start date must be before the end date.');
        if ((strtotime($to) - strtotime($from)) > 86400 * 400) out(false, 'Date range is too large.');
        $w = $sc ? " AND m.committee_id = $sc" : '';
        $cids = array_values(array_filter(array_map('intval', (array)($in['committee_ids'] ?? []))));
        if ($cids) $w .= ' AND m.committee_id IN (' . implode(',', $cids) . ')';
        $sch = array_values(array_intersect(['none', 'shs', 'college'], array_map('strval', (array)($in['scholar_types'] ?? []))));
        if ($sch && count($sch) < 3) $w .= " AND m.scholar_type IN ('" . implode("','", $sch) . "')";
        if (($in['role'] ?? '') === 'leader') $w .= " AND m.member_role = 'leader'";
        $rows = q("SELECT e.id AS event_id, e.title AS event, e.event_date AS date, e.event_time AS time,
            m.id AS member_id, m.full_name AS member, c.name AS committee, m.ministry, m.member_role AS role, m.scholar_type AS scholar,
            COALESCE(a.status, 'pending') AS status, a.time_in, a.reason
            FROM events e
            CROSS JOIN members m
            JOIN committees c ON c.id = m.committee_id
            LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
            WHERE " . expectedSql() . " AND e.event_date BETWEEN ? AND ? AND (m.status = 'active' OR a.id IS NOT NULL)$w
            ORDER BY e.event_date, e.event_time, (m.member_role = 'leader') DESC, c.sort_order, m.full_name", [$from, $to])->fetchAll();
        if (count($rows) > 60000) out(false, 'Too many records. Narrow the date range or committees.');
        $names = [];
        foreach (q('SELECT x.event_id, c2.name FROM event_committees x JOIN committees c2 ON c2.id = x.committee_id ORDER BY c2.sort_order')->fetchAll() as $r) $names[(int)$r['event_id']][] = $r['name'];
        foreach ($rows as &$r) $r['event_for'] = isset($names[(int)$r['event_id']]) ? implode(', ', $names[(int)$r['event_id']]) : null;
        unset($r);
        out(true, '', $rows);
    }

    /* ---------------- Leader accounts (Secretariat only) ---------------- */
    case 'users_list': {
        needSec();
        out(true, '', q('SELECT u.id, u.username, u.full_name, u.role, u.committee_id, u.status, c.name AS committee_name
            FROM users u LEFT JOIN committees c ON c.id = u.committee_id ORDER BY u.role DESC, c.sort_order, u.full_name')->fetchAll());
    }

    case 'user_save': {
        $me = needSec();
        $id = (int)($in['id'] ?? 0);
        $name = cut($in['full_name'] ?? '', 100);
        $un = cut($in['username'] ?? '', 50);
        $pw = (string)($in['password'] ?? '');
        $role = ($in['role'] ?? '') === 'secretariat' ? 'secretariat' : 'leader';
        $cid = (int)($in['committee_id'] ?? 0) ?: null;
        $st = ($in['status'] ?? '') === 'disabled' ? 'disabled' : 'active';
        if ($name === '' || $un === '') out(false, 'Name and username are required.');
        if (!preg_match('/^[A-Za-z0-9._-]{3,50}$/', $un)) out(false, 'Username: 3-50 letters, numbers, dot, dash or underscore.');
        if ($role === 'leader') {
            if (!$cid || !q('SELECT id FROM committees WHERE id = ?', [$cid])->fetch()) out(false, 'Choose the leader\'s committee.');
        } else $cid = null;
        if (q('SELECT id FROM users WHERE username = ? AND id <> ?', [$un, $id])->fetch()) out(false, 'That username is already taken.');
        if ($id) {
            if ($id === (int)$me['id'] && ($st === 'disabled' || $role !== 'secretariat')) out(false, 'You cannot disable or demote your own account.');
            if ($pw !== '') {
                if (strlen($pw) < 6) out(false, 'Password must be at least 6 characters.');
                $nh = password_hash($pw, PASSWORD_BCRYPT);
                q('UPDATE users SET full_name=?, username=?, role=?, committee_id=?, status=?, password=? WHERE id=?', [$name, $un, $role, $cid, $st, $nh, $id]);
                if ($id === (int)$me['id']) set_login($id, $nh); // keep your own device signed in after changing your own password
            } else {
                q('UPDATE users SET full_name=?, username=?, role=?, committee_id=?, status=? WHERE id=?', [$name, $un, $role, $cid, $st, $id]);
            }
            try { syncLeaders(); } catch (Throwable $e) {}
            out(true, 'Account updated.');
        }
        if (strlen($pw) < 6) out(false, 'Give the new account a password of at least 6 characters.');
        q('INSERT INTO users (username, password, full_name, role, committee_id, status) VALUES (?,?,?,?,?,?)', [$un, password_hash($pw, PASSWORD_BCRYPT), $name, $role, $cid, $st]);
        try { syncLeaders(); } catch (Throwable $e) {}
        out(true, 'Account created. Give the username and password to the leader.');
    }

    case 'user_delete': {
        $me = needSec();
        $id = (int)($in['id'] ?? 0);
        if ($id === (int)$me['id']) out(false, 'You cannot delete your own account.');
        q('DELETE FROM users WHERE id = ?', [$id]);
        out(true, 'Account deleted. Attendance they marked is kept.');
    }

    case 'location_save': {
        needSec();
        $name = cut($in['name'] ?? '', 100);
        if ($name === '') out(false, 'Type a location name.');
        if (q('SELECT id FROM locations WHERE name = ?', [$name])->fetch()) out(false, 'That location already exists.');
        q('INSERT INTO locations (name, sort_order) SELECT ?, COALESCE(MAX(sort_order), 0) + 1 FROM locations', [$name]);
        out(true, 'Location added.', locations());
    }

    case 'location_delete': {
        needSec();
        q('DELETE FROM locations WHERE id = ?', [(int)($in['id'] ?? 0)]);
        out(true, 'Location removed. Schedules already using it keep their text.', locations());
    }

    case 'settings_save': {
        needSec();
        $a = (string)($in['season_start'] ?? ''); $b = (string)($in['season_end'] ?? '');
        if (!validDate($a) || !validDate($b)) out(false, 'Choose valid dates.');
        if ($a > $b) out(false, 'The first day must be before the last day.');
        if ((strtotime($b) - strtotime($a)) > 86400 * 400) out(false, 'The season is too long (max 400 days).');
        $up = $pdo->prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)');
        foreach (['season_start' => $a, 'season_end' => $b] as $k => $v) $up->execute([$k, $v]);
        out(true, 'Season dates saved.', ['season_start' => $a, 'season_end' => $b]);
    }

    case 'change_password': {
        $u = need();
        $cur = (string)($in['current'] ?? ''); $new = (string)($in['password'] ?? '');
        if (strlen($new) < 6) out(false, 'New password must be at least 6 characters.');
        $h = q('SELECT password FROM users WHERE id = ?', [$u['id']])->fetchColumn();
        if (!$h || !password_verify($cur, $h)) out(false, 'Your current password is wrong.');
        $nh = password_hash($new, PASSWORD_BCRYPT);
        q('UPDATE users SET password = ? WHERE id = ?', [$nh, $u['id']]);
        set_login((int)$u['id'], $nh); // keep this device signed in; every other device is signed out
        out(true, 'Password changed.');
    }

    /* Cheap change detector the pages poll every few seconds (no data, just a fingerprint). */
    case 'pulse': {
        $u = need(); $sc = scope($u);
        $mj = $sc ? " WHERE m.committee_id = $sc" : '';
        $ms = $sc ? " WHERE committee_id = $sc" : '';
        $a = q("SELECT COUNT(*) c, COALESCE(MAX(a.marked_at), '') t, COALESCE(SUM(a.status = 'present'), 0) p, COALESCE(SUM(a.status = 'excused'), 0) x FROM attendance a JOIN members m ON m.id = a.member_id$mj")->fetch();
        $m = q("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT(id, '-', full_name, '-', committee_id, '-', member_role, '-', status, '-', scholar_type, '-', COALESCE(ministry, '')))), 0) s FROM members$ms")->fetch();
        $e = q("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT(id, '-', title, '-', event_date, '-', COALESCE(event_time, ''), '-', COALESCE(end_time, ''), '-', COALESCE(location, '')))), 0) s FROM events")->fetch();
        $ec = q("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT(event_id, '-', committee_id))), 0) s FROM event_committees")->fetch();
        out(true, '', ['hash' => md5(json_encode([$a, $m, $e, $ec]))]);
    }

    default: out(false, 'Unknown action.');
}
