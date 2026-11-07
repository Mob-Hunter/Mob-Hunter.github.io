/**
 * Device-side transport: how an agent reaches the backend.
 * - LocalDeviceTransport calls the in-browser reference backend (demo mode).
 * - HttpDeviceTransport speaks the real wire protocol to a Mob Hunter server:
 *   signed headers over the raw body bytes (what the Android agent does).
 */
import type { Backend } from '../core/backend';
import { deviceRequestMessage } from '../core/backend';
import { canonicalJson, randomId, sha256Hex } from '../core/crypto';
import type { DeviceCertificate, DevicePolicy, SignedCommand } from '../core/types';

export interface DeviceSigner {
  deviceId: string;
  cert: DeviceCertificate;
  certSig: string;
  sign(message: string): Promise<string>;
}

export interface EnrollResponse {
  deviceId: string;
  cert: DeviceCertificate;
  certJson?: string;
  certSig: string;
  serverPublicKey: string;
  caPublicKey: string;
  policy: DevicePolicy;
  transparencyUrl?: string;
}

export interface DeviceTransport {
  readonly kind: 'local' | 'http';
  enroll(body: { token: string; devicePublicKey: string; keyAlg?: 'Ed25519' | 'ES256'; platform?: 'android'; hardware: { serial: string; model: string; os: string } }): Promise<EnrollResponse>;
  request<T>(method: 'GET' | 'POST', path: string, body: unknown, signer: DeviceSigner): Promise<T>;
}

/** JSON round-trip: nothing is shared by reference between "device" and "server". */
const wire = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export class LocalDeviceTransport implements DeviceTransport {
  readonly kind = 'local' as const;
  constructor(private readonly backend: Backend, private readonly clock: () => number = () => backend.now()) {}

  async enroll(body: Parameters<DeviceTransport['enroll']>[0]): Promise<EnrollResponse> {
    return wire(await this.backend.enroll(wire(body)));
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: unknown, signer: DeviceSigner): Promise<T> {
    const ts = this.clock();
    const nonce = randomId('', 12);
    const payload = method === 'GET' ? null : wire(body);
    const bodyHash = await sha256Hex(canonicalJson(payload ?? null));
    const sig = await signer.sign(deviceRequestMessage(method, path, ts, nonce, bodyHash));
    const auth = { deviceId: signer.deviceId, cert: wire(signer.cert), certSig: signer.certSig, ts, nonce, bodyHash, sig };
    const b = this.backend;
    const m = /^\/v1\/commands\/([^/]+)\/result$/.exec(path);
    let out: unknown;
    if (method === 'GET' && path === '/v1/policy') out = await b.devicePolicy(auth);
    else if (method === 'POST' && path === '/v1/checkin') out = await b.checkin(auth, payload as never);
    else if (method === 'GET' && path === '/v1/commands/pending') out = await b.pendingCommands(auth);
    else if (method === 'POST' && m) out = await b.commandResult(auth, m[1], payload as never);
    else if (method === 'POST' && path === '/v1/location/batch') out = await b.locationBatch(auth, payload as never);
    else if (method === 'POST' && path === '/v1/push-token') out = await b.registerPushToken(auth, payload as never);
    else throw new Error(`No such device route ${method} ${path}`);
    return wire(out) as T;
  }
}

export class DeviceHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class HttpDeviceTransport implements DeviceTransport {
  readonly kind = 'http' as const;
  /** @param baseUrl server origin, e.g. https://fleet.example.com (the API lives under /api) */
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = (...a) => fetch(...a), private readonly clock: () => number = () => Date.now()) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}/api${path}`;
  }

  private async parse<T>(res: Response): Promise<T> {
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new DeviceHttpError(res.status, j.error ?? 'http_error', j.message ?? `HTTP ${res.status}`);
    return j as T;
  }

  async enroll(body: Parameters<DeviceTransport['enroll']>[0]): Promise<EnrollResponse> {
    return this.parse(await this.fetcher(this.url('/v1/enroll'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: unknown, signer: DeviceSigner): Promise<T> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? null);
    const ts = this.clock();
    const nonce = randomId('', 12);
    const bodyHash = await sha256Hex(raw);
    const sig = await signer.sign(deviceRequestMessage(method, path, ts, nonce, bodyHash));
    const headers: Record<string, string> = {
      'x-mh-device': signer.deviceId,
      'x-mh-cert': btoa(canonicalJson(signer.cert)),
      'x-mh-cert-sig': signer.certSig,
      'x-mh-ts': String(ts),
      'x-mh-nonce': nonce,
      'x-mh-body-sha256': bodyHash,
      'x-mh-sig': sig,
    };
    if (raw) headers['content-type'] = 'application/json';
    return this.parse<T>(await this.fetcher(this.url(path), { method, headers, body: raw || undefined }));
  }
}

export type { SignedCommand };
