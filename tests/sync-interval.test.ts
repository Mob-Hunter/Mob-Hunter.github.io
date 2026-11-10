import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { SimulatedAgent, newAgentFromProvisioning } from '../src/core/agent';
import { effectiveSyncMin, isOnline, complianceIssues } from '../src/core/backend';
import type { Device } from '../src/core/types';

describe('automatic check-in frequency', () => {
  it('organisation default reaches every agent at its next check-in; only Super Admin can change it', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    expect(agent.state.syncIntervalMin).toBe(15);
    expect(backend.getDevice(admin, deviceId).sync).toMatchObject({ minutes: 15, source: 'organisation' });
    await expect(backend.updateSettings(admin, { syncIntervalMin: 60 })).rejects.toMatchObject({ status: 403 });
    const sa = await signIn('SUPER_ADMIN');
    await expect(backend.updateSettings(sa, { syncIntervalMin: 7 })).rejects.toMatchObject({ code: 'invalid_interval' });
    await backend.updateSettings(sa, { syncIntervalMin: 60 });
    await agent.checkin();
    expect(agent.state.syncIntervalMin).toBe(60);
    expect(backend.getDevice(admin, deviceId).sync).toMatchObject({ minutes: 60, source: 'organisation' });
    expect(backend.listAudit(sa).some((r) => r.action === 'settings.updated')).toBe(true);
  });

  it('a per-device override wins, needs no justification on its own, bumps the policy and queues a sync', async () => {
    const { backend, enrolledAgent, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    const v = backend.getDevice(admin, deviceId).policy.version;
    let d = await backend.updatePolicy(admin, deviceId, { syncIntervalMin: 240 }, '');
    expect(d.sync).toMatchObject({ minutes: 240, source: 'device' });
    expect(d.policy.version).toBe(v + 1);
    expect(d.queuedCommands).toBe(1);
    await agent.poll(); // SYNC_POLICY
    await agent.checkin();
    expect(agent.state.syncIntervalMin).toBe(240);
    // Mixed with another policy change, the usual justification rule still applies.
    await expect(backend.updatePolicy(admin, deviceId, { syncIntervalMin: 30, cameraDisabled: true }, '')).rejects.toMatchObject({ code: 'justification_required' });
    // Back to the organisation default.
    d = await backend.updatePolicy(admin, deviceId, { syncIntervalMin: null }, '');
    expect(d.sync.source).toBe('organisation');
    await expect(backend.updatePolicy(await signIn('HELPDESK'), deviceId, { syncIntervalMin: 30 }, '')).rejects.toMatchObject({ status: 403 });
  });

  it('phones never go below Android’s 15-minute limit; computers can check in every 5 minutes', async () => {
    const { backend, signIn } = await setup();
    const sa = await signIn('SUPER_ADMIN');
    await backend.updateSettings(sa, { syncIntervalMin: 5 });
    const e = await backend.createEnrollment(sa);
    const pc = new SimulatedAgent(newAgentFromProvisioning(e.provisioning, { platform: 'linux' }), backend);
    await pc.enroll();
    await pc.checkin();
    expect(pc.state.syncIntervalMin).toBe(5);
    const phone = { platform: 'android', policy: {} } as Device;
    expect(effectiveSyncMin(phone, { syncIntervalMin: 5 })).toEqual({ minutes: 15, source: 'organisation', requested: 5 });
  });

  it('online and stale follow each device’s own interval', () => {
    const now = Date.UTC(2026, 10, 10);
    const d = { platform: 'windows', policy: { syncIntervalMin: 720 }, lastCheckinAt: now - 8 * 3600_000, state: 'active', policyAckAt: 1, label: 'x', assignedUserId: 'e', lostMode: false } as unknown as Device;
    expect(isOnline(d, undefined, now)).toBe(true); // 8 h ago, 12 h interval
    expect(isOnline({ ...d, policy: {} } as Device, undefined, now)).toBe(false); // 15 min default
    const daily = { ...d, policy: { syncIntervalMin: 1440 }, lastCheckinAt: now - 30 * 3600_000 } as unknown as Device;
    expect(complianceIssues(daily, now).map((i) => i.code)).not.toContain('stale_checkin'); // 30 h < 3 × 24 h
    expect(complianceIssues({ ...daily, policy: {} } as unknown as Device, now).map((i) => i.code)).toContain('stale_checkin');
  });
});
