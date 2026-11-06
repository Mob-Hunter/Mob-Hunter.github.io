import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/core/totp';

const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it('matches RFC 4226 HOTP vectors', async () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    for (let i = 0; i < expected.length; i++) expect(await hotp(RFC_SECRET, i)).toBe(expected[i]);
  });

  it('matches RFC 6238 SHA-1 vectors (8 digits)', async () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect(await hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });

  it('base32 round-trips', () => {
    const b32 = base32Encode(RFC_SECRET);
    expect(b32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(b32)).toEqual(RFC_SECRET);
  });

  it('verifies with ±1 step drift and rejects others', async () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    const code = await totp(secret, now);
    expect(await verifyTotp(secret, code, now)).toBe(true);
    expect(await verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(await verifyTotp(secret, code, now + 120_000)).toBe(false);
    expect(await verifyTotp(secret, 'abcdef', now)).toBe(false);
  });
});
