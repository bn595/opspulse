'use strict';
// Include/exclude rules for connector items.
//   rule     { field: matcher, ... }  all fields must match
//   list     [rule, ...]              any rule may match
//   matcher  "text" (case-insensitive, * wildcard) | "/regex/flags" | number | boolean | null | [matcher, ...]
// Fields may be dotted paths. `raw.*` addresses the unmodified API object.
// An item is kept when it matches an include rule (or none are configured) and no exclude rule.

function compileMatcher(m, where) {
  if (Array.isArray(m)) {
    const fns = m.map((x, i) => compileMatcher(x, `${where}[${i}]`));
    return (v) => fns.some((f) => f(v));
  }
  if (m === null) return (v) => v == null || v === '';
  if (typeof m === 'number' || typeof m === 'boolean') return (v) => v === m;
  if (typeof m !== 'string') throw new Error(`${where}: unsupported matcher ${JSON.stringify(m)}`);
  const re = /^\/(.*)\/([a-z]*)$/s.exec(m);
  let rx;
  try {
    rx = re ? new RegExp(re[1], re[2]) : new RegExp('^' + m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  } catch (e) {
    throw new Error(`${where}: invalid regular expression (${e.message})`);
  }
  return (v) => v != null && rx.test(String(v));
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function compileRule(rule, where) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where}: a rule must be an object of field: matcher pairs`);
  const checks = Object.entries(rule).map(([field, m]) => [field, compileMatcher(m, `${where}.${field}`)]);
  if (!checks.length) throw new Error(`${where}: empty rule`);
  return (item) => checks.every(([field, test]) => {
    const v = get(item, field);
    return Array.isArray(v) ? v.some(test) || (v.length === 0 && test(null)) : test(v);
  });
}

function compileList(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${where} must be a list of rules`);
  return list.map((r, i) => compileRule(r, `${where}[${i}]`));
}

// Returns a predicate for one config section ({ include, exclude }). `where` names it in errors.
function compile(section, where) {
  const inc = compileList(section?.include, `${where}.include`);
  const exc = compileList(section?.exclude, `${where}.exclude`);
  if (!inc.length && !exc.length) return null;
  return (item) => (!inc.length || inc.some((f) => f(item))) && !exc.some((f) => f(item));
}

module.exports = { compile };
