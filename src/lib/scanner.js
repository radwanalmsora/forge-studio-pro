'use strict';
const { hash } = require('./util');

const JS = /\.([cm]?[jt]sx?|vue|svelte)$/;
const R = (id, category, severity, title, re, fix, files) => ({ id, category, severity, title, re, fix, files });

const RULES = [
  R('aws-key', 'Secrets', 'critical', 'AWS access key in source', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'Revoke the key and load it from the environment.'),
  R('private-key', 'Secrets', 'critical', 'Private key committed to the project', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/, 'Remove the key, rotate it, and store it in a secret manager.'), // forge-ignore
  R('token', 'Secrets', 'critical', 'API token in source', /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_\w{60,}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9a-zA-Z]{20,})/, 'Revoke the token and load it from the environment.'),
  R('hardcoded-secret', 'Secrets', 'high', 'Hardcoded password or secret', /\b[\w-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\w*["']?\s*[:=]\s*["'](?!.*(?:\$\{|<|\*{3}|example|changeme|your[_-]|placeholder|dummy))[^"'\s]{6,}["']/i, 'Move the value to an environment variable or secret store.'),
  R('db-url', 'Secrets', 'high', 'Database URL with embedded password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:'"]+:(?!\$|<|\{)[^\s@'"]{3,}@/i, 'Read the connection string from the environment.'),
  R('eval', 'Unsafe functions', 'high', 'Dynamic code execution', /(?<![.\w])eval\s*\(|new\s+Function\s*\(/, 'Replace eval with explicit parsing or a lookup table.', /\.([cm]?[jt]sx?|vue|svelte|py|php|rb)$/),
  R('inner-html', 'Injection', 'medium', 'Raw HTML assignment (XSS risk)', /\.(?:inner|outer)HTML\s*\+?=(?!\s*(?:''|""|``))|dangerouslySetInnerHTML|v-html=/, 'Use textContent, or sanitize the HTML first.', JS),
  R('sql-concat', 'Injection', 'high', 'SQL built from variables', /(["'`])\s*(?:SELECT\s.*?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b.*?(?:\$\{|\1\s*\+\s*\w|\1\s*%\s*[\w(])|\bf["'](?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*\{/i, 'Use parameterized queries.'),
  R('shell', 'Injection', 'high', 'Shell command built from variables', /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)|os\.system\s*\(\s*(?:f["']|[^"')]+\+)|shell\s*=\s*True/, 'Pass arguments as an array without a shell.'),
  R('deserialize', 'Unsafe functions', 'high', 'Unsafe deserialization', /pickle\.loads?\(|yaml\.load\((?![^)]*SafeLoader)|\bunserialize\(\s*\$_/, 'Use a safe loader and validate input.', /\.(py|php)$/),
  R('weak-hash', 'Cryptography', 'medium', 'Weak hash algorithm', /createHash\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"/i, 'Use SHA-256, or bcrypt/Argon2 for passwords.'),
  R('weak-random', 'Cryptography', 'medium', 'Non-cryptographic randomness for a secret', /(?:token|secret|password|otp|nonce|salt)\w*\s*[:=].*Math\.random\(\)/i, 'Use crypto.randomBytes or crypto.randomUUID.', JS),
  R('tls-off', 'Authentication', 'high', 'TLS certificate verification disabled', /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/, 'Keep certificate verification enabled.'),
  R('jwt-none', 'Authentication', 'critical', 'JWT accepted without a signature', /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i, 'Require a signed algorithm such as RS256.'),
  R('cors-any', 'Authorization', 'medium', 'CORS allows every origin', /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*/, 'List the trusted origins explicitly.'),
  R('log-sensitive', 'Privacy', 'medium', 'Sensitive value written to logs', /\b(?:console\.\w+|logger?\.\w+|logging\.\w+|print|System\.out\.println|log\.Print\w*)\s*\([^)\n]*(?:[,+]\s*|\$\{[\w.]*|\{[\w.]*)\b\w*(?:password|passwd|secret|token|authorization|credit_?card|ssn)\b/i, 'Remove the value or mask it before logging.'),
  R('storage', 'Privacy', 'medium', 'Credential stored in browser storage', /(?:localStorage|sessionStorage)\.setItem\(\s*['"][^'"]*(?:token|password|secret|jwt)/i, 'Prefer HttpOnly, Secure cookies.', JS),
  R('email', 'Privacy', 'low', 'Personal e-mail address in a data file', /\b[\w.+-]+@(?!example\.|test\.|localhost)[\w-]+\.[a-z]{2,}\b/i, 'Replace real personal data with synthetic data.', /\.(csv|sql|log)$/),
  R('card', 'Privacy', 'high', 'Possible payment card number', /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)(?:[ -]?\d){9,12}\b/, 'Remove card data from the repository.')
];

function luhn(s) {
  const d = s.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return d.length >= 13 && sum % 10 === 0;
}
const mask = (s) => (s.length <= 8 ? '••••' : s.slice(0, 4) + '••••••' + s.slice(-2));

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|[^/]*\.min\.(js|css))$/;

function scanText(file, text) {
  if (SKIP.test(file)) return [];
  const findings = [];
  const test = /(^|\/)(tests?|__tests__|fixtures|mocks?)\/|\.(test|spec)\./.test(file);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && findings.length < 100; i++) {
    const line = lines[i];
    if (line.length > 2000 || /forge-ignore(?!-next)/.test(line) || (i && /forge-ignore-next-line/.test(lines[i - 1]))) continue;
    for (const rule of RULES) {
      if (rule.files && !rule.files.test(file)) continue;
      const m = rule.re.exec(line);
      if (!m || (rule.id === 'card' && !luhn(m[0]))) continue;
      if (rule.category !== 'Secrets' && /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
      const sensitive = rule.category === 'Secrets' || rule.id === 'card' || rule.id === 'email';
      const severity = test && rule.category === 'Secrets' ? 'low' : rule.severity;
      findings.push({
        key: hash(`${file}|${rule.id}|${line.trim()}`), rule: rule.id, category: rule.category, severity,
        title: rule.title, fix: rule.fix, file, line: i + 1, column: m.index,
        evidence: rule.id === 'hardcoded-secret' ? m[0].replace(/(["'])[^"'\s]{6,}["']$/, '$1••••••$1') : sensitive ? mask(m[0]) : line.trim().slice(0, 160)
      });
    }
  }
  return findings;
}

/** Group project files into the layers of a request path and count findings in each. */
function securityLayers(files, findings) {
  const layers = [
    ['Input and UI', /(component|view|page|screen|form|client|frontend)/i],
    ['Controller', /(controller|route|handler|endpoint|resolver|\bapi\b)/i],
    ['Validation', /(valid|schema|dto|sanitiz|guard|middleware)/i],
    ['Service', /(service|usecase|domain|logic|manager)/i],
    ['Data', /(repositor|model|entity|database|\bdb\b|migration|prisma|\.sql$|dao)/i]
  ];
  return layers.map(([name, re]) => {
    const set = new Set(files.filter((f) => re.test(f)));
    return { name, files: set.size, findings: findings.filter((f) => set.has(f.file)).length };
  });
}

module.exports = { RULES, scanText, securityLayers, luhn };
