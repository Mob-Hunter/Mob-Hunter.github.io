/**
 * Worker entry: /api/* goes to the tenant Durable Object; everything else is
 * the console SPA from Workers Static Assets, served with real security headers.
 */
import type { Env } from './env';
export { TenantDO } from './tenant';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function tenant(env: Env) {
  return env.TENANT.get(env.TENANT.idFromName('default'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return tenant(env).fetch(request);
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('X-Frame-Options', 'DENY');
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return out;
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await tenant(env).runRetention();
  },
} satisfies ExportedHandler<Env>;
