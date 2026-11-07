<?php
/**
 * Creates an event with several slots (e.g. Simbang Gabi -> Slot A, Slot B),
 * optionally repeated every day until a last date. Each slot becomes its own
 * event ("Title – Slot name") with its own servers and its own attendance.
 * Secretariat only.
 */
require_once __DIR__ . '/session.php';
header('Content-Type: application/json');
require_once 'config.php';
require_once 'security.php';

$action = $_GET['action'] ?? '';
$input  = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) $input = [];

function respond($success, $message = '', $data = null) {
    echo json_encode(['success' => $success, 'message' => $message, 'data' => $data]);
    exit;
}
function nextId($pdo, $table) {
    return (int)$pdo->query("SELECT COALESCE(MAX(id),0) FROM `$table`")->fetchColumn() + 1;
}
function okDate($d) {
    return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) !== false;
}
function normTime($t) {
    $t = trim((string)$t);
    if ($t === '' || !preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $t)) return null;
    return strlen($t) === 5 ? $t . ':00' : $t;
}

if (!isset($_SESSION['user_id'])) respond(false, 'Your session has expired. Please log in again.');
if (($_SESSION['role'] ?? '') !== 'secretariat') respond(false, 'You do not have permission to perform this action.');
ensureEventServerSchema($pdo);

switch ($action) {

    case 'save_slots': {
        $category_id = (int)($input['category_id'] ?? 0);
        $title    = trim((string)($input['title'] ?? ''));
        $date     = (string)($input['event_date'] ?? '');
        $end      = (string)($input['end_date'] ?? '');
        $location = trim((string)($input['location'] ?? ''));
        $baseTime = normTime($input['event_time'] ?? '');
        $slots    = $input['slots'] ?? [];

        if ($title === '' || !okDate($date)) respond(false, 'Title and date are required.');
        if ($end === '') $end = $date;
        elseif (!okDate($end) || $end < $date) respond(false, 'The "repeat until" date must be on or after the event date.');

        $s = $pdo->prepare("SELECT is_system FROM event_categories WHERE id = ?");
        $s->execute([$category_id]);
        $c = $s->fetch();
        if (!$c) respond(false, 'Please select a category.');
        if ((int)$c['is_system'] === 1) respond(false, 'Normal Serve uses the fixed weekly slots. Events cannot be added to it.');

        // Dates (one per day, max 31)
        $dates = [];
        $d = new DateTime($date); $e = new DateTime($end);
        for (; $d <= $e; $d->modify('+1 day')) {
            $dates[] = $d->format('Y-m-d');
            if (count($dates) > 31) respond(false, 'You can add up to 31 days at a time.');
        }

        // Slots
        if (!is_array($slots) || !count($slots)) respond(false, 'Add at least one slot.');
        if (count($slots) > 10) respond(false, 'A maximum of 10 slots is allowed.');
        $clean = []; $seen = [];
        $chk = $pdo->prepare("SELECT id FROM youth_members WHERE id = ?");
        foreach ($slots as $sl) {
            if (!is_array($sl)) continue;
            $name = actCut(trim((string)($sl['name'] ?? '')), 60);
            if ($name === '') respond(false, 'Please type a name for every slot.');
            $key = strtolower($name);
            if (isset($seen[$key])) respond(false, 'Two slots have the same name: ' . $name);
            $seen[$key] = true;
            $ids = $sl['server_ids'] ?? [];
            if (!is_array($ids)) $ids = [];
            $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn($v) => $v > 0)));
            $valid = [];
            foreach ($ids as $mid) { $chk->execute([$mid]); if ($chk->fetch()) $valid[] = $mid; }
            $clean[] = ['name' => $name, 'time' => normTime($sl['time'] ?? '') ?: $baseTime, 'servers' => $valid];
        }
        if (!$clean) respond(false, 'Add at least one slot.');

        $made = 0; $skipped = 0;
        try {
            $pdo->beginTransaction();
            $eid  = nextId($pdo, 'events');
            $sid  = nextId($pdo, 'event_servers');
            $dup  = $pdo->prepare("SELECT id FROM events WHERE title = ? AND event_date = ? AND category_id = ?");
            $insE = $pdo->prepare("INSERT INTO events (id, title, type, event_date, event_time, location, category_id, has_servers) VALUES (?,?,?,?,?,?,?,?)");
            $insS = $pdo->prepare("INSERT INTO event_servers (id, event_id, member_id) VALUES (?,?,?)");
            foreach ($dates as $dt) {
                foreach ($clean as $sl) {
                    $evTitle = actCut($title . ' – ' . $sl['name'], 150);
                    $dup->execute([$evTitle, $dt, $category_id]);
                    if ($dup->fetch()) { $skipped++; continue; }
                    $insE->execute([$eid, $evTitle, 'category', $dt, $sl['time'], $location, $category_id, $sl['servers'] ? 1 : 0]);
                    foreach ($sl['servers'] as $mid) $insS->execute([$sid++, $eid, $mid]);
                    $eid++; $made++;
                }
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            error_log('save_slots: ' . $e->getMessage());
            respond(false, 'Failed to save events: ' . $e->getMessage());
        }

        logActivity($pdo, 'save_event_slots', $title, $made . ' event(s) created: ' . count($clean) . ' slot(s) × ' . count($dates) . ' day(s)' . ($skipped ? ', ' . $skipped . ' already existed' : ''));
        $msg = $made . ' event(s) added (' . count($clean) . ' slot(s) × ' . count($dates) . ' day(s)).';
        if ($skipped) $msg .= ' ' . $skipped . ' already existed and were skipped.';
        respond(true, $msg);
    }

    default:
        respond(false, 'Unknown action.');
}
