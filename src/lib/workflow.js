'use strict';
const { globToRegex } = require('./util');

const STEP_TYPES = {
  analyzeChanges: 'Analyze changes',
  diagnostics: 'Check editor errors',
  build: 'Run build',
  runTests: 'Run all tests',
  relatedTests: 'Run related tests',
  securityScan: 'Security scan',
  aiReview: 'AI code review',
  command: 'Shell command',
  incident: 'Create incident',
  report: 'Generate report'
};

const TRIGGERS = {
  manual: 'Manual only', onOpen: 'Project opened', onSave: 'File saved', onTaskFailure: 'Task failed',
  onTestFailure: 'Test failed', preCommit: 'Before commit', preDeploy: 'Before deploy', postDeploy: 'After deploy'
};

const s = (type, extra) => ({ type, ...extra });
const DEFAULTS = [
  { id: 'before-commit', name: 'Before Commit', trigger: 'preCommit', enabled: true, steps: [s('analyzeChanges'), s('relatedTests'), s('securityScan'), s('aiReview', { continueOnFail: true }), s('report')] },
  { id: 'environment-check', name: 'Environment Check', trigger: 'onOpen', enabled: false, steps: [s('command', { command: 'git --version' }), s('analyzeChanges'), s('report')] },
  { id: 'related-on-save', name: 'Related Files on Save', trigger: 'onSave', enabled: false, filePattern: 'src/**', steps: [s('analyzeChanges'), s('diagnostics')] },
  { id: 'incident-on-failure', name: 'Incident on Test Failure', trigger: 'onTestFailure', enabled: true, steps: [s('incident')] },
  { id: 'before-deploy', name: 'Before Deploy Review', trigger: 'preDeploy', enabled: true, steps: [s('diagnostics'), s('build'), s('runTests'), s('securityScan'), s('report')] }
];

function normalize(list) {
  if (!Array.isArray(list)) throw new Error('"workflows" must be an array.');
  const ids = new Set();
  return list.filter((w) => w && typeof w === 'object').slice(0, 50).map((w, i) => {
    const name = String(w.name || `Workflow ${i + 1}`).slice(0, 80);
    let id = String(w.id || name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')).slice(0, 80) || `workflow-${i}`;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return {
      id, name,
      trigger: Object.prototype.hasOwnProperty.call(TRIGGERS, w.trigger) ? w.trigger : 'manual',
      enabled: w.enabled !== false,
      filePattern: String(w.filePattern || ''),
      steps: (Array.isArray(w.steps) ? w.steps : []).filter((x) => x && Object.prototype.hasOwnProperty.call(STEP_TYPES, x.type)).slice(0, 30).map((x) => ({
        type: x.type,
        ...(x.type === 'command' ? { command: String(x.command || '') } : {}),
        continueOnFail: !!x.continueOnFail
      }))
    };
  });
}

const matches = (wf, trigger, file) => wf.enabled && wf.trigger === trigger && (!wf.filePattern || !file || globToRegex(wf.filePattern).test(file));

/** Runs steps in order. handlers[type](step, context) -> { status: 'passed'|'failed'|'warning'|'skipped', detail } */
async function run(wf, handlers, onUpdate = () => {}, context = {}) {
  const result = { id: wf.id, name: wf.name, started: Date.now(), status: 'running', steps: wf.steps.map((x) => ({ ...x, label: STEP_TYPES[x.type], status: 'pending', detail: '' })) };
  context.result = result;
  let stopped = false;
  for (const step of result.steps) {
    if (stopped) { step.status = 'skipped'; step.detail = 'An earlier step failed.'; continue; }
    step.status = 'running';
    onUpdate(result);
    const t = Date.now();
    try {
      Object.assign(step, await handlers[step.type](step, context));
    } catch (e) {
      Object.assign(step, { status: 'failed', detail: e.message || String(e) });
    }
    step.ms = Date.now() - t;
    if (step.status === 'failed' && !step.continueOnFail) stopped = true;
    onUpdate(result);
  }
  result.finished = Date.now();
  result.status = result.steps.some((x) => x.status === 'failed') ? 'failed' : result.steps.some((x) => x.status === 'warning') ? 'warning' : 'passed';
  onUpdate(result);
  return result;
}

function report(result) {
  const done = result.steps.filter((x) => x.type !== 'report');
  return `# Workflow report: ${result.name}\n\nStarted ${new Date(result.started).toISOString()}\n\n| Step | Result | Time |\n|---|---|---|\n` +
    done.map((x) => `| ${x.label} | ${x.status} | ${((x.ms || 0) / 1000).toFixed(1)} s |`).join('\n') + '\n\n' +
    done.filter((x) => x.detail).map((x) => `## ${x.label}\n\n~~~~\n${x.detail}\n~~~~\n`).join('\n');
}

module.exports = { STEP_TYPES, TRIGGERS, DEFAULTS, normalize, matches, run, report };
