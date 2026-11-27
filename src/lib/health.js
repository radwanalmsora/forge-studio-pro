'use strict';
const { hash, uniq } = require('./util');

const TYPE_RULES = [
  ['Memory Problem', /memory leak|heap/i], ['Performance Problem', /performance|too slow/i],
  ['Dependency Conflict', /cannot find module|unresolved import|peer dep|could not be resolved/i],
  ['Configuration Problem', /tsconfig|eslintrc|configuration|\.env\b/i], ['Database Problem', /database|\bsql\b|migration/i],
  ['UI Problem', /accessibility|aria-|\bcss\b/i], ['Compatibility Problem', /deprecated|unsupported|compatib/i]
];

function classify(message, severity) {
  const hit = TYPE_RULES.find(([, re]) => re.test(message));
  if (hit) return hit[0];
  return severity === 'high' || severity === 'critical' ? 'Compilation Error' : 'Bug';
}

/**
 * Merge freshly detected problems with the stored registry so every problem keeps its number and status.
 * registry: { next, items: {key: record} }
 */
function reconcile(registry, detected, now = Date.now()) {
  const reg = { next: registry.next || 1, items: { ...(registry.items || {}) } };
  const live = new Set();
  for (const p of detected) {
    const key = p.key || hash(`${p.type}|${p.file}|${p.title}`);
    if (live.has(key)) continue;
    live.add(key);
    const old = reg.items[key];
    const status = !old || old.status === 'Resolved' ? 'Open' : old.status;
    reg.items[key] = { ...p, key, id: old ? old.id : reg.next++, status, firstSeen: old ? old.firstSeen : now, resolved: null };
  }
  for (const [key, r] of Object.entries(reg.items)) {
    if (!live.has(key) && r.status !== 'Resolved') reg.items[key] = { ...r, status: 'Resolved', resolved: now };
  }
  const old = Object.values(reg.items).filter((r) => r.status === 'Resolved').sort((a, b) => b.resolved - a.resolved).slice(100);
  for (const r of old) delete reg.items[r.key];
  return reg;
}

const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const open = (reg) => Object.values(reg.items || {}).filter((p) => p.status !== 'Resolved' && p.status !== 'Ignored').sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id - b.id);

function health({ problems = [], tests, build, outdated, vulnerabilities, todos = 0 }) {
  const count = (sev) => problems.filter((p) => p.severity === sev && p.type !== 'Test Failure').length;
  let score = 100;
  score -= Math.min(count('critical') * 8, 32) + Math.min(count('high') * 3, 24) + Math.min(count('medium') * 0.8, 10) + Math.min(count('low') * 0.2, 4);
  if (tests && !tests.ok) score -= Math.min(10 + (tests.failed || 0) * 2, 22);
  if (build && !build.ok) score -= 20;
  if (vulnerabilities) score -= Math.min((vulnerabilities.critical || 0) * 6 + (vulnerabilities.high || 0) * 3, 18);
  if (outdated) score -= Math.min(outdated.length * 0.3, 5);
  score -= Math.min(todos * 0.2, 4);
  return Math.max(0, Math.round(score));
}

function actions({ problems = [], tests, build, outdated, vulnerabilities, todos = 0, gitChanges = [] }) {
  const out = [];
  const add = (text, tab) => out.push({ text, tab });
  if (build && !build.ok) add('Fix the failing build', 'workflows');
  if (tests && !tests.ok) add(tests.failed ? `Resolve ${tests.failed} failing test(s)` : 'Investigate the failed test run', 'testing');
  const sec = problems.filter((p) => p.type === 'Security Vulnerability' && (p.severity === 'critical' || p.severity === 'high'));
  if (sec.length) add(`Fix ${sec.length} high-risk security finding(s)`, 'security');
  const errs = problems.filter((p) => p.source === 'diagnostics' && p.severity === 'high');
  if (errs.length) add(`Resolve ${errs.length} editor error(s)`, 'problems');
  const auth = uniq(gitChanges.filter((c) => /auth|login|session|token|password|permission/i.test(c.file)).map((c) => c.file));
  if (auth.length) add(`Review authentication changes in ${auth.length} file(s)`, 'understanding');
  if (vulnerabilities && vulnerabilities.total) add(`Update ${vulnerabilities.total} vulnerable package(s)`, 'security');
  else if (outdated && outdated.length) add(`Review ${outdated.length} dependency update(s)`, 'security');
  if (todos) add(`Complete ${todos} unfinished implementation marker(s)`, 'understanding');
  return out;
}

module.exports = { classify, reconcile, open, health, actions };
