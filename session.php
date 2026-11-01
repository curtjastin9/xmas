<?php
/** Shared bootstrap: Manila time, TiDB connection (TLS), DB-backed sessions on Vercel. */
date_default_timezone_set('Asia/Manila');
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

function env($k) {
    $v = getenv($k);
    if ($v === false || $v === '') $v = $_ENV[$k] ?? $_SERVER[$k] ?? null;
    return ($v === null || $v === false || $v === '') ? null : (string)$v;
}

/** Env vars on Vercel: DB_HOST, DB_PORT (4000), DB_NAME, DB_USER, DB_PASS */
function db() {
    static $pdo = null;
    if ($pdo) return $pdo;
    $h = trim(env('DB_HOST') ?: 'localhost');
    $h = preg_replace('#^[a-z]+://#i', '', $h);
    $port = env('DB_PORT') ?: '3306';
    if (preg_match('/^(.*):(\d+)$/', $h, $m)) { $h = $m[1]; $port = $m[2]; }
    $dsn = "mysql:host=$h;port=$port;dbname=" . (env('DB_NAME') ?: 'xmas_attendance') . ";charset=utf8mb4";
    $base = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 10,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET time_zone = '+08:00'",
    ];
    $remote = !in_array($h, ['localhost', '127.0.0.1', '::1'], true);
    $ca = __DIR__ . '/cacert.pem';
    $tries = [[]];
    if ($remote) {
        $tries = [];
        if (is_readable($ca)) {
            $tries[] = [PDO::MYSQL_ATTR_SSL_CA => $ca, PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => true];
            $tries[] = [PDO::MYSQL_ATTR_SSL_CA => $ca, PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false];
        }
        $tries[] = [PDO::MYSQL_ATTR_SSL_CIPHER => 'DEFAULT', PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false];
    }
    $last = null;
    foreach ($tries as $ssl) {
        try { return $pdo = new PDO($dsn, env('DB_USER') ?: 'root', rtrim((string)env('DB_PASS'), "\r\n"), $ssl + $base); }
        catch (Throwable $e) { $last = $e; error_log('DB connect: ' . $e->getMessage()); }
    }
    throw $last;
}

class DbSessions implements SessionHandlerInterface {
    private $pdo, $old = null, $oldTs = 0, $oldId = null;
    function __construct() { $this->pdo = db(); }
    function open($p, $n): bool { return true; }
    function close(): bool { return true; }
    function read($id): string|false {
        $s = $this->pdo->prepare('SELECT data, ts FROM php_sessions WHERE id = ?');
        $s->execute([$id]);
        $r = $s->fetch();
        $this->oldId = $id;
        if ($r) { $this->old = $r['data']; $this->oldTs = (int)$r['ts']; return $r['data']; }
        $this->old = null;
        return '';
    }
    function write($id, $data): bool {
        if ($this->old === null && $data === '') return true;
        if ($id === $this->oldId && $data === $this->old && time() - $this->oldTs < 300) return true;
        $this->pdo->prepare('REPLACE INTO php_sessions (id, data, ts) VALUES (?,?,?)')->execute([$id, $data, time()]);
        return true;
    }
    function destroy($id): bool { $this->pdo->prepare('DELETE FROM php_sessions WHERE id = ?')->execute([$id]); return true; }
    function gc($max): int|false { return $this->pdo->prepare('DELETE FROM php_sessions WHERE ts < ?')->execute([time() - 86400 * 7]) ? 1 : 0; }
}

if (session_status() === PHP_SESSION_NONE) {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
    if (getenv('VERCEL') || getenv('NOW_REGION')) {
        try { session_set_save_handler(new DbSessions(), true); } catch (Throwable $e) { error_log('session handler: ' . $e->getMessage()); }
    }
    session_start();
}
