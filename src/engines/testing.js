'use strict';
const vscode = require('vscode');
const { parseTestOutput, relatedCommand, parseCoverage, skeleton } = require('../lib/testing');
const { relatedTests, walk } = require('../lib/graph');
const { tail, moduleOf } = require('../lib/util');

module.exports = {
  relatedForChanges() {
    let changed = this.changedFiles().filter((f) => this.index.has(f));
    const active = vscode.window.activeTextEditor && this.rel(vscode.window.activeTextEditor.document.uri);
    if (!changed.length && active && this.index.has(active)) changed = [active];
    return { changed: changed.slice(0, 50), tests: relatedTests(this.index, this.graph, changed).slice(0, 100) };
  },

  async runTests(scope = 'all', { token, quiet } = {}) {
    this.requireWorkspace();
    if (!this.project) await this.loadProject();
    if (!this.project.test) throw new Error('No test command detected. Set "forge.testCommand" in settings.');
    let command = this.project.test;
    let note = '';
    if (scope === 'related') {
      const { tests } = this.relatedForChanges();
      if (!tests.length) { if (!quiet) vscode.window.showInformationMessage('Forge: no tests are related to the current changes.'); return null; }
      const narrow = relatedCommand(this.project, tests);
      if (narrow) command = narrow; else note = 'This framework cannot select test files safely, so the full suite ran.';
    }
    const r = await this.execute(command, 'Running tests', token);
    if (r.cancelled) throw new Error('Test run was cancelled.');
    const parsed = parseTestOutput(r.output, r.code);
    const names = [...this.index.values()].flatMap((i) => i.testNames.map((t) => ({ ...t, file: i.path })));
    for (const f of parsed.failures) {
      const hit = names.find((n) => f.name.endsWith(n.name));
      const byFile = [...this.index.keys()].find((p) => this.index.get(p).isTest && f.name.includes(p));
      if (hit) Object.assign(f, { file: hit.file, line: hit.line });
      else if (byFile) f.file = byFile;
    }
    const before = new Set(((this.data.tests && this.data.tests.failures) || []).map((f) => f.name));
    const now = new Set(parsed.failures.map((f) => f.name));
    const previous = this.data.tests;
    this.data.tests = {
      ...parsed, command, note, scope, time: Date.now(), ms: r.ms, output: tail(r.output, 12000),
      newFailures: [...now].filter((n) => !before.has(n)),
      fixed: scope === 'all' ? [...before].filter((n) => !now.has(n)) : [],
      previous: previous ? { passed: previous.passed, failed: previous.failed, ms: previous.ms } : null
    };
    await this.loadCoverage();
    await this.commit();
    if (!parsed.ok && !quiet) await this.trigger('onTestFailure');
    return this.data.tests;
  },

  async loadCoverage() {
    this.coverage = null;
    for (const file of ['coverage/coverage-summary.json', 'coverage/lcov.info', 'lcov.info', 'coverage.lcov']) {
      try {
        const uri = this.uri(file);
        if ((await vscode.workspace.fs.stat(uri)).size > 20 * 1024 * 1024) continue;
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const parsed = parseCoverage(text, this.root);
        if (parsed.files.length) { this.coverage = { ...parsed, source: file }; return; }
      } catch { /* report not present or unreadable */ }
    }
  },

  coverageView() {
    if (!this.coverage) return null;
    const groups = new Map();
    for (const f of this.coverage.files) {
      const key = moduleOf(f.file);
      const g = groups.get(key) || { name: key, covered: 0, lines: 0 };
      g.covered += f.covered; g.lines += f.lines;
      groups.set(key, g);
    }
    return {
      total: this.coverage.total, source: this.coverage.source,
      modules: [...groups.values()].map((g) => ({ name: g.name, pct: g.lines ? Math.round((g.covered / g.lines) * 100) : 100 })).sort((a, b) => a.pct - b.pct).slice(0, 20),
      weakest: this.coverage.files.slice().sort((a, b) => a.pct - b.pct).slice(0, 10)
    };
  },

  /** Source files with symbols that no test imports, directly or indirectly. */
  untested() {
    const tests = [...this.index.values()].filter((i) => i.isTest).map((i) => i.path);
    const reached = walk(this.graph.deps, tests, 4);
    const stems = new Set(tests.map((t) => t.split('/').pop().toLowerCase().replace(/\.(test|spec)(?=\.)/, '').replace(/^test_|_test(?=\.)|_spec(?=\.)|tests?(?=\.)/, '').replace(/\.\w+$/, '')));
    return [...this.index.values()]
      .filter((i) => !i.isTest && !['sql', 'prisma'].includes(i.lang) && i.symbols.some((s) => s.kind !== 'type') && !reached.has(i.path) && !stems.has(i.path.split('/').pop().toLowerCase().replace(/\.\w+$/, '')))
      .map((i) => i.path).slice(0, 100);
  },

  async generateTest(file) {
    this.requireWorkspace();
    const info = this.index.get(file);
    if (!info || info.isTest) throw new Error('Choose a source file that is not already a test.');
    const out = skeleton(file, info, { framework: this.project && this.project.framework, esm: !!this.pkg && this.pkg.type === 'module' });
    if (!out) throw new Error('Test generation supports JavaScript, TypeScript, Python and Go.');
    const uri = this.uri(out.path);
    let exists = true;
    try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
    if (!exists) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(out.content, 'utf8'));
      await this.updateFiles([uri]);
    }
    await this.open(out.path);
    vscode.window.showInformationMessage(exists ? 'Forge: that test file already exists, so it was opened unchanged.' : 'Forge: test skeleton created. Add your assertions.');
  }
};
