'use strict';
// Minimal in-memory stand-in for the VS Code API, used by the integration test.
const fs = require('fs');
const path = require('path');
const { globToRegex } = require('../../src/lib/util');

const log = { errors: [], warnings: [], info: [], documents: [], posted: [] };
class Disposable { dispose() {} }
class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return new Disposable(); }; }
  fire(v) { for (const fn of this.listeners) fn(v); }
}
class Uri {
  constructor(p, scheme = 'file') { this.fsPath = p; this.scheme = scheme; }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(a, b, c, d) { this.start = typeof a === 'number' ? new Position(a, b) : a; this.end = typeof a === 'number' ? new Position(c, d) : b; } }

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (['.git', 'node_modules'].includes(e.name) ? [] : walk(p, base)) : [path.relative(base, p).replace(/\\/g, '/')];
});
const events = {};
const hook = (name) => (fn) => { events[name] = fn; return new Disposable(); };
const commands = new Map();
const settings = {};
const answers = { warning: 'Allow', info: 'Allow', input: 'test commit', diagnostics: [] };
const folder = { name: 'demo', uri: null };

const api = {
  _test: { log, events, commands, settings, answers, folder },
  Disposable, EventEmitter, Uri, Position, Range,
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ProgressLocation: { Window: 10, Notification: 15 }, StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: -1, One: 1 },
  TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
  CodeAction: class {}, CodeActionKind: { QuickFix: 'quickfix' }, WorkspaceEdit: class { insert() {} },
  workspace: {
    get workspaceFolders() { return [folder]; }, isTrusted: true,
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : k === 'exclude' ? ['node_modules', '.git', 'coverage'] : d) }),
    findFiles: async (rel) => {
      const re = globToRegex(rel.pattern);
      return walk(folder.uri.fsPath).filter((f) => re.test(f) && !f.startsWith('coverage/')).map((f) => Uri.joinPath(folder.uri, f));
    },
    fs: {
      stat: async (u) => fs.promises.stat(u.fsPath), readFile: async (u) => fs.promises.readFile(u.fsPath),
      writeFile: async (u, b) => fs.promises.writeFile(u.fsPath, b), createDirectory: async (u) => fs.promises.mkdir(u.fsPath, { recursive: true })
    },
    openTextDocument: async (x) => {
      if (x.content !== undefined) { log.documents.push(x.content); return { lineCount: 1 }; }
      return { lineCount: fs.readFileSync(x.fsPath, 'utf8').split('\n').length };
    },
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
    onDidSaveTextDocument: hook('save'), onDidChangeConfiguration: hook('config'), onDidGrantWorkspaceTrust: hook('trust')
  },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerTreeDataProvider: (_id, provider) => { api._test.tree = provider; return new Disposable(); },
    showErrorMessage: async (m) => { log.errors.push(m); }, showWarningMessage: async (m, o) => { log.warnings.push(m); return o && o.modal ? (m.startsWith('Deploy') ? 'Deploy' : answers.warning) : undefined; },
    showInformationMessage: async (m, o) => { log.info.push(m); return o && o.modal ? answers.info : undefined; },
    showInputBox: async () => answers.input, showQuickPick: async (items) => items[0], showTextDocument: async () => {},
    withProgress: async (_o, fn) => fn({}, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
    createWebviewPanel: () => {
      const panel = { reveal() {}, dispose() {}, onDidDispose() {}, webview: { cspSource: 'self', asWebviewUri: (u) => u.fsPath, onDidReceiveMessage() {}, postMessage: (m) => log.posted.push(m) } };
      api._test.panel = panel;
      return panel;
    }
  },
  languages: {
    createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }), getDiagnostics: () => answers.diagnostics,
    onDidChangeDiagnostics: hook('diagnostics'), registerCodeActionsProvider: () => new Disposable()
  },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return new Disposable(); }, executeCommand: async (id, ...a) => (commands.has(id) ? commands.get(id)(...a) : undefined) },
  tasks: { onDidEndTaskProcess: hook('task') },
  debug: { registerDebugAdapterTrackerFactory: (_t, f) => { events.debug = f; return new Disposable(); } },
  env: { clipboard: { readText: async () => '' } }
};
module.exports = api;
