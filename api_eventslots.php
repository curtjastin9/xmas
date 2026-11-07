<?php
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

if (!isset($_SESSION['user_id'])) respond(false, 'Your session has expired. Please log in again.');
if (($_SESSION['role'] ?? '') !== 'secretariat') respond(false, 'You do not have permission to perform this action.');

function ensureEventSlotSchema($pdo) {
    if (!empty($_SESSION['evslt_ok'])) return;
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS `event_slots` (
            `id` int(11) NOT NULL,
            `event_id` int(11) NOT NULL,
            `name` varchar(100) NOT NULL,
            `sort_order` int(11) NOT NULL DEFAULT 0,
            PRIMARY KEY (`id`),
            KEY `idx_es_event` (`event_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $pdo->exec("CREATE TABLE IF NOT EXISTS `event_slot_servers` (
            `id` int(11) NOT NULL,
            `slot_id` int(11) NOT NULL,
            `member_id` int(11) NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_ess` (`slot_id`,`member_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $_SESSION['evslt_ok'] = 1;
    } catch (Throwable $e) { error_log('event slots schema: ' . $e->getMessage()); }
}

ensureEventServerSchema($pdo);
ensureEventSlotSchema($pdo);

switch ($action) {

    case 'get': {
        $eid = (int)($input['event_id'] ?? 0);
        $s = $pdo->prepare("SELECT id, name FROM event_slots WHERE event_id = ? ORDER BY sort_order ASC, id ASC");
        $s->execute([$eid]);
        $slots = $s->fetchAll();
        $q = $pdo->prepare("SELECT ss.slot_id, y.id AS member_id, y.full_name
            FROM event_slot_servers ss
            JOIN event_slots s ON s.id = ss.slot_id
            JOIN youth_members y ON y.id = ss.member_id
            WHERE s.event_id = ? ORDER BY y.full_name ASC");
        $q->execute([$eid]);
        $by = [];
        foreach ($q->fetchAll() as $r) $by[(int)$r['slot_id']][] = ['member_id' => (int)$r['member_id'], 'full_name' => $r['full_name']];
        foreach ($slots as &$sl) $sl['servers'] = $by[(int)$sl['id']] ?? [];
        unset($sl);
        respond(true, '', $slots);
    }

    case 'find_event': {
        $q = $pdo->prepare("SELECT id FROM events WHERE category_id = ? AND title = ? AND event_date = ? ORDER BY id DESC LIMIT 1");
        $q->execute([(int)($input['category_id'] ?? 0), trim((string)($input['title'] ?? '')), (string)($input['event_date'] ?? '')]);
        $id = $q->fetchColumn();
        respond(true, '', $id ? ['id' => (int)$id] : null);
    }

    case 'save': {
        $eid = (int)($input['event_id'] ?? 0);
        $in  = $input['slots'] ?? [];
        if (!is_array($in)) $in = [];
        $chk = $pdo->prepare("SELECT id FROM events WHERE id = ? AND category_id IS NOT NULL");
        $chk->execute([$eid]);
        if (!$chk->fetch()) respond(false, 'Invalid event.');

        $slots = [];
        foreach ($in as $s) {
            $name = trim((string)($s['name'] ?? ''));
            if ($name === '') continue;
            $ids = $s['server_ids'] ?? [];
            if (!is_array($ids)) $ids = [];
            $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn($v) => $v > 0)));
            $slots[] = ['name' => substr($name, 0, 100), 'ids' => $ids];
        }

        try {
            $pdo->beginTransaction();
            $pdo->prepare("DELETE FROM event_slot_servers WHERE slot_id IN (SELECT id FROM event_slots WHERE event_id = ?)")->execute([$eid]);
            $pdo->prepare("DELETE FROM event_slots WHERE event_id = ?")->execute([$eid]);

            if ($slots) {
                $all = [];
                foreach ($slots as $s) foreach ($s['ids'] as $m) $all[$m] = true;
                $valid = [];
                if ($all) {
                    $keys = array_keys($all);
                    $v = $pdo->prepare("SELECT id FROM youth_members WHERE id IN (" . implode(',', array_fill(0, count($keys), '?')) . ")");
                    $v->execute($keys);
                    foreach ($v->fetchAll(PDO::FETCH_COLUMN) as $id) $valid[(int)$id] = true;
                }

                $sid = nextId($pdo, 'event_slots');
                $ssid = nextId($pdo, 'event_slot_servers');
                $insS = $pdo->prepare("INSERT INTO event_slots (id, event_id, name, sort_order) VALUES (?,?,?,?)");
                $insM = $pdo->prepare("INSERT INTO event_slot_servers (id, slot_id, member_id) VALUES (?,?,?)");
                $union = [];
                foreach ($slots as $i => $s) {
                    $insS->execute([$sid, $eid, $s['name'], $i + 1]);
                    foreach ($s['ids'] as $m) {
                        if (!isset($valid[$m])) continue;
                        $insM->execute([$ssid++, $sid, $m]);
                        $union[$m] = true;
                    }
                    $sid++;
                }

                // keep Attendance working: all slot servers appear as servers of the event
                $pdo->prepare("DELETE FROM event_servers WHERE event_id = ?")->execute([$eid]);
                $nid = nextId($pdo, 'event_servers');
                $insE = $pdo->prepare("INSERT INTO event_servers (id, event_id, member_id) VALUES (?,?,?)");
                foreach (array_keys($union) as $m) $insE->execute([$nid++, $eid, $m]);
                $pdo->prepare("UPDATE events SET has_servers = 1 WHERE id = ?")->execute([$eid]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            respond(false, 'Failed to save slots: ' . $e->getMessage());
        }
        respond(true, 'Slots saved.');
    }

    default:
        respond(false, 'Unknown action.');
}
