/**
 * Firebase Cloud Messaging (HTTP v1) push provider. Sends a data-only "wake"
 * message — never command data or personal data — and the agent then pulls
 * over its authenticated channel.
 */
import type { PushProvider } from '../src/core/relay';
import type { Platform } from '../src/core/types';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class FcmPushProvider implements PushProvider {
  private token: { value: string; exp: number } | null = null;
  private readonly sa: ServiceAccount;

  constructor(serviceAccountJson: string, private readonly fetcher: typeof fetch = fetch, private readonly onLog?: (msg: string) => void) {
    this.sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
    );
    const key = await crypto.subtle.importKey('pkcs8', pemToDer(this.sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
    const res = await this.fetcher(this.sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claims}.${b64url(sig)}`,
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: now + j.expires_in };
    return j.access_token;
  }

  async wake(deviceId: string, platform: Platform, pushToken: string, reason: string): Promise<void> {
    if (platform !== 'android' || !pushToken || pushToken.startsWith('fcm_')) return; // not registered yet: device polls
    try {
      const res = await this.fetcher(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: pushToken, data: { type: 'wake' }, android: { priority: 'HIGH', ttl: '600s' } } }),
      });
      if (!res.ok) this.onLog?.(`FCM wake for ${deviceId} (${reason}) failed: ${res.status}`);
    } catch (e) {
      this.onLog?.(`FCM wake for ${deviceId} failed: ${(e as Error).message}`);
    }
  }
}

/** Fallback when FCM is not configured: agents poll every 15 minutes (and immediately after check-in). */
export class NoopPushProvider implements PushProvider {
  async wake(): Promise<void> {}
}
