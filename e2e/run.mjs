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
import { AxeBuilder } from '@axe-core/playwright';

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
// The console probes ./api/health (server detection) and ./downloads/*.apk (download card);
// on a static host without them those 404s are expected. Any other 404 still fails the run.
let probe404 = 0;
let other404 = [];
page.on('response', (r) => {
  if (r.status() !== 404) return;
  if (/\/api\/health$|\/downloads\/([\w.-]+\.apk|SHA256SUMS(-desktop)?\.txt|mob-hunter-agent-[\w.-]+)$/.test(r.url())) probe404++;
  else other404.push(r.url());
});
page.on('console', (m) => m.type() === 'error' && !(probe404 > 0 && /status of 404/.test(m.text())) && errors.push(m.text()));
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
/** Main navigation, as a phone user does it: open the menu first when the menu button is shown. */
async function go(name) {
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: typeof name === 'string' }).click();
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
  await go(/Add devices/);
  await page.getByRole('button', { name: 'Mint token + QR' }).click();
  // Default tab: an existing phone — one QR that opens the enrolment page on the phone.
  const existing = page.getByAltText('Enrolment QR for an existing phone');
  await existing.waitFor();
  assert.equal(await existing.evaluate((img) => img.complete && img.naturalWidth > 0), true);
  const installUrl = await page.getByLabel('Or send this link to the phone').inputValue();
  assert.match(installUrl, /#\/e\/[A-Za-z0-9_-]{20,}$/);
  // Company phones: the zero-touch provisioning QR, large enough to scan from a screen.
  await page.getByRole('tab', { name: /Factory-reset company phone/ }).click();
  await page.getByAltText('Device-owner provisioning QR code').waitFor();
  const qr = await page.getByAltText('Device-owner provisioning QR code').evaluate((img) => ({ ok: img.complete && img.naturalWidth > 0, w: img.getBoundingClientRect().width }));
  assert.ok(qr.ok, 'provisioning QR image failed to load');
  assert.ok(qr.w >= 300, `provisioning QR too small to scan: ${qr.w}px`);
  ok('enrolment minted: existing-phone QR and company provisioning QR rendered');
  await page.getByRole('button', { name: /Simulate a phone scanning this QR/ }).click();
  await page.locator('.toast-ok', { hasText: 'enrolled' }).waitFor();
  ok('simulated phone enrolled with the one-time token');

  const install = await context.newPage();
  await install.goto(installUrl);
  await install.getByText('already used').waitFor();
  await install.close();
  ok('install link is single-use (shows "already used")');

  await go('Devices');
  await page.getByRole('tab', { name: /Unnamed/ }).click();
  await page.waitForURL(/unnamed=1/);
  await page.getByText('Unnamed device').first().waitFor();
  const unnamedCount = await page.locator('.device-list li').count();
  assert.ok(unnamedCount >= 2, `expected >=2 unnamed devices, got ${unnamedCount}`);
  await page.locator('.device-list li').first().getByLabel('New device name').fill('Kavya sales phone');
  await page.locator('.device-list li').first().getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast-ok', { hasText: 'renamed' }).waitFor();
  await page.getByRole('tab', { name: /^All/ }).click();
  await page.getByRole('link', { name: 'Kavya sales phone' }).waitFor();
  ok('new device appeared as "Unnamed device" and was renamed inline');

  // Acknowledge notice on the simulator so the device can be located
  await go(/Device simulator/);
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
  await go('Devices');
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  const options = await page.getByLabel('Command').locator('option').allTextContents();
  assert.ok(!options.includes('LOCATE'), 'Helpdesk must not be offered LOCATE');
  assert.equal(await page.locator('nav.sidenav a', { hasText: 'Locations' }).count(), 0);
  ok('Helpdesk is not offered LOCATE and has no Locations menu');
  await signOut();

  // Phase 1: Location Operator locates through the relay
  await signIn('Location Operator');
  await go('Devices');
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  await page.getByLabel('Command').selectOption('LOCATE');
  await page.getByLabel('Ticket reference').fill('INC-2041');
  await page.getByLabel('Why is this necessary?').fill('Employee reported the phone missing after a client visit');
  await page.getByRole('button', { name: 'Send LOCATE' }).click();
  await page.locator('td', { hasText: 'succeeded' }).first().waitFor({ timeout: 10_000 });
  ok('LOCATE signed → relay → push wake → device pulled, verified, replied');
  await page.getByLabel('Ticket justifying this view').fill('INC-2041');
  await page.getByRole('button', { name: 'Show location', exact: true }).click();
  await page.getByRole('img', { name: /Map with 1 location fixes/ }).waitFor();
  await page.getByText('Last position').waitFor();
  ok('location result decrypted, summarised and plotted for the Location Operator');

  await go(/Device simulator/);
  const notif = page.locator('.notif', { hasText: 'Your device location was requested' }).filter({ hasText: 'INC-2041' }).first();
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

  await go(/Locations/);
  await page.getByRole('heading', { name: 'Locations', exact: true }).waitFor();
  await page.locator('tr', { hasText: 'INC-1001' }).getByRole('button', { name: 'View' }).click();
  await page.getByRole('img', { name: /Map with 2 location fixes/ }).waitFor();
  assert.ok(await page.locator('.list li', { hasText: "Nimal's field phone" }).count() > 0);
  assert.ok((await page.locator('table tbody tr', { hasText: 'INC-1001' }).count()) >= 2);
  ok('Locations workspace: seeded ticket INC-1001 shows fleet map, latest position per device and history');

  // Lost / stolen incident with active tracking — the guided flow from Lost & stolen
  await go(/Lost & stolen/);
  await page.getByRole('link', { name: /Report a lost or stolen phone/ }).click();
  await page.getByRole('heading', { name: 'Report a lost or stolen phone' }).waitFor();
  await page.getByLabel('Search phones').fill('Nimal');
  await page.locator('.pick', { hasText: "Nimal's field phone" }).click();
  await page.getByRole('heading', { name: '2 · What happened?' }).waitFor();
  await page.getByLabel('Report as').selectOption('stolen');
  await page.getByLabel('Incident ticket').fill('INC-3001');
  await page.getByLabel('Tracking interval').selectOption('60');
  await page.getByLabel('Tracking duration').selectOption('4');
  await page.getByLabel('What happened (justification for tracking)').fill('Phone taken from a parked car, police ref 2026/1123');
  await page.getByRole('button', { name: /Report stolen & start tracking/ }).click();
  await page.waitForURL(/#\/incidents\/inc_/);
  await page.getByText(/Tracking every 1 min/).first().waitFor();
  await page.getByText('Stolen device:').waitFor();
  await page.getByRole('img', { name: /Live track with \d+ location fixes/ }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.flow li[aria-current="step"] strong').textContent(), 'Follow live');
  await go(/Lost & stolen/);
  await page.getByRole('heading', { name: /Open incidents \(1\)/ }).waitFor();
  await page.getByRole('link', { name: "Nimal's field phone" }).click();
  await page.getByRole('button', { name: /Recovered/ }).click();
  await page.locator('.toast-ok', { hasText: 'Lost Mode ended' }).waitFor();
  await page.getByText(/Closed as/).waitFor({ timeout: 20_000 });
  ok('guided report (pick phone → form) → live tracking with step tracker → one-click close as recovered');
  await signOut();

  // Audit chain verifies
  await signIn('Auditor');
  await go(/Audit log/);
  await page.getByRole('button', { name: 'Verify hash chain' }).click();
  await page.getByText(/Chain intact/).waitFor();
  assert.ok((await page.locator('table.audit tbody tr').count()) > 10);
  ok('audit hash chain verifies');

  await signOut();

  // Enterprise features: users, employees, compliance, settings (Super Admin)
  await signIn('Super Admin');
  await go(/Users & access/);
  await page.getByRole('heading', { name: 'Users & access', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Priya Auditor');
  await page.getByLabel('Work e-mail').fill('priya@example.com');
  await page.getByLabel('Role').selectOption('AUDITOR');
  await page.getByLabel('Temporary password').fill('Temp-Passw0rd-123');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByAltText('Authenticator enrolment QR code').waitFor();
  assert.match(await page.getByLabel('Or enter this key manually').inputValue(), /^[A-Z2-7]{32}$/);
  await page.getByText('Active sessions').waitFor();
  ok('Super Admin invited a user and got an authenticator QR; sessions listed');

  await go(/Employees/);
  await page.getByRole('heading', { name: 'Employees', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Tharindu Bandara');
  await page.getByLabel('Work e-mail').fill('tharindu@example.com');
  await page.getByLabel('Department').fill('Field Ops');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText('Tharindu Bandara').waitFor();
  await page.getByLabel('CSV file').setInputFiles({ name: 'hr.csv', mimeType: 'text/csv', buffer: Buffer.from('name,email,department\nAmali Dias,amali@example.com,Sales\nBad Row,not-an-email,X\n') });
  await page.getByText(/1 created, 0 updated, 1 rejected/).waitFor();
  ok('employee added and HR CSV imported (bad row rejected)');

  await go(/Compliance/);
  await page.getByRole('heading', { name: 'Compliance', exact: true }).waitFor();
  await page.getByText('Non-compliant').waitFor();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export inventory (CSV)' }).click();
  const file = await dl;
  assert.match(file.suggestedFilename(), /^device-inventory-.*\.csv$/);
  ok('compliance view rendered and inventory CSV exported');

  await go(/Settings/);
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByLabel('Data Protection Officer contact').fill('privacy@example.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast-ok', { hasText: 'Settings saved' }).waitFor();
  await page.getByText('Timesheets', { exact: true }).waitFor();
  ok('organisation settings saved; app catalogue shown');

  // MDM parity: groups + asset tag on a device, restrictions, then a bulk message to a group.
  await go('Devices');
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  await page.getByRole('heading', { name: 'Kavya sales phone' }).waitFor();
  await page.getByLabel('Groups').fill('Sales, Colombo');
  await page.getByLabel('Asset tag').fill('MH-000777');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast-ok', { hasText: 'recorded in the audit log' }).first().waitFor();
  await page.getByRole('switch', { name: /Disable camera/ }).check();
  await page.getByRole('switch', { name: /Block screenshots/ }).check();
  await page.getByLabel('Justification (DPIA / ticket / programme)').fill('Secure-site policy, SEC-12');
  await page.getByRole('button', { name: 'Save policy (2 changes)' }).click();
  await page.locator('.toast-ok', { hasText: 'Policy updated' }).waitFor();
  await page.getByRole('button', { name: 'No changes' }).waitFor();
  assert.equal(await page.getByRole('switch', { name: /Disable camera/ }).isChecked(), true);
  ok('device grouped and asset-tagged; camera + screenshot restrictions saved as a new policy version');

  await go('Devices');
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.getByLabel('Filter by group').selectOption('Sales');
  await page.getByText('MH-000777').waitFor();
  assert.equal(await page.locator('.device-list > li').count(), 1);
  await page.getByLabel('Select all shown devices').check();
  await page.getByRole('button', { name: 'Message…' }).click();
  await page.getByLabel(/Message to 1 phone/).fill('Team meeting moved to 3 pm');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.toast-ok', { hasText: 'Message: sent to 1 device' }).waitFor();
  await go(/Device simulator/);
  await page.locator('.notif', { hasText: 'Team meeting moved to 3 pm' }).first().waitFor({ timeout: 10_000 });
  ok('group filter + bulk MESSAGE delivered as a visible notification on the phone');

  // Device lifecycle end: retire, then delete (Super Admin). Super Admin holds every permission, so the
  // device page offers the ticketed location view instead of the "Restricted" notice.
  await go('Devices');
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Unnamed device' }).first().click();
  await page.getByRole('heading', { name: 'Unnamed device' }).waitFor();
  await page.getByLabel('Ticket justifying this view').first().waitFor();
  assert.equal(await page.getByText('Restricted.').count(), 0);
  const deviceUrl = page.url();
  await page.getByLabel('Reason', { exact: true }).fill('Returned to IT stock, screen cracked');
  await page.getByRole('button', { name: 'Retire', exact: true }).click();
  await page.locator('.toast-ok', { hasText: 'retired' }).waitFor();
  await page.getByLabel('Reason for deletion').fill('Disposed via certified e-waste, ref EW-221');
  await page.getByLabel('Type "DELETE" to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await page.waitForURL(/#\/devices$/);
  await page.getByRole('tab', { name: /Retired/ }).click();
  await page.getByText('No retired or wiped devices.').waitFor();
  await page.goto(deviceUrl);
  await page.getByRole('alert').filter({ hasText: 'Device not found' }).waitFor();
  await go(/Audit log/);
  await page.getByLabel('Filter audit rows').fill('device.deleted');
  await page.locator('table.audit tbody tr', { hasText: 'device.deleted' }).first().waitFor();
  ok('device retired, then permanently deleted with reason + typed confirmation; recorded in the audit log');

  // Deleting an ACTIVE device: the agent releases management and uninstalls itself, then the record is deleted.
  await go('Devices');
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Kavya sales phone' }).click();
  await page.getByRole('heading', { name: 'Kavya sales phone' }).waitFor();
  await page.getByLabel('Reason for deletion').fill('Employee left; phone kept as personal');
  await page.getByLabel('Type "DELETE" to confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Uninstall agent & delete' }).click();
  await page.locator('.toast-ok', { hasText: 'uninstall itself' }).waitFor();
  await go('Devices');
  await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('.device-name')].some((a) => a.textContent === 'Kavya sales phone'), null, { timeout: 15_000 });
  await go(/Device simulator/);
  await page.getByText('Personal phone — not managed').first().waitFor();
  await page.getByText('This phone is no longer managed').first().waitFor();
  await go(/Audit log/);
  await page.getByLabel('Filter audit rows').fill('device.released');
  await page.locator('table.audit tbody tr', { hasText: 'device.released' }).first().waitFor();
  ok('deleting an active device: agent released management and uninstalled itself, then the record was deleted');

  // Phone tables become labelled cards (the audit log is readable without sideways scrolling)
  const label = await page.locator('table.audit tbody tr').first().locator('td').nth(3).getAttribute('data-label');
  assert.equal(label, 'Action');
  assert.equal(await page.locator('table.audit thead').evaluate((t) => t.getBoundingClientRect().height <= 1), true);
  ok('audit log rows stack as labelled cards on a phone');

  // Phone menu: opens, lists every section, closes on Escape and after navigating
  const menuBtn = page.getByRole('button', { name: 'Open menu' });
  await menuBtn.click();
  const mainNav = page.getByRole('navigation', { name: 'Main' });
  await mainNav.getByRole('link', { name: /Settings/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await mainNav.getByRole('link', { name: /Settings/ }).waitFor({ state: 'hidden' });
  await go(/Compliance/);
  await page.getByRole('heading', { name: 'Compliance', level: 1 }).waitFor();
  assert.equal(await mainNav.getByRole('link', { name: /Settings/ }).isVisible(), false);
  ok('phone menu opens, closes on Escape and after navigating');

  // Console search: Ctrl+K finds a device by serial and opens it; the Help page filters its guides.
  await go('Devices');
  // Pick a named, active device and find it by its serial number.
  const row = page.locator('.device-list li:not(.unnamed)').first();
  const deviceName = (await row.locator('.device-name').textContent()).trim();
  const serial = (await row.locator('.device-main .small').textContent()).split(' · ')[1].trim();
  // Park the pointer where the second result will appear: a resting cursor must not steal the
  // keyboard selection when the list opens under it (Chromium sends a synthetic mouse event).
  await page.mouse.move(195, 250);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Search the console' });
  await search.waitFor();
  await search.fill(serial);
  await page.getByRole('option', { name: new RegExp(deviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: deviceName, level: 1 }).waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#\/devices\/dev_/);
  await page.keyboard.press('Control+k');
  await search.fill('help');
  await page.getByRole('option', { name: /Help & guides/ }).click();
  await page.getByRole('heading', { name: 'Help & guides', level: 1 }).waitFor();
  await page.getByLabel('Search the guides').fill('stolen');
  await page.getByText('A phone is lost or stolen').waitFor();
  assert.equal(await page.locator('.help-item').count(), 1);
  ok('Ctrl+K search opens a device by serial; Help & guides filters by topic');

  // Threat landscape: seeded phone + computers show their threats; one-click remediation and risk acceptance.
  await go(/Threat landscape/);
  await page.getByRole('heading', { name: 'Threat landscape', exact: true }).waitFor();
  await page.getByRole('status', { name: /Fleet threat level (high|critical)/ }).waitFor();
  for (const t of ['Security patch more than 6 months old', 'USB debugging enabled', 'Connected to an open Wi-Fi network', 'Firewall off', 'Storage not encrypted']) {
    await page.locator('.threat-list .threat', { hasText: t }).first().waitFor();
  }
  await page.getByLabel('Filter by platform').selectOption('windows');
  const fw = page.locator('.threat-list .threat', { hasText: 'Firewall off' });
  await fw.waitFor();
  assert.equal(await page.locator('.threat-list .threat', { hasText: 'Linux' }).count(), 0);
  await fw.getByRole('button', { name: 'Send instructions' }).click();
  await page.locator('.toast-ok', { hasText: 'Send instructions: sent' }).waitFor();
  await page.getByLabel('Filter by platform').selectOption('linux');
  const upd = page.locator('.threat-list .threat', { hasText: 'OS updates waiting to install' });
  await upd.getByRole('button', { name: 'Accept risk…' }).click();
  await upd.getByLabel('Why is this risk acceptable?').fill('Build server patched in the monthly window, CHG-301');
  await upd.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.locator('.toast-ok', { hasText: 'Risk accepted' }).waitFor();
  await page.getByLabel('Show accepted').check();
  await page.locator('.threat-list .threat.accepted', { hasText: 'CHG-301' }).waitFor();
  ok('threat landscape: phone + computer threats, filter by platform, one-click remediation, time-limited risk acceptance');

  // A computer enrols with the desktop agent (one command; simulated in demo mode).
  await page.goto(`${base}#/enrol?platform=desktop`);
  await page.getByRole('heading', { name: 'Add devices' }).waitFor();
  await page.getByRole('button', { name: 'Mint token + QR' }).click();
  await page.getByRole('tab', { name: 'Linux', exact: true }).click();
  const cmd = await page.getByLabel('Install command').textContent();
  assert.match(cmd, /sudo mob-hunter-agent enrol 'mobhunter:\/\/enrol\?server=/);
  await page.getByRole('tab', { name: /Windows 10/ }).click();
  assert.match(await page.getByLabel('Install command').textContent(), /Invoke-WebRequest .*mob-hunter-agent-windows-\$a\.exe/);
  await page.getByRole('button', { name: /Simulate this computer enrolling/ }).click();
  await page.locator('.toast-ok', { hasText: 'Simulated computer enrolled' }).waitFor();
  await go('Devices');
  await page.getByLabel('Filter by platform').selectOption('windows');
  assert.equal(await page.locator('.device-list > li').count(), 2);
  ok('computer enrolment: per-OS install command with the one-time link; Windows computer enrolled and listed');

  // Accessibility: no serious or critical WCAG 2.1 AA violations on the main screens
  for (const route of ['#/', '#/devices', '#/threats', '#/enrol?platform=desktop', '#/apps', '#/audit', '#/settings', '#/privacy', '#/download']) {
    await page.goto(`${base}${route}`);
    await page.locator('h1').first().waitFor();
    await page.waitForTimeout(300);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    assert.deepEqual(bad.map((v) => `${route} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), []);
  }
  ok('no serious/critical accessibility violations (axe, WCAG 2.1 AA) on the main screens');

  // No horizontal scroll at phone width
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  ok('no horizontal page scroll at 390px');

  // CSP present
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.match(csp, /script-src 'self'/);
  ok('Content-Security-Policy is applied');

  assert.deepEqual(other404, [], `unexpected 404s: ${other404.join(', ')}`);
  assert.deepEqual(errors, [], `browser errors: ${errors.join('\n')}`);
  ok('no console errors');
  console.log(`\nE2E passed (${step} checks)`);
} catch (e) {
  await page.screenshot({ path: 'e2e-failure.png', fullPage: true }).catch(() => {});
  // Enough page state in the log to diagnose a CI-only failure without the screenshot.
  const state = await page
    .evaluate(() => ({
      hash: location.hash,
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent),
      options: [...document.querySelectorAll('[role=option]')].map((o) => `${o.getAttribute('aria-selected') === 'true' ? '>' : ' '} ${o.textContent}`),
      alerts: [...document.querySelectorAll('[role=alert], .toast')].map((a) => a.textContent),
    }))
    .catch((x) => ({ error: String(x) }));
  console.error('Page state at failure:', JSON.stringify(state, null, 1));
  console.error('\nE2E FAILED:', e.message, errors.length ? `\nBrowser errors:\n${errors.join('\n')}` : '');
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
