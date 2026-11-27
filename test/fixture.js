'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AUTH = 'src/auth';
const files = {
  'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'node --check src/server.js' }, dependencies: { express: '^4', pg: '^8' } }, null, 2),
  [`${AUTH}/tokenManager.js`]: "function issueToken(user) {\n  return `t-${user.id}`;\n}\nmodule.exports = { issueToken };\n",
  [`${AUTH}/userRepository.js`]: "function findUser(db, name) {\n  return db.query(\"SELECT * FROM users WHERE name = '\" + name + \"'\");\n}\nmodule.exports = { findUser };\n",
  [`${AUTH}/authService.js`]: "const { issueToken } = require('./tokenManager');\nconst { findUser } = require('./userRepository');\nfunction login(db, name) {\n  const user = findUser(db, name);\n  return issueToken(user);\n}\nmodule.exports = { login };\n",
  [`${AUTH}/authController.js`]: "const { login } = require('./authService');\nfunction register(app, db) {\n  app.post('/auth/login', (req, res) => res.json({ token: login(db, req.body.name) }));\n  app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));\n}\nmodule.exports = { register };\n",
  'src/server.js': "const { register } = require('./auth/authController');\n// TODO: add rate limiting\nconst API_SECRET = 'q8Zr2LmNp7VxT4';\nmodule.exports = { register, API_SECRET };\n", // forge-ignore
  'src/web/loginScreen.js': "export async function submit(name) {\n  return fetch('/auth/login', { method: 'POST', body: name });\n}\n",
  'src/billing/paymentService.js': 'function refund(amount) {\n  return -amount;\n}\nmodule.exports = { refund };\n',
  'test/authService.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { login } = require('../src/auth/authService');\ntest('login returns a token', () => assert.strictEqual(login({ query: () => ({ id: 1 }) }, 'a'), 't-1'));\ntest('login rejects unknown users', () => assert.throws(() => login({ query: () => null }, 'x'), /unknown/));\n",
  'db/schema.sql': 'CREATE TABLE users (id INT PRIMARY KEY, name TEXT);\nCREATE TABLE sessions (id INT);\n',
  'coverage/lcov.info': 'SF:src/auth/authService.js\nLF:10\nLH:9\nend_of_record\nSF:src/billing/paymentService.js\nLF:10\nLH:3\nend_of_record\n'
};

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'Dev');
  git('add', '.'); git('commit', '-qm', 'initial');
  fs.appendFileSync(path.join(dir, AUTH, 'authService.js'), '// changed\n');
  return dir;
}

module.exports = { createFixture };
