/**
 * Real-OS service test for the desktop agent (run in CI on Windows, macOS and Linux runners):
 * a fresh Mob Hunter Worker in workerd, the real agent binary enrolled with the one-time link, and the
 * background service it installs (Windows service + Event Log / systemd unit / launch daemon).
 * Checks: service running, log file, Event Log (Windows), device active with inventory, commands run by
 * the service loop, and deletion → RELEASE → service and credentials removed.
 * Usage: node e2e/desktop-service.mjs <path-to-agent-binary>   (needs admin/root rights; uses sudo on Unix)
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const BIN = resolve(process.argv[2] ?? '');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const PLATFORM = WIN ? 'windows' : MAC ? 'macos' : 'linux';
const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `svc-${randomBytes(6).toString('hex')}`;
const DATA = WIN ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'MobHunter') : MAC ? '/Library/Application Support/MobHunter' : '/var/lib/mob-hunter';
let step = 0;
const ok = (m) => console.log(`  ✓ ${++step}. ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const asRoot = (cmd, args) => (WIN ? sh(cmd, args) : sh('sudo', [cmd, ...args]));

assert.ok(existsSync(BIN), `agent binary not found: ${BIN}`);
const state = mkdtempSync(join(tmpdir(), 'mh-svc-'));
const wrangler = spawn(WIN ? 'npx.cmd' : 'npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', `PUBLIC_URL:${BASE}`, '--var', 'INSECURE_DEV_COOKIES:true', '--var', `BOOTSTRAP_TOKEN:${TOKEN}`], { stdio: 'ignore', shell: WIN, detached: !WIN });
const stopServer = () => {
  try {
    if (WIN) execFileSync('taskkill', ['/pid', String(wrangler.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-wrangler.pid);
  } catch {}
};

// ---- minimal admin client: cookie session + CSRF header + TOTP
let cookie = '';
async function api(method, path, body) {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-mob-hunter-csrf': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
async function must(method, path, body) {
  const r = await api(method, path, body);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function until(what, fn, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}
function serviceState() {
  if (WIN) return sh('sc.exe', ['query', 'MobHunterAgent']).stdout;
  if (MAC) return asRoot('launchctl', ['print', 'system/com.mobhunter.agent']).status === 0 ? 'loaded running' : 'absent';
  return sh('systemctl', ['is-active', 'mob-hunter-agent']).stdout.trim();
}
const running = () => (WIN ? /RUNNING/.test(serviceState()) : MAC ? serviceState().includes('loaded') : serviceState() === 'active');
const readLog = () => (WIN ? readFileSync(join(DATA, 'logs', 'agent.log'), 'utf8') : asRoot('cat', [join(DATA, 'logs', 'agent.log')]).stdout);

let failed = false;
try {
  console.log(`Desktop agent service E2E on ${PLATFORM} (${BIN})`);
  await until('the Worker to start', async () => (await fetch(`${BASE}/api/health`)).ok, 120_000);
  const b = await must('POST', '/bootstrap', { token: TOKEN, name: 'Root', email: 'root@corp.test', password: 'correct horse battery staple' });
  const ch = await must('POST', '/admin/login', { email: 'root@corp.test', password: 'correct horse battery staple' });
  await must('POST', '/admin/mfa', { challengeId: ch.challengeId, code: totp(b.totpSecret) });
  const e = await must('POST', '/admin/enrollments', {});
  ok('fresh server, Super Admin signed in, one-time enrolment link minted');

  const enrol = asRoot(BIN, ['enrol', e.standardLink, '--accept-notice']);
  console.log(enrol.stdout.trim().split('\n').slice(-3).join('\n'));
  assert.equal(enrol.status, 0, `enrol failed: ${enrol.stderr}`);
  ok('agent enrolled with the real binary and installed its background service');

  await until('the service to be running', async () => running(), 60_000);
  ok(`service running: ${WIN ? 'Windows service MobHunterAgent (LocalSystem, automatic)' : MAC ? 'launch daemon com.mobhunter.agent' : 'systemd unit mob-hunter-agent'}`);
  if (WIN) {
    const cfg = sh('sc.exe', ['qc', 'MobHunterAgent']).stdout;
    assert.match(cfg, /AUTO_START/);
    assert.match(cfg, /LocalSystem/);
    const fail = sh('sc.exe', ['qfailure', 'MobHunterAgent']).stdout;
    assert.match(fail, /RESTART/);
    ok('service configured: automatic (delayed) start, LocalSystem, restart on failure');
  }

  const devices = await until('the device to check in', async () => {
    const r = await must('GET', '/admin/devices');
    return r.length === 1 && r[0].state === 'active' && r[0].inventoryAt ? r : null;
  });
  const d = devices[0];
  assert.equal(d.platform, PLATFORM);
  const inv = await must('GET', `/admin/devices/${d.id}/inventory`);
  assert.ok(inv.data.os.name && inv.data.hardware.threads > 0, 'inventory OS/hardware');
  assert.ok(inv.data.settings.length >= 3, `settings: ${inv.data.settings.length}`);
  ok(`device active as ${PLATFORM}: ${inv.data.os.name}; ${inv.data.settings.length} settings, ${inv.data.disks.length} volumes, ${inv.data.network.length} adapters, ${inv.data.software.length} programs`);
  console.log('     settings:', inv.data.settings.map((s) => `${s.name}=${s.value}`).join(' | ').slice(0, 900));

  // The service loop pulls commands every minute.
  await must('POST', `/admin/devices/${d.id}/commands`, { type: 'COLLECT_INVENTORY' });
  await must('POST', `/admin/devices/${d.id}/policy`, { patch: { syncIntervalMin: 5 }, justification: '' });
  await until('the service to run the commands', async () => {
    const cmds = await must('GET', `/admin/commands?deviceId=${d.id}`);
    return cmds.length >= 2 && cmds.every((c) => c.status === 'succeeded') ? cmds : null;
  }, 200_000);
  ok('the running service pulled, verified and ran COLLECT_INVENTORY and SYNC_POLICY');

  const log = readLog();
  assert.match(log, /running for dev_/);
  assert.match(log, /inventory sent/);
  ok(`log file ${join(DATA, 'logs', 'agent.log')} records the service activity`);
  if (WIN) {
    const ev = sh('powershell.exe', ['-NoProfile', '-Command', "(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MobHunterAgent'} -MaxEvents 20 | Measure-Object).Count"]).stdout.trim();
    assert.ok(Number(ev) > 0, `no Event Log entries (${ev})`);
    ok(`Windows Event Log (Application, source MobHunterAgent): ${ev} recent entries`);
  }
  const status = asRoot(BIN, ['status']).stdout;
  assert.match(status, /checks in every 5m0s/);
  ok('`mob-hunter-agent status` shows the service and the console-set interval (5 min)');

  await must('POST', `/admin/devices/${d.id}/delete`, { reason: 'Service E2E finished', confirm: 'DELETE' });
  await until('the device record to be erased', async () => (await api('GET', `/admin/devices/${d.id}`)).status === 404, 200_000);
  await until('the service to be removed', async () => !running(), 60_000);
  assert.ok(!existsSync(join(DATA, 'agent.json')) || (!WIN && asRoot('test', ['-e', join(DATA, 'agent.json')]).status !== 0), 'credentials left on disk');
  ok('deleted in the console → signed RELEASE → service removed, credentials erased, record deleted');
  console.log(`\nDesktop service E2E passed on ${PLATFORM} (${step} checks)`);
} catch (err) {
  failed = true;
  console.error(`\nDesktop service E2E FAILED on ${PLATFORM}: ${err.stack ?? err}`);
  console.error('service state:', serviceState());
  try {
    console.error('agent log:\n' + readLog().split('\n').slice(-40).join('\n'));
  } catch {}
} finally {
  stopServer();
  if (failed) asRoot(BIN, ['uninstall']);
  process.exit(failed ? 1 : 0);
}
