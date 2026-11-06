/**
 * DeviceRelay — the in-browser equivalent of the per-device Durable Object.
 *
 * Holds the device's command queue, sends a push wake on enqueue, hands
 * commands to the device when it pulls, and serialises all state changes for
 * one device (a Durable Object is single-threaded; we emulate that with a
 * per-device promise chain).
 */
import type { CommandRecord, Platform, PushWake, SignedCommand } from './types';
import { randomId } from './crypto';

/** Push transport (FCM for Android, APNs for iOS). Stubbed in this build. */
export interface PushProvider {
  wake(deviceId: string, platform: Platform, pushToken: string, reason: string): Promise<void>;
}

/** Records wakes and notifies listeners — stands in for FCM/APNs. */
export class StubPushProvider implements PushProvider {
  private listeners = new Set<(deviceId: string) => void>();
  constructor(private readonly log: (w: PushWake) => void, private readonly clock: () => number) {}
  onWake(fn: (deviceId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async wake(deviceId: string, platform: Platform, _pushToken: string, reason: string): Promise<void> {
    // A wake carries NO command data — the device must pull over the authenticated channel.
    this.log({ id: randomId('wake', 8), deviceId, platform, at: this.clock(), reason });
    for (const l of this.listeners) queueMicrotask(() => l(deviceId));
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` exclusively for `key` (per-device serialisation). */
export function withDeviceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export class DeviceRelay {
  constructor(
    private readonly deviceId: string,
    private readonly queue: string[],
    private readonly commands: Map<string, CommandRecord>,
  ) {}

  enqueue(cmd: CommandRecord): void {
    if (cmd.deviceId !== this.deviceId) throw new Error('command for another device');
    if (!cmd.envelope) throw new Error('command must be signed before relay');
    if (!this.queue.includes(cmd.id)) this.queue.push(cmd.id);
    cmd.status = 'queued';
  }

  /** Device pull: returns signed envelopes; expired ones are dropped and marked. */
  pull(now: number): SignedCommand[] {
    const out: SignedCommand[] = [];
    const keep: string[] = [];
    for (const id of this.queue) {
      const cmd = this.commands.get(id);
      if (!cmd || !cmd.envelope) continue;
      if (now > cmd.envelope.payload.expiresAt) {
        cmd.status = 'expired';
        continue;
      }
      if (cmd.status === 'queued' || cmd.status === 'delivered') {
        if (cmd.status === 'queued') {
          cmd.status = 'delivered';
          cmd.deliveredAt = now;
        }
        out.push(cmd.envelope);
        keep.push(id); // stays until the device posts a result (at-least-once delivery, once-only execution on device)
      }
    }
    this.queue.splice(0, this.queue.length, ...keep);
    return out;
  }

  complete(commandId: string): void {
    const i = this.queue.indexOf(commandId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  size(): number {
    return this.queue.length;
  }
}
