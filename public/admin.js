'use strict';
// Admin view: SonarQube Cloud bulk tools. Flow per tool: form -> preview (server keeps it) -> select
// rows -> confirm -> apply in the background -> live per-row results. Uses helpers from app.js.

const Admin = (() => {
  const TOOLS = {
    drift: { label: 'Name drift', select: false, pattern: false, branch: false, verb: 'Update keys', noun: 'project key',
      intro: 'Finds projects whose key no longer follows their repository, usually because the repository was renamed. The new key keeps everything up to the first underscore and adds the name of the bound repository (or the project name, for projects not bound to one).',
      warn: 'Pipelines that still pass the old sonar.projectKey will fail until they use the new key.' },
    keys: { label: 'Project keys', select: true, pattern: false, branch: false, verb: 'Update keys', noun: 'project key',
      intro: 'Updates the keys of selected projects to follow their repository. The new key keeps everything up to the first underscore and adds the name of the bound repository (or the project name, for projects not bound to one).',
      warn: 'Pipelines that still pass the old sonar.projectKey will fail until they use the new key.' },
    pattern: { label: 'Long-lived branch pattern', select: true, pattern: true, branch: false, verb: 'Set pattern', noun: 'project',
      intro: 'Sets sonar.branch.longLivedBranches.regex on selected projects. It only affects branches analyzed for the first time after the change.' },
    delete: { label: 'Delete branch', select: true, pattern: false, branch: true, verb: 'Delete branch', noun: 'project', typeToConfirm: true,
      intro: 'Deletes one branch from selected projects. Main branches are never deleted.',
      warn: 'Deleting a branch removes its analysis history. This cannot be undone.' },
    longlived: { label: 'Make branch long-lived', select: true, pattern: true, branch: true, verb: 'Make long-lived', noun: 'project', typeToConfirm: true,
      intro: 'Sets the long-lived pattern, then deletes the branch where it exists as short-lived, so its next analysis recreates it as long-lived.',
      warn: 'Where the branch is deleted, its analysis history is removed. This cannot be undone.' },
  };
  const STATUS = {
    change: ['Will change', 'pill-act'], delete: ['Will delete', 'pill-act'], unchanged: ['Already correct', 'pill-muted'], missing: ['Branch not found', 'pill-muted'],
    conflict: ['Target key exists', 'pill-warn'], invalid: ['Name is not a valid key', 'pill-warn'], unrecognized: ['Key format not recognized', 'pill-warn'],
    'not-found': ['Project not found', 'pill-warn'], main: ['Main branch', 'pill-warn'],
  };
  const RESULT = { queued: 'Queued', running: 'Running…', waiting: 'Waiting', done: 'Done', failed: 'Failed' };
  // Where a new key's name comes from (row.source), and the hint that explains the marks.
  const SOURCE = {
    repo: ['repo', '', 'From the repository this project is bound to. SonarQube Cloud updates the binding when the repository is renamed.'],
    name: ['name', 'mark-warn', 'Not bound to a repository, so the project name is used. It may not match the repository: check it before applying. Not selected by default.'],
  };
  const NAME_DIFFERS = 'The project name differs from its repository. The key follows the repository.';
  const KEY_HINT = `How the new key is chosen:
• repo: ${SOURCE.repo[2]}
• name: ${SOURCE.name[2]}
• ≠ repo, next to a project name: ${NAME_DIFFERS}`;
  const mark = (text, cls, title) => `<span class="mark ${cls}" title="${esc(title)}">${esc(text)}</span>`;

  const state = {
    tool: 'drift',
    form: { org: '', mode: 'prefix', prefix: '', keys: '', pattern: '', branch: '', test: '' },
    preview: null, // { id, tool, rows, branch }
    selected: new Set(),
    confirming: false,
    confirmText: '',
    run: null, // { id, data }
    busy: false,
    error: null,
  };
  const root = () => document.getElementById('admin-body');
  const T = () => TOOLS[state.tool];

  function patternTest() {
    const { pattern, test } = state.form;
    if (!pattern) return '';
    let rx;
    try { rx = new RegExp(`^(?:${pattern})$`); } catch (e) { return `<span class="bad">Invalid regular expression: ${esc(e.message)}</span>`; }
    if (!test) return '<span class="muted">Type a branch name to test the pattern.</span>';
    return rx.test(test) ? `<span class="ok">✓ <b>${esc(test)}</b> would be long-lived</span>` : `<span class="muted">✗ <b>${esc(test)}</b> would be short-lived</span>`;
  }

  function form() {
    const t = T(), f = state.form;
    const orgs = snap?.config?.sonar?.organizations || [];
    const hint = snap?.demo ? 'Demo organizations: acme, acme-labs' : orgs.length ? '' : 'The SonarQube Cloud organization key';
    return `<p class="admin-intro">${esc(t.intro)}</p>
      <div class="admin-form">
        <label>Organization<input class="input" data-field="org" value="${esc(f.org)}" list="admin-orgs" placeholder="${esc(orgs[0] || 'acme')}" autocomplete="off">
          <datalist id="admin-orgs">${orgs.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>${hint ? `<span class="muted small">${esc(hint)}</span>` : ''}</label>
        ${t.select ? `<fieldset class="admin-select"><legend>Projects</legend>
          <label class="radio"><input type="radio" name="admin-mode" data-field="mode" value="prefix" ${f.mode === 'prefix' ? 'checked' : ''}> Name starts with</label>
          <label class="radio"><input type="radio" name="admin-mode" data-field="mode" value="keys" ${f.mode === 'keys' ? 'checked' : ''}> List of project keys</label>
          ${f.mode === 'prefix'
            ? `<input class="input" data-field="prefix" value="${esc(f.prefix)}" placeholder="e.g. payments- (empty = every project)">`
            : `<textarea class="input" data-field="keys" rows="4" placeholder="One key per line, or separated by commas or spaces">${esc(f.keys)}</textarea>`}
        </fieldset>` : ''}
        ${t.pattern ? `<label>Long-lived branch pattern<input class="input mono" data-field="pattern" value="${esc(f.pattern)}" placeholder="e.g. (main|dev|release-.*)">
          <span class="pattern-test"><input class="input" data-field="test" value="${esc(f.test)}" placeholder="Test a branch name, e.g. dev"> <span id="admin-test">${patternTest()}</span></span></label>` : ''}
        ${t.branch ? `<label>Branch<input class="input mono" data-field="branch" value="${esc(f.branch)}" placeholder="e.g. dev"></label>` : ''}
        <div><button class="btn primary" type="button" data-admin="preview" ${state.busy ? 'disabled' : ''}>${state.busy && !state.preview ? 'Loading preview…' : 'Preview'}</button></div>
      </div>`;
  }

  function columns(tool) {
    const keyCols = [
      ['Project', (r) => `<span class="mono">${esc(r.project)}</span>`],
      ['Name', (r) => `${esc(r.name ?? '—')}${r.repo && r.name && !r.name.endsWith(r.repo) ? ` ${mark('≠ repo', '', NAME_DIFFERS)}` : ''}`],
      ['Repository', (r) => (r.repoUrl ? `<a class="mono" href="${href(r.repoUrl)}" target="_blank" rel="noopener">${esc(r.repo)} ↗</a>` : r.source === 'name' ? '<span class="muted">not bound</span>' : '—')],
      [`New key <span class="hint" title="${esc(KEY_HINT)}" tabindex="0" aria-label="${esc(KEY_HINT)}">ⓘ</span>`, (r) => (r.to ? `<span class="mono">${esc(r.to)}</span>${SOURCE[r.source] ? ` ${mark(...SOURCE[r.source])}` : ''}` : '—'), true],
    ];
    if (tool === 'pattern') return [['Project', keyCols[0][1]], ['Current pattern', (r) => `<span class="mono">${esc(r.from ?? '—')}</span>${r.inherited ? ' <span class="muted small">inherited</span>' : ''}`], ['New pattern', (r) => `<span class="mono">${esc(r.to)}</span>`]];
    if (tool === 'delete') return [['Project', keyCols[0][1]], ['Branch type', (r) => esc(r.type || '—')], ['Last analysis', (r) => (r.analysisDate ? rel(r.analysisDate) : '—')]];
    if (tool === 'longlived') return [['Project', keyCols[0][1]], ['Pattern', (r) => (r.setPattern ? `<span class="mono">${esc(r.from ?? '—')}</span> → <span class="mono">${esc(r.to)}</span>` : '<span class="muted">already set</span>')], ['Branch', (r) => (r.deleteBranch ? `delete <span class="mono">${esc(r.branch)}</span>` : '<span class="muted">nothing to delete</span>')]];
    return keyCols;
  }

  function table() {
    const p = state.preview;
    if (!p) return '';
    const rows = state.run?.data?.rows || p.rows;
    const running = !!state.run;
    const counts = countBy(rows, (r) => r.status).map(([s, n]) => `${n} ${(STATUS[s]?.[0] || s).toLowerCase()}`);
    const actionable = rows.filter((r) => r.actionable);
    const cols = columns(p.tool);
    EXPORT.admin = () => ({ name: `sonar-${p.tool}`, rows, columns: [['Project', (r) => r.project], ['Name', (r) => r.name], ['Status', (r) => r.status], ['From', (r) => r.from], ['To', (r) => r.to], ['Key source', (r) => r.source], ['Repository', (r) => r.repoUrl], ['Branch', (r) => r.branch], ['Result', (r) => r.result], ['Error', (r) => r.error], ['Link', (r) => r.url]] });
    return `<div class="sub-h"><h3>Preview · ${esc(TOOLS[p.tool].label)}</h3><span class="tb-right"><span class="muted small">${plural(rows.length, 'project')}${counts.length ? ' · ' + esc(counts.join(' · ')) : ''}</span>${exportBtn('admin')}</span></div>
      ${!running && actionable.length ? `<div class="toolbar"><span class="muted small">${state.selected.size} of ${actionable.length} selected</span><button class="link-btn" type="button" data-admin="all">Select all</button><button class="link-btn" type="button" data-admin="none">Select none</button></div>` : ''}
      <div class="tbl-wrap"><table class="admin-table">
        <thead><tr><th></th><th>Status</th>${cols.map(([h, , html]) => `<th>${html ? h : esc(h)}</th>`).join('')}${running ? '<th>Result</th>' : ''}<th class="r">Open</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.result ? `res-${r.result}` : ''}">
          <td>${r.actionable ? `<input type="checkbox" data-row="${esc(r.project)}" ${state.selected.has(r.project) ? 'checked' : ''} ${running ? 'disabled' : ''} aria-label="Select ${esc(r.project)}">` : ''}</td>
          <td><span class="pill ${STATUS[r.status]?.[1] || ''}">${esc(STATUS[r.status]?.[0] || r.status)}</span></td>
          ${cols.map(([, cell]) => `<td>${cell(r)}</td>`).join('')}
          ${running ? `<td>${r.result ? `<span class="result">${esc(RESULT[r.result] || r.result)}</span>${r.error ? `<div class="small bad">${esc(r.error)}</div>` : ''}` : ''}</td>` : ''}
          <td class="r"><a href="${href(r.url)}" target="_blank" rel="noopener">Open ↗</a></td></tr>`).join('') || `<tr><td colspan="${cols.length + 4}" class="empty">No projects match</td></tr>`}</tbody>
      </table></div>`;
  }

  function actions() {
    const p = state.preview;
    if (!p) return '';
    const t = TOOLS[p.tool];
    if (state.run) {
      const d = state.run.data || {};
      const pr = d.progress || { done: 0, total: state.selected.size, concurrency: snap?.config?.admin?.concurrency };
      const failed = (d.rows || []).filter((r) => r.result === 'failed').length;
      const waiting = pr.waitingUntil && pr.waitingUntil > Date.now();
      const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
      return `<div class="admin-run">
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="small">${d.finished ? '<b>Finished.</b> ' : ''}${fmt.format(pr.done)} / ${fmt.format(pr.total)} done${failed ? ` · <span class="bad">${failed} failed</span>` : ''}${!d.finished && pr.concurrency ? ` · ${pr.concurrency} at a time` : ''}
          ${waiting ? ` · <span class="warn-text">Rate limited by SonarQube Cloud; continuing at ${esc(new Date(pr.waitingUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}${d.error ? ` · <span class="bad">${esc(d.error)}</span>` : ''}</div>
        ${d.finished ? '<button class="btn" type="button" data-admin="reset">New preview</button>' : ''}
      </div>`;
    }
    const n = state.selected.size;
    if (!n) return '';
    if (!state.confirming) return `<div class="admin-apply">${t.warn ? `<div class="alert warn">${esc(t.warn)}</div>` : ''}<button class="btn primary" type="button" data-admin="confirm">${esc(t.verb)} · ${plural(n, t.noun)}</button></div>`;
    const typed = t.typeToConfirm ? state.confirmText === p.branch : true;
    return `<div class="admin-apply confirm">
      ${t.warn ? `<div class="alert ${t.typeToConfirm ? 'err' : 'warn'}">${esc(t.warn)}</div>` : ''}
      <span>${t.typeToConfirm ? `Type <b class="mono">${esc(p.branch)}</b> to confirm changes to ${plural(n, t.noun)}:` : `Apply to ${plural(n, t.noun)}?`}</span>
      ${t.typeToConfirm ? `<input class="input mono" data-confirm value="${esc(state.confirmText)}" autocomplete="off" aria-label="Type the branch name to confirm">` : ''}
      <button class="btn primary" type="button" data-admin="apply" ${typed && !state.busy ? '' : 'disabled'}>Yes, ${esc(t.verb.toLowerCase())}</button>
      <button class="btn" type="button" data-admin="cancel">Cancel</button>
    </div>`;
  }

  function render() {
    document.getElementById('admin-tools').innerHTML = Object.entries(TOOLS).map(([k, t]) => `<button role="tab" type="button" data-tool="${k}" aria-selected="${state.tool === k}">${esc(t.label)}</button>`).join('');
    root().innerHTML = `${form()}${state.error ? `<div class="alert err">${esc(state.error)}</div>` : ''}${table()}${actions()}`;
  }

  async function doPreview() {
    const f = state.form, t = T();
    state.busy = true; state.error = null; state.preview = null; state.run = null; state.confirming = false; state.selected.clear();
    render();
    const body = { tool: state.tool, org: f.org, ...(t.select ? (f.mode === 'keys' ? { keys: f.keys } : { prefix: f.prefix }) : {}), ...(t.pattern ? { pattern: f.pattern } : {}), ...(t.branch ? { branch: f.branch } : {}) };
    const r = await post('/api/admin/preview', body);
    state.busy = false;
    if (!r || r.error) state.error = r?.error || 'Preview failed: the server did not respond.';
    else {
      state.preview = { id: r.id, tool: state.tool, rows: r.rows, branch: f.branch.trim() };
      for (const row of r.rows) if (row.actionable && !row.review) state.selected.add(row.project);
    }
    render();
  }

  async function doApply() {
    const p = state.preview, t = TOOLS[p.tool];
    state.busy = true;
    render();
    const r = await post('/api/admin/apply', { previewId: p.id, selected: [...state.selected], confirm: t.typeToConfirm ? state.confirmText : true });
    state.busy = false;
    if (!r || r.error) { state.error = r?.error || 'Apply failed: the server did not respond.'; state.confirming = false; return render(); }
    state.run = { id: r.runId, data: null };
    state.confirming = false;
    pollRun();
  }

  async function pollRun() {
    if (!state.run) return;
    try {
      state.run.data = await (await fetch(`/api/admin/run?id=${encodeURIComponent(state.run.id)}`, { cache: 'no-store' })).json();
    } catch { /* keep polling */ }
    render();
    if (!state.run.data?.finished) setTimeout(pollRun, 700);
  }

  function onClick(e) {
    const tab = e.target.closest('[data-tool]');
    if (tab) {
      if (state.run && !state.run.data?.finished) return;
      state.tool = tab.dataset.tool;
      Object.assign(state, { preview: null, run: null, confirming: false, confirmText: '', error: null });
      state.selected.clear();
      return render();
    }
    const a = e.target.closest('[data-admin]');
    if (!a) return;
    const act = a.dataset.admin;
    if (act === 'preview') return doPreview();
    if (act === 'apply') return doApply();
    if (act === 'confirm') { state.confirming = true; state.confirmText = ''; render(); return document.querySelector('[data-confirm]')?.focus(); }
    if (act === 'cancel') { state.confirming = false; return render(); }
    if (act === 'all') { for (const r of state.preview.rows) if (r.actionable) state.selected.add(r.project); return render(); }
    if (act === 'none') { state.selected.clear(); state.confirming = false; return render(); }
    if (act === 'reset') { Object.assign(state, { preview: null, run: null }); state.selected.clear(); return render(); }
  }

  function onInput(e) {
    const field = e.target.dataset.field;
    if (field) {
      state.form[field] = e.target.value;
      if (field === 'mode') return render();
      if (field === 'pattern' || field === 'test') { const out = document.getElementById('admin-test'); if (out) out.innerHTML = patternTest(); }
      return;
    }
    if (e.target.dataset.row) {
      if (e.target.checked) state.selected.add(e.target.dataset.row); else state.selected.delete(e.target.dataset.row);
      state.confirming = false;
      return render();
    }
    if (e.target.matches('[data-confirm]')) {
      state.confirmText = e.target.value;
      const btn = document.querySelector('[data-admin="apply"]');
      if (btn) btn.disabled = state.confirmText !== state.preview.branch || state.busy;
    }
  }

  let wired = false;
  function show() {
    if (!wired) {
      const view = document.getElementById('view-admin');
      view.addEventListener('click', onClick);
      view.addEventListener('input', onInput);
      view.addEventListener('change', onInput);
      view.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-field]')) doPreview(); });
      wired = true;
    }
    render();
  }

  return { show };
})();
