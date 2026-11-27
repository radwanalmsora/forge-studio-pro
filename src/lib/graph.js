'use strict';
const path = require('path').posix;
const { uniq, moduleOf } = require('./util');

const JS_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'];

function makeResolver(files, goModule) {
  const set = new Set(files);
  const bySuffix = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, f);
    }
  }
  const tryJs = (base) => {
    if (set.has(base)) return base;
    const bare = base.replace(/\.[cm]?jsx?$/, '');
    for (const b of uniq([base, bare])) {
      for (const e of JS_EXT) if (set.has(`${b}.${e}`)) return `${b}.${e}`;
      for (const e of JS_EXT) if (set.has(`${b}/index.${e}`)) return `${b}/index.${e}`;
    }
    return null;
  };
  return (from, lang, spec) => {
    const dir = path.dirname(from);
    if (lang === 'js') {
      if (spec.startsWith('.')) return [tryJs(path.normalize(path.join(dir, spec)))];
      const alias = /^[@~]\/(.*)$/.exec(spec);
      if (!alias) return [];
      const root = /^(.*?)(?:^|\/)src\//.exec(from);
      const prefix = root && root[1] ? root[1] + '/' : '';
      return [tryJs(`${prefix}src/${alias[1]}`) || tryJs(prefix + alias[1])];
    }
    if (lang === 'py') {
      const dots = spec.length - spec.replace(/^\.+/, '').length;
      const rest = spec.slice(dots).replace(/\./g, '/');
      const base = dots ? path.normalize(path.join(dir, '../'.repeat(dots - 1) || '.', rest)) : rest;
      for (const c of [`${base}.py`, `${base}/__init__.py`]) {
        if (set.has(c)) return [c];
        if (!dots && set.has(path.join(dir, c))) return [path.join(dir, c)];
        if (!dots && base.includes('/') && bySuffix.has(c)) return [bySuffix.get(c)];
      }
      return [];
    }
    if (lang === 'java') {
      const p = spec.replace(/\./g, '/');
      return [bySuffix.get(`${p}.java`) || bySuffix.get(`${p}.kt`)];
    }
    if (lang === 'go') {
      if (!goModule || !spec.startsWith(goModule)) return [];
      const d = spec.slice(goModule.length).replace(/^\//, '') || '.';
      return files.filter((f) => f.endsWith('.go') && path.dirname(f) === d && !f.endsWith('_test.go'));
    }
    if (lang === 'php') {
      if (spec.includes('\\')) {
        const parts = spec.split('\\');
        return [bySuffix.get(parts.slice(1).join('/') + '.php') || bySuffix.get(parts[parts.length - 1] + '.php')];
      }
      return [set.has(path.join(dir, spec)) ? path.join(dir, spec) : bySuffix.get(spec.replace(/^\//, ''))];
    }
    if (lang === 'ruby' || lang === 'rust') {
      const base = path.normalize(path.join(dir, spec));
      const ext = lang === 'ruby' ? 'rb' : 'rs';
      return [[`${base}.${ext}`, `${base}/mod.rs`].find((c) => set.has(c))];
    }
    return [];
  };
}

/** index: Map<path, parsedFile> */
function buildGraph(index, goModule) {
  const files = [...index.keys()];
  const resolve = makeResolver(files, goModule);
  const deps = new Map();
  const users = new Map(files.map((f) => [f, []]));
  for (const [file, info] of index) {
    const targets = uniq(info.imports.flatMap((s) => resolve(file, info.lang, s)).filter((t) => t && t !== file));
    deps.set(file, targets);
    for (const t of targets) users.get(t).push(file);
  }
  return { deps, users };
}

function walk(map, start, depth = 8) {
  const seen = new Map();
  let frontier = [].concat(start);
  const roots = new Set(frontier);
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) for (const n of map.get(f) || []) {
      if (!seen.has(n) && !roots.has(n)) { seen.set(n, d); next.push(n); }
    }
    frontier = next;
  }
  return seen;
}

function tree(map, root, depth = 3, seen = new Set()) {
  seen.add(root);
  const children = [];
  if (depth > 0) for (const n of (map.get(root) || []).slice(0, 12)) {
    if (!seen.has(n)) children.push(tree(map, n, depth - 1, seen));
  }
  return { file: root, children };
}

const stem = (f) => path.basename(f).replace(/\.\w+$/, '').replace(/\.(test|spec)$/i, '').replace(/^test_|_test$|_spec$|Tests?$|IT$/g, '').toLowerCase();

function relatedTests(index, graph, changed) {
  const list = [].concat(changed).filter((f) => index.has(f));
  const found = new Set(list.filter((f) => index.get(f).isTest));
  for (const f of walk(graph.users, list, 5).keys()) if (index.get(f).isTest) found.add(f);
  const stems = new Set(list.map(stem));
  for (const [f, info] of index) if (info.isTest && stems.has(stem(f))) found.add(f);
  return [...found].sort();
}

function impact(index, graph, file) {
  const dependents = walk(graph.users, file);
  const affected = [file, ...dependents.keys()];
  const endpoints = affected.flatMap((f) => (index.has(f) ? index.get(f).endpoints : []));
  const direct = [...walk(graph.deps, file, 4).keys()];
  const isData = (f) => /(repositor|model|entity|schema|migration|\bdb\b|database|prisma|\.sql$)/i.test(f);
  return {
    file,
    dependencies: graph.deps.get(file) || [],
    dependents: [...dependents].map(([f, d]) => ({ file: f, depth: d })),
    tests: relatedTests(index, graph, file),
    endpoints,
    data: uniq([file, ...direct].filter(isData)),
    systems: uniq(affected.filter((f) => index.has(f) && !index.get(f).isTest).map(moduleOf))
  };
}

const SYNONYMS = {
  login: ['auth', 'signin', 'session', 'token', 'password'], auth: ['login', 'signin', 'session', 'token'],
  signup: ['register', 'auth'], payment: ['billing', 'checkout', 'invoice', 'stripe'], user: ['account', 'profile'],
  database: ['db', 'repository', 'model', 'schema'], email: ['mail', 'notification'], cart: ['order', 'checkout']
};
const STOP = new Set('the a an i want to change modify edit update how does of in for and is where fix add method way system'.split(' '));

/** Answer "I want to change X" with a ranked list of files. */
function search(index, graph, query) {
  const words = uniq(query.toLowerCase().replace(/log in|sign in/g, 'login').split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1 && !STOP.has(w)));
  const terms = new Map();
  for (const w of words) {
    terms.set(w, 3);
    for (const s of SYNONYMS[w] || []) if (!terms.has(s)) terms.set(s, 1);
  }
  const scored = [];
  for (const [file, info] of index) {
    let score = 0;
    const matched = [];
    const p = file.toLowerCase();
    for (const [t, weight] of terms) {
      if (p.includes(t)) score += weight * 3;
      for (const s of info.symbols) if (s.name.toLowerCase().includes(t)) { score += weight; matched.push(s.name); }
      for (const e of info.endpoints) if (e.path.toLowerCase().includes(t)) score += weight * 2;
    }
    if (score > 0) scored.push({ file, score, symbols: uniq(matched).slice(0, 6), users: (graph.users.get(file) || []).length, isTest: info.isTest });
  }
  scored.sort((a, b) => b.score - a.score);
  const edit = scored.filter((s) => !s.isTest).slice(0, 8);
  const chosen = new Set(edit.map((e) => e.file));
  const near = uniq(edit.flatMap((e) => graph.deps.get(e.file) || []));
  const careful = near.filter((f) => !chosen.has(f) && (graph.users.get(f) || []).length >= 2)
    .map((f) => ({ file: f, users: graph.users.get(f).length })).sort((a, b) => b.users - a.users).slice(0, 6);
  const entry = edit.slice().sort((a, b) => (graph.deps.get(b.file).length - graph.deps.get(a.file).length) || b.score - a.score)[0];
  return { query, edit, careful, tests: relatedTests(index, graph, edit.map((e) => e.file)), map: entry ? tree(graph.deps, entry.file, 3) : null };
}

module.exports = { buildGraph, walk, tree, relatedTests, impact, search };
