import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { BULK_COMMANDS, cleanTags, unsupportedReason } from '../src/core/backend';
import { can } from '../src/core/rbac';

const APP = { packageName: 'com.corp.time', name: 'Timesheets', url: 'https://cdn.corp.test/time.apk', sha256: 'a'.repeat(64) };

describe('MDM parity: messages, ring, uninstall, groups, restrictions, bulk', () => {
  it('MESSAGE shows a visible notification with the text; RING is audible and explained', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const help = await signIn('HELPDESK');
    await backend.issueCommand(help, deviceId, { type: 'MESSAGE', params: { text: '  Please update tonight.  ' } });
    await backend.issueCommand(help, deviceId, { type: 'RING' });
    await agent.poll();
    const titles = agent.state.notifications.map((n) => n.title);
    expect(titles).toContain('Message from your IT team');
    expect(agent.state.notifications.find((n) => n.title === 'Message from your IT team')?.text).toBe('Please update tonight.');
    expect(titles).toContain('Your IT team is ringing this phone');
    // both are recorded as succeeded commands in the audit trail
    const sec = await signIn('SECURITY');
    const issued = backend.listAudit(sec).filter((x) => x.action === 'command.issued').map((x) => (x.detail as { type?: string }).type);
    expect(issued).toEqual(expect.arrayContaining(['MESSAGE', 'RING']));
  });

  it('MESSAGE validates its text', async () => {
    const { backend, enrolledAgent } = await setup();
    const { deviceId, admin } = await enrolledAgent();
    await expect(backend.issueCommand(admin, deviceId, { type: 'MESSAGE', params: { text: '' } })).rejects.toMatchObject({ status: 422 });
    await expect(backend.issueCommand(admin, deviceId, { type: 'MESSAGE', params: { text: 'x'.repeat(301) } })).rejects.toMatchObject({ status: 422 });
  });

  it('UNINSTALL_APP only removes catalogue apps, and only on company phones', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await expect(backend.issueCommand(admin, deviceId, { type: 'UNINSTALL_APP', params: { packageName: APP.packageName } })).rejects.toMatchObject({ status: 422 });
    await backend.upsertApp(await signIn('SUPER_ADMIN'), APP);
    await backend.issueCommand(admin, deviceId, { type: 'INSTALL_APP', params: { packageName: APP.packageName } });
    await agent.poll();
    expect(agent.state.installedApps).toContain(APP.packageName);
    await backend.issueCommand(admin, deviceId, { type: 'UNINSTALL_APP', params: { packageName: APP.packageName } });
    await agent.poll();
    expect(agent.state.installedApps).not.toContain(APP.packageName);
    expect(unsupportedReason({ managementMode: 'standard', capabilities: null }, 'UNINSTALL_APP')).toMatch(/factory/i);
    // Helpdesk may message and ring, but not remove apps
    expect(can('HELPDESK', 'command.MESSAGE')).toBe(true);
    expect(can('HELPDESK', 'command.UNINSTALL_APP')).toBe(false);
    expect(can('AUDITOR', 'command.RING')).toBe(false);
  });

  it('groups, asset tag and notes are cleaned, searchable and audited', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { deviceId, admin } = await enrolledAgent();
    const d = await backend.updateDevice(admin, deviceId, { tags: [' Sales ', 'sales', 'Field-Ops'], assetTag: ' AST-0042 ', notes: 'Spare charger in drawer 3' });
    expect(d.tags).toEqual(['Sales', 'Field-Ops']);
    expect(d.assetTag).toBe('AST-0042');
    expect(d.notes).toBe('Spare charger in drawer 3');
    expect(backend.listDevices(admin, { q: 'field-ops' }).map((x) => x.id)).toEqual([deviceId]);
    expect(backend.listDevices(admin, { q: 'ast-0042' }).map((x) => x.id)).toEqual([deviceId]);
    await expect(backend.updateDevice(admin, deviceId, { tags: ['<script>'] })).rejects.toMatchObject({ code: 'invalid_tags' });
    const sec = await signIn('SECURITY');
    const row = backend.listAudit(sec).find((x) => x.action === 'device.updated');
    expect(row?.detail).toMatchObject({ after: { tags: ['Sales', 'Field-Ops'], assetTag: 'AST-0042' } });
  });

  it('cleanTags limits count and length', () => {
    expect(cleanTags([])).toEqual([]);
    expect(() => cleanTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(/10/);
    expect(() => cleanTags(['x'.repeat(31)])).toThrow();
    expect(() => cleanTags('sales' as unknown)).toThrow();
  });

  it('restrictions are stored in the policy, versioned, and pushed to the phone', async () => {
    const { backend, enrolledAgent } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    const before = backend.getDevice(admin, deviceId).policy;
    expect(before.cameraDisabled).toBe(false);
    const d = await backend.updatePolicy(admin, deviceId, { cameraDisabled: true, screenCaptureDisabled: true, bluetoothDisabled: true }, 'Secure area policy');
    expect(d.policy).toMatchObject({ cameraDisabled: true, screenCaptureDisabled: true, bluetoothDisabled: true, disallowAddUser: false });
    expect(d.policy.version).toBe(before.version + 1);
    await agent.poll();
    expect(agent.state.policy?.cameraDisabled).toBe(true);
    // logging stays hard-wired off whatever is sent
    const d2 = await backend.updatePolicy(admin, deviceId, { securityLogging: true } as never, 'try to enable logging');
    expect(d2.policy.securityLogging).toBe(false);
  });

  it('bulk commands go to every phone, report per-device failures and write one bulk audit row', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const a = await enrolledAgent();
    const b = await enrolledAgent();
    const res = await backend.issueBulkCommand(a.admin, { deviceIds: [a.deviceId, b.deviceId, a.deviceId, 'dev_missing'], type: 'MESSAGE', params: { text: 'All-hands at 3 pm' } });
    expect(res.results).toHaveLength(3);
    expect(res.results.filter((r) => r.ok).map((r) => r.deviceId).sort()).toEqual([a.deviceId, b.deviceId].sort());
    expect(res.results.find((r) => r.deviceId === 'dev_missing')).toMatchObject({ ok: false });
    await a.agent.poll();
    await b.agent.poll();
    for (const ag of [a.agent, b.agent]) expect(ag.state.notifications.some((n) => n.text === 'All-hands at 3 pm')).toBe(true);
    const sec = await signIn('SECURITY');
    expect(backend.listAudit(sec).filter((x) => x.action === 'command.bulk')).toHaveLength(1);
  });

  it('bulk refuses commands that need a ticket or a second person, and enforces RBAC', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { deviceId, admin } = await enrolledAgent();
    for (const type of ['WIPE', 'LOCATE', 'LOST_MODE_ON', 'RELEASE'] as const) {
      expect(BULK_COMMANDS.has(type)).toBe(false);
      await expect(backend.issueBulkCommand(admin, { deviceIds: [deviceId], type })).rejects.toMatchObject({ status: 422 });
    }
    await expect(backend.issueBulkCommand(admin, { deviceIds: [], type: 'RING' })).rejects.toMatchObject({ status: 422 });
    const auditor = await signIn('AUDITOR');
    await expect(backend.issueBulkCommand(auditor, { deviceIds: [deviceId], type: 'RING' })).rejects.toMatchObject({ status: 403 });
  });
});
