import { describe, expect, it } from 'vitest';
import { ApiError, Backend, deviceRequestMessage } from '../src/core/backend';
import { newAgentFromProvisioning, PinMismatchError, SimulatedAgent } from '../src/core/agent';
import { canonicalJson, generateEd25519, sha256Hex, signEd25519 } from '../src/core/crypto';
import { verifyChain } from '../src/core/audit';
import { totp } from '../src/core/totp';
import { PASSWORD, setup } from './helpers';

async function expectApiError(p: Promise<unknown> | (() => unknown), status: number, code?: string) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    if (code) expect((e as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}`);
}

describe('admin authentication', () => {
  it('requires password AND TOTP', async () => {
    const { backend, accounts, clock } = await setup();
    await expectApiError(backend.login(accounts.SUPER_ADMIN.email, 'wrong password!!'), 401, 'invalid_credentials');
    await expectApiError(backend.login('nobody@corp.test', PASSWORD), 401, 'invalid_credentials');
    const { challengeId } = await backend.login(accounts.SUPER_ADMIN.email, PASSWORD);
    await expectApiError(backend.verifyMfa(challengeId, '000000'), 401, 'mfa_invalid');
    const ok = await backend.verifyMfa(challengeId, await totp(accounts.SUPER_ADMIN.totpSecret, clock.now()));
    expect(ok.user.role).toBe('SUPER_ADMIN');
    expect(backend.me(ok.sessionId).email).toBe(accounts.SUPER_ADMIN.email);
  });

  it('locks the account after 5 bad passwords', async () => {
    const { backend, accounts } = await setup();
    for (let i = 0; i < 5; i++) await expectApiError(backend.login(accounts.HELPDESK.email, 'nope nope nope'), 401);
    await expectApiError(backend.login(accounts.HELPDESK.email, PASSWORD), 423, 'locked');
  });

  it('expires idle sessions and supports logout', async () => {
    const { backend, signIn, clock } = await setup();
    const s = await signIn('AUDITOR');
    clock.advance(31 * 60_000);
    await expectApiError(() => backend.me(s), 401);
    const s2 = await signIn('AUDITOR');
    await backend.logout(s2);
    await expectApiError(() => backend.me(s2), 401);
  });

  it('separation of duties on role management', async () => {
    const { backend, signIn } = await setup();
    const sa = await signIn('SUPER_ADMIN');
    const me = backend.me(sa);
    await expectApiError(backend.setUserRole(sa, me.id, 'LOCATION_OPERATOR'), 409, 'self_change');
    const da = await signIn('DEVICE_ADMIN');
    await expectApiError(backend.setUserRole(da, me.id, 'AUDITOR'), 403);
    const target = backend.listUsers(sa).find((u) => u.role === 'HELPDESK')!;
    const hd = await signIn('HELPDESK');
    await backend.setUserRole(sa, target.id, 'AUDITOR');
    // role change revokes existing sessions
    await expectApiError(() => backend.me(hd), 401);
  });
});

describe('Phase 1 acceptance: relay end to end', () => {
  it('admin issues LOCATE → relay → simulated device → fake result → audit chain verifies; Helpdesk denied', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    expect(backend.listDevices(op).map((d) => d.id)).toContain(deviceId);

    const cmd = await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-1042', reason: 'Device reported lost by employee' });
    expect(cmd.status).toBe('queued');
    expect(backend.getDevice(op, deviceId).queuedCommands).toBe(1);

    const outcomes = await agent.poll();
    expect(outcomes).toEqual([{ id: cmd.id, type: 'LOCATE', outcome: 'succeeded' }]);
    expect(backend.listCommands(op, deviceId).find((c) => c.id === cmd.id)!.status).toBe('succeeded');
    // the device showed the notification
    expect(agent.state.notifications[0]).toMatchObject({ channel: 'location_request', importance: 'high' });
    expect(agent.state.notifications[0].text).toContain('INC-1042');

    const locs = await backend.listLocationResults(op, { deviceId, ticket: 'INC-1042' });
    expect(locs).toHaveLength(1);
    expect(locs[0].ticket).toBe('INC-1042');
    expect(locs[0].fix.notification).toBeTruthy();

    const auditor = await signIn('AUDITOR');
    const actions = backend.listAudit(auditor).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['command.issued', 'command.succeeded', 'location.viewed', 'device.enrolled']));
    expect((await backend.verifyAudit(auditor)).ok).toBe(true);

    const hd = await signIn('HELPDESK');
    await expectApiError(backend.issueCommand(hd, deviceId, { type: 'LOCATE', ticket: 'INC-1', reason: 'curious only' }), 403, 'forbidden');
    expect(backend.listAudit(auditor).some((r) => r.action === 'access.denied')).toBe(true);
  });

  it('only Location Operator and Super Admin may LOCATE and read location results', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    const sa = await signIn('SUPER_ADMIN');
    await expectApiError(backend.issueCommand(sa, deviceId, { type: 'LOCATE', ticket: '', reason: 'reason here' }), 422);
    await backend.issueCommand(sa, deviceId, { type: 'LOCATE', ticket: 'INC-1', reason: 'reason here' });
    backend.listLocationResults(sa, { ticket: 'INC-1' });
    for (const role of ['DEVICE_ADMIN', 'HELPDESK', 'SECURITY', 'AUDITOR']) {
      const s = await signIn(role);
      await expectApiError(backend.issueCommand(s, deviceId, { type: 'LOCATE', ticket: 'INC-1', reason: 'reason here' }), 403);
      await expectApiError(backend.listLocationResults(s, { ticket: 'INC-1' }), 403);
    }
  });

  it('LOCATE needs a ticket and a reason; location viewing needs a ticket', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await expectApiError(backend.issueCommand(op, deviceId, { type: 'LOCATE' }), 422, 'ticket_required');
    await expectApiError(backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-5' }), 422, 'reason_required');
    await expectApiError(backend.listLocationResults(op, { ticket: '' }), 422, 'ticket_required');
  });

  it('no location before the employee acknowledges the notice', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId } = await enrolledAgent({ ack: false });
    const op = await signIn('LOCATION_OPERATOR');
    expect(backend.getDevice(op, deviceId).state).toBe('enrolled');
    await expectApiError(backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-9', reason: 'device lost' }), 409, 'not_acknowledged');
    agent.acknowledge();
    await agent.checkin();
    expect(backend.getDevice(op, deviceId).state).toBe('active');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-9', reason: 'device lost' });
  });

  it('commands expire after 10 minutes in the relay', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const da = await signIn('DEVICE_ADMIN');
    const cmd = await backend.issueCommand(da, deviceId, { type: 'LOCK' });
    clock.advance(11 * 60_000);
    expect(await agent.poll()).toEqual([]);
    const da2 = await signIn('DEVICE_ADMIN');
    expect(backend.listCommands(da2, deviceId).find((c) => c.id === cmd.id)!.status).toBe('expired');
  });

  it('push wake is sent on enqueue', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    const hd = await signIn('HELPDESK');
    await backend.issueCommand(hd, deviceId, { type: 'LOCK' });
    expect(backend.pushLog(hd)[0]).toMatchObject({ deviceId, reason: 'LOCK' });
  });
});

describe('Phase 2 acceptance: enrolment and rename', () => {
  it('mint → install page → enrol → appears as Unnamed device → rename + assign → audited', async () => {
    const { backend, signIn, clock, emp } = await setup();
    const da = await signIn('DEVICE_ADMIN');
    const e = await backend.createEnrollment(da, { wifiSsid: 'CorpSetup' });
    expect(e.expiresAt - clock.now()).toBe(15 * 60_000);
    const extras = e.provisioning['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
    expect(extras.token).toBe(e.token);
    expect(e.provisioning['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME']).toContain('/.');
    expect(e.provisioning['android.app.extra.PROVISIONING_WIFI_SSID']).toBe('CorpSetup');
    expect(JSON.stringify(e.provisioning)).not.toMatch(/PASSWORD/);

    const page = await backend.installPage(e.token);
    expect(page.status).toBe('valid');

    const agent = new SimulatedAgent(newAgentFromProvisioning(e.provisioning), backend, clock.now);
    await agent.enroll();
    await agent.checkin();
    expect((await backend.installPage(e.token)).status).toBe('used');

    const list = backend.listDevices(da, { unnamedOnly: true });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ displayName: 'Unnamed device', label: null, state: 'enrolled', model: agent.state.hardware.model });

    await backend.updateDevice(da, list[0].id, { label: "Nimal's phone", assignedUserId: emp.id });
    const d = backend.getDevice(da, list[0].id);
    expect(d.displayName).toBe("Nimal's phone");
    expect(d.assignedUser?.name).toBe('Nimal Perera');
    const sa = await signIn('SUPER_ADMIN');
    const row = backend.listAudit(sa).find((r) => r.action === 'device.updated')!;
    expect(row.detail).toMatchObject({ before: { label: null }, after: { label: "Nimal's phone" } });
  });

  it('enrolment tokens are single-use and expire after 15 minutes', async () => {
    const { backend, signIn, clock } = await setup();
    const da = await signIn('DEVICE_ADMIN');
    const e1 = await backend.createEnrollment(da);
    const k = await generateEd25519();
    const hw = { serial: 'S1', model: 'M', os: 'A16' };
    await backend.enroll({ token: e1.token, devicePublicKey: k.publicKey, hardware: hw });
    await expectApiError(backend.enroll({ token: e1.token, devicePublicKey: k.publicKey, hardware: hw }), 410, 'token_used');
    const e2 = await backend.createEnrollment(da);
    clock.advance(16 * 60_000);
    expect((await backend.installPage(e2.token)).status).toBe('expired');
    await expectApiError(backend.enroll({ token: e2.token, devicePublicKey: k.publicKey, hardware: hw }), 410, 'token_expired');
    await expectApiError(backend.enroll({ token: 'x'.repeat(32), devicePublicKey: k.publicKey, hardware: hw }), 401, 'invalid_token');
    expect((await backend.installPage('short')).status).toBe('invalid');
  });

  it('only Device Admin / Super Admin can mint tokens or rename', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    for (const role of ['HELPDESK', 'LOCATION_OPERATOR', 'SECURITY', 'AUDITOR']) {
      const s = await signIn(role);
      await expectApiError(backend.createEnrollment(s), 403);
      await expectApiError(backend.updateDevice(s, deviceId, { label: 'x' }), 403);
    }
  });

  it('rejects invalid labels', async () => {
    const { backend, enrolledAgent } = await setup();
    const { deviceId, admin } = await enrolledAgent();
    await expectApiError(backend.updateDevice(admin, deviceId, { label: '<script>' }), 422);
    await expectApiError(backend.updateDevice(admin, deviceId, { label: '   ' }), 422);
    await expectApiError(backend.updateDevice(admin, deviceId, { assignedUserId: 'emp_nope' }), 422);
  });

  it('agent refuses to enrol if the server key does not match the pin', async () => {
    const { backend, signIn, clock } = await setup();
    const da = await signIn('DEVICE_ADMIN');
    const e = await backend.createEnrollment(da);
    const prov = structuredClone(e.provisioning);
    prov['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].serverPin = 'f'.repeat(64);
    const agent = new SimulatedAgent(newAgentFromProvisioning(prov), backend, clock.now);
    await expect(agent.enroll()).rejects.toBeInstanceOf(PinMismatchError);
  });
});

describe('device authentication (mutual-TLS equivalent)', () => {
  it('rejects forged certificates, replayed requests and stale timestamps', async () => {
    const { backend, enrolledAgent, clock } = await setup();
    const { agent } = await enrolledAgent();
    const s = agent.state;
    const mk = async (overrides: Partial<{ ts: number; nonce: string; secretKey: string; cert: typeof s.cert }> = {}) => {
      const ts = overrides.ts ?? clock.now();
      const nonce = overrides.nonce ?? Math.random().toString(36).slice(2);
      const bodyHash = await sha256Hex(canonicalJson(null));
      const sig = await signEd25519(deviceRequestMessage('GET', '/v1/commands/pending', ts, nonce, bodyHash), overrides.secretKey ?? s.keys!.secretKey);
      return { deviceId: s.deviceId!, cert: overrides.cert ?? s.cert!, certSig: s.certSig!, ts, nonce, bodyHash, sig };
    };
    expect(await backend.pendingCommands(await mk())).toEqual([]);
    const auth = await mk({ nonce: 'fixed-nonce' });
    await backend.pendingCommands(auth);
    await expectApiError(backend.pendingCommands(auth), 401, 'device_unauthenticated'); // replay
    await expectApiError(backend.pendingCommands(await mk({ ts: clock.now() - 10 * 60_000 })), 401);
    const attacker = await generateEd25519();
    await expectApiError(backend.pendingCommands(await mk({ secretKey: attacker.secretKey })), 401);
    await expectApiError(backend.pendingCommands(await mk({ cert: { ...s.cert!, publicKey: attacker.publicKey } })), 401);
  });

  it('a wiped device loses access (certificate revoked)', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const da = await signIn('DEVICE_ADMIN');
    const wipe = await backend.issueCommand(da, deviceId, { type: 'WIPE', ticket: 'INC-77', reason: 'Device stolen, confirmed by police report' });
    expect(wipe.status).toBe('pending_approval');
    await expectApiError(backend.approveCommand(da, wipe.id, true), 409, 'same_approver');
    const da2 = await signIn('DEVICE_ADMIN_2');
    await backend.approveCommand(da2, wipe.id, true);
    await agent.poll();
    expect(backend.getDevice(da, deviceId).state).toBe('wiped');
    agent.state.wiped = false; // attacker restores the old agent
    await expect(agent.checkin()).rejects.toMatchObject({ status: 401 });
  });
});

describe('privacy & transparency guardrails', () => {
  it('location is encrypted at rest — no plaintext coordinates in storage', async () => {
    const { backend, signIn, enrolledAgent, store } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-3', reason: 'lost device' });
    await agent.poll();
    const [loc] = await backend.listLocationResults(op, { ticket: 'INC-3' });
    const raw = JSON.stringify(store.load()!.locations);
    expect(raw).not.toContain(String(loc.fix.lat));
    expect(raw).not.toContain(String(loc.fix.lng));
  });

  it('a location without on-device notification proof is discarded and flagged', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    const cmd = await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-4', reason: 'lost device' });
    // A malicious/modified agent tries to report silently.
    const s = agent.state;
    const pull = async (method: string, path: string, body: unknown) => {
      const ts = clock.now();
      const nonce = Math.random().toString(36);
      const bodyHash = await sha256Hex(canonicalJson(body ?? null));
      const sig = await signEd25519(deviceRequestMessage(method, path, ts, nonce, bodyHash), s.keys!.secretKey);
      return { deviceId: s.deviceId!, cert: s.cert!, certSig: s.certSig!, ts, nonce, bodyHash, sig };
    };
    await backend.pendingCommands(await pull('GET', '/v1/commands/pending', null));
    const body = { status: 'succeeded' as const, location: { lat: 6.9, lng: 79.8, accuracyM: 5, fixAt: clock.now(), source: 'fused' as const, tier: 1 as const, notification: null } };
    await backend.commandResult(await pull('POST', `/v1/commands/${cmd.id}/result`, body), cmd.id, body);
    expect(backend.listCommands(op, deviceId)[0]).toMatchObject({ status: 'failed' });
    expect(await backend.listLocationResults(op, { ticket: 'INC-4' })).toHaveLength(0);
    const sec = await signIn('SECURITY');
    expect(backend.listAudit(sec).some((r) => r.action === 'security.silent_location_blocked')).toBe(true);
  });

  it('purges location results after 30 days', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-5', reason: 'lost device' });
    await agent.poll();
    expect(backend.locationCount()).toBe(1);
    clock.advance(29 * 24 * 3600_000);
    expect(await backend.runRetention()).toBe(0);
    clock.advance(2 * 24 * 3600_000);
    expect(await backend.runRetention()).toBe(1);
    expect(backend.locationCount()).toBe(0);
  });

  it('Lost Mode: Tier 2 fixes accepted only while in Lost Mode', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOST_MODE_ON', ticket: 'INC-6', reason: 'lost on bus', params: { message: 'Call IT', phone: '+94 11 000 0000' } });
    await agent.poll();
    expect(backend.getDevice(op, deviceId)).toMatchObject({ lostMode: true, state: 'lost' });
    expect(agent.state.notifications.some((n) => n.channel === 'lost_mode' && n.persistent)).toBe(true);
    clock.advance(5 * 60_000);
    await agent.tick();
    expect(backend.locationCount()).toBe(2);
    await backend.issueCommand(op, deviceId, { type: 'LOST_MODE_OFF' });
    await agent.poll();
    expect(backend.getDevice(op, deviceId)).toMatchObject({ lostMode: false, state: 'active' });
    expect(agent.state.notifications.some((n) => n.channel === 'lost_mode' && n.persistent)).toBe(false);
  });

  it('Tier 3 continuous location is off by default, needs justification, ≥15 min, and always shows a persistent notification', async () => {
    const { backend, signIn, enrolledAgent, clock } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const da = await signIn('DEVICE_ADMIN');
    expect(backend.getDevice(da, deviceId).policy.continuousLocation).toBe(false);
    await agent.tick();
    expect(backend.locationCount()).toBe(0);
    await expectApiError(backend.updatePolicy(da, deviceId, { continuousLocation: true }, ''), 422, 'justification_required');
    await expectApiError(backend.updatePolicy(da, deviceId, { continuousIntervalMin: 5 }, 'field team safety'), 422);
    await backend.updatePolicy(da, deviceId, { continuousLocation: true }, 'Lone-worker safety programme, DPIA-12');
    await agent.poll(); // SYNC_POLICY
    expect(agent.state.policy!.continuousLocation).toBe(true);
    await agent.tick();
    const fg = agent.state.notifications.find((n) => n.channel === 'continuous_location');
    expect(fg).toMatchObject({ persistent: true, importance: 'low' });
    expect(backend.locationCount()).toBe(1);
    // outside working hours (Saturday) nothing is collected and the notification is gone
    clock.advance(5 * 24 * 3600_000);
    await agent.tick();
    expect(backend.locationCount()).toBe(1);
    expect(agent.state.notifications.some((n) => n.channel === 'continuous_location')).toBe(false);
    const da3 = await signIn('DEVICE_ADMIN'); // the earlier session has (correctly) expired
    expect(backend.getDevice(da3, deviceId).policy).toMatchObject({ securityLogging: false, networkLogging: false });
  });

  it('employee transparency page lists location requests for their own device only with the right key', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { agent, deviceId } = await enrolledAgent();
    const op = await signIn('LOCATION_OPERATOR');
    await backend.issueCommand(op, deviceId, { type: 'LOCATE', ticket: 'INC-8', reason: 'lost device' });
    await agent.poll();
    const link = agent.state.notifications.find((n) => n.channel === 'location_request')!.link!;
    const [, , id, key] = link.split('/');
    const page = await backend.transparency(id, key);
    expect(page.events[0]).toMatchObject({ type: 'LOCATE', ticket: 'INC-8', status: 'succeeded' });
    expect(page.locations).toHaveLength(1);
    await expectApiError(backend.transparency(id, 'wrong-key-wrong-key'), 404);
  });

  it('device views never leak the transparency key or private keys', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    const { deviceId } = await enrolledAgent();
    const sa = await signIn('SUPER_ADMIN');
    const json = JSON.stringify([backend.listDevices(sa), backend.getDevice(sa, deviceId)]);
    expect(json).not.toContain('transparencyKey');
    expect(json).not.toContain('secretKey');
  });
});

describe('audit', () => {
  it('detects tampering with persisted history', async () => {
    const { backend, signIn, enrolledAgent } = await setup();
    await enrolledAgent();
    const sec = await signIn('SECURITY');
    expect((await backend.verifyAudit(sec)).ok).toBe(true);
    backend.rawAuditForTests()[3].actor = 'someone-else';
    const v = await backend.verifyAudit(sec);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(4);
  });

  it('export is restricted to Security, Auditor and Super Admin and is itself audited', async () => {
    const { backend, signIn } = await setup();
    await expectApiError(backend.exportAudit(await signIn('DEVICE_ADMIN')), 403);
    const a = await signIn('AUDITOR');
    const exp = JSON.parse(await backend.exportAudit(a));
    expect(exp.verification.ok).toBe(true);
    expect(backend.listAudit(a)[0].action).toBe('audit.exported');
  });

  it('state persists and re-opens with a valid chain', async () => {
    const { store, enrolledAgent, clock } = await setup();
    await enrolledAgent();
    const reopened = await Backend.open({ store, clock: clock.now, pbkdf2Iterations: 1000 });
    expect((await verifyChain(store.load()!.audit)).ok).toBe(true);
    expect(reopened.locationCount()).toBe(0);
  });
});
