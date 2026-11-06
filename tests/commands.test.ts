import { describe, expect, it } from 'vitest';
import { COMMAND_TTL_MS, CommandVerifier, signCommand } from '../src/core/commands';
import { canonicalJson, generateEd25519, signEd25519 } from '../src/core/crypto';

async function fixture() {
  const key = await generateEd25519();
  const now = 1_800_000_000_000;
  const env = await signCommand({ id: 'cmd_1', deviceId: 'dev_1', type: 'LOCATE', params: {}, ticket: 'INC-1' }, { kid: 'k1', secretKey: key.secretKey }, now);
  return { key, now, env };
}

describe('signed commands', () => {
  it('carries a nonce and a 10-minute expiry', async () => {
    const { env, now } = await fixture();
    expect(env.payload.nonce.length).toBeGreaterThan(10);
    expect(env.payload.expiresAt - now).toBe(COMMAND_TTL_MS);
    expect(COMMAND_TTL_MS).toBe(600_000);
  });

  it('accepts a valid command exactly once', async () => {
    const { key, env, now } = await fixture();
    const v = new CommandVerifier('dev_1', key.publicKey);
    expect(await v.verify(env, now + 1000)).toEqual({ ok: true, payload: env.payload });
    expect(await v.verify(env, now + 2000)).toEqual({ ok: false, reason: 'replayed' });
  });

  it('remembers seen commands across restarts via snapshot', async () => {
    const { key, env, now } = await fixture();
    const v1 = new CommandVerifier('dev_1', key.publicKey);
    await v1.verify(env, now);
    const v2 = new CommandVerifier('dev_1', key.publicKey, v1.snapshot());
    expect(await v2.verify(env, now)).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('rejects expired commands', async () => {
    const { key, env, now } = await fixture();
    expect(await new CommandVerifier('dev_1', key.publicKey).verify(env, now + COMMAND_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampered payloads', async () => {
    const { key, env, now } = await fixture();
    const tampered = { ...env, payload: { ...env.payload, type: 'WIPE' as const } };
    expect(await new CommandVerifier('dev_1', key.publicKey).verify(tampered, now)).toEqual({ ok: false, reason: 'bad_signature' });
    const extended = { ...env, payload: { ...env.payload, expiresAt: env.payload.expiresAt + 3600_000 } };
    expect(await new CommandVerifier('dev_1', key.publicKey).verify(extended, now)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects commands for another device or from another key', async () => {
    const { key, env, now } = await fixture();
    expect(await new CommandVerifier('dev_2', key.publicKey).verify(env, now)).toEqual({ ok: false, reason: 'wrong_device' });
    const attacker = await generateEd25519();
    expect(await new CommandVerifier('dev_1', attacker.publicKey).verify(env, now)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a validly-signed command whose lifetime exceeds 10 minutes', async () => {
    const { key, now } = await fixture();
    const payload = { v: 1 as const, id: 'c', deviceId: 'dev_1', type: 'LOCK' as const, params: {}, nonce: 'n'.repeat(16), issuedAt: now, expiresAt: now + COMMAND_TTL_MS * 6 };
    const sig = await signEd25519(canonicalJson(payload), key.secretKey);
    expect(await new CommandVerifier('dev_1', key.publicKey).verify({ payload, sig, kid: 'k' }, now)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects commands from the future and malformed envelopes', async () => {
    const { key, env, now } = await fixture();
    expect(await new CommandVerifier('dev_1', key.publicKey).verify(env, now - 10 * 60_000)).toEqual({ ok: false, reason: 'not_yet_valid' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await new CommandVerifier('dev_1', key.publicKey).verify({} as any, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});
