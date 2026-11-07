/* PYM — Events: Type = Event Category, "needs servers" checkbox + typed server names, plus multiple slots with different servers (slt-box). Loaded last on index.php. */
(function () {
  const css = `
  .srv-box{margin:4px 0 14px}
  .srv-check{display:flex;align-items:center;gap:10px;font-size:13.5px;font-weight:700;color:var(--text-primary);cursor:pointer;padding:6px 0}
  .srv-check input{width:18px;height:18px;accent-color:var(--sapphire)}
  .srv-panel{border:1.5px dashed var(--border-mid);border-radius:var(--radius-sm);padding:14px;background:var(--surface);margin-top:6px}
  .srv-note{font-size:12px;color:var(--text-soft);margin-bottom:10px;line-height:1.5}
  .srv-search{position:relative;max-width:420px}
  .srv-search i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-faint);font-size:12px}
  .srv-search input{width:100%;padding:10px 12px 10px 34px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:13px;outline:none}
  .srv-search input:focus{border-color:var(--sapphire-glow);box-shadow:0 0 0 3px rgba(59,130,246,.10)}
  .srv-list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;max-height:230px;overflow-y:auto;background:var(--surface);border:1.5px solid var(--border-mid);border-radius:8px;box-shadow:var(--shadow-md);padding:4px}
  .srv-opt{padding:8px 10px;font-size:13px;border-radius:6px;cursor:pointer}
  .srv-opt:hover{background:var(--sapphire-pale)}
  .srv-none{padding:9px 10px;font-size:12px;color:var(--text-faint);font-style:italic}
  .srv-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .srv-chip{display:inline-flex;align-items:center;gap:6px;background:var(--sapphire-pale);border:1px solid #BFDBFE;color:var(--sapphire);font-size:12px;font-weight:700;padding:4px 6px 4px 11px;border-radius:99px}
  .srv-chip button{border:none;background:rgba(0,0,0,.08);width:18px;height:18px;border-radius:50%;font-size:11px;line-height:1;color:inherit}
  .srv-empty{font-size:11.5px;color:var(--text-faint);font-style:italic}
  .slt-box{margin:4px 0 14px}
  .slt-panel{border:1.5px dashed var(--amber);border-radius:var(--radius-sm);padding:14px;background:#FFFBEB;margin-top:6px}
  .slt-card{border:1.5px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);padding:12px;margin-bottom:10px}
  .slt-head{display:flex;gap:8px;align-items:center;margin-bottom:10px}
  .slt-head .slt-name{flex:1;min-width:0;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;font-weight:700;outline:none}
  .slt-head .slt-name:focus{border-color:var(--sapphire-glow);box-shadow:0 0 0 3px rgba(59,130,246,.10)}
  .slt-del{border:none;background:var(--crimson-pale);color:var(--crimson);width:36px;height:36px;border-radius:8px;font-size:16px;font-weight:800}
  .slt-add{border:1.5px solid var(--amber);background:var(--amber-pale);color:var(--amber);font-size:12.5px;font-weight:800;padding:9px 16px;border-radius:var(--radius-sm)}
  .slt-add:hover{background:var(--amber);color:#fff}
  .srv-box.locked{opacity:.5}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const $ = id => document.getElementById(id);
  const E = s => escapeHtml(s);
  let YOUTH = null;
  async function youth() {
    if (YOUTH) return YOUTH;
    const r = await coyApi('get_all_youth');
    YOUTH = r.success ? r.data : [];
    return YOUTH;
  }
  async function evs(action, payload) {
    try {
      const r = await fetch('api_eventslots.php?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
      return await r.json();
    } catch (e) { return { success: false, message: 'Network error. Please check your connection.' }; }
  }

  async function refreshCats() {
    const form = $('adminEventForm');
    const sel = form && form.elements['category_id'];
    if (!sel) return;
    const r = await apiCall('get_categories');
    const cats = r.success ? r.data.filter(c => Number(c.is_system) !== 1) : [];
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Select category —</option>' + cats.map(c => `<option value="${c.id}">${E(c.name)}</option>`).join('');
    sel.value = cur;
  }

  function mount(form) {
    const box = document.createElement('div');
    box.className = 'srv-box';
    box.innerHTML = `
      <label class="srv-check"><input type="checkbox" class="srv-on"/> <span>This event needs servers</span></label>
      <div class="srv-panel hidden">
        <p class="srv-note">Type the names of the servers (no limit). Everyone else automatically appears as an attendee in Attendance, below the servers.</p>
        <div class="srv-search"><i class="fas fa-user-plus"></i><input type="text" class="srv-input" placeholder="Type a name..." autocomplete="off"/><div class="srv-list hidden"></div></div>
        <div class="srv-chips"></div>
      </div>`;
    form.querySelector('.form-actions').before(box);
    const on = box.querySelector('.srv-on'), panel = box.querySelector('.srv-panel'), inp = box.querySelector('.srv-input'),
          list = box.querySelector('.srv-list'), chips = box.querySelector('.srv-chips');
    const sel = new Map();

    const draw = () => {
      chips.innerHTML = sel.size
        ? [...sel].map(([id, n]) => `<span class="srv-chip">${E(n)}<button type="button" data-rm="${id}" aria-label="Remove">&times;</button></span>`).join('')
        : '<span class="srv-empty">No servers added yet.</span>';
    };
    const toggle = () => panel.classList.toggle('hidden', !on.checked);
    const show = async () => {
      const q = inp.value.trim().toLowerCase();
      const all = await youth();
      const items = all.filter(y => !sel.has(String(y.id)) && (!q || y.full_name.toLowerCase().includes(q))).slice(0, 40);
      list.innerHTML = items.length
        ? items.map(y => `<div class="srv-opt" data-id="${y.id}" data-name="${E(y.full_name)}">${E(y.full_name)}</div>`).join('')
        : '<div class="srv-none">No match</div>';
      list.classList.remove('hidden');
    };
    const add = o => { sel.set(String(o.dataset.id), o.dataset.name); inp.value = ''; list.classList.add('hidden'); draw(); inp.focus(); };

    on.addEventListener('change', toggle);
    inp.addEventListener('input', show);
    inp.addEventListener('focus', show);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const o = list.querySelector('.srv-opt'); if (o) add(o); }
      else if (e.key === 'Escape') list.classList.add('hidden');
    });
    list.addEventListener('mousedown', e => { const o = e.target.closest('.srv-opt'); if (o) { e.preventDefault(); add(o); } });
    chips.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { sel.delete(b.dataset.rm); draw(); } });
    document.addEventListener('mousedown', e => { if (!e.target.closest('.srv-search')) list.classList.add('hidden'); });

    const api = {
      box,
      get() { return { has_servers: on.checked ? 1 : 0, server_ids: on.checked ? [...sel.keys()] : [] }; },
      set(has, servers) {
        on.checked = !!has; sel.clear();
        (servers || []).forEach(s => sel.set(String(s.member_id), s.full_name));
        draw(); toggle();
      },
      reset() { on.checked = false; sel.clear(); inp.value = ''; list.classList.add('hidden'); draw(); toggle(); },
      lock(v) {
        if (v) { on.checked = false; toggle(); }
        on.disabled = !!v; box.classList.toggle('locked', !!v);
      }
    };
    form.addEventListener('reset', () => setTimeout(api.reset, 0));
    draw();
    return api;
  }

  /* ---------- Multiple slots, each with its own servers ---------- */
  function mountSlots(form, srv) {
    const box = document.createElement('div');
    box.className = 'slt-box';
    box.innerHTML = `
      <label class="srv-check"><input type="checkbox" class="slt-on"/> <span>This event has multiple slots (e.g. Slot A, Slot B) with different servers</span></label>
      <div class="slt-panel hidden">
        <p class="srv-note">Add each slot and type the names of its servers. Everyone else is an attendee in Attendance, below all the servers.</p>
        <div class="slt-list"></div>
        <button type="button" class="slt-add"><i class="fas fa-plus"></i> Add slot</button>
      </div>`;
    srv.box.after(box);
    const on = box.querySelector('.slt-on'), panel = box.querySelector('.slt-panel'), list = box.querySelector('.slt-list'), addBtn = box.querySelector('.slt-add');
    let slots = [];

    const chipsHtml = i => slots[i].sel.size
      ? [...slots[i].sel].map(([id, n]) => `<span class="srv-chip">${E(n)}<button type="button" data-rm="${id}" aria-label="Remove">&times;</button></span>`).join('')
      : '<span class="srv-empty">No servers added yet.</span>';
    const draw = () => {
      list.innerHTML = slots.map((s, i) => `
        <div class="slt-card" data-i="${i}">
          <div class="slt-head"><input type="text" class="slt-name" placeholder="Slot name (e.g. Slot ${String.fromCharCode(65 + (i % 26))})" value="${E(s.name)}" maxlength="100"/><button type="button" class="slt-del" aria-label="Remove slot">&times;</button></div>
          <div class="srv-search"><i class="fas fa-user-plus"></i><input type="text" class="slt-q" placeholder="Type a server name..." autocomplete="off"/><div class="srv-list hidden"></div></div>
          <div class="srv-chips">${chipsHtml(i)}</div>
        </div>`).join('');
    };
    const toggle = () => { panel.classList.toggle('hidden', !on.checked); srv.lock(on.checked); };
    const showList = async card => {
      const i = +card.dataset.i, q = card.querySelector('.slt-q').value.trim().toLowerCase(), dd = card.querySelector('.srv-list');
      const all = await youth();
      const items = all.filter(y => !slots[i].sel.has(String(y.id)) && (!q || y.full_name.toLowerCase().includes(q))).slice(0, 40);
      dd.innerHTML = items.length
        ? items.map(y => `<div class="srv-opt" data-id="${y.id}" data-name="${E(y.full_name)}">${E(y.full_name)}</div>`).join('')
        : '<div class="srv-none">No match</div>';
      dd.classList.remove('hidden');
    };
    const addServer = (card, o) => {
      const i = +card.dataset.i;
      slots[i].sel.set(String(o.dataset.id), o.dataset.name);
      const q = card.querySelector('.slt-q'); q.value = '';
      card.querySelector('.srv-list').classList.add('hidden');
      card.querySelector('.srv-chips').innerHTML = chipsHtml(i);
      q.focus();
    };

    on.addEventListener('change', () => { if (on.checked && !slots.length) { slots.push({ name: '', sel: new Map() }, { name: '', sel: new Map() }); draw(); } toggle(); });
    addBtn.addEventListener('click', () => { slots.push({ name: '', sel: new Map() }); draw(); const n = list.querySelectorAll('.slt-name'); if (n.length) n[n.length - 1].focus(); });
    list.addEventListener('input', e => {
      const card = e.target.closest('.slt-card'); if (!card) return;
      if (e.target.classList.contains('slt-name')) slots[+card.dataset.i].name = e.target.value;
      else if (e.target.classList.contains('slt-q')) showList(card);
    });
    list.addEventListener('focusin', e => { if (e.target.classList.contains('slt-q')) showList(e.target.closest('.slt-card')); });
    list.addEventListener('keydown', e => {
      if (!e.target.classList.contains('slt-q')) return;
      const card = e.target.closest('.slt-card');
      if (e.key === 'Enter') { e.preventDefault(); const o = card.querySelector('.srv-opt'); if (o) addServer(card, o); }
      else if (e.key === 'Escape') card.querySelector('.srv-list').classList.add('hidden');
    });
    list.addEventListener('mousedown', e => { const o = e.target.closest('.srv-opt'); if (o) { e.preventDefault(); addServer(o.closest('.slt-card'), o); } });
    list.addEventListener('click', e => {
      const card = e.target.closest('.slt-card'); if (!card) return;
      const i = +card.dataset.i;
      if (e.target.closest('.slt-del')) { slots.splice(i, 1); draw(); return; }
      const b = e.target.closest('[data-rm]');
      if (b) { slots[i].sel.delete(b.dataset.rm); card.querySelector('.srv-chips').innerHTML = chipsHtml(i); }
    });
    document.addEventListener('mousedown', e => { if (!e.target.closest('.srv-search')) list.querySelectorAll('.srv-list').forEach(l => l.classList.add('hidden')); });

    const api = {
      get() {
        return {
          on: on.checked,
          slots: on.checked ? slots.filter(s => s.name.trim()).map(s => ({ name: s.name.trim(), server_ids: [...s.sel.keys()] })) : []
        };
      },
      set(data) {
        slots = (data || []).map(s => ({ name: s.name || '', sel: new Map((s.servers || []).map(x => [String(x.member_id), x.full_name])) }));
        on.checked = slots.length > 0;
        draw(); toggle();
      },
      reset() { slots = []; on.checked = false; draw(); toggle(); }
    };
    form.addEventListener('reset', () => setTimeout(api.reset, 0));
    return api;
  }

  async function saveEvent(form, srv, slt, base, after) {
    const sl = slt.get();
    if (sl.on && !sl.slots.length) { alert('Add at least one slot and give it a name.'); return; }
    const payload = Object.assign({}, base, sl.on ? { has_servers: 0, server_ids: [] } : srv.get());
    const res = await apiCall('save_category_event', payload);
    if (!res.success) { alert(res.message); return; }
    let eid = base.id;
    if (!eid) {
      const f = await evs('find_event', { category_id: base.category_id, title: base.title, event_date: base.event_date });
      eid = f.success && f.data ? f.data.id : null;
    }
    if (eid) {
      const r = await evs('save', { event_id: eid, slots: sl.slots });
      if (!r.success) { alert(r.message); return; }
    }
    alert(res.message);
    form.reset(); form.classList.add('hidden');
    after();
  }

  function applyEdit(srv, slt, ev, slots) {
    if (slots && slots.length) { srv.reset(); slt.set(slots); }
    else { slt.set([]); srv.set(Number(ev.has_servers) === 1, ev.servers); }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const adm = $('adminEventForm'), cev = $('categoryEventForm');
    if (!adm || typeof apiCall !== 'function') return;
    const s = await apiCall('check_session');
    if (!(s.success && s.data.role === 'secretariat')) return;

    /* Type -> Category */
    const t = adm.elements['type'];
    if (t) {
      const fld = t.closest('.form-field');
      fld.innerHTML = '<label>Category</label><select name="category_id" required><option value="">— Select category —</option></select>';
    }
    const admSrv = mount(adm);
    const admSlt = mountSlots(adm, admSrv);
    adm.__srv = admSrv; adm.__slt = admSlt;
    const catSrv = cev ? mount(cev) : null;
    const catSlt = cev ? mountSlots(cev, catSrv) : null;
    refreshCats();

    $('adminShowEventFormBtn').addEventListener('click', refreshCats);

    adm.addEventListener('submit', e => {
      e.preventDefault(); e.stopImmediatePropagation();
      const f = adm.elements;
      if (!f['category_id'].value) { alert('Please select a category.'); return; }
      saveEvent(adm, admSrv, admSlt, {
        id: f['id'].value, category_id: f['category_id'].value, title: f['title'].value.trim(),
        event_date: f['event_date'].value, event_time: f['event_time'].value, location: f['location'].value.trim()
      }, () => loadEvents(true));
    }, true);

    if (cev) {
      cev.addEventListener('submit', e => {
        e.preventDefault(); e.stopImmediatePropagation();
        const f = cev.elements;
        saveEvent(cev, catSrv, catSlt, {
          id: f['id'].value, category_id: f['category_id'].value, title: f['title'].value.trim(),
          event_date: f['event_date'].value, event_time: f['event_time'].value, location: f['location'].value.trim()
        }, () => loadAdminCategories());
      }, true);

      // Editing an event inside Event Categories: fill the servers / slots part
      document.addEventListener('click', async e => {
        const b = e.target.closest('.cat-ev-edit');
        if (!b) return;
        let found = null;
        ALL_CATEGORIES.forEach(c => c.events.forEach(ev => { if (String(ev.id) === b.dataset.id) found = ev; }));
        if (!found) return;
        const r = await evs('get', { event_id: found.id });
        applyEdit(catSrv, catSlt, found, r.success ? r.data : []);
      });
    }
  });

  /* Editing from Admin Panel → Manage Events */
  const _editEvent = editEvent;
  editEvent = async function (id, isAdmin) {
    if (!isAdmin) return _editEvent(id, isAdmin);
    const ev = ALL_EVENTS.find(x => String(x.id) === String(id));
    const form = $('adminEventForm');
    if (!ev || !form || !form.elements['category_id']) return;
    await refreshCats();
    const f = form.elements;
    f['id'].value = ev.id; f['title'].value = ev.title;
    f['category_id'].value = ev.category_id || '';
    f['event_date'].value = ev.event_date; f['event_time'].value = ev.event_time ? ev.event_time.substring(0, 5) : '';
    f['location'].value = ev.location || '';
    const r = await evs('get', { event_id: ev.id });
    if (form.__srv && form.__slt) applyEdit(form.__srv, form.__slt, ev, r.success ? r.data : []);
    form.classList.remove('hidden'); form.scrollIntoView({ behavior: 'smooth' });
  };
})();

/* ---------- Real-time name search for attendance lists (all roles) ---------- */
(function () {
  const css = `
  .att-search{position:sticky;top:72px;z-index:20;background:var(--surface);padding:8px 0 10px;margin:0 0 4px}
  .att-search .box{position:relative;max-width:460px}
  .att-search .box i.fa-search{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--text-faint);font-size:13px}
  .att-search input{width:100%;padding:11px 38px 11px 36px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:14px;outline:none;background:var(--surface)}
  .att-search input:focus{border-color:var(--sapphire-glow);box-shadow:0 0 0 3px rgba(59,130,246,.10)}
  .att-search .clr{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;border:none;background:none;color:var(--text-soft);border-radius:50%;font-size:14px}
  .att-search .clr:hover{background:var(--bg)}
  .att-search .nm{font-size:12px;color:var(--text-faint);font-style:italic;margin-top:6px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function setup(tbodyId, closeId) {
    const tb = document.getElementById(tbodyId);
    if (!tb) return;
    const wrap = tb.closest('.table-wrap');
    if (!wrap) return;
    const box = document.createElement('div');
    box.className = 'att-search';
    box.innerHTML = '<div class="box"><i class="fas fa-search"></i><input type="text" placeholder="Search name..." autocomplete="off" aria-label="Search name"/><button type="button" class="clr hidden" aria-label="Clear"><i class="fas fa-times"></i></button></div><div class="nm hidden">No matching name.</div>';
    wrap.before(box);
    const inp = box.querySelector('input'), clr = box.querySelector('.clr'), nm = box.querySelector('.nm');

    const apply = () => {
      const q = inp.value.trim().toLowerCase();
      clr.classList.toggle('hidden', !q);
      let shown = 0, total = 0, grp = null, grpShown = 0;
      const closeGrp = () => { if (grp) grp.style.display = (!q || grpShown) ? '' : 'none'; };
      tb.querySelectorAll('tr').forEach(tr => {
        if (tr.classList.contains('att-group')) { closeGrp(); grp = tr; grpShown = 0; return; }
        if (!tr.dataset.memberId) return;
        total++;
        const ok = !q || String(tr.dataset.name || '').toLowerCase().includes(q);
        tr.style.display = ok ? '' : 'none';
        if (ok) { shown++; grpShown++; }
      });
      closeGrp();
      nm.classList.toggle('hidden', !(q && total && !shown));
    };
    inp.addEventListener('input', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; apply(); } });
    clr.addEventListener('click', () => { inp.value = ''; apply(); inp.focus(); });
    new MutationObserver(apply).observe(tb, { childList: true });
    const c = document.getElementById(closeId);
    if (c) c.addEventListener('click', () => { inp.value = ''; apply(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setup('attendanceTableBody', 'closeAttPanel');
    setup('evAttTableBody', 'closeEvAttPanel');
  });

  // "Mark All" only touches the names currently shown by the search
  attMarkAll = function (tbody, s) {
    tbody.querySelectorAll('tr[data-member-id]').forEach(row => {
      if (row.dataset.status === 'excused' || row.style.display === 'none') return;
      attSetRow(row, s);
    });
  };
})();
