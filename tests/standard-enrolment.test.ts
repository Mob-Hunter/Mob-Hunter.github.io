import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { unsupportedReason } from '../src/core/backend';
import { randomBytes, toHex } from '../src/core/crypto';

describe('standard enrolment (existing phone, no factory reset)', () => {
  it('enrolment offers a mobhunter:// link carrying the server, the one-time token and the server-key pin', async () => {
    const { backend, signIn } = await setup();
    const e = await backend.createEnrollment(await signIn('DEVICE_ADMIN'));
    const u = new URL(e.standardLink);
    expect(u.protocol).toBe('mobhunter:');
    expect(u.host).toBe('enrol');
    expect(u.searchParams.get('token')).toBe(e.token);
    const extras = e.provisioning['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
    expect(u.searchParams.get('pin')).toBe(extras.serverPin);
    expect(u.searchParams.get('server')).toBe(extras.serverUrl);
    // the public install page hands the same link to the phone, until the token is used
    const page = await backend.installPage(e.token);
    expect(page.status === 'valid' && page.standardLink).toBe(e.standardLink);
  });

  it('records the mode and capabilities; refuses commands the phone cannot run', async () => {
    const { backend, signIn } = await setup();
    const admin = await signIn('DEVICE_ADMIN');
    const e = await backend.createEnrollment(admin);
    const r = await backend.enroll({ token: e.token, devicePublicKey: toHex(randomBytes(32)), hardware: { serial: 'unknown', model: 'Pixel 9', os: 'Android 16' }, mode: 'standard' });
    let d = backend.getDevice(admin, r.deviceId);
    expect(d.managementMode).toBe('standard');
    for (const type of ['WIPE', 'REBOOT', 'INSTALL_APP'] as const) {
      await expect(backend.issueCommand(admin, r.deviceId, { type, ticket: 'INC-1', reason: 'testing standard mode', params: { packageName: 'x', url: 'https://x', sha256: 'a'.repeat(64) } })).rejects.toMatchObject({
        status: 422,
        code: 'not_supported',
      });
    }
    // remote lock needs the user to allow it on the phone (device admin)
    await expect(backend.issueCommand(admin, r.deviceId, { type: 'LOCK' })).rejects.toMatchObject({ code: 'not_supported' });
    expect(unsupportedReason({ managementMode: 'standard', capabilities: { deviceOwner: false, deviceAdmin: true, notifications: true, location: 'background' } }, 'LOCK')).toBeNull();
    // policy sync stays available (it only reports what it could not enforce)
    await backend.issueCommand(admin, r.deviceId, { type: 'SYNC_POLICY' });
    d = backend.getDevice(admin, r.deviceId);
    expect(d.queuedCommands).toBe(1);
    // the audit trail records how the phone was enrolled
    const sec = await signIn('SECURITY');
    expect(backend.listAudit(sec).find((x) => x.action === 'device.enrolled')?.detail).toMatchObject({ mode: 'standard' });
  });

  it('company phones (device owner) are unaffected', () => {
    for (const type of ['WIPE', 'REBOOT', 'INSTALL_APP', 'LOCK'] as const) expect(unsupportedReason({ managementMode: 'device_owner', capabilities: null }, type)).toBeNull();
    expect(unsupportedReason({}, 'WIPE')).toBeNull(); // devices enrolled before this field existed
  });
});
