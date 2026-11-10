import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { detectThreats, patchAgeDays, riskBand, riskScore } from '../src/core/threats';
import { unsupportedReason } from '../src/core/backend';
import { SimulatedAgent, newAgentFromProvisioning } from '../src/core/agent';
import type { Device } from '../src/core/types';

const DAY = 86_400_000;

describe('threat detection rules', () => {
  const now = Date.UTC(2026, 10, 9);
  const base = { id: 'dev_1', platform: 'android', state: 'active', enrolledAt: now - 30 * DAY, lastCheckinAt: now - 60_000, lostMode: false } as Device;
  const ctx = { commands: [], incidents: [] };
  const keys = (d: Partial<Device>) => detectThreats({ ...base, ...d } as Device, now, ctx).map((t) => t.key);
  const tel = (security: object, extra: object = {}) => ({ telemetry: { batteryLevel: 50, batteryHealth: 'good', batteryTempC: 30, storageFreeGb: 10, storageTotalGb: 64, integrity: 'MEETS_DEVICE_INTEGRITY', patchLevel: '2026-10-05', security, ...extra } }) as Partial<Device>;

  it('maps each posture signal to its threat, and a clean device has none', () => {
    expect(keys(tel({ screenLock: true, encrypted: true, usbDebugging: false }))).toEqual([]);
    expect(keys(tel({ screenLock: false }))).toEqual(['no_screen_lock']);
    expect(keys(tel({ encrypted: false, firewall: false, antivirus: false, openWifi: true, secureBoot: false }))).toEqual(['not_encrypted', 'antivirus_off', 'firewall_off', 'open_wifi', 'secure_boot_off']);
    // USB debugging implies developer options: reported once, as the more serious one.
    expect(keys(tel({ usbDebugging: true, devOptions: true }))).toEqual(['usb_debugging']);
    expect(keys(tel({ devOptions: true }))).toEqual(['dev_options']);
    expect(keys(tel({ compromised: true }))).toEqual(['device_compromised']);
    expect(keys(tel({}, { integrity: 'FAILED' }))).toEqual(['device_compromised']);
    expect(keys(tel({}, { integrity: 'MEETS_BASIC_INTEGRITY' }))).toEqual(['integrity_basic']);
    expect(keys(tel({ pendingUpdates: 3 }))).toEqual(['updates_pending']);
  });

  it('ages the security patch level', () => {
    expect(patchAgeDays('2026-10-05', now)).toBe(35);
    expect(patchAgeDays('2026-04', now)).toBe(222);
    expect(patchAgeDays('garbage', now)).toBeNull();
    expect(keys(tel({}, { patchLevel: '2026-07-01' }))).toEqual(['patch_outdated']);
    expect(keys(tel({}, { patchLevel: '2026-03-01' }))).toEqual(['patch_critical']);
  });

  it('flags silent and half-enrolled devices, and ignores decommissioned ones', () => {
    expect(keys({ lastCheckinAt: now - 4 * DAY })).toEqual(['agent_silent']);
    expect(keys({ state: 'enrolled', enrolledAt: now - 2 * DAY })).toEqual(['notice_pending']);
    expect(keys({ ...tel({ screenLock: false }), state: 'retired' })).toEqual([]);
    expect(keys({ lostMode: true })).toEqual(['device_stolen']);
  });

  it('scores and bands risk', () => {
    expect(riskScore([])).toBe(0);
    expect(riskScore(['medium', 'low'])).toBe(14);
    expect(riskScore(['critical', 'critical', 'critical'])).toBe(100);
    expect([0, 4, 20, 40, 70].map(riskBand)).toEqual(['secure', 'low', 'medium', 'high', 'critical']);
  });
});

describe('threat lifecycle in the backend', () => {
  it('detects at check-in, resolves when fixed, keeps a timeline and a daily snapshot', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    agent.state.posture = { patchLevel: '2026-03-01', security: { screenLock: false, openWifi: true } };
    await agent.checkin();
    let d = backend.getDevice(admin, deviceId);
    expect(d.risk.threats.map((t) => t.key)).toEqual(['patch_critical', 'no_screen_lock', 'open_wifi']);
    expect(d.risk.score).toBe(50);
    expect(d.risk.band).toBe('high');

    const auditor = await signIn('AUDITOR'); // every console role may read the landscape
    let land = backend.getThreatLandscape(auditor);
    expect(land.counts).toEqual({ critical: 0, high: 2, medium: 1, low: 0 });
    expect(land.devicesAtRisk).toBe(1);
    expect(land.band).toBe('high');
    expect(land.byPlatform).toEqual([{ platform: 'android', devices: 1, atRisk: 1, threats: 3 }]);
    expect(land.topDevices[0]).toMatchObject({ deviceId, score: 50 });
    expect(land.history.at(-1)).toMatchObject({ high: 2, medium: 1, devicesAtRisk: 1, devices: 1 });

    // The user sets a screen lock and leaves the open network → those threats resolve.
    agent.state.posture = { patchLevel: '2026-03-01', security: { screenLock: true, openWifi: false } };
    await agent.checkin();
    d = backend.getDevice(admin, deviceId);
    expect(d.risk.threats.map((t) => t.key)).toEqual(['patch_critical']);
    land = backend.getThreatLandscape(auditor);
    expect(land.resolved7d).toBe(2);
    expect(land.events.slice(0, 2).map((e) => e.kind)).toEqual(['resolved', 'resolved']);
  });

  it('accepting a risk is reasoned, time-limited, audited and excluded from the score; critical ones cannot be accepted', async () => {
    const { backend, enrolledAgent, signIn, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    agent.state.posture = { security: { usbDebugging: true, compromised: true } };
    await agent.checkin();
    const sec = await signIn('SECURITY');
    await expect(backend.acceptThreat(sec, deviceId, 'usb_debugging', { reason: 'no' })).rejects.toMatchObject({ code: 'justification_required' });
    await expect(backend.acceptThreat(sec, deviceId, 'device_compromised', { reason: 'Developer test phone' })).rejects.toMatchObject({ code: 'not_acceptable' });
    await expect(backend.acceptThreat(await signIn('HELPDESK'), deviceId, 'usb_debugging', { reason: 'Developer test phone' })).rejects.toMatchObject({ status: 403 });
    const d = await backend.acceptThreat(sec, deviceId, 'usb_debugging', { reason: 'Developer test phone, SEC-88', days: 7 });
    expect(d.risk.threats.find((t) => t.key === 'usb_debugging')?.accepted).toMatchObject({ byName: 'SECURITY', reason: 'Developer test phone, SEC-88' });
    expect(d.risk.score).toBe(40); // only the critical one counts
    expect(backend.listAudit(sec).some((r) => r.action === 'threat.accepted')).toBe(true);
    // After 7 days the acceptance lapses and the threat counts again.
    clock.advance(8 * 86_400_000);
    await agent.checkin();
    expect(backend.getDevice(await signIn('SECURITY'), deviceId).risk.threats.find((t) => t.key === 'usb_debugging')?.accepted).toBeNull();
  });

  it('a command the agent rejects as tampered becomes a critical management-channel threat', async () => {
    const { backend, enrolledAgent } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await backend.issueCommand(admin, deviceId, { type: 'LOCK' });
    // Simulate an attacker altering the envelope in transit: the agent's verifier refuses it.
    (agent as unknown as { verify: () => Promise<unknown> }).verify = async () => ({ ok: false, reason: 'bad_signature' });
    await agent.poll();
    const t = backend.getDevice(admin, deviceId).risk.threats;
    expect(t[0]).toMatchObject({ key: 'command_tampering', severity: 'critical' });
    expect(backend.getThreatLandscape(admin).band).toBe('critical');
  });
});

describe('computers (desktop agent)', () => {
  it('enrol with their platform, report posture, and only accept computer commands', async () => {
    const { backend, signIn } = await setup();
    const admin = await signIn('SUPER_ADMIN');
    const e = await backend.createEnrollment(admin);
    const pc = new SimulatedAgent(
      newAgentFromProvisioning(e.provisioning, { platform: 'windows', hardware: { serial: 'PF1', model: 'Latitude 7450', os: 'Windows 11 Pro' }, posture: { noBattery: true, security: { firewall: false, antivirus: true } } }),
      backend,
    );
    await pc.enroll();
    pc.acknowledge();
    await pc.checkin();
    const d = backend.getDevice(admin, pc.state.deviceId!);
    expect(d.platform).toBe('windows');
    expect(d.telemetry?.noBattery).toBe(true);
    expect(d.risk.threats.map((t) => t.key)).toEqual(['firewall_off']);
    for (const type of ['LOCATE', 'WIPE', 'RING', 'INSTALL_APP', 'LOST_MODE_ON'] as const) {
      await expect(backend.issueCommand(admin, d.id, { type, ticket: 'INC-1', reason: 'should be refused', params: { packageName: 'x' } })).rejects.toMatchObject({ code: 'not_supported' });
    }
    await backend.issueCommand(admin, d.id, { type: 'MESSAGE', params: { text: 'Please restart' } });
    await backend.issueCommand(admin, d.id, { type: 'LOCK' });
    expect(unsupportedReason({ platform: 'linux', managementMode: 'standard', capabilities: null }, 'REBOOT')).toMatch(/service/);
    expect(unsupportedReason({ platform: 'ios', managementMode: 'device_owner', capabilities: null }, 'LOCK')).toMatch(/Apple/);
    // Unknown platforms from a client are stored as android, never as arbitrary strings.
    const e2 = await backend.createEnrollment(admin);
    const r = await backend.enroll({ token: e2.token, devicePublicKey: 'ab'.repeat(32), platform: 'beos' as never, hardware: { serial: 's', model: 'm', os: 'o' } });
    expect(backend.getDevice(admin, r.deviceId).platform).toBe('android');
  });

  it('keeps only known posture fields from the device', async () => {
    const { backend, enrolledAgent } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    agent.state.posture = { security: { firewall: true, pendingUpdates: 3.7, agentVersion: '1.0.0<script>', evil: 'x' } as never };
    await agent.checkin();
    const s = backend.getDevice(admin, deviceId).telemetry!.security!;
    expect(s.pendingUpdates).toBe(4);
    expect(s.agentVersion).toBe('1.0.0script');
    expect('evil' in s).toBe(false);
  });
});
