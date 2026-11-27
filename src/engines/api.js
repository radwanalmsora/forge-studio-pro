'use strict';
const vscode = require('vscode');
const api = require('../lib/http');
const { hash, tail } = require('../lib/util');

const FIELDS = ['method', 'url', 'headers', 'body', 'authType', 'authValue', 'schema', 'environment'];
const clean = (spec) => Object.fromEntries(FIELDS.map((k) => [k, String((spec && spec[k]) || '').slice(0, 200000)]));
/** What may be written to disk: no literal credentials, only {{variable}} references. */
function storable(spec) {
  const s = clean(spec);
  if (!/^\s*\{\{[^}]+\}\}\s*$/.test(s.authValue)) s.authValue = '';
  s.headers = s.headers.split('\n').filter((l) => !/^[^:]*(authorization|cookie|api-?key|token|secret)[^:]*:/i.test(l) || /\{\{[^}]+\}\}/.test(l)).join('\n');
  return s;
}

module.exports = {
  secretKey() { return `forge.environments.${hash(this.root || 'none')}`; },

  async loadEnvironments() {
    try { this.environments = JSON.parse((await this.context.secrets.get(this.secretKey())) || '{}'); }
    catch { this.environments = {}; }
    if (!this.cookies) this.cookies = new api.CookieJar();
  },

  async saveEnvironment(name, text) {
    const key = String(name || '').trim().slice(0, 60);
    if (!key || key === '__proto__') throw new Error('Name the environment.');
    if (text === null) delete this.environments[key]; else this.environments[key] = String(text).slice(0, 20000);
    await this.context.secrets.store(this.secretKey(), JSON.stringify(this.environments));
    this.emit();
  },

  variables(name) { return Object.prototype.hasOwnProperty.call(this.environments || {}, name) ? api.parseLines(this.environments[name], '=') : {}; },

  async sendRequest(raw) {
    const spec = clean(raw);
    const request = api.buildRequest(spec, this.variables(spec.environment));
    let schema = null;
    if (spec.schema.trim()) {
      const parsed = api.tryJson(spec.schema);
      if (!parsed.ok) throw new Error('The response schema is not valid JSON.');
      schema = parsed.value;
    }
    const previous = this.last;
    this.response = { pending: true };
    this.emit();
    try {
      const r = await this.withBusy(`${request.method} ${request.url.host}`, () => api.send(request, { jar: this.cookies, timeout: this.config().get('api.timeout', 30) * 1000 }));
      const json = api.tryJson(r.body);
      const same = previous && previous.key === `${request.method} ${request.url.href}`;
      this.last = { key: `${request.method} ${request.url.href}`, spec, response: r };
      this.response = {
        status: r.status, statusText: r.statusText, time: r.time, size: r.size, truncated: r.truncated, url: r.url,
        headers: Object.entries(r.headers).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('\n'),
        body: (json.ok ? JSON.stringify(json.value, null, 2) : r.body).slice(0, 200000),
        schema: schema ? (json.ok ? api.validateSchema(json.value, schema) : ['The response body is not JSON.']) : null,
        diff: same ? api.diffResponses(previous.response, r) : null
      };
    } catch (e) {
      this.response = { error: e.message || e.code || String(e) };
    }
    this.data.history = [{ ...storable(spec), status: this.response.status || 'ERR', time: Date.now() }, ...this.data.history].slice(0, 30);
    await this.save();
    this.emit();
  },

  async saveRequest(name, spec) {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw new Error('Name the request before saving it.');
    this.data.collections = [...this.data.collections.filter((c) => c.name !== n), { ...storable(spec), name: n }].sort((a, b) => a.name.localeCompare(b.name));
    await this.save(); this.emit();
  },

  async deleteRequest(name) { this.data.collections = this.data.collections.filter((c) => c.name !== name); await this.save(); this.emit(); },
  async clearHistory() { this.data.history = []; await this.save(); this.emit(); },
  clearCookies() { this.cookies.clear(); this.emit(); },

  async apiTest() {
    if (!this.last) throw new Error('Send a request successfully first.');
    await this.showDocument(api.testFile(this.last.spec, this.last.response, this.variables(this.last.spec.environment)), 'javascript');
  },

  async openResponse() {
    if (!this.response || this.response.body === undefined) throw new Error('There is no response to open.');
    await this.showDocument(this.response.body, api.tryJson(this.response.body).ok ? 'json' : 'plaintext');
  },

  async exportCollections() {
    const doc = JSON.stringify({ exportedBy: 'Forge Studio Pro', requests: this.data.collections }, null, 2);
    await this.showDocument(tail(doc, 1000000), 'json');
  }
};
