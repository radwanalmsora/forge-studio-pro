'use strict';
const net = require('net');
const vscode = require('vscode');
const { shell } = require('../exec');
const { parseLines } = require('../lib/http');

const DRIVERS = { pg: 'PostgreSQL', postgres: 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', mongodb: 'MongoDB', mongoose: 'MongoDB', sqlite3: 'SQLite', 'better-sqlite3': 'SQLite', redis: 'Redis', ioredis: 'Redis', '@prisma/client': 'Prisma', typeorm: 'TypeORM', sequelize: 'Sequelize', 'drizzle-orm': 'Drizzle' };
const PORTS = { postgres: 5432, postgresql: 5432, mysql: 3306, mongodb: 27017, redis: 6379 };
const json = (s) => { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } };

module.exports = {
  async checkDependencies() {
    this.requireWorkspace();
    if (!this.pkg) throw new Error('Dependency checks currently need a package.json in the project root.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before checking dependencies.');
    await this.withBusy('Checking dependencies', async (token) => {
      const [audit, outdated] = await Promise.all([shell('npm audit --json', this.root, { token, timeout: 120000 }), shell('npm outdated --json', this.root, { token, timeout: 120000 })]);
      const a = json(audit.output);
      const o = outdated.output.trim() ? json(outdated.output) : {};
      const auditOk = a && a.metadata && a.metadata.vulnerabilities;
      if (!auditOk && (!o || o.error)) throw new Error('npm could not check dependencies. Make sure npm is installed, you are online, and a package-lock.json exists.');
      const level = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'low' };
      this.data.deps = {
        time: Date.now(),
        audited: !!auditOk,
        vulnerabilities: auditOk ? a.metadata.vulnerabilities : null,
        packages: auditOk ? Object.values(a.vulnerabilities || {}).slice(0, 100).map((v) => ({ name: v.name, severity: level[v.severity] || 'medium', fix: !!v.fixAvailable })) : [],
        outdated: o && !o.error ? Object.entries(o).map(([name, v]) => { const x = [].concat(v)[0]; return { name, current: x.current || 'missing', latest: x.latest }; }) : []
      };
    }, true);
    await this.commit();
  },

  async databaseUrl() {
    for (const f of ['.env.local', '.env']) {
      const text = await this.readText(this.uri(f));
      const v = text && parseLines(text, '=').DATABASE_URL;
      if (v) return v.replace(/^["']|["']$/g, '');
    }
    return null;
  },

  async detectDatabase() {
    const all = this.pkg ? { ...this.pkg.dependencies, ...this.pkg.devDependencies } : {};
    const drivers = [...new Set(Object.keys(all).filter((k) => Object.prototype.hasOwnProperty.call(DRIVERS, k)).map((k) => DRIVERS[k]))];
    const tables = [...this.index.values()].filter((i) => i.lang === 'sql' || i.lang === 'prisma').flatMap((i) => i.symbols.map((s) => ({ name: s.name, file: i.path, line: s.line })));
    const url = await this.databaseUrl();
    const previous = this.database;
    this.database = drivers.length || tables.length || url ? { drivers, tables: tables.slice(0, 200), hasUrl: !!url, reachable: previous ? previous.reachable : null } : null;
  },

  async checkDatabase() {
    this.requireWorkspace();
    const url = await this.databaseUrl();
    if (!url) throw new Error('Add DATABASE_URL to .env or .env.local to test connectivity.');
    let u;
    try { u = new URL(url); } catch { throw new Error('DATABASE_URL is not a valid URL.'); }
    const port = Number(u.port) || PORTS[u.protocol.replace(':', '')];
    if (!u.hostname || !port) throw new Error('Connectivity checks need a network database URL with a host.');
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
      const end = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(4000, () => end(false));
      s.once('connect', () => end(true));
      s.once('error', () => end(false));
    });
    await this.detectDatabase();
    this.database.reachable = ok;
    this.emit();
    vscode.window.showInformationMessage(`Forge: ${u.hostname}:${port} is ${ok ? 'reachable' : 'not reachable'}.`);
  },

  async securityReport() {
    const list = this.securityFindings();
    await this.showDocument(`# Security and privacy report\n\nGenerated ${new Date().toISOString()}. ${list.length} finding(s). Pattern-based analysis: review each item.\n\n| Severity | Category | Finding | Location | Recommendation |\n|---|---|---|---|---|\n` +
      list.map((f) => `| ${f.severity} | ${f.category} | ${f.title} | \`${f.file}:${f.line}\` | ${f.fix} |`).join('\n') + '\n');
  }
};
