'use strict';
// Activates the real extension against a temporary project and drives every system through the webview protocol.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mock = require('./mock/vscode');
const { createFixture } = require('./fixture');

const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? mock : load.call(this, request, ...rest); };

test('all eight systems work end to end', async (t) => {
  // The fixture runs its own test suite, which must not inherit this runner's context.
  delete process.env.NODE_TEST_CONTEXT;
  const dir = createFixture();
  const T = mock._test;
  T.folder.uri = mock.Uri.file(dir);
  const memory = new Map();
  const secrets = new Map();
  const context = {
    subscriptions: [], extensionUri: mock.Uri.file(path.join(__dirname, '..')),
    workspaceState: { get: (k, d) => (memory.has(k) ? memory.get(k) : d), update: async (k, v) => memory.set(k, JSON.parse(JSON.stringify(v))) },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v) }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/users' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/' });
    res.end(JSON.stringify({ id: 1, name: 'Ada' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const { activate } = require('../src/extension');
  const { forge } = activate(context);
  for (let i = 0; i < 200 && !forge.lastScan; i++) await new Promise((r) => setTimeout(r, 50));
  await mock.commands.executeCommand('forge.open');
  const studio = T.panel;
  assert.ok(studio, 'panel created');

  // Reach the Studio instance through the registered command to use the real message handler.
  const { Studio } = require('../src/ui/panel');
  const ui = new Studio(context, forge);
  ui.show();
  const send = (cmd, args) => ui.receive({ cmd, args });
  await send('ready');

  let s = forge.snapshot();
  assert.ok(s.stats.files >= 8, 'indexed');
  assert.strictEqual(s.endpoints.length, 2);
  assert.strictEqual(s.endpoints.find((e) => e.path === '/auth/login').consumers.length, 1);
  assert.ok(s.findings.some((f) => f.rule === 'sql-concat'));
  assert.ok(s.findings.some((f) => f.rule === 'hardcoded-secret'));
  assert.strictEqual(s.database.tables.length, 2);
  assert.ok(s.coverage.modules.length);
  assert.ok(s.related.tests.includes('test/authService.test.js'));
  assert.strictEqual(T.tree.getChildren().length, 8);

  await send('search', { query: 'change how login works' });
  assert.ok(forge.view.search.edit.length);
  await send('impact', { file: 'src/auth/tokenManager.js' });
  assert.ok(forge.view.impact.endpoints.length);

  await send('runTests', { scope: 'all' });
  assert.strictEqual(forge.data.tests.passed, 1);
  assert.strictEqual(forge.data.tests.failed, 1);
  assert.ok(forge.data.tests.failures.some((f) => f.file === 'test/authService.test.js'));
  assert.ok(forge.data.incidents.some((i) => i.source === 'test'), 'failure workflow created an incident');
  await send('runTests', { scope: 'related' });
  assert.match(forge.data.tests.command, /authService\.test\.js/);
  await send('build');
  assert.ok(forge.data.build.ok);
  await send('generateTest', { file: 'src/billing/paymentService.js' });
  const generated = path.join(dir, 'src/billing/paymentService.test.js');
  require('child_process').execFileSync(process.execPath, ['--test', generated], { stdio: 'ignore' });

  const problem = forge.snapshot().problems.find((p) => p.file === 'src/auth/userRepository.js');
  await send('selectProblem', { key: problem.key });
  await send('problemStatus', { key: problem.key, status: 'Investigating' });
  assert.strictEqual(forge.data.registry.items[problem.key].status, 'Investigating');
  assert.ok(forge.view.problem.systems.includes('auth'));

  await send('runWorkflow', { id: 'before-commit' });
  assert.strictEqual(forge.data.runs[0].status, 'failed');
  await send('openReport', { id: 'before-commit' });
  await send('saveWorkflows', { workflows: [{ id: 'mine', name: 'Mine', trigger: 'preDeploy', steps: [{ type: 'command', command: 'node --version' }, { type: 'analyzeChanges' }, { type: 'diagnostics' }, { type: 'aiReview' }, { type: 'securityScan', continueOnFail: true }, { type: 'report' }] }] });
  await send('runWorkflow', { id: 'mine' });
  assert.strictEqual(forge.data.runs[0].steps[0].status, 'passed');
  T.settings.deployCommand = 'node --version';
  forge.workflows[0].steps = [{ type: 'build' }];
  await send('deploy');
  assert.ok(forge.data.deployments[0].ok);

  await send('analyzeStack', { text: "TypeError: Cannot read properties of null\n    at login (" + path.join(dir, 'src/auth/authService.js') + ':4:2)' });
  const incident = forge.data.incidents[0];
  assert.ok(incident.files.includes('src/auth/authService.js'));
  await send('bugReport', { id: incident.id });
  await send('closeIncident', { id: incident.id });
  await T.events.task({ exitCode: 2, execution: { task: { name: 'lint' } } });
  assert.strictEqual(forge.data.incidents[0].source, 'task');
  const session = { id: 's', customRequest: async (c) => ({ exceptionInfo: { description: 'boom' }, stackTrace: { stackFrames: [{ id: 1, name: 'f', line: 1, source: { path: path.join(dir, 'src/server.js') } }] }, scopes: { scopes: [{ variablesReference: 2 }] }, variables: { variables: [{ name: 'password', value: 'hunter2' }] } }[c]) };
  await forge.captureException(session, { threadId: 1 });
  assert.strictEqual(forge.data.incidents[0].variables[0].value, '[hidden]');

  await send('securityReport');
  const base = `http://127.0.0.1:${server.address().port}`;
  await send('saveEnvironment', { name: 'local', text: `baseUrl=${base}` });
  const spec = { method: 'GET', url: '{{baseUrl}}/redirect', environment: 'local', authType: 'bearer', authValue: 'literal-credential', headers: 'X-Api-Key: abc123', schema: '{"type":"object","required":["id"]}' };
  await send('send', { spec });
  assert.strictEqual(forge.response.status, 200);
  assert.deepStrictEqual(forge.response.schema, []);
  assert.strictEqual(forge.cookies.list().length, 1);
  await send('send', { spec });
  assert.deepStrictEqual(forge.response.diff, []);
  await send('saveRequest', { name: 'Get user', spec });
  assert.ok(!JSON.stringify(memory.get('forge.state')).match(/literal-credential|abc123/), 'credentials are not persisted');
  await send('apiTest');
  await send('openResponse');
  await send('exportCollections');
  await send('commit');
  await send('scan');

  // Restricted Mode: analysis continues, Git and project commands do not run.
  mock.workspace.isTrusted = false;
  await send('scan');
  assert.strictEqual(forge.gitState.available, false);
  await assert.rejects(forge.runTests('all'), /Trust this workspace/);
  mock.workspace.isTrusted = true;
  await send('scan');

  const expected = T.log.errors.filter((e) => !/Commit stopped|Stage the changes/.test(e));
  assert.deepStrictEqual(expected, []);
  assert.ok(T.log.documents.some((d) => d.includes('Bug report')));

  if (process.env.FORGE_SNAPSHOT) {
    const { DEFAULTS } = require('../src/lib/workflow');
    await forge.saveWorkflows(DEFAULTS);
    await forge.runWorkflow('before-commit');
    forge.view.incident = incident.id;
    forge.selectProblem(problem.key);
    fs.writeFileSync(process.env.FORGE_SNAPSHOT, JSON.stringify(forge.snapshot()));
  }
});
