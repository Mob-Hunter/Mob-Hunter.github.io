/**
 * Lost Mode location cadence (shared rule; the Android agent mirrors it in
 * Agent.lostFixIntervalMs).
 *  - Active tracking (lost/stolen incident): the chosen interval (≥ 60 s) until `until`.
 *  - Otherwise in Lost Mode: every 5 minutes (spec Tier 2).
 *  - Battery below 15%: never more often than every 5 minutes, to keep the phone findable longer.
 */
export const LOST_MODE_DEFAULT_MS = 5 * 60_000;

export function lostFixIntervalMs(tracking: { intervalSec: number; until: number } | null | undefined, now: number, batteryLevel: number | null | undefined): number {
  const active = !!tracking && now < tracking.until;
  const ms = active ? Math.max(60, Math.min(300, tracking!.intervalSec)) * 1000 : LOST_MODE_DEFAULT_MS;
  return batteryLevel !== null && batteryLevel !== undefined && batteryLevel < 15 ? Math.max(ms, LOST_MODE_DEFAULT_MS) : ms;
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Track statistics from fixes sorted newest first. */
export function trackStats(fixes: { lat: number; lng: number; fixAt: number }[]): { distanceM: number; speedKmh: number | null; durationMs: number } {
  if (fixes.length < 2) return { distanceM: 0, speedKmh: null, durationMs: 0 };
  const chron = fixes.slice().sort((a, b) => a.fixAt - b.fixAt);
  let distanceM = 0;
  for (let i = 1; i < chron.length; i++) distanceM += haversineM(chron[i - 1], chron[i]);
  const [prev, last] = [chron[chron.length - 2], chron[chron.length - 1]];
  const dt = (last.fixAt - prev.fixAt) / 3600_000;
  return { distanceM, speedKmh: dt > 0 ? haversineM(prev, last) / 1000 / dt : null, durationMs: last.fixAt - chron[0].fixAt };
}
