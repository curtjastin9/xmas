<?php
/* TEMPORARY diagnostic page. Delete this file from GitHub once the login works. */
require_once __DIR__ . '/session.php';
header('Content-Type: application/json');
try {
    $pdo = db();
    $r = ['connected' => true, 'database_in_use' => $pdo->query('SELECT DATABASE()')->fetchColumn()];
    foreach (['users', 'committees', 'members', 'events', 'attendance'] as $t) {
        try { $r['rows_' . $t] = (int)$pdo->query("SELECT COUNT(*) FROM `$t`")->fetchColumn(); }
        catch (Throwable $e) { $r['rows_' . $t] = 'table missing'; }
    }
    $s = $pdo->prepare('SELECT password, status FROM users WHERE username = ?');
    $s->execute(['JASTIN']);
    $u = $s->fetch();
    $r['JASTIN_exists'] = (bool)$u;
    $r['JASTIN_status'] = $u['status'] ?? null;
    $r['JASTIN123_matches'] = $u ? password_verify('JASTIN123', $u['password']) : null;
} catch (Throwable $e) {
    $r = ['connected' => false, 'error' => $e->getMessage()];
}
echo json_encode($r, JSON_PRETTY_PRINT);
