<?php
require_once __DIR__ . '/session.php';
header('Content-Type: application/json');

function out($ok, $msg = '', $data = null, $code = null) {
    echo json_encode(['success' => $ok, 'message' => $msg, 'data' => $data, 'code' => $code], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
set_exception_handler(function ($e) { error_log('xmas: ' . $e->getMessage()); out(false, 'Something went wrong on the server. Please try again.'); });

$pdo = db();
$action = $_GET['action'] ?? '';
$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) $in = [];

function q($sql, $p = []) { global $pdo; $s = $pdo->prepare($sql); $s->execute($p); return $s; }

/* Self-heal: add members.member_role if the database doesn't have it yet (no manual SQL needed). */
try {
    $hasRole = (int)q("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = 'member_role'")->fetchColumn();
    if (!$hasRole) $pdo->exec("ALTER TABLE members ADD COLUMN member_role ENUM('member','leader') NOT NULL DEFAULT 'member' AFTER ministry");
} catch (Throwable $e) { error_log('member_role migration: ' . $e->getMessage()); }
function user() {
    static $u = false;
    if ($u !== false) return $u;
    $u = null;
    if (!empty($_SESSION['uid'])) {
        $r = q('SELECT id, username, full_name, role, committee_id, status FROM users WHERE id = ?', [$_SESSION['uid']])->fetch();
        if ($r && $r['status'] === 'active') $u = $r;
    }
    return $u;
}
function need() { $u = user(); if (!$u) out(false, 'Your session has expired. Please log in again.', null, 'auth'); return $u; }
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
function committeeByName($name) {
    static $map = null;
    if ($map === null) {
        $map = [];
        foreach (q('SELECT id, name FROM committees')->fetchAll() as $c) $map[norm($c['name'])] = (int)$c['id'];
        $map['foodcommittee'] = $map['foodcom'] ?? null;
        $map['dance'] = $map['finaldance'] ?? null;
        $map['character'] = $map['characters'] ?? null;
        $map['prop'] = $map['props'] ?? null;
    }
    return $map[norm($name)] ?? null;
}

/** Events visible to $u with present/total/marked counts. $extra is appended to WHERE (trusted SQL). */
function eventList($u, $extra = '', $params = []) {
    $sc = scope($u);
    $vis = $sc ? " AND (e.committee_id IS NULL OR e.committee_id = $sc)" : '';
    $ms = $sc ? " AND m.committee_id = $sc" : '';
    $rows = q("SELECT e.id, e.title, e.event_date, e.event_time, e.end_time, e.location, e.committee_id, e.kind, e.created_by, (SELECT u.full_name FROM users u WHERE u.id = e.created_by) AS added_by, c.name AS committee_name,
        (SELECT COUNT(*) FROM members m WHERE m.status = 'active' AND (e.committee_id IS NULL OR m.committee_id = e.committee_id)$ms) AS total,
        (SELECT COUNT(*) FROM attendance a JOIN members m ON m.id = a.member_id WHERE a.event_id = e.id AND a.status = 'present'$ms) AS present,
        (SELECT COUNT(*) FROM attendance a JOIN members m ON m.id = a.member_id WHERE a.event_id = e.id$ms) AS marked
        FROM events e LEFT JOIN committees c ON c.id = e.committee_id
        WHERE 1=1$vis $extra ORDER BY e.event_date, e.event_time", $params)->fetchAll();
    foreach ($rows as &$r) $r['can_edit'] = (isSec($u) || ($r['kind'] === 'custom' && (int)$r['created_by'] === (int)$u['id'])) ? 1 : 0;
    return $rows;
}
function eventFor($u, $id) {
    $e = q('SELECT * FROM events WHERE id = ?', [(int)$id])->fetch();
    if (!$e) out(false, 'Event not found.');
    $sc = scope($u);
    if ($sc && $e['committee_id'] && (int)$e['committee_id'] !== $sc) out(false, 'You do not have access to this event.');
    return $e;
}
/** SQL fragment limiting members (alias m) to those expected at event $e for user $u. */
function memberScope($u, $e) {
    $cid = $e['committee_id'] ? (int)$e['committee_id'] : scope($u);
    return $cid ? " AND m.committee_id = $cid" : '';
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

if ($action !== 'login') {
    // every action other than login requires a session
    need();
    if (in_array($action, ['dashboard', 'events_list', 'att_get', 'att_save', 'members_list', 'records'], true)) {
        try { syncLeaders(); } catch (Throwable $e) { error_log('syncLeaders: ' . $e->getMessage()); }
    }
}

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
        q('DELETE FROM rate_limits WHERE rkey = ?', [$key]);
        session_regenerate_id(true);
        $_SESSION['uid'] = (int)$r['id'];
        out(true, 'Welcome!');
    }

    case 'logout': { $_SESSION = []; session_destroy(); out(true); }

    case 'me': {
        $u = need();
        $u['committee_name'] = $u['committee_id'] ? q('SELECT name FROM committees WHERE id = ?', [$u['committee_id']])->fetchColumn() : null;
        out(true, '', ['user' => $u, 'committees' => q('SELECT id, name, color FROM committees ORDER BY sort_order')->fetchAll()]);
    }

    case 'dashboard': {
        $u = need(); $sc = scope($u); $today = date('Y-m-d');
        $ms = $sc ? " AND committee_id = $sc" : '';
        $members = (int)q("SELECT COUNT(*) FROM members WHERE status = 'active'$ms")->fetchColumn();
        $todayEv = eventList($u, 'AND e.event_date = ?', [$today]);
        $upcoming = array_slice(eventList($u, 'AND e.event_date > ?', [$today]), 0, 6);
        $mw = $sc ? " AND m.committee_id = $sc" : '';
        $rate = [];
        foreach (q("SELECT m.committee_id cid, SUM(a.status = 'present') p, SUM(a.id IS NOT NULL) t FROM events e
            JOIN members m ON m.status = 'active' AND (e.committee_id IS NULL OR e.committee_id = m.committee_id)$mw
            LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
            WHERE e.event_date <= ? GROUP BY m.committee_id", [$today])->fetchAll() as $r) $rate[$r['cid']] = [(int)$r['p'], (int)$r['t']];
        $cw = $sc ? "WHERE c.id = $sc" : '';
        $coms = q("SELECT c.id, c.name, c.color, (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.id AND m.status = 'active') AS members FROM committees c $cw ORDER BY c.sort_order")->fetchAll();
        foreach ($coms as &$c) { $r = $rate[$c['id']] ?? [0, 0]; $c['rate'] = $r[1] ? round($r[0] / $r[1] * 100) : null; }
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
        if (isSec($u)) {
            $cid = (int)($in['committee_id'] ?? 0) ?: null;
            if ($cid && !q('SELECT id FROM committees WHERE id = ?', [$cid])->fetch()) out(false, 'Invalid committee.');
            $kind = $cid ? 'custom' : 'fixed';
        } else {
            $cid = scope($u); $kind = 'custom';
        }
        if ($id) {
            $e = q('SELECT * FROM events WHERE id = ?', [$id])->fetch();
            if (!$e) out(false, 'Event not found.');
            if (!isSec($u) && !($e['kind'] === 'custom' && (int)$e['created_by'] === (int)$u['id'])) out(false, 'You can only edit schedules you added.');
            q('UPDATE events SET title=?, event_date=?, event_time=?, end_time=?, location=?, committee_id=?, kind=? WHERE id=?', [$title, $dates[0], $time, $end, $loc, $cid, $kind, $id]);
            out(true, 'Schedule updated.');
        }
        try {
            $pdo->beginTransaction();
            $ins = $pdo->prepare('INSERT INTO events (title, event_date, event_time, end_time, location, committee_id, kind, created_by) VALUES (?,?,?,?,?,?,?,?)');
            foreach ($dates as $d) $ins->execute([$title, $d, $time, $end, $loc, $cid, $kind, $u['id']]);
            $pdo->commit();
        } catch (Throwable $ex) {
            if ($pdo->inTransaction()) $pdo->rollBack();
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
        q('DELETE FROM attendance WHERE event_id = ?', [$e['id']]);
        q('DELETE FROM events WHERE id = ?', [$e['id']]);
        out(true, 'Schedule and its attendance deleted.');
    }

    /* ---------------- Attendance ---------------- */
    case 'att_get': {
        $u = need(); $e = eventFor($u, $in['event_id'] ?? 0); $w = memberScope($u, $e);
        // Leaders always first, then by committee, then by name
        $rows = q("SELECT m.id AS member_id, m.full_name, m.ministry, m.scholar_type, m.member_role, c.name AS committee_name, a.status, a.time_in, a.reason
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
            $ins = $pdo->prepare('INSERT INTO attendance (member_id, event_id, status, time_in, reason, marked_by, marked_at) VALUES (?,?,?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE status = VALUES(status), time_in = VALUES(time_in), reason = VALUES(reason), marked_by = VALUES(marked_by), marked_at = VALUES(marked_at)');
            foreach ($clean as [$mid, $st, $t, $reason]) $ins->execute([$mid, $e['id'], $st, $t, $reason, $u['id']]);
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
        q('DELETE FROM attendance WHERE member_id = ?', [$id]);
        q('DELETE FROM members WHERE id = ?', [$id]);
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
        $today = date('Y-m-d');
        $rows = q("SELECT e.id AS event_id, e.title AS event, e.event_date AS date, e.event_time AS time, sc.name AS event_for,
            m.id AS member_id, m.full_name AS member, c.name AS committee, m.ministry, m.member_role AS role, m.scholar_type AS scholar,
            COALESCE(a.status, 'pending') AS status, a.time_in, a.reason
            FROM events e
            JOIN members m ON (e.committee_id IS NULL OR e.committee_id = m.committee_id)
            JOIN committees c ON c.id = m.committee_id
            LEFT JOIN committees sc ON sc.id = e.committee_id
            LEFT JOIN attendance a ON a.event_id = e.id AND a.member_id = m.id
            WHERE e.event_date BETWEEN ? AND ? AND (m.status = 'active' OR a.id IS NOT NULL)$w
            ORDER BY e.event_date, e.event_time, (m.member_role = 'leader') DESC, c.sort_order, m.full_name", [$from, $to])->fetchAll();
        if (count($rows) > 60000) out(false, 'Too many records. Narrow the date range or committees.');
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
                q('UPDATE users SET full_name=?, username=?, role=?, committee_id=?, status=?, password=? WHERE id=?', [$name, $un, $role, $cid, $st, password_hash($pw, PASSWORD_BCRYPT), $id]);
            } else {
                q('UPDATE users SET full_name=?, username=?, role=?, committee_id=?, status=? WHERE id=?', [$name, $un, $role, $cid, $st, $id]);
            }
            out(true, 'Account updated.');
        }
        if (strlen($pw) < 6) out(false, 'Give the new account a password of at least 6 characters.');
        q('INSERT INTO users (username, password, full_name, role, committee_id, status) VALUES (?,?,?,?,?,?)', [$un, password_hash($pw, PASSWORD_BCRYPT), $name, $role, $cid, $st]);
        out(true, 'Account created. Give the username and password to the leader.');
    }

    case 'user_delete': {
        $me = needSec();
        $id = (int)($in['id'] ?? 0);
        if ($id === (int)$me['id']) out(false, 'You cannot delete your own account.');
        q('DELETE FROM users WHERE id = ?', [$id]);
        out(true, 'Account deleted. Attendance they marked is kept.');
    }

    case 'change_password': {
        $u = need();
        $cur = (string)($in['current'] ?? ''); $new = (string)($in['password'] ?? '');
        if (strlen($new) < 6) out(false, 'New password must be at least 6 characters.');
        $h = q('SELECT password FROM users WHERE id = ?', [$u['id']])->fetchColumn();
        if (!$h || !password_verify($cur, $h)) out(false, 'Your current password is wrong.');
        q('UPDATE users SET password = ? WHERE id = ?', [password_hash($new, PASSWORD_BCRYPT), $u['id']]);
        out(true, 'Password changed.');
    }

    /* Cheap change detector the pages poll every few seconds (no data, just a fingerprint). */
    case 'pulse': {
        $u = need(); $sc = scope($u);
        $mj = $sc ? " WHERE m.committee_id = $sc" : '';
        $ms = $sc ? " WHERE committee_id = $sc" : '';
        $a = q("SELECT COUNT(*) c, COALESCE(MAX(a.marked_at), '') t, COALESCE(SUM(CRC32(CONCAT(a.member_id, '-', a.event_id, '-', a.status, '-', COALESCE(a.time_in, ''), '-', COALESCE(a.reason, '')))), 0) s
            FROM attendance a JOIN members m ON m.id = a.member_id$mj")->fetch();
        $m = q("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT(id, '-', full_name, '-', committee_id, '-', member_role, '-', status, '-', scholar_type, '-', COALESCE(ministry, '')))), 0) s FROM members$ms")->fetch();
        $e = q("SELECT COUNT(*) c, COALESCE(SUM(CRC32(CONCAT(id, '-', title, '-', event_date, '-', COALESCE(event_time, ''), '-', COALESCE(end_time, ''), '-', COALESCE(location, ''), '-', COALESCE(committee_id, '')))), 0) s FROM events")->fetch();
        out(true, '', ['hash' => md5(json_encode([$a, $m, $e]))]);
    }

    default: out(false, 'Unknown action.');
}
