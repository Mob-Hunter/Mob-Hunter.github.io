import { describe, expect, it } from 'vitest';
import { complianceIssues, ApiError } from '../src/core/backend';
import { defaultPolicy } from '../src/core/enrollment';
import { derToRawEcdsa, generateEs256, signEs256, toHex, fromHex, verifyEs256, isP256Spki } from '../src/core/crypto';
import type { Device } from '../src/core/types';
import { setup } from './helpers';

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'dev_1', platform: 'android', label: 'Phone', assignedUserId: 'emp_1', state: 'active', serial: 'S', model: 'M', os: 'A16',
    enrolledAt: 0, lastCheckinAt: Date.UTC(2026, 10, 9), telemetry: { batteryLevel: 80, batteryHealth: 'good', batteryTempC: 30, storageFreeGb: 50, storageTotalGb: 128, integrity: 'MEETS_DEVICE_INTEGRITY', patchLevel: '2026-10-05' },
    cert: { serial: 'x', deviceId: 'dev_1', publicKey: '', issuer: '', notBefore: 0, notAfter: 0 }, policyAckAt: 1, policyAckVersion: 'v', pushToken: '', lostMode: false,
    policy: defaultPolicy(), transparencyKey: 'k', enrollmentTokenId: 'e', ...over,
  };
}

describe('compliance rules', () => {
  const now = Date.UTC(2026, 10, 9, 6);
  it('a healthy, assigned, acknowledged device is compliant', () => {
    expect(complianceIssues(device(), now)).toEqual([]);
  });
  it('flags stale check-in, old patch, integrity, battery, storage, ack, assignment, lost', () => {
    const d = device({
      lastCheckinAt: now - 3 * 86_400_000, label: null, policyAckAt: null, lostMode: true,
      telemetry: { batteryLevel: 9, batteryHealth: 'good', batteryTempC: 30, storageFreeGb: 5, storageTotalGb: 128, integrity: 'FAILED', patchLevel: '2026-01-01' },
    });
    const codes = complianceIssues(d, now).map((i) => i.code).sort();
    expect(new Set(codes)).toEqual(new Set(['lost', 'not_acknowledged', 'stale_checkin', 'unassigned', 'low_battery', 'integrity', 'old_patch', 'low_storage']));
    expect(complianceIssues(d, now).find((i) => i.code === 'old_patch')!.severity).toBe('bad');
  });
  it('never-checked-in and not-evaluated integrity', () => {
    const d = device({ lastCheckinAt: null, telemetry: { ...device().telemetry!, integrity: 'NOT_EVALUATED' } });
    const issues = complianceIssues(d, now);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['never_checked_in', 'integrity']));
    expect(issues.find((i) => i.code === 'integrity')!.severity).toBe('warn');
  });
});

describe('ES256 (Android Keystore keys)', () => {
  it('verifies raw and DER signatures and rejects tampering', async () => {
    const kp = await generateEs256();
    expect(await isP256Spki(kp.publicKey)).toBe(true);
    expect(await isP256Spki('00ff')).toBe(false);
    const sig = await signEs256('hello', kp.privateJwk); // raw r||s
    expect(await verifyEs256('hello', sig, kp.publicKey)).toBe(true);
    expect(await verifyEs256('hellO', sig, kp.publicKey)).toBe(false);
    // DER form (what Java produces)
    const raw = fromHex(sig);
    const int = (b: Uint8Array) => {
      let v = Array.from(b);
      while (v.length > 1 && v[0] === 0) v.shift();
      if (v[0] & 0x80) v = [0, ...v];
      return [0x02, v.length, ...v];
    };
    const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
    const der = Uint8Array.from([0x30, body.length, ...body]);
    expect(toHex(derToRawEcdsa(der))).toBe(sig);
    expect(await verifyEs256('hello', toHex(der), kp.publicKey)).toBe(true);
    expect(() => derToRawEcdsa(Uint8Array.from([0x31, 0]))).toThrow();
  });
});

describe('enterprise backend features (in-memory)', () => {
  it('employees: create, duplicate e-mail, update, offboard unassigns devices', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { deviceId, admin } = await enrolledAgent();
    const e = await backend.createEmployee(admin, { name: 'Amali', email: 'Amali@Corp.test', department: 'Sales' });
    expect(e.email).toBe('amali@corp.test');
    await expect(backend.createEmployee(admin, { name: 'Dup', email: 'amali@corp.test', department: '' })).rejects.toMatchObject({ status: 409 });
    await backend.updateDevice(admin, deviceId, { assignedUserId: e.id });
    const r = await backend.offboardEmployee(admin, e.id);
    expect(r.unassigned).toEqual([deviceId]);
    expect(backend.getDevice(admin, deviceId).assignedUserId).toBeNull();
    // a leaver is still visible for audit/DSAR
    expect(backend.listEmployees(admin).find((x) => x.id === e.id)!.status).toBe('leaver');
    const hd = await signIn('HELPDESK');
    await expect(backend.createEmployee(hd, { name: 'X', email: 'x@corp.test', department: '' })).rejects.toBeInstanceOf(ApiError);
  });

  it('users: cannot disable yourself or the last Super Admin; password change revokes other sessions', async () => {
    const { backend, signIn } = await setup();
    const sa = await signIn('SUPER_ADMIN');
    const me = backend.me(sa);
    await expect(backend.setUserDisabled(sa, me.id, true)).rejects.toMatchObject({ code: 'self_change' });
    const sa2 = await signIn('SUPER_ADMIN');
    await backend.changePassword(sa, 'correct horse battery staple', 'another long passphrase here');
    expect(() => backend.me(sa2)).toThrow();
    expect(backend.me(sa).id).toBe(me.id);
    await expect(backend.changePassword(sa, 'wrong', 'another long passphrase here')).rejects.toMatchObject({ status: 401 });
  });

  it('settings personalise the employee notice; non-https webhook refused', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const sa = await signIn('SUPER_ADMIN');
    await backend.updateSettings(sa, { orgName: 'Acme Lanka', dpoContact: 'dpo@acme.lk' });
    await expect(backend.updateSettings(sa, { siemWebhookUrl: 'http://x' })).rejects.toMatchObject({ code: 'invalid_url' });
    expect(backend.notice().title).toBe('Acme Lanka — company device notice');
    expect(backend.notice().rights).toContain('dpo@acme.lk');
    const { agent } = await enrolledAgent();
    expect(agent.state.notifications.length).toBeGreaterThan(0);
  });

  it('every audit append is forwarded to onAudit (SIEM hook)', async () => {
    const rows: string[] = [];
    const { Backend, MemoryStore } = await import('../src/core/backend');
    const b = await Backend.open({ store: new MemoryStore(), pbkdf2Iterations: 1000, onAudit: (r) => rows.push(r.action) });
    await b.createUser({ name: 'A', email: 'a@corp.test', role: 'SUPER_ADMIN', password: 'correct horse battery staple' });
    expect(rows).toEqual(expect.arrayContaining(['system.initialised', 'user.created']));
  });
});
