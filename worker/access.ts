/**
 * Cloudflare Access (SSO) JWT verification: RS256 against the team's JWKS,
 * checking issuer, audience and expiry. Returns the verified e-mail.
 */
interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

export function makeAccessVerifier(opts: { teamDomain: string; audience: string; fetcher?: typeof fetch; now?: () => number }) {
  const issuer = `https://${opts.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const fetcher = opts.fetcher ?? fetch;
  let cache: { keys: Jwk[]; at: number } | null = null;

  const keys = async (force = false): Promise<Jwk[]> => {
    if (!force && cache && Date.now() - cache.at < 3600_000) return cache.keys;
    const res = await fetcher(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    cache = { keys: ((await res.json()) as { keys: Jwk[] }).keys, at: Date.now() };
    return cache.keys;
  };

  return async (jwt: string): Promise<string | null> => {
    try {
      const [h, p, s] = jwt.split('.');
      if (!h || !p || !s) return null;
      const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { alg: string; kid: string };
      if (header.alg !== 'RS256') return null;
      let jwk = (await keys()).find((k) => k.kid === header.kid);
      if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
      if (!jwk) return null;
      const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`) as BufferSource);
      if (!ok) return null;
      const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as { iss: string; aud: string | string[]; exp: number; nbf?: number; email?: string };
      const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer || !aud.includes(opts.audience) || claims.exp < now || (claims.nbf && claims.nbf > now + 60)) return null;
      return claims.email ?? null;
    } catch {
      return null;
    }
  };
}
