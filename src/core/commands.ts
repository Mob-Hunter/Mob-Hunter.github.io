/**
 * Signed command envelopes (Non-negotiable #5):
 * Ed25519-signed by the server, carry a nonce and a 10-minute expiry, and are
 * executed at most once (idempotent by command id).
 */
import { canonicalJson, randomId, signEd25519, verifyEd25519 } from './crypto';
import type { CommandType } from './rbac';
import type { CommandPayload, SignedCommand } from './types';

export const COMMAND_TTL_MS = 10 * 60 * 1000;
/** tolerated clock skew between server and device */
export const CLOCK_SKEW_MS = 2 * 60 * 1000;

export async function signCommand(
  input: { id: string; deviceId: string; type: CommandType; params: Record<string, unknown>; ticket?: string },
  key: { kid: string; secretKey: string },
  now: number,
): Promise<SignedCommand> {
  const payload: CommandPayload = {
    v: 1,
    id: input.id,
    deviceId: input.deviceId,
    type: input.type,
    params: input.params,
    nonce: randomId('', 16),
    issuedAt: now,
    expiresAt: now + COMMAND_TTL_MS,
    ...(input.ticket ? { ticket: input.ticket } : {}),
  };
  const sig = await signEd25519(canonicalJson(payload), key.secretKey);
  return { payload, sig, kid: key.kid };
}

export type VerifyFailure = 'bad_signature' | 'wrong_device' | 'expired' | 'not_yet_valid' | 'replayed' | 'malformed';
export type VerifyResult = { ok: true; payload: CommandPayload } | { ok: false; reason: VerifyFailure };

/**
 * Device-side verifier. Holds the pinned server key and remembers every
 * command id and nonce it has accepted so a replay is refused.
 */
export class CommandVerifier {
  private readonly seenIds: Set<string>;
  private readonly seenNonces: Set<string>;

  constructor(
    private readonly deviceId: string,
    private readonly serverPublicKey: string,
    seen: { ids?: string[]; nonces?: string[] } = {},
  ) {
    this.seenIds = new Set(seen.ids ?? []);
    this.seenNonces = new Set(seen.nonces ?? []);
  }

  snapshot(): { ids: string[]; nonces: string[] } {
    return { ids: [...this.seenIds], nonces: [...this.seenNonces] };
  }

  async verify(cmd: SignedCommand, now: number): Promise<VerifyResult> {
    const p = cmd?.payload;
    if (!p || p.v !== 1 || typeof cmd.sig !== 'string' || typeof p.id !== 'string' || typeof p.nonce !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    if (!(await verifyEd25519(canonicalJson(p), cmd.sig, this.serverPublicKey))) return { ok: false, reason: 'bad_signature' };
    if (p.deviceId !== this.deviceId) return { ok: false, reason: 'wrong_device' };
    if (p.expiresAt - p.issuedAt > COMMAND_TTL_MS) return { ok: false, reason: 'malformed' };
    if (now > p.expiresAt) return { ok: false, reason: 'expired' };
    if (p.issuedAt > now + CLOCK_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
    if (this.seenIds.has(p.id) || this.seenNonces.has(p.nonce)) return { ok: false, reason: 'replayed' };
    this.seenIds.add(p.id);
    this.seenNonces.add(p.nonce);
    return { ok: true, payload: p };
  }
}
