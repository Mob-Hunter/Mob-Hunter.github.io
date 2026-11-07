import { describe, expect, it } from 'vitest';
import { haversineM, lostFixIntervalMs, trackStats } from '../src/core/tracking';

const now = 1_800_000_000_000;

describe('Lost Mode cadence (mirrored by the Android agent)', () => {
  it('active tracking uses the chosen interval', () => {
    expect(lostFixIntervalMs({ intervalSec: 60, until: now + 3_600_000 }, now, 80)).toBe(60_000);
    expect(lostFixIntervalMs({ intervalSec: 120, until: now + 3_600_000 }, now, null)).toBe(120_000);
  });
  it('clamps to sane bounds', () => {
    expect(lostFixIntervalMs({ intervalSec: 5, until: now + 1000 }, now, 80)).toBe(60_000);
    expect(lostFixIntervalMs({ intervalSec: 900, until: now + 1000 }, now, 80)).toBe(300_000);
  });
  it('falls back to 5 minutes when tracking ends or is absent', () => {
    expect(lostFixIntervalMs({ intervalSec: 60, until: now - 1 }, now, 80)).toBe(300_000);
    expect(lostFixIntervalMs(null, now, 80)).toBe(300_000);
  });
  it('low battery slows to 5 minutes', () => {
    expect(lostFixIntervalMs({ intervalSec: 60, until: now + 3_600_000 }, now, 14)).toBe(300_000);
    expect(lostFixIntervalMs({ intervalSec: 60, until: now + 3_600_000 }, now, 15)).toBe(60_000);
  });
});

describe('track statistics', () => {
  it('haversine is accurate to known distances', () => {
    // Colombo Fort → Galle Face ≈ 1.0 km
    expect(haversineM({ lat: 6.9344, lng: 79.8428 }, { lat: 6.9254, lng: 79.8452 })).toBeGreaterThan(950);
    expect(haversineM({ lat: 6.9344, lng: 79.8428 }, { lat: 6.9254, lng: 79.8452 })).toBeLessThan(1100);
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111_195, -2);
  });
  it('distance, speed and duration from newest-first fixes', () => {
    const s = trackStats([
      { lat: 0, lng: 0.02, fixAt: 120_000 },
      { lat: 0, lng: 0.01, fixAt: 60_000 },
      { lat: 0, lng: 0, fixAt: 0 },
    ]);
    expect(s.distanceM).toBeCloseTo(2 * 1112, -1);
    expect(s.speedKmh!).toBeCloseTo(66.7, 0);
    expect(s.durationMs).toBe(120_000);
    expect(trackStats([{ lat: 0, lng: 0, fixAt: 0 }])).toEqual({ distanceM: 0, speedKmh: null, durationMs: 0 });
  });
});
