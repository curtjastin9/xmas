<?php
require_once __DIR__ . '/session.php';
if (!empty($_SESSION['uid'])) { header('Location: index.php'); exit; }
?><!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Christmas Presentation Attendance · Log in</title>
<meta name="description" content="Attendance system for every committee and every rehearsal of the Christmas Presentation.">
<link rel="icon" type="image/png" href="favicon.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="#050A26">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<link rel="stylesheet" href="login.css?v=1">
</head><body>
<div class="bg" aria-hidden="true"><div class="tiles" id="tiles"></div><div class="shade"></div><div class="spot" id="spot"></div></div>

<header class="top">
  <a class="brand" href="login.php" aria-label="Christmas Presentation Attendance"><img src="logo.png" width="524" height="600" alt=""><span><b>MQAP</b><small>PYM ATTENDANCE</small></span></a>
  <button class="top-btn" data-open>Log In</button>
</header>

<main class="hero">
  <div class="logo-wrap rise" style="--i:0"><img src="logo.png" width="524" height="600" alt="Logo: Bringing Christ to our fellow Youth"></div>
  <div class="pill rise" style="--i:1"><i class="fas fa-church"></i> Parish Youth Ministry</div>
  <h1 class="rise" style="--i:2">Christmas <span class="gold">Presentation</span><br>Attendance System</h1>
  <p class="tag rise" style="--i:3">Every youth. Every rehearsal. Every committee.</p>
  <p class="lead rise" style="--i:4">A clear, real-time record of attendance for every rehearsal and the Christmas Presentation, managed by your Secretariat and committee leaders.</p>
  <button class="cta rise" style="--i:5" data-open><i class="fas fa-right-to-bracket"></i> Login <i class="fas fa-chevron-right ar"></i></button>
  <div class="feats rise" style="--i:6">
    <span class="feat"><i class="fas fa-clipboard-check"></i> Fast attendance per committee</span>
    <span class="feat"><i class="fas fa-chart-line"></i> Live records &amp; Excel export</span>
    <span class="feat"><i class="fas fa-shield-halved"></i> Secure leader accounts</span>
  </div>
</main>
<footer class="foot">Parish Youth Ministry · Accounts are issued by the Secretariat</footer>

<div class="modal" id="modal" aria-hidden="true">
  <div class="mback" data-close></div>
  <div class="mcard" role="dialog" aria-modal="true" aria-labelledby="mt">
    <button class="mx" data-close aria-label="Close"><i class="fas fa-xmark"></i></button>
    <img class="mlogo" src="logo.png" width="524" height="600" alt="">
    <h2 id="mt">Welcome back</h2>
    <p class="sub">Log in to take attendance and manage schedules.</p>
    <form id="f" novalidate>
      <label class="field">Username
        <span class="fw"><i class="fas fa-user ic" aria-hidden="true"></i><input name="username" id="un" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Your username" required></span></label>
      <label class="field">Password
        <span class="fw"><i class="fas fa-lock ic" aria-hidden="true"></i><input name="password" id="pw" type="password" autocomplete="current-password" placeholder="Your password" required>
          <button type="button" class="eye" id="eye" aria-label="Show password"><i class="fas fa-eye"></i></button></span></label>
      <div id="msg" class="msg" role="alert"></div>
      <button class="go" id="go">Log in</button>
    </form>
    <p class="note">There is no sign-up. Your Secretariat gives each leader an account.</p>
  </div>
</div>

<script>
/* background tiles */
(() => {
  const icons = ['cross','bell','hands-praying','dove','music','church','star','gift','candy-cane','tree','hand-holding-heart','people-group'];
  const fills = [
    'linear-gradient(160deg,#1a37a8,#0b1552)', 'linear-gradient(160deg,#16307f,#0a1240)', 'linear-gradient(160deg,#2149d6,#0f2486)',
    'linear-gradient(160deg,#8a5a12,#2b1d08)', 'linear-gradient(160deg,#5a1626,#1d0810)', 'linear-gradient(160deg,#0f4a3a,#06201a)', 'linear-gradient(160deg,#3b1d7a,#150a35)'
  ];
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const box = document.getElementById('tiles'); let h = '';
  for (let i = 0; i < 64; i++) {
    const tall = rnd() > .62 ? 'grid-row:span 2;' : '';
    h += `<div class="tile" style="${tall}background:${fills[Math.floor(rnd() * fills.length)]}"><i class="fas fa-${icons[Math.floor(rnd() * icons.length)]}"></i></div>`;
  }
  box.innerHTML = h;
  const spot = document.getElementById('spot');
  addEventListener('pointermove', e => { spot.style.setProperty('--mx', e.clientX + 'px'); spot.style.setProperty('--my', e.clientY + 'px'); }, { passive: true });
})();

/* login modal */
const modal = document.getElementById('modal'), f = document.getElementById('f'), msg = document.getElementById('msg'),
      pw = document.getElementById('pw'), un = document.getElementById('un'), go = document.getElementById('go');
let opener = null;
const open = e => { opener = e && e.currentTarget; modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; setTimeout(() => un.focus(), 60); };
const close = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; msg.textContent = ''; if (opener) opener.focus(); };
document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', open));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
if (location.hash === '#login') open();

document.getElementById('eye').addEventListener('click', e => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  e.currentTarget.innerHTML = '<i class="fas fa-eye' + (show ? '-slash' : '') + '"></i>';
  e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});
f.addEventListener('submit', async e => {
  e.preventDefault();
  if (!un.value.trim() || !pw.value) { msg.textContent = 'Enter your username and password.'; return; }
  go.disabled = true; go.textContent = 'Logging in…'; msg.textContent = '';
  try {
    const r = await (await fetch('api.php?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(f))) })).json();
    if (r.success) { go.textContent = 'Welcome!'; location.href = 'index.php'; return; }
    msg.textContent = r.message;
  } catch (x) { msg.textContent = 'Network error. Check your connection.'; }
  go.disabled = false; go.textContent = 'Log in';
});
</script>
</body></html>
