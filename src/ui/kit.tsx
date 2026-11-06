import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { Runtime } from '../runtime';
import { ApiError } from '../core/backend';
import type { PublicUser } from '../core/types';
import type { ConsoleApi } from '../api/console';
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
  return useRuntime().me;
}

export function useCan(perm: Permission): boolean {
  return can(useMe()?.role, perm);
}

type QueryState<T> = { data: T | null; error: string | null; loading: boolean };

/**
 * Async query against the console API. Re-runs when deps change and (unless
 * live=false) whenever the runtime signals a change; keeps showing the previous
 * data while refreshing. A 401 drops the local session.
 */
export function useQuery<T>(fn: (api: ConsoleApi) => Promise<T>, deps: unknown[] = [], opts: { live?: boolean; enabled?: boolean } = {}): [T | null, string | null, { loading: boolean; reload: () => void }] {
  const rt = useRuntime();
  const live = opts.live !== false;
  const enabled = opts.enabled !== false && !!rt.me;
  const [state, setState] = useState<QueryState<T>>({ data: null, error: null, loading: enabled });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn(rt.api).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) rt.sessionLost();
        setState((s) => ({ data: s.data, error: errorText(e), loading: false }));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, n, live ? rt.version : 0, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return [state.data, state.error, { loading: state.loading, reload }];
}

/** One-shot query (not refreshed on every change) — e.g. audited location views. */
export function useAsyncQuery<T>(fn: (api: ConsoleApi) => Promise<T>, deps: unknown[], enabled = true): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, error, meta] = useQuery(fn, deps, { live: false, enabled });
  return { data, error, ...meta };
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
  const rt = useContext(RuntimeCtx);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T> | T, ok?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast('ok', ok);
        // Refresh every view right away (server mode has no push from the backend to the browser).
        rt?.emit();
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) rt?.sessionLost();
        toast('err', errorText(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, rt],
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

let fieldSeq = 0;
/** Form field: the hint is outside the <label> (so the accessible name is just the label) and linked via aria-describedby. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const [hintId] = useState(() => `hint-${++fieldSeq}`);
  const child = hint && isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': hintId }) : children;
  return (
    <div className="field">
      <label className="field-inner">
        <span className="field-label">{label}</span>
        {child}
      </label>
      {hint && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function download(filename: string, text: string, type = 'application/json') {
  // Inside the FleetGuard Console APK, save through the native bridge (WebView cannot download blobs).
  const native = (window as unknown as { FleetGuardNative?: { saveFile(n: string, m: string, b64: string): boolean } }).FleetGuardNative;
  if (native) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    if (native.saveFile(filename, type, btoa(bin))) return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
