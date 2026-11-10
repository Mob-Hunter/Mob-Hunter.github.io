// Writes <dir>/index.html: a static, dependency-free listing of every published download with its
// size and SHA-256, so https://…/downloads/ works on GitHub Pages (which has no directory listings).
// Usage: node scripts/downloads-index.mjs <dir> [consoleUrl]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const consoleUrl = (process.argv[3] || '').replace(/\/$/, '');
if (!dir) throw new Error('usage: downloads-index.mjs <dir> [consoleUrl]');

const sums = {};
for (const f of readdirSync(dir).filter((f) => /^SHA256SUMS.*\.txt$/.test(f))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) sums[m[2]] = m[1];
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const size = (f) => `${(statSync(join(dir, f)).size / 1048576).toFixed(1)} MB`;
const has = (f) => readdirSync(dir).includes(f);

const groups = [
  {
    title: 'Android',
    lead: 'Install the agent on phones (or let enrolment install it). The console app is for administrators.',
    files: [
      ['mob-hunter-agent.apk', 'Mob Hunter agent', 'For employee phones — enrol from the console with one QR scan'],
      ['mob-hunter-console.apk', 'Mob Hunter console', 'The administrator console as an Android app'],
    ],
  },
  {
    title: 'Computers',
    lead: 'The desktop agent. Usually you copy one command from Add devices → Computer, which downloads and enrols in one step.',
    files: [
      ['mob-hunter-agent-windows-amd64.exe', 'Windows 10 / 11 (x64)', 'Run enrol from an elevated PowerShell'],
      ['mob-hunter-agent-windows-arm64.exe', 'Windows 11 (ARM)', 'Surface Pro X, Snapdragon laptops'],
      ['mob-hunter-agent-linux-amd64', 'Linux (x86-64)', 'Ubuntu, Debian, Fedora, RHEL… (systemd)'],
      ['mob-hunter-agent-linux-arm64', 'Linux (ARM64)', 'ARM servers and laptops'],
      ['mob-hunter-agent-darwin-arm64', 'macOS (Apple silicon)', 'M1 and later'],
      ['mob-hunter-agent-darwin-amd64', 'macOS (Intel)', 'Intel Macs'],
    ],
  },
];

const rows = (g) =>
  g.files
    .filter(([f]) => has(f))
    .map(
      ([f, name, note]) => `
        <li class="item">
          <div class="meta">
            <strong>${esc(name)}</strong>
            <span class="note">${esc(note)}</span>
            <code class="hash" title="SHA-256">${esc(sums[f] ?? 'checksum missing')}</code>
          </div>
          <div class="acts">
            <a class="btn" href="${esc(f)}" download>Download <small>${size(f)}</small></a>
            <button class="btn ghost" type="button" data-copy="${esc(sums[f] ?? '')}">Copy SHA-256</button>
          </div>
        </li>`,
    )
    .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mob Hunter downloads</title>
<meta name="description" content="Signed Mob Hunter apps for Android, Windows, Linux and macOS, with SHA-256 checksums.">
<style>
  :root { --bg:#070b14; --card:#0e1626; --line:#1d2a42; --text:#e6edf7; --muted:#8fa3bf; --accent:#22d3ee; --on-accent:#04121a; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f7fb; --card:#fff; --line:#d9e1ec; --text:#0f172a; --muted:#516079; --accent:#0e7490; --on-accent:#ffffff; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:24px; }
  h1 { margin:0; font-size:1.9rem; } h1 span { color:var(--accent); }
  h2 { margin:32px 0 4px; font-size:1.2rem; } .lead { color:var(--muted); margin:0 0 12px; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  .item { display:flex; flex-wrap:wrap; gap:12px; justify-content:space-between; align-items:center; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .meta { display:grid; gap:2px; min-width:0; flex:1 1 380px; } .note { color:var(--muted); font-size:.9rem; }
  .hash { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); word-break:break-all; }
  .acts { display:flex; gap:8px; flex-wrap:wrap; }
  .btn { display:inline-flex; align-items:center; gap:6px; padding:9px 14px; border-radius:10px; background:var(--accent); color:var(--on-accent); font-weight:600; text-decoration:none; border:1px solid var(--accent); cursor:pointer; font-size:.95rem; }
  .btn small { font-weight:500; } .btn.ghost { background:transparent; color:var(--text); border-color:var(--line); }
  .btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .box { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-top:28px; color:var(--muted); font-size:.92rem; }
  .box code { color:var(--text); } a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Mob Hunter <span>downloads</span></h1>
    ${consoleUrl ? `<a class="btn ghost" href="${esc(consoleUrl)}/">Open the console →</a>` : ''}
  </header>
  <p class="lead">Every file is signed by the release pipeline and listed with its SHA-256. ${consoleUrl ? `For QR codes to scan with a phone, open <a href="${esc(consoleUrl)}/#/download">the download page</a>.` : ''}</p>
  ${groups.map((g) => `<section><h2>${esc(g.title)}</h2><p class="lead">${esc(g.lead)}</p><ul>${rows(g)}</ul></section>`).join('\n')}
  <div class="box">
    <strong>Verify a download.</strong> Linux / macOS: <code>sha256sum -c --ignore-missing SHA256SUMS-desktop.txt</code> (or <code>shasum -a 256 &lt;file&gt;</code>).
    Windows: <code>Get-FileHash .\\mob-hunter-agent-windows-amd64.exe</code>. Compare with the value above.
    Checksum files: <a href="SHA256SUMS.txt">SHA256SUMS.txt</a> (Android) · <a href="SHA256SUMS-desktop.txt">SHA256SUMS-desktop.txt</a> (computers).
  </div>
</main>
<script>
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { const t = b.textContent; b.textContent = '✓ Copied'; setTimeout(() => (b.textContent = t), 1500); });
  });
</script>
</body>
</html>
`;
writeFileSync(join(dir, 'index.html'), html);
console.log(`wrote ${join(dir, 'index.html')} (${Object.keys(sums).length} checksums)`);
