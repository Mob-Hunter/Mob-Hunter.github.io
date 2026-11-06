import { describe, expect, it } from 'vitest';
import { canonicalJson, generateAesKey, generateEd25519, openJson, sealJson, sha256Hex, signEd25519, verifyEd25519, fromHex, toHex, timingSafeEqual } from '../src/core/crypto';

describe('crypto primitives', () => {
  it('canonicalJson is key-order independent and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], u: undefined })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(() => canonicalJson({ x: Infinity })).toThrow();
  });

  it('sha256 matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hex round-trips and rejects garbage', () => {
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('zz')).toThrow();
  });

  it('Ed25519 signs and rejects tampering or the wrong key', async () => {
    const k = await generateEd25519();
    const other = await generateEd25519();
    const sig = await signEd25519('hello', k.secretKey);
    expect(await verifyEd25519('hello', sig, k.publicKey)).toBe(true);
    expect(await verifyEd25519('hellO', sig, k.publicKey)).toBe(false);
    expect(await verifyEd25519('hello', sig, other.publicKey)).toBe(false);
    expect(await verifyEd25519('hello', 'not-hex', k.publicKey)).toBe(false);
  });

  it('AES-GCM seals and binds the AAD', async () => {
    const key = await generateAesKey();
    const sealed = await sealJson({ lat: 6.9 }, key, 'loc_1|dev_1');
    expect(sealed.ct).not.toContain('6.9');
    expect(await openJson(sealed, key)).toEqual({ lat: 6.9 });
    await expect(openJson({ ...sealed, aad: 'loc_1|dev_2' }, key)).rejects.toBeTruthy();
    const otherKey = await generateAesKey();
    await expect(openJson(sealed, otherKey)).rejects.toBeTruthy();
  });

  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
