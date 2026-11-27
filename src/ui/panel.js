'use strict';
const crypto = require('crypto');
const vscode = require('vscode');

class Studio {
  constructor(context, forge) { this.context = context; this.forge = forge; this.panel = null; this.ready = false; }

  snapshot() { return this.forge.snapshot(); }
  post(state = this.snapshot()) { if (this.panel && this.ready) this.panel.webview.postMessage({ type: 'state', state }); }

  show(tab) {
    if (this.panel) {
      this.panel.reveal();
      if (tab) { this.tab = tab; if (this.ready) this.panel.webview.postMessage({ type: 'tab', tab }); }
      return;
    }
    this.tab = tab;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('forge.studio', 'Forge Studio Pro', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    this.panel.webview.onDidReceiveMessage((m) => this.receive(m));
    this.panel.onDidDispose(() => { this.panel = null; this.ready = false; });
    this.panel.webview.html = this.html(this.panel.webview, media);
  }

  async receive(m) {
    const f = this.forge;
    if (!m || typeof m.cmd !== 'string') return;
    const a = m.args || {};
    const actions = {
      ready: () => { this.ready = true; if (this.tab) this.panel.webview.postMessage({ type: 'tab', tab: this.tab }); this.post(); },
      openFolder: () => vscode.commands.executeCommand('vscode.openFolder'),
      scan: () => f.scan(),
      open: () => f.open(a.file, a.line),
      settings: () => vscode.commands.executeCommand('workbench.action.openSettings', 'forge.'),
      build: () => f.runBuild(),
      deploy: () => f.deploy(),
      commit: () => f.commitWithChecks(),
      dependencies: () => f.checkDependencies(),
      database: () => f.checkDatabase(),
      selectProblem: () => f.selectProblem(a.key),
      problemStatus: () => f.setProblemStatus(a.key, a.status),
      search: () => f.analyze(a.query),
      impact: () => f.showImpact(a.file),
      runTests: () => f.runTests(a.scope === 'related' ? 'related' : 'all'),
      generateTest: () => f.generateTest(a.file),
      runWorkflow: () => f.runWorkflow(a.id, { trigger: 'manual' }),
      saveWorkflows: async () => { await f.saveWorkflows(a.workflows); vscode.window.showInformationMessage('Forge: workflows saved to .forge/workflows.json'); },
      openReport: () => f.openReport(a.id),
      analyzeStack: () => f.analyzeStack(a.text),
      selectIncident: () => { f.view.incident = Number(a.id); f.emit(); },
      bugReport: () => f.bugReport(a.id),
      explain: () => f.explainIncident(a.id),
      closeIncident: () => f.closeIncident(a.id, false),
      deleteIncident: () => f.closeIncident(a.id, true),
      securityReport: () => f.securityReport(),
      send: () => f.sendRequest(a.spec),
      saveRequest: () => f.saveRequest(a.name, a.spec),
      deleteRequest: () => f.deleteRequest(a.name),
      clearHistory: () => f.clearHistory(),
      clearCookies: () => f.clearCookies(),
      saveEnvironment: () => f.saveEnvironment(a.name, a.text),
      deleteEnvironment: () => f.saveEnvironment(a.name, null),
      apiTest: () => f.apiTest(),
      openResponse: () => f.openResponse(),
      exportCollections: () => f.exportCollections()
    };
    if (!Object.prototype.hasOwnProperty.call(actions, m.cmd)) return;
    try { await actions[m.cmd](); } catch (e) { vscode.window.showErrorMessage(`Forge: ${e.message || e}`); }
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('app.css')}">
<title>Forge Studio Pro</title>
</head>
<body>
<header><img src="${asset('icon.png')}" alt=""><div><h1>Forge Studio Pro</h1><p id="subtitle">Loading project…</p></div><button data-cmd="scan">Scan project</button></header>
<nav id="tabs" role="tablist"></nav>
<div id="busy" role="status" hidden></div>
<main id="main"></main>
<script nonce="${nonce}" src="${asset('app.js')}"></script>
</body>
</html>`;
  }

  dispose() { if (this.panel) this.panel.dispose(); }
}

module.exports = { Studio };
