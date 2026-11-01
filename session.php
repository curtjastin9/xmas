<?php
/** Shared bootstrap: Manila time, TiDB connection (TLS), stateless signed-cookie login (no DB lookups for sessions). */
date_default_timezone_set('Asia/Manila');
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

function env($k) {
    $v = getenv($k);
    if ($v === false || $v === '') $v = $_ENV[$k] ?? $_SERVER[$k] ?? null;
    return ($v === null || $v === false || $v === '') ? null : (string)$v;
}

/** Env vars on Vercel: DB_HOST, DB_PORT (4000), DB_NAME, DB_USER, DB_PASS  (optional: SESSION_SECRET) */
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
        PDO::ATTR_EMULATE_PREPARES => true,   // one round trip per query instead of two
        PDO::ATTR_STRINGIFY_FETCHES => false,
        PDO::ATTR_TIMEOUT => 10,
        PDO::ATTR_PERSISTENT => true,
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

/* ---------- Stateless login cookie: signed with HMAC, so pages never need the database just to know who you are ---------- */
function auth_key() { return hash('sha256', 'mqap|' . (env('SESSION_SECRET') ?: (env('DB_PASS') . '|' . env('DB_USER') . '|' . env('DB_HOST')))); }
function b64u_enc($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec($s) { return base64_decode(strtr($s, '-_', '+/')); }
function cookie_opts($exp) {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return ['expires' => $exp, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax'];
}
function set_login($uid) {
    $exp = time() + 86400 * 7;
    $p = b64u_enc((int)$uid . '.' . $exp);
    setcookie('mq_auth', $p . '.' . hash_hmac('sha256', $p, auth_key()), cookie_opts($exp));
    $_SESSION['uid'] = (int)$uid;
}
function clear_login() {
    setcookie('mq_auth', '', cookie_opts(time() - 3600));
    $_SESSION = [];
}

$_SESSION = [];
$mqc = $_COOKIE['mq_auth'] ?? '';
if (is_string($mqc) && substr_count($mqc, '.') === 1) {
    [$mqp, $mqs] = explode('.', $mqc);
    if (hash_equals(hash_hmac('sha256', $mqp, auth_key()), $mqs)) {
        $mqd = explode('.', (string)b64u_dec($mqp));
        if (count($mqd) === 2 && (int)$mqd[1] > time() && (int)$mqd[0] > 0) $_SESSION['uid'] = (int)$mqd[0];
    }
}
