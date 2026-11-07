/**
 * TenantDO — one Durable Object holds the organisation's state.
 * Durable Objects are single-threaded with transactional storage, so every
 * command, enrolment and audit append is serialised exactly as the in-memory
 * reference backend assumes (the per-device relay queues live inside it).
 */
import { DurableObject } from 'cloudflare:workers';
import { Backend } from '../src/core/backend';
import { createApp } from './http';
import { SqlStore } from './sqlstore';
import { FcmPushProvider, NoopPushProvider } from './fcm';
import { makeAccessVerifier } from './access';
import type { AuditRow } from '../src/core/audit';
import type { Env } from './env';

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class TenantDO extends DurableObject<Env> {
  private backendP: Promise<Backend> | null = null;
  private app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = createApp({
      getBackend: () => this.backend(),
      bootstrapToken: env.BOOTSTRAP_TOKEN || undefined,
      verifyAccessJwt: env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD ? makeAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }) : undefined,
      apks: env.APKS,
      pushClientConfig: env.FCM_CLIENT_CONFIG ? (JSON.parse(env.FCM_CLIENT_CONFIG) as Record<string, string>) : undefined,
      secureCookies: env.INSECURE_DEV_COOKIES !== 'true',
      clientIp: (c) => c.req.header('cf-connecting-ip') ?? 'unknown',
    });
  }

  private backend(): Promise<Backend> {
    this.backendP ??= Backend.open({
      store: new SqlStore(this.ctx.storage.sql),
      apiBaseUrl: `${(this.env.PUBLIC_URL || 'https://localhost').replace(/\/$/, '')}/api`,
      // Workers cap PBKDF2 at 100 000 iterations.
      pbkdf2Iterations: 100_000,
      push: this.env.FCM_SERVICE_ACCOUNT ? new FcmPushProvider(this.env.FCM_SERVICE_ACCOUNT, fetch, (m) => console.warn(m)) : new NoopPushProvider(),
      apkVersion: this.env.APK_VERSION || undefined,
      apkDownloadUrl: this.env.APK_DOWNLOAD_URL || `${(this.env.PUBLIC_URL || 'https://localhost').replace(/\/$/, '')}/downloads/mob-hunter-agent.apk`,
      apkSignatureChecksum: this.env.APK_SIGNATURE_CHECKSUM || undefined,
      onAudit: (row) => this.forwardAudit(row),
    }).then(async (b) => {
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
      return b;
    });
    return this.backendP;
  }

  /** SIEM forwarding: HMAC-signed POST of every audit row, outside the request's critical path. */
  private forwardAudit(row: AuditRow) {
    void this.backendP?.then((b) => {
      const url = b.siemWebhookUrl();
      if (!url) return;
      const body = JSON.stringify(row);
      this.ctx.waitUntil(
        (async () => {
          const sig = this.env.SIEM_WEBHOOK_SECRET ? await hmacHex(this.env.SIEM_WEBHOOK_SECRET, body) : '';
          await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mob-hunter-signature': sig }, body }).catch((e) => console.warn('SIEM forward failed', e));
        })(),
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  /** Hourly: 30-day location purge, token/command retention. */
  async alarm(): Promise<void> {
    const b = await this.backend();
    await b.runRetention();
    await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }

  async runRetention(): Promise<number> {
    return (await this.backend()).runRetention();
  }
}
