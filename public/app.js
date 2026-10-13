'use strict';
/* opspulse front end — plain JS, no build step. Everything rendered here comes from
   /api/snapshot; ticket titles, comments etc. are user-generated, so ALL text goes through esc(). */

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
  org: store.get('org', '__all'),
  jiraStatus: null,
  jiraQuery: '',
  jiraSort: store.get('jiraSort', { key: 'updated', dir: -1 }),
  jiraAll: false,
  ghasAll: false,
  feedAll: false,
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
// GitHub spells dismissal reasons differently per tool ("won't fix" vs "wont_fix"); fold them together.
const reasonLabel = (r) => { const k = String(r || 'unspecified').toLowerCase().replace(/[_\s]+/g, ' ').replace("won't", 'wont').trim(); return k === 'wont fix' ? "Won't fix" : pretty(k); };

/* ---------- icons (status always ships with icon + label) ---------- */
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
  tip.innerHTML = t.getAttribute('data-tip'); // data-tip values are built from esc()'d text
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
// Horizontal bars. rows: [{ label, v, cls, key?, tip? }]
function hbars(rows, { max, clickable, active } = {}) {
  if (!rows.length) return '<div class="empty small">Nothing in this window</div>';
  const m = max || Math.max(...rows.map((r) => r.v), 1);
  return `<div class="hbars">${rows
    .map((r) => `<div class="hbar${clickable ? ' clickable' : ''}${active && active === r.key ? ' active' : ''}" ${clickable ? `data-key="${esc(r.key)}" role="button" tabindex="0"` : ''} data-tip="${esc(`<b>${esc(r.label)}</b><br>${fmt.format(r.v)}${r.tip ? '<br>' + esc(r.tip) : ''}`)}">
        <span class="hb-label">${esc(r.label)}</span>
        <span class="hb-track"><span class="hb-fill ${r.cls || 'bg-s1'}" style="width:${(r.v / m) * 100}%;display:block"></span></span>
        <span class="hb-val">${fmt.format(r.v)}</span></div>`)
    .join('')}</div>`;
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

/* ---------- shell ---------- */
function sourceState(key) {
  const s = snap.sources[key];
  if (!s || s.status === 'disabled') return null;
  if (s.status === 'refreshing' || s.status === 'pending') return { cls: 'busy', text: 'refreshing…' };
  if (s.error) return { cls: s.data ? 'stale' : 'err', text: s.error };
  if (s.status === 'cached') return { cls: 'stale', text: 'from cache' };
  return { cls: 'ok', text: `updated ${rel(s.fetchedAt)} · ${(s.durationMs / 1000).toFixed(1)}s` };
}

function renderShell() {
  $('#demo-tag').hidden = !snap.demo;
  const names = { actions: 'Actions', jira: 'Jira', dismissals: 'GHAS', sonar: 'Sonar' };
  const a = snap.auth || {};
  let chips = Object.entries(names)
    .map(([k, n]) => { const st = sourceState(k); return st ? `<span class="chip" data-tip="${esc(`<b>${n}</b><br>${esc(st.text)}`)}"><i class="dot ${st.cls}"></i>${n}</span>` : ''; })
    .join('');
  if (a.enabled) {
    const st = a.signedIn ? { cls: 'ok', text: `signed in as ${a.user || 'unknown'} via ${a.method}` } : a.device ? { cls: 'busy', text: 'waiting for device sign-in' } : a.needsLogin ? { cls: 'stale', text: 'sign-in required' } : a.error ? { cls: 'err', text: a.error } : { cls: '', text: 'not connected yet' };
    chips += `<span class="chip" data-tip="${esc(`<b>Key Vault · ${esc(a.vault)}</b><br>${esc(st.text)}`)}"><i class="dot ${st.cls}"></i>Key Vault</span>`;
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

const post = (path) => fetch(path, { method: 'POST', headers: { 'X-OpsPulse': '1' } }).then((r) => r.json()).catch(() => null);
async function startDevice() {
  const b = $('#device-start'); if (b) { b.disabled = true; b.textContent = 'Requesting code…'; }
  const r = await post('/api/auth/device');
  if (!r || r.error) { if (b) { b.disabled = false; b.textContent = 'Use a device code'; } alert(r?.error || 'Could not start device sign-in'); return; }
  poll();
}

function renderFeed() {
  const items = snap.feed;
  const crit = items.filter((i) => i.level === 'critical').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  $('#feed-summary').textContent = items.length ? [crit && `${crit} critical`, warn && plural(warn, 'warning'), items.length - crit - warn && `${items.length - crit - warn} info`].filter(Boolean).join(' · ') : '';
  if (!snap.lastRefreshAt && !items.length) { $('#feed').innerHTML = '<div class="skeleton" style="height:56px"></div>'; return; }
  if (!items.length) {
    $('#feed').innerHTML = `<div class="feed-empty"><span class="lvl good">${ICON.good} All clear</span><span>Nothing needs attention right now.</span></div>`;
    return;
  }
  const LIMIT = 6;
  const shown = ui.feedAll ? items : items.slice(0, LIMIT);
  $('#feed').innerHTML =
    shown.map((i) => `<div class="feed-item ${i.level}">
        <span class="lvl ${i.level}">${ICON[i.level]}${LEVEL_LABEL[i.level]}</span>
        <div><div class="fi-title">${esc(i.title)}</div>${i.detail ? `<div class="fi-detail">${esc(i.detail)}</div>` : ''}</div>
        <span class="src-tag">${esc(SRC_LABEL[i.source] || i.source)}</span>
        ${i.url ? `<a class="small" href="${href(i.url)}" target="_blank" rel="noopener">Open ↗</a>` : '<span></span>'}
      </div>`).join('') +
    (items.length > LIMIT ? `<button class="link-btn feed-more" id="feed-toggle">${ui.feedAll ? 'Show fewer' : `Show all ${items.length}`}</button>` : '');
  const t = $('#feed-toggle');
  if (t) t.onclick = () => { ui.feedAll = !ui.feedAll; renderFeed(); };
}

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
    tiles.push(kpi(`Job runs · ${winLabel(ui.win)}`, fmt.format(a.runs), a.fails ? `<span class="bad">${plural(a.fails, 'failure')}</span> · ${pct}% of runs` : 'no failures'));
    tiles.push(kpi('Workflows failing', `${a.failing}<small> / ${a.total}</small>`, a.failing ? 'latest run failed' : a.late ? `<span class="bad" style="color:var(--warn-ink)">${a.late} overdue</span>` : `all passing${a.running ? ` · ${a.running} running` : ''}`));
  }
  const j = snap.sources.jira?.data;
  if (j) {
    const open = j.issues.filter((i) => i.category !== 'done');
    const wk = j.issues.filter((i) => now - Date.parse(i.created) <= 7 * D).length;
    const un = open.filter((i) => !i.assignee).length;
    tiles.push(kpi('Open tickets', fmt.format(open.length), `+${wk} new in 7d${un ? ` · <span class="bad">${un} unassigned</span>` : ''}`));
  }
  const g = snap.sources.dismissals?.data;
  if (g) {
    const n = g.orgs.reduce((s, o) => s + o.items.filter((i) => now - Date.parse(i.at) <= ui.ghasWin * D).length, 0);
    tiles.push(kpi(`GHAS dismissals · ${ui.ghasWin}d`, fmt.format(n), `across ${plural(g.orgs.length, 'org')}`));
  }
  const s = snap.sources.sonar?.data;
  if (s) {
    const sum = (k) => s.orgs.reduce((t, o) => t + (o[k]?.v || 0), 0);
    tiles.push(kpi('Sonar projects', fmt.format(sum('projects')), `${fmt.format(sum('stale'))} not analyzed in ${s.staleDays}d`));
  }
  $('#kpis').innerHTML = tiles.join('');
  $('#kpis').hidden = !tiles.length;
}
const kpi = (label, val, sub) => `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-val">${val}</div><div class="k-sub">${sub}</div></div>`;

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

function renderActions() {
  const g = sectionGuard('actions', '#sec-actions', '#actions-body');
  const opts = [24, 72, 168].filter((h) => h <= (snap.sources.actions?.data?.lookbackHours || 168)).map((h) => [h, winLabel(h)]);
  seg($('#win'), opts, ui.win, (v) => { ui.win = v; store.set('win', v); renderAll(); });
  if (!g) return;
  const d = g.data;
  const since = now - ui.win * H;
  const stepH = ui.win <= 24 ? 1 : ui.win <= 72 ? 3 : 6;
  const st = actionsStats(ui.win);

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

  $('#actions-body').innerHTML = `${g.banner}
    <div class="sub-h" style="margin-top:0"><h3>Runs over time · all workflows</h3><span class="muted small">${fmt.format(st.runs)} runs in ${winLabel(ui.win)}</span></div>
    ${legend([['bg-good', 'Succeeded'], ['bg-crit', 'Failed'], ['bg-neutral', 'Cancelled / other']])}
    <div class="chart" id="act-chart"></div>
    <div class="sub-h"><h3>Workflows</h3><span class="muted small">recent runs: oldest → newest</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Status</th><th>Workflow</th><th class="hide-sm">Recent runs</th><th class="r">Success · ${winLabel(ui.win)}</th><th class="r">Failed / runs</th><th class="r">Last run</th><th class="r hide-sm">Median time</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;

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

function renderJira() {
  const g = sectionGuard('jira', '#sec-jira', '#jira-body');
  if (!g) { $('#jira-open').hidden = true; return; }
  const d = g.data;
  $('#jira-open').hidden = false;
  $('#jira-open').href = d.searchUrl;
  const open = d.issues.filter((i) => i.category !== 'done');
  const stale = open.filter((i) => now - Date.parse(i.updated) > d.staleDays * D);
  const un = open.filter((i) => !i.assignee);
  const ages = open.map((i) => now - Date.parse(i.created));
  const resolved = d.issues.filter((i) => i.resolved && now - Date.parse(i.resolved) <= d.lookbackDays * D).length;
  const medAge = median(ages);

  const minis = [
    ['Open', open.length], ['In progress', open.filter((i) => i.category === 'indeterminate').length], ['Unassigned', un.length],
    [`Stale · ${d.staleDays}d+`, stale.length], ['Median open age', medAge == null ? '—' : `${Math.round(medAge / D)}d`], [`Resolved · ${d.lookbackDays}d`, resolved],
  ].map(([l, v]) => `<div class="mini"><div class="m-label">${esc(l)}</div><div class="m-val">${typeof v === 'number' ? fmt.format(v) : v}</div></div>`).join('');

  const order = { new: 0, indeterminate: 1, done: 2 };
  const statuses = countBy(d.issues, (i) => i.status).map(([s, v]) => {
    const cat = d.issues.find((i) => i.status === s).category;
    return { label: s, key: s, v, cls: CAT[cat]?.[0] || 'bg-neutral', tip: CAT[cat]?.[1], cat };
  }).sort((a, b) => order[a.cat] - order[b.cat] || b.v - a.v);

  let list = d.issues;
  if (ui.jiraStatus) list = list.filter((i) => i.status === ui.jiraStatus);
  if (ui.jiraQuery) { const q = ui.jiraQuery.toLowerCase(); list = list.filter((i) => `${i.key} ${i.summary} ${i.assignee || ''} ${i.reporter || ''}`.toLowerCase().includes(q)); }
  const { key: sk, dir } = ui.jiraSort;
  list = [...list].sort((a, b) => {
    const va = a[sk] ?? '', vb = b[sk] ?? '';
    return (sk === 'created' || sk === 'updated' ? Date.parse(va) - Date.parse(vb) : String(va).localeCompare(String(vb))) * dir;
  });
  const LIMIT = 25;
  const shown = ui.jiraAll ? list : list.slice(0, LIMIT);
  const arrow = (k) => (sk === k ? (dir > 0 ? ' ↑' : ' ↓') : '');

  $('#jira-body').innerHTML = `${g.banner}${d.truncated ? '<div class="alert warn">Result capped by <code>jira.maxIssues</code>; numbers cover the first page set only.</div>' : ''}
    <div class="minis">${minis}</div>
    <div class="grid-2">
      <div><h3>By status <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· click to filter</span></h3>
        ${legend(Object.values(CAT))}${hbars(statuses, { clickable: true, active: ui.jiraStatus })}</div>
      <div><h3>Created per day · ${d.lookbackDays}d</h3><div class="chart" id="jira-chart"></div></div>
    </div>
    <div class="toolbar">
      <input class="input" id="jira-q" type="search" placeholder="Filter by key, summary, person…" value="${esc(ui.jiraQuery)}" aria-label="Filter tickets">
      ${ui.jiraStatus ? `<span class="filter-pill">Status: ${esc(ui.jiraStatus)}<button id="jira-clear" aria-label="Clear status filter">×</button></span>` : ''}
      <span class="muted small">${plural(list.length, 'ticket')}</span>
    </div>
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
    ${list.length > LIMIT ? `<button class="link-btn" id="jira-more">${ui.jiraAll ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`;

  const days = d.lookbackDays;
  const from = new Date(now - (days - 1) * D); from.setHours(0, 0, 0, 0);
  const b = bucketize(d.issues, (i) => i.created, from.getTime(), from.getTime() + days * D, D, (xs) => [{ v: xs.length, cls: 'f-s1', name: 'Created' }]).map((x) => ({ ...x, label: dayStr(x.t0) }));
  columns($('#jira-chart'), b, { height: 170 });

  const body = $('#jira-body');
  body.querySelectorAll('.hbar.clickable').forEach((el) => {
    const pick = () => { ui.jiraStatus = ui.jiraStatus === el.dataset.key ? null : el.dataset.key; ui.jiraAll = false; renderJira(); };
    el.onclick = pick;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  const q = $('#jira-q');
  q.oninput = () => { ui.jiraQuery = q.value; const pos = q.selectionStart; renderJira(); const n = $('#jira-q'); n.focus(); n.setSelectionRange(pos, pos); };
  const c = $('#jira-clear'); if (c) c.onclick = () => { ui.jiraStatus = null; renderJira(); };
  const m = $('#jira-more'); if (m) m.onclick = () => { ui.jiraAll = !ui.jiraAll; renderJira(); };
  body.querySelectorAll('th.sortable').forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    ui.jiraSort = { key: k, dir: ui.jiraSort.key === k ? -ui.jiraSort.dir : -1 };
    store.set('jiraSort', ui.jiraSort);
    renderJira();
  }));
}

/* ---------- GHAS ---------- */
const TOOL = { 'code-scanning': ['bg-s1', 'f-s1', 'Code scanning'], 'secret-scanning': ['bg-s2', 'f-s2', 'Secret scanning'], dependabot: ['bg-s3', 'f-s3', 'Dependabot'] };

function renderGhas() {
  const g = sectionGuard('dismissals', '#sec-ghas', '#ghas-body');
  const lb = snap.sources.dismissals?.data?.lookbackDays || 30;
  const opts = [7, 14, 30, 90].filter((x) => x <= lb).map((x) => [x, `${x}d`]);
  if (ui.ghasWin > lb) ui.ghasWin = lb;
  seg($('#ghas-win'), opts, ui.ghasWin, (v) => { ui.ghasWin = v; store.set('ghasWin', v); renderAll(); });
  if (!g) return;
  const d = g.data;
  const since = now - ui.ghasWin * D;
  const orgs = d.orgs.map((o) => ({ ...o, win: o.items.filter((i) => Date.parse(i.at) >= since) }));
  if (ui.org !== '__all' && !orgs.some((o) => o.org === ui.org)) ui.org = '__all';
  const items = ui.org === '__all' ? orgs.flatMap((o) => o.win) : orgs.find((o) => o.org === ui.org).win;
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const sel = ui.org === '__all' ? orgs : orgs.filter((o) => o.org === ui.org);
  const errs = sel.flatMap((o) => Object.entries(o.errors).map(([t, e]) => `${o.org} · ${TOOL[t]?.[2] || t}: ${e}`));

  const tabs = orgs.length > 1
    ? `<div class="tabs" role="tablist">${[['__all', 'All orgs', items.length && orgs.reduce((s, o) => s + o.win.length, 0)], ...orgs.map((o) => [o.org, o.org, o.win.length])]
        .map(([k, l, n]) => `<button role="tab" data-org="${esc(k)}" aria-selected="${ui.org === k}">${esc(l)}<span class="count">${fmt.format(k === '__all' ? orgs.reduce((s, o) => s + o.win.length, 0) : n)}</span></button>`).join('')}</div>`
    : '';

  const minis = d.tools.filter((t) => TOOL[t]).map((t) => {
    const n = items.filter((i) => i.tool === t).length;
    const failed = sel.some((o) => o.errors[t]);
    return `<div class="mini"><div class="m-label"><i class="sw ${TOOL[t][0]}"></i>${TOOL[t][2]}</div><div class="m-val${failed ? ' na' : ''}">${failed ? 'n/a' : fmt.format(n)}</div></div>`;
  }).join('');
  const total = `<div class="mini"><div class="m-label">Total dismissed · ${ui.ghasWin}d</div><div class="m-val">${fmt.format(items.length)}</div></div>`;

  const reasons = countBy(items, (i) => reasonLabel(i.reason)).slice(0, 8).map(([label, v]) => ({ label, v }));
  const people = countBy(items, (i) => i.by || 'unknown').slice(0, 8).map(([label, v]) => ({ label, v }));
  const repos = countBy(items, (i) => i.repo).slice(0, 8).map(([label, v]) => ({ label, v }));
  const LIMIT = 15;
  const shown = ui.ghasAll ? items : items.slice(0, LIMIT);

  $('#ghas-body').innerHTML = `${g.banner}${tabs}
    ${errs.length ? `<div class="alert warn">${errs.map(esc).join('<br>')}</div>` : ''}
    ${sel.some((o) => o.truncated.length) ? '<div class="alert warn">Some results hit <code>maxPagesPerTool</code>; counts may be low.</div>' : ''}
    <div class="minis">${total}${minis}</div>
    <h3>Dismissals per day</h3>
    ${legend(d.tools.filter((t) => TOOL[t]).map((t) => [TOOL[t][0], TOOL[t][2]]))}
    <div class="chart" id="ghas-chart"></div>
    <div class="grid-3" style="margin-top:22px">
      <div><h3>Reason</h3>${hbars(reasons)}</div>
      <div><h3>Dismissed by</h3>${hbars(people)}</div>
      <div><h3>Repository</h3>${hbars(repos)}</div>
    </div>
    <div class="sub-h"><h3>Recent dismissals</h3><span class="muted small">${plural(items.length, 'alert')}</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>When</th><th>Tool</th><th>Alert</th><th class="hide-sm">Severity</th><th class="hide-sm">Repository</th><th>By</th><th>Reason</th></tr></thead>
      <tbody>${shown.map((i) => `<tr>
        <td class="small" data-tip="${esc(esc(dateStr(i.at)))}">${rel(i.at)}</td>
        <td class="small"><span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap"><i class="sw ${TOOL[i.tool]?.[0]}"></i>${esc(TOOL[i.tool]?.[2] || i.tool)}</span></td>
        <td><div class="trunc"><a href="${href(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div></td>
        <td class="hide-sm"><span class="sev ${esc(i.severity || '')}">${esc(i.severity || '—')}</span></td>
        <td class="hide-sm mono">${esc(i.repo)}</td>
        <td>${esc(i.by || '—')}</td>
        <td class="small"${i.comment ? ` data-tip="${esc('“' + esc(i.comment) + '”')}"` : ''}>${esc(reasonLabel(i.reason))}${i.comment ? ' <span class="muted">💬</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No dismissals in this window</td></tr>'}</tbody></table></div>
    ${items.length > LIMIT ? `<button class="link-btn" id="ghas-more">${ui.ghasAll ? 'Show fewer' : `Show all ${items.length}`}</button>` : ''}`;

  const from = new Date(now - (ui.ghasWin - 1) * D); from.setHours(0, 0, 0, 0);
  const tools = d.tools.filter((t) => TOOL[t]);
  const b = bucketize(items, (i) => i.at, from.getTime(), from.getTime() + ui.ghasWin * D, D, (xs) => tools.map((t) => ({ v: xs.filter((x) => x.tool === t).length, cls: TOOL[t][1], name: TOOL[t][2] }))).map((x) => ({ ...x, label: dayStr(x.t0) }));
  columns($('#ghas-chart'), b, { height: 150 });

  $('#ghas-body').querySelectorAll('[data-org]').forEach((el) => (el.onclick = () => { ui.org = el.dataset.org; store.set('org', ui.org); ui.ghasAll = false; renderGhas(); }));
  const m = $('#ghas-more'); if (m) m.onclick = () => { ui.ghasAll = !ui.ghasAll; renderGhas(); };
}

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

  $('#sonar-body').innerHTML = `${g.banner}${orgs}
    ${d.tokens ? `<div class="sub-h"><h3>Tokens on this account</h3></div>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Last used</th><th>Created</th><th class="r">Expires</th></tr></thead>
    <tbody>${toks || '<tr><td colspan="4" class="empty">None</td></tr>'}</tbody></table></div>` : ''}`;
}

/* ---------- loop ---------- */
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
}

let lastKey = '';
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    snap = await res.json();
    // Only re-render data sections when data actually changed (keeps scroll + input focus stable).
    const key = JSON.stringify([snap.lastRefreshAt, snap.refreshing, snap.auth?.signedIn, snap.auth?.needsLogin, snap.auth?.device?.userCode, snap.auth?.error, Object.values(snap.sources).map((s) => [s.status, s.fetchedAt, s.error])]);
    if (key !== lastKey) { lastKey = key; renderAll(); } else { now = Date.now(); renderShell(); }
  } catch {
    $('#updated').textContent = 'Server unreachable — is opspulse still running?';
  }
  pollTimer = setTimeout(poll, snap?.refreshing || snap?.auth?.device ? 1500 : 15000);
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

poll();
