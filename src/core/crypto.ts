/**
 * Cryptographic primitives.
 *
 * - Ed25519 (via @noble/ed25519, audited, constant-time) for command signing,
 *   device certificates and device request signatures.
 * - SHA-256 (WebCrypto) for the audit hash chain.
 * - AES-256-GCM (WebCrypto) for location results at rest.
 *
 * Everything here works identically in modern browsers and in Node >= 20,
 * which is what lets the test-suite exercise the real crypto.
 */
import * as ed from '@noble/ed25519';

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** URL-safe, unguessable identifier (128 bits by default). */
export function randomId(prefix = '', bytes = 16): string {
  const b64 = toB64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return prefix ? `${prefix}_${b64}` : b64;
}

/**
 * Deterministic JSON serialisation (sorted keys, no whitespace) so that the
 * same object always produces the same bytes to sign or hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** Constant-time string comparison for secrets / MACs. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- Ed25519

export interface Ed25519KeyPair {
  /** hex-encoded 32-byte secret key */
  secretKey: string;
  /** hex-encoded 32-byte public key */
  publicKey: string;
}

export async function generateEd25519(): Promise<Ed25519KeyPair> {
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);
  return { secretKey: toHex(sk), publicKey: toHex(pk) };
}

export async function signEd25519(message: string, secretKeyHex: string): Promise<string> {
  const sig = await ed.signAsync(enc.encode(message), fromHex(secretKeyHex));
  return toHex(sig);
}

export async function verifyEd25519(message: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    return await ed.verifyAsync(fromHex(signatureHex), enc.encode(message), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

/** SHA-256 fingerprint of a public key, used for certificate pinning. */
export function fingerprint(publicKeyHex: string): Promise<string> {
  return sha256Hex(fromHex(publicKeyHex));
}

// ---------------------------------------------------------------- AES-GCM

export async function generateAesKey(): Promise<JsonWebKey> {
  const key = (await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])) as CryptoKey;
  return (await subtle.exportKey('jwk', key)) as JsonWebKey;
}

async function importAes(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface Sealed {
  iv: string;
  ct: string;
  /** additional authenticated data (not secret, but bound to the ciphertext) */
  aad: string;
}

export async function sealJson(value: unknown, jwk: JsonWebKey, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const key = await importAes(jwk);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource },
    key,
    enc.encode(JSON.stringify(value)) as BufferSource,
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)), aad };
}

export async function openJson<T>(sealed: Sealed, jwk: JsonWebKey): Promise<T> {
  const key = await importAes(jwk);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv) as BufferSource, additionalData: enc.encode(sealed.aad) as BufferSource },
    key,
    fromB64(sealed.ct) as BufferSource,
  );
  return JSON.parse(dec.decode(pt)) as T;
}

// ---------------------------------------------------------------- PBKDF2 (password hashing)

export async function hashPassword(password: string, saltHex: string, iterations = 210_000): Promise<string> {
  const base = await subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex) as BufferSource, iterations },
    base,
    256,
  );
  return toHex(new Uint8Array(bits));
}

// ---------------------------------------------------------------- ECDSA P-256 (Android Keystore device keys)

/** Converts an ASN.1 DER ECDSA signature (what Android/Java produce) to raw r||s (what WebCrypto expects). */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const expect = (b: number) => {
    if (der[i++] !== b) throw new Error('bad DER');
  };
  const readLen = (): number => {
    let len = der[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2) throw new Error('bad DER length');
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
    }
    return len;
  };
  expect(0x30);
  const total = readLen();
  if (total !== der.length - i) throw new Error('bad DER length');
  const out = new Uint8Array(size * 2);
  for (const off of [0, size]) {
    expect(0x02);
    let len = readLen();
    let start = i;
    while (len > size && der[start] === 0) {
      start++;
      len--;
    }
    if (len > size) throw new Error('integer too long');
    out.set(der.subarray(start, start + len), off + size - len);
    i = start + len;
  }
  if (i !== der.length) throw new Error('trailing DER bytes');
  return out;
}

/** Verifies an ES256 (ECDSA P-256 / SHA-256) signature; key is hex SPKI DER, signature hex DER or raw. */
export async function verifyEs256(message: string | Uint8Array, signatureHex: string, spkiHex: string): Promise<boolean> {
  try {
    const key = await subtle.importKey('spki', fromHex(spkiHex) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sigBytes = fromHex(signatureHex);
    const raw = sigBytes.length === 64 ? sigBytes : derToRawEcdsa(sigBytes);
    const data = typeof message === 'string' ? enc.encode(message) : message;
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

/** Test/simulator helper: generate an ES256 key pair as hex SPKI + exported JWK private key. */
export async function generateEs256(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const kp = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array((await subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer);
  return { publicKey: toHex(spki), privateJwk: (await subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey };
}

export async function signEs256(message: string, privateJwk: JsonWebKey): Promise<string> {
  const key = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return toHex(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(message) as BufferSource)));
}

/** True when the hex string is an importable P-256 SubjectPublicKeyInfo. */
export async function isP256Spki(spkiHex: string): Promise<boolean> {
  try {
    await subtle.importKey('spki', fromHex(spkiHex) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}
