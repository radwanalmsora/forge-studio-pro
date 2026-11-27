// Regenerates the PNG artwork. Requires: npm i -g sharp
const fs = require('fs');
const sharp = require('sharp');
const out = 'media/readme';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const F = "font-family='Poppins, Inter, sans-serif'";
const text = (x, y, s, size = 18, fill = '#e8eef7', weight = 500, anchor = 'middle') => `<text x='${x}' y='${y}' ${F} font-size='${size}' font-weight='${weight}' fill='${fill}' text-anchor='${anchor}'>${esc(s)}</text>`;
const box = (x, y, w, h, title, sub, color = '#27c2dc') => `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='10' fill='#172131' stroke='#2b3a52' stroke-width='1.5'/><rect x='${x}' y='${y + 10}' width='5' height='${h - 20}' fill='${color}'/>${text(x + w / 2, y + (sub ? h / 2 - 3 : h / 2 + 6), title, 17, '#f4f7fb', 600)}${sub ? text(x + w / 2, y + h / 2 + 19, sub, 12.5, '#93a4bd', 400) : ''}`;
const arrow = (x1, y1, x2, y2, color = '#e8672c') => { const a = Math.atan2(y2 - y1, x2 - x1); const p = (d) => `${x2 - 11 * Math.cos(a + d)},${y2 - 11 * Math.sin(a + d)}`; return `<path d='M${x1} ${y1}L${x2} ${y2}' stroke='${color}' stroke-width='2.5'/><path d='M${x2} ${y2}L${p(0.45)}L${p(-0.45)}z' fill='${color}'/>`; };
const frame = (w, h, title, body) => `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><rect width='${w}' height='${h}' rx='16' fill='#0e141f'/>${title ? text(32, 44, title, 22, '#ffffff', 700, 'start') + `<rect x='32' y='58' width='64' height='4' fill='#e8672c'/>` : ''}${body}</svg>`;
const chain = (items, y, w = 1100, color) => { const bw = (w - 64 - (items.length - 1) * 34) / items.length; return items.map(([t, s], i) => { const x = 32 + i * (bw + 34); return box(x, y, bw, 84, t, s, color) + (i ? arrow(x - 32, y + 42, x - 3, y + 42) : ''); }).join(''); };
const fan = (root, kids, y) => { const bw = (1036 - (kids.length - 1) * 20) / kids.length; return box(400, y, 300, 76, root[0], root[1], '#e8672c') + kids.map(([t, s], i) => { const x = 32 + i * (bw + 20); return arrow(550, y + 76, x + bw / 2, y + 160) + box(x, y + 163, bw, 84, t, s); }).join(''); };

const images = {
  'architecture': frame(1100, 560, 'Connected project intelligence', fan(['Project index', 'files, symbols, imports, routes'], [['Code', 'dependency graph'], ['API', 'routes and callers'], ['Database', 'schemas and tables'], ['Tests', 'results and coverage'], ['Deploy', 'history']], 90) + [0, 1, 2, 3, 4].map((i) => arrow(128 + i * 211, 340, 550, 425, '#27c2dc')).join('') + box(300, 428, 500, 90, 'Problem Solver and Command Center', 'one registry, one health score, one place to act', '#e8672c')),
  '01-command-center': frame(1100, 330, '01  Project Command Center', chain([['Signals', 'build, tests, Git'], ['Health score', '0 to 100'], ['Actions', 'ranked by impact'], ['Jump', 'file or system']], 100) + chain([['Build', 'run on demand'], ['Security', 'live findings'], ['API', 'endpoint count'], ['Database', 'connectivity'], ['Deploy', 'history']], 215)),
  '02-problem-solver': frame(1100, 400, '02  Universal Problem Solver', fan(['Problem #284', 'severity and status'], [['Editor', 'errors, warnings'], ['Security', 'findings'], ['Tests', 'failures'], ['Git', 'conflicts'], ['Runtime', 'incidents'], ['Design', 'cycles']], 100)),
  '03-understanding': frame(1100, 390, '03  Deep Project Understanding', chain([['LoginScreen', 'UI'], ['AuthController', 'HTTP'], ['AuthService', 'logic'], ['UserRepository', 'data'], ['Database', 'schema']], 100) + chain([['Your question', 'plain words'], ['Files to change', 'ranked'], ['Handle with care', 'shared files'], ['Tests to run', 'linked']], 240, 1100, '#e8672c')),
  '04-workflows': frame(1100, 340, '04  Workflow Automation Engine', chain([['Changes', 'Git status'], ['Analyze', 'impact'], ['Test', 'related'], ['Secure', 'scan'], ['Review', 'AI or rules'], ['Report', 'Markdown']], 100) + chain([['On open', ''], ['On save', ''], ['On failure', ''], ['Before commit', ''], ['Before deploy', ''], ['After deploy', '']], 220, 1100, '#e8672c')),
  '05-testing': frame(1100, 400, '05  Testing Universe', fan(['Changed file', 'PaymentService.ts'], [['Related tests', 'import graph'], ['Run', 'targeted or full'], ['Compare', 'new and fixed'], ['Coverage', 'lcov, Istanbul'], ['Gaps', 'untested, duplicate']], 100)),
  '06-debugging': frame(1100, 340, '06  Debugging Universe', chain([['Exception', 'debugger or task'], ['Evidence', 'stack, variables'], ['Context', 'changes, tests'], ['Incident', 'cause, history'], ['Bug report', 'Markdown']], 100) + chain([['Similar errors', 'signature match'], ['Heuristic cause', 'known patterns'], ['AI explanation', 'optional']], 225, 1100, '#e8672c')),
  '07-security': frame(1100, 340, '07  Security and Privacy Center', chain([['Input', 'UI'], ['Controller', 'routes'], ['Validation', 'schemas'], ['Service', 'logic'], ['Data', 'storage']], 100) + chain([['Secrets', 'keys, tokens'], ['Injection', 'SQL, XSS, shell'], ['Crypto and auth', 'TLS, JWT'], ['Privacy', 'logs, personal data'], ['Dependencies', 'npm audit']], 225, 1100, '#e8672c')),
  '08-api-studio': frame(1100, 340, '08  API Studio', chain([['Source routes', 'detected'], ['Request', 'auth, variables'], ['Response', 'JSON, timing'], ['Validate', 'schema, diff'], ['Test file', 'generated']], 100) + chain([['Collections', 'saved'], ['Environments', 'secret storage'], ['Cookies', 'session jar'], ['Consumers', 'linked files']], 225, 1100, '#e8672c'))
};

(async () => {
  const logo = fs.readFileSync('media/logo.svg');
  await sharp(logo).resize(256, 256).png().toFile('media/icon.png');
  for (const [name, svg] of Object.entries(images)) await sharp(Buffer.from(svg)).png().toFile(`${out}/${name}.png`);
  const mark = (await sharp(logo).resize(250, 250).png().toBuffer()).toString('base64');
  const banner = frame(1100, 360, '', `<image x='60' y='55' width='250' height='250' href='data:image/png;base64,${mark}'/>${text(350, 160, 'Forge Studio Pro', 62, '#ffffff', 700, 'start')}${text(354, 207, 'The Universal Software Development Control Center', 24, '#ff9a3d', 600, 'start')}${text(354, 250, 'Code, problems, tests, security, APIs and workflows in one place', 18, '#93a4bd', 400, 'start')}`);
  await sharp(Buffer.from(banner)).png().toFile(`${out}/banner.png`);
})();
