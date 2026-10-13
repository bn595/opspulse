// View logic shared by the browser (window.OpsView) and the test suite (require).
//   panel  { facets: { name: { get(item) } }, filters: { name: value }, query, search(item) -> text }
//   state  { win?, ghasWin?, filters: { panel: { facet: value } }, queries: { panel: text }, focus? }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpsView = api;
})(this, function () {
  'use strict';

  function filterItems(items, panel, except) {
    const facets = panel.facets || {};
    const active = Object.entries(panel.filters || {}).filter(([k]) => k !== except && facets[k]);
    const q = (panel.query || '').trim().toLowerCase();
    return items.filter((i) =>
      active.every(([k, v]) => String(facets[k].get(i)) === v) &&
      (!q || !panel.search || panel.search(i).toLowerCase().includes(q)));
  }

  // Counts per value of one facet, computed with every other filter applied.
  // Returns { rows: [{ key, count }] (descending, or by `sort`), more }; the active value stays visible.
  function breakdown(items, panel, facet, { limit = 8, sort } = {}) {
    const get = panel.facets[facet].get;
    const counts = new Map();
    for (const i of filterItems(items, panel, facet)) {
      const k = get(i);
      if (k != null) counts.set(String(k), (counts.get(String(k)) || 0) + 1);
    }
    let rows = [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
    if (sort) rows.sort(sort);
    const more = Math.max(0, rows.length - limit);
    if (more) {
      const active = panel.filters?.[facet];
      const top = rows.slice(0, limit);
      const keep = active != null && !top.some((r) => r.key === active) && rows.find((r) => r.key === active);
      rows = keep ? [...top, keep] : top;
    }
    return { rows, more };
  }

  // Hash format: win, ghas.win, <panel>.<facet>, <panel>.q, at=<panel>
  function encodeState(state) {
    const p = new URLSearchParams();
    if (state.win != null) p.set('win', state.win);
    if (state.ghasWin != null) p.set('ghas.win', state.ghasWin);
    for (const [panel, f] of Object.entries(state.filters || {})) for (const [k, v] of Object.entries(f)) p.set(`${panel}.${k}`, v);
    for (const [panel, q] of Object.entries(state.queries || {})) if (q) p.set(`${panel}.q`, q);
    if (state.focus) p.set('at', state.focus);
    return p.toString();
  }

  function decodeState(hash) {
    const state = { filters: {}, queries: {} };
    for (const [k, v] of new URLSearchParams(String(hash).replace(/^#/, ''))) {
      if (k === 'win' || k === 'ghas.win') {
        const n = Number(v);
        if (n > 0) state[k === 'win' ? 'win' : 'ghasWin'] = n;
      } else if (k === 'at') state.focus = v;
      else {
        const dot = k.indexOf('.');
        if (dot < 1) continue;
        const panel = k.slice(0, dot), facet = k.slice(dot + 1);
        if (facet === 'q') state.queries[panel] = v;
        else (state.filters[panel] ||= {})[facet] = v;
      }
    }
    return state;
  }

  // Text cells starting with = + - @ are prefixed so spreadsheet apps treat them as text, not formulas.
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  }
  // columns: [[header, row => value]]
  function toCsv(columns, rows) {
    return [columns.map((c) => csvCell(c[0])).join(','), ...rows.map((r) => columns.map((c) => csvCell(c[1](r))).join(','))].join('\r\n');
  }

  // Display order of panels. layout: { panels: [id] listed first, hide: [id] removed }.
  function panelOrder(available, layout) {
    const hide = new Set(layout?.hide || []);
    const listed = (layout?.panels || []).filter((id, i, a) => available.includes(id) && a.indexOf(id) === i);
    return [...listed, ...available.filter((id) => !listed.includes(id))].filter((id) => !hide.has(id));
  }

  return { filterItems, breakdown, encodeState, decodeState, toCsv, panelOrder };
});
