/* Christmas Presentation Attendance — front end. Talks to api.php (JSON). */
(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const TZ = 'Asia/Manila';
const SEASON_START = '2026-11-01', SEASON_END = '2026-12-24'; // only Nov 1 – Dec 24, 2026 is shown
const clampDay = d => d < SEASON_START ? SEASON_START : d > SEASON_END ? SEASON_END : d;
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const nowHM = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtTime = t => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
};
const timeRange = e => e.event_time ? fmtTime(e.event_time) + (e.end_time ? ' – ' + fmtTime(e.end_time) : '') : '';
const SCHOLAR = { none: 'Not a scholar', shs: 'SHS Scholar', college: 'College Scholar' };
const SCHOLAR_SHORT = { none: '—', shs: 'SHS', college: 'College' };
const STATUS_LABEL = { present: 'Present', absent: 'Absent', excused: 'Excused', pending: 'Not yet modified' };
const ROLE = { member: 'Member', leader: 'Leader' };

/** Leader badge (members show nothing in compact views) */
const roleBadge = r => r === 'leader' ? '<span class="pill lead"><i class="fas fa-star"></i>Leader</span>' : '';
const isLead = r => (r && (r.member_role || r.role)) === 'leader' ? 1 : 0;
/** stable sort: leaders always first, everything else keeps its order */
const leadersFirst = list => list.map((x, i) => [x, i]).sort((a, b) => (isLead(b[0]) - isLead(a[0])) || (a[1] - b[1])).map(x => x[0]);

let ME = null, COMMITTEES = [];
const isSec = () => ME && ME.role === 'secretariat';
const comColor = id => (COMMITTEES.find(c => +c.id === +id) || {}).color || '#64748b';
const comByName = n => COMMITTEES.find(c => c.name === n);
const comTag = (name, id) => {
  const c = id ? COMMITTEES.find(x => +x.id === +id) : comByName(name);
  return `<span class="ctag"><i style="background:${esc(c ? c.color : '#64748b')}"></i>${esc(name)}</span>`;
};

function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}

/** POST to api.php. Returns the parsed response; redirects to login if the session ended. */
async function api(action, body) {
  let r;
  try {
    const res = await fetch('api.php?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    r = await res.json();
  } catch (e) {
    toast('Network error. Check your connection and try again.', true);
    return { success: false, message: 'Network error.' };
  }
  if (r.code === 'auth') { location.href = 'login.php'; return r; }
  return r;
}
/** api() that toasts failures and returns data (or null). */
async function call(action, body, okToast) {
  const r = await api(action, body);
  if (!r.success) { if (r.code !== 'auth') toast(r.message || 'Something went wrong.', true); return null; }
  if (okToast && r.message) toast(r.message);
  return r.data === null || r.data === undefined ? true : r.data;
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

function modal(html, mount) {
  const back = document.createElement('div');
  back.className = 'back';
  back.innerHTML = `<div class="box" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  document.body.style.overflow = 'hidden'; // no background scroll behind the sheet on phones
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (!$('.back')) document.body.style.overflow = ''; };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  $$('[data-close]', back).forEach(b => b.addEventListener('click', close));
  // on touch devices don't auto-focus (it pops the keyboard over the form)
  const touch = matchMedia('(pointer:coarse)').matches;
  const first = $('input:not([type=hidden]),select,textarea', back);
  if (first && !touch) first.focus();
  if (mount) mount(back, close);
  return { el: back, close };
}
function ask(title, msg, okLabel = 'Yes, continue') {
  return new Promise(res => {
    const m = modal(`<h3>${esc(title)}</h3><p>${esc(msg)}</p>
      <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn pri" id="ok">${esc(okLabel)}</button></div>`,
      (el, close) => { $('#ok', el).addEventListener('click', () => { close(); res(true); }); });
    m.el.addEventListener('click', e => { if (e.target === m.el || e.target.hasAttribute('data-close')) res(false); });
    document.addEventListener('keydown', function f(e) { if (e.key === 'Escape') { res(false); document.removeEventListener('keydown', f); } });
  });
}

const view = () => $('#view');
const loading = () => { view().innerHTML = '<div class="empty">Loading…</div>'; };

/* ---------- csv / xlsx export ---------- */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportRows(kind, name, head, rows, extra = []) {
  if (kind === 'xlsx' && window.XLSX) {
    const safe = rows.map(r => r.map(v => (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v));
    const ws = XLSX.utils.aoa_to_sheet([head, ...safe, ...extra]);
    ws['!cols'] = head.map((h, i) => ({ wch: Math.min(40, Math.max(String(h).length + 2, ...rows.slice(0, 200).map(r => String(r[i] ?? '').length + 2))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, name + '.xlsx');
  } else {
    const csv = [head, ...rows, ...extra].map(r => r.map(csvCell).join(',')).join('\r\n');
    download(name + '.csv', new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  }
}

/* ---------- shell ---------- */
const NAV = {
  dashboard: ['fa-gauge', 'Dashboard'],
  schedule: ['fa-calendar-days', 'Schedule'],
  attendance: ['fa-clipboard-check', 'Take attendance'],
  members: ['fa-users', 'Members'],
  records: ['fa-table-list', 'Records'],
  leaders: ['fa-user-shield', 'Leaders'],
  settings: ['fa-gear', 'Settings']
};
const navFor = () => isSec() ? ['dashboard', 'schedule', 'attendance', 'members', 'records', 'leaders', 'settings']
                              : ['dashboard', 'schedule', 'attendance', 'members', 'records', 'settings'];

function buildNav() {
  $('#nav').innerHTML = navFor().map(k => `<button data-v="${k}"><i class="fas ${NAV[k][0]}"></i>${NAV[k][1]}</button>`).join('');
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    closeSide();
    if (location.hash === '#/' + b.dataset.v) route(); else location.hash = '#/' + b.dataset.v;
  });
}
const closeSide = () => { $('#side').classList.remove('open'); $('#shade').classList.remove('open'); };

let leaveGuard = null; // set by the attendance screen while there are unsaved changes
window.addEventListener('beforeunload', e => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- live updates: pages refresh themselves when data changes (no reload) ---------- */
let routeTok = 0;          // bumps on every navigation so a slow refresh can't paint over a newer page
let liveRefresh = null;    // set by each page: async () => re-fetch + redraw (return false = "not applied, retry")
let lastPulse = null;
let pickUI = {};           // remembers the attendance picker's tab / calendar position across refreshes
async function pulse() {
  if (document.hidden || !liveRefresh || $('.back')) return; // skip hidden tabs and open popups
  let r;
  try { r = await (await fetch('api.php?action=pulse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return; } // offline: stay quiet, try again next tick
  if (r.code === 'auth') { location.href = 'login.php'; return; }
  if (!r.success || !r.data) return;
  const h = r.data.hash;
  if (lastPulse === null) { lastPulse = h; return; }
  if (h === lastPulse) return;
  const prev = lastPulse; lastPulse = h;
  const fn = liveRefresh;
  try { if ((await fn()) === false) lastPulse = prev; } catch (e) { console.error(e); lastPulse = prev; }
}
setInterval(pulse, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pulse(); });
addEventListener('online', pulse);

const VIEWS = {};
async function route() {
  const [v0, arg] = location.hash.replace(/^#\/?/, '').split('/');
  let v = NAV[v0] ? v0 : 'dashboard';
  if (!navFor().includes(v)) v = 'dashboard';
  if (leaveGuard && leaveGuard() && !(await ask('Unsaved attendance', 'You have attendance changes that are not saved yet. Leave without saving?', 'Leave anyway'))) {
    history.replaceState(null, '', document.body.dataset.hash || '#/attendance'); return;
  }
  leaveGuard = null;
  routeTok++; liveRefresh = null; pickUI = {};
  document.body.dataset.hash = location.hash;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#title').textContent = NAV[v][1];
  document.title = NAV[v][1] + ' · Christmas Presentation';
  window.scrollTo(0, 0);
  loading();
  try { await VIEWS[v](arg); } catch (e) { console.error(e); view().innerHTML = '<div class="empty">Could not load this page. Please refresh.</div>'; }
}

/* ---------- shared event row ---------- */
function evFor(e) {
  return e.committee_id ? comTag(e.committee_name, e.committee_id) : '<span class="pill fixed">Whole group</span>';
}
function evMeta(e) {
  return [fmtDate(e.event_date), timeRange(e), e.location].filter(Boolean).map(esc).join(' · ');
}

/* ================= DASHBOARD ================= */
VIEWS.dashboard = async () => {
  const tok = routeTok;
  const load = async () => { const d = await call('dashboard'); if (!d || tok !== routeTok) return false; paint(d); };
  const paint = d => {
  const sc = !isSec();
  const hr = +new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }) % 24;
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const evList = (list, empty) => list.length ? list.map(e => `
    <div class="row"><div><b>${esc(e.title)}</b> ${e.event_date === todayStr() ? '<span class="pill today">Today</span>' : ''}<br>
      <span class="sub">${evMeta(e)}</span><br>${evFor(e)} <span class="sub">${e.present}/${e.total} present</span></div>
      <a class="btn sm pri" href="#/attendance/${e.id}"><i class="fas fa-clipboard-check"></i> Take</a></div>`).join('')
    : `<div class="empty">${empty}</div>`;
  view().innerHTML = `
    <div class="welcome"><div><div class="eyebrow">${esc(fmtDate(todayStr()))}</div>
      <h2>${greet}, ${esc(sc ? ME.full_name.split(' ')[0] : ME.full_name)}</h2>
      <p>${sc ? `Leader of <b>${esc(ME.committee_name || '')}</b>. Here is how your committee is doing.` : 'Here is how the Christmas Presentation is shaping up across every committee.'}</p></div>
      <img src="logo.png" alt=""></div>
    <div class="stats">
      <div class="stat"><i class="fas fa-users si"></i><b>${d.members}</b><span>${sc ? 'Members in your committee' : 'Active members'}</span></div>
      <div class="stat gold"><i class="fas fa-calendar-day si"></i><b>${d.today.length}</b><span>Schedules today</span></div>
      <div class="stat"><i class="fas fa-user-check si"></i><b>${d.present_today}</b><span>Present today</span></div>
      <div class="stat red"><i class="fas fa-calendar-plus si"></i><b>${d.upcoming.length}</b><span>Coming up</span></div>
    </div>
    <div class="grid2">
      <div class="card"><div class="head"><h3>Today</h3></div>${evList(d.today, 'No schedule today.')}</div>
      <div class="card"><div class="head"><h3>Coming up</h3></div>${evList(d.upcoming, 'Nothing scheduled yet.')}</div>
    </div>
    <div class="card"><div class="head"><div><h3>Attendance rate by committee</h3><div class="sub">Present ÷ expected, across all rehearsals held so far.</div></div></div>
      ${d.committees.map(c => `<div style="margin-bottom:14px"><div class="row" style="border:0;padding:0"><span>${comTag(c.name, c.id)} <span class="sub">${c.members} members</span></span><b>${c.rate === null ? '—' : c.rate + '%'}</b></div>
        <div class="meter"><i style="width:${c.rate || 0}%;background:${esc(c.color)}"></i></div></div>`).join('')}
    </div>`;
  };
  if ((await load()) === false) return;
  liveRefresh = load;
};

/* ================= SCHEDULE ================= */
function eventModal(e, done) {
  e = e || {};
  const editing = !!e.id, cid = e.committee_id || '';
  const sel = new Set(editing ? [e.event_date] : []);
  const base = new Date((editing ? e.event_date : todayStr()) + 'T00:00:00');
  let vy = base.getFullYear(), vm = base.getMonth();
  const pad = n => String(n).padStart(2, '0');

  const m = modal(`<h3>${editing ? 'Edit schedule' : (isSec() ? 'Add schedule' : 'Add my committee schedule')}</h3>
    <form id="ef">
      <label>What<input name="title" maxlength="120" required value="${esc(e.title)}" placeholder="e.g. Props build day"></label>
      <div class="sub" style="margin-top:14px;font-weight:600;color:var(--ink)">${editing ? 'Date' : 'Tap the dates (you can pick many)'}</div>
      <div class="cal">
        <div class="cal-nav"><button type="button" class="btn sm ghost" id="pm" aria-label="Previous month">‹</button><b id="ct"></b><button type="button" class="btn sm ghost" id="nm" aria-label="Next month">›</button></div>
        <div class="cal-w"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
        <div class="cal-g" id="days"></div>
      </div>
      <div class="picked" id="picked"></div>
      <div class="two">
        <label>Start time<input name="event_time" type="time" value="${esc((e.event_time || '').slice(0, 5))}"></label>
        <label>End time<input name="end_time" type="time" value="${esc((e.end_time || '').slice(0, 5))}"></label>
      </div>
      <label>Location<input name="location" maxlength="150" value="${esc(e.location)}" placeholder="e.g. Parish hall"></label>
      ${isSec() ? `<label>For<select name="committee_id"><option value="">Everyone – all committees &amp; leaders</option>
        ${COMMITTEES.map(c => `<option value="${c.id}" ${+cid === +c.id ? 'selected' : ''}>${esc(c.name)} only</option>`).join('')}</select></label>`
        : `<p class="sub" style="margin-top:12px">This schedule is only for <b>${esc(ME.committee_name || 'your committee')}</b>.</p>`}
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn pri" id="sv">Save</button></div>
    </form>`, (el, close) => {
      const draw = () => {
        const first = new Date(vy, vm, 1), n = new Date(vy, vm + 1, 0).getDate(), t = todayStr();
        $('#ct', el).textContent = first.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
        let h = '<span></span>'.repeat(first.getDay());
        for (let d = 1; d <= n; d++) {
          const ds = `${vy}-${pad(vm + 1)}-${pad(d)}`;
          h += `<button type="button" class="day${sel.has(ds) ? ' on' : ''}${ds === t ? ' now' : ''}" data-d="${ds}">${d}</button>`;
        }
        $('#days', el).innerHTML = h;
        const list = [...sel].sort();
        $('#picked', el).innerHTML = list.length
          ? `<b>${list.length} date${list.length > 1 ? 's' : ''} selected:</b> ` + list.map(d => `<span class="pill" data-rm="${d}" title="Remove">${esc(new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }))} ✕</span>`).join(' ')
          : '<span class="muted">No dates selected yet.</span>';
        $('#sv', el).textContent = !editing && list.length > 1 ? `Save ${list.length} schedules` : 'Save';
      };
      draw();
      const step = k => { vm += k; if (vm < 0) { vm = 11; vy--; } if (vm > 11) { vm = 0; vy++; } draw(); };
      $('#pm', el).onclick = () => step(-1);
      $('#nm', el).onclick = () => step(1);
      $('#days', el).onclick = ev => {
        const b = ev.target.closest('[data-d]'); if (!b) return;
        const d = b.dataset.d;
        if (editing) { sel.clear(); sel.add(d); } else sel.has(d) ? sel.delete(d) : sel.add(d);
        draw();
      };
      $('#picked', el).onclick = ev => { const p = ev.target.closest('[data-rm]'); if (p && !editing) { sel.delete(p.dataset.rm); draw(); } };
      $('#ef', el).addEventListener('submit', async ev => {
        ev.preventDefault();
        if (!sel.size) { toast('Tap at least one date on the calendar.', true); return; }
        const body = Object.fromEntries(new FormData(ev.target));
        body.id = e.id || 0;
        body.dates = [...sel].sort();
        body.event_date = body.dates[0];
        if (await busy($('#sv', el), () => call('event_save', body, true))) { close(); done(); }
      });
    });
  return m;
}

VIEWS.schedule = async () => {
  const tok = routeTok;
  let rows = await call('events_list'); if (!rows) return;
  const today = todayStr();
  let tab = 'upcoming';
  const draw = () => {
    const list = rows.filter(e => tab === 'all' ? true : tab === 'upcoming' ? e.event_date >= today : e.event_date < today);
    if (tab === 'past') list.reverse();
    $('#sch').innerHTML = list.length ? `<div class="tw tc"><table><thead><tr><th>Date</th><th>Title</th><th>For</th><th>Added by</th><th>Marked</th><th></th></tr></thead><tbody>
      ${list.map(e => `<tr><td data-label="Date"><span><b>${esc(fmtDate(e.event_date))}</b><br><small>${esc(timeRange(e))}${e.location ? ' · ' + esc(e.location) : ''}</small></span></td>
        <td data-label="Title"><span>${esc(e.title)} ${e.event_date === today ? '<span class="pill today">Today</span>' : ''}</span></td>
        <td data-label="For">${evFor(e)}</td><td data-label="Added by">${esc(e.added_by || 'Secretariat')}</td><td data-label="Marked">${e.marked}/${e.total}</td>
        <td class="act" style="white-space:nowrap;text-align:right"><a class="btn sm" href="#/attendance/${e.id}"><i class="fas fa-clipboard-check"></i> Attendance</a>
          ${e.can_edit ? `<button class="btn sm ghost" data-edit="${e.id}" aria-label="Edit">Edit</button><button class="btn sm no" data-del="${e.id}" aria-label="Delete">Delete</button>` : '<span class="sub">View only</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No schedules here.</div>';
  };
  view().innerHTML = `<div class="card">
    <div class="head"><div><h3>Schedule</h3><div class="sub">${isSec() ? 'Fixed events are for everyone. You can also add a schedule for one committee.' : 'Fixed events come from the Secretariat. You can add schedules for your own committee.'}</div></div>
      <button class="btn pri" id="add"><i class="fas fa-plus"></i> Add schedule</button></div>
    <div class="chips" id="tabs"><button class="chip on" data-t="upcoming">Upcoming</button><button class="chip" data-t="past">Past</button><button class="chip" data-t="all">All</button></div>
    <div id="sch"></div></div>`;
  const reload = () => route();
  draw();
  liveRefresh = async () => { const r = await api('events_list'); if (!r.success || tok !== routeTok) return false; rows = r.data; draw(); };
  $('#add').onclick = () => eventModal(null, reload);
  $('#tabs').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; tab = b.dataset.t; $$('#tabs .chip').forEach(c => c.classList.toggle('on', c === b)); draw(); };
  $('#sch').onclick = async e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) eventModal(rows.find(r => r.id == ed.dataset.edit), reload);
    if (del) {
      const ev = rows.find(r => r.id == del.dataset.del);
      if (await ask('Delete this schedule?', `"${ev.title}" and all attendance recorded for it will be deleted.`, 'Delete')) { if (await call('event_delete', { id: ev.id }, true)) reload(); }
    }
  };
};

/* ================= ATTENDANCE ================= */
VIEWS.attendance = async arg => arg ? takeAttendance(+arg) : pickEvent();

async function pickEvent(live) {
  const tok = routeTok;
  let all;
  if (live) { const r = await api('events_list'); if (!r.success || tok !== routeTok) return false; all = r.data; }
  else { all = await call('events_list'); if (!all) return; }
  const rows = all.filter(e => e.event_date >= SEASON_START && e.event_date <= SEASON_END);
  const today = todayStr(), pad = n => String(n).padStart(2, '0');
  const byDate = {};
  rows.forEach(e => (byDate[e.event_date] = byDate[e.event_date] || []).push(e));
  let sel = pickUI.sel || clampDay(today); // opens on the current month (kept inside Nov 1 – Dec 24, 2026)
  const b0 = new Date(sel + 'T00:00:00');
  let vy = pickUI.vy ?? b0.getFullYear(), vm = pickUI.vm ?? b0.getMonth(), tab = pickUI.tab || 'upcoming';

  const sub = e => [timeRange(e), e.location].filter(Boolean).map(esc).join(' · ') || '<span class="muted">No time set</span>';
  const pct = e => e.total ? Math.round(e.marked / e.total * 100) : 0;
  const meter = e => `<div class="meter"><i style="width:${pct(e)}%;background:${e.marked >= e.total && e.total ? 'var(--ok)' : 'var(--gold)'}"></i></div>`;
  const btn = e => `<a class="btn sm pri" href="#/attendance/${e.id}"><i class="fas fa-clipboard-check"></i> ${e.marked ? 'Review / edit' : 'Take attendance'}</a>`;
  const badge = d => { const x = new Date(d + 'T00:00:00'); return `<div class="dbadge"><small>${x.toLocaleDateString('en-PH', { month: 'short' })}</small><b>${x.getDate()}</b></div>`; };

  // Important activity: today's unfinished one, else today's first, else the next upcoming
  const todayEv = rows.filter(e => e.event_date === today);
  const feat = todayEv.find(e => e.marked < e.total) || todayEv[0] || rows.find(e => e.event_date > today);

  const featHtml = feat ? `<div class="feat">
      <div class="feat-top"><span class="pill ${feat.event_date === today ? 'today' : 'fixed'}">${feat.event_date === today ? 'Happening today' : 'Next up'}</span>
        <span class="feat-tag"><i class="fas fa-star"></i> Important activity</span></div>
      <div class="feat-main"><div><h3>${esc(feat.title)}</h3>
        <div class="feat-meta"><i class="fas fa-calendar-day"></i> ${esc(fmtDate(feat.event_date))}</div>
        <div class="feat-meta"><i class="fas fa-clock"></i> ${sub(feat)}</div>
        <div style="margin-top:8px">${evFor(feat)}</div></div>
        <a class="btn pri feat-btn" href="#/attendance/${feat.id}"><i class="fas fa-clipboard-check"></i> ${feat.marked ? 'Review / edit attendance' : 'Take attendance'}</a></div>
      <div class="feat-prog"><span>${feat.marked}/${feat.total} marked · ${feat.present} present</span><b>${pct(feat)}%</b></div>${meter(feat)}
    </div>` : '';

  view().innerHTML = `${featHtml}
    <div class="grid2 attgrid">
      <div class="card"><div class="head"><div><h3>All schedules</h3><div class="sub">Pick one to take or review its attendance.</div></div></div>
        <div class="chips" id="tabs"><button class="chip on" data-t="upcoming">Upcoming</button><button class="chip" data-t="past">Earlier</button><button class="chip" data-t="all">All</button></div>
        <div id="lst"></div></div>
      <div class="card"><div class="head"><div><h3>Calendar</h3><div class="sub">Tap a date with a dot to open its attendance.</div></div><button class="btn sm" id="tdy">Today</button></div>
        <div class="cal big">
          <div class="cal-nav"><button type="button" class="btn sm ghost" id="pm" aria-label="Previous month">‹</button><b id="ct"></b><button type="button" class="btn sm ghost" id="nm" aria-label="Next month">›</button></div>
          <div class="cal-w"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
          <div class="cal-g" id="days"></div>
        </div>
        <div id="dayev" style="margin-top:14px"></div></div>
    </div>`;

  const drawLst = () => {
    pickUI = { sel, vy, vm, tab };
    let list = rows.filter(e => tab === 'all' ? true : tab === 'upcoming' ? e.event_date >= today : e.event_date < today);
    if (tab === 'past') list = list.reverse();
    $('#lst').innerHTML = list.length ? list.map(e => `<div class="evrow${e.event_date === today ? ' istoday' : ''}">
      ${badge(e.event_date)}
      <div class="evbody"><b>${esc(e.title)}</b> ${e.event_date === today ? '<span class="pill today">Today</span>' : ''}
        <div class="sub">${esc(fmtDate(e.event_date))} · ${sub(e)}</div>
        <div style="margin:4px 0 2px">${evFor(e)} <span class="sub">${e.marked}/${e.total} marked · ${e.present} present</span></div>${meter(e)}</div>
      ${btn(e)}</div>`).join('') : '<div class="empty">No schedules here.</div>';
  };
  const drawDay = () => {
    const list = byDate[sel] || [];
    $('#dayev').innerHTML = `<div class="sub" style="font-weight:700;color:var(--ink);margin-bottom:4px">${esc(fmtDate(sel))}</div>` +
      (list.length ? list.map(e => `<div class="row"><div><b>${esc(e.title)}</b><br><span class="sub">${sub(e)}</span></div>${btn(e)}</div>`).join('')
        : '<div class="sub">No schedule on this date.</div>');
  };
  const drawCal = () => {
    pickUI = { sel, vy, vm, tab };
    const first = new Date(vy, vm, 1), n = new Date(vy, vm + 1, 0).getDate();
    $('#ct').textContent = first.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
    let h = '<span></span>'.repeat(first.getDay());
    for (let d = 1; d <= n; d++) {
      const ds = `${vy}-${pad(vm + 1)}-${pad(d)}`, evs = byDate[ds] || [], off = ds < SEASON_START || ds > SEASON_END;
      const dots = evs.slice(0, 4).map(e => `<i style="background:${esc(e.committee_id ? comColor(e.committee_id) : '#0F3D2E')}"></i>`).join('');
      h += `<button type="button" class="day${ds === sel ? ' on' : ''}${ds === today ? ' now' : ''}${evs.length ? ' has' : ''}" data-d="${ds}"${off ? ' disabled aria-disabled="true"' : ''}>${d}<span class="dots">${dots}</span></button>`;
    }
    $('#days').innerHTML = h;
    $('#pm').disabled = vy * 12 + vm <= 2026 * 12 + 10;
    $('#nm').disabled = vy * 12 + vm >= 2026 * 12 + 11;
  };
  const step = k => { const n = vy * 12 + vm + k; if (n < 2026 * 12 + 10 || n > 2026 * 12 + 11) return; vy = Math.floor(n / 12); vm = n % 12; drawCal(); };
  $$('#tabs .chip').forEach(c => c.classList.toggle('on', c.dataset.t === tab));
  drawLst(); drawCal(); drawDay();
  $('#tabs').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; tab = b.dataset.t; $$('#tabs .chip').forEach(c => c.classList.toggle('on', c === b)); drawLst(); };
  $('#pm').onclick = () => step(-1);
  $('#nm').onclick = () => step(1);
  $('#tdy').onclick = () => { sel = clampDay(today); const t = new Date(sel + 'T00:00:00'); vy = t.getFullYear(); vm = t.getMonth(); drawCal(); drawDay(); };
  $('#days').onclick = e => {
    const b = e.target.closest('[data-d]'); if (!b || b.disabled) return;
    sel = b.dataset.d;
    const evs = byDate[sel] || [];
    if (evs.length === 1) { location.hash = '#/attendance/' + evs[0].id; return; } // one schedule: go straight to attendance
    drawCal(); drawDay();
    if (!evs.length) toast('No schedule on this date.', true);
  };
  liveRefresh = () => pickEvent(true);
}

async function takeAttendance(id) {
  const d = await call('att_get', { event_id: id }); if (!d) { location.hash = '#/attendance'; return; }
  const tok = routeTok;
  const ev = d.event; let members = leadersFirst(d.members); // leaders always on top
  const state = new Map(), base = new Map(); // member_id -> {status|null, time_in, reason}; base = last version from the server
  const fromServer = m => ({ status: m.status || null, time_in: (m.time_in || '').slice(0, 5), reason: m.reason || '' });
  members.forEach(m => { const s = fromServer(m); state.set(+m.member_id, s); base.set(+m.member_id, JSON.stringify(s)); });
  const dirty = () => [...state].some(([mid, s]) => JSON.stringify(s) !== base.get(mid));
  leaveGuard = dirty;
  const multi = isSec() && !ev.committee_id; // Secretariat on a whole-group event sees several committees
  const evName = ev.committee_id ? (COMMITTEES.find(c => +c.id === +ev.committee_id) || {}).name : null;
  let q = '', cf = '';

  view().innerHTML = `
    <div class="card">
      <a class="btn sm ghost" href="#/attendance" style="margin-bottom:12px"><i class="fas fa-arrow-left"></i> All schedules</a>
      <div class="head"><div><h3>${esc(ev.title)}</h3><div class="sub">${evMeta(ev)}</div>
        <div style="margin-top:6px">${ev.committee_id ? comTag(evName, ev.committee_id) : '<span class="pill fixed">Whole group</span>'}</div></div></div>
      <div class="stats" id="cnt" style="margin-bottom:0"></div>
    </div>
    <div class="card">
      <div class="bar"><input id="q" type="search" placeholder="Search name, ministry or committee…" aria-label="Search">
        ${multi ? `<select id="cf" aria-label="Committee"><option value="">All committees</option>${COMMITTEES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>` : ''}
        <button class="btn sm ok" id="allp"><i class="fas fa-check-double"></i> Mark all present</button>
        <button class="btn sm ghost" id="clr">Clear all</button></div>
      <div class="tw" id="list" style="border-radius:var(--r)"></div>
      <div class="actions stick"><button class="btn pri" id="save"><i class="fas fa-floppy-disk"></i> Save attendance</button></div>
    </div>`;

  const counts = () => {
    let p = 0, a = 0, x = 0, n = 0;
    state.forEach(s => { if (s.status === 'present') p++; else if (s.status === 'absent') a++; else if (s.status === 'excused') x++; else n++; });
    $('#cnt').innerHTML = `<div class="stat"><b>${p}</b><span>Present</span></div><div class="stat red"><b>${a}</b><span>Absent</span></div>
      <div class="stat gold"><b>${x}</b><span>Excused</span></div><div class="stat" style="border-left-color:#94a3b8"><b>${n}</b><span>Not yet modified</span></div>`;
  };
  const rowHtml = m => {
    const s = state.get(+m.member_id);
    return `<div class="arow${isLead(m) ? ' isl' : ''}" data-m="${m.member_id}">
      <div class="who2"><b>${esc(m.full_name)}</b>${roleBadge(m.member_role)}<br><small>${comTag(m.committee_name)} · ${esc(m.ministry || 'No ministry')}${m.scholar_type !== 'none' ? ' · <span class="pill">' + esc(SCHOLAR_SHORT[m.scholar_type]) + ' scholar</span>' : ''}</small></div>
      <div class="ctl"><div class="seg">${['present', 'absent', 'excused'].map(v => `<button type="button" data-v="${v}" class="${s.status === v ? 'on' : ''}">${STATUS_LABEL[v]}</button>`).join('')}</div>
        <label class="tin ${s.status === 'present' ? '' : 'hidden'}">In <input type="time" class="ti" value="${esc(s.time_in)}"></label></div>
      <input class="reason ${s.status === 'excused' ? '' : 'hidden'}" maxlength="255" placeholder="Reason for excuse (required)" value="${esc(s.reason)}"></div>`;
  };
  const draw = () => {
    const list = members.filter(m => (!cf || +m.committee_id === +cf || m.committee_name === (COMMITTEES.find(c => +c.id === +cf) || {}).name) &&
      (!q || norm(m.full_name + m.ministry + m.committee_name + (isLead(m) ? 'leader' : '')).includes(norm(q))));
    $('#list').innerHTML = list.length ? list.map(rowHtml).join('') : '<div class="empty">No members found. Add members in the Members page.</div>';
  };
  counts(); draw();

  $('#q').oninput = e => { q = e.target.value; draw(); };
  if (multi) $('#cf').onchange = e => { cf = e.target.value; draw(); };
  $('#allp').onclick = () => {
    $$('#list .arow').forEach(r => { const s = state.get(+r.dataset.m); if (s.status !== 'present') { s.status = 'present'; s.time_in = s.time_in || nowHM(); s.reason = ''; } });
    counts(); draw();
  };
  $('#clr').onclick = () => { $$('#list .arow').forEach(r => { state.set(+r.dataset.m, { status: null, time_in: '', reason: '' }); }); counts(); draw(); };
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('.seg button'); if (!b) return;
    const row = b.closest('.arow'), s = state.get(+row.dataset.m), v = b.dataset.v;
    s.status = s.status === v ? null : v; // tap again to un-mark
    if (s.status === 'present' && !s.time_in) s.time_in = nowHM();
    $$('.seg button', row).forEach(x => x.classList.toggle('on', x.dataset.v === s.status));
    $('.tin', row).classList.toggle('hidden', s.status !== 'present');
    $('.ti', row).value = s.time_in;
    const rs = $('.reason', row); rs.classList.toggle('hidden', s.status !== 'excused');
    if (s.status === 'excused') rs.focus();
    counts();
  });
  $('#list').addEventListener('input', e => {
    const row = e.target.closest('.arow'); if (!row) return;
    const s = state.get(+row.dataset.m);
    if (e.target.classList.contains('reason')) s.reason = e.target.value;
    if (e.target.classList.contains('ti')) s.time_in = e.target.value;
  });
  $('#save').onclick = e => busy(e.currentTarget, async () => {
    const records = [];
    for (const [mid, s] of state) {
      if (!s.status) { if (JSON.parse(base.get(mid)).status) records.push({ member_id: mid, status: 'clear' }); continue; } // was saved, now un-marked
      if (s.status === 'excused' && !s.reason.trim()) {
        const m = members.find(x => +x.member_id === mid);
        toast(`Type a reason for ${m.full_name} (excused).`, true);
        q = ''; if (multi) cf = ''; $('#q').value = ''; draw();
        const r = $(`.arow[data-m="${mid}"] .reason`); if (r) { r.scrollIntoView({ block: 'center' }); r.focus(); }
        return;
      }
      records.push({ member_id: mid, status: s.status, time_in: s.status === 'present' ? s.time_in : '', reason: s.status === 'excused' ? s.reason.trim() : '' });
    }
    if (!records.length) { toast('Mark at least one member first.', true); return; }
    const ok = await call('att_save', { event_id: id, records }, true);
    if (ok) { leaveGuard = null; location.hash = '#/attendance'; }
  });

  // Live: pull in what other leaders/Secretariat marked, but never overwrite taps you haven't saved yet
  liveRefresh = async () => {
    const a = document.activeElement;
    if (a && $('#list') && $('#list').contains(a) && a.matches('input,textarea')) return false; // you're typing a reason/time
    const r = await api('att_get', { event_id: id });
    if (!r.success || tok !== routeTok) return false;
    members = leadersFirst(r.data.members);
    const ids = new Set();
    members.forEach(m => {
      const mid = +m.member_id, srv = fromServer(m), cur = state.get(mid);
      ids.add(mid);
      if (!cur || JSON.stringify(cur) === base.get(mid)) state.set(mid, srv); // untouched here → take the server's version
      base.set(mid, JSON.stringify(srv));
    });
    [...state.keys()].forEach(mid => { if (!ids.has(mid)) { state.delete(mid); base.delete(mid); } });
    counts(); draw();
  };
}

/* ================= MEMBERS ================= */
function memberModal(m, done) {
  m = m || {};
  modal(`<h3>${m.id ? 'Edit member' : 'Add member'}</h3>
    <form id="mf">
      <label>Full name<input name="full_name" maxlength="100" required value="${esc(m.full_name)}"></label>
      ${isSec() ? `<label>Committee<select name="committee_id" required><option value="">Choose…</option>${COMMITTEES.map(c => `<option value="${c.id}" ${+m.committee_id === +c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`
        : `<p class="sub" style="margin-top:12px">Committee: <b>${esc(ME.committee_name || '')}</b></p>`}
      <label>Role<select name="member_role"><option value="member" ${m.member_role !== 'leader' ? 'selected' : ''}>Member</option><option value="leader" ${m.member_role === 'leader' ? 'selected' : ''}>Leader (always shown on top)</option></select></label>
      <label>Ministry<input name="ministry" maxlength="100" value="${esc(m.ministry)}" placeholder="e.g. Youth, Choir, Altar servers"></label>
      <label>Scholar<select name="scholar_type">${Object.entries(SCHOLAR).map(([k, v]) => `<option value="${k}" ${(m.scholar_type || 'none') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Status<select name="status"><option value="active" ${m.status !== 'inactive' ? 'selected' : ''}>Active</option><option value="inactive" ${m.status === 'inactive' ? 'selected' : ''}>Inactive (hidden from attendance)</option></select></label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn pri">Save</button></div>
    </form>`, (el, close) => {
      $('#mf', el).addEventListener('submit', async ev => {
        ev.preventDefault();
        const body = Object.fromEntries(new FormData(ev.target)); body.id = m.id || 0;
        if (await busy($('.pri', el), () => call('member_save', body, true))) { close(); done(); }
      });
    });
}

/** Turn a sheet (array of arrays) into [{full_name, committee, ministry, scholar, role}] */
function sheetToRows(matrix) {
  matrix = matrix.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!matrix.length) return [];
  const idx = { name: -1, committee: -1, ministry: -1, scholar: -1, role: -1 };
  matrix[0].forEach((h, i) => {
    const k = norm(h);
    if (['name', 'fullname', 'membername', 'names'].includes(k)) idx.name = i;
    else if (k.startsWith('committee')) idx.committee = i;
    else if (k.startsWith('ministr')) idx.ministry = i;
    else if (k.startsWith('scholar')) idx.scholar = i;
    else if (k === 'role' || k === 'position') idx.role = i;
  });
  let start = 1;
  if (idx.name < 0 || idx.committee < 0) { idx.name = 0; idx.committee = 1; idx.ministry = 2; idx.scholar = 3; idx.role = 4; start = 0; }
  return matrix.slice(start).map(r => ({
    full_name: String(r[idx.name] ?? '').trim(), committee: String(r[idx.committee] ?? '').trim(),
    ministry: idx.ministry >= 0 ? String(r[idx.ministry] ?? '').trim() : '', scholar: idx.scholar >= 0 ? String(r[idx.scholar] ?? '').trim() : '',
    role: idx.role >= 0 ? String(r[idx.role] ?? '').trim() : ''
  })).filter(r => r.full_name);
}
function parseText(txt) {
  const lines = txt.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.some(l => l.includes('\t'))) return lines.map(l => l.split('\t'));
  const out = [];
  for (const line of lines) { // small CSV parser (handles "quoted, names")
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur); out.push(cells);
  }
  return out;
}
function importModal(done) {
  let rows = [];
  modal(`<h3>Import members</h3>
    <p class="sub">Columns: <b>Name, Committee, Ministry, Scholar, Role</b>. Committee must be one of: ${COMMITTEES.map(c => esc(c.name)).join(', ')}. Scholar is <i>None</i>, <i>SHS</i> or <i>College</i>. Role is <i>Leader</i> or <i>Member</i> (blank = Member).</p>
    <label>Excel / CSV file<input type="file" id="file" accept=".xlsx,.xls,.csv"></label>
    <label>…or paste rows (copy straight from Excel)<textarea id="paste" placeholder="Juan Dela Cruz&#9;Props&#9;Youth&#9;College&#9;Leader"></textarea></label>
    <div class="msg" id="pv" style="color:var(--soft)"></div>
    <div class="actions"><button type="button" class="btn ghost" id="tpl"><i class="fas fa-download"></i> Template</button><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn pri" id="go" disabled>Import</button></div>`,
    (el, close) => {
      const set = r => { rows = r; $('#pv', el).textContent = r.length ? `${r.length} member${r.length > 1 ? 's' : ''} ready to import.` : 'Nothing found yet.'; $('#go', el).disabled = !r.length; };
      $('#paste', el).addEventListener('input', e => set(sheetToRows(parseText(e.target.value))));
      $('#file', el).addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          if (/\.csv$/i.test(f.name)) set(sheetToRows(parseText(await f.text())));
          else if (window.XLSX) { const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' }); set(sheetToRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }))); }
          else toast('Excel reader did not load. Save as CSV or paste the rows.', true);
        } catch (x) { toast('Could not read that file.', true); }
      });
      $('#tpl', el).onclick = () => exportRows('xlsx', 'members-template', ['Name', 'Committee', 'Ministry', 'Scholar', 'Role'], [['Juan Dela Cruz', 'Props', 'Youth', 'None', 'Leader'], ['Maria Santos', 'Canvas', 'Choir', 'SHS', 'Member'], ['Pedro Reyes', 'Final Dance', 'Altar servers', 'College', 'Member']]);
      $('#go', el).onclick = async e => {
        const d = await busy(e.currentTarget, () => api('members_import', { rows }));
        if (d && d.success) { toast(d.message); close(); done(); } else if (d) toast(d.message, true);
      };
    });
}

/** Turn pasted/uploaded rows into [{n, m, s, r}] for the Insert members popup. Columns: Full name, Ministry, Scholar, Role */
function parseMemberRows(matrix) {
  matrix = matrix.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!matrix.length) return [];
  const NAMES = ['name', 'fullname', 'membername', 'names'];
  let ni = 0, mi = 1, si = 2, ri = 3, start = 0;
  const h = matrix[0].map(norm);
  if (h.some(k => NAMES.includes(k))) {
    start = 1; ri = -1;
    h.forEach((k, i) => { if (NAMES.includes(k)) ni = i; else if (k.startsWith('ministr')) mi = i; else if (k.startsWith('scholar')) si = i; else if (k === 'role' || k === 'position') ri = i; });
  }
  const sk = v => { const s = norm(v); return (s.startsWith('shs') || s.includes('seniorhigh')) ? 'shs' : s.includes('college') ? 'college' : 'none'; };
  const rk = v => { const s = norm(v); return (s.includes('lead') || s.includes('head')) ? 'leader' : 'member'; };
  return matrix.slice(start).map(r => ({ n: String(r[ni] ?? '').trim(), m: String(r[mi] ?? '').trim(), s: sk(r[si]), r: ri >= 0 ? rk(r[ri]) : 'member' })).filter(r => r.n);
}

function insertModal(done) {
  const blank = () => ({ n: '', m: '', s: 'none', r: 'member' });
  let rows = [blank(), blank(), blank()];
  modal(`<h3>Insert members</h3>
    <p class="sub">${isSec() ? 'Pick the committee, then add the members.' : 'They will be added to <b>' + esc(ME.committee_name || 'your committee') + '</b>.'} Status is set to <b>Active</b> automatically.</p>
    ${isSec() ? `<label>Committee<select id="icom"><option value="">Choose…</option>${COMMITTEES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>` : ''}
    <div class="irow ihead"><span>Full name</span><span>Ministry</span><span>Role</span><span>Scholar</span><span></span></div>
    <div id="irows"></div>
    <div class="bar" style="margin:10px 0 0">
      <button type="button" class="btn sm" id="iadd"><i class="fas fa-plus"></i> Add row</button>
      <button type="button" class="btn sm" id="ifile"><i class="fas fa-file-excel"></i> Upload Excel / CSV</button>
      <button type="button" class="btn sm ghost" id="itpl"><i class="fas fa-download"></i> Template</button>
      <input type="file" id="ifl" class="hidden" accept=".xlsx,.xls,.csv"></div>
    <label>Or paste rows copied from Excel <span class="muted">(Full name, Ministry, Scholar, Role)</span>
      <textarea id="ipaste" style="min-height:70px" placeholder="Tap here and paste"></textarea></label>
    <div class="msg" id="ipv" style="color:var(--soft);min-height:20px"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn pri" id="isave"><i class="fas fa-floppy-disk"></i> <span id="ilabel">Save members</span></button></div>`,
    (el, close) => {
      $('.box', el).style.maxWidth = '860px';
      const draw = focusLast => {
        $('#irows', el).innerHTML = rows.map((r, i) => `<div class="irow" data-i="${i}">
          <input class="nm" data-f="n" maxlength="100" placeholder="Full name" value="${esc(r.n)}" aria-label="Full name">
          <input data-f="m" maxlength="100" placeholder="e.g. Youth, Choir" value="${esc(r.m)}" aria-label="Ministry">
          <select data-f="r" aria-label="Role">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${r.r === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <select data-f="s" aria-label="Scholar">${Object.entries(SCHOLAR).map(([k, v]) => `<option value="${k}" ${r.s === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <button type="button" class="btn sm no rm" data-rm="${i}" aria-label="Remove row">✕</button></div>`).join('');
        count();
        if (focusLast) { const n = $$('#irows .nm', el); n[n.length - 1].focus(); }
      };
      const count = () => {
        const n = rows.filter(r => r.n.trim()).length;
        $('#ilabel', el).textContent = n ? `Save ${n} member${n > 1 ? 's' : ''}` : 'Save members';
      };
      const addRows = list => {
        rows = rows.filter(r => r.n.trim() || r.m.trim()).concat(list);
        if (!rows.length) rows = [blank()];
        draw(); $('#ipv', el).textContent = `${list.length} row${list.length > 1 ? 's' : ''} added to the list. Check them, then Save.`;
      };
      draw();
      $('#iadd', el).onclick = () => { rows.push(blank()); draw(true); };
      $('#irows', el).addEventListener('input', e => {
        const row = e.target.closest('.irow'); if (!row || !e.target.dataset.f) return;
        rows[+row.dataset.i][e.target.dataset.f] = e.target.value; count();
      });
      $('#irows', el).addEventListener('click', e => {
        const b = e.target.closest('[data-rm]'); if (!b) return;
        rows.splice(+b.dataset.rm, 1); if (!rows.length) rows = [blank()]; draw();
      });
      $('#irows', el).addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.target.tagName === 'SELECT') return;
        e.preventDefault();
        const row = e.target.closest('.irow'), i = +row.dataset.i;
        if (i === rows.length - 1) { rows.push(blank()); draw(true); } else $$('#irows .nm', el)[i + 1].focus();
      });
      $('#ipaste', el).addEventListener('paste', e => {
        const txt = (e.clipboardData || window.clipboardData).getData('text');
        e.preventDefault();
        const list = parseMemberRows(parseText(txt));
        if (list.length) addRows(list); else toast('Nothing to add from that paste.', true);
      });
      $('#ifile', el).onclick = () => $('#ifl', el).click();
      $('#ifl', el).addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          let list;
          if (/\.csv$/i.test(f.name)) list = parseMemberRows(parseText(await f.text()));
          else if (window.XLSX) { const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' }); list = parseMemberRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })); }
          else { toast('Excel reader did not load. Save as CSV or paste the rows.', true); return; }
          if (list.length) addRows(list); else toast('No names found in that file.', true);
        } catch (x) { toast('Could not read that file.', true); }
        e.target.value = '';
      });
      $('#itpl', el).onclick = () => exportRows('xlsx', 'members-template', ['Full name', 'Ministry', 'Scholar', 'Role'], [['Juan Dela Cruz', 'Youth', 'College', 'Leader'], ['Maria Santos', 'Choir', 'SHS', 'Member'], ['Pedro Reyes', 'Altar servers', 'None', 'Member']]);
      $('#isave', el).onclick = async e => {
        const list = rows.filter(r => r.n.trim()).map(r => ({ full_name: r.n.trim(), ministry: r.m.trim(), scholar: r.s, role: r.r }));
        if (!list.length) { toast('Type at least one full name.', true); return; }
        const body = { rows: list };
        if (isSec()) { body.committee_id = +$('#icom', el).value; if (!body.committee_id) { toast('Choose a committee first.', true); return; } }
        const d = await busy(e.currentTarget, () => api('members_bulk', body));
        if (d && d.success) { toast(d.message); close(); done(); } else if (d && d.code !== 'auth') toast(d.message, true);
      };
    });
}

VIEWS.members = async () => {
  const tok = routeTok;
  let rows = await call('members_list'); if (!rows) return;
  let q = '', cf = '', sf = '', rf = '', st = 'active';
  view().innerHTML = `<div class="card">
    <div class="head"><div><h3>${isSec() ? 'All members' : esc(ME.committee_name || '') + ' members'}</h3><div class="sub" id="mc"></div></div>
      <div class="bar" style="margin:0"><button class="btn pri" id="add"><i class="fas fa-user-plus"></i> Add member</button><button class="btn" id="ins"><i class="fas fa-table-list"></i> Insert members</button>${isSec() ? '<button class="btn" id="imp"><i class="fas fa-file-import"></i> Import</button>' : ''}</div></div>
    <div class="bar"><input id="q" type="search" placeholder="Search name, ministry or committee…" aria-label="Search">
      ${isSec() ? `<select id="cf" aria-label="Committee"><option value="">All committees</option>${COMMITTEES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>` : ''}
      <select id="rf" aria-label="Role"><option value="">All roles</option><option value="leader">Leaders</option><option value="member">Members</option></select>
      <select id="sf" aria-label="Scholar"><option value="">All scholars</option><option value="none">Not a scholar</option><option value="shs">SHS Scholar</option><option value="college">College Scholar</option></select>
      <select id="st" aria-label="Status"><option value="active">Active</option><option value="inactive">Inactive</option><option value="">All</option></select></div>
    <div id="tb"></div></div>`;
  const draw = () => {
    const list = leadersFirst(rows.filter(m => (!cf || +m.committee_id === +cf) && (!rf || m.member_role === rf) && (!sf || m.scholar_type === sf) && (!st || m.status === st) &&
      (!q || norm(m.full_name + m.ministry + m.committee_name + (isLead(m) ? 'leader' : '')).includes(norm(q)))));
    $('#mc').textContent = `${list.length} shown of ${rows.length}`;
    $('#tb').innerHTML = list.length ? `<div class="tw tc"><table><thead><tr><th>Name</th>${isSec() ? '<th>Committee</th>' : ''}<th>Role</th><th>Ministry</th><th>Scholar</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(m => `<tr class="${isLead(m) ? 'isl' : ''}"><td data-label="Name"><b>${esc(m.full_name)}</b></td>${isSec() ? `<td data-label="Committee">${comTag(m.committee_name, m.committee_id)}</td>` : ''}
        <td data-label="Role">${isLead(m) ? roleBadge('leader') : '<span class="pill member">Member</span>'}</td>
        <td data-label="Ministry">${esc(m.ministry) || '<small>—</small>'}</td>
        <td data-label="Scholar">${m.scholar_type === 'none' ? '<small>—</small>' : esc(SCHOLAR[m.scholar_type])}</td><td data-label="Status"><span class="pill ${m.status}">${m.status}</span></td>
        <td class="act" style="white-space:nowrap;text-align:right"><button class="btn sm ghost" data-edit="${m.id}" aria-label="Edit ${esc(m.full_name)}">Edit</button>
        ${isSec() ? `<button class="btn sm no" data-del="${m.id}" aria-label="Delete ${esc(m.full_name)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No members yet. Use “Add member”' + (isSec() ? ' or “Import”' : '') + '.</div>';
  };
  draw();
  liveRefresh = async () => { const r = await api('members_list'); if (!r.success || tok !== routeTok) return false; rows = r.data; draw(); };
  $('#q').oninput = e => { q = e.target.value; draw(); };
  if (isSec()) $('#cf').onchange = e => { cf = e.target.value; draw(); };
  $('#rf').onchange = e => { rf = e.target.value; draw(); };
  $('#sf').onchange = e => { sf = e.target.value; draw(); };
  $('#st').onchange = e => { st = e.target.value; draw(); };
  $('#add').onclick = () => memberModal(null, route);
  $('#ins').onclick = () => insertModal(route);
  if (isSec()) $('#imp').onclick = () => importModal(route);
  $('#tb').onclick = async e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) memberModal(rows.find(m => m.id == ed.dataset.edit), route);
    if (del) {
      const m = rows.find(x => x.id == del.dataset.del);
      if (await ask('Delete member?', `${m.full_name} and all of their attendance records will be permanently deleted. (To keep history, set them Inactive instead.)`, 'Delete')) { if (await call('member_delete', { id: m.id }, true)) route(); }
    }
  };
};

/* ================= RECORDS ================= */
VIEWS.records = async () => {
  let data = [], mode = 'member', q = '';
  const cSel = new Set(), sSel = new Set();
  let leadOnly = false;
  view().innerHTML = `<div class="card"><div class="head"><div><h3>Attendance records</h3><div class="sub">Every schedule in the date range. Anyone not marked Present, Excused or Absent shows as Not yet modified.</div></div></div>
    <div class="bar"><label class="fl">From<input type="date" id="from" value="${clampDay(todayStr())}" min="${SEASON_START}" max="${SEASON_END}"></label><label class="fl">To<input type="date" id="to" value="${SEASON_END}" min="${SEASON_START}" max="${SEASON_END}"></label></div>
    ${isSec() ? `<div class="sub">Committees</div><div class="chips" id="cc">${COMMITTEES.map(c => `<button class="chip" data-c="${c.id}">${esc(c.name)}</button>`).join('')}</div>` : ''}
    <div class="sub">Scholar type</div><div class="chips" id="sc"><button class="chip" data-s="none">Not a scholar</button><button class="chip" data-s="shs">SHS</button><button class="chip" data-s="college">College</button></div>
    <div class="sub">Role</div><div class="chips" id="rc"><button class="chip" data-r="leader"><i class="fas fa-star"></i> Leaders only</button></div>
    <button class="btn pri" id="run"><i class="fas fa-magnifying-glass"></i> Show records</button></div>
    <div id="out"></div>`;
  const toggle = (set, v, btn) => { set.has(v) ? set.delete(v) : set.add(v); btn.classList.toggle('on', set.has(v)); };
  if (isSec()) $('#cc').onclick = e => { const b = e.target.closest('[data-c]'); if (b) toggle(cSel, +b.dataset.c, b); };
  $('#sc').onclick = e => { const b = e.target.closest('[data-s]'); if (b) toggle(sSel, b.dataset.s, b); };
  $('#rc').onclick = e => { const b = e.target.closest('[data-r]'); if (b) { leadOnly = !leadOnly; b.classList.toggle('on', leadOnly); } };

  const byMember = () => {
    const m = new Map();
    data.forEach(r => {
      let x = m.get(r.member_id);
      if (!x) m.set(r.member_id, x = { member: r.member, committee: r.committee, ministry: r.ministry, scholar: r.scholar, role: r.role, events: 0, present: 0, absent: 0, excused: 0, pending: 0 });
      x.events++; x[r.status]++;
    });
    // leaders always on top, then committee, then name
    return [...m.values()].sort((a, b) => (isLead(b) - isLead(a)) || a.committee.localeCompare(b.committee) || a.member.localeCompare(b.member));
  };
  const pct = (p, t) => t ? Math.round(p / t * 100) + '%' : '—';
  const filtered = () => q ? data.filter(r => norm(r.member + r.ministry + r.event + r.committee + (isLead(r) ? 'leader' : '')).includes(norm(q))) : data;

  const draw = () => {
    const tot = data.length, p = data.filter(r => r.status === 'present').length, x = data.filter(r => r.status === 'excused').length, a = data.filter(r => r.status === 'absent').length, n = data.filter(r => r.status === 'pending').length;
    let table;
    if (mode === 'member') {
      const list = byMember().filter(r => !q || norm(r.member + r.ministry + r.committee + (isLead(r) ? 'leader' : '')).includes(norm(q)));
      table = list.length ? `<div class="tw tc"><table><thead><tr><th>Member</th><th>Committee</th><th>Role</th><th>Ministry</th><th>Scholar</th><th>Schedules</th><th>Present</th><th>Absent</th><th>Excused</th><th>Not yet modified</th><th>Rate</th></tr></thead><tbody>
        ${list.slice(0, 1000).map(r => `<tr class="${isLead(r) ? 'isl' : ''}"><td data-label="Member"><b>${esc(r.member)}</b></td><td data-label="Committee">${comTag(r.committee)}</td><td data-label="Role">${isLead(r) ? roleBadge('leader') : '<span class="pill member">Member</span>'}</td><td data-label="Ministry">${esc(r.ministry)}</td><td data-label="Scholar">${esc(SCHOLAR_SHORT[r.scholar])}</td><td data-label="Schedules">${r.events}</td><td data-label="Present">${r.present}</td><td data-label="Absent">${r.absent}</td><td data-label="Excused">${r.excused}</td><td data-label="Not yet modified">${r.pending}</td><td data-label="Rate"><b>${pct(r.present, r.events - r.pending)}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No records.</div>';
    } else {
      const list = filtered(); // server already returns leaders first within each schedule
      table = list.length ? `<div class="tw tc"><table><thead><tr><th>Date</th><th>Schedule</th><th>Member</th><th>Committee</th><th>Role</th><th>Status</th><th>Time in</th><th>Reason</th></tr></thead><tbody>
        ${list.slice(0, 1000).map(r => `<tr class="${isLead(r) ? 'isl' : ''}"><td data-label="Date">${esc(fmtDate(r.date))}</td><td data-label="Schedule">${esc(r.event)}</td><td data-label="Member"><b>${esc(r.member)}</b></td><td data-label="Committee">${comTag(r.committee)}</td><td data-label="Role">${isLead(r) ? roleBadge('leader') : '<span class="pill member">Member</span>'}</td><td data-label="Status"><span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span></td><td data-label="Time in">${esc(fmtTime(r.time_in))}</td><td data-label="Reason">${esc(r.reason || '')}</td></tr>`).join('')}</tbody></table></div>
        ${list.length > 1000 ? `<p class="sub" style="margin-top:8px">Showing the first 1,000 of ${list.length}. Export to get everything.</p>` : ''}` : '<div class="empty">No records.</div>';
    }
    $('#out').innerHTML = `<div class="stats"><div class="stat"><i class="fas fa-list si"></i><b>${tot}</b><span>Total records</span></div><div class="stat gold"><i class="fas fa-percent si"></i><b>${pct(p, tot - n)}</b><span>Overall attendance rate</span></div></div>
      <div class="card"><div class="head"><div><h3>Summary total</h3><div class="sub">${esc(fmtDate($('#from').value))} – ${esc(fmtDate($('#to').value))}</div></div></div>
        <div class="sumgrid">
          <div class="sum ok"><b>${p}</b><span>PRESENT</span><small>${pct(p, tot)} of all records</small></div>
          <div class="sum ex"><b>${x}</b><span>EXCUSED</span><small>${pct(x, tot)} of all records</small></div>
          <div class="sum no"><b>${a}</b><span>ABSENT</span><small>${pct(a, tot)} of all records</small></div>
          <div class="sum nm"><b>${n}</b><span>NOT YET MODIFIED</span><small>${pct(n, tot)} of all records</small></div>
        </div>
        <div class="meter stack" aria-hidden="true"><i style="width:${tot ? p / tot * 100 : 0}%;background:var(--ok)"></i><i style="width:${tot ? x / tot * 100 : 0}%;background:var(--gold)"></i><i style="width:${tot ? a / tot * 100 : 0}%;background:#C8372D"></i><i style="width:${tot ? n / tot * 100 : 0}%;background:#C5CBD9"></i></div>
      </div>
      <div class="card"><div class="bar"><div class="seg" id="mode"><button data-m="member" class="${mode === 'member' ? 'on' : ''}">By member</button><button data-m="all" class="${mode === 'all' ? 'on' : ''}">Every record</button></div>
        <input id="rq" type="search" placeholder="Search…" value="${esc(q)}" aria-label="Search"><button class="btn sm" data-x="xlsx"><i class="fas fa-file-excel"></i> Excel</button><button class="btn sm" data-x="csv"><i class="fas fa-file-csv"></i> CSV</button></div>${table}</div>`;
    $('#mode').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; draw(); } };
    $('#rq').oninput = e => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = $('#rq'); n.focus(); n.setSelectionRange(pos, pos); };
    $$('[data-x]', $('#out')).forEach(b => b.onclick = () => doExport(b.dataset.x));
  };
  const summaryRows = () => {
    const tot = data.length, p = data.filter(r => r.status === 'present').length, x = data.filter(r => r.status === 'excused').length,
      a = data.filter(r => r.status === 'absent').length, n = data.filter(r => r.status === 'pending').length;
    return [[], ['SUMMARY TOTAL'], ['Date range', $('#from').value + ' to ' + $('#to').value], ['PRESENT', p], ['EXCUSED', x], ['ABSENT', a],
      ['NOT YET MODIFIED', n], ['TOTAL RECORDS', tot], ['ATTENDANCE RATE (present of marked)', (tot - n) ? Math.round(p / (tot - n) * 100) + '%' : '—']];
  };
  const doExport = kind => {
    const nm = 'attendance-' + $('#from').value + '_to_' + $('#to').value;
    if (mode === 'member') exportRows(kind, nm + '-by-member', ['Member', 'Committee', 'Role', 'Ministry', 'Scholar', 'Schedules', 'Present', 'Absent', 'Excused', 'Not yet modified', 'Rate %'],
      byMember().map(r => [r.member, r.committee, ROLE[r.role] || 'Member', r.ministry, SCHOLAR[r.scholar], r.events, r.present, r.absent, r.excused, r.pending, (r.events - r.pending) ? Math.round(r.present / (r.events - r.pending) * 100) : '—']), summaryRows());
    else exportRows(kind, nm, ['Date', 'Schedule', 'For', 'Member', 'Committee', 'Role', 'Ministry', 'Scholar', 'Status', 'Time in', 'Reason'],
      filtered().map(r => [r.date, r.event, r.event_for || 'Whole group', r.member, r.committee, ROLE[r.role] || 'Member', r.ministry, SCHOLAR[r.scholar], STATUS_LABEL[r.status], fmtTime(r.time_in), r.reason || '']), summaryRows());
  };
  $('#run').onclick = async e => {
    const f = clampDay($('#from').value || todayStr()), t = clampDay($('#to').value || SEASON_END);
    $('#from').value = f; $('#to').value = t;
    const d = await busy(e.currentTarget, () => call('records', { from: f, to: t, committee_ids: [...cSel], scholar_types: [...sSel], role: leadOnly ? 'leader' : '' }));
    if (d) { data = d === true ? [] : d; draw(); }
  };
  $('#run').click();
  const tok = routeTok;
  liveRefresh = async () => {
    if (document.activeElement && document.activeElement.id === 'rq') return false; // don't steal focus while searching
    const r = await api('records', { from: $('#from').value, to: $('#to').value, committee_ids: [...cSel], scholar_types: [...sSel], role: leadOnly ? 'leader' : '' });
    if (!r.success || tok !== routeTok) return false;
    data = r.data || []; draw();
  };
};

/* ================= LEADERS (Secretariat only) ================= */
const genPass = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8)), n => a[n % a.length]).join(''); };

function leaderModal(u, done) {
  u = u || {};
  modal(`<h3>${u.id ? 'Edit account' : 'New leader account'}</h3>
    <form id="uf" autocomplete="off">
      <label>Full name<input name="full_name" maxlength="100" required value="${esc(u.full_name)}"></label>
      <label>Username<input name="username" maxlength="50" required autocapitalize="none" value="${esc(u.username)}" placeholder="letters, numbers, . - _"></label>
      <label>Password ${u.id ? '<span class="muted">(leave blank to keep the current one)</span>' : ''}
        <div class="pwrow"><input name="password" id="pw" type="text" autocomplete="new-password" ${u.id ? '' : 'required'} minlength="6"><button type="button" class="btn sm" id="gen">Generate</button></div></label>
      <label>Role<select name="role" id="role"><option value="leader" ${u.role !== 'secretariat' ? 'selected' : ''}>Leader (takes attendance for a committee)</option><option value="secretariat" ${u.role === 'secretariat' ? 'selected' : ''}>Secretariat (full access)</option></select></label>
      <label id="cw">Committee<select name="committee_id"><option value="">Choose…</option>${COMMITTEES.map(c => `<option value="${c.id}" ${+u.committee_id === +c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>Status<select name="status"><option value="active" ${u.status !== 'disabled' ? 'selected' : ''}>Active</option><option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>Disabled (cannot log in)</option></select></label>
      <div class="actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn pri">Save</button></div>
    </form>`, (el, close) => {
      const sync = () => $('#cw', el).classList.toggle('hidden', $('#role', el).value === 'secretariat');
      $('#role', el).onchange = sync; sync();
      $('#gen', el).onclick = () => { $('#pw', el).value = genPass(); };
      $('#uf', el).addEventListener('submit', async ev => {
        ev.preventDefault();
        const body = Object.fromEntries(new FormData(ev.target)); body.id = u.id || 0;
        if (await busy($('.pri', el), () => call('user_save', body))) {
          close(); done();
          if (body.password) modal(`<h3>Give these to ${esc(body.full_name)}</h3><p class="sub">This is the only time the password is shown.</p>
            <div class="cred"><div>Username: <b>${esc(body.username)}</b></div><div>Password: <b>${esc(body.password)}</b></div></div>
            <div class="actions"><button class="btn" id="cp"><i class="fas fa-copy"></i> Copy</button><button class="btn pri" data-close>Done</button></div>`,
            c2 => $('#cp', c2).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(`Username: ${body.username}\nPassword: ${body.password}`).then(() => toast('Copied.')); });
          else toast('Account updated.');
        }
      });
    });
}

VIEWS.leaders = async () => {
  const rows = await call('users_list'); if (!rows) return;
  view().innerHTML = `<div class="card" id="lc"><div class="head"><div><h3>Leaders</h3><div class="sub">There is no sign-up. You create each leader's account here and hand them the username and password.</div></div>
    <button class="btn pri" id="add"><i class="fas fa-user-plus"></i> New leader</button></div>
    ${rows.length ? `<div class="tw tc"><table><thead><tr><th>Name</th><th>Username</th><th>Committee</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(u => `<tr><td data-label="Name"><b>${esc(u.full_name)}</b></td><td data-label="Username">${esc(u.username)}</td><td data-label="Committee">${u.committee_name ? comTag(u.committee_name, u.committee_id) : '<small>—</small>'}</td>
        <td data-label="Role">${u.role === 'secretariat' ? 'Secretariat' : 'Leader'}</td><td data-label="Status"><span class="pill ${u.status}">${u.status}</span></td>
        <td class="act" style="white-space:nowrap;text-align:right"><button class="btn sm ghost" data-edit="${u.id}" aria-label="Edit ${esc(u.full_name)}">Edit</button>
        ${+u.id !== +ME.id ? `<button class="btn sm no" data-del="${u.id}" aria-label="Delete ${esc(u.full_name)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No accounts.</div>'}</div>`;
  $('#add').onclick = () => leaderModal(null, route);
  $('#lc').onclick = async e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) leaderModal(rows.find(u => u.id == ed.dataset.edit), route);
    if (del) {
      const u = rows.find(x => x.id == del.dataset.del);
      if (await ask('Delete this account?', `${u.full_name} (${u.username}) will no longer be able to log in. Attendance they marked is kept.`, 'Delete')) { if (await call('user_delete', { id: u.id }, true)) route(); }
    }
  };
};

/* ================= SETTINGS ================= */
VIEWS.settings = async () => {
  view().innerHTML = `<div class="card" style="max-width:520px"><div class="head"><h3>Change password</h3></div>
    <form id="pf"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
    <label>New password<input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
    <label>Repeat new password<input name="again" type="password" autocomplete="new-password" minlength="6" required></label>
    <div class="actions"><button class="btn pri">Change password</button></div></form></div>
    <div class="card" style="max-width:520px"><b>${esc(ME.full_name)}</b><div class="sub">${esc(ME.username)} · ${isSec() ? 'Secretariat' : 'Leader of ' + esc(ME.committee_name || '—')}</div></div>`;
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    if (b.password !== b.again) { toast('The new passwords do not match.', true); return; }
    if (await busy($('.pri', e.target), () => call('change_password', { current: b.current, password: b.password }, true))) e.target.reset();
  };
};

/* ---------- boot ---------- */
(async function init() {
  const r = await api('me');
  if (!r.success) { if (r.code !== 'auth') location.href = 'login.php'; return; }
  ME = r.data.user; COMMITTEES = r.data.committees;
  $('#whoName').textContent = ME.full_name;
  $('#hchip').innerHTML = `<i class="av" style="font-style:normal">${esc(ME.full_name.trim().charAt(0).toUpperCase())}</i><span><b>${esc(ME.full_name)}</b><small>${isSec() ? 'Secretariat' : 'Leader · ' + esc(ME.committee_name || '—')}</small></span>`;
  $('#whoRole').textContent = isSec() ? 'Secretariat' : 'Leader · ' + (ME.committee_name || 'no committee');
  buildNav();
  $('#burger').onclick = () => { $('#side').classList.add('open'); $('#shade').classList.add('open'); };
  $('#shade').onclick = closeSide;
  $('#logout').onclick = async () => { await api('logout'); location.href = 'login.php'; };
  window.addEventListener('hashchange', route);
  route();
})();
})();
