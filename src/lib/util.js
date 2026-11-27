'use strict';
const crypto = require('crypto');
const path = require('path');

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const posix = (p) => String(p).replace(/\\/g, '/');
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
const tail = (s, n = 6000) => (s.length > n ? '…' + s.slice(-n) : s);
const uniq = (a) => [...new Set(a)];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Top-level "system" a file belongs to, e.g. src/auth/session.ts -> auth */
function moduleOf(file) {
  const parts = posix(file).split('/');
  parts.pop();
  const skip = new Set(['src', 'app', 'lib', 'main', 'java', 'packages', 'apps']);
  const dir = parts.find((p) => !skip.has(p));
  return dir || path.posix.basename(posix(file)).replace(/\.\w+$/, '');
}

/** Quote a repository path for a shell command; returns null when it is not safe to pass. */
function shellPath(p) {
  if (!/^[\p{L}\p{N}_@.+,=\/\\ \-()[\]]+$/u.test(p) || p.startsWith('-')) return null;
  return `"${p}"`;
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > 0) {
      const end = glob.indexOf('}', i);
      out += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRegex).join('|') + ')';
      i = end;
    } else out += escapeRegex(c);
  }
  return new RegExp('^' + out + '$');
}

module.exports = { hash, posix, stripAnsi, tail, uniq, escapeRegex, moduleOf, shellPath, globToRegex };
