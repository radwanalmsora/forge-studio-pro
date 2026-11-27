'use strict';
const vscode = require('vscode');
const health = require('../lib/health');

class SystemsView {
  constructor(forge) {
    this.forge = forge;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(parent) {
    if (parent || !this.forge.root) return [];
    const problems = health.open(this.forge.data.registry).length;
    const t = this.forge.data.tests;
    const open = this.forge.data.incidents.filter((i) => !i.closed).length;
    return [
      ['command', 'Command Center', 'dashboard', ''],
      ['problems', 'Problem Solver', 'issues', problems ? `${problems} open` : ''],
      ['understanding', 'Project Understanding', 'type-hierarchy', `${this.forge.index.size} files`],
      ['workflows', 'Workflow Automation', 'git-merge', `${this.forge.workflows.length}`],
      ['testing', 'Testing Universe', 'beaker', t ? (t.ok ? 'passing' : 'failing') : ''],
      ['debugging', 'Debugging Universe', 'debug', open ? `${open} incidents` : ''],
      ['security', 'Security and Privacy', 'shield', `${this.forge.securityFindings().length || ''}`],
      ['api', 'API Studio', 'plug', '']
    ].map(([id, label, icon, description]) => {
      const item = new vscode.TreeItem(label);
      item.iconPath = new vscode.ThemeIcon(icon);
      item.description = description;
      item.command = { command: 'forge.open', title: 'Open', arguments: [id] };
      return item;
    });
  }
}

module.exports = { SystemsView };
