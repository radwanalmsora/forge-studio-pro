'use strict';
const path = require('path');
const { uniq } = require('./util');

const LANG = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  py: 'py', java: 'java', kt: 'java', go: 'go', rs: 'rust', php: 'php', rb: 'ruby', cs: 'cs',
  sql: 'sql', prisma: 'prisma'
};
const langOf = (file) => LANG[path.extname(file).slice(1).toLowerCase()] || null;

const TEST_RE = /(^|\/)(__tests__|tests?|spec)\/.+\.([cm]?[jt]sx?|py|java|kt|go|rs|php|cs)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(Test|Tests|IT)\.(java|kt|php|cs)$|_spec\.rb$/;
const isTestFile = (file) => TEST_RE.test(file);

const lineAt = (text, index) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

function each(re, text, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    fn(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

const SYMBOLS = {
  js: [
    [/^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, 'class'],
    [/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, 'function'],
    [/^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>/gm, 'function'],
    [/^[ \t]*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, 'type']
  ],
  py: [[/^[ \t]*class\s+(\w+)/gm, 'class'], [/^[ \t]*(?:async\s+)?def\s+(\w+)/gm, 'function']],
  java: [[/\b(?:class|interface|enum|record|object)\s+([A-Z]\w*)/g, 'class'], [/\bfun\s+(\w+)\s*\(/g, 'function'],
    [/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\], ]+\s+(\w+)\s*\(/gm, 'function']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm, 'function'], [/^type\s+(\w+)\s+(?:struct|interface)/gm, 'class']],
  rust: [[/\bfn\s+(\w+)/g, 'function'], [/\b(?:struct|enum|trait)\s+(\w+)/g, 'class']],
  php: [[/\b(?:class|interface|trait)\s+(\w+)/g, 'class'], [/\bfunction\s+(\w+)/g, 'function']],
  ruby: [[/^\s*(?:class|module)\s+([A-Z][\w:]*)/gm, 'class'], [/^\s*def\s+([\w.?!]+)/gm, 'function']],
  cs: [[/\b(?:class|interface|record|struct)\s+([A-Z]\w*)/g, 'class']],
  sql: [[/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"\[]?([\w.]+)/gi, 'table']],
  prisma: [[/^\s*model\s+(\w+)/gm, 'table']]
};

function parseImports(lang, text) {
  const out = [];
  const add = (m) => out.push(m[1]);
  if (lang === 'js') {
    each(/\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g, text, add);
    each(/\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, text, add);
  } else if (lang === 'py') {
    each(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm, text, (m) => {
      out.push(m[1]);
      for (const n of m[2].replace(/[()]/g, '').split(',')) {
        const name = n.trim().split(/\s+/)[0];
        if (/^\w+$/.test(name)) out.push(m[1].endsWith('.') ? m[1] + name : `${m[1]}.${name}`);
      }
    });
    each(/^[ \t]*import[ \t]+([\w.]+)/gm, text, add);
  } else if (lang === 'java') each(/^\s*import\s+(?:static\s+)?([\w.]+)/gm, text, add);
  else if (lang === 'go') {
    each(/^import\s+(?:\w+\s+)?"([^"]+)"/gm, text, add);
    each(/^import\s*\(([\s\S]*?)\)/gm, text, (b) => each(/"([^"]+)"/g, b[1], add));
  } else if (lang === 'php') {
    each(/^\s*use\s+([\w\\]+)/gm, text, add);
    each(/\b(?:require|include)(?:_once)?\s*\(?[^'"\n;]*['"]([^'"]+)['"]/g, text, add);
  } else if (lang === 'ruby') each(/^\s*require_relative\s+['"]([^'"]+)['"]/gm, text, (m) => out.push('./' + m[1]));
  else if (lang === 'rust') each(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm, text, (m) => out.push('./' + m[1]));
  return uniq(out);
}

const joinRoute = (a, b) => ('/' + [a, b].join('/')).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');

/** API routes implemented by a file. */
function parseEndpoints(file, text) {
  const lang = langOf(file);
  const out = [];
  const add = (method, route, index) => out.push({ method: method.toUpperCase(), path: route, file, line: lineAt(text, index) });
  if (isTestFile(file)) return out;
  if (lang === 'js') {
    each(/\b(?:app|router|server|fastify|\w+Router|\w+Routes)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`](\/[^'"`\n]*)['"`]\s*,/g, text,
      (m) => add(m[1], m[2], m.index));
    const ctl = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/.exec(text);
    if (ctl) each(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g, text,
      (m) => add(m[1], joinRoute(ctl[1] || '', m[2] || ''), m.index));
    const next = /(?:^|\/)app\/((?:.*\/)?)route\.[jt]s$/.exec(file);
    if (next) each(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g, text,
      (m) => add(m[1], joinRoute('', next[1].replace(/\([^)]*\)\//g, '')), m.index));
    const pages = /(?:^|\/)pages\/(api\/.*)\.[jt]sx?$/.exec(file);
    if (pages) add('ALL', joinRoute('', pages[1].replace(/\/index$/, '')), 0);
  } else if (lang === 'py') {
    each(/@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g, text, (m) => add(m[1], joinRoute('', m[2]), m.index));
    each(/@\w+\.route\(\s*['"]([^'"]*)['"]([^)\n]*)/g, text, (m) => {
      const methods = [...m[2].matchAll(/['"](GET|POST|PUT|PATCH|DELETE)['"]/gi)].map((x) => x[1]);
      for (const v of methods.length ? methods : ['GET']) add(v, joinRoute('', m[1]), m.index);
    });
    if (/urls\.py$/.test(file)) each(/\bpath\(\s*['"]([^'"]*)['"]/g, text, (m) => add('ALL', joinRoute('', m[1]), m.index));
  } else if (lang === 'java') {
    const base = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:open\s+)?class/.exec(text);
    each(/@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:"([^"]*)")?[^)]*\))?/g, text,
      (m) => add(m[1], joinRoute(base ? base[1] : '', m[2] || ''), m.index));
  } else if (lang === 'go') {
    each(/\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"\s*,/g, text, (m) => add(m[1], m[2], m.index));
    each(/\bHandle(?:Func)?\(\s*"(?:(GET|POST|PUT|PATCH|DELETE) )?(\/[^"]*)"/g, text, (m) => add(m[1] || 'ALL', m[2], m.index));
  } else if (lang === 'php') {
    each(/Route::(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g, text, (m) => add(m[1], joinRoute('', m[2]), m.index));
  }
  return out;
}

/** HTTP calls made by a file (API consumers). */
function parseApiCalls(file, text) {
  const out = [];
  const add = (method, url, index) => {
    const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{[^}]+\}(?=\/)/, '').split('?')[0];
    if (p.startsWith('/') && p.length > 1) out.push({ method: method.toUpperCase(), path: p, file, line: lineAt(text, index) });
  };
  each(/\bfetch\(\s*['"`]([^'"`\n]+)['"`](?:\s*,\s*\{[^}]*?method\s*:\s*['"`](\w+)['"`])?/g, text, (m) => add(m[2] || 'GET', m[1], m.index));
  each(/\b(?:axios|http|api|apiClient|client|requests|httpClient|\$http)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>\n]*>)?\(\s*f?['"`]([^'"`\n]+)['"`]/g, text,
    (m) => add(m[1], m[2], m.index));
  return out;
}

const segs = (p) => p.split('/').filter(Boolean).map((s) => (/^(:|\{|\[|<|\$\{)/.test(s) ? '*' : s));
function routeMatches(endpoint, call) {
  if (endpoint.method !== 'ALL' && endpoint.method !== call.method) return false;
  const a = segs(endpoint.path);
  let b = segs(call.path);
  if (b.length > a.length && b[0] === 'api') b = b.slice(1);
  return a.length === b.length && a.every((s, i) => s === '*' || b[i] === '*' || s === b[i]);
}

function parseFile(file, text) {
  const lang = langOf(file);
  const symbols = [];
  for (const [re, kind] of SYMBOLS[lang] || []) {
    each(re, text, (m) => symbols.push({ name: m[1], kind, line: lineAt(text, m.index + m[0].indexOf(m[1])) }));
  }
  const test = isTestFile(file);
  const testNames = [];
  if (test) {
    each(/\b(?:it|test)(?:\.(?:only|skip))?\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])+)\1/g, text, (m) => testNames.push({ name: m[2], line: lineAt(text, m.index) }));
    if (lang === 'py') each(/^[ \t]*(?:async\s+)?def\s+(test_\w+)/gm, text, (m) => testNames.push({ name: m[1], line: lineAt(text, m.index + m[0].indexOf(m[1])) }));
    if (lang === 'go') each(/^func\s+(Test\w+)/gm, text, (m) => testNames.push({ name: m[1], line: lineAt(text, m.index) }));
  }
  return {
    path: file, lang, symbols, testNames, isTest: test,
    lines: text.split('\n').length,
    imports: parseImports(lang, text),
    endpoints: parseEndpoints(file, text),
    calls: test ? [] : parseApiCalls(file, text),
    todos: (text.match(/(?:\/\/|#|\/\*|--)\s*(?:TODO|FIXME)\b|throw new Error\(['"]not implemented|raise NotImplementedError/gi) || []).length
  };
}

module.exports = { langOf, isTestFile, parseFile, parseImports, parseEndpoints, parseApiCalls, routeMatches, lineAt };
