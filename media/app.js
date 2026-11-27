/* Forge Studio Pro webview client */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const TABS = [['command', 'Command Center'], ['problems', 'Problem Solver'], ['understanding', 'Understanding'], ['workflows', 'Workflows'], ['testing', 'Testing'], ['debugging', 'Debugging'], ['security', 'Security'], ['api', 'API Studio']];
  const blankApi = () => ({ method: 'GET', url: '', headers: '', body: '', authType: 'none', authValue: '', schema: '', environment: '', name: '' });
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'command';
  const form = { api: Object.assign(blankApi(), saved.api), env: { name: '', text: '' }, query: saved.query || '', file: '', stack: '', filter: '' };
  let S = null;
  let draft = null;
  let selected = saved.workflow || '';
  let lastHtml = '';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (t) => (t ? new Date(t).toLocaleString() : 'never');
  const secs = (ms) => `${((ms || 0) / 1000).toFixed(1)} s`;
  const post = (cmd, args) => vscode.postMessage({ cmd, args });
  const persist = () => vscode.setState({ tab, api: Object.assign({}, form.api, { authValue: '' }), query: form.query, workflow: selected });

  const attrs = (o) => Object.entries(o || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const btn = (label, cmd, args, cls = '') => `<button class="${cls}" data-cmd="${cmd}"${attrs(args)}>${esc(label)}</button>`;
  const ui = (label, action, args, cls = 'quiet') => `<button class="${cls}" data-ui="${action}"${attrs(args)}>${esc(label)}</button>`;
  const link = (file, line, label) => (file ? btn(label || (line ? `${file}:${line}` : file), 'open', { file, line: line || 1 }, 'link') : `<span class="muted">${esc(label || 'Project')}</span>`);
  const badge = (text, cls) => `<span class="badge ${esc(cls || text)}">${esc(text)}</span>`;
  const empty = (text, action = '') => `<div class="empty">${esc(text)} ${action}</div>`;
  const list = (items, render, none) => (items && items.length ? `<ul class="list">${items.map((x) => `<li>${render(x)}</li>`).join('')}</ul>` : empty(none));
  const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const tree = (node) => (node ? `<ul class="tree">${(function walk(n) { return `<li>${link(n.file, 1, n.file)}${n.children.length ? `<ul class="tree">${n.children.map(walk).join('')}</ul>` : ''}</li>`; })(node)}</ul>` : '');
  const input = (model, placeholder, cls = '', label = placeholder) => { const [a, b] = model.split('.'); const v = b ? form[a][b] : form[a]; return `<input id="f-${model}" class="${cls}" data-model="${model}" value="${esc(v)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}">`; };
  const area = (model, label, placeholder) => { const [a, b] = model.split('.'); return `<label for="f-${model}">${esc(label)}</label><textarea id="f-${model}" data-model="${model}" placeholder="${esc(placeholder)}" spellcheck="false">${esc(b ? form[a][b] : form[a])}</textarea>`; };
  const options = (pairs, value) => pairs.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const select = (model, pairs, label) => { const [a, b] = model.split('.'); return `<select id="f-${model}" data-model="${model}" aria-label="${esc(label)}">${options(pairs, b ? form[a][b] : form[a])}</select>`; };
  const fileSelect = () => `<input id="f-file" class="grow" data-model="file" list="files" value="${esc(form.file)}" placeholder="Type to choose a project file" aria-label="Project file"><datalist id="files">${S.files.map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>`;

  function gauge(score) {
    const c = 2 * Math.PI * 62;
    const v = score === null ? 0 : score;
    const color = v >= 80 ? 'var(--ok)' : v >= 55 ? 'var(--warn)' : 'var(--bad)';
    return `<svg class="gauge" viewBox="0 0 148 148" role="img" aria-label="Project health ${score === null ? 'unknown' : v + ' out of 100'}"><circle cx="74" cy="74" r="62" fill="none" stroke="var(--line)" stroke-width="11"/><circle cx="74" cy="74" r="62" fill="none" stroke="${color}" stroke-width="11" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 74 74)"/><text class="score" x="74" y="80">${score === null ? '–' : v}</text><text class="sub" x="74" y="100">health of 100</text></svg>`;
  }

  const views = {
    command() {
      const t = S.tests; const b = S.build; const d = S.deps; const db = S.database; const dep = S.deployments[0];
      const sec = S.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
      const row = (name, cls, text, action) => tr([esc(name), `<span class="${cls}">${esc(text)}</span>`, action]);
      const rows = [
        row('Build', !b ? 'muted' : b.ok ? 'ok' : 'bad', !b ? (S.project.build ? 'Not run yet' : 'No build command') : b.ok ? `Passed in ${secs(b.ms)}` : 'Failed', S.project.build ? btn('Run build', 'build', {}, 'quiet') : btn('Configure', 'settings', {}, 'quiet')),
        row('Tests', !t ? 'muted' : t.ok ? 'ok' : 'bad', !t ? (S.project.test ? 'Not run yet' : 'No test command') : t.ok ? `Passed${t.passed ? ` (${t.passed})` : ''}` : `${t.failed || 'Some'} failure(s)`, S.project.test ? btn('Run tests', 'runTests', { scope: 'all' }, 'quiet') : btn('Configure', 'settings', {}, 'quiet')),
        row('Security', sec ? 'bad' : S.findingTotal ? 'warn' : 'ok', sec ? `${sec} high-risk finding(s)` : S.findingTotal ? `${S.findingTotal} lower-risk finding(s)` : 'No findings', ui('Review', 'tab', { tab: 'security' })),
        row('Dependencies', !d ? 'muted' : d.packages.length || d.outdated.length ? 'warn' : 'ok', !d ? 'Not checked' : `${d.audited ? d.packages.length + ' vulnerable, ' : 'Audit unavailable, '}${d.outdated.length} update(s)`, btn('Check', 'dependencies', {}, 'quiet')),
        row('Git', !S.git.available ? 'muted' : S.git.total ? 'warn' : 'ok', !S.git.available ? 'No repository' : `${S.git.total} change(s) on ${S.git.branch}`, S.git.available ? btn('Commit with checks', 'commit', {}, 'quiet') : ''),
        row('API', S.endpoints.length ? 'ok' : 'muted', `${S.endpoints.length} endpoint(s) found`, ui('Open', 'tab', { tab: 'api' })),
        row('Database', !db ? 'muted' : db.reachable === false ? 'bad' : db.reachable ? 'ok' : 'muted', !db ? 'Not detected' : `${db.reachable === true ? 'Reachable' : db.reachable === false ? 'Unreachable' : 'Detected'}${db.drivers.length ? ': ' + db.drivers.join(', ') : ''}, ${db.tables.length} table(s)`, db && db.hasUrl ? btn('Test connection', 'database', {}, 'quiet') : ''),
        row('Deployment', !dep ? 'muted' : dep.ok ? 'ok' : 'bad', !dep ? (S.deployConfigured ? 'Never deployed' : 'Not configured') : `${dep.ok ? 'Succeeded' : 'Failed'} ${when(dep.time)}`, btn(S.deployConfigured ? 'Deploy' : 'Configure', 'deploy', {}, 'quiet'))
      ];
      const node = (n, label, to) => `<button data-ui="tab" data-tab="${to}"><b>${esc(n)}</b>${esc(label)}</button>`;
      return `<div class="hero">${gauge(S.health)}<div class="status"><table><tbody>${rows.join('')}</tbody></table></div></div>
      <h2>Project universe</h2><div class="universe">${node(S.stats.files, 'code files', 'understanding')}<i></i>${node(S.endpoints.length, 'endpoints', 'api')}<i></i>${node(db ? db.tables.length : 0, 'tables', 'security')}<i></i>${node(S.stats.testFiles, 'test files', 'testing')}<i></i>${node(S.deployments.length, 'deployments', 'workflows')}</div>
      <div class="cols"><section><h2>Action required</h2>${list(S.actions, (a) => ui(a.text, 'tab', { tab: a.tab }, 'link'), S.lastScan ? 'Nothing needs your attention.' : 'Scan the project to see actions.')}</section>
      <section><h2>Largest modules</h2>${list(S.modules, (m) => `<span class="grow">${esc(m.name)}</span><span class="muted">${m.count} file(s)</span>`, 'No source files found.')}</section></div>
      ${S.git.changes.length ? `<h2>Uncommitted changes</h2>${list(S.git.changes.slice(0, 20), (c) => `${badge(c.status, c.conflict ? 'bad' : 'low')}${link(c.file)}${ui('Impact', 'impact', { file: c.file }, 'link')}`, '')}` : ''}
      ${dep ? `<h2>Deployment history</h2>${S.deployments.map((x) => `<details><summary class="${x.ok ? 'ok' : 'bad'}">${x.ok ? 'Succeeded' : 'Failed'} ${esc(when(x.time))} ${esc(x.commit)}</summary><pre>${esc(x.output)}</pre></details>`).join('')}` : ''}`;
    },

    problems() {
      const sel = S.view.problem;
      const items = S.problems.filter((p) => !form.filter || p.type === form.filter);
      const types = [...new Set(S.problems.map((p) => p.type))].sort();
      let detail = empty('Choose "Analyze" on a problem to see its graph, affected systems and related tests.');
      const p = sel && S.problems.concat(S.ignored).find((x) => x.key === sel.key);
      if (p) detail = `<h3>Problem #${p.id}: ${esc(p.title)}</h3><p>${badge(p.severity)} ${esc(p.type)}, status <b>${esc(p.status)}</b></p><p>${link(p.file, p.line)}</p>
        <div class="row">${['Open', 'Investigating', 'Ignored'].filter((s) => s !== p.status).map((s) => btn(s === 'Open' ? 'Reopen' : s === 'Ignored' ? 'Ignore' : 'Investigate', 'problemStatus', { key: p.key, status: s }, 'quiet')).join('')}</div>
        <h3>Affected systems</h3><p>${sel.systems.map((s) => badge(s, 'running')).join(' ') || '<span class="muted">None detected</span>'}</p>
        <h3>Problem graph (files that depend on this one)</h3>${tree(sel.tree) || empty('This problem is not tied to an indexed source file.')}
        <h3>Related tests</h3>${list(sel.tests, (f) => link(f), 'No related tests found.')}`;
      return `<div class="row"><h2 class="grow">${S.problemTotal} active problem(s)</h2>${select('filter', [['', 'All types'], ...types.map((t) => [t, t])], 'Filter by type')}</div>
      <div class="cols"><section>${items.length ? table(['#', 'Problem', 'Severity', ''], items.slice(0, 150).map((x) => tr([x.id, `${esc(x.title)}<br><span class="muted">${esc(x.type)}, ${esc(x.status)}</span><br>${link(x.file, x.line)}`, badge(x.severity), btn('Analyze', 'selectProblem', { key: x.key }, 'quiet')]))) : empty('No active problems.')}
      ${S.ignored.length ? `<h2>Ignored</h2>${list(S.ignored, (x) => `<span class="grow">#${x.id} ${esc(x.title)}</span>${btn('Reopen', 'problemStatus', { key: x.key, status: 'Open' }, 'quiet')}`, '')}` : ''}
      <h2>Recently resolved</h2>${list(S.resolved, (x) => `${badge('resolved', 'ok')} #${x.id} ${esc(x.title)}`, 'Resolved problems appear here automatically.')}</section><section>${detail}</section></div>`;
    },

    understanding() {
      const r = S.view.search; const i = S.view.impact; const st = S.stats;
      return `<p class="muted">${st.files} files, ${st.symbols} symbols, ${st.lines} lines and ${st.links} internal dependencies indexed.${S.truncated ? ' The file limit was reached; raise "forge.maxFiles".' : ''}</p>
      <h2>What do you want to change?</h2><div class="row">${input('query', 'Example: change how login works', 'grow')}${ui('Map it', 'search', {}, '')}</div>
      ${r ? (r.edit.length ? `<div class="cols"><section><h3>System map for “${esc(r.query)}”</h3>${tree(r.map)}</section><section><h3>Files likely to change</h3>${list(r.edit, (e) => `${link(e.file)}<span class="muted">${esc(e.symbols.join(', '))}</span>${ui('Impact', 'impact', { file: e.file }, 'link')}`, '')}
        <h3>Shared files to handle with care</h3>${list(r.careful, (c) => `${link(c.file)}<span class="muted">used by ${c.users} files</span>`, 'No widely shared dependencies detected.')}<h3>Tests to run afterwards</h3>${list(r.tests, (f) => link(f), 'No related tests found.')}</section></div>` : empty('No matching files. Try a symbol, folder or feature name.')) : ''}
      <h2>File impact analysis</h2><div class="row">${fileSelect()}${ui('Analyze impact', 'impactSelected', {}, '')}</div>
      ${i ? `<h3>${esc(i.file)}</h3><p>Affected systems: ${i.systems.map((s) => badge(s, 'running')).join(' ') || 'none'}</p><div class="cols"><section><h3>Who depends on it (${i.dependents.length})</h3>${tree(i.tree)}<h3>It depends on</h3>${list(i.dependencies, (f) => link(f), 'No internal dependencies.')}</section>
        <section><h3>Related tests</h3>${list(i.tests, (f) => link(f), 'No related tests found.')}<h3>Affected API endpoints</h3>${list(i.endpoints, (e) => `<span class="method">${esc(e.method)}</span>${link(e.file, e.line, e.path)}`, 'No endpoints affected.')}<h3>Data layer</h3>${list(i.data, (f) => link(f), 'No data files involved.')}<h3>Symbols</h3>${list(i.symbols, (s) => `${badge(s.kind, 'low')}${link(i.file, s.line, s.name)}`, 'No symbols found.')}</section></div>` : ''}
      <h2>Architecture warnings</h2>${list(S.cycles, (c) => `${badge('cycle', 'warn')}${c.map((f) => link(f, 1, f)).join(' → ')}`, 'No circular dependencies detected.')}`;
    },

    workflows() {
      const all = draft || S.workflows;
      const w = all.find((x) => x.id === selected) || all[0];
      const side = `<div class="side">${all.map((x) => `<button class="quiet ${w && x.id === w.id ? 'selected' : ''}" data-ui="pick" data-id="${esc(x.id)}">${esc(x.name)}<br><span class="muted">${esc(S.triggers[x.trigger])}${x.enabled ? '' : ', disabled'}</span></button>`).join('')}${ui('New workflow', 'wfNew', {}, '')}</div>`;
      if (!w) return `<h2>Workflows</h2>${side}`;
      const run = S.runs.find((r) => r.id === w.id);
      const steps = w.steps.map((s, n) => {
        const rs = run && !draft && run.steps[n] && run.steps[n].type === s.type ? run.steps[n] : null;
        return `<li class="s-${rs ? rs.status : 'none'}"><div class="row"><b class="grow">${esc(S.stepTypes[s.type])}</b>${rs ? badge(rs.status) : ''}${ui('↑', 'wfUp', { n })}${ui('↓', 'wfDown', { n })}${ui('Remove', 'wfRemove', { n })}</div>
          ${s.type === 'command' ? `<input id="cmd-${n}" class="grow" data-step="${n}" data-field="command" value="${esc(s.command)}" placeholder="npm run lint" aria-label="Shell command" size="50">` : ''}
          <label class="inline"><input type="checkbox" id="cont-${n}" data-step="${n}" data-field="continueOnFail"${s.continueOnFail ? ' checked' : ''}> Continue if this step fails</label>
          ${rs && rs.detail ? `<details id="d-${esc(w.id)}-${n}"><summary>Output (${secs(rs.ms)})</summary><pre>${esc(rs.detail)}</pre></details>` : ''}</li>`;
      }).join('');
      return `<div class="split"><section><h2>Workflows</h2>${side}</section><section><h2>Visual editor</h2>
        <div class="row"><input id="wf-name" class="grow" data-wf="name" value="${esc(w.name)}" aria-label="Workflow name"><select id="wf-trigger" data-wf="trigger" aria-label="Trigger">${options(Object.entries(S.triggers), w.trigger)}</select><label class="inline"><input id="wf-enabled" type="checkbox" data-wf="enabled"${w.enabled ? ' checked' : ''}> Enabled</label></div>
        ${w.trigger === 'onSave' ? `<label for="wf-pattern">File pattern</label><input id="wf-pattern" data-wf="filePattern" value="${esc(w.filePattern)}" placeholder="src/**/*.ts">` : ''}
        <ol class="flow">${steps || '<li>Add the first step below.</li>'}</ol>
        <div class="row"><select id="wf-add" aria-label="Step type">${options(Object.entries(S.stepTypes), '')}</select>${ui('Add step', 'wfAdd')}</div>
        <div class="row">${draft ? ui('Save changes', 'wfSave', {}, '') + ui('Discard', 'wfDiscard') : btn('Run workflow', 'runWorkflow', { id: w.id }) + (run ? btn('Open report', 'openReport', { id: w.id }, 'quiet') : '')}${ui('Delete workflow', 'wfDelete')}</div>
        ${draft ? '<div class="notice">Unsaved changes. Save before running.</div>' : ''}${run ? `<p>Last run: ${badge(run.status)} ${esc(when(run.started))}</p>` : ''}</section></div>`;
    },

    testing() {
      const t = S.tests; const c = S.coverage; const rel = S.related;
      return `<div class="row"><h2 class="grow">Test intelligence</h2>${btn('Run all tests', 'runTests', { scope: 'all' })}${btn('Run related tests', 'runTests', { scope: 'related' }, 'quiet')}</div>
      <p class="muted">Framework: ${esc(S.project.framework || 'not detected')}. Command: ${esc(S.project.test || 'set forge.testCommand')}</p>
      ${t ? `<div class="notice"><b class="${t.ok ? 'ok' : 'bad'}">${t.ok ? 'Passed' : 'Failed'}</b>: ${t.passed ?? '?'} passed, ${t.failed ?? '?'} failed in ${secs(t.ms)} (${esc(when(t.time))}). ${esc(t.note)}${t.previous ? `<br><span class="muted">Previous run: ${t.previous.passed ?? '?'} passed, ${t.previous.failed ?? '?'} failed, ${secs(t.previous.ms)}. New failures: ${t.newFailures.length}. Fixed: ${t.fixed.length}.</span>` : ''}</div>
        ${t.failures.length ? `<h3>Failures</h3>${list(t.failures, (f) => `${badge('failed')}<span class="grow">${esc(f.name)} ${f.file ? link(f.file, f.line) : ''}</span>`, '')}${ui('Analyze this failure', 'analyzeTests')}` : ''}<details id="test-output"><summary>Raw output</summary><pre>${esc(t.output)}</pre></details>` : empty('Run the tests to see results, failures and comparisons.')}
      <div class="cols"><section><h2>Related to current changes</h2>${rel.changed.length ? `<p class="muted">Changed: ${rel.changed.map(esc).join(', ')}</p>` : ''}${list(rel.tests, (f) => link(f), 'No related tests for the current changes.')}
        <h2>Coverage</h2>${c ? `<p>Project coverage: <b>${c.total}%</b> <span class="muted">from ${esc(c.source)}</span></p>${c.modules.map((m) => `<div class="row"><span class="grow">${esc(m.name)} ${m.pct}%</span></div><progress class="${m.pct < 60 ? 'weak' : ''}" max="100" value="${m.pct}"></progress>`).join('')}<h3>Weakest files</h3>${list(c.weakest, (f) => `${link(f.file)}<span class="muted">${f.pct}%</span>`, '')}` : empty('Generate an lcov or coverage-summary.json report (for example with your test runner’s coverage option).')}</section>
      <section><h2>Generate a test skeleton</h2><div class="row">${fileSelect()}${ui('Generate', 'generateSelected', {}, '')}</div>
        <h2>Source files without detected tests</h2>${list(S.untested.slice(0, 30), (f) => `<span class="grow">${link(f)}</span>${btn('Generate test', 'generateTest', { file: f }, 'quiet')}`, 'Every indexed source file is reached by a test.')}
        <h2>Duplicate test names</h2>${list(S.duplicates, (d) => `<span class="grow">${esc(d.name)}</span>${d.places.map((p) => link(p.file, p.line)).join(' ')}`, 'No duplicate test names found.')}</section></div>`;
    },

    debugging() {
      const cur = S.incidents.find((i) => i.id === S.view.incident) || S.incidents[0];
      return `<h2>Analyze an error</h2>${area('stack', 'Stack trace or error text', 'Paste here. Leave empty to read the clipboard.')}<div class="row">${ui('Create incident', 'stack', {}, '')}<span class="muted">Debugger exceptions and failed tasks are captured automatically.</span></div>
      <div class="split"><section><h2>Incidents</h2><div class="side">${S.incidents.map((i) => `<button class="quiet ${cur && cur.id === i.id ? 'selected' : ''}" data-cmd="selectIncident" data-id="${i.id}">#${i.id} ${esc(i.message.slice(0, 60))}<br><span class="muted">${esc(i.source)}${i.closed ? ', closed' : ''}</span></button>`).join('') || empty('No incidents yet.')}</div></section>
      <section>${cur ? `<h2>Incident report #${cur.id}</h2><pre>${esc(cur.message)}</pre><h3>Probable cause</h3><p>${esc(cur.cause)}</p><h3>Suggested investigation</h3><ol>${cur.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <p class="muted">${cur.similar} similar earlier incident(s). ${cur.changes.length} uncommitted file(s) at capture time.</p>
        <div class="row">${btn('Create bug report', 'bugReport', { id: cur.id })}${btn('Explain with AI', 'explain', { id: cur.id }, 'quiet')}${btn(cur.closed ? 'Reopen' : 'Close', 'closeIncident', { id: cur.id }, 'quiet')}${btn('Delete', 'deleteIncident', { id: cur.id }, 'quiet')}</div>
        <h3>Stack trace</h3>${list(cur.frames, (f) => `<span>${esc(f.fn || '(anonymous)')}</span>${f.local ? link(f.local, f.line) : `<span class="muted">${esc(f.file)}:${f.line}</span>`}`, 'No stack frames available.')}
        ${cur.variables.length ? `<h3>Variables</h3>${table(['Name', 'Value'], cur.variables.map((v) => tr([esc(v.name), esc(v.value)])))}` : ''}<h3>Related tests</h3>${list(cur.tests, (f) => link(f), 'No related tests found.')}<h3>Recent changes</h3>${list(cur.changes, (f) => `${link(f)}${cur.suspects.includes(f) ? badge('in stack', 'warn') : ''}`, 'No uncommitted changes.')}` : empty('An incident report will appear here.')}</section></div>`;
    },

    security() {
      const cats = {};
      for (const f of S.findings) cats[f.category] = (cats[f.category] || 0) + 1;
      const d = S.deps; const db = S.database;
      return `<div class="row"><h2 class="grow">Security and privacy: ${S.findingTotal} finding(s)</h2>${btn('Rescan', 'scan', {}, 'quiet')}${btn('Export report', 'securityReport')}</div><p>${Object.entries(cats).map(([k, v]) => badge(`${k}: ${v}`, 'running')).join(' ')}</p>
      <div class="cols"><section><h3>Security graph</h3><div class="pipe">${S.layers.map((l) => `<div><b>${esc(l.name)}</b><span class="${l.findings ? 'bad' : 'muted'}">${l.files} files, ${l.findings} findings</span></div>`).join('<i></i>')}</div></section>
      <section><div class="row"><h3 class="grow">Dependency security</h3>${btn('Check with npm', 'dependencies', {}, 'quiet')}</div>${d ? `${list(d.packages, (p) => `${badge(p.severity)}<span class="grow">${esc(p.name)}</span><span class="muted">${p.fix ? 'fix available' : 'no automatic fix'}</span>`, d.audited ? 'No known vulnerabilities.' : 'The audit was unavailable. A lockfile may be missing.')}<h3>Updates</h3>${list(d.outdated, (o) => `<span class="grow">${esc(o.name)}</span><span class="muted">${esc(o.current)} → ${esc(o.latest)}</span>`, 'Everything is up to date.')}` : empty('Run a check to list vulnerable and outdated packages.')}</section></div>
      <h2>Findings</h2>${S.findings.length ? table(['Severity', 'Finding', 'Location', 'Evidence'], S.findings.map((f) => tr([badge(f.severity), `<b>${esc(f.title)}</b><br><span class="muted">${esc(f.category)}. ${esc(f.fix)}</span>`, link(f.file, f.line), `<code>${esc(f.evidence)}</code>`]))) : empty('No findings from the pattern scanner. This is not proof that the project is secure.')}
      ${db && db.tables.length ? `<h2>Database tables</h2>${list(db.tables, (x) => `<span class="grow">${esc(x.name)}</span>${link(x.file, x.line)}`, '')}` : ''}`;
    },

    api() {
      const a = form.api; const r = S.response;
      let response = empty('Send a request to see the response.');
      if (r) response = r.pending ? empty('Waiting for the response…') : r.error ? `<div class="notice bad">${esc(r.error)}</div>` : `<p><b class="${r.status < 400 ? 'ok' : 'bad'}">${r.status} ${esc(r.statusText)}</b> in ${r.time} ms, ${r.size} bytes${r.truncated ? ' (truncated at 5 MB)' : ''}</p>
        <div class="row">${btn('Open in editor', 'openResponse', {}, 'quiet')}${btn('Generate test', 'apiTest', {}, 'quiet')}</div>
        ${r.schema ? (r.schema.length ? `<h3>Schema errors</h3>${list(r.schema, (e) => `<span class="bad">${esc(e)}</span>`, '')}` : '<p class="ok">The response matches the schema.</p>') : ''}
        ${r.diff ? `<h3>Compared with the previous response</h3>${list(r.diff, (e) => esc(e), 'No differences.')}` : ''}<pre>${esc(r.body)}</pre><details id="resp-headers"><summary>Response headers</summary><pre>${esc(r.headers)}</pre></details>`;
      const envs = Object.keys(S.environments);
      return `<h2>Request</h2><div class="row">${select('api.method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => [m, m]), 'Method')}${input('api.url', '{{baseUrl}}/users or https://api.example.com', 'grow', 'URL')}${select('api.environment', [['', 'No environment'], ...envs.map((e) => [e, e])], 'Environment')}${ui('Send', 'send', {}, '')}</div>
      <div class="cols"><section>${area('api.headers', 'Headers, one per line', 'Accept: application/json')}<label>Authentication</label><div class="row">${select('api.authType', [['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic (user:password)']], 'Authentication type')}${a.authType !== 'none' ? `<input id="f-api.authValue" type="password" class="grow" data-model="api.authValue" value="${esc(a.authValue)}" placeholder="Token or {{variable}}" aria-label="Credential">` : ''}</div>
        ${area('api.body', 'Body', '{ "email": "user@example.com" }')}${area('api.schema', 'Response JSON schema (optional)', '{ "type": "object", "required": ["id"] }')}<div class="row">${input('api.name', 'Request name', 'grow')}${ui('Save to collection', 'saveRequest')}${ui('Clear', 'apiClear')}</div></section><section>${response}</section></div>
      <h2>Endpoints in this project</h2>${S.endpoints.length ? table(['Endpoint', 'Implemented in', 'Consumers', ''], S.endpoints.map((e, n) => tr([`<span class="method">${esc(e.method)}</span>${esc(e.path)}`, link(e.file, e.line), e.consumers.map((c) => link(c.file, c.line)).join('<br>') || '<span class="muted">None found</span>', ui('Try', 'useEndpoint', { n }) + ' ' + ui('Impact', 'impact', { file: e.file })]))) : empty('No routes detected. Express, NestJS, Next.js, FastAPI, Flask, Django, Spring, Go and Laravel patterns are supported.')}
      <div class="cols"><section><div class="row"><h2 class="grow">Collection</h2>${btn('Export', 'exportCollections', {}, 'quiet')}</div>${list(S.collections, (c) => `<span class="grow"><span class="method">${esc(c.method)}</span>${esc(c.name)}</span>${ui('Load', 'loadSaved', { name: c.name })}${btn('Delete', 'deleteRequest', { name: c.name }, 'quiet')}`, 'Saved requests appear here.')}
        <h2>Environments</h2><p class="muted">Stored in VS Code secret storage. Use {{name}} in requests.</p><div class="row">${envs.map((e) => ui(e, 'editEnv', { name: e })).join('')}</div>${input('env.name', 'Environment name', '', 'Environment name')}${area('env.text', 'Variables, one KEY=value per line', 'baseUrl=http://localhost:3000')}<div class="row">${ui('Save environment', 'saveEnv', {}, '')}${ui('Delete', 'deleteEnv')}</div></section>
      <section><div class="row"><h2 class="grow">History</h2>${btn('Clear', 'clearHistory', {}, 'quiet')}</div>${list(S.history, (h) => `<span class="grow"><span class="method">${esc(h.method)}</span>${esc(h.url)} <span class="muted">${esc(h.status)}</span></span>${ui('Load', 'loadHistory', { time: h.time })}`, 'Sent requests appear here.')}
        <h2>Cookies</h2>${list(S.cookies, (c) => `${esc(c.host)}: ${esc(c.name)}`, 'No cookies stored in this session.')}${S.cookies.length ? btn('Clear cookies', 'clearCookies', {}, 'quiet') : ''}</section></div>`;
    }
  };

  function render() {
    $('tabs').innerHTML = TABS.map(([id, label]) => `<button role="tab" aria-selected="${id === tab}" data-ui="tab" data-tab="${id}">${label}</button>`).join('');
    if (!S) return;
    $('subtitle').textContent = S.workspace ? `${S.workspace}. Last scan: ${when(S.lastScan)}` : 'No project folder is open.';
    $('busy').hidden = !S.busy.length;
    $('busy').textContent = S.busy.length ? `Working: ${S.busy.join(', ')}` : '';
    let html = !S.workspace ? empty('Open a project folder to start.', btn('Open folder', 'openFolder')) : (views[tab] || views.command)();
    if (S.workspace && !S.trusted) html = `<div class="notice">Restricted mode: analysis works, running commands is disabled until you trust this workspace.</div>${html}`;
    if (html === lastHtml) return;
    const active = document.activeElement;
    const id = active && active.id;
    const range = id && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const open = [...document.querySelectorAll('details[open][id]')].map((d) => d.id);
    $('main').innerHTML = html;
    lastHtml = html;
    for (const d of open) if ($(d)) $(d).open = true;
    if (id && $(id)) { $(id).focus(); if (range) { try { $(id).setSelectionRange(range[0], range[1]); } catch (e) { /* not a text field */ } } }
  }

  const edit = () => { if (!draft) draft = JSON.parse(JSON.stringify(S.workflows)); return draft.find((x) => x.id === selected) || draft[0]; };
  const go = (name) => { tab = name; persist(); render(); window.scrollTo(0, 0); };
  const load = (spec) => { if (!spec) return; form.api = Object.assign(blankApi(), spec); lastHtml = ''; persist(); render(); window.scrollTo(0, 0); };

  const actions = {
    tab: (d) => go(d.tab),
    impact: (d) => { form.file = d.file; post('impact', { file: d.file }); go('understanding'); },
    impactSelected: () => post('impact', { file: form.file }),
    generateSelected: () => post('generateTest', { file: form.file }),
    search: () => { if (form.query.trim()) post('search', { query: form.query }); },
    stack: () => post('analyzeStack', { text: form.stack }),
    analyzeTests: () => { const t = S.tests; post('analyzeStack', { text: `Test failure: ${t.failures.map((f) => f.name).join(', ')}\n${t.output}` }); go('debugging'); },
    pick: (d) => { selected = d.id; persist(); render(); },
    wfNew: () => { if (!draft) draft = JSON.parse(JSON.stringify(S.workflows)); selected = `workflow-${Date.now()}`; draft.push({ id: selected, name: 'New workflow', trigger: 'manual', enabled: true, filePattern: '', steps: [] }); render(); },
    wfAdd: () => { const type = $('wf-add').value; edit().steps.push(type === 'command' ? { type, command: '' } : { type }); render(); },
    wfRemove: (d) => { edit().steps.splice(+d.n, 1); render(); },
    wfUp: (d) => { const s = edit().steps; const n = +d.n; if (n > 0) [s[n - 1], s[n]] = [s[n], s[n - 1]]; render(); },
    wfDown: (d) => { const s = edit().steps; const n = +d.n; if (n < s.length - 1) [s[n + 1], s[n]] = [s[n], s[n + 1]]; render(); },
    wfDelete: () => { const w = edit(); draft = draft.filter((x) => x !== w); selected = ''; render(); },
    wfSave: () => { post('saveWorkflows', { workflows: draft }); draft = null; render(); },
    wfDiscard: () => { draft = null; render(); },
    send: () => post('send', { spec: form.api }),
    saveRequest: () => post('saveRequest', { name: form.api.name, spec: form.api }),
    apiClear: () => load({}),
    useEndpoint: (d) => { const e = S.endpoints[+d.n]; load(Object.assign({}, form.api, { method: e.method === 'ALL' ? 'GET' : e.method, url: `{{baseUrl}}${e.path}`, body: '' })); if (!form.api.environment) { const first = Object.keys(S.environments)[0]; if (first) { form.api.environment = first; render(); } } },
    loadSaved: (d) => load(S.collections.find((c) => c.name === d.name)),
    loadHistory: (d) => load(S.history.find((h) => String(h.time) === d.time)),
    editEnv: (d) => { form.env = { name: d.name, text: S.environments[d.name] }; lastHtml = ''; render(); },
    saveEnv: () => { post('saveEnvironment', form.env); form.api.environment = form.env.name.trim(); },
    deleteEnv: () => post('deleteEnvironment', { name: form.env.name })
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    const data = Object.assign({}, el.dataset);
    if (data.ui) { if (actions[data.ui]) actions[data.ui](data); return; }
    if (data.cmd) { const cmd = data.cmd; delete data.cmd; post(cmd, data); }
  });

  function onInput(e) {
    const el = e.target;
    const d = el.dataset;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (d.model) {
      const [a, b] = d.model.split('.');
      if (b) form[a][b] = value; else form[a] = value;
      persist();
      if (e.type === 'change' && el.tagName === 'SELECT') render();
    } else if (d.wf) {
      edit()[d.wf] = value;
      if (e.type === 'change') render();
    } else if (d.step !== undefined) {
      edit().steps[+d.step][d.field] = value;
      if (e.type === 'change' && el.type === 'checkbox') render();
    }
  }
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'f-query') actions.search();
    if (e.target.id === 'f-api.url') actions.send();
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { S = m.state; render(); }
    if (m.type === 'tab') go(m.tab);
  });
  render();
  post('ready');
})();
