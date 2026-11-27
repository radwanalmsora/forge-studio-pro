'use strict';
const path = require('path').posix;
const { hash, posix, uniq, stripAnsi } = require('./util');

const PYTHON = /File "([^"]+)", line (\d+)(?:, in (\S+))?/;
const JAVA = /\bat\s+([\w.$<>]+)\(([\w$]+\.(?:java|kt)):(\d+)\)/;
const JS = /\bat\s+(?:(.+?)\s+\()?((?:file:\/\/)?[^()\n]+?):(\d+):(\d+)\)?/;
const GENERIC = /^\s*(?:[^\s:]+\s+)??((?:[A-Za-z]:)?[^\s:()]+\.[A-Za-z]\w{0,4}):(\d+)/;

function parseStack(text) {
  const frames = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (line.length > 1000) continue;
    let m;
    if ((m = PYTHON.exec(line))) frames.push({ file: m[1], line: +m[2], fn: m[3] || '' });
    else if ((m = JAVA.exec(line))) frames.push({ file: m[1].split('.').slice(0, -2).concat(m[2]).join('/'), line: +m[3], fn: m[1] });
    else if ((m = JS.exec(line))) frames.push({ file: m[2].replace(/^file:\/\//, ''), line: +m[3], fn: m[1] || '' });
    else if ((m = GENERIC.exec(line))) frames.push({ file: m[1], line: +m[2], fn: '' });
  }
  return frames.slice(0, 40);
}

/** Map an absolute or partial frame path to a workspace file. */
function locate(framePath, files, root = '') {
  let p = posix(framePath);
  const r = posix(root);
  if (r && p.toLowerCase().startsWith(r.toLowerCase() + '/')) p = p.slice(r.length + 1);
  p = p.replace(/^\.\//, '');
  if (/node_modules|site-packages|^node:|^internal\//.test(p)) return null;
  if (files.has(p)) return p;
  for (const f of files.keys()) if (p.endsWith('/' + f) || f.endsWith('/' + p)) return f;
  return null;
}

const CAUSES = [
  [/cannot read propert|undefined is not|null ?pointer|NoneType|nil pointer|is not a function|NullReference/i, 'A value was missing (null or undefined) where an object was expected.', ['Find where the value is created.', 'Verify the data model or API response.', 'Add null handling at the boundary.']],
  [/ECONNREFUSED|ENOTFOUND|connection refused|timed? ?out|ETIMEDOUT|network/i, 'A network service or database could not be reached.', ['Confirm the service is running.', 'Check host, port and environment variables.', 'Review timeout and retry settings.']],
  [/cannot find module|ModuleNotFoundError|ImportError|ClassNotFound|no required module/i, 'A module or dependency could not be resolved.', ['Install dependencies.', 'Check the import path and file name casing.', 'Review recent dependency changes.']],
  [/SyntaxError|unexpected token|parse error|IndentationError/i, 'Source or data could not be parsed.', ['Inspect the reported line.', 'Verify the format of external input.', 'Run the formatter or linter.']],
  [/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid token|\bjwt\b/i, 'Authentication or authorization was rejected.', ['Check the token or session lifetime.', 'Verify roles and permissions.', 'Review recent authentication changes.']],
  [/relation .* does not exist|no such (?:table|column)|\bSQL|duplicate key|constraint/i, 'The database rejected a query or the schema does not match.', ['Run pending migrations.', 'Compare the query with the schema.', 'Check constraints and input data.']],
  [/EADDRINUSE|address already in use/i, 'The network port is already in use.', ['Stop the other process.', 'Change the configured port.']],
  [/assert|expected .* (?:to|but)|toEqual|toBe/i, 'Actual behavior differs from what a test expects.', ['Compare expected and actual values.', 'Review recent changes in the tested code.', 'Update the test only if the new behavior is intended.']],
  [/ENOENT|FileNotFound|no such file/i, 'A required file or directory is missing.', ['Verify the path and working directory.', 'Check that generated files exist.']],
  [/heap out of memory|OutOfMemory|MemoryError/i, 'The process ran out of memory.', ['Look for unbounded collections.', 'Process data in batches.']]
];

function diagnose(message) {
  const hit = CAUSES.find(([re]) => re.test(message));
  return hit ? { cause: hit[1], suggestions: hit[2].slice() }
    : { cause: 'No known pattern matched. Start from the first project file in the stack trace.', suggestions: ['Inspect the top project frame.', 'Review recent changes.', 'Reproduce with a focused test.'] };
}

const signature = (message, top) => hash(`${String(message).split('\n')[0].replace(/0x[0-9a-f]+|\d+/gi, '#').slice(0, 200)}|${top || ''}`);

function create(input, history = []) {
  const { message, stack = '', source = 'manual', frames: given, files, root, changes = [] } = input;
  const frames = (given || parseStack(stack)).map((f) => ({ ...f, local: locate(f.file, files, root) }));
  const related = uniq(frames.map((f) => f.local).filter(Boolean));
  const sig = signature(message, related[0]);
  const d = diagnose(`${message}\n${stack.slice(0, 3000)}`);
  const suspects = related.filter((f) => changes.includes(f));
  if (suspects.length) d.suggestions.unshift(`Review uncommitted changes in ${suspects.map((f) => path.basename(f)).join(', ')}.`);
  return {
    id: history.reduce((m, i) => Math.max(m, i.id), 0) + 1,
    signature: sig, time: Date.now(), source, message: String(message).slice(0, 2000), stack: stack.slice(-8000),
    frames: frames.slice(0, 25), files: related, cause: d.cause, suggestions: d.suggestions, suspects,
    changes: changes.slice(0, 50), similar: history.filter((i) => i.signature === sig).length, variables: input.variables || [], tests: []
  };
}

function bugReport(i) {
  const list = (a, f) => (a.length ? a.map(f).join('\n') : '_None_');
  return `# Bug report: incident #${i.id}\n\n**Detected:** ${new Date(i.time).toISOString()}  \n**Source:** ${i.source}  \n**Similar incidents:** ${i.similar}\n\n## Error\n\n~~~~\n${i.message}\n~~~~\n\n## Probable cause\n\n${i.cause}\n\n_Heuristic analysis. Confirm before acting._\n\n## Suggested investigation\n\n${list(i.suggestions, (s, n) => `${n + 1}. ${s}`)}\n\n## Related files\n\n${list(i.files, (f) => `- \`${f}\``)}\n\n## Related tests\n\n${list(i.tests, (f) => `- \`${f}\``)}\n\n## Uncommitted changes\n\n${list(i.changes, (f) => `- \`${f}\``)}\n\n## Variables\n\n${list(i.variables, (v) => `- \`${v.name}\` = \`${v.value}\``)}\n\n## Stack trace\n\n~~~~\n${i.stack || i.frames.map((f) => `${f.fn} ${f.file}:${f.line}`).join('\n')}\n~~~~\n\n## Steps to reproduce\n\n1. \n\n## Expected behavior\n\n`;
}

module.exports = { parseStack, locate, diagnose, signature, create, bugReport };
