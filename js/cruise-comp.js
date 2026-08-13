// Cruise Comp: compare Royal Caribbean & NCL ships.
// Data comes from the Worker proxy at /api/ships, which calls the Widgety
// Ships API server-side (App ID + Token stay secret as Worker secrets).
(function () {
  const root = document.getElementById('cruiseComp');
  if (!root) return;

  const MAX_COMPARE = 3;
  const els = {
    status: root.querySelector('#ccStatus'),
    toolbar: root.querySelector('#ccToolbar'),
    lineFilter: root.querySelector('#ccLineFilter'),
    sizeFilter: root.querySelector('#ccSizeFilter'),
    search: root.querySelector('#ccSearch'),
    count: root.querySelector('#ccCount'),
    grid: root.querySelector('#ccGrid'),
    tray: root.querySelector('#ccTray'),
    traySlots: root.querySelector('#ccTraySlots'),
    compareBtn: root.querySelector('#ccCompareBtn'),
    trayClear: root.querySelector('#ccTrayClear'),
    // The comparison overlay lives outside #cruiseComp (sibling of the footer),
    // so it is queried from the document rather than the widget root.
    modal: document.getElementById('ccModal'),
    modalBody: document.getElementById('ccModalBody'),
    modalClose: document.getElementById('ccModalClose'),
  };

  const state = { ships: [], filters: { line: 'all', size: 'all', q: '' }, selected: [] };

  const SIZE_LABELS = { large: 'Large', super: 'Super', mega: 'Mega' };
  const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const fmtTonnage = (n) => (n ? n.toLocaleString('en-US') + ' GT' : '—');
  const fmtMeters = (n) => (n ? n + ' m' : '—');
  const byId = (id) => state.ships.find((s) => s.id === id);

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function load() {
    try {
      const res = await fetch('/api/ships', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        throw new Error(info.message || 'HTTP ' + res.status);
      }
      const data = await res.json();
      state.ships = Array.isArray(data.ships) ? data.ships : [];
      if (!state.ships.length) throw new Error('No ships returned.');
      buildFilters(data.lines || []);
      els.status.style.display = 'none';
      els.toolbar.hidden = false;
      render();
    } catch (err) {
      els.status.className = 'cc-status is-error';
      els.status.textContent =
        'The cruise comparison is temporarily unavailable. Please check back soon or contact your advisor.';
      // Detail for anyone reading the console.
      console.error('Cruise Comp load failed:', err);
    }
  }

  function buildFilters(lines) {
    // Line filter chips.
    const lineChips = [{ v: 'all', label: 'All Lines' }].concat(
      lines.map((l) => ({ v: l, label: l.replace(' International', '').replace(' Cruise Line', '') }))
    );
    els.lineFilter.innerHTML = lineChips
      .map(
        (c) =>
          `<button type="button" class="cc-chip${c.v === 'all' ? ' is-active' : ''}" data-line="${esc(
            c.v
          )}">${esc(c.label)}</button>`
      )
      .join('');

    // Size filter chips (only sizes present in the data).
    const sizes = [...new Set(state.ships.map((s) => s.size).filter(Boolean))].sort();
    const sizeChips = [{ v: 'all', label: 'Any Size' }].concat(
      sizes.map((s) => ({ v: s, label: SIZE_LABELS[s] || titleCase(s) }))
    );
    els.sizeFilter.innerHTML = sizeChips
      .map(
        (c) =>
          `<button type="button" class="cc-chip${c.v === 'all' ? ' is-active' : ''}" data-size="${esc(
            c.v
          )}">${esc(c.label)}</button>`
      )
      .join('');
  }

  function filtered() {
    const { line, size, q } = state.filters;
    const needle = q.trim().toLowerCase();
    return state.ships.filter((s) => {
      if (line !== 'all' && s.line !== line) return false;
      if (size !== 'all' && s.size !== size) return false;
      if (needle && !(s.title + ' ' + s.ship_class).toLowerCase().includes(needle)) return false;
      return true;
    });
  }

  function render() {
    const list = filtered();
    els.count.textContent =
      list.length + (list.length === 1 ? ' ship' : ' ships') +
      (state.ships.length !== list.length ? ' of ' + state.ships.length : '');

    if (!list.length) {
      els.grid.innerHTML = '<p class="cc-status">No ships match those filters.</p>';
      return;
    }

    els.grid.innerHTML = list.map(cardHtml).join('');
    els.grid.querySelectorAll('[data-select]').forEach((btn) => {
      btn.addEventListener('click', () => toggleSelect(Number(btn.getAttribute('data-select'))));
    });
    renderTray();
  }

  function cardHtml(s) {
    const isSel = state.selected.includes(s.id);
    const badge = s.logo
      ? `<span class="cc-line-badge"><img src="${encodeURI(s.logo)}" alt="${esc(s.line)}" loading="lazy"></span>`
      : '';
    const img = s.image
      ? `<img src="${encodeURI(s.image)}" alt="${esc(s.title)}" loading="lazy">`
      : '';
    return `
      <article class="cc-card${isSel ? ' is-selected' : ''}" data-id="${s.id}">
        <div class="cc-card-media">${img}${badge}</div>
        <div class="cc-card-body">
          <h3 class="cc-card-title">${esc(s.title)}</h3>
          <div class="cc-tags">
            ${s.ship_class ? `<span class="cc-tag">${esc(s.ship_class)} Class</span>` : ''}
            ${s.size ? `<span class="cc-tag cc-tag-size">${esc(SIZE_LABELS[s.size] || titleCase(s.size))}</span>` : ''}
          </div>
          <ul class="cc-facts">
            <li><span>Launched</span><span class="cc-fact-val">${esc(s.launch_year || '—')}</span></li>
            <li><span>Tonnage</span><span class="cc-fact-val">${fmtTonnage(s.gross_tonnage)}</span></li>
            <li><span>Sailings</span><span class="cc-fact-val">${s.cruise_count || '—'}</span></li>
          </ul>
          <div class="cc-card-actions">
            <button type="button" class="cc-select-btn" data-select="${s.id}">${
      isSel ? 'Selected ✓' : 'Compare'
    }</button>
            ${s.url ? `<a class="cc-detail-link" href="${encodeURI(s.url)}" target="_blank" rel="noopener">Details</a>` : ''}
          </div>
        </div>
      </article>`;
  }

  function toggleSelect(id) {
    const i = state.selected.indexOf(id);
    if (i >= 0) {
      state.selected.splice(i, 1);
    } else {
      if (state.selected.length >= MAX_COMPARE) {
        flashTray();
        return;
      }
      state.selected.push(id);
    }
    // Update just the affected card + tray without a full re-render.
    const card = els.grid.querySelector(`.cc-card[data-id="${id}"]`);
    if (card) {
      const sel = state.selected.includes(id);
      card.classList.toggle('is-selected', sel);
      const btn = card.querySelector('.cc-select-btn');
      if (btn) btn.textContent = sel ? 'Selected ✓' : 'Compare';
    }
    renderTray();
  }

  function renderTray() {
    const n = state.selected.length;
    els.tray.classList.toggle('is-visible', n > 0);
    els.compareBtn.disabled = n < 2;
    els.compareBtn.textContent = n < 2 ? 'Select 2+ to compare' : `Compare ${n} ships`;
    els.traySlots.innerHTML = state.selected
      .map((id) => {
        const s = byId(id);
        return `<span class="cc-slot">${esc(s ? s.title : '')}<button type="button" data-remove="${id}" aria-label="Remove">×</button></span>`;
      })
      .join('');
    els.traySlots.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => toggleSelect(Number(b.getAttribute('data-remove'))));
    });
  }

  function flashTray() {
    els.tray.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }],
      { duration: 260 }
    );
  }

  function openCompare() {
    const picks = state.selected.map(byId).filter(Boolean);
    if (picks.length < 2) return;
    const rows = [
      ['Cruise line', (s) => esc(s.line)],
      ['Class', (s) => esc(s.ship_class || '—')],
      ['Size', (s) => esc(SIZE_LABELS[s.size] || titleCase(s.size) || '—')],
      ['Launched', (s) => esc(s.launch_year || '—')],
      ['Last refit', (s) => esc(s.refit_year || '—')],
      ['Gross tonnage', (s) => fmtTonnage(s.gross_tonnage)],
      ['Length', (s) => fmtMeters(s.length)],
      ['Width', (s) => fmtMeters(s.width)],
      ['Sailings listed', (s) => (s.cruise_count || '—')],
    ];
    const head =
      '<tr><th></th>' +
      picks
        .map(
          (s) =>
            `<th>${
              s.image ? `<img class="cc-compare-ship-img" src="${encodeURI(s.image)}" alt="${esc(s.title)}">` : ''
            }<span class="cc-compare-ship-name">${esc(s.title)}</span></th>`
        )
        .join('') +
      '</tr>';
    const body = rows
      .map(
        (r) =>
          `<tr><th scope="row">${r[0]}</th>` + picks.map((s) => `<td>${r[1](s)}</td>`).join('') + '</tr>'
      )
      .join('');
    els.modalBody.innerHTML =
      '<div class="cc-compare-scroll"><table class="cc-compare-table"><thead>' +
      head +
      '</thead><tbody>' +
      body +
      '</tbody></table></div>' +
      '<div class="cc-compare-cta"><p style="margin-bottom:1rem;color:var(--ink-soft);">Prices vary by sailing and date. Your Parrothead travel advisors book every major line.</p>' +
      '<a href="contact.html" class="btn btn-gold">Ask Your Advisor to Book</a></div>';
    els.modal.classList.add('is-open');
    els.modalClose.focus();
  }

  function closeCompare() {
    els.modal.classList.remove('is-open');
  }

  // Events
  els.lineFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-line]');
    if (!btn) return;
    state.filters.line = btn.getAttribute('data-line');
    els.lineFilter.querySelectorAll('.cc-chip').forEach((c) => c.classList.toggle('is-active', c === btn));
    render();
  });
  els.sizeFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-size]');
    if (!btn) return;
    state.filters.size = btn.getAttribute('data-size');
    els.sizeFilter.querySelectorAll('.cc-chip').forEach((c) => c.classList.toggle('is-active', c === btn));
    render();
  });
  els.search.addEventListener('input', () => {
    state.filters.q = els.search.value;
    render();
  });
  els.compareBtn.addEventListener('click', openCompare);
  els.trayClear.addEventListener('click', () => {
    state.selected = [];
    render();
  });
  els.modalClose.addEventListener('click', closeCompare);
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) closeCompare();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCompare();
  });

  load();
})();
