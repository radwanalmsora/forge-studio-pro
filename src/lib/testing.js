'use strict';
const path = require('path').posix;
const { stripAnsi, uniq, shellPath, posix } = require('./util');

function detectProject({ pkg, files }) {
  const has = (re) => files.some((f) => re.test(f));
  const out = { framework: null, test: null, build: null, related: null };
  if (pkg) {
    const s = pkg.scripts || {};
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = has(/^pnpm-lock\.yaml$/) ? 'pnpm' : has(/^yarn\.lock$/) ? 'yarn' : 'npm';
    if (s.test && !/no test specified/.test(s.test)) out.test = `${pm} test`;
    if (s.build) out.build = `${pm} run build`;
    else if (s.compile) out.build = `${pm} run compile`;
    const fw = ['vitest', 'jest', 'mocha'].find((n) => all[n] || (s.test || '').includes(n));
    if (fw) {
      out.framework = fw;
      out.related = `npx --no-install ${fw}${fw === 'vitest' ? ' run' : ''}`;
      if (!out.test) out.test = out.related;
    } else if (/node\s+--test/.test(s.test || '')) { out.framework = 'node:test'; out.related = 'node --test'; }
  }
  if (!out.test) {
    if (has(/(^|\/)(pytest\.ini|conftest\.py)$/) || has(/(^|\/)test_[^/]+\.py$/)) Object.assign(out, { framework: 'pytest', test: 'python -m pytest', related: 'python -m pytest' });
    else if (has(/^go\.mod$/)) Object.assign(out, { framework: 'go', test: 'go test ./...', build: 'go build ./...', related: 'go test' });
    else if (has(/^Cargo\.toml$/)) Object.assign(out, { framework: 'cargo', test: 'cargo test', build: 'cargo build' });
    else if (has(/^pom\.xml$/)) Object.assign(out, { framework: 'maven', test: 'mvn -q test', build: 'mvn -q -DskipTests package' });
    else if (has(/^build\.gradle(\.kts)?$/)) Object.assign(out, { framework: 'gradle', test: 'gradle test', build: 'gradle assemble' });
    else if (has(/\.(sln|csproj)$/)) Object.assign(out, { framework: 'dotnet', test: 'dotnet test', build: 'dotnet build' });
  }
  return out;
}

function relatedCommand(project, tests) {
  if (!project.related || !tests.length) return null;
  const targets = project.framework === 'go' ? uniq(tests.map((t) => './' + path.dirname(t))) : tests;
  const quoted = targets.map(shellPath);
  return quoted.includes(null) ? null : `${project.related} ${quoted.join(' ')}`;
}

function parseTestOutput(raw, exitCode) {
  const text = stripAnsi(raw).replace(/\r/g, '');
  let passed = null;
  let failed = null;
  const num = (re) => { const all = [...text.matchAll(re)]; return all.length ? all.reduce((a, m) => a + +m[1], 0) : null; };
  const jestLine = /^\s*Tests:?\s+(.*(?:passed|failed|total).*)$/m.exec(text);
  if (jestLine) {
    passed = +(/(\d+) passed/.exec(jestLine[1]) || [0, 0])[1];
    failed = +(/(\d+) failed/.exec(jestLine[1]) || [0, 0])[1];
  } else if (/Tests run: \d+/.test(text)) {
    const m = [...text.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?(?![^\n]*Time elapsed)/g)].pop();
    if (m) { failed = +m[2] + +m[3]; passed = +m[1] - failed - +(m[4] || 0); }
  } else if (/^(?:#|ℹ) pass \d+/m.test(text)) {
    passed = num(/^(?:#|ℹ) pass (\d+)/gm); failed = num(/^(?:#|ℹ) fail (\d+)/gm);
  } else if (/test result: /.test(text)) {
    passed = num(/test result: \w+\. (\d+) passed/g); failed = num(/test result: \w+\. \d+ passed; (\d+) failed/g);
  } else if (/Passed:\s+\d+/.test(text)) {
    passed = num(/Passed:\s+(\d+)/g); failed = num(/Failed:\s+(\d+)/g);
  } else {
    passed = num(/(\d+) pass(?:ed|ing)\b/g); failed = num(/(\d+) fail(?:ed|ing|ures?)\b/g);
    if (passed === null && /^--- (?:PASS|FAIL)|^(?:ok|FAIL)\s+\S+/m.test(text)) {
      passed = (text.match(/^ok\s+\S+|^--- PASS/gm) || []).length;
      failed = (text.match(/^--- FAIL/gm) || []).length;
    }
  }
  const names = [];
  const patterns = [/^\s*● (.+)$/gm, /^\s*(?:FAIL|×|✗) +(\S.*? > .+?)(?: \d+ms)?$/gm, /^FAILED (\S+)/gm, /^\s*--- FAIL: (\S+)/gm,
    /^\s*✖ (.+?)(?: \([\d.]+ms\))?$/gm, /^not ok \d+ - (.+)$/gm, /^test (\S+) \.\.\. FAILED/gm, /^\s*\d+\) (.+)$/gm];
  if (exitCode !== 0 || failed > 0) for (const re of patterns) {
    for (const m of text.matchAll(re)) if (!/^failing tests:?$/i.test(m[1])) names.push(m[1].trim());
  }
  const ok = exitCode === 0 && !failed;
  const failures = uniq(names).slice(0, 50).map((name) => ({ name }));
  if (!ok && !failed) failed = failures.length || null;
  return { ok, passed, failed: ok ? 0 : failed, failures };
}

/** Returns { total, files: [{file, pct, covered, lines}] } from lcov or an Istanbul summary. */
function parseCoverage(content, root = '') {
  const rows = [];
  const rel = (f) => { const p = posix(f); const r = posix(root); return r && p.startsWith(r + '/') ? p.slice(r.length + 1) : p.replace(/^\.\//, ''); };
  if (content.trimStart().startsWith('{')) {
    for (const [f, v] of Object.entries(JSON.parse(content))) if (f !== 'total' && v.lines) rows.push({ file: rel(f), covered: v.lines.covered, lines: v.lines.total });
  } else {
    for (const block of content.split('end_of_record')) {
      const sf = /^SF:(.+)$/m.exec(block);
      const lf = /^LF:(\d+)/m.exec(block);
      const lh = /^LH:(\d+)/m.exec(block);
      if (sf && lf && lh) rows.push({ file: rel(sf[1].trim()), lines: +lf[1], covered: +lh[1] });
    }
  }
  const pct = (c, l) => (l ? Math.round((c / l) * 100) : 100);
  for (const r of rows) r.pct = pct(r.covered, r.lines);
  return { total: pct(rows.reduce((a, r) => a + r.covered, 0), rows.reduce((a, r) => a + r.lines, 0)), files: rows };
}

function duplicateTests(index) {
  const seen = new Map();
  for (const [file, info] of index) for (const t of info.testNames) {
    const key = t.name.toLowerCase().trim();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push({ file, line: t.line });
  }
  return [...seen].filter(([, v]) => v.length > 1).map(([name, places]) => ({ name, places }));
}

function skeleton(file, info, { framework, esm } = {}) {
  const base = path.basename(file).replace(/\.\w+$/, '');
  const names = uniq(info.symbols.filter((s) => (s.kind === 'function' || s.kind === 'class') && !s.name.startsWith('_') && /^[A-Za-z_]\w*$/.test(s.name)).map((s) => s.name)).slice(0, 20);
  const dir = path.dirname(file);
  const join = (n) => (dir === '.' ? n : `${dir}/${n}`);
  const list = names.length ? names : [base];
  if (info.lang === 'py') {
    const mod = file.replace(/\.py$/, '').replace(/\//g, '.');
    return { path: join(`test_${base}.py`), content: `import pytest\n\nimport ${mod} as subject\n\n\n` + list.map((n) => `def test_${n.toLowerCase()}():\n    pytest.skip("Write assertions for ${n}")\n`).join('\n\n') };
  }
  if (info.lang === 'go') {
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const pkg = dir === '.' ? 'main' : path.basename(dir).replace(/\W/g, '_');
    return { path: join(`${base}_test.go`), content: `package ${pkg}\n\nimport "testing"\n\n` + uniq(list.map(cap)).map((n) => `func Test${n}(t *testing.T) {\n\tt.Skip("Write assertions for ${n}")\n}\n`).join('\n') };
  }
  if (info.lang === 'js') {
    const ext = /\.tsx?$/.test(file) ? 'ts' : 'js';
    const modules = esm || ext === 'ts' || /\.mjs$/.test(file);
    const source = framework === 'vitest' ? 'vitest' : framework === 'jest' || framework === 'mocha' ? null : 'node:test';
    const header = !source ? '' : modules || source === 'vitest' ? `import { describe, it } from '${source}';\n\n` : `const { describe, it } = require('${source}');\n\n`;
    const pending = framework === 'mocha' ? 'it' : 'it.todo';
    return { path: join(`${base}.test.${ext}`), content: header + list.map((n) => `describe(${JSON.stringify(n)}, () => {\n  ${pending}(${JSON.stringify(`behaves as expected (${base}.${n})`)});\n});\n`).join('\n') };
  }
  return null;
}

module.exports = { detectProject, relatedCommand, parseTestOutput, parseCoverage, duplicateTests, skeleton };
