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

    await backend.retireDevice(admin, deviceId, 'Returned by leaver');
    await expect(backend.deleteDevice(admin, deviceId, { reason: 'x', confirm: 'DELETE' })).rejects.toMatchObject({ code: 'reason_required' });
    await expect(backend.deleteDevice(admin, deviceId, { reason: 'Disposed via e-waste', confirm: 'delete' })).rejects.toMatchObject({ code: 'confirm_required' });

    const r = await backend.deleteDevice(admin, deviceId, { reason: 'Disposed via e-waste', confirm: 'DELETE' });
    expect(r).toMatchObject({ status: 'deleted', deleted: deviceId, locations: 1 });
    expect(r.status === 'deleted' && r.commands).toBeGreaterThanOrEqual(1);
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
  it('ticket index lists tickets, devices and counts without coordinates; Location Operator and Super Admin only', async () => {
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
    expect(backend.listLocationTickets(await signIn('SUPER_ADMIN'))).toHaveLength(2);
    for (const role of ['DEVICE_ADMIN', 'HELPDESK', 'SECURITY', 'AUDITOR']) {
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

describe('deleting an active device uninstalls the agent', () => {
  it('sends a signed RELEASE; the phone uninstalls; the record is then deleted and the certificate revoked', async () => {
    const { backend, signIn, enrolledAgent, store } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await expect(backend.issueCommand(admin, deviceId, { type: 'RELEASE' })).rejects.toMatchObject({ code: 'use_delete' });
    const r = await backend.deleteDevice(admin, deviceId, { reason: 'Employee left, phone kept as personal', confirm: 'DELETE' });
    expect(r.status).toBe('pending_removal');
    expect(backend.getDevice(admin, deviceId).pendingRemoval).toMatchObject({ reason: 'Employee left, phone kept as personal' });
    await expect(backend.deleteDevice(admin, deviceId, { reason: 'again please', confirm: 'DELETE' })).rejects.toMatchObject({ code: 'removal_pending' });

    const before = structuredClone(agent.state); // a copy of the agent as it was before uninstalling
    expect(await agent.poll()).toEqual([expect.objectContaining({ type: 'RELEASE', outcome: 'succeeded' })]);
    expect(agent.state.released).toBe(true);
    expect(agent.state.keys).toBeUndefined();
    expect(agent.state.notifications[0].title).toBe('This phone is no longer managed');
    expect(backend.listDevices(admin).find((d) => d.id === deviceId)).toBeUndefined();
    const sa = await signIn('SUPER_ADMIN');
    const actions = backend.listAudit(sa).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['device.removal_requested', 'command.succeeded', 'device.released', 'device.deleted']));
    const del = backend.listAudit(sa).find((x) => x.action === 'device.deleted')!;
    expect(del.actor).toBe(backend.me(admin).id);
    expect(del.detail).toMatchObject({ how: 'agent released management and uninstalled' });
    expect(JSON.stringify(store.load()!.devices)).not.toContain(deviceId);
    const { SimulatedAgent } = await import('../src/core/agent');
    await expect(new SimulatedAgent(before, backend).checkin()).rejects.toMatchObject({ status: 401 });
  });

  it('re-signs the RELEASE for a phone that was offline past the 10-minute command lifetime', async () => {
    const { backend, enrolledAgent, clock, signIn } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    const r = await backend.deleteDevice(admin, deviceId, { reason: 'Phone handed back to the employee', confirm: 'DELETE' });
    clock.advance(3 * 3600_000); // offline for hours
    expect(await agent.poll()).toEqual([expect.objectContaining({ type: 'RELEASE', outcome: 'succeeded' })]);
    expect(r.status === 'pending_removal' && r.commandId).toBeTruthy();
    const fresh = await signIn('DEVICE_ADMIN');
    await expect(Promise.resolve().then(() => backend.getDevice(fresh, deviceId))).rejects.toMatchObject({ status: 404 });
  });

  it('a pending removal can be cancelled; retiring also clears it', async () => {
    const { backend, enrolledAgent } = await setup();
    const { agent, deviceId, admin } = await enrolledAgent();
    await backend.deleteDevice(admin, deviceId, { reason: 'Wrong device selected', confirm: 'DELETE' });
    expect((await backend.cancelRemoval(admin, deviceId)).pendingRemoval).toBeNull();
    expect(await agent.poll()).toEqual([]);
    expect(agent.state.released).toBeFalsy();
    await backend.deleteDevice(admin, deviceId, { reason: 'Second attempt now', confirm: 'DELETE' });
    await backend.retireDevice(admin, deviceId, 'Phone lost, never came back online');
    expect(backend.getDevice(admin, deviceId).pendingRemoval).toBeNull();
    const r = await backend.deleteDevice(admin, deviceId, { reason: 'Clean up retired record', confirm: 'DELETE' });
    expect(r.status).toBe('deleted');
  });
});
