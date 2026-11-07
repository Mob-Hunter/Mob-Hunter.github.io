import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const report = { kind: 'stolen' as const, ticket: 'INC-900', reason: 'Phone taken from car, police ref 2026/1123', intervalSec: 60, durationHours: 4, message: 'Stolen phone — call', phone: '+94 11 000 0000' };

describe('lost / stolen incidents with active tracking', () => {
  it('only the Location Operator can report; ticket, reason, interval and duration are validated; notice must be acknowledged', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    for (const role of ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK', 'SECURITY', 'AUDITOR']) {
      await expect(backend.reportIncident(await signIn(role), deviceId, report)).rejects.toMatchObject({ status: 403 });
    }
    const op = await signIn('LOCATION_OPERATOR');
    await expect(backend.reportIncident(op, deviceId, { ...report, intervalSec: 10 })).rejects.toMatchObject({ code: 'invalid_interval' });
    await expect(backend.reportIncident(op, deviceId, { ...report, durationHours: 100 })).rejects.toMatchObject({ code: 'invalid_duration' });
    await expect(backend.reportIncident(op, deviceId, { ...report, ticket: '' })).rejects.toMatchObject({ code: 'ticket_required' });
    const fresh = await enrolledAgent({ ack: false });
    await expect(backend.reportIncident(op, fresh.deviceId, report)).rejects.toMatchObject({ code: 'not_acknowledged' });
  });

  it('tracks every minute until the limit, files fixes under the ticket, then falls back to 5 minutes', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const inc = await backend.reportIncident(op, deviceId, report);
    await expect(backend.reportIncident(op, deviceId, report)).rejects.toMatchObject({ code: 'incident_open' });
    await agent.poll();
    expect(agent.state.tracking).toMatchObject({ intervalSec: 60, kind: 'stolen' });
    expect(agent.state.notifications.find((n) => n.channel === 'lost_mode' && n.persistent)!.text).toMatch(/tracking it every 1 min until/);

    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      await agent.tick();
    }
    const op2 = await signIn('LOCATION_OPERATOR');
    const t = await backend.trackIncident(op2, inc.id);
    expect(t.trackingActive).toBe(true);
    expect(t.fixes).toHaveLength(6); // 1 with the command result + 5 periodic
    expect(t.fixes.every((f) => f.ticket === 'INC-900' && f.tier === 2)).toBe(true);
    expect(t.device).toMatchObject({ lostMode: true });

    clock.advance(4 * 3600_000); // past the 4-hour limit: the phone itself stops high-frequency tracking
    await agent.tick();
    const n = (await backend.trackIncident(await signIn('LOCATION_OPERATOR'), inc.id)).fixes.length;
    clock.advance(60_000);
    await agent.tick(); // only 1 min later: no new fix at the 5-minute cadence
    const op3 = await signIn('LOCATION_OPERATOR');
    const after = await backend.trackIncident(op3, inc.id);
    expect(after.fixes).toHaveLength(n);
    expect(after.trackingActive).toBe(false);
  });

  it('live views are audited once per operator per 15 minutes', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const inc = await backend.reportIncident(op, deviceId, report);
    await agent.poll();
    for (let i = 0; i < 10; i++) {
      await backend.trackIncident(op, inc.id);
      clock.advance(15_000);
    }
    const sec = await signIn('SECURITY');
    const views = () => backend.listAudit(sec).filter((r) => r.action === 'location.tracking_viewed').length;
    expect(views()).toBe(1);
    clock.advance(16 * 60_000);
    await backend.trackIncident(await signIn('LOCATION_OPERATOR'), inc.id);
    expect(views()).toBe(2);
    // non-operators can list incidents (status only) but not track
    expect(backend.listIncidents(sec)[0]).toMatchObject({ kind: 'stolen', ticket: 'INC-900', status: 'active' });
    expect(JSON.stringify(backend.listIncidents(sec))).not.toMatch(/"lat"|"lng"/);
    await expect(backend.trackIncident(sec, inc.id)).rejects.toMatchObject({ status: 403 });
  });

  it('extend and change interval re-sign the limits to the phone; extension is capped at 72 h from now', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const inc = await backend.reportIncident(op, deviceId, report);
    await agent.poll();
    await expect(backend.updateIncidentTracking(op, inc.id, { extendHours: 24, reason: 'x' })).rejects.toMatchObject({ code: 'reason_required' });
    const up = await backend.updateIncidentTracking(op, inc.id, { extendHours: 72, intervalSec: 120, reason: 'Police asked for updates overnight' });
    expect(up.trackingUntil).toBe(clock.now() + 72 * 3600_000);
    expect(up.trackingIntervalSec).toBe(120);
    await agent.poll();
    expect(agent.state.tracking).toMatchObject({ intervalSec: 120, until: up.trackingUntil });
  });

  it('resolve as found ends Lost Mode on the phone; not recovered keeps Lost Mode but stops tracking', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const a1 = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const i1 = await backend.reportIncident(op, a1.deviceId, { ...report, kind: 'lost' });
    await a1.agent.poll();
    const r1 = await backend.resolveIncident(op, i1.id, { resolution: 'found', note: 'Left at the office' });
    expect(r1).toMatchObject({ status: 'resolved', resolution: 'found' });
    await a1.agent.poll();
    expect(a1.agent.state.lostMode).toBe(false);
    expect(backend.getDevice(op, a1.deviceId)).toMatchObject({ lostMode: false, activeIncident: null });

    const a2 = await enrolledAgent();
    const i2 = await backend.reportIncident(op, a2.deviceId, report);
    await a2.agent.poll();
    await backend.resolveIncident(op, i2.id, { resolution: 'not_recovered' });
    await a2.agent.poll();
    expect(a2.agent.state.lostMode).toBe(true);
    expect(a2.agent.state.tracking!.until).toBeLessThanOrEqual(clock.now()); // high-frequency tracking stopped on the phone
    expect(backend.getDevice(op, a2.deviceId).lostMode).toBe(true);
    const sa = await signIn('SUPER_ADMIN');
    expect(backend.listAudit(sa).filter((r) => r.action === 'incident.resolved')).toHaveLength(2);
  });

  it('a manual LOST_MODE_OFF or a wipe closes the open incident automatically; the employee sees tracking on the transparency page', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const inc = await backend.reportIncident(op, deviceId, report);
    await agent.poll();
    const link = agent.state.transparencyUrl!;
    const [, , id, key] = link.split('/');
    expect((await backend.transparency(id, key)).tracking).toMatchObject({ kind: 'stolen', intervalSec: 60 });
    await backend.issueCommand(op, deviceId, { type: 'LOST_MODE_OFF' });
    await agent.poll();
    expect(backend.listIncidents(op).find((i) => i.id === inc.id)).toMatchObject({ status: 'resolved', resolution: 'found' });
    expect((await backend.transparency(id, key)).tracking).toBeNull();

    const b = await enrolledAgent();
    const inc2 = await backend.reportIncident(op, b.deviceId, report);
    await b.agent.poll();
    const da = await signIn('DEVICE_ADMIN');
    const wipe = await backend.issueCommand(da, b.deviceId, { type: 'WIPE', ticket: 'INC-900', reason: 'Not recoverable, wipe data' });
    await backend.approveCommand(await signIn('DEVICE_ADMIN_2'), wipe.id, true);
    await b.agent.poll();
    expect(backend.listIncidents(op).find((i) => i.id === inc2.id)).toMatchObject({ status: 'resolved', resolution: 'not_recovered' });
  });
});
