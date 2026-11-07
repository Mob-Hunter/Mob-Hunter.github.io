/**
 * HTTP API for FleetGuard (build-prompt §3.3), as a platform-neutral Hono app.
 *
 * In production it runs inside the TenantDO Durable Object (worker/tenant.ts),
 * which gives single-threaded, strongly consistent state. The same app is
 * exercised in Node by tests/worker-http.test.ts.
 */
import { Hono, type Context } from 'hono';
import { ApiError, type Backend } from '../src/core/backend';
import { sha256Hex, timingSafeEqual } from '../src/core/crypto';
import { isCommandType, isRole } from '../src/core/rbac';
import type { DeviceAuth } from '../src/core/types';

export const SESSION_COOKIE = 'fg_sid';
export const CSRF_HEADER = 'x-fleetguard-csrf';
export const API_VERSION = '2.0.0';

export interface ApkStore {
  get(key: string): Promise<{ body: ReadableStream | ArrayBuffer | null; size?: number } | null>;
}

export interface HttpConfig {
  getBackend: () => Promise<Backend>;
  /** shared secret allowing creation of the first Super Admin (unset = bootstrap disabled) */
  bootstrapToken?: string;
  /** Cloudflare Access: verifies the Cf-Access-Jwt-Assertion header, returns the e-mail or null */
  verifyAccessJwt?: (jwt: string) => Promise<string | null>;
  apks?: ApkStore;
  /** Firebase client options handed to agents so they can obtain an FCM token */
  pushClientConfig?: Record<string, string>;
  /** set false only for local http testing */
  secureCookies?: boolean;
  clientIp?: (c: Context) => string;
}

type Vars = { Variables: { sid: string; backend: Backend } };

class IpLimiter {
  private hits = new Map<string, { t: number; n: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  check(ip: string) {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || now - h.t > this.windowMs) {
      this.hits.set(ip, { t: now, n: 1 });
      if (this.hits.size > 10_000) this.hits.clear();
      return;
    }
    if (++h.n > this.limit) throw new ApiError(429, 'rate_limited', 'Too many requests from this address');
  }
}

function getCookie(c: Context, name: string): string | undefined {
  const raw = c.req.header('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function createApp(cfg: HttpConfig) {
  const app = new Hono<Vars>().basePath('/api');
  const authLimiter = new IpLimiter(30, 60_000);
  const enrollLimiter = new IpLimiter(20, 60_000);
  const ipOf = cfg.clientIp ?? ((c: Context) => c.req.header('cf-connecting-ip') ?? 'local');
  const secure = cfg.secureCookies !== false;

  const setSession = (c: Context, sid: string | null) => {
    const attrs = ['Path=/api', 'HttpOnly', 'SameSite=Strict', secure ? 'Secure' : ''].filter(Boolean);
    c.header('Set-Cookie', sid ? `${SESSION_COOKIE}=${encodeURIComponent(sid)}; ${attrs.join('; ')}; Max-Age=43200` : `${SESSION_COOKIE}=; ${attrs.join('; ')}; Max-Age=0`);
  };

  // ---- security headers + error mapping
  app.use('*', async (c, next) => {
    c.set('backend', await cfg.getBackend());
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    if (err instanceof SyntaxError) return c.json({ error: 'bad_json', message: 'Malformed JSON body' }, 400);
    console.error('internal error', err);
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: 'No such route' }, 404));

  const body = async <T>(c: Context): Promise<T> => {
    const text = await c.req.text();
    if (text.length > 1_000_000) throw new ApiError(413, 'too_large', 'Body too large');
    return (text ? JSON.parse(text) : {}) as T;
  };

  // ---------------------------------------------------------------- public
  app.get('/health', (c) =>
    c.json({ service: 'fleetguard', mode: 'server', version: API_VERSION, needsBootstrap: c.var.backend.needsBootstrap(), sso: !!cfg.verifyAccessJwt }),
  );

  app.post('/bootstrap', async (c) => {
    authLimiter.check(ipOf(c));
    const b = await body<{ token?: string; name: string; email: string; password: string }>(c);
    if (!cfg.bootstrapToken || !b.token || !timingSafeEqual(b.token, cfg.bootstrapToken)) throw new ApiError(403, 'forbidden', 'Invalid bootstrap token');
    return c.json(await c.var.backend.bootstrap(b), 201);
  });

  app.get('/e/:token', async (c) => c.json(await c.var.backend.installPage(c.req.param('token'))));
  app.get('/transparency/:id/:key', async (c) => c.json(await c.var.backend.transparency(c.req.param('id'), c.req.param('key'))));

  app.get('/apk/:version', async (c) => {
    const v = c.req.param('version');
    if (!/^\d+\.\d+\.\d+$/.test(v) || !cfg.apks) throw new ApiError(404, 'not_found', 'APK not found');
    const obj = await cfg.apks.get(`agent-${v}.apk`);
    if (!obj?.body) throw new ApiError(404, 'not_found', 'APK not found');
    return new Response(obj.body as BodyInit, {
      headers: { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="fleetguard-agent-${v}.apk"`, 'cache-control': 'public, max-age=300' },
    });
  });

  // ---------------------------------------------------------------- admin auth
  app.post('/admin/login', async (c) => {
    authLimiter.check(ipOf(c));
    const b = await body<{ email: string; password: string }>(c);
    return c.json(await c.var.backend.login(b.email, b.password));
  });
  app.post('/admin/mfa', async (c) => {
    authLimiter.check(ipOf(c));
    const b = await body<{ challengeId: string; code: string }>(c);
    const r = await c.var.backend.verifyMfa(b.challengeId, b.code);
    setSession(c, r.sessionId);
    return c.json({ user: r.user });
  });
  app.post('/admin/sso', async (c) => {
    authLimiter.check(ipOf(c));
    const jwt = c.req.header('cf-access-jwt-assertion');
    if (!cfg.verifyAccessJwt || !jwt) throw new ApiError(404, 'sso_disabled', 'Single sign-on is not configured');
    const email = await cfg.verifyAccessJwt(jwt);
    if (!email) throw new ApiError(401, 'sso_invalid', 'SSO assertion rejected');
    const r = await c.var.backend.ssoLogin(email, 'cloudflare-access');
    setSession(c, r.sessionId);
    return c.json({ user: r.user });
  });

  // Everything below needs a session cookie AND the CSRF header (SameSite=Strict + custom header).
  app.use('/admin/*', async (c, next) => {
    if (['/api/admin/login', '/api/admin/mfa', '/api/admin/sso'].includes(c.req.path)) return next();
    if (c.req.header(CSRF_HEADER) !== '1') throw new ApiError(403, 'csrf', 'Missing CSRF header');
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) throw new ApiError(401, 'unauthenticated', 'Please sign in');
    c.set('sid', sid);
    return next();
  });

  app.post('/admin/logout', async (c) => {
    await c.var.backend.logout(c.var.sid);
    setSession(c, null);
    return c.json({ ok: true });
  });
  app.get('/admin/me', (c) => c.json(c.var.backend.me(c.var.sid)));
  app.post('/admin/me/password', async (c) => {
    const b = await body<{ current: string; next: string }>(c);
    await c.var.backend.changePassword(c.var.sid, b.current, b.next);
    return c.json({ ok: true });
  });

  // devices
  app.get('/admin/stats', (c) => c.json(c.var.backend.stats(c.var.sid)));
  app.get('/admin/devices', (c) => c.json(c.var.backend.listDevices(c.var.sid, { q: c.req.query('q') ?? undefined, unnamedOnly: c.req.query('unnamed') === '1' })));
  app.get('/admin/devices/:id', (c) => c.json(c.var.backend.getDevice(c.var.sid, c.req.param('id'))));
  app.patch('/admin/devices/:id', async (c) => c.json(await c.var.backend.updateDevice(c.var.sid, c.req.param('id'), await body(c))));
  app.post('/admin/devices/:id/policy', async (c) => {
    const b = await body<{ patch: Parameters<Backend['updatePolicy']>[2]; justification: string }>(c);
    return c.json(await c.var.backend.updatePolicy(c.var.sid, c.req.param('id'), b.patch ?? {}, b.justification));
  });
  app.post('/admin/devices/:id/incidents', async (c) => c.json(await c.var.backend.reportIncident(c.var.sid, c.req.param('id'), await body(c)), 201));
  app.get('/admin/incidents', (c) => c.json(c.var.backend.listIncidents(c.var.sid)));
  app.get('/admin/incidents/:id/track', async (c) => c.json(await c.var.backend.trackIncident(c.var.sid, c.req.param('id'))));
  app.post('/admin/incidents/:id/tracking', async (c) => c.json(await c.var.backend.updateIncidentTracking(c.var.sid, c.req.param('id'), await body(c))));
  app.post('/admin/incidents/:id/resolve', async (c) => c.json(await c.var.backend.resolveIncident(c.var.sid, c.req.param('id'), await body(c))));
  app.post('/admin/devices/:id/cancel-removal', async (c) => c.json(await c.var.backend.cancelRemoval(c.var.sid, c.req.param('id'))));
  app.post('/admin/devices/:id/delete', async (c) => c.json(await c.var.backend.deleteDevice(c.var.sid, c.req.param('id'), await body(c))));
  app.post('/admin/devices/:id/retire', async (c) => c.json(await c.var.backend.retireDevice(c.var.sid, c.req.param('id'), (await body<{ reason: string }>(c)).reason)));
  app.post('/admin/devices/:id/commands', async (c) => {
    const b = await body<{ type: string; ticket?: string; reason?: string; params?: Record<string, unknown> }>(c);
    if (!isCommandType(b.type)) throw new ApiError(422, 'invalid_command', 'Unknown command type');
    const { envelope: _e, ...cmd } = await c.var.backend.issueCommand(c.var.sid, c.req.param('id'), { ...b, type: b.type });
    return c.json(cmd, 201);
  });
  app.post('/admin/commands/:id/approve', async (c) => {
    const { envelope: _e, ...cmd } = await c.var.backend.approveCommand(c.var.sid, c.req.param('id'), !!(await body<{ approve: boolean }>(c)).approve);
    return c.json(cmd);
  });
  app.get('/admin/commands', (c) => c.json(c.var.backend.listCommands(c.var.sid, c.req.query('deviceId') ?? undefined)));
  app.get('/admin/push-log', (c) => c.json(c.var.backend.pushLog(c.var.sid)));
  app.get('/admin/compliance', (c) => c.json(c.var.backend.compliance(c.var.sid)));

  // enrolment
  app.post('/admin/enrollments', async (c) => c.json(await c.var.backend.createEnrollment(c.var.sid, await body(c)), 201));
  app.get('/admin/enrollments', (c) => c.json(c.var.backend.listEnrollments(c.var.sid)));

  // location
  app.get('/admin/location-results', async (c) => {
    const tier = Number(c.req.query('tier'));
    return c.json(
      await c.var.backend.listLocationResults(c.var.sid, {
        deviceId: c.req.query('deviceId') ?? undefined,
        ticket: c.req.query('ticket') ?? '',
        tier: tier === 1 || tier === 2 || tier === 3 ? tier : undefined,
        sinceMs: Number(c.req.query('sinceMs')) || undefined,
        onlyTicket: c.req.query('onlyTicket') === '1',
      }),
    );
  });
  app.get('/admin/location-tickets', (c) => c.json(c.var.backend.listLocationTickets(c.var.sid)));
  app.post('/admin/location-purge', async (c) => c.json({ purged: await c.var.backend.purgeNow(c.var.sid) }));

  // audit
  app.get('/admin/audit', (c) => c.json(c.var.backend.listAudit(c.var.sid)));
  app.get('/admin/audit/verify', async (c) => c.json(await c.var.backend.verifyAudit(c.var.sid)));
  app.get('/admin/audit/export', async (c) => {
    const text = await c.var.backend.exportAudit(c.var.sid);
    return c.body(text, 200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="audit-export.json"' });
  });

  // users, roles, sessions
  app.get('/admin/roles', (c) => c.json(c.var.backend.listUsers(c.var.sid)));
  app.post('/admin/users', async (c) => c.json(await c.var.backend.adminCreateUser(c.var.sid, await body(c)), 201));
  app.patch('/admin/users/:id/role', async (c) => {
    const role = (await body<{ role: string }>(c)).role;
    if (!isRole(role)) throw new ApiError(422, 'invalid_role', 'Unknown role');
    return c.json(await c.var.backend.setUserRole(c.var.sid, c.req.param('id'), role));
  });
  app.post('/admin/users/:id/disable', async (c) => c.json(await c.var.backend.setUserDisabled(c.var.sid, c.req.param('id'), !!(await body<{ disabled: boolean }>(c)).disabled)));
  app.post('/admin/users/:id/reset-mfa', async (c) => c.json(await c.var.backend.resetUserMfa(c.var.sid, c.req.param('id'))));
  app.get('/admin/sessions', (c) => c.json(c.var.backend.listSessions(c.var.sid)));
  app.delete('/admin/sessions/:id', async (c) => {
    await c.var.backend.revokeSession(c.var.sid, c.req.param('id'));
    return c.json({ ok: true });
  });

  // employees
  app.get('/admin/employees', (c) => c.json(c.var.backend.listEmployees(c.var.sid)));
  app.post('/admin/employees', async (c) => c.json(await c.var.backend.createEmployee(c.var.sid, await body(c)), 201));
  app.patch('/admin/employees/:id', async (c) => c.json(await c.var.backend.updateEmployee(c.var.sid, c.req.param('id'), await body(c))));
  app.post('/admin/employees/import', async (c) => c.json(await c.var.backend.importEmployees(c.var.sid, (await body<{ rows: never[] }>(c)).rows)));
  app.post('/admin/employees/:id/offboard', async (c) => c.json(await c.var.backend.offboardEmployee(c.var.sid, c.req.param('id'))));
  app.post('/admin/employees/:id/dsar', async (c) => {
    const text = await c.var.backend.exportEmployeeData(c.var.sid, c.req.param('id'), (await body<{ ticket: string }>(c)).ticket);
    return c.body(text, 200, { 'content-type': 'application/json' });
  });

  // settings & app catalogue
  app.get('/admin/settings', (c) => c.json(c.var.backend.getSettings(c.var.sid)));
  app.patch('/admin/settings', async (c) => c.json(await c.var.backend.updateSettings(c.var.sid, await body(c))));
  app.put('/admin/apps', async (c) => c.json(await c.var.backend.upsertApp(c.var.sid, await body(c))));
  app.delete('/admin/apps/:pkg', async (c) => c.json(await c.var.backend.removeApp(c.var.sid, c.req.param('pkg'))));

  // ---------------------------------------------------------------- device API (signed requests)

  /** Builds DeviceAuth from headers. The body hash is computed HERE from the raw bytes. */
  const deviceAuth = async (c: Context, raw: string): Promise<DeviceAuth> => {
    const h = (k: string) => c.req.header(k) ?? '';
    let cert: DeviceAuth['cert'];
    try {
      cert = JSON.parse(atob(h('x-fg-cert')));
    } catch {
      throw new ApiError(401, 'device_unauthenticated', 'Missing or malformed client certificate');
    }
    return {
      deviceId: h('x-fg-device'),
      cert,
      certSig: h('x-fg-cert-sig'),
      ts: Number(h('x-fg-ts')),
      nonce: h('x-fg-nonce'),
      bodyHash: h('x-fg-body-sha256').toLowerCase(),
      sig: h('x-fg-sig').toLowerCase(),
      serverBodyHash: await sha256Hex(raw),
    };
  };
  const deviceCall = async <T>(c: Context, fn: (auth: DeviceAuth, body: never) => Promise<T>) => {
    const raw = await c.req.text();
    if (raw.length > 512_000) throw new ApiError(413, 'too_large', 'Body too large');
    const auth = await deviceAuth(c, raw);
    return c.json(await fn(auth, (raw ? JSON.parse(raw) : null) as never));
  };

  app.post('/v1/enroll', async (c) => {
    enrollLimiter.check(ipOf(c));
    const r = await c.var.backend.enroll(await body(c));
    return c.json({ ...r, push: cfg.pushClientConfig ?? null }, 201);
  });
  app.get('/v1/policy', (c) => deviceCall(c, (a) => c.var.backend.devicePolicy(a)));
  app.post('/v1/checkin', (c) => deviceCall(c, (a, b) => c.var.backend.checkin(a, b)));
  app.get('/v1/commands/pending', (c) => deviceCall(c, (a) => c.var.backend.pendingCommands(a)));
  app.post('/v1/commands/:id/result', (c) => deviceCall(c, (a, b) => c.var.backend.commandResult(a, c.req.param('id'), b)));
  app.post('/v1/location/batch', (c) => deviceCall(c, (a, b) => c.var.backend.locationBatch(a, b)));
  app.post('/v1/push-token', (c) => deviceCall(c, (a, b) => c.var.backend.registerPushToken(a, b)));

  return app;
}
