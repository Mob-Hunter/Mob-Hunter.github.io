import { describe, expect, it } from 'vitest';
import { DeviceRelay, StubPushProvider, withDeviceLock } from '../src/core/relay';
import { signCommand } from '../src/core/commands';
import { generateEd25519 } from '../src/core/crypto';
import type { CommandRecord, PushWake } from '../src/core/types';

async function cmd(id: string, now: number): Promise<CommandRecord> {
  const k = await generateEd25519();
  const envelope = await signCommand({ id, deviceId: 'd1', type: 'LOCK', params: {} }, { kid: 'k', secretKey: k.secretKey }, now);
  return { id, deviceId: 'd1', type: 'LOCK', params: {}, issuedBy: 'u', issuedAt: now, status: 'pending_approval', envelope };
}

describe('DeviceRelay', () => {
  it('queues, delivers until completed, then drops', async () => {
    const q: string[] = [];
    const map = new Map<string, CommandRecord>();
    const c = await cmd('c1', 0);
    map.set('c1', c);
    const r = new DeviceRelay('d1', q, map);
    r.enqueue(c);
    r.enqueue(c); // idempotent
    expect(q).toEqual(['c1']);
    expect(r.pull(1).map((e) => e.payload.id)).toEqual(['c1']);
    expect(c.status).toBe('delivered');
    expect(r.pull(2)).toHaveLength(1); // redelivered until acked
    r.complete('c1');
    expect(r.pull(3)).toHaveLength(0);
  });

  it('expires stale commands instead of delivering them', async () => {
    const q: string[] = [];
    const map = new Map<string, CommandRecord>();
    const c = await cmd('c1', 0);
    map.set('c1', c);
    const r = new DeviceRelay('d1', q, map);
    r.enqueue(c);
    expect(r.pull(11 * 60_000)).toHaveLength(0);
    expect(c.status).toBe('expired');
    expect(r.size()).toBe(0);
  });

  it('refuses unsigned or foreign commands', async () => {
    const r = new DeviceRelay('d1', [], new Map());
    const c = await cmd('c1', 0);
    expect(() => r.enqueue({ ...c, envelope: undefined })).toThrow();
    expect(() => r.enqueue({ ...c, deviceId: 'd2' })).toThrow();
  });

  it('push wake carries no command data and notifies listeners', async () => {
    const wakes: PushWake[] = [];
    const p = new StubPushProvider((w) => wakes.push(w), () => 5);
    const woken: string[] = [];
    p.onWake((d) => woken.push(d));
    await p.wake('d1', 'android', 'tok', 'LOCATE');
    await Promise.resolve();
    expect(wakes[0]).toMatchObject({ deviceId: 'd1', reason: 'LOCATE', at: 5 });
    expect(Object.keys(wakes[0])).not.toContain('payload');
    expect(woken).toEqual(['d1']);
  });

  it('serialises work per device', async () => {
    const order: number[] = [];
    const slow = withDeviceLock('x', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const fast = withDeviceLock('x', async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });
});
