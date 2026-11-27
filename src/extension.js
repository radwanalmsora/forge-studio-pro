'use strict';
const vscode = require('vscode');
const { Forge } = require('./app');
const { Studio } = require('./ui/panel');
const { SystemsView } = require('./ui/tree');

function activate(context) {
  const forge = new Forge(context);
  const studio = new Studio(context, forge);
  const tree = new SystemsView(forge);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'forge.open';
  status.text = '$(tools) Forge';
  status.tooltip = 'Open Forge Studio Pro';
  status.show();

  const guard = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { vscode.window.showErrorMessage(`Forge: ${e.message || e}`); }
  };
  const command = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));
  const activeFile = (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    const file = target && forge.rel(target);
    if (!file) throw new Error('Open a file from the project first.');
    return file;
  };

  command('forge.open', (tab) => studio.show(typeof tab === 'string' ? tab : undefined));
  command('forge.scan', () => forge.scan());
  const testCommand = (scope) => async () => {
    const t = await forge.runTests(scope);
    if (t) vscode.window.showInformationMessage(`Forge: tests ${t.ok ? 'passed' : 'failed'} (${t.passed ?? '?'} passed, ${t.failed ?? '?'} failed).`);
  };
  command('forge.runTests', testCommand('all'));
  command('forge.runRelatedTests', testCommand('related'));
  command('forge.runWorkflow', async () => {
    const pick = await vscode.window.showQuickPick(forge.workflows.map((w) => ({ label: w.name, description: w.trigger, id: w.id })), { title: 'Run workflow' });
    if (pick) { studio.show('workflows'); await forge.runWorkflow(pick.id, { trigger: 'manual' }); }
  });
  command('forge.commitWithChecks', () => forge.commitWithChecks());
  command('forge.deploy', () => forge.deploy());
  command('forge.fileImpact', (uri) => { const f = activeFile(uri); forge.showImpact(f); studio.show('understanding'); });
  command('forge.generateTest', (uri) => forge.generateTest(activeFile(uri)));
  command('forge.analyzeStack', async () => {
    const e = vscode.window.activeTextEditor;
    await forge.analyzeStack(e && !e.selection.isEmpty ? e.document.getText(e.selection) : '');
    studio.show('debugging');
  });
  command('forge.securityReport', () => forge.securityReport());

  context.subscriptions.push(status, studio,
    vscode.window.registerTreeDataProvider('forge.systems', tree),
    forge.onDidChange(() => {
      tree.refresh();
      const score = forge.score();
      status.text = forge.busy.size ? '$(sync~spin) Forge' : score === null ? '$(tools) Forge' : `$(tools) Forge ${score}/100`;
      if (studio.panel) studio.post();
    })
  );

  // File changes are batched to keep indexing cheap.
  const pending = new Map();
  let timer;
  const queue = (uri) => {
    const file = forge.rel(uri);
    if (file === '.forge/workflows.json') { guard(() => forge.loadWorkflows())(); return; }
    if (!file || forge.isExcluded(file) || file.startsWith('.git/') || !forge.lastScan) return;
    pending.set(file, uri);
    clearTimeout(timer);
    timer = setTimeout(guard(async () => {
      const uris = [...pending.values()];
      pending.clear();
      if (forge.scanning) await forge.scanning;
      if (uris.length > 200) await forge.scan(); else await forge.updateFiles(uris);
    }), 900);
  };
  if (forge.folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(forge.folder, '**/*'));
    watcher.onDidCreate(queue); watcher.onDidDelete(queue); watcher.onDidChange(queue);
    context.subscriptions.push(watcher);
  }

  let diagTimer;
  const saveTimers = new Map();
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => { clearTimeout(diagTimer); diagTimer = setTimeout(guard(() => forge.commit()), 1500); }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const file = forge.rel(doc.uri);
      if (!file) return;
      if (file === '.forge/workflows.json') { forge.loadWorkflows(); return; }
      if (forge.isExcluded(file)) return;
      clearTimeout(saveTimers.get(file));
      saveTimers.set(file, setTimeout(guard(() => { saveTimers.delete(file); return forge.trigger('onSave', file); }), 1500));
    }),
    vscode.tasks.onDidEndTaskProcess(guard(async (e) => {
      if (!e.exitCode) return;
      await forge.addIncident({ source: 'task', message: `Task "${e.execution.task.name}" exited with code ${e.exitCode}` });
      await forge.trigger('onTaskFailure');
    })),
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: (session) => ({
        onDidSendMessage: (m) => {
          if (m.type === 'event' && m.event === 'stopped' && m.body && m.body.reason === 'exception') guard(() => forge.captureException(session, m.body))();
        }
      })
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('forge')) guard(() => forge.scan())(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(guard(() => forge.scan())),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions(doc, _range, ctx) {
        return ctx.diagnostics.filter((d) => d.source === 'Forge Security' && !/\.(json|csv|pem|key|txt|log)$/.test(doc.fileName)).map((d) => {
          const a = new vscode.CodeAction('Forge: ignore this finding', vscode.CodeActionKind.QuickFix);
          const line = doc.lineAt(d.range.start.line);
          const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
          const style = /\.(py|rb|sh|ya?ml|toml|properties|conf|cfg|ini)$|\.env/.test(doc.fileName) ? ['# ', ''] : /\.(sql|prisma)$/.test(doc.fileName) ? [doc.fileName.endsWith('sql') ? '-- ' : '// ', ''] : /\.(xml)$/.test(doc.fileName) ? ['<!-- ', ' -->'] : ['// ', ''];
          a.edit = new vscode.WorkspaceEdit();
          a.edit.insert(doc.uri, new vscode.Position(line.lineNumber, 0), `${indent}${style[0]}forge-ignore-next-line${style[1]}\n`);
          a.diagnostics = [d];
          return a;
        });
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
  );

  guard(async () => {
    await forge.loadEnvironments();
    await forge.loadWorkflows();
    if (forge.root && forge.config().get('scanOnStartup', true)) {
      await forge.scan();
      await forge.trigger('onOpen');
    }
  })();

  return { forge };
}

function deactivate() {}

module.exports = { activate, deactivate };
