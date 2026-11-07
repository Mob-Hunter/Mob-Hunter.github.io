/**
 * Worker entry: /api/* goes to the tenant Durable Object; everything else is
 * the console SPA, embedded in the Worker (worker/generated/assets.ts) and
 * served with real security headers.
 */
import type { Env } from './env';
import { ASSETS } from './generated/assets';
export { TenantDO } from './tenant';

/** Where the signed APKs are published (GitHub Pages); the console fetches their checksums. */
const DOWNLOADS_ORIGIN = 'https://mob-hunter.github.io';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${DOWNLOADS_ORIGIN}`,
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function tenant(env: Env) {
  return env.TENANT.get(env.TENANT.idFromName('default'));
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Serves the embedded console; unknown paths get index.html (single-page app). */
export function serveAsset(request: Request): Response {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path === '/' || !ASSETS[path]) path = ASSETS[path] ? path : '/index.html';
  const asset = ASSETS[path];
  if (!asset) return new Response('Console not built', { status: 503, headers: SECURITY_HEADERS });
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', asset.type);
  headers.set('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (request.method === 'HEAD') return new Response(null, { headers });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
  return new Response(decode(asset.b64), { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return tenant(env).fetch(request);
    return serveAsset(request);
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await tenant(env).runRetention();
  },
} satisfies ExportedHandler<Env>;
