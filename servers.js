/* PYM — Events: Type = Event Category, "needs servers" checkbox + typed server names,
   and "multiple slots" (e.g. Simbang Gabi -> Slot A / Slot B, different servers each). Loaded last on index.php. */
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
  .slt-item{border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px;background:var(--surface-2)}
  .slt-head{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
  .slt-head .slt-name{flex:1;min-width:150px;padding:10px 12px;border:1.5px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;font-weight:700;outline:none;background:var(--surface)}
  .slt-head .slt-name:focus{border-color:var(--sapphire-glow);box-shadow:0 0 0 3px rgba(59,130,246,.10)}
  .slt-rm{border:none;background:var(--crimson-pale);color:var(--crimson);width:34px;height:34px;border-radius:8px;font-size:18px;line-height:1;font-weight:800}
  .slt-rm:hover{background:var(--crimson);color:#fff}
  .slt-add{margin-top:4px}
  .slt-dadd{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .slt-dadd .slt-d{max-width:200px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const $ = id => document.getElementById(id);
  let YOUTH = null;
  async function youth() {
    if (YOUTH) return YOUTH;
    const r = await coyApi('get_all_youth');
    YOUTH = r.success ? r.data : [];
    return YOUTH;
  }

  async function slotApi(action, payload) {
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
    sel.innerHTML = '<option value="">— Select category —</option>' + cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    sel.value = cur;
  }

  const PICK = '<div class="srv-search"><i class="fas fa-user-plus"></i><input type="text" class="srv-input" placeholder="Type a name..." autocomplete="off"/><div class="srv-list hidden"></div></div><div class="srv-chips"></div>';

  /* Name picker (search + chips) inside `root` */
  function makePicker(root) {
    const wrap = root.querySelector('.srv-search'), inp = root.querySelector('.srv-input'),
          list = root.querySelector('.srv-list'), chips = root.querySelector('.srv-chips');
    const sel = new Map();
    const draw = () => {
      chips.innerHTML = sel.size
        ? [...sel].map(([id, n]) => `<span class="srv-chip">${escapeHtml(n)}<button type="button" data-rm="${id}" aria-label="Remove">&times;</button></span>`).join('')
        : '<span class="srv-empty">No servers added yet.</span>';
    };
    const show = async () => {
      const q = inp.value.trim().toLowerCase();
      const all = await youth();
      const items = all.filter(y => !sel.has(String(y.id)) && (!q || y.full_name.toLowerCase().includes(q))).slice(0, 40);
      list.innerHTML = items.length
        ? items.map(y => `<div class="srv-opt" data-id="${y.id}" data-name="${escapeHtml(y.full_name)}">${escapeHtml(y.full_name)}</div>`).join('')
        : '<div class="srv-none">No match</div>';
      list.classList.remove('hidden');
    };
    const add = o => { sel.set(String(o.dataset.id), o.dataset.name); inp.value = ''; list.classList.add('hidden'); draw(); inp.focus(); };
    inp.addEventListener('input', show);
    inp.addEventListener('focus', show);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const o = list.querySelector('.srv-opt'); if (o) add(o); }
      else if (e.key === 'Escape') list.classList.add('hidden');
    });
    list.addEventListener('mousedown', e => { const o = e.target.closest('.srv-opt'); if (o) { e.preventDefault(); add(o); } });
    chips.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { sel.delete(b.dataset.rm); draw(); } });
    document.addEventListener('mousedown', e => { if (!wrap.contains(e.target)) list.classList.add('hidden'); });
    draw();
    return {
      ids: () => [...sel.keys()],
      set(servers) { sel.clear(); (servers || []).forEach(s => sel.set(String(s.member_id), s.full_name)); draw(); },
      clear() { sel.clear(); inp.value = ''; list.classList.add('hidden'); draw(); }
    };
  }

  /* "This event needs servers" (single event) */
  function mount(form) {
    const box = document.createElement('div');
    box.className = 'srv-box';
    box.innerHTML = `
      <label class="srv-check"><input type="checkbox" class="srv-on"/> <span>This event needs servers</span></label>
      <div class="srv-panel hidden">
        <p class="srv-note">Type the names of the servers (no limit). Everyone else automatically appears as an attendee in Attendance, below the servers.</p>
        ${PICK}
      </div>`;
    form.querySelector('.form-actions').before(box);
    const on = box.querySelector('.srv-on'), panel = box.querySelector('.srv-panel');
    const p = makePicker(panel);
    const toggle = () => panel.classList.toggle('hidden', !on.checked);
    on.addEventListener('change', toggle);

    const api = {
      box,
      get() { return { has_servers: on.checked ? 1 : 0, server_ids: on.checked ? p.ids() : [] }; },
      set(has, servers) { on.checked = !!has; p.set(servers); toggle(); },
      reset() { on.checked = false; p.clear(); toggle(); }
    };
    form.addEventListener('reset', () => setTimeout(api.reset, 0));
    return api;
  }

  /* "This event has multiple slots" (Slot A / Slot B ... each with its own servers) */
  function mountSlots(form, srv) {
    const box = document.createElement('div');
    box.className = 'srv-box slt-box';
    box.innerHTML = `
      <label class="srv-check"><input type="checkbox" class="slt-on"/> <span>This event has multiple slots (e.g. Slot A, Slot B) with different servers</span></label>
      <div class="srv-panel slt-panel hidden">
        <p class="srv-note">Each slot is saved as its own event named "Title – Slot name", with its own servers and its own attendance. It is created for every date you choose: the Date above, plus any extra dates you add below.</p>
        <div class="form-field"><label>Add more dates (the Date above is already included)</label>
          <div class="slt-dadd"><input type="date" class="slt-d"/><button type="button" class="add-btn slt-dbtn"><i class="fas fa-plus"></i> Add date</button></div>
          <div class="srv-chips slt-dchips"></div></div>
        <div class="slt-list"></div>
        <button type="button" class="add-btn slt-add"><i class="fas fa-plus"></i> Add Slot</button>
      </div>`;
    form.querySelector('.form-actions').before(box);
    const on = box.querySelector('.slt-on'), panel = box.querySelector('.slt-panel'),
          dIn = box.querySelector('.slt-d'), dChips = box.querySelector('.slt-dchips'), list = box.querySelector('.slt-list');
    let locked = false;
    const dates = new Set();
    const drawDates = () => {
      dChips.innerHTML = [...dates].sort().map(d => `<span class="srv-chip">${escapeHtml(formatDate(d))}<button type="button" data-d="${d}" aria-label="Remove date">&times;</button></span>`).join('');
    };
    const addDate = () => {
      if (!dIn.value) { alert('Pick a date first.'); return; }
      dates.add(dIn.value); dIn.value = ''; drawDates();
    };
    box.querySelector('.slt-dbtn').addEventListener('click', addDate);
    dIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDate(); } });
    dChips.addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) { dates.delete(b.dataset.d); drawDates(); } });

    const addSlot = name => {
      const it = document.createElement('div');
      it.className = 'slt-item';
      it.innerHTML = `<div class="slt-head"><input type="text" class="slt-name" placeholder="Slot name (e.g. Slot A)" maxlength="60" autocomplete="off"/><input type="time" class="slt-time" title="Time (optional)"/><button type="button" class="slt-rm" aria-label="Remove slot" title="Remove slot">&times;</button></div>` + PICK;
      it.querySelector('.slt-name').value = name || '';
      list.appendChild(it);
      it.__p = makePicker(it);
    };
    const sync = () => {
      panel.classList.toggle('hidden', !on.checked);
      srv.box.style.display = on.checked ? 'none' : '';
      if (on.checked && !list.children.length) { addSlot('Slot A'); addSlot('Slot B'); }
    };
    on.addEventListener('change', sync);
    box.querySelector('.slt-add').addEventListener('click', () => addSlot(''));
    list.addEventListener('click', e => { const b = e.target.closest('.slt-rm'); if (b) b.closest('.slt-item').remove(); });

    const api = {
      get() {
        if (!on.checked || locked) return null;
        const items = [...list.querySelectorAll('.slt-item')];
        if (!items.length) return { error: 'Add at least one slot.' };
        const slots = [];
        for (const it of items) {
          const name = it.querySelector('.slt-name').value.trim();
          if (!name) return { error: 'Please type a name for every slot.' };
          slots.push({ name, time: it.querySelector('.slt-time').value, server_ids: it.__p.ids() });
        }
        return { slots, dates: [...dates] };
      },
      lock(v) {                       // editing an existing event: slots are only for new events
        locked = !!v;
        box.style.display = locked ? 'none' : '';
        if (locked) { on.checked = false; list.innerHTML = ''; dates.clear(); drawDates(); sync(); }
      },
      reset() { locked = false; box.style.display = ''; on.checked = false; list.innerHTML = ''; dates.clear(); drawDates(); sync(); }
    };
    form.addEventListener('reset', () => setTimeout(api.reset, 0));
    return api;
  }

  /* Saves either one event or the multi-slot set. Returns the API result, or null if validation failed. */
  async function saveFrom(f, srv, slt) {
    const base = {
      id: f['id'].value, category_id: f['category_id'].value, title: f['title'].value.trim(),
      event_date: f['event_date'].value, event_time: f['event_time'].value, location: f['location'].value.trim()
    };
    const sl = slt.get();
    if (!sl) return apiCall('save_category_event', Object.assign(base, srv.get()));
    if (sl.error) { alert(sl.error); return null; }
    return slotApi('save_slots', Object.assign(base, { slots: sl.slots, dates: sl.dates }));
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
    adm.__srv = admSrv;
    const admSlt = mountSlots(adm, admSrv);
    adm.__slt = admSlt;
    const catSrv = cev ? mount(cev) : null;
    const catSlt = cev ? mountSlots(cev, catSrv) : null;
    refreshCats();

    $('adminShowEventFormBtn').addEventListener('click', refreshCats);

    adm.addEventListener('submit', async e => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!adm.elements['category_id'].value) { alert('Please select a category.'); return; }
      const res = await saveFrom(adm.elements, admSrv, admSlt);
      if (!res) return;
      alert(res.message);
      if (res.success) { adm.reset(); adm.classList.add('hidden'); loadEvents(true); }
    }, true);

    if (cev) {
      cev.addEventListener('submit', async e => {
        e.preventDefault(); e.stopImmediatePropagation();
        const res = await saveFrom(cev.elements, catSrv, catSlt);
        if (!res) return;
        alert(res.message);
        if (res.success) { cev.reset(); cev.classList.add('hidden'); loadAdminCategories(); }
      }, true);

      // Editing an event inside Event Categories: fill the servers part
      document.addEventListener('click', e => {
        const b = e.target.closest('.cat-ev-edit');
        if (!b) return;
        let found = null;
        ALL_CATEGORIES.forEach(c => c.events.forEach(ev => { if (String(ev.id) === b.dataset.id) found = ev; }));
        if (found) { catSrv.set(Number(found.has_servers) === 1, found.servers); catSlt.lock(true); }
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
    if (form.__srv) form.__srv.set(Number(ev.has_servers) === 1, ev.servers);
    if (form.__slt) form.__slt.lock(true);
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
