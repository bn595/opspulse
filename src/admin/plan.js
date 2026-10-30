'use strict';
// Previews for the SonarQube Cloud admin tools. Each function turns projects (with their settings or
// branches) into rows: { project, name, status, actionable, ...tool fields }. Only actionable rows
// can be applied.

// SonarQube project keys: letters, digits, '-', '_', '.', ':'.
const KEY_CHARS = /^[A-Za-z0-9_.:-]+$/;
const PATTERN_SETTING = 'sonar.branch.longLivedBranches.regex';

// New key = old key up to and including the first '_' (the organization part, which cannot itself
// contain '_'), followed by `name`: the bound repository's name, or the project name when the project
// is not bound. A name that already starts with that prefix (in any case; projects created by the
// scanner are named after their key) is not prefixed again.
function deriveKey(key, name) {
  const cut = key.indexOf('_');
  if (cut < 1) return { to: null, status: 'unrecognized' };
  const prefix = key.slice(0, cut + 1);
  const bare = name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : name;
  const to = prefix + bare;
  if (!KEY_CHARS.test(bare)) return { to, status: 'invalid' };
  return { to, status: to === key ? 'unchanged' : 'change' };
}

// projects: [{ key, name, repo? }], where repo is the bound repository ({ name, url }), or null when
// the project is not bound. Keys follow the repository when there is one; otherwise the project name,
// and the row is marked for review (a project name can differ from the repository's).
// existingKeys: keys already taken, used to detect conflicts.
function planKeys(projects, { existingKeys = new Set() } = {}) {
  const rows = projects.map((p) => ({
    project: p.key, name: p.name, from: p.key,
    repo: p.repo?.name ?? null, repoUrl: p.repo?.url ?? null, source: p.repo ? 'repo' : 'name', review: p.repo === null,
    ...deriveKey(p.key, p.repo ? p.repo.name : p.name),
  }));
  const targets = new Map();
  for (const r of rows) if (r.status === 'change') targets.set(r.to, (targets.get(r.to) || 0) + 1);
  for (const r of rows) if (r.status === 'change' && (existingKeys.has(r.to) || targets.get(r.to) > 1)) r.status = 'conflict';
  return rows.map((r) => ({ ...r, actionable: r.status === 'change' }));
}

// Projects whose key no longer follows their repository (or name, when unbound). Conflicts are
// checked against every key listed plus `existingKeys` (keys known to be taken elsewhere). Keys in
// another format are listed when the name differs, so they can be followed up by hand.
function findDrift(projects, { existingKeys = new Set() } = {}) {
  const taken = new Set([...projects.map((p) => p.key), ...existingKeys]);
  return planKeys(projects, { existingKeys: taken }).filter((r) => r.status !== 'unchanged' && !(r.status === 'unrecognized' && r.from === (r.repo ?? r.name)));
}

function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('a branch pattern is required');
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch (e) {
    throw new Error(`invalid regular expression: ${e.message}`);
  }
}

// projects: [{ key, name, pattern, inherited }] with the current long-lived branch pattern.
function planPattern(projects, pattern) {
  compile(pattern);
  return projects.map((p) => {
    const status = p.pattern === pattern ? 'unchanged' : 'change';
    return { project: p.key, name: p.name, from: p.pattern, inherited: p.inherited, to: pattern, status, actionable: status === 'change' };
  });
}

// projects: [{ key, name, branches: [{ name, isMain, type, analysisDate }] }]
function planDelete(projects, branch) {
  return projects.map((p) => {
    const b = (p.branches || []).find((x) => x.name === branch);
    const status = !b ? 'missing' : b.isMain ? 'main' : 'delete';
    return { project: p.key, name: p.name, branch, type: status === 'delete' ? b.type || null : null, analysisDate: b?.analysisDate || null, status, actionable: status === 'delete' };
  });
}

// SonarQube Cloud reports long-lived branches as LONG; newer SonarQube versions as BRANCH.
const isLongLived = (b) => b.type === 'LONG' || b.type === 'BRANCH';

// Sets the pattern where needed and deletes the branch where it exists as short-lived, so the next
// analysis recreates it as long-lived (a branch's type is fixed at its first analysis).
function planLongLived(projects, pattern, branch) {
  if (!compile(pattern).test(branch)) throw new Error(`pattern does not match "${branch}", so it would not become long-lived`);
  return projects.map((p) => {
    const b = (p.branches || []).find((x) => x.name === branch);
    if (b?.isMain) return { project: p.key, name: p.name, from: p.pattern, to: pattern, branch, setPattern: false, deleteBranch: false, status: 'main', actionable: false };
    const setPattern = p.pattern !== pattern;
    const deleteBranch = !!b && !isLongLived(b);
    const status = setPattern || deleteBranch ? 'change' : 'unchanged';
    return { project: p.key, name: p.name, from: p.pattern, inherited: p.inherited, to: pattern, branch, type: b?.type || null, analysisDate: b?.analysisDate || null, setPattern, deleteBranch, status, actionable: status === 'change' };
  });
}

module.exports = { planKeys, findDrift, planPattern, planDelete, planLongLived, PATTERN_SETTING };
