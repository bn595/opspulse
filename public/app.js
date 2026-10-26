'use strict';
// Renders /api/snapshot. Ticket titles and comments are user-generated: escape all text with esc().

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const href = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const store = {
  get(k, d) { try { const v = localStorage.getItem('opspulse.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('opspulse.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const H = 3600e3, D = 86400e3;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const fmt = new Intl.NumberFormat();

let snap = null;
let now = Date.now();
const ui = {
  win: store.get('win', 24),
  ghasWin: store.get('ghasWin', 30),
  filters: {},  // panel -> { facet: value }
  queries: {},  // panel -> search text
  expanded: {}, // panel -> show all rows
  sort: { jira: store.get('jiraSort', { key: 'updated', dir: -1 }) }, // panel -> { key, dir }
  focus: null,
  feedAll: false,
  showMuted: false,
};

/* ---------- formatting ---------- */
function rel(t) {
  if (!t) return '—';
  const ms = now - (typeof t === 'number' ? t : Date.parse(t));
  const fut = ms < 0, a = Math.abs(ms);
  let s;
  if (a < 60e3) s = 'just now';
  else if (a < H) s = `${Math.round(a / 60e3)}m`;
  else if (a < 48 * H) s = `${Math.round(a / H)}h`;
  else s = `${Math.round(a / D)}d`;
  return s === 'just now' ? s : fut ? `in ${s}` : `${s} ago`;
}
function dur(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m < 60 ? `${m}m ${String(s).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const dateStr = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayStr = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n, w, many) => `${fmt.format(n)} ${n === 1 ? w : many || w + 's'}`;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const winLabel = (h) => (h < 48 ? `${h}h` : `${h / 24}d`);
const pretty = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
// Normalizes dismissal reasons, which differ by tool ("won't fix" vs "wont_fix").
const reasonLabel = (r) => { const k = String(r || 'unspecified').toLowerCase().replace(/[_\s]+/g, ' ').replace("won't", 'wont').trim(); return k === 'wont fix' ? "Won't fix" : pretty(k); };

/* ---------- icons ---------- */
const ICON = {
  critical: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2z" fill="currentColor"/><path d="M8 4.6v4.2M8 10.9v.4" stroke="var(--card)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.6 15 14H1z" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="1"/><path d="M8 6v3.6M8 11.5v.3" stroke="var(--card)" stroke-width="1.7" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 7.2v4.3M8 4.6v.3" stroke="var(--card)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4" fill="none" stroke="var(--card)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  running: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="26 12"/></svg>',
  idle: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};
const LEVEL_LABEL = { critical: 'Critical', warn: 'Warning', info: 'Info' };
const SRC_LABEL = { actions: 'Actions', jira: 'Jira', sonar: 'Sonar', ghas: 'GHAS', dismissals: 'GHAS', secrets: 'Secrets' };

/* ---------- tooltip ---------- */
const tip = $('#tip');
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.getAttribute('data-tip'); // values are pre-escaped
  tip.hidden = false;
});
document.addEventListener('mousemove', (e) => {
  if (tip.hidden) return;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
});
document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

/* ---------- charts ---------- */
// Stacked columns. buckets: [{ t0, t1, label, segs: [{ v, cls, name }] }]
function columns(el, buckets, { height = 150, tipTitle } = {}) {
  const W = Math.max(240, el.clientWidth || 600);
  const padL = 30, padB = 20, padT = 6;
  const iw = W - padL, ih = height - padB - padT;
  const max = Math.max(1, ...buckets.map((b) => b.segs.reduce((s, x) => s + x.v, 0)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + ih - (v / top) * ih;
  const bw = iw / buckets.length;
  const barW = Math.max(2, Math.min(28, bw * 0.68));
  let svg = `<svg width="${W}" height="${height}" role="img">`;
  for (let v = 0; v <= top; v += step) {
    svg += `<line class="${v === 0 ? 'base' : 'gl'}" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt.format(v)}</text>`;
  }
  const every = Math.ceil(buckets.length / Math.max(2, Math.floor(iw / 64)));
  buckets.forEach((b, i) => {
    const cx = padL + bw * i + bw / 2;
    let acc = 0;
    const segs = b.segs.filter((s) => s.v > 0);
    segs.forEach((s, si) => {
      const y0 = y(acc), y1 = y(acc + s.v);
      const gap = si > 0 ? 2 : 0; // 2px surface gap between stacked fills
      const h = Math.max(0, y0 - y1 - gap);
      const isTop = si === segs.length - 1;
      svg += isTop ? roundTop(cx - barW / 2, y1, barW, h, Math.min(4, h, barW / 2), s.cls) : `<rect class="${s.cls}" x="${cx - barW / 2}" y="${y1}" width="${barW}" height="${h}"/>`;
      acc += s.v;
    });
    if (i % every === 0) svg += `<text x="${cx}" y="${height - 5}" text-anchor="middle">${esc(b.label)}</text>`;
    const total = b.segs.reduce((s, x) => s + x.v, 0);
    const lines = b.segs.map((s) => `${esc(s.name)}: <b>${fmt.format(s.v)}</b>`).join('<br>');
    const t = `<b>${esc(tipTitle ? tipTitle(b) : b.label)}</b><br>${b.segs.length > 1 ? `Total: <b>${fmt.format(total)}</b><br>` : ''}${lines}`;
    svg += `<rect class="hit" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${ih}" data-tip="${esc(t)}"/>`;
  });
  el.innerHTML = svg + '</svg>';
}
function roundTop(x, y, w, h, r, cls) {
  if (h <= 0) return '';
  r = Math.max(0, Math.min(r, h));
  return `<path class="${cls}" d="M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z"/>`;
}
function niceStep(max) {
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}
function legend(items) {
  return `<div class="legend">${items.map(([cls, name]) => `<span><i class="sw ${cls}"></i>${esc(name)}</span>`).join('')}</div>`;
}
// Horizontal bars. rows: [{ label, v, key?, cls?, tip? }]. With panel + facet, each bar toggles a filter.
function hbars(rows, { panel, facet, active } = {}) {
  if (!rows.length) return '<div class="empty small">Nothing in this window</div>';
  const m = Math.max(...rows.map((r) => r.v), 1);
  const click = panel && facet;
  return `<div class="hbars${active != null ? ' has-active' : ''}">${rows.map((r) => {
    const key = String(r.key ?? r.label);
    const on = active === key;
    const attrs = click ? ` data-panel="${esc(panel)}" data-facet="${esc(facet)}" data-key="${esc(key)}" role="button" tabindex="0" aria-pressed="${on}"` : '';
    return `<div class="hbar${click ? ' clickable' : ''}${on ? ' active' : ''}"${attrs} data-tip="${esc(`<b>${esc(r.label)}</b><br>${fmt.format(r.v)}${r.tip ? '<br>' + esc(r.tip) : ''}${click ? `<br><i>${on ? 'Click to clear filter' : 'Click to filter'}</i>` : ''}`)}">
        <span class="hb-label">${esc(r.label)}</span>
        <span class="hb-track"><span class="hb-fill ${r.cls || 'bg-s1'}" style="width:${(r.v / m) * 100}%;display:block"></span></span>
        <span class="hb-val">${fmt.format(r.v)}</span></div>`;
  }).join('')}</div>`;
}
function countBy(items, fn) {
  const m = new Map();
  for (const i of items) { const k = fn(i); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function bucketize(items, getT, fromMs, toMs, stepMs, segFn) {
  const n = Math.ceil((toMs - fromMs) / stepMs);
  const out = Array.from({ length: n }, (_, i) => ({ t0: fromMs + i * stepMs, t1: fromMs + (i + 1) * stepMs, items: [] }));
  for (const it of items) {
    const t = Date.parse(getT(it));
    const idx = Math.floor((t - fromMs) / stepMs);
    if (idx >= 0 && idx < n) out[idx].items.push(it);
  }
  return out.map((b) => ({ ...b, segs: segFn(b.items) }));
}

/* ---------- filters ---------- */
// Facets per panel: { facet: { label, get(item), fmt?(value) } }. Plugins register theirs at render time.
const FACETS = {};
const SEARCH = {};
const facetDefs = (panel) => FACETS[panel] || {};

const panelCtx = (panel) => ({ facets: facetDefs(panel), filters: ui.filters[panel] || {}, query: ui.queries[panel] || '', search: SEARCH[panel] });
const applyFilters = (panel, items, except) => OpsView.filterItems(items, panelCtx(panel), except);

// Breakdown for one facet, computed with every other filter applied.
function facetBars(panel, facet, items, { limit, cls, sort } = {}) {
  const def = facetDefs(panel)[facet];
  const { rows, more } = OpsView.breakdown(items, panelCtx(panel), facet, { limit, sort });
  const bars = rows.map((r) => ({ key: r.key, label: def.fmt ? def.fmt(r.key) : r.key, v: r.count, cls: cls ? cls(r.key) : undefined }));
  return hbars(bars, { panel, facet, active: ui.filters[panel]?.[facet] }) + (more ? `<div class="muted small more-note">+${fmt.format(more)} more · search to narrow</div>` : '');
}

function filterBar(panel, n, noun, extra = '') {
  const defs = facetDefs(panel);
  const pills = Object.entries(ui.filters[panel] || {}).map(([k, v]) => `<span class="filter-pill">${esc(defs[k]?.label || k)}: ${esc(defs[k]?.fmt ? defs[k].fmt(v) : v)}<button type="button" data-panel="${esc(panel)}" data-unfacet="${esc(k)}" aria-label="Remove ${esc(defs[k]?.label || k)} filter">×</button></span>`).join('');
  const any = pills || ui.queries[panel];
  return `<div class="toolbar">
    <input class="input" type="search" data-search="${esc(panel)}" placeholder="Search…" value="${esc(ui.queries[panel] || '')}" aria-label="Search">
    ${pills}${any ? `<button class="link-btn" type="button" data-clearall="${esc(panel)}">Clear all</button>` : ''}
    <span class="muted small">${plural(n, noun)}</span>
    <span class="tb-right">${extra}${EXPORT[panel] ? exportBtn(panel) : ''}<button class="btn sm" type="button" data-copylink="${esc(panel)}">Copy link</button></span>
  </div>`;
}

function filtersChanged(panel) {
  if (ui.filters[panel] && !Object.keys(ui.filters[panel]).length) delete ui.filters[panel];
  ui.expanded[panel] = false;
  ui.focus = panel;
  writeHash();
  rerender(panel);
}
function setFacet(panel, facet, value, toggle) {
  const f = (ui.filters[panel] ||= {});
  if (value == null || (toggle && f[facet] === value)) delete f[facet];
  else f[facet] = value;
  filtersChanged(panel);
}
function clearFilters(panel) {
  delete ui.filters[panel];
  delete ui.queries[panel];
  filtersChanged(panel);
}

let dashboardHash = ''; // restored when switching back from the admin view
function writeHash() {
  dashboardHash = '#' + OpsView.encodeState({ win: ui.win, ghasWin: ui.ghasWin, filters: ui.filters, queries: ui.queries, focus: ui.focus });
  history.replaceState(null, '', dashboardHash);
}
function readHash() {
  const st = OpsView.decodeState(location.hash);
  ui.filters = st.filters;
  ui.queries = st.queries;
  if (st.win) ui.win = st.win;
  if (st.ghasWin) ui.ghasWin = st.ghasWin;
  if (st.focus) ui.focus = st.focus;
}

const RENDER = {};
const EXPORT = {}; // panel -> () => { name, columns: [[header, fn(row)]], rows }

function downloadCsv(panel) {
  const x = EXPORT[panel]?.();
  if (!x) return;
  const blob = new Blob(['\ufeff' + OpsView.toCsv(x.columns, x.rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `opspulse-${x.name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const exportBtn = (panel) => `<button class="btn sm" type="button" data-export="${esc(panel)}">Export CSV</button>`;

const pluginKey = (id) => `plugin:${id}`;
const pluginIdOf = (key) => (key.startsWith('plugin:') ? key.slice(7) : null);

// Column types: how a value renders, sorts and aligns.
const COLUMN_TYPES = {
  text: { sortValue: (v) => String(v ?? ''), cell: (v) => esc(v) },
  number: { align: 'r', sortValue: (v) => Number(v) || 0, cell: (v) => (typeof v === 'number' ? fmt.format(v) : esc(v)) },
  date: { sortValue: (v) => Date.parse(v) || 0, cell: (v) => `<span data-tip="${esc(esc(dateStr(v)))}">${rel(v)}</span>` },
  link: { sortValue: (v) => String(v ?? ''), cell: (v, col, row) => (col.href && row[col.href] ? `<a href="${href(row[col.href])}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)) },
};
function sortRows(rows, col, dir) {
  const value = COLUMN_TYPES[col.type || 'text'].sortValue;
  return [...rows].sort((a, b) => {
    const x = value(a[col.key]), y = value(b[col.key]);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}
// Headers marked <th data-sort="key"> toggle the panel's sort; a new column starts descending.
function bindSort(root, panel, onChange) {
  root.querySelectorAll('th[data-sort]').forEach((th) => (th.onclick = () => {
    const cur = ui.sort[panel];
    ui.sort[panel] = { key: th.dataset.sort, dir: cur?.key === th.dataset.sort ? -cur.dir : -1 };
    onChange(ui.sort[panel]);
  }));
}
const sortArrow = (panel, key) => (ui.sort[panel]?.key === key ? (ui.sort[panel].dir > 0 ? ' ↑' : ' ↓') : '');

// Items per day over the last `days` days. segs(itemsOfDay) -> [{ v, cls, name }]
function dailyChart(el, items, getTime, days, segs, height = 150) {
  const from = new Date(now - (days - 1) * D);
  from.setHours(0, 0, 0, 0);
  const buckets = bucketize(items, getTime, from.getTime(), from.getTime() + days * D, D, segs).map((x) => ({ ...x, label: dayStr(x.t0) }));
  columns(el, buckets, { height });
}
// Re-render one panel, keeping focus and caret in its search box.
function rerender(panel) {
  const a = document.activeElement;
  const typing = a?.dataset?.search === panel ? [a.selectionStart, a.selectionEnd] : null;
  now = Date.now();
  (RENDER[panel] || renderAll)();
  renderKpis();
  if (typing) {
    const n = document.querySelector(`[data-search="${CSS.escape(panel)}"]`);
    if (n) { n.focus(); n.setSelectionRange(...typing); }
  }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-facet],[data-apply],[data-unfacet],[data-clearall],[data-copylink],[data-more],[data-export]');
  if (!t) return;
  if (t.dataset.export) { downloadCsv(t.dataset.export); return; }
  const panel = t.dataset.panel || t.dataset.clearall || t.dataset.copylink || t.dataset.more;
  if (t.dataset.facet) setFacet(panel, t.dataset.facet, t.dataset.key, t.dataset.set !== '1');
  else if (t.dataset.apply) { ui.filters[panel] = JSON.parse(t.dataset.apply); filtersChanged(panel); }
  else if (t.dataset.unfacet) setFacet(panel, t.dataset.unfacet, null);
  else if (t.dataset.clearall) clearFilters(panel);
  else if (t.dataset.more) { ui.expanded[panel] = !ui.expanded[panel]; rerender(panel); }
  else if (t.dataset.copylink) {
    ui.focus = panel;
    writeHash();
    navigator.clipboard?.writeText(location.href).then(() => { t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy link'; }, 1500); });
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-facet][role="button"], [data-goto][role="button"]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('input', (e) => {
  const panel = e.target.dataset?.search;
  if (!panel) return;
  ui.queries[panel] = e.target.value;
  filtersChanged(panel);
});
// Views: #/admin shows the admin tools; any other hash is the dashboard and its view state.
function route() {
  const admin = location.hash.startsWith('#/admin');
  $('#view-dashboard').hidden = admin;
  $('#view-admin').hidden = !admin;
  document.querySelectorAll('.sidenav a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === (admin ? 'admin' : 'dashboard') ? 'page' : 'false'));
  if (admin) Admin.show();
  return admin;
}
document.querySelector('.sidenav').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a || a.dataset.view !== 'dashboard') return;
  e.preventDefault();
  location.hash = dashboardHash || '#';
});
addEventListener('hashchange', () => { if (!route()) { readHash(); renderAll(); } });

/* ---------- shell ---------- */
function sourceState(key) {
  const s = snap.sources[key];
  if (!s || s.status === 'disabled') return null;
  if (s.status === 'refreshing' || s.status === 'pending') return { cls: 'busy', text: 'refreshing…' };
  if (s.status === 'rate-limited') return { cls: 'stale', text: `rate limited, resumes ${rel(s.retryAt)}` };
  if (s.error) return { cls: s.data ? 'stale' : 'err', text: s.error };
  if (s.status === 'cached') return { cls: 'stale', text: 'from cache' };
  const budget = snap.limits?.[s.platform];
  const left = budget?.limit ? ` · API budget ${fmt.format(budget.remaining)} / ${fmt.format(budget.limit)}` : '';
  return { cls: 'ok', text: `updated ${rel(s.fetchedAt)} · ${(s.durationMs / 1000).toFixed(1)}s${left}` };
}

function renderShell() {
  $('#demo-tag').hidden = !snap.demo;
  const sourceChips = [['actions', 'actions', 'Actions'], ['jira', 'jira', 'Jira'], ['dismissals', 'ghas', 'GHAS'], ['sonar', 'sonar', 'Sonar'],
    ...Object.keys(snap.sources).map(pluginIdOf).filter(Boolean).map((id) => [pluginKey(id), id, snap.sources[pluginKey(id)].title || id])];
  const a = snap.auth || {};
  let chips = sourceChips
    .map(([k, panel, n]) => { const st = sourceState(k); return st ? `<button type="button" class="chip" data-goto="${esc(panel)}" data-tip="${esc(`<b>${esc(n)}</b><br>${esc(st.text)}`)}"><i class="dot ${st.cls}"></i>${esc(n)}</button>` : ''; })
    .join('');
  if (a.enabled) {
    const st = a.signedIn ? { cls: 'ok', text: `signed in as ${a.user || 'unknown'} via ${a.method}` } : a.device ? { cls: 'busy', text: 'waiting for device sign-in' } : a.needsLogin ? { cls: 'stale', text: 'sign-in required' } : a.error ? { cls: 'err', text: a.error } : { cls: '', text: 'not connected yet' };
    chips += `<button type="button" class="chip" data-goto="top" data-tip="${esc(`<b>Key Vault · ${esc(a.vault)}</b><br>${esc(st.text)}`)}"><i class="dot ${st.cls}"></i>Key Vault</button>`;
  }
  $('#sources').innerHTML = chips;
  $('#updated').textContent = snap.lastRefreshAt ? `Updated ${rel(snap.lastRefreshAt)}` : 'Loading…';
  $('#refresh').classList.toggle('spin', snap.refreshing);
  $('#refresh').disabled = snap.refreshing;

  const c = snap.config;
  const setup = [];
  if (!snap.demo && !c.configExists) {
    setup.push(`<div class="alert info"><b>No config found.</b> Copy <code>config.example.jsonc</code> to <code>config.json</code>, fill in repos/orgs/JQL, put tokens in <code>.env</code> or Key Vault, then hit Refresh. Expected at <code>${esc(c.configFile)}</code>. Try <code>npm run demo</code> to see it with fake data.</div>`);
  }
  if (a.enabled && !a.signedIn && (a.needsLogin || a.device || a.error)) {
    const missing = Object.entries(a.secrets || {}).filter(([, v]) => v === 'pending' || v === 'error').map(([k]) => k);
    let body;
    if (a.device) {
      body = `<div class="auth-row"><div><b>Finish signing in.</b> Open <a href="${href(a.device.verificationUri)}" target="_blank" rel="noopener">${esc(a.device.verificationUri)}</a> and enter the code
        <code class="code-big" id="device-code">${esc(a.device.userCode)}</code> <button class="btn" type="button" id="copy-code">Copy</button></div>
        <span class="muted small">expires ${rel(a.device.expiresAt)}</span></div>`;
    } else if (a.needsLogin && a.canInteractive) {
      body = `<div class="auth-row"><div><b>Sign in to load secrets.</b> Tokens for ${missing.length ? missing.map(esc).join(', ') : 'this dashboard'} live in Key Vault <code>${esc(a.vault)}</code>. Use your company account; the vault's access policy decides who may read them.</div>
        <div class="auth-btns"><a class="btn primary" href="/auth/azure/start">Sign in with Microsoft</a><button class="btn" type="button" id="device-start">Use a device code</button></div></div>`;
    } else {
      body = `<div><b>Key Vault not reachable.</b> ${esc(a.error || 'Secrets could not be loaded.')}</div>`;
    }
    setup.push(`<div class="alert ${a.device || a.needsLogin ? 'info' : 'err'}" id="auth-card">${body}</div>`);
  }
  $('#setup').innerHTML = setup.join('');
  const ds = $('#device-start'); if (ds) ds.onclick = startDevice;
  const cc = $('#copy-code'); if (cc) cc.onclick = () => { navigator.clipboard?.writeText($('#device-code').textContent).then(() => { cc.textContent = 'Copied'; }); };

  const who = a.enabled && a.signedIn ? ` · Key Vault as ${esc(a.user || 'unknown')} (${esc(a.method)}) <button class="link-btn" id="signout" type="button" style="padding:0">sign out</button>` : '';
  const px = Object.entries(c.network?.proxies || {}).filter(([, v]) => v).map(([k, v]) => `${k} → ${v}`);
  $('#footer').innerHTML = `<span>opspulse ${esc(snap.version)} · refreshes every ${c.refreshMinutes} min${snap.nextRefreshAt ? ` · next ${rel(snap.nextRefreshAt)}` : ''}${px.length ? ` · proxy: ${esc(px.join(', '))}` : ''}</span><span>config: <code>${esc(c.configFile)}</code>${who}</span>`;
  const so = $('#signout'); if (so) so.onclick = async () => { await post('/api/auth/signout'); poll(); };
}

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'X-OpsPulse': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
async function startDevice() {
  const b = $('#device-start'); if (b) { b.disabled = true; b.textContent = 'Requesting code…'; }
  const r = await post('/api/auth/device');
  if (!r || r.error) { if (b) { b.disabled = false; b.textContent = 'Use a device code'; } alert(r?.error || 'Could not start device sign-in'); return; }
  poll();
}

function feedRow(i) {
  const muted = i.muted
    ? `<span class="muted small">${i.muted.kind === 'snoozed' ? `Snoozed until ${esc(dateStr(i.muted.until))}` : 'Acknowledged'}</span><button class="btn sm ghost" type="button" data-feed="restore" data-id="${esc(i.id)}">Restore</button>`
    : `<button class="btn sm ghost" type="button" data-feed="ack" data-id="${esc(i.id)}" data-tip="Hide until this item changes">Acknowledge</button><button class="btn sm ghost" type="button" data-feed="snooze" data-id="${esc(i.id)}" data-tip="Hide for 24 hours">Snooze 24h</button>`;
  return `<div class="feed-item ${i.level}${i.muted ? ' is-muted' : ''}">
      <span class="lvl ${i.level}">${ICON[i.level]}${LEVEL_LABEL[i.level]}</span>
      <div><div class="fi-title">${esc(i.title)}</div>${i.detail ? `<div class="fi-detail">${esc(i.detail)}</div>` : ''}</div>
      <span class="src-tag">${esc(SRC_LABEL[i.source] || snap.sources[pluginKey(i.source)]?.title || i.source)}</span>
      <span class="fi-actions">${i.url ? `<a class="small" href="${href(i.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}${muted}</span>
    </div>`;
}

function renderFeed() {
  const active = snap.feed.filter((i) => !i.muted);
  const muted = snap.feed.filter((i) => i.muted);
  const crit = active.filter((i) => i.level === 'critical').length;
  const warn = active.filter((i) => i.level === 'warn').length;
  const info = active.length - crit - warn;
  $('#feed-summary').textContent = [crit && `${crit} critical`, warn && plural(warn, 'warning'), info && `${info} info`, muted.length && `${muted.length} hidden`].filter(Boolean).join(' · ');
  if (!snap.lastRefreshAt && !snap.feed.length) { $('#feed').innerHTML = '<div class="skeleton" style="height:56px"></div>'; return; }

  const LIMIT = 6;
  const shown = ui.feedAll ? active : active.slice(0, LIMIT);
  let html = active.length
    ? shown.map(feedRow).join('')
    : `<div class="feed-empty"><span class="lvl good">${ICON.good} All clear</span><span>Nothing needs attention right now.</span></div>`;
  const links = [];
  if (active.length > LIMIT) links.push(`<button class="link-btn" type="button" data-feed="all">${ui.feedAll ? 'Show fewer' : `Show all ${active.length}`}</button>`);
  if (muted.length) links.push(`<button class="link-btn" type="button" data-feed="muted">${ui.showMuted ? 'Hide' : 'Show'} ${plural(muted.length, 'acknowledged or snoozed item')}</button>`);
  if (links.length) html += `<div class="feed-links">${links.join('')}</div>`;
  if (ui.showMuted && muted.length) html += muted.map(feedRow).join('');
  $('#feed').innerHTML = html;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-feed]');
  if (!b) return;
  const action = b.dataset.feed;
  if (action === 'all') { ui.feedAll = !ui.feedAll; return renderFeed(); }
  if (action === 'muted') { ui.showMuted = !ui.showMuted; return renderFeed(); }
  const item = snap.feed.find((i) => i.id === b.dataset.id);
  if (!item) return;
  b.disabled = true;
  const body = action === 'restore' ? { id: item.id } : { id: item.id, title: item.title };
  await post(`/api/feed/${action}`, body);
  poll();
});

/* ---------- derived numbers ---------- */
function actionsStats(winH) {
  const d = snap.sources.actions?.data;
  if (!d) return null;
  const since = now - winH * H;
  let runs = 0, fails = 0, failing = 0, total = 0, running = 0, late = 0;
  const all = [];
  for (const repo of d.repos) for (const wf of repo.workflows) {
    total++;
    const rs = wf.runs.filter((r) => Date.parse(r.created) >= since);
    runs += rs.length;
    fails += rs.filter((r) => FAILED.has(r.conclusion)).length;
    all.push(...rs);
    const last = wf.runs.find((r) => r.status === 'completed');
    if (last && FAILED.has(last.conclusion)) failing++;
    if (wf.runs[0] && wf.runs[0].status !== 'completed') running++;
    if (wfState(wf)[0] === 'late') late++;
  }
  return { runs, fails, failing, total, running, late, all };
}

function renderKpis() {
  const tiles = [];
  const a = actionsStats(ui.win);
  if (a) {
    const pct = a.runs ? Math.round((a.fails / a.runs) * 100) : 0;
    tiles.push(kpi(`Job runs · ${winLabel(ui.win)}`, fmt.format(a.runs), a.fails ? `<span class="bad">${plural(a.fails, 'failure')}</span> · ${pct}% of runs` : 'no failures', 'actions'));
    tiles.push(kpi('Workflows failing', `${a.failing}<small> / ${a.total}</small>`, a.failing ? 'latest run failed' : a.late ? `<span class="bad" style="color:var(--warn-ink)">${a.late} overdue</span>` : `all passing${a.running ? ` · ${a.running} running` : ''}`, 'actions'));
  }
  const j = snap.sources.jira?.data;
  if (j) {
    const open = j.issues.filter((i) => i.category !== 'done');
    const wk = j.issues.filter((i) => now - Date.parse(i.created) <= 7 * D).length;
    const un = open.filter((i) => !i.assignee).length;
    tiles.push(kpi('Open tickets', fmt.format(open.length), `+${wk} new in 7d${un ? ` · <span class="bad kpi-link" data-panel="jira" data-apply="${esc(JSON.stringify({ state: 'Open', assignee: 'Unassigned' }))}" data-tip="Show open unassigned tickets">${un} unassigned</span>` : ''}`, 'jira'));
  }
  const g = snap.sources.dismissals?.data;
  if (g) {
    const n = g.orgs.reduce((s, o) => s + o.items.filter((i) => now - Date.parse(i.at) <= ui.ghasWin * D).length, 0);
    tiles.push(kpi(`GHAS dismissals · ${ui.ghasWin}d`, fmt.format(n), `across ${plural(g.orgs.length, 'org')}`, 'ghas'));
  }
  const s = snap.sources.sonar?.data;
  if (s) {
    const sum = (k) => s.orgs.reduce((t, o) => t + (o[k]?.v || 0), 0);
    tiles.push(kpi('Sonar projects', fmt.format(sum('projects')), `${fmt.format(sum('stale'))} not analyzed in ${s.staleDays}d`, 'sonar'));
  }
  for (const [k, src] of Object.entries(snap.sources)) {
    if (!pluginIdOf(k) || !src.data) continue;
    for (const m of src.data.metrics.filter((x) => x.kpi)) tiles.push(kpi(m.label, typeof m.value === 'number' ? fmt.format(m.value) : esc(m.value), esc(m.hint || src.title || ''), pluginIdOf(k)));
  }
  $('#kpis').innerHTML = tiles.join('');
  $('#kpis').hidden = !tiles.length;
}
const kpi = (label, val, sub, panel) => `<div class="kpi"${panel ? ` data-goto="${esc(panel)}" role="button" tabindex="0"` : ''}><div class="k-label">${esc(label)}</div><div class="k-val">${val}</div><div class="k-sub">${sub}</div></div>`;

function goTo(panel) {
  const el = panel === 'top' ? document.body : document.querySelector(`[data-panel-id="${CSS.escape(panel)}"]`);
  if (!el) return;
  if (panel !== 'top') { ui.focus = panel; writeHash(); }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) goTo(g.dataset.goto);
});

// Panel order and visibility from config `ui`; uses CSS order so panels are not re-rendered.
function applyLayout() {
  const secs = [...document.querySelectorAll('#view-dashboard > [data-panel-id]')];
  const order = OpsView.panelOrder(secs.map((s) => s.dataset.panelId), snap.config.ui);
  for (const s of secs) {
    const i = order.indexOf(s.dataset.panelId);
    s.style.order = i;
    s.classList.toggle('layout-hidden', i < 0);
  }
}

function sectionGuard(key, secId, bodyId) {
  const s = snap.sources[key];
  const sec = $(secId), body = $(bodyId);
  if (!s || s.status === 'disabled') { sec.hidden = true; return null; }
  sec.hidden = false;
  if (!s.data) {
    const waiting = /waiting for key vault sign-in/i.test(s.error || '');
    body.innerHTML = s.error
      ? `<div class="alert ${waiting ? 'info' : 'err'}"><b>${waiting ? 'Waiting for sign-in.' : "Couldn't load."}</b> ${waiting ? 'Data will load once Key Vault secrets are available.' : esc(s.error)}</div>`
      : '<div class="skeleton"></div>';
    return null;
  }
  return { data: s.data, banner: s.error ? `<div class="alert warn">Showing data from ${rel(s.fetchedAt)} — last refresh failed: ${esc(s.error)}</div>` : '' };
}

function seg(el, options, value, onPick) {
  el.innerHTML = options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === value}">${l}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(Number(b.dataset.v)); };
}

/* ---------- pipelines ---------- */
function wfState(wf) {
  const latest = wf.runs[0] || wf.lastRun;
  if (wf.state && wf.state !== 'active') return ['idle', 'Disabled'];
  if (latest && latest.status !== 'completed') return ['run', 'Running'];
  const last = wf.runs.find((r) => r.status === 'completed') || wf.lastRun;
  if (!last) return ['idle', 'No runs'];
  if (FAILED.has(last.conclusion)) return ['fail', 'Failing'];
  if (wf.expectEveryHours && now - Date.parse((wf.runs[0] || wf.lastRun).created) > wf.expectEveryHours * H) return ['late', 'Overdue'];
  if (last.conclusion === 'success') return ['pass', 'Passing'];
  return ['idle', pretty(last.conclusion)];
}
const STATE_ICON = { pass: ICON.good, fail: ICON.critical, run: ICON.running, idle: ICON.idle, late: ICON.warn };
RENDER.actions = () => renderActions();

function renderActions() {
  const g = sectionGuard('actions', '#sec-actions', '#actions-body');
  const opts = [24, 72, 168].filter((h) => h <= (snap.sources.actions?.data?.lookbackHours || 168)).map((h) => [h, winLabel(h)]);
  seg($('#win'), opts, ui.win, (v) => { ui.win = v; store.set('win', v); ui.focus = 'actions'; writeHash(); renderAll(); });
  if (!g) return;
  const d = g.data;
  const since = now - ui.win * H;
  const stepH = ui.win <= 24 ? 1 : ui.win <= 72 ? 3 : 6;
  const st = actionsStats(ui.win);

  const summary = [];
  let rows = '';
  for (const repo of d.repos) {
    rows += `<tr class="repo-head"><td colspan="7"><a href="${href(repo.url)}" target="_blank" rel="noopener">${esc(repo.label)}</a>${repo.label !== repo.repo ? ` <span class="muted small mono">${esc(repo.repo)}</span>` : ''}${repo.truncated ? ' <span class="muted small">(run list truncated)</span>' : ''}</td></tr>`;
    if (repo.error) { rows += `<tr><td colspan="7"><div class="alert err">${esc(repo.error)}</div></td></tr>`; continue; }
    if (!repo.workflows.length) { rows += '<tr><td colspan="7" class="muted">No matching workflows</td></tr>'; continue; }
    for (const wf of repo.workflows) {
      const [cls, label] = wfState(wf);
      const inWin = wf.runs.filter((r) => Date.parse(r.created) >= since);
      const fails = inWin.filter((r) => FAILED.has(r.conclusion)).length;
      const ok = inWin.filter((r) => r.conclusion === 'success').length;
      const rate = ok + fails ? Math.round((ok / (ok + fails)) * 100) : null;
      const strip = wf.runs.slice(0, 30).reverse().map((r) => {
        const c = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'success' : FAILED.has(r.conclusion) ? 'failure' : 'other';
        const t = `<b>#${r.n} · ${esc(r.status !== 'completed' ? pretty(r.status) : pretty(r.conclusion))}</b><br>${esc(dateStr(r.created))} (${rel(r.created)})<br>${esc(r.event)}${r.actor ? ' · ' + esc(r.actor) : ''}${r.durationSec != null ? ' · ' + dur(r.durationSec) : ''}`;
        return `<a href="${href(r.url)}" target="_blank" rel="noopener" aria-label="Run ${r.n} ${esc(c)}"><i class="${c}" data-tip="${esc(t)}"></i></a>`;
      }).join('');
      const last = wf.runs[0] || wf.lastRun;
      const med = median(inWin.map((r) => r.durationSec).filter((x) => x != null));
      summary.push({ repo: repo.repo, wf, label, runs: inWin.length, fails, rate, last, med });
      rows += `<tr>
        <td><span class="state ${cls}">${STATE_ICON[cls]}${label}</span></td>
        <td><a href="${href(wf.url)}" target="_blank" rel="noopener">${esc(wf.name)}</a>${wf.expectEveryHours ? ` <span class="muted small" data-tip="Expected to run at least every ${wf.expectEveryHours}h">· every ${wf.expectEveryHours}h</span>` : ''}</td>
        <td class="hide-sm"><div class="strip">${strip || '<span class="muted small">no runs in lookback</span>'}</div></td>
        <td class="r num">${rate == null ? '<span class="muted">—</span>' : rate + '%'}</td>
        <td class="r num">${fails ? `<b style="color:var(--critical-ink)">${fails}</b>` : '0'}<span class="muted"> / ${inWin.length}</span></td>
        <td class="r">${last ? `<a href="${href(last.url)}" target="_blank" rel="noopener" data-tip="${esc(esc(dateStr(last.created)))}">${rel(last.created)}</a>` : '—'}</td>
        <td class="r num hide-sm">${dur(med)}</td></tr>`;
    }
  }

  const hidden = d.repos.reduce((n, r) => n + (r.hidden || 0), 0);
  $('#actions-body').innerHTML = `${g.banner}${hidden ? `<div class="muted small rules-note">${plural(hidden, 'run')} hidden by config rules</div>` : ''}
    <div class="sub-h" style="margin-top:0"><h3>Runs over time · all workflows</h3><span class="muted small">${fmt.format(st.runs)} runs in ${winLabel(ui.win)}</span></div>
    ${legend([['bg-good', 'Succeeded'], ['bg-crit', 'Failed'], ['bg-neutral', 'Cancelled / other']])}
    <div class="chart" id="act-chart"></div>
    <div class="sub-h"><h3>Workflows</h3><span class="tb-right"><span class="muted small hide-sm">recent runs: oldest → newest</span>${exportBtn('actions')}</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Status</th><th>Workflow</th><th class="hide-sm">Recent runs</th><th class="r">Success · ${winLabel(ui.win)}</th><th class="r">Failed / runs</th><th class="r">Last run</th><th class="r hide-sm">Median time</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;

  EXPORT.actions = () => ({
    name: `workflows-${winLabel(ui.win)}`,
    rows: summary,
    columns: [['Repository', (r) => r.repo], ['Workflow', (r) => r.wf.name], ['File', (r) => r.wf.path], ['Status', (r) => r.label],
      [`Runs (${winLabel(ui.win)})`, (r) => r.runs], ['Failures', (r) => r.fails], ['Success rate %', (r) => r.rate],
      ['Last run', (r) => r.last?.created], ['Last conclusion', (r) => r.last?.conclusion || r.last?.status], ['Median duration (s)', (r) => r.med], ['URL', (r) => r.wf.url]],
  });
  const from = Math.floor(since / (stepH * H)) * stepH * H;
  const buckets = bucketize(st.all, (r) => r.created, from, now + 1, stepH * H, (rs) => [
    { v: rs.filter((r) => r.conclusion === 'success').length, cls: 'f-good', name: 'Succeeded' },
    { v: rs.filter((r) => FAILED.has(r.conclusion)).length, cls: 'f-crit', name: 'Failed' },
    { v: rs.filter((r) => r.conclusion !== 'success' && !FAILED.has(r.conclusion)).length, cls: 'f-neutral', name: 'Cancelled / other' },
  ]).map((b) => ({ ...b, label: stepH < 24 && ui.win <= 24 ? new Date(b.t0).toLocaleTimeString(undefined, { hour: 'numeric' }) : dayStr(b.t0) }));
  columns($('#act-chart'), buckets, { tipTitle: (b) => `${dateStr(b.t0)} – ${new Date(b.t1).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` });
}

/* ---------- jira ---------- */
const CAT = { new: ['bg-s1', 'To do'], indeterminate: ['bg-s2', 'In progress'], done: ['bg-s3', 'Done'] };
FACETS.jira = {
  state: { label: 'State', get: (i) => (i.category === 'done' ? 'Done' : 'Open') },
  status: { label: 'Status', get: (i) => i.status },
  assignee: { label: 'Assignee', get: (i) => i.assignee || 'Unassigned' },
  priority: { label: 'Priority', get: (i) => i.priority || 'None' },
  type: { label: 'Type', get: (i) => i.type || 'None' },
};
SEARCH.jira = (i) => `${i.key} ${i.summary} ${i.assignee || ''} ${i.reporter || ''} ${(i.labels || []).join(' ')}`;

function renderJira() {
  const g = sectionGuard('jira', '#sec-jira', '#jira-body');
  if (!g) { $('#jira-open').hidden = true; return; }
  const d = g.data;
  $('#jira-open').hidden = false;
  $('#jira-open').href = d.searchUrl;
  const items = applyFilters('jira', d.issues);
  const open = items.filter((i) => i.category !== 'done');
  const stale = open.filter((i) => now - Date.parse(i.updated) > d.staleDays * D);
  const medAge = median(open.map((i) => now - Date.parse(i.created)));
  const resolved = items.filter((i) => i.resolved && now - Date.parse(i.resolved) <= d.lookbackDays * D).length;

  const minis = [
    ['Open', open.length], ['In progress', open.filter((i) => i.category === 'indeterminate').length], ['Unassigned', open.filter((i) => !i.assignee).length],
    [`Stale · ${d.staleDays}d+`, stale.length], ['Median open age', medAge == null ? '—' : `${Math.round(medAge / D)}d`], [`Resolved · ${d.lookbackDays}d`, resolved],
  ].map(([l, v]) => `<div class="mini"><div class="m-label">${esc(l)}</div><div class="m-val">${typeof v === 'number' ? fmt.format(v) : v}</div></div>`).join('');

  const catOf = new Map(d.issues.map((i) => [i.status, i.category]));
  const order = { new: 0, indeterminate: 1, done: 2 };
  const statusBars = facetBars('jira', 'status', d.issues, {
    limit: 12,
    cls: (s) => CAT[catOf.get(s)]?.[0] || 'bg-neutral',
    sort: (a, b) => (order[catOf.get(a.key)] ?? 3) - (order[catOf.get(b.key)] ?? 3) || b.count - a.count,
  });

  const sort = ui.sort.jira;
  const list = sortRows(items, { key: sort.key, type: sort.key === 'created' || sort.key === 'updated' ? 'date' : 'text' }, sort.dir);
  EXPORT.jira = () => ({
    name: 'jira',
    rows: list,
    columns: [['Key', (i) => i.key], ['Summary', (i) => i.summary], ['Status', (i) => i.status], ['Category', (i) => CAT[i.category]?.[1] || i.category],
      ['Assignee', (i) => i.assignee], ['Reporter', (i) => i.reporter], ['Priority', (i) => i.priority], ['Type', (i) => i.type],
      ['Labels', (i) => (i.labels || []).join(' ')], ['Created', (i) => i.created], ['Updated', (i) => i.updated], ['Resolved', (i) => i.resolved], ['URL', (i) => i.url]],
  });
  const LIMIT = 25;
  const shown = ui.expanded.jira ? list : list.slice(0, LIMIT);
  const arrow = (k) => sortArrow('jira', k);

  $('#jira-body').innerHTML = `${g.banner}${d.truncated ? '<div class="alert warn">Result capped by <code>jira.maxIssues</code>; numbers cover the fetched issues only.</div>' : ''}
    ${d.hidden ? `<div class="muted small rules-note">${plural(d.hidden, 'issue')} hidden by config rules</div>` : ''}
    <div class="minis">${minis}</div>
    <div class="grid-2">
      <div><h3>By status</h3>${legend(Object.values(CAT))}${statusBars}</div>
      <div><h3>Created per day · ${d.lookbackDays}d</h3><div class="chart" id="jira-chart"></div></div>
    </div>
    <div class="grid-4 breakdowns">
      <div><h3>State</h3>${facetBars('jira', 'state', d.issues)}</div>
      <div><h3>Assignee</h3>${facetBars('jira', 'assignee', d.issues)}</div>
      <div><h3>Priority</h3>${facetBars('jira', 'priority', d.issues)}</div>
      <div><h3>Type</h3>${facetBars('jira', 'type', d.issues)}</div>
    </div>
    ${filterBar('jira', list.length, 'ticket')}
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th class="sortable" data-sort="key">Key${arrow('key')}</th><th>Summary</th><th class="sortable" data-sort="status">Status${arrow('status')}</th>
        <th class="sortable hide-sm" data-sort="assignee">Assignee${arrow('assignee')}</th><th class="hide-sm">Priority</th>
        <th class="sortable r" data-sort="created">Age${arrow('created')}</th><th class="sortable r" data-sort="updated">Updated${arrow('updated')}</th></tr></thead>
      <tbody>${shown.map((i) => {
        const isStale = i.category !== 'done' && now - Date.parse(i.updated) > d.staleDays * D;
        return `<tr><td class="mono"><a href="${href(i.url)}" target="_blank" rel="noopener">${esc(i.key)}</a></td>
          <td><div class="trunc" data-tip="${esc(esc(i.summary) + (i.reporter ? `<br>Reporter: ${esc(i.reporter)}` : '') + (i.type ? `<br>${esc(i.type)}` : ''))}">${esc(i.summary)}</div></td>
          <td><span class="pill cat-${esc(i.category)}">${esc(i.status)}</span></td>
          <td class="hide-sm">${i.assignee ? esc(i.assignee) : '<span class="muted">Unassigned</span>'}</td>
          <td class="hide-sm small">${esc(i.priority || '—')}</td>
          <td class="r num" data-tip="${esc('Created ' + esc(dateStr(i.created)))}">${rel(i.created).replace(' ago', '')}</td>
          <td class="r">${rel(i.updated)}${isStale ? '<span class="stale-tag">stale</span>' : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="empty">No tickets match</td></tr>'}</tbody></table></div>
    ${list.length > LIMIT ? `<button class="link-btn" type="button" data-more="jira">${ui.expanded.jira ? 'Show fewer' : `Show all ${fmt.format(list.length)}`}</button>` : ''}`;

  dailyChart($('#jira-chart'), items, (i) => i.created, d.lookbackDays, (xs) => [{ v: xs.length, cls: 'f-s1', name: 'Created' }], 170);
  bindSort($('#jira-body'), 'jira', (s) => { store.set('jiraSort', s); renderJira(); });
}
RENDER.jira = renderJira;

/* ---------- GHAS ---------- */
const TOOL = { 'code-scanning': ['bg-s1', 'f-s1', 'Code scanning'], 'secret-scanning': ['bg-s2', 'f-s2', 'Secret scanning'], dependabot: ['bg-s3', 'f-s3', 'Dependabot'] };
FACETS.ghas = {
  org: { label: 'Org', get: (i) => i.org },
  tool: { label: 'Tool', get: (i) => i.tool, fmt: (t) => TOOL[t]?.[2] || t },
  reason: { label: 'Reason', get: (i) => reasonLabel(i.reason) },
  by: { label: 'Dismissed by', get: (i) => i.by || 'unknown' },
  repo: { label: 'Repository', get: (i) => i.repo },
  title: { label: 'Alert', get: (i) => i.title },
  severity: { label: 'Severity', get: (i) => i.severity || 'none' },
};
SEARCH.ghas = (i) => `${i.title} ${i.repo} ${i.by || ''} ${i.comment || ''} ${i.secretType || ''} ${i.package || ''} ${i.ruleId || ''}`;

function renderGhas() {
  const g = sectionGuard('dismissals', '#sec-ghas', '#ghas-body');
  const lb = snap.sources.dismissals?.data?.lookbackDays || 30;
  const opts = [7, 14, 30, 90].filter((x) => x <= lb).map((x) => [x, `${x}d`]);
  if (ui.ghasWin > lb) ui.ghasWin = lb;
  seg($('#ghas-win'), opts, ui.ghasWin, (v) => { ui.ghasWin = v; store.set('ghasWin', v); ui.focus = 'ghas'; writeHash(); renderAll(); });
  if (!g) return;
  const d = g.data;
  const since = now - ui.ghasWin * D;
  const base = d.orgs.flatMap((o) => o.items.filter((i) => Date.parse(i.at) >= since).map((i) => (i.org ? i : { ...i, org: o.org })));
  const items = applyFilters('ghas', base).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const orgSel = ui.filters.ghas?.org;
  const sel = orgSel ? d.orgs.filter((o) => o.org === orgSel) : d.orgs;
  const errs = [...Object.entries(d.errors || {}).map(([t, e]) => `${d.enterprise} · ${TOOL[t]?.[2] || t}: ${e}`), ...sel.flatMap((o) => Object.entries(o.errors).map(([t, e]) => `${o.org} · ${TOOL[t]?.[2] || t}: ${e}`))];
  const hidden = sel.reduce((n, o) => n + (o.hidden || 0), 0);

  const forTabs = applyFilters('ghas', base, 'org');
  const orgCount = new Map(countBy(forTabs, (i) => i.org));
  const tabs = d.orgs.length > 1
    ? `<div class="tabs" role="tablist">
        <button role="tab" type="button" data-panel="ghas" data-unfacet="org" aria-selected="${!orgSel}">All orgs<span class="count">${fmt.format(forTabs.length)}</span></button>
        ${d.orgs.map((o) => `<button role="tab" type="button" data-panel="ghas" data-facet="org" data-set="1" data-key="${esc(o.org)}" aria-selected="${orgSel === o.org}">${esc(o.org)}<span class="count">${fmt.format(orgCount.get(o.org) || 0)}</span></button>`).join('')}
      </div>`
    : '';

  const forTools = applyFilters('ghas', base, 'tool');
  const toolSel = ui.filters.ghas?.tool;
  const minis = d.tools.filter((t) => TOOL[t]).map((t) => {
    const failed = sel.some((o) => o.errors[t]);
    return `<div class="mini clickable${toolSel === t ? ' active' : ''}" data-panel="ghas" data-facet="tool" data-key="${esc(t)}" role="button" tabindex="0" aria-pressed="${toolSel === t}">
      <div class="m-label"><i class="sw ${TOOL[t][0]}"></i>${TOOL[t][2]}</div><div class="m-val${failed ? ' na' : ''}">${failed ? 'n/a' : fmt.format(forTools.filter((i) => i.tool === t).length)}</div></div>`;
  }).join('');
  const total = `<div class="mini"><div class="m-label">Dismissed · ${ui.ghasWin}d</div><div class="m-val">${fmt.format(items.length)}</div></div>`;

  EXPORT.ghas = () => ({
    name: 'ghas-dismissals',
    rows: items,
    columns: [['Dismissed at', (i) => i.at], ['Org', (i) => i.org], ['Tool', (i) => TOOL[i.tool]?.[2] || i.tool], ['Alert', (i) => i.title], ['Severity', (i) => i.severity],
      ['Repository', (i) => i.repo], ['Dismissed by', (i) => i.by], ['Reason', (i) => reasonLabel(i.reason)], ['Comment', (i) => i.comment],
      ['Secret type', (i) => i.secretType], ['Validity', (i) => i.validity], ['Package', (i) => i.package], ['Rule', (i) => i.ruleId], ['URL', (i) => i.url]],
  });
  const LIMIT = 15;
  const shown = ui.expanded.ghas ? items : items.slice(0, LIMIT);

  $('#ghas-body').innerHTML = `${g.banner}${tabs}
    ${errs.length ? `<div class="alert warn">${errs.map(esc).join('<br>')}</div>` : ''}
    ${d.truncated?.length || sel.some((o) => o.truncated.length) ? '<div class="alert warn">Some results hit <code>maxPagesPerTool</code>; counts may be low until the next full sync.</div>' : ''}
    ${d.mode === 'enterprise' ? `<div class="muted small rules-note">Enterprise <b>${esc(d.enterprise)}</b> · organizations where you are an owner or security manager</div>` : ''}
    ${hidden ? `<div class="muted small rules-note">${plural(hidden, 'dismissal')} hidden by config rules</div>` : ''}
    <div class="minis">${total}${minis}</div>
    <h3>Dismissals per day</h3>
    ${legend(d.tools.filter((t) => TOOL[t]).map((t) => [TOOL[t][0], TOOL[t][2]]))}
    <div class="chart" id="ghas-chart"></div>
    <div class="grid-4 breakdowns">
      <div><h3>Reason</h3>${facetBars('ghas', 'reason', base)}</div>
      <div><h3>Dismissed by</h3>${facetBars('ghas', 'by', base)}</div>
      <div><h3>Repository</h3>${facetBars('ghas', 'repo', base)}</div>
      <div><h3>Alert</h3>${facetBars('ghas', 'title', base)}</div>
    </div>
    ${filterBar('ghas', items.length, 'dismissal')}
    <div class="tbl-wrap"><table>
      <thead><tr><th>When</th><th>Tool</th><th>Alert</th><th class="hide-sm">Severity</th><th class="hide-sm">Repository</th><th>By</th><th>Reason</th></tr></thead>
      <tbody>${shown.map((i) => `<tr>
        <td class="small" data-tip="${esc(esc(dateStr(i.at)))}">${rel(i.at)}</td>
        <td class="small"><span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap"><i class="sw ${TOOL[i.tool]?.[0]}"></i>${esc(TOOL[i.tool]?.[2] || i.tool)}</span></td>
        <td><div class="trunc"><a href="${href(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div></td>
        <td class="hide-sm"><span class="sev ${esc(i.severity || '')}">${esc(i.severity || '—')}</span></td>
        <td class="hide-sm mono">${esc(i.repo)}</td>
        <td>${esc(i.by || '—')}</td>
        <td class="small"${i.comment ? ` data-tip="${esc('“' + esc(i.comment) + '”')}"` : ''}>${esc(reasonLabel(i.reason))}${i.comment ? ' <span class="muted">💬</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No dismissals match</td></tr>'}</tbody></table></div>
    ${items.length > LIMIT ? `<button class="link-btn" type="button" data-more="ghas">${ui.expanded.ghas ? 'Show fewer' : `Show all ${fmt.format(items.length)}`}</button>` : ''}`;

  const tools = d.tools.filter((t) => TOOL[t]);
  dailyChart($('#ghas-chart'), items, (i) => i.at, ui.ghasWin, (xs) => tools.map((t) => ({ v: xs.filter((x) => x.tool === t).length, cls: TOOL[t][1], name: TOOL[t][2] })));
}
RENDER.ghas = renderGhas;

/* ---------- Sonar ---------- */
function renderSonar() {
  const g = sectionGuard('sonar', '#sec-sonar', '#sonar-body');
  if (!g) { $('#sonar-open').hidden = true; return; }
  const d = g.data;
  $('#sonar-open').hidden = false;
  $('#sonar-open').href = d.url;
  const val = (x) => (x?.err ? `<div class="m-val na" data-tip="${esc(esc(x.err))}">n/a</div>` : `<div class="m-val">${x?.v == null ? '—' : fmt.format(x.v)}</div>`);
  const orgs = d.orgs.map((o) => `<div style="margin-bottom:14px">
      <div class="sub-h" style="margin:6px 0 8px"><h3 style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--text)"><a href="${href(o.url)}" target="_blank" rel="noopener">${esc(o.key)}</a></h3></div>
      <div class="minis" style="margin-bottom:0">
        <div class="mini"><div class="m-label">Projects</div>${val(o.projects)}</div>
        <div class="mini"><div class="m-label">Not analyzed · ${d.staleDays}d</div>${val(o.stale)}</div>
        <div class="mini"><div class="m-label">Never analyzed</div>${val(o.neverAnalyzed)}</div>
        <div class="mini"><div class="m-label">Failing quality gate</div>${val(o.failingGate)}</div>
      </div></div>`).join('') || '<div class="empty">No organizations visible to this token.</div>';

  const toks = (d.tokens || []).map((t) => {
    const left = t.expirationDate ? Date.parse(t.expirationDate) - now : null;
    const lvl = left == null ? null : left < 3 * D ? 'critical' : left < d.tokenExpiryWarnDays * D ? 'warn' : null;
    return `<tr><td class="mono">${esc(t.name)}</td><td>${rel(t.lastConnectionDate)}</td><td>${rel(t.createdAt)}</td>
      <td class="r">${t.expirationDate ? `${lvl ? `<span class="lvl ${lvl}">${ICON[lvl]}` : '<span>'}${left < 0 ? 'expired' : rel(t.expirationDate)}</span>` : '<span class="muted">no expiry</span>'}</td></tr>`;
  }).join('');

  const cell = (x) => (x?.err ? `n/a (${x.err})` : x?.v);
  EXPORT.sonar = () => ({
    name: 'sonar-orgs',
    rows: d.orgs,
    columns: [['Organization', (o) => o.key], ['Projects', (o) => cell(o.projects)], [`Not analyzed in ${d.staleDays}d`, (o) => cell(o.stale)],
      ['Never analyzed', (o) => cell(o.neverAnalyzed)], ['Failing quality gate', (o) => cell(o.failingGate)], ['URL', (o) => o.url]],
  });
  EXPORT['sonar-tokens'] = () => ({
    name: 'sonar-tokens',
    rows: d.tokens || [],
    columns: [['Name', (t) => t.name], ['Last used', (t) => t.lastConnectionDate], ['Created', (t) => t.createdAt], ['Expires', (t) => t.expirationDate]],
  });
  $('#sonar-body').innerHTML = `${g.banner}<div class="sub-h" style="margin-top:0"><h3>Organizations</h3>${d.orgs.length ? exportBtn('sonar') : ''}</div>${orgs}
    ${d.tokens ? `<div class="sub-h"><h3>Tokens on this account</h3>${d.tokens.length ? exportBtn('sonar-tokens') : ''}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Last used</th><th>Created</th><th class="r">Expires</th></tr></thead>
    <tbody>${toks || '<tr><td colspan="4" class="empty">None</td></tr>'}</tbody></table></div>` : ''}`;
}

/* ---------- plugins ---------- */
function pluginCell(col, row) {
  const v = row[col.key];
  return v == null || v === '' ? '<span class="muted">—</span>' : COLUMN_TYPES[col.type].cell(v, col, row);
}

function pluginSection(id) {
  let sec = document.querySelector(`section[data-panel-id="${CSS.escape(id)}"]`);
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'card plugin';
    sec.dataset.panelId = id;
    sec.innerHTML = '<div class="section-head"><h2></h2><span class="tag">Plugin</span></div><div class="plugin-body"></div>';
    $('#view-dashboard').insertBefore(sec, $('#footer'));
  }
  return sec;
}

function renderPlugin(id) {
  const src = snap.sources[pluginKey(id)];
  if (!src) return;
  const sec = pluginSection(id);
  sec.querySelector('h2').textContent = src.title || id;
  const body = sec.querySelector('.plugin-body');
  if (!src.data) {
    body.innerHTML = src.error ? `<div class="alert err"><b>Couldn't load.</b> ${esc(src.error)}</div>` : '<div class="skeleton"></div>';
    return;
  }
  const d = src.data;
  let html = src.error ? `<div class="alert warn">Showing data from ${rel(src.fetchedAt)} — last refresh failed: ${esc(src.error)}</div>` : '';
  if (d.metrics.length) {
    html += `<div class="minis">${d.metrics.map((m) => `<div class="mini${m.level ? ` lvl-${esc(m.level)}` : ''}"${m.hint ? ` data-tip="${esc(esc(m.hint))}"` : ''}>
      <div class="m-label">${esc(m.label)}</div><div class="m-val">${typeof m.value === 'number' ? fmt.format(m.value) : esc(m.value)}</div></div>`).join('')}</div>`;
  }
  let rows = [];
  if (d.table) {
    const cols = d.table.columns;
    FACETS[id] = Object.fromEntries(cols.filter((c) => c.facet).map((c) => [c.key, { label: c.label, get: (r) => r[c.key] ?? '—' }]));
    SEARCH[id] = (r) => cols.map((c) => r[c.key] ?? '').join(' ');
    const sortCol = cols.find((c) => c.key === ui.sort[id]?.key);
    rows = applyFilters(id, d.table.rows);
    if (sortCol) rows = sortRows(rows, sortCol, ui.sort[id].dir);
    EXPORT[id] = () => ({ name: id, rows, columns: cols.map((c) => [c.label, (r) => r[c.key]]) });

    if (d.chart) html += `<h3>${esc(d.chart.title || 'Per day')}</h3><div class="chart plugin-chart"></div>`;
    const facetCols = cols.filter((c) => c.facet);
    if (facetCols.length) html += `<div class="grid-4 breakdowns">${facetCols.map((c) => `<div><h3>${esc(c.label)}</h3>${facetBars(id, c.key, d.table.rows)}</div>`).join('')}</div>`;

    const LIMIT = 25;
    const shown = ui.expanded[id] ? rows : rows.slice(0, LIMIT);
    html += `${filterBar(id, rows.length, 'row')}${d.table.truncated ? '<div class="muted small rules-note">Showing the first 5,000 rows returned by the plugin.</div>' : ''}
      <div class="tbl-wrap"><table>
        <thead><tr>${cols.map((c) => `<th class="sortable ${COLUMN_TYPES[c.type].align || ''}" data-sort="${esc(c.key)}">${esc(c.label)}${sortArrow(id, c.key)}</th>`).join('')}</tr></thead>
        <tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td class="${COLUMN_TYPES[c.type].align ? 'r num' : ''}">${pluginCell(c, r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">No rows match</td></tr>`}</tbody>
      </table></div>
      ${rows.length > LIMIT ? `<button class="link-btn" type="button" data-more="${esc(id)}">${ui.expanded[id] ? 'Show fewer' : `Show all ${fmt.format(rows.length)}`}</button>` : ''}`;
  }
  body.innerHTML = html || '<div class="empty">This plugin returned no metrics or table.</div>';

  if (d.chart) dailyChart(body.querySelector('.plugin-chart'), rows, (r) => r[d.chart.key], d.chart.days, (xs) => [{ v: xs.length, cls: 'f-s1', name: 'Rows' }]);
  bindSort(body, id, () => renderPlugin(id));
  RENDER[id] = () => renderPlugin(id);
}

function renderPlugins() {
  const ids = Object.keys(snap.sources).map(pluginIdOf).filter(Boolean);
  document.querySelectorAll('section.plugin').forEach((s) => { if (!ids.includes(s.dataset.panelId)) s.remove(); });
  ids.forEach(renderPlugin);
}

/* ---------- loop ---------- */
let scrolledToFocus = false;
function renderAll() {
  if (!snap) return;
  now = Date.now();
  renderShell();
  renderFeed();
  renderKpis();
  renderActions();
  renderJira();
  renderGhas();
  renderSonar();
  renderPlugins();
  applyLayout();
  if (!scrolledToFocus && ui.focus && snap.lastRefreshAt) {
    scrolledToFocus = true;
    const sec = document.querySelector(`[data-panel-id="${CSS.escape(ui.focus)}"]`);
    if (sec) sec.scrollIntoView();
  }
}

let lastKey = '';
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try {
    // The status is small; the snapshot is fetched and rendered only when something changed,
    // which also keeps scroll position and input focus stable.
    const st = await (await fetch('/api/status', { cache: 'no-store' })).json();
    const key = `${st.revision}|${st.authKey}`;
    if (!snap || key !== lastKey) {
      snap = await (await fetch('/api/snapshot', { cache: 'no-store' })).json();
      lastKey = key;
      renderAll();
    } else {
      Object.assign(snap, { refreshing: st.refreshing, lastRefreshAt: st.lastRefreshAt, nextRefreshAt: st.nextRefreshAt });
      now = Date.now();
      renderShell();
    }
  } catch {
    $('#updated').textContent = 'Server unreachable — is opspulse still running?';
  }
  pollTimer = setTimeout(poll, snap?.refreshing || snap?.auth?.device ? 1500 : 5000);
}

$('#refresh').onclick = async () => {
  $('#refresh').classList.add('spin');
  await fetch('/api/refresh', { method: 'POST', headers: { 'X-OpsPulse': '1' } }).catch(() => {});
  setTimeout(poll, 300);
};
$('#theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.set('theme', next);
};
let rt;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderAll, 150); });

// After every script has loaded (admin.js comes after this file), so a #/admin link works directly.
addEventListener('DOMContentLoaded', () => {
  if (!route()) readHash();
  poll();
});
