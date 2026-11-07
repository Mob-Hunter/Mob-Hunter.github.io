/**
 * Server-mode E2E: runs the real Worker (workerd via `wrangler dev`, fresh
 * Durable Object storage) and drives the console against it in Chromium:
 * first-run setup → MFA enrolment → sign-in → invite a Location Operator →
 * enrol a test device over the real device API → LOCATE → audited view.
 *
 *   npm run build && npm run test:e2e:server
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/`;
const TOKEN = 'e2e-bootstrap-token-0123456789';
const PW = 'correct horse battery staple';

function totp(b32, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of b32.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const persist = mkdtempSync(join(tmpdir(), 'fg-e2e-'));
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist,
  '--var', `PUBLIC_URL:http://127.0.0.1:${PORT}`, '--var', 'INSECURE_DEV_COOKIES:true', '--var', `BOOTSTRAP_TOKEN:${TOKEN}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
let wlog = '';
wrangler.stdout.on('data', (d) => (wlog += d));
wrangler.stderr.on('data', (d) => (wlog += d));

let step = 0;
const ok = (m) => console.log(`  ✓ ${++step}. ${m}`);
const browser = await chromium.launch();
try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}api/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const health = await (await fetch(`${BASE}api/health`)).json();
  assert.equal(health.needsBootstrap, true);
  ok(`Worker up in workerd (v${health.version}), fresh storage`);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const signIn = async (email, secret) => {
    await page.goto(`${BASE}#/login`);
    await page.getByLabel('Work e-mail').fill(email);
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code (MFA)').fill(totp(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
  };

  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Set up FleetGuard' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Bootstrap token').fill(TOKEN);
  await page.getByLabel('Your name').fill('Root Admin');
  await page.getByLabel('Work e-mail').fill('root@corp.test');
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByLabel('Confirm password').fill(PW);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  const rootSecret = await page.getByLabel('Or enter this key manually').inputValue();
  ok('first-run setup created the Super Admin and showed the authenticator QR');
  await page.getByRole('button', { name: /continue to sign in/ }).click();

  await signIn('root@corp.test', rootSecret);
  assert.equal(await page.locator('.env-live').textContent(), 'Live');
  assert.equal(await page.evaluate(() => document.cookie), '', 'session cookie must be HttpOnly');
  ok('signed in against the server (HttpOnly cookie, "Live" mode)');

  await page.getByRole('link', { name: /Users & access/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lee Locator');
  await page.getByLabel('Work e-mail').fill('lee@corp.test');
  await page.getByLabel('Role').selectOption('LOCATION_OPERATOR');
  await page.getByLabel('Temporary password').fill(PW);
  await page.getByRole('button', { name: 'Create' }).click();
  const opSecret = await page.getByLabel('Or enter this key manually').inputValue();
  ok('invited a Location Operator');

  await page.getByRole('link', { name: /Add devices/ }).click();
  await page.getByRole('button', { name: 'Mint token + QR' }).click();
  await page.getByAltText('Device-owner provisioning QR code').waitFor();
  const prov = JSON.parse(await page.locator('pre.code').textContent());
  assert.equal(prov['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'], `http://127.0.0.1:${PORT}/api/apk/1.0.0`);
  await page.getByRole('button', { name: /Simulate a phone scanning this QR/ }).click();
  await page.locator('.toast-ok', { hasText: 'enrolled' }).waitFor();
  await page.getByRole('link', { name: /Device simulator/ }).click();
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.locator('.toast-ok', { hasText: 'acknowledged' }).waitFor();
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByRole('link', { name: 'Unnamed device' }).click();
  await page.getByRole('heading', { name: 'Unnamed device' }).waitFor(); // detail page, not the list's inline rename
  await page.getByLabel('Device name', { exact: true }).fill('Pilot phone 1');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: 'Pilot phone 1' }).waitFor();
  ok('test device enrolled over the HTTP device API, acknowledged and renamed');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn('lee@corp.test', opSecret);
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByRole('link', { name: 'Pilot phone 1' }).click();
  await page.getByLabel('Command').selectOption('LOCATE');
  await page.getByLabel('Ticket reference').fill('INC-777');
  await page.getByLabel('Why is this necessary?').fill('Pilot test of lost-device recovery');
  await page.getByRole('button', { name: 'Send LOCATE' }).click();
  await page.locator('td', { hasText: 'succeeded' }).first().waitFor({ timeout: 30000 });
  ok('LOCATE signed by the server, pulled by the device, result returned');
  await page.getByLabel('Ticket justifying this view').fill('INC-777');
  await page.getByRole('button', { name: 'Show location', exact: true }).click();
  await page.getByRole('img', { name: /Map with 1 location fixes/ }).waitFor();
  ok('location decrypted server-side for the Location Operator only');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn('root@corp.test', rootSecret);
  await page.getByRole('link', { name: /Audit log/ }).click();
  await page.getByRole('button', { name: 'Verify hash chain' }).click();
  await page.getByText(/Chain intact/).waitFor();
  ok('audit hash chain verifies on the server');

  const r = await fetch(`${BASE}api/admin/devices`);
  assert.equal(r.status, 403, 'API must refuse calls without CSRF header/session');
  const res = await fetch(BASE);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  ok('unauthenticated API refused; security headers served on assets');

  assert.deepEqual(errors, []);
  console.log(`\nServer E2E passed (${step} checks)`);
} catch (e) {
  for (const c of browser.contexts()) for (const p of c.pages()) await p.screenshot({ path: 'e2e-server-failure.png', fullPage: true }).catch(() => {});
  console.error('\nServer E2E FAILED:', e.message, '\n--- wrangler log tail ---\n', wlog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  try {
    process.kill(-wrangler.pid, 'SIGTERM'); // whole process group: npx → wrangler → workerd
  } catch {}
  rmSync(persist, { recursive: true, force: true });
}
