<?php
require_once __DIR__ . '/session.php';
if (empty($_SESSION['uid'])) { header('Location: login.php'); exit; }
?><!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Christmas Presentation Attendance</title>
<link rel="icon" type="image/png" href="favicon.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="#0F1830">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="MQAP Attendance">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<link rel="stylesheet" href="style.css?v=12">
<link rel="stylesheet" href="mobile.css?v=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
</head><body>
<aside id="side">
  <div class="brand"><img src="logo.png" width="524" height="600" alt="Logo"><div><b>MQAP</b><small>PYM ATTENDANCE</small></div></div>
  <div class="who"><b id="whoName">—</b><small id="whoRole">—</small></div>
  <nav id="nav"></nav>
  <button class="logout" id="logout"><i class="fas fa-right-from-bracket"></i> Log out</button>
</aside>
<div id="shade"></div>
<main>
  <header><button id="burger" aria-label="Menu">&#9776;</button><h2 id="title">Dashboard</h2><div class="hchip" id="hchip"></div></header>
  <div id="view"></div>
</main>
<div id="toasts" role="status" aria-live="polite"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<script src="app.js?v=13"></script>
</body></html>
