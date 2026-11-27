'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const MAX_BODY = 5 * 1024 * 1024;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const interpolate = (s, vars) => String(s || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (own(vars, k) ? vars[k] : m));

/** "KEY=value" or "Header: value" lines. */
function parseLines(text, sep) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

class CookieJar {
  constructor() { this.map = new Map(); }
  store(host, setCookie) {
    for (const raw of [].concat(setCookie || [])) {
      const [pair, ...attrs] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.slice(a.indexOf('=') + 1)) < Date.now()));
      const jar = this.map.get(host) || new Map();
      if (expired) jar.delete(name); else jar.set(name, { value: pair.slice(i + 1).trim(), secure: attrs.some((a) => /^\s*secure\s*$/i.test(a)) });
      this.map.set(host, jar);
    }
  }
  header(url) {
    const jar = this.map.get(url.host);
    if (!jar) return '';
    return [...jar].filter(([, c]) => !c.secure || url.protocol === 'https:').map(([n, c]) => `${n}=${c.value}`).join('; ');
  }
  list() { return [...this.map].flatMap(([host, jar]) => [...jar.keys()].map((name) => ({ host, name }))); }
  clear() { this.map.clear(); }
}

function buildRequest(spec, vars = {}) {
  let url = interpolate(spec.url, vars).trim();
  const missing = url.match(/\{\{[^}]+\}\}/);
  if (missing) throw new Error(`Variable ${missing[0]} is not defined in the selected environment.`);
  if (!url) throw new Error('Enter a request URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http and https URLs are supported.');
  const headers = parseLines(interpolate(spec.headers, vars), ':');
  const find = (n) => Object.keys(headers).find((k) => k.toLowerCase() === n);
  const auth = interpolate(spec.authValue, vars).trim();
  if (spec.authType === 'bearer' && auth) headers.Authorization = `Bearer ${auth}`;
  if (spec.authType === 'basic' && auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  const method = String(spec.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? '' : interpolate(spec.body, vars);
  if (body && !find('content-type')) headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
  return { method, url: parsed, headers, body };
}

function send(request, { jar, timeout = 30000, redirects = 5 } = {}) {
  const started = Date.now();
  const run = (req, left) => new Promise((resolve, reject) => {
    const lib = req.url.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'ForgeStudioPro/1.0', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br', ...req.headers };
    const cookie = jar && jar.header(req.url);
    if (cookie && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) headers.Cookie = cookie;
    if (req.body) headers['Content-Length'] = Buffer.byteLength(req.body);
    let timer;
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const r = lib.request(req.url, { method: req.method, headers }, (res) => {
      if (jar) jar.store(req.url.host, res.headers['set-cookie']);
      const loc = res.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(res.statusCode) && left > 0) {
        res.resume();
        clearTimeout(timer);
        let url;
        try { url = new URL(loc, req.url); } catch (e) { return reject(e); }
        const next = { ...req, url, headers: { ...req.headers } };
        if (url.origin !== req.url.origin) for (const k of Object.keys(next.headers)) if (/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(k)) delete next.headers[k];
        if (res.statusCode === 303 || (res.statusCode < 303 && req.method === 'POST')) {
          next.method = 'GET'; next.body = '';
          for (const k of Object.keys(next.headers)) if (/^content-(type|length)$/i.test(k)) delete next.headers[k];
        }
        return resolve(run(next, left - 1));
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (req.method !== 'HEAD' && res.statusCode !== 204 && res.statusCode !== 304) {
        const decoder = enc === 'gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
        if (decoder) { res.on('error', fail); stream = res.pipe(decoder); }
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (truncated) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, body, size, truncated, time: Date.now() - started, url: req.url.href });
      };
      stream.on('data', (c) => {
        if (done) return;
        if (size + c.length > MAX_BODY) { finish(true); r.destroy(); } else { size += c.length; chunks.push(c); }
      });
      stream.on('end', () => finish(false));
      stream.on('error', fail);
    });
    timer = setTimeout(() => r.destroy(new Error(`Request timed out after ${timeout} ms`)), timeout);
    r.on('error', fail);
    r.end(req.body || undefined);
  });
  return run(request, redirects);
}

/** Subset of JSON Schema: type, required, properties, items, enum, additionalProperties, min/max. */
function validateSchema(value, schema, at = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => t === type || (t === 'integer' && Number.isInteger(value)))) { errors.push(`${at}: expected ${types.join(' or ')}, received ${type}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: value is not in the allowed list`);
  if (type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (type === 'object') {
    for (const k of schema.required || []) if (!own(value, k)) errors.push(`${at}.${k}: required property is missing`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && own(schema.properties, k)) validateSchema(v, schema.properties[k], `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: unexpected property`);
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${at}[${i}]`, errors));
  return errors;
}

const tryJson = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };

function diffResponses(a, b) {
  const out = [];
  if (a.status !== b.status) out.push(`status: ${a.status} → ${b.status}`);
  const x = tryJson(a.body);
  const y = tryJson(b.body);
  if (!x.ok || !y.ok) { if (a.body !== b.body) out.push('body: text content differs'); return out; }
  const show = (v) => JSON.stringify(v).slice(0, 80);
  (function walk(p, q, at) {
    if (out.length > 100) return;
    if (p && q && typeof p === 'object' && typeof q === 'object' && Array.isArray(p) === Array.isArray(q)) {
      for (const k of new Set([...Object.keys(p), ...Object.keys(q)])) {
        const next = `${at}.${k}`;
        if (!own(p, k)) out.push(`${next}: added ${show(q[k])}`);
        else if (!own(q, k)) out.push(`${next}: removed`);
        else walk(p[k], q[k], next);
      }
    } else if (JSON.stringify(p) !== JSON.stringify(q)) out.push(`${at}: ${show(p)} → ${show(q)}`);
  })(x.value, y.value, '$');
  return out;
}

/** A dependency-free node:test file. Credentials are read from the environment. */
function testFile(spec, response, vars = {}) {
  const req = buildRequest({ ...spec, authType: 'none' }, vars);
  const headers = { ...req.headers };
  for (const k of Object.keys(headers)) if (/authorization|cookie|api-?key|token|secret/i.test(k)) delete headers[k];
  const json = tryJson(response.body);
  const auth = spec.authType === 'bearer' ? '  headers.Authorization = `Bearer ${process.env.API_TOKEN}`;\n'
    : spec.authType === 'basic' ? "  headers.Authorization = 'Basic ' + Buffer.from(process.env.API_BASIC_AUTH || '').toString('base64');\n" : '';
  const keys = json.ok && json.value && typeof json.value === 'object' && !Array.isArray(json.value) ? Object.keys(json.value) : [];
  return `// Generated by Forge Studio Pro. Run with: node --test\nconst test = require('node:test');\nconst assert = require('node:assert');\n\n` +
    `test(${JSON.stringify(`${req.method} ${req.url.pathname} returns ${response.status}`)}, async () => {\n` +
    `  const headers = ${JSON.stringify(headers)};\n${auth}` +
    `  const res = await fetch(${JSON.stringify(req.url.href)}, { method: ${JSON.stringify(req.method)}, headers${req.body ? `, body: ${JSON.stringify(req.body)}` : ''} });\n` +
    `  assert.strictEqual(res.status, ${Number(response.status)});\n` +
    (keys.length ? `  const body = await res.json();\n  for (const key of ${JSON.stringify(keys)}) assert.ok(key in body, \`missing \${key}\`);\n` : '') + `});\n`;
}

module.exports = { interpolate, parseLines, CookieJar, buildRequest, send, validateSchema, diffResponses, testFile, tryJson };
