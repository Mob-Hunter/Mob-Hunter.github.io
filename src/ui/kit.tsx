import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { Runtime } from '../runtime';
import { ApiError } from '../core/backend';
import type { PublicUser } from '../core/types';
import { can, type Permission } from '../core/rbac';

// ---------------------------------------------------------------- runtime context

const RuntimeCtx = createContext<Runtime | null>(null);
export const RuntimeProvider = RuntimeCtx.Provider;

export function useRuntime(): Runtime {
  const rt = useContext(RuntimeCtx);
  if (!rt) throw new Error('Runtime missing');
  // Re-render on every backend / simulator change.
  useSyncExternalStore(
    (cb) => rt.subscribe(cb),
    () => rt.version,
  );
  return rt;
}

/** Current signed-in admin, or null. */
export function useMe(): PublicUser | null {
  const rt = useRuntime();
  const sid = rt.sessionId;
  if (!sid) return null;
  try {
    return rt.backend.me(sid);
  } catch {
    return null;
  }
}

export function useCan(perm: Permission): boolean {
  return can(useMe()?.role, perm);
}

/** Calls a backend read with the current session; returns [data, error]. */
export function useQuery<T>(fn: (sid: string) => T, deps: unknown[] = []): [T | null, string | null] {
  const rt = useRuntime();
  const sid = rt.sessionId;
  return useMemo(() => {
    if (!sid) return [null, 'Not signed in'];
    try {
      return [fn(sid), null];
    } catch (e) {
      return [null, errorText(e)];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.version, sid, ...deps]);
}

/** Like useQuery but for async calls. */
export function useAsyncQuery<T>(fn: (sid: string) => Promise<T>, deps: unknown[], enabled = true): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const rt = useRuntime();
  const sid = rt.sessionId;
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: enabled });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled || !sid) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn(sid).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e) => live && setState({ data: null, error: errorText(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, enabled, n, ...deps]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Async query for public (unauthenticated) endpoints. */
export function usePublicQuery<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [s, setS] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setS({ data, error: null }),
      (e) => live && setS({ data: null, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with toast feedback; returns the result or undefined on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T> | T, ok?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast('ok', ok);
        return r;
      } catch (e) {
        toast('err', errorText(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------------------------------------------------------------- small components

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="errorbox" role="alert">
      {children}
    </div>
  );
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${fmtDuration(-s)}`;
  if (s < 10) return 'just now';
  return `${fmtDuration(s)} ago`;
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function QrImage({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 320 }).then((d) => live && setSrc(d), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [text]);
  return src ? <img className="qr" src={src} alt={label} width={260} height={260} /> : <div className="qr qr-loading">Generating QR…</div>;
}

/** Dependency-free map: plots fixes on a grid with accuracy circles (no third-party tiles = no tracking). */
export function MiniMap({ points }: { points: { lat: number; lng: number; accuracyM: number; label: string; highlight?: boolean }[] }) {
  if (!points.length) return <div className="minimap minimap-empty">No location fixes to show</div>;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const pad = 0.004;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;
  const W = 600;
  const H = 360;
  const x = (lng: number) => ((lng - minLng) / (maxLng - minLng || 1)) * W;
  const y = (lat: number) => H - ((lat - minLat) / (maxLat - minLat || 1)) * H;
  const metersPerPx = ((maxLng - minLng) * 111_320 * Math.cos((minLat * Math.PI) / 180)) / W;
  const latest = points[0];
  return (
    <figure className="minimap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map with ${points.length} location fixes`}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" className="grid-line" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" className="map-bg" />
        {points
          .slice()
          .reverse()
          .map((p, i) => (
            <g key={i}>
              <circle cx={x(p.lng)} cy={y(p.lat)} r={Math.max(4, p.accuracyM / (metersPerPx || 1))} className="acc" />
              <circle cx={x(p.lng)} cy={y(p.lat)} r={p.highlight ? 8 : 5} className={p.highlight ? 'pin pin-hi' : 'pin'}>
                <title>{p.label}</title>
              </circle>
            </g>
          ))}
      </svg>
      <figcaption>
        Latest: {latest.lat.toFixed(5)}, {latest.lng.toFixed(5)} (±{Math.round(latest.accuracyM)} m) ·{' '}
        <a href={`https://www.openstreetmap.org/?mlat=${latest.lat}&mlon=${latest.lng}#map=17/${latest.lat}/${latest.lng}`} target="_blank" rel="noopener noreferrer">
          Open in OpenStreetMap
        </a>
      </figcaption>
    </figure>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function download(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
