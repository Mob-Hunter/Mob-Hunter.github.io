import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/core/backend';
import { verifyChain } from '../src/core/audit';
import { setup } from './helpers';

describe('device deletion', () => {
  it('refuses active devices; deletes retired ones with their commands and location data; audits a snapshot', async () => {
    const { backend, signIn, enrolledAgent, store } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-7', reason: 'lost phone' });
    await agent.poll();
    expect(backend.locationCount()).toBe(1);

    await expect(backend.deleteDevice(admin, deviceId, { reason: 'cleanup old', confirm: 'DELETE' })).rejects.toMatchObject({ status: 409, code: 'device_active' });
    await backend.retireDevice(admin, deviceId, 'Returned by leaver');
    await expect(backend.deleteDevice(admin, deviceId, { reason: 'x', confirm: 'DELETE' })).rejects.toMatchObject({ code: 'reason_required' });
    await expect(backend.deleteDevice(admin, deviceId, { reason: 'Disposed via e-waste', confirm: 'delete' })).rejects.toMatchObject({ code: 'confirm_required' });

    const r = await backend.deleteDevice(admin, deviceId, { reason: 'Disposed via e-waste', confirm: 'DELETE' });
    expect(r).toMatchObject({ deleted: deviceId, locations: 1 });
    expect(r.commands).toBeGreaterThanOrEqual(1);
    expect(backend.listDevices(admin).find((d) => d.id === deviceId)).toBeUndefined();
    expect(backend.listCommands(admin, deviceId)).toEqual([]);
    expect(backend.locationCount()).toBe(0);
    const raw = JSON.stringify(store.load());
    expect(raw).not.toContain(`"relayQueues":{"${deviceId}"`);

    const sa = await signIn('SUPER_ADMIN');
    const row = backend.listAudit(sa).find((x) => x.action === 'device.deleted')!;
    expect(row.target).toBe(deviceId);
    expect(row.detail).toMatchObject({ reason: 'Disposed via e-waste', erased: { locations: 1 }, snapshot: { state: 'retired' } });
    expect(verifyChain(store.load()!.audit).ok).toBe(true);
    // the deleted device can no longer authenticate
    await expect(agent.checkin()).rejects.toMatchObject({ status: 401 });
  });

  it('wiped devices can be deleted; only Super Admin / Device Admin may delete', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    const wipe = await backend.issueCommand(admin, deviceId, { type: 'WIPE', ticket: 'INC-9', reason: 'Stolen phone' });
    await backend.approveCommand(await signIn('DEVICE_ADMIN_2'), wipe.id, true);
    await agent.poll();
    expect(backend.getDevice(admin, deviceId).state).toBe('wiped');
    for (const role of ['HELPDESK', 'LOCATION_OPERATOR', 'SECURITY', 'AUDITOR']) {
      await expect(backend.deleteDevice(await signIn(role), deviceId, { reason: 'cleanup', confirm: 'DELETE' })).rejects.toBeInstanceOf(ApiError);
    }
    await backend.deleteDevice(await signIn('SUPER_ADMIN'), deviceId, { reason: 'cleanup after wipe', confirm: 'DELETE' });
    await expect(Promise.resolve().then(() => backend.getDevice(admin, deviceId))).rejects.toMatchObject({ status: 404 });
  });
});

describe('location data for the Location Operator', () => {
  it('ticket index lists tickets, devices and counts without coordinates; Location Operator only', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await backend.updateDevice(admin, deviceId, { label: 'Field phone' });
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-11', reason: 'lost phone' });
    await agent.poll();
    clock.advance(60_000);
    await backend.issueCommand(op, deviceId, { type: 'LOST_MODE_ON', ticket: 'INC-12', reason: 'still missing' });
    await agent.poll();
    const idx = backend.listLocationTickets(op);
    expect(idx.map((t) => t.ticket)).toEqual(['INC-12', 'INC-11']);
    expect(idx[0]).toMatchObject({ devices: ['Field phone'], requests: 1, fixes: 1, open: true });
    expect(JSON.stringify(idx)).not.toMatch(/"lat"|"lng"/);
    for (const role of ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK', 'SECURITY', 'AUDITOR']) {
      await expect(Promise.resolve().then(async () => backend.listLocationTickets(await signIn(role)))).rejects.toMatchObject({ status: 403 });
    }
  });

  it('filters results by tier and period, and audits the filter used', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-21', reason: 'lost phone' });
    await agent.poll();
    clock.advance(2 * 24 * 3600_000);
    const op2 = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op2, deviceId, { type: 'LOST_MODE_ON', ticket: 'INC-21', reason: 'still missing' });
    await agent.poll();
    expect(await backend.listLocationResults(op2, { ticket: 'INC-21' })).toHaveLength(2);
    expect(await backend.listLocationResults(op2, { ticket: 'INC-21', tier: 2 })).toHaveLength(1);
    expect(await backend.listLocationResults(op2, { ticket: 'INC-21', sinceMs: 24 * 3600_000 })).toHaveLength(1);
    const sa = await signIn('SUPER_ADMIN');
    const views = backend.listAudit(sa).filter((r) => r.action === 'location.viewed');
    expect(views[0].detail).toMatchObject({ sinceMs: 86_400_000 });
  });
});

describe('purpose limitation', () => {
  it('onlyTicket returns just the fixes filed under that ticket; Lost Mode fixes inherit the Lost Mode ticket', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-31', reason: 'lost phone' });
    await agent.poll();
    await backend.issueCommand(op, deviceId, { type: 'LOST_MODE_ON', ticket: 'INC-32', reason: 'still missing' });
    await agent.poll();
    clock.advance(5 * 60_000);
    await agent.tick(); // periodic Lost Mode fix (tier 2, via /v1/location/batch)
    const op2 = await signIn('LOCATION_OPERATOR');
    expect(await backend.listLocationResults(op2, { ticket: 'INC-31' })).toHaveLength(3);
    expect((await backend.listLocationResults(op2, { ticket: 'INC-31', onlyTicket: true })).map((l) => l.ticket)).toEqual(['INC-31']);
    const lost = await backend.listLocationResults(op2, { ticket: 'INC-32', onlyTicket: true });
    expect(lost).toHaveLength(2);
    expect(lost.every((l) => l.tier === 2 && l.ticket === 'INC-32')).toBe(true);
  });
});
