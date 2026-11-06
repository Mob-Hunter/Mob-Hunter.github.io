/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) used as the MFA factor for
 * admin sign-in. Verified against the RFC test vectors in tests/totp.test.ts.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export async function hotp(secret: Uint8Array, counter: number, digits = 6, hash: 'SHA-1' | 'SHA-256' | 'SHA-512' = 'SHA-1'): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secretB32: string, nowMs: number, opts: { step?: number; digits?: number } = {}): Promise<string> {
  const step = opts.step ?? 30;
  return hotp(base32Decode(secretB32), Math.floor(nowMs / 1000 / step), opts.digits ?? 6);
}

/** Accepts the current code and one step either side to tolerate clock drift. */
export async function verifyTotp(secretB32: string, code: string, nowMs: number): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  for (const drift of [-1, 0, 1]) {
    if ((await totp(secretB32, nowMs + drift * 30_000)) === code) return true;
  }
  return false;
}
