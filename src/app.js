'use strict';
const vscode = require('vscode');
const nodePath = require('path');
const { git, shell, parseStatus } = require('./exec');
const { parseFile, langOf, routeMatches } = require('./lib/parser');
const { buildGraph, impact, search, tree, walk } = require('./lib/graph');
const { scanText, securityLayers } = require('./lib/scanner');
const health = require('./lib/health');
const { detectProject, duplicateTests } = require('./lib/testing');
const { hash, posix, uniq, moduleOf } = require('./lib/util');
const { STEP_TYPES, TRIGGERS } = require('./lib/workflow');

const SOURCE_EXT = 'js,jsx,ts,tsx,mjs,cjs,vue,svelte,py,java,kt,go,rs,php,rb,cs,sql,prisma';
const SCAN_EXT = 'json,yml,yaml,toml,ini,properties,xml,csv,log,txt,pem,key,sh,conf,cfg,gradle';
const MAX_FILE = 512 * 1024;
const PERSIST = ['registry', 'incidents', 'tests', 'build', 'deps', 'deployments', 'runs', 'history', 'collections'];

class Forge {
  constructor(context) {
    this.context = context;
    const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file');
    this.folder = folder;
    this.root = folder ? folder.uri.fsPath : null;
    this.index = new Map();
    this.graph = buildGraph(this.index);
    this.findings = new Map();
    this.gitState = { available: false, branch: '', changes: [] };
    this.allFiles = [];
    this.workflows = [];
    this.busy = new Map();
    this.running = new Set();
    const saved = context.workspaceState.get('forge.state', {});
    this.data = { registry: { next: 1, items: {} }, incidents: [], tests: null, build: null, deps: null, deployments: [], runs: [], history: [], collections: [] };
    for (const k of PERSIST) if (saved[k] !== undefined) this.data[k] = saved[k];
    this.view = {};
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    this.diagnostics = vscode.languages.createDiagnosticCollection('forge-security');
    context.subscriptions.push(this.changed, this.diagnostics);
  }

  config() { return vscode.workspace.getConfiguration('forge', this.folder && this.folder.uri); }
  uri(file) { return vscode.Uri.joinPath(this.folder.uri, file); }
  rel(uri) {
    if (!this.root || uri.scheme !== 'file') return null;
    const r = posix(nodePath.relative(this.root, uri.fsPath));
    return r && r !== '..' && !r.startsWith('../') && !nodePath.isAbsolute(r) ? r : null;
  }
  excluded() { return this.config().get('exclude', []).filter((x) => /^[\w.-]+$/.test(x)); }
  isExcluded(file) { const ex = new Set(this.excluded()); return file.split('/').slice(0, -1).some((p) => ex.has(p)); }
  requireWorkspace() { if (!this.root) throw new Error('Open a project folder first.'); }

  emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.changed.fire(), 120);
  }
  async save() {
    const out = {};
    for (const k of PERSIST) out[k] = this.data[k];
    await this.context.workspaceState.update('forge.state', out);
  }
  async commit() { this.refreshProblems(); await this.save(); this.emit(); }

  async withBusy(label, fn, cancellable = false) {
    const id = Symbol(label);
    this.busy.set(id, label);
    this.emit();
    try {
      return await vscode.window.withProgress({ location: cancellable ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: `Forge: ${label}`, cancellable },
        (_p, token) => fn(token));
    } finally { this.busy.delete(id); this.emit(); }
  }

  /** Commands that come from the project always need trust and a one-time confirmation. */
  async approve(command) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running project commands.');
    const approved = this.context.workspaceState.get('forge.approved', []);
    const key = hash(command);
    if (approved.includes(key)) return;
    const answer = await vscode.window.showWarningMessage('Allow Forge Studio Pro to run this command in your project?', { modal: true, detail: command }, 'Allow');
    if (answer !== 'Allow') throw new Error('Command was not approved.');
    await this.context.workspaceState.update('forge.approved', [...approved, key]);
  }

  async execute(command, label, token) {
    await this.approve(command);
    if (token) return shell(command, this.root, { token, timeout: this.config().get('commandTimeout', 600) * 1000 });
    return this.withBusy(label, (t) => shell(command, this.root, { token: t, timeout: this.config().get('commandTimeout', 600) * 1000 }), true);
  }

  async readText(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE) return null;
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      return text.includes('\u0000') ? null : text;
    } catch { return null; }
  }

  async scan() {
    if (!this.root) return;
    if (this.scanning) return this.scanning;
    this.scanning = this.withBusy('Scanning project', async () => {
      const ex = this.excluded();
      const exclude = ex.length ? `**/{${ex.join(',')},_none_}/**` : null;
      const max = this.config().get('maxFiles', 5000);
      const find = (glob, n) => vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, glob), exclude, n);
      const [source, other, env] = await Promise.all([find(`**/*.{${SOURCE_EXT}}`, max), find(`**/*.{${SCAN_EXT}}`, max), find('**/.env*', 50)]);
      const uris = [...source, ...other, ...env];
      this.truncated = source.length >= max;
      const index = new Map();
      const findings = new Map();
      for (let i = 0; i < uris.length; i += 40) {
        await Promise.all(uris.slice(i, i + 40).map(async (uri) => {
          const file = this.rel(uri);
          const text = file && await this.readText(uri);
          if (text === null || text === undefined || text === false) return;
          if (langOf(file)) index.set(file, parseFile(file, text));
          const found = await this.scanFile(file, text);
          if (found.length) findings.set(file, found);
        }));
      }
      this.index = new Map([...index].sort((a, b) => a[0].localeCompare(b[0])));
      this.findings = findings;
      this.allFiles = uris.map((u) => this.rel(u)).filter(Boolean);
      await this.loadProject();
      this.rebuild();
      this.publishDiagnostics();
      await this.refreshGit();
      await this.loadCoverage();
      await this.detectDatabase();
      this.lastScan = Date.now();
      await this.commit();
    });
    try { await this.scanning; } finally { this.scanning = null; }
  }

  async scanFile(file, text) {
    const found = scanText(file, text);
    if (found.length && vscode.workspace.isTrusted && /(^|\/)\.env/.test(file) && (await git(['check-ignore', '-q', '--', file], this.root)) !== null) return [];
    return found;
  }

  async updateFiles(uris) {
    for (const uri of uris) {
      const file = this.rel(uri);
      if (!file || this.isExcluded(file)) continue;
      if (!new RegExp(`(\\.(${(SOURCE_EXT + ',' + SCAN_EXT).replace(/,/g, '|')})|(^|/)\\.env[^/]*)$`, 'i').test(file)) {
        await this.forgetDeletedFolder(uri, file);
        continue;
      }
      const text = await this.readText(uri);
      this.index.delete(file);
      this.findings.delete(file);
      this.allFiles = this.allFiles.filter((f) => f !== file);
      if (text === null) continue;
      this.allFiles.push(file);
      if (langOf(file)) this.index.set(file, parseFile(file, text));
      const found = await this.scanFile(file, text);
      if (found.length) this.findings.set(file, found);
    }
    await this.loadProject();
    this.rebuild();
    this.publishDiagnostics();
    await this.refreshGit();
    await this.commit();
  }

  async forgetDeletedFolder(uri, folder) {
    const prefix = `${folder}/`;
    if (!this.allFiles.some((f) => f.startsWith(prefix))) return;
    try { await vscode.workspace.fs.stat(uri); return; } catch { /* the folder was removed */ }
    for (const f of this.allFiles.filter((x) => x.startsWith(prefix))) { this.index.delete(f); this.findings.delete(f); }
    this.allFiles = this.allFiles.filter((f) => !f.startsWith(prefix));
  }

  async loadProject() {
    const read = (f) => this.readText(this.uri(f));
    let pkg = null;
    const raw = await read('package.json');
    if (raw) { try { pkg = JSON.parse(raw); } catch { pkg = null; } }
    this.pkg = pkg;
    const gomod = await read('go.mod');
    this.goModule = gomod ? (/^module\s+(\S+)/m.exec(gomod) || [])[1] : undefined;
    const markers = [];
    for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'pytest.ini', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml']) {
      try { await vscode.workspace.fs.stat(this.uri(f)); markers.push(f); } catch { /* not present */ }
    }
    this.markers = markers;
    const project = detectProject({ pkg, files: [...this.allFiles, ...markers] });
    const cfg = this.config();
    if (cfg.get('testCommand')) project.test = cfg.get('testCommand');
    if (cfg.get('buildCommand')) project.build = cfg.get('buildCommand');
    this.project = project;
  }

  rebuild() {
    this.graph = buildGraph(this.index, this.goModule);
    this.cycles = this.findCycles();
  }

  findCycles() {
    const state = new Map();
    const stack = [];
    const out = [];
    const seen = new Set();
    for (const start of this.graph.deps.keys()) {
      if (state.has(start) || out.length >= 10) continue;
      const todo = [[start, 0]];
      state.set(start, 1); stack.push(start);
      while (todo.length) {
        const top = todo[todo.length - 1];
        const next = this.graph.deps.get(top[0])[top[1]++];
        if (next === undefined) { state.set(top[0], 2); stack.pop(); todo.pop(); continue; }
        if (!state.has(next)) { state.set(next, 1); stack.push(next); todo.push([next, 0]); }
        else if (state.get(next) === 1 && out.length < 10) {
          const cycle = stack.slice(stack.indexOf(next));
          const key = cycle.slice().sort().join('|');
          const js = this.index.get(next).lang !== 'java';
          if (js && !seen.has(key)) { seen.add(key); out.push(cycle); }
        }
      }
    }
    return out;
  }

  async refreshGit() {
    if (!this.root) return;
    // A repository's Git configuration can start programs, so Git waits for workspace trust.
    if (!vscode.workspace.isTrusted) { this.gitState = { available: false, branch: '', changes: [] }; return; }
    const prefix = await git(['rev-parse', '--show-prefix'], this.root);
    if (prefix === null) { this.gitState = { available: false, branch: '', changes: [] }; return; }
    const [branch, status] = await Promise.all([git(['branch', '--show-current'], this.root), git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], this.root)]);
    this.gitState = { available: true, branch: (branch || '').trim() || 'detached', changes: parseStatus(status, prefix.trim()).filter((c) => !this.isExcluded(c.file)) };
  }

  changedFiles() { return uniq(this.gitState.changes.map((c) => c.file)); }
  securityFindings() { return [...this.findings.values()].flat(); }

  publishDiagnostics() {
    this.diagnostics.clear();
    if (!this.root) return;
    const sev = { critical: vscode.DiagnosticSeverity.Error, high: vscode.DiagnosticSeverity.Warning, medium: vscode.DiagnosticSeverity.Warning, low: vscode.DiagnosticSeverity.Information };
    for (const [file, list] of this.findings) {
      this.diagnostics.set(this.uri(file), list.map((f) => {
        const d = new vscode.Diagnostic(new vscode.Range(f.line - 1, f.column, f.line - 1, 2000), `${f.title}. ${f.fix}`, sev[f.severity]);
        d.source = 'Forge Security';
        d.code = f.rule;
        return d;
      }));
    }
  }

  detectProblems() {
    const out = [];
    const add = (p) => out.push({ severity: 'medium', file: '', line: 1, ...p });
    if (this.root) for (const [uri, list] of vscode.languages.getDiagnostics()) {
      const file = this.rel(uri);
      if (!file || this.isExcluded(file)) continue;
      for (const d of list) {
        if (out.length > 600 || d.source === 'Forge Security' || d.severity > vscode.DiagnosticSeverity.Warning) continue;
        const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'high' : 'medium';
        add({ source: 'diagnostics', type: health.classify(`${d.message} ${file}`, severity), severity, file, line: d.range.start.line + 1, title: d.message.split('\n')[0].slice(0, 200), key: hash(`d|${file}|${d.source}|${d.message}`) });
      }
    }
    for (const f of this.securityFindings()) add({ source: 'security', type: 'Security Vulnerability', severity: f.severity, file: f.file, line: f.line, title: f.title, key: f.key });
    const t = this.data.tests;
    if (t && !t.ok) {
      const list = t.failures.length ? t.failures : [{ name: 'Test run failed' }];
      for (const f of list) add({ source: 'tests', type: 'Test Failure', severity: 'high', file: f.file, line: f.line, title: f.name });
    }
    if (this.data.build && !this.data.build.ok) add({ source: 'build', type: 'Compilation Error', severity: 'critical', title: 'Build failed' });
    for (const c of this.gitState.changes.filter((x) => x.conflict)) add({ source: 'git', type: 'Git Conflict', severity: 'critical', file: c.file, title: 'Unresolved merge conflict' });
    for (const v of (this.data.deps && this.data.deps.packages) || []) add({ source: 'dependencies', type: 'Security Vulnerability', severity: v.severity, file: 'package.json', title: `Vulnerable dependency: ${v.name}` });
    const dep = this.data.deployments[0];
    if (dep && !dep.ok) add({ source: 'deploy', type: 'Deployment Failure', severity: 'critical', title: 'Last deployment failed' });
    for (const i of this.data.incidents.filter((x) => !x.closed)) {
      const frame = i.frames.find((f) => f.local);
      add({ source: 'incident', type: i.source === 'task' ? 'Environment Issue' : 'Runtime Error', severity: 'high', file: frame && frame.local, line: frame && frame.line, title: i.message.split('\n')[0].slice(0, 200), key: `i${i.signature}` });
    }
    for (const c of this.cycles || []) add({ source: 'architecture', type: 'Architecture Problem', severity: 'low', file: c[0], title: `Circular dependency: ${c.map((f) => nodePath.posix.basename(f)).join(' → ')}` });
    return out;
  }

  refreshProblems() {
    this.data.registry = health.reconcile(this.data.registry, this.detectProblems());
  }

  async open(file, line = 1) {
    this.requireWorkspace();
    const uri = this.uri(String(file));
    if (!this.rel(uri)) throw new Error('That file is outside the project.');
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, Math.min((Number(line) || 1) - 1, doc.lineCount - 1)), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
  }

  async showDocument(content, language = 'markdown') {
    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  analyze(query) { this.view.search = search(this.index, this.graph, String(query)); this.emit(); }
  showImpact(file) {
    if (!this.index.has(file)) throw new Error('This file is not part of the project index.');
    this.view.impact = { ...impact(this.index, this.graph, file), tree: tree(this.graph.users, file, 3), symbols: this.index.get(file).symbols.slice(0, 60) };
    this.emit();
  }

  selectProblem(key) {
    const p = this.data.registry.items[key];
    if (!p) return;
    const known = p.file && this.index.has(p.file);
    this.view.problem = { key, tree: known ? tree(this.graph.users, p.file, 3) : null, systems: known ? impact(this.index, this.graph, p.file).systems : [], tests: known ? impact(this.index, this.graph, p.file).tests : [] };
    this.emit();
  }

  async setProblemStatus(key, status) {
    if (!['Open', 'Investigating', 'Ignored'].includes(status) || !this.data.registry.items[key]) return;
    this.data.registry.items[key].status = status;
    await this.commit();
  }

  endpoints() {
    const calls = [...this.index.values()].flatMap((i) => i.calls);
    return [...this.index.values()].flatMap((i) => i.endpoints).slice(0, 500).map((e) => ({
      ...e, consumers: calls.filter((c) => routeMatches(e, c)).slice(0, 30).map((c) => ({ file: c.file, line: c.line }))
    }));
  }

  healthInput() {
    const deps = this.data.deps;
    const todos = [...this.index.values()].reduce((a, f) => a + f.todos, 0);
    return { problems: health.open(this.data.registry), tests: this.data.tests, build: this.data.build, outdated: deps && deps.outdated, vulnerabilities: deps && deps.vulnerabilities, todos, gitChanges: this.gitState.changes };
  }

  score() { return this.lastScan ? health.health(this.healthInput()) : null; }

  snapshot() {
    const reg = this.data.registry;
    const input = this.healthInput();
    const { problems, todos } = input;
    const files = [...this.index.values()];
    const findings = this.securityFindings().sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity));
    const modules = new Map();
    for (const f of files) if (!f.isTest) modules.set(moduleOf(f.path), (modules.get(moduleOf(f.path)) || 0) + 1);
    return {
      workspace: this.folder ? this.folder.name : null,
      trusted: vscode.workspace.isTrusted,
      busy: [...this.busy.values()],
      lastScan: this.lastScan || null,
      truncated: !!this.truncated,
      health: this.score(),
      actions: health.actions(input),
      stats: { files: files.length, symbols: files.reduce((a, f) => a + f.symbols.length, 0), lines: files.reduce((a, f) => a + f.lines, 0), links: [...this.graph.deps.values()].reduce((a, d) => a + d.length, 0), todos, testFiles: files.filter((f) => f.isTest).length },
      modules: [...modules].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
      files: files.map((f) => f.path).slice(0, 3000),
      project: this.project || {},
      git: { ...this.gitState, changes: this.gitState.changes.slice(0, 200), total: this.gitState.changes.length },
      problems: problems.slice(0, 300), problemTotal: problems.length,
      ignored: Object.values(reg.items).filter((p) => p.status === 'Ignored').slice(0, 100),
      resolved: Object.values(reg.items).filter((p) => p.status === 'Resolved').sort((a, b) => b.resolved - a.resolved).slice(0, 20),
      findings: findings.slice(0, 300), findingTotal: findings.length,
      layers: securityLayers([...this.index.keys()], findings),
      tests: this.data.tests, build: this.data.build, deps: this.data.deps, database: this.database || null,
      deployments: this.data.deployments, deployConfigured: !!this.config().get('deployCommand'),
      coverage: this.coverageView(), untested: this.untested(), duplicates: duplicateTests(this.index).slice(0, 30),
      related: this.relatedForChanges(),
      incidents: this.data.incidents,
      workflows: this.workflows, runs: this.data.runs, stepTypes: STEP_TYPES, triggers: TRIGGERS,
      endpoints: this.endpoints(), history: this.data.history, collections: this.data.collections,
      environments: this.environments || {}, response: this.response || null, cookies: this.cookies ? this.cookies.list() : [],
      cycles: this.cycles || [],
      view: this.view
    };
  }

  affectedBy(files) { return uniq([...files, ...walk(this.graph.users, files, 5).keys()]); }
}

Object.assign(Forge.prototype, require('./engines/testing'), require('./engines/workflows'), require('./engines/debugging'), require('./engines/security'), require('./engines/api'));

module.exports = { Forge };
