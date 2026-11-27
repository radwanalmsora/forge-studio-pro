'use strict';
const test = require('node:test');
const assert = require('node:assert');
const parser = require('../src/lib/parser');
const graph = require('../src/lib/graph');
const { scanText } = require('../src/lib/scanner');
const testing = require('../src/lib/testing');
const http = require('../src/lib/http');
const workflow = require('../src/lib/workflow');
const incident = require('../src/lib/incident');
const health = require('../src/lib/health');
const util = require('../src/lib/util');

const index = (files) => new Map(Object.entries(files).map(([f, t]) => [f, parser.parseFile(f, t)]));

test('routes are detected across frameworks', () => {
  const find = (f, t) => parser.parseEndpoints(f, t).map((e) => `${e.method} ${e.path}`);
  assert.deepStrictEqual(find('a.js', "router.get('/u/:id', h)"), ['GET /u/:id']);
  assert.deepStrictEqual(find('a.py', '@app.route("/x", methods=["POST"])'), ['POST /x']);
  assert.deepStrictEqual(find('A.java', '@RequestMapping("/api")\npublic class A {\n@GetMapping("/y")\n}'), ['GET /api/y']);
  assert.deepStrictEqual(find('c.ts', "@Controller('cats')\nclass C { @Get(':id') one() {} }"), ['GET /cats/:id']);
  assert.deepStrictEqual(find('app/api/z/route.ts', 'export async function GET() {}'), ['GET /api/z']);
  assert.deepStrictEqual(find('m.go', 'r.GET("/ping", h)'), ['GET /ping']);
});

test('API consumers match routes with parameters', () => {
  const calls = parser.parseApiCalls('w.js', 'axios.get(`${BASE}/users/${id}`)');
  assert.ok(parser.routeMatches({ method: 'GET', path: '/users/:id' }, calls[0]));
});

test('graph resolves imports, impact and related tests', () => {
  const i = index({ 'src/a.ts': "import { b } from './b';\nexport function a() {}", 'src/b.ts': 'export function b() {}', 'test/a.test.ts': "import { a } from '../src/a';",
    'pkg/m.py': 'from . import n\n', 'pkg/n.py': 'def n(): pass' });
  const g = graph.buildGraph(i);
  assert.deepStrictEqual(g.deps.get('src/a.ts'), ['src/b.ts']);
  assert.deepStrictEqual(g.deps.get('pkg/m.py'), ['pkg/n.py']);
  assert.deepStrictEqual(graph.relatedTests(i, g, 'src/b.ts'), ['test/a.test.ts']);
});

test('scanner finds risks, masks secrets and honors ignores', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const [f] = scanText('c.js', `const k = '${key}';`);
  assert.strictEqual(f.rule, 'aws-key');
  assert.ok(!f.evidence.includes(key));
  const value = 'q8Zr2LmN' + 'p7VxT4';
  assert.ok(!scanText('s.js', `const API_SECRET = '${value}';`)[0].evidence.includes(value));
  assert.strictEqual(scanText('q.js', 'db.query("SELECT * FROM t WHERE a=\'" + a + "\'")')[0].rule, 'sql-concat');
  assert.strictEqual(scanText('e.js', '// forge-ignore-next-line\neval(x)').length, 0);
  assert.strictEqual(scanText('ok.js', "const password = process.env.PASSWORD; el.innerHTML = '';").length, 0);
});

test('test output is parsed for common runners', () => {
  const p = (t, c = 1) => testing.parseTestOutput(t, c);
  assert.strictEqual(p('Tests:       3 failed, 12 passed, 15 total').failed, 3);
  assert.strictEqual(p('  Tests  1 failed | 4 passed (5)').passed, 4);
  assert.strictEqual(p('# pass 2\n# fail 1').failed, 1);
  assert.strictEqual(p('=== 2 failed, 5 passed in 1s ===').failed, 2);
  assert.strictEqual(p('Tests run: 5, Failures: 1, Errors: 1, Skipped: 0').passed, 3);
  assert.ok(p('12 passing', 0).ok);
  assert.strictEqual(testing.relatedCommand({ related: 'jest', framework: 'jest' }, ['a$(x).js']), null);
});

test('coverage reports are read', () => {
  assert.strictEqual(testing.parseCoverage('SF:/r/a.js\nLF:4\nLH:1\nend_of_record\n', '/r').files[0].pct, 25);
});

test('requests interpolate variables and validate schemas', () => {
  const r = http.buildRequest({ url: '{{base}}/x', authType: 'bearer', authValue: '{{t}}' }, { base: 'http://h', t: 'abc' });
  assert.strictEqual(r.headers.Authorization, 'Bearer abc');
  assert.throws(() => http.buildRequest({ url: '{{nope}}/x' }), /not defined/);
  assert.throws(() => http.buildRequest({ url: 'file:///etc/passwd' }), /Only http/);
  assert.strictEqual(http.validateSchema({ id: 'x' }, { type: 'object', required: ['id', 'n'], properties: { id: { type: 'integer' } } }).length, 2);
});

test('workflows stop at the first failing step', async () => {
  const [w] = workflow.normalize([{ name: 'w', steps: [{ type: 'build' }, { type: 'report' }, { type: 'bogus' }] }]);
  const r = await workflow.run(w, { build: async () => ({ status: 'failed' }), report: async () => ({ status: 'passed' }) });
  assert.deepStrictEqual(r.steps.map((s) => s.status), ['failed', 'skipped']);
});

test('stack traces and incidents', () => {
  const i = incident.create({ message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: '    at login (/r/src/a.js:3:5)\n  File "/r/b.py", line 4, in run', files: new Map([['src/a.js', 1], ['b.py', 1]]), root: '/r' });
  assert.deepStrictEqual(i.files, ['src/a.js', 'b.py']);
  assert.match(i.cause, /missing/);
});

test('problem numbers and status persist', () => {
  let r = health.reconcile({}, [{ key: 'a', severity: 'high' }]);
  r.items.a.status = 'Investigating';
  r = health.reconcile(r, [{ key: 'a', severity: 'high' }]);
  assert.strictEqual(r.items.a.status, 'Investigating');
  r = health.reconcile(r, []);
  assert.strictEqual(r.items.a.status, 'Resolved');
  assert.strictEqual(health.open(r).length, 0);
});

test('shell paths reject metacharacters', () => {
  assert.strictEqual(util.shellPath('a;rm -rf.js'), null);
  assert.strictEqual(util.shellPath('app/[id]/x.test.ts'), '"app/[id]/x.test.ts"');
});
