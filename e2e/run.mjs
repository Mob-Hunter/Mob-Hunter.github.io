/**
 * End-to-end test: serves the production build and drives it in Chromium
 * through the Phase 1 and Phase 2 acceptance flows, on a phone-sized viewport.
 *
 *   npm run build && npm run test:e2e
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const DIST = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = join(DIST, path.endsWith('/') ? `${path}index.html` : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

async function signIn(roleLabel) {
  await page.goto(`${base}#/login`);
  const row = page.locator('.demo-list li', { hasText: roleLabel }).first();
  await row.getByRole('button').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const code = (await row.locator('.totp code').textContent()).trim();
  await page.getByLabel('Authenticator code (MFA)').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
}
async function signOut() {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Continue' }).waitFor();
}

try {
  console.log('E2E against', base);
  await page.goto(base);
  await page.getByRole('heading', { name: 'Demo accounts' }).waitFor({ timeout: 60_000 });
  ok('app boots, demo tenant seeded');

  // Wrong MFA code is refused
  await page.getByRole('button', { name: /Helpdesk/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code (MFA)').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'Invalid authentication code' }).waitFor();
  ok('wrong MFA code rejected');

  // Phase 2: enrol + rename
  await signIn('Device Admin');
  ok('Device Admin signed in with password + TOTP');
  await page.getByRole('link', { name: /Add devices/ }).first().click();
  await page.getByRole('button', { name: 'Mint token + QR' }).click();
  await page.getByAltText('Device-owner provisioning QR code').waitFor();
  const installUrl = await page.getByLabel('Install page (share with the person enrolling)').inputValue();
  assert.match(installUrl, /#\/e\/[A-Za-z0-9_-]{20,}$/);
  ok('enrolment minted: QR + install link rendered');
  await page.getByRole('button', { name: /Simulate a phone scanning this QR/ }).click();
  await page.locator('.toast-ok', { hasText: 'enrolled' }).waitFor();
  ok('simulated phone enrolled with the one-time token');

  const install = await context.newPage();
  await install.goto(installUrl);
  await install.getByText('already used').waitFor();
  await install.close();
  ok('install link is single-use (shows "already used")');

  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByLabel('New / unnamed only').check();
  await page.waitForURL(/unnamed=1/);
  await page.getByText('Unnamed device').first().waitFor();
  const unnamedCount = await page.locator('.device-list li').count();
  assert.ok(unnamedCount >= 2, `expected >=2 unnamed devices, got ${unnamedCount}`);
  await page.locator('.device-list li').first().getByLabel('New device name').fill('Kavya sales phone');
  await page.locator('.device-list li').first().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast-ok', { hasText: 'renamed' }).waitFor();
  await page.getByLabel('New / unnamed only').uncheck();
  await page.getByRole('link', { name: 'Kavya sales phone' }).waitFor();
  ok('new device appeared as "Unnamed device" and was renamed inline');

  // Acknowledge notice on the simulator so the device can be located
  await page.getByRole('link', { name: /Device simulator/ }).click();
  await page.locator('.phone').nth(2).waitFor();
  const ackButtons = page.getByRole('button', { name: 'I understand' });
  while ((await ackButtons.count()) > 0) {
    await ackButtons.first().click();
    await page.locator('.toast-ok', { hasText: 'acknowledged' }).last().waitFor();
  }
  ok('employee notice acknowledged on every simulated phone');
  await signOut();

  // Phase 1: Helpdesk is denied LOCATE (not even offered) — backend check covered by unit tests
  await signIn('Helpdesk');
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  const options = await page.getByLabel('Command').locator('option').allTextContents();
  assert.ok(!options.includes('LOCATE'), 'Helpdesk must not be offered LOCATE');
  assert.equal(await page.getByRole('link', { name: /Locations/ }).count(), 0);
  ok('Helpdesk is not offered LOCATE and has no Locations menu');
  await signOut();

  // Phase 1: Location Operator locates through the relay
  await signIn('Location Operator');
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  await page.getByLabel('Command').selectOption('LOCATE');
  await page.getByLabel('Ticket reference').fill('INC-2041');
  await page.getByLabel('Why is this necessary?').fill('Employee reported the phone missing after a client visit');
  await page.getByRole('button', { name: 'Send LOCATE' }).click();
  await page.locator('td', { hasText: 'succeeded' }).first().waitFor({ timeout: 10_000 });
  ok('LOCATE signed → relay → push wake → device pulled, verified, replied');
  await page.getByLabel('Ticket justifying this view').fill('INC-2041');
  await page.getByRole('button', { name: 'Show locations' }).click();
  await page.getByRole('img', { name: /Map with 1 location fixes/ }).waitFor();
  ok('location result decrypted and plotted for the Location Operator');

  await page.getByRole('link', { name: /Device simulator/ }).click();
  const notif = page.locator('.notif', { hasText: 'Your device location was requested' }).first();
  await notif.waitFor();
  assert.match(await notif.textContent(), /INC-2041/);
  ok('phone showed the mandatory location notification with the ticket');

  const phone = page.locator('.phone-wrap', { has: page.locator('.notif', { hasText: 'INC-2041' }) });
  await phone.getByRole('button', { name: 'Test: tampered command' }).click();
  await page.locator('.toast-ok', { hasText: 'bad_signature' }).waitFor();
  await phone.getByRole('button', { name: 'Test: replay' }).click();
  await page.locator('.toast-ok', { hasText: 'Replayed command rejected' }).waitFor();
  ok('agent rejects tampered and replayed commands');

  const link = await notif.getByRole('link', { name: 'See details' }).getAttribute('href');
  const t = await context.newPage();
  await t.goto(base + link);
  await t.getByText('INC-2041').first().waitFor();
  await t.close();
  ok('employee transparency page lists the request');
  await signOut();

  // Audit chain verifies
  await signIn('Auditor');
  await page.getByRole('link', { name: /Audit log/ }).click();
  await page.getByRole('button', { name: 'Verify hash chain' }).click();
  await page.getByText(/Chain intact/).waitFor();
  assert.ok((await page.locator('table.audit tbody tr').count()) > 10);
  ok('audit hash chain verifies');

  // No horizontal scroll at phone width
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  ok('no horizontal page scroll at 390px');

  // CSP present
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.match(csp, /script-src 'self'/);
  ok('Content-Security-Policy is applied');

  assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`);
  ok('no console errors');
  console.log(`\nE2E passed (${step} checks)`);
} catch (e) {
  await page.screenshot({ path: 'e2e-failure.png', fullPage: true }).catch(() => {});
  console.error('\nE2E FAILED:', e.message, errors.length ? `\nBrowser errors:\n${errors.join('\n')}` : '');
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
