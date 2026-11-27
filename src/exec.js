'use strict';
const { spawn, execFile } = require('child_process');

const LIMIT = 400000;

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { child.kill('SIGKILL'); }
}

/** Run a shell command. Resolves with { code, output, ms, cancelled, timedOut }. */
function shell(command, cwd, { timeout = 600000, token } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let cancelled = false;
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (d) => { output += d.toString(); if (output.length > LIMIT * 2) output = output.slice(-LIMIT); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeout);
    const sub = token && token.onCancellationRequested(() => { cancelled = true; kill(child); });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sub) sub.dispose();
      resolve({ code: cancelled || timedOut ? 1 : code, output: output.slice(-LIMIT) + (timedOut ? '\n[Timed out]' : ''), ms: Date.now() - started, cancelled, timedOut });
    };
    child.on('error', (e) => { output += e.message; finish(127); });
    child.on('close', (code) => finish(code === null ? 1 : code));
  });
}

/** Run git without a shell. Resolves null when git fails. */
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 30000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseStatus(out, prefix = '') {
  const parts = String(out || '').split('\0');
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const status = e.slice(0, 2);
    let file = e.slice(3);
    if (/[RC]/.test(status)) i++;
    if (prefix) { if (!file.startsWith(prefix)) continue; file = file.slice(prefix.length); }
    changes.push({ file, status: status.trim(), conflict: /^(DD|AU|UD|UA|DU|AA|UU)$/.test(status), staged: !/^[ ?]/.test(status) });
  }
  return changes;
}

module.exports = { shell, git, parseStatus };
