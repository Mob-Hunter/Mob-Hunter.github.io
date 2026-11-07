import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp, CSRF_HEADER } from '../worker/http';
import { SqlStore, type SqlLike } from '../worker/sqlstore';
import { makeAccessVerifier } from '../worker/access';
import { FcmPushProvider } from '../worker/fcm';
import { Backend, MemoryStore, deviceRequestMessage } from '../src/core/backend';
import { canonicalJson, generateEs256, sha256Hex, toHex, verifyEd25519, randomId } from '../src/core/crypto';
import { totp } from '../src/core/totp';
import { HttpDeviceTransport } from '../src/api/device';
import { SimulatedAgent, newAgentFromProvisioning } from '../src/core/agent';
import { verifyChain } from '../src/core/audit';

const BOOT = 'bootstrap-secret-0123456789';
const PW = 'correct horse battery staple';

/** Mimics what the Android agent does: P-256 key, DER signature (Java's SHA256withECDSA). */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

async function es256Signer(jwk: JsonWebKey) {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return async (m: string) => toHex(rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(m)))));
}

async function setup(opts: { store?: MemoryStore | SqlStore; access?: Parameters<typeof createApp>[0]['verifyAccessJwt'] } = {}) {
  const store = opts.store ?? new MemoryStore();
  const backend = await Backend.open({ store, pbkdf2Iterations: 1000, apiBaseUrl: 'https://fleet.test/api' });
  const app = createApp({ getBackend: async () => backend, bootstrapToken: BOOT, secureCookies: true, verifyAccessJwt: opts.access, pushClientConfig: { projectId: 'p' } });
  const jar = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who = 'default') => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const ck = jar.get(who);
    if (ck) h.cookie = ck;
    const res = await app.request(`/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) jar.set(who, set.split(';')[0]);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const admin = (method: string, path: string, body?: unknown, who = 'default') => call(method, path, body, { [CSRF_HEADER]: '1' }, who);
  const signIn = async (email: string, secret: string, who = 'default') => {
    const l = await call('POST', '/admin/login', { email, password: PW });
    expect(l.status).toBe(200);
    const m = await call('POST', '/admin/mfa', { challengeId: l.json.challengeId, code: await totp(secret, Date.now()) }, {}, who);
    expect(m.status).toBe(200);
    return m;
  };
  return { app, backend, call, admin, signIn, jar, store };
}

async function bootstrapped() {
  const ctx = await setup();
  const b = await ctx.call('POST', '/bootstrap', { token: BOOT, name: 'Root', email: 'root@corp.test', password: PW });
  expect(b.status).toBe(201);
  await ctx.signIn('root@corp.test', b.json.totpSecret, 'sa');
  const mk = async (role: string, email: string) => {
    const r = await ctx.admin('POST', '/admin/users', { name: role, email, role, password: PW }, 'sa');
    expect(r.status).toBe(201);
    return r.json.totpSecret as string;
  };
  return { ...ctx, mk, rootSecret: b.json.totpSecret as string };
}

describe('Worker HTTP API', () => {
  it('health reports bootstrap state; bootstrap needs the token and works once', async () => {
    const { call } = await setup();
    expect((await call('GET', '/health')).json).toMatchObject({ service: 'mob-hunter', mode: 'server', needsBootstrap: true });
    expect((await call('POST', '/bootstrap', { token: 'wrong', name: 'x', email: 'a@b.co', password: PW })).status).toBe(403);
    const ok = await call('POST', '/bootstrap', { token: BOOT, name: 'Root', email: 'root@corp.test', password: PW });
    expect(ok.status).toBe(201);
    expect(ok.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await call('POST', '/bootstrap', { token: BOOT, name: 'Root2', email: 'r2@corp.test', password: PW })).status).toBe(409);
    expect((await call('GET', '/health')).json.needsBootstrap).toBe(false);
  });

  it('sets a HttpOnly Secure SameSite=Strict cookie and requires the CSRF header', async () => {
    const ctx = await bootstrapped();
    const res = await ctx.signIn('root@corp.test', ctx.rootSecret, 'me');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect((await ctx.call('GET', '/admin/me', undefined, {}, 'me')).status).toBe(403); // no CSRF header
    expect((await ctx.admin('GET', '/admin/me', undefined, 'me')).json.email).toBe('root@corp.test');
    expect((await ctx.admin('GET', '/admin/me', undefined, 'nobody')).status).toBe(401);
  });

  it('maps errors to status codes without leaking internals', async () => {
    const { admin, call } = await bootstrapped();
    expect((await admin('GET', '/admin/devices/dev_nope', undefined, 'sa')).json).toEqual({ error: 'not_found', message: 'Device not found' });
    expect((await call('GET', '/nope')).status).toBe(404);
    const bad = await call('POST', '/admin/login', undefined, { 'content-type': 'application/json' });
    expect([400, 401]).toContain(bad.status);
    const h = (await call('GET', '/health')).headers;
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('x-content-type-options')).toBe('nosniff');
  });

  it('end to end over HTTP: ES256 device enrols, checks in, receives a signed LOCATE, returns a location', async () => {
    const ctx = await bootstrapped();
    const opSecret = await ctx.mk('LOCATION_OPERATOR', 'op@corp.test');
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    expect(e.status).toBe(201);
    const token = e.json.provisioning['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].token;
    expect(e.json.provisioning['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION']).toBe('https://fleet.test/api/apk/1.0.0');

    // --- device: Android Keystore-style P-256 key
    const kp = await generateEs256();
    const en = await ctx.call('POST', '/v1/enroll', { token, devicePublicKey: kp.publicKey, keyAlg: 'ES256', hardware: { serial: 'S1', model: 'Pixel 9', os: 'Android 16' } });
    expect(en.status).toBe(201);
    expect(en.json.cert.alg).toBe('ES256');
    expect(en.json.certJson).toBe(canonicalJson(en.json.cert));
    expect(en.json.push).toEqual({ projectId: 'p' });
    const sign = await es256Signer(kp.privateJwk);
    const dev = async (method: 'GET' | 'POST', path: string, body?: unknown, tamper?: (h: Record<string, string>) => void) => {
      const raw = body === undefined ? '' : JSON.stringify(body);
      const ts = Date.now();
      const nonce = randomId('', 12);
      const bodyHash = await sha256Hex(raw);
      const h: Record<string, string> = {
        'x-mh-device': en.json.deviceId,
        'x-mh-cert': btoa(en.json.certJson),
        'x-mh-cert-sig': en.json.certSig,
        'x-mh-ts': String(ts),
        'x-mh-nonce': nonce,
        'x-mh-body-sha256': bodyHash,
        'x-mh-sig': await sign(deviceRequestMessage(method, path, ts, nonce, bodyHash)),
      };
      tamper?.(h);
      const res = await ctx.app.request(`/api${path}`, { method, headers: { ...h, ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
      return { status: res.status, json: await res.json() as any };
    };
    // body formatting is irrelevant: the hash is over raw bytes
    const ci = await dev('POST', '/v1/checkin', { telemetry: { batteryLevel: 80, batteryHealth: 'good', batteryTempC: 30, storageFreeGb: 50, storageTotalGb: 128, integrity: 'NOT_EVALUATED', patchLevel: '2026-10-05' }, serial: 'S1', model: 'Pixel 9', os: 'Android 16', policyAck: { version: '2026-11-v1', at: Date.now() } });
    expect(ci.status).toBe(200);
    expect(ci.json.state).toBe('active');
    // tampered body hash / signature / missing cert are rejected
    expect((await dev('GET', '/v1/policy', undefined, (h) => (h['x-mh-sig'] = '00'.repeat(70)))).status).toBe(401);
    expect((await dev('GET', '/v1/policy', undefined, (h) => (h['x-mh-body-sha256'] = 'a'.repeat(64)))).status).toBe(401);
    expect((await dev('GET', '/v1/policy', undefined, (h) => delete h['x-mh-cert'])).status).toBe(401);

    // --- operator issues LOCATE
    await ctx.signIn('op@corp.test', opSecret, 'op');
    const cmd = await ctx.admin('POST', `/admin/devices/${en.json.deviceId}/commands`, { type: 'LOCATE', ticket: 'INC-1', reason: 'phone lost on bus' }, 'op');
    expect(cmd.status).toBe(201);
    expect(cmd.json.envelope).toBeUndefined();

    const pending = await dev('GET', '/v1/commands/pending');
    expect(pending.json).toHaveLength(1);
    const env = pending.json[0];
    // non-JS agents verify the exact signed string, then parse it
    expect(env.signed).toBe(canonicalJson(env.payload));
    expect(await verifyEd25519(env.signed, env.sig, en.json.serverPublicKey)).toBe(true);
    const res = await dev('POST', `/v1/commands/${env.payload.id}/result`, {
      status: 'succeeded',
      location: { lat: 6.9271, lng: 79.8612, accuracyM: 12, fixAt: Date.now(), source: 'fused', tier: 1, notification: { shownAt: Date.now(), channel: 'location_request', text: 'Requested for INC-1' } },
    });
    expect(res.status).toBe(200);
    const locs = await ctx.admin('GET', `/admin/location-results?ticket=INC-1&deviceId=${en.json.deviceId}`, undefined, 'op');
    expect(locs.json[0].fix.lat).toBe(6.9271);
    // helpdesk-equivalent (super admin) cannot read locations
    expect((await ctx.admin('GET', '/admin/location-results?ticket=INC-1', undefined, 'sa')).status).toBe(403);
    expect((await ctx.admin('GET', '/admin/audit/verify', undefined, 'sa')).json.ok).toBe(true);
  });

  it('the simulator speaks the same wire protocol through HttpDeviceTransport', async () => {
    const ctx = await bootstrapped();
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    const fetcher = ((url: string, init?: RequestInit) => ctx.app.request(new URL(url).pathname, init)) as unknown as typeof fetch;
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.json.provisioning), new HttpDeviceTransport('https://fleet.test', fetcher));
    await agent.enroll();
    agent.acknowledge();
    await agent.checkin();
    const da = await ctx.mk('DEVICE_ADMIN', 'da@corp.test');
    await ctx.signIn('da@corp.test', da, 'da');
    await ctx.admin('POST', `/admin/devices/${agent.state.deviceId}/commands`, { type: 'LOCK' }, 'da');
    expect(await agent.poll()).toEqual([expect.objectContaining({ type: 'LOCK', outcome: 'succeeded' })]);
  });

  it('user lifecycle: create, disable, reset MFA, sessions', async () => {
    const ctx = await bootstrapped();
    const hd = await ctx.mk('HELPDESK', 'hd@corp.test');
    await ctx.signIn('hd@corp.test', hd, 'hd');
    expect((await ctx.admin('POST', '/admin/users', { name: 'x', email: 'x@corp.test', role: 'AUDITOR', password: PW }, 'hd')).status).toBe(403);
    const users = (await ctx.admin('GET', '/admin/roles', undefined, 'sa')).json;
    const hdUser = users.find((u: any) => u.email === 'hd@corp.test');
    const sessions = (await ctx.admin('GET', '/admin/sessions', undefined, 'sa')).json;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(sessions)).not.toMatch(/ses_[A-Za-z0-9_-]{20,}/);
    expect((await ctx.admin('POST', `/admin/users/${hdUser.id}/disable`, { disabled: true }, 'sa')).json.disabled).toBe(true);
    expect((await ctx.admin('GET', '/admin/me', undefined, 'hd')).status).toBe(401);
    const reset = await ctx.admin('POST', `/admin/users/${hdUser.id}/reset-mfa`, {}, 'sa');
    expect(reset.json.totpSecret).not.toBe(hd);
  });

  it('employees: import, offboard, DSAR (Security only, ticketed, audited)', async () => {
    const ctx = await bootstrapped();
    const imp = await ctx.admin('POST', '/admin/employees/import', { rows: [{ name: 'A One', email: 'a@corp.test', department: 'Ops' }, { name: 'B', email: 'bad', department: '' }] }, 'sa');
    expect(imp.json).toMatchObject({ created: 1, updated: 0 });
    expect(imp.json.errors).toHaveLength(1);
    const emp = (await ctx.admin('GET', '/admin/employees', undefined, 'sa')).json[0];
    expect((await ctx.admin('POST', `/admin/employees/${emp.id}/dsar`, { ticket: 'DSAR-1' }, 'sa')).status).toBe(403);
    const sec = await ctx.mk('SECURITY', 'sec@corp.test');
    await ctx.signIn('sec@corp.test', sec, 'sec');
    expect((await ctx.admin('POST', `/admin/employees/${emp.id}/dsar`, {}, 'sec')).status).toBe(422);
    const d = await ctx.admin('POST', `/admin/employees/${emp.id}/dsar`, { ticket: 'DSAR-1' }, 'sec');
    expect(d.json.employee.email).toBe('a@corp.test');
    expect((await ctx.admin('POST', `/admin/employees/${emp.id}/offboard`, {}, 'sa')).status).toBe(200);
    const audit = (await ctx.admin('GET', '/admin/audit', undefined, 'sec')).json.map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['privacy.dsar_exported', 'employee.offboarded', 'employee.imported']));
  });

  it('app catalogue gates INSTALL_APP', async () => {
    const ctx = await bootstrapped();
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    const fetcher = ((url: string, init?: RequestInit) => ctx.app.request(new URL(url).pathname, init)) as unknown as typeof fetch;
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.json.provisioning), new HttpDeviceTransport('https://fleet.test', fetcher));
    await agent.enroll();
    const id = agent.state.deviceId!;
    expect((await ctx.admin('POST', `/admin/devices/${id}/commands`, { type: 'INSTALL_APP', params: { packageName: 'com.corp.time' } }, 'sa')).json.error).toBe('not_in_catalogue');
    expect((await ctx.admin('PUT', '/admin/apps', { packageName: 'com.corp.time', name: 'Time', url: 'http://insecure', sha256: 'a'.repeat(64) }, 'sa')).status).toBe(422);
    expect((await ctx.admin('PUT', '/admin/apps', { packageName: 'com.corp.time', name: 'Time', url: 'https://cdn.corp.test/time.apk', sha256: 'A'.repeat(64) }, 'sa')).status).toBe(200);
    const c = await ctx.admin('POST', `/admin/devices/${id}/commands`, { type: 'INSTALL_APP', params: { packageName: 'com.corp.time' } }, 'sa');
    expect(c.json.params).toMatchObject({ url: 'https://cdn.corp.test/time.apk', sha256: 'a'.repeat(64) });
  });

  it('retired devices lose API access', async () => {
    const ctx = await bootstrapped();
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    const fetcher = ((url: string, init?: RequestInit) => ctx.app.request(new URL(url).pathname, init)) as unknown as typeof fetch;
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.json.provisioning), new HttpDeviceTransport('https://fleet.test', fetcher));
    await agent.enroll();
    await agent.checkin();
    expect((await ctx.admin('POST', `/admin/devices/${agent.state.deviceId}/retire`, { reason: 'x' }, 'sa')).status).toBe(422);
    expect((await ctx.admin('POST', `/admin/devices/${agent.state.deviceId}/retire`, { reason: 'Returned to stock, broken screen' }, 'sa')).json.state).toBe('retired');
    await expect(agent.checkin()).rejects.toMatchObject({ status: 401 });
  });

  it('delete device and location ticket index over HTTP', async () => {
    const ctx = await bootstrapped();
    const opSecret = await ctx.mk('LOCATION_OPERATOR', 'op2@corp.test');
    await ctx.signIn('op2@corp.test', opSecret, 'op');
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    const fetcher = ((url: string, init?: RequestInit) => ctx.app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch;
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.json.provisioning), new HttpDeviceTransport('https://fleet.test', fetcher));
    await agent.enroll();
    agent.acknowledge();
    await agent.checkin();
    const id = agent.state.deviceId!;
    await ctx.admin('POST', `/admin/devices/${id}/commands`, { type: 'LOCATE', ticket: 'INC-55', reason: 'lost on train' }, 'op');
    await agent.poll();
    const idx = await ctx.admin('GET', '/admin/location-tickets', undefined, 'op');
    expect(idx.json[0]).toMatchObject({ ticket: 'INC-55', fixes: 1 });
    expect((await ctx.admin('GET', '/admin/location-tickets', undefined, 'sa')).status).toBe(403);
    expect((await ctx.admin('GET', '/admin/location-results?ticket=INC-55&tier=2', undefined, 'op')).json).toHaveLength(0);
    expect((await ctx.admin('GET', '/admin/location-results?ticket=INC-55&tier=1', undefined, 'op')).json).toHaveLength(1);

    // Active device: the server asks the phone to release management and uninstall first.
    const del = await ctx.admin('POST', `/admin/devices/${id}/delete`, { reason: 'Employee left the company', confirm: 'DELETE' }, 'sa');
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ status: 'pending_removal' });
    expect((await ctx.admin('GET', `/admin/devices/${id}`, undefined, 'sa')).json.pendingRemoval).toMatchObject({ reason: 'Employee left the company' });
    expect(await agent.poll()).toEqual([expect.objectContaining({ type: 'RELEASE', outcome: 'succeeded' })]);
    expect((await ctx.admin('GET', `/admin/devices/${id}`, undefined, 'sa')).status).toBe(404);
    expect((await ctx.admin('GET', '/admin/audit/verify', undefined, 'sa')).json.ok).toBe(true);
  });

  it('lost/stolen incident over HTTP: report, live track, update, resolve', async () => {
    const ctx = await bootstrapped();
    const opSecret = await ctx.mk('LOCATION_OPERATOR', 'op3@corp.test');
    await ctx.signIn('op3@corp.test', opSecret, 'op');
    const e = await ctx.admin('POST', '/admin/enrollments', {}, 'sa');
    const fetcher = ((url: string, init?: RequestInit) => ctx.app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch;
    const agent = new SimulatedAgent(newAgentFromProvisioning(e.json.provisioning), new HttpDeviceTransport('https://fleet.test', fetcher));
    await agent.enroll();
    agent.acknowledge();
    await agent.checkin();
    const id = agent.state.deviceId!;
    const body = { kind: 'lost', ticket: 'INC-71', reason: 'Lost on the train home', intervalSec: 120, durationHours: 24 };
    expect((await ctx.admin('POST', `/admin/devices/${id}/incidents`, body, 'sa')).status).toBe(403);
    const inc = await ctx.admin('POST', `/admin/devices/${id}/incidents`, body, 'op');
    expect(inc.status).toBe(201);
    await agent.poll();
    expect(agent.state.tracking).toMatchObject({ intervalSec: 120, kind: 'lost' });
    const track = await ctx.admin('GET', `/admin/incidents/${inc.json.id}/track`, undefined, 'op');
    expect(track.json).toMatchObject({ trackingActive: true, incident: { ticket: 'INC-71' } });
    expect(track.json.fixes).toHaveLength(1);
    expect((await ctx.admin('GET', `/admin/incidents/${inc.json.id}/track`, undefined, 'sa')).status).toBe(403);
    expect((await ctx.admin('GET', '/admin/incidents', undefined, 'sa')).json[0]).toMatchObject({ status: 'active', kind: 'lost' });
    const up = await ctx.admin('POST', `/admin/incidents/${inc.json.id}/tracking`, { intervalSec: 60, reason: 'Phone is moving, need more detail' }, 'op');
    expect(up.json.trackingIntervalSec).toBe(60);
    const done = await ctx.admin('POST', `/admin/incidents/${inc.json.id}/resolve`, { resolution: 'found', note: 'Returned by station staff' }, 'op');
    expect(done.json).toMatchObject({ status: 'resolved', resolution: 'found' });
    await agent.poll();
    expect(agent.state.lostMode).toBe(false);
  });

  it('Cloudflare Access SSO: verified e-mail maps to a provisioned user only', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
    const fetcher = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }))) as unknown as typeof fetch;
    const verify = makeAccessVerifier({ teamDomain: 'corp.cloudflareaccess.com', audience: 'aud-1', fetcher });
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const mint = async (claims: Record<string, unknown>) => {
      const data = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(data)));
      return `${data}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: 'https://corp.cloudflareaccess.com', aud: ['aud-1'], exp: now + 300, email: 'root@corp.test' };
    expect(await verify(await mint(good))).toBe('root@corp.test');
    expect(await verify(await mint({ ...good, aud: ['other'] }))).toBeNull();
    expect(await verify(await mint({ ...good, exp: now - 10 }))).toBeNull();
    // Tamper with a character in the middle of the signature, always changing it (the last base64url
    // character can carry padding bits, so editing it is not guaranteed to change the bytes).
    const tok = await mint(good);
    const sigStart = tok.lastIndexOf('.') + 1;
    const mid = sigStart + 20;
    const tampered = tok.slice(0, mid) + (tok[mid] === 'A' ? 'B' : 'A') + tok.slice(mid + 1);
    expect(await verify(tampered)).toBeNull();

    const ctx = await setup({ access: verify });
    await ctx.call('POST', '/bootstrap', { token: BOOT, name: 'Root', email: 'root@corp.test', password: PW });
    const ok = await ctx.call('POST', '/admin/sso', {}, { 'cf-access-jwt-assertion': await mint(good) }, 'sso');
    expect(ok.status).toBe(200);
    expect((await ctx.admin('GET', '/admin/me', undefined, 'sso')).json.email).toBe('root@corp.test');
    const stranger = await ctx.call('POST', '/admin/sso', {}, { 'cf-access-jwt-assertion': await mint({ ...good, email: 'x@corp.test' }) });
    expect(stranger.status).toBe(403);
  });
});

describe('SqlStore (Durable Object SQLite)', () => {
  const adapter = (db: DatabaseSync): SqlLike => ({
    exec: (q: string, ...b: unknown[]) => {
      const st = db.prepare(q);
      if (/^\s*select/i.test(q)) {
        const rows = st.all(...(b as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      st.run(...(b as never[]));
      return { toArray: () => [] };
    },
  });

  it('persists state + append-only audit and reloads with a valid chain', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqlStore(adapter(db));
    const b1 = await Backend.open({ store, pbkdf2Iterations: 1000 });
    await b1.createUser({ name: 'A', email: 'a@corp.test', role: 'SUPER_ADMIN', password: PW });
    const rows1 = db.prepare('select count(*) as n from audit').get() as { n: number };
    const store2 = new SqlStore(adapter(db));
    const st = store2.load()!;
    expect(st.users).toHaveLength(1);
    expect(st.audit).toHaveLength(rows1.n);
    expect(verifyChain(st.audit).ok).toBe(true);
    // big state is chunked
    const big = await Backend.open({ store: store2, pbkdf2Iterations: 1000 });
    for (let i = 0; i < 40; i++) big.addEmployee({ name: `E${i}`, email: `e${i}@corp.test`, department: 'x'.repeat(20_000) });
    const chunks = db.prepare('select count(*) as n from state_chunks').get() as { n: number };
    expect(chunks.n).toBeGreaterThan(1);
    expect(new SqlStore(adapter(db)).load()!.employees).toHaveLength(40);
  });
});

describe('FCM push provider', () => {
  it('exchanges a service-account JWT for a token and sends a data-only wake', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pk = new Uint8Array((await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pk))}\n-----END PRIVATE KEY-----\n`;
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      return new Response('{}');
    }) as unknown as typeof fetch;
    const p = new FcmPushProvider(JSON.stringify({ project_id: 'proj', client_email: 'sa@proj.iam', private_key: pem }), fetcher);
    await p.wake('dev1', 'android', 'fcm_placeholder', 'LOCK'); // placeholder → skipped
    expect(calls).toHaveLength(0);
    await p.wake('dev1', 'android', 'real-registration-token-123', 'LOCK');
    await p.wake('dev1', 'android', 'real-registration-token-123', 'LOCATE');
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); // token cached
    const send = calls.find((c) => c.url.includes('fcm.googleapis.com/v1/projects/proj/messages:send'))!;
    expect(JSON.parse(send.body).message).toEqual({ token: 'real-registration-token-123', data: { type: 'wake' }, android: { priority: 'HIGH', ttl: '600s' } });
  });
});
