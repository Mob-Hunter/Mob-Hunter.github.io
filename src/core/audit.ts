/**
 * Append-only, hash-chained audit log.
 *   hash_n = SHA-256(prev_hash || canonicalJson(payload_n))
 * Any edit, deletion or reordering of a past row breaks every later hash, and
 * `verifyChain` reports the first broken row.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson, toHex } from './crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditPayload {
  seq: number;
  at: number;
  actor: string;
  actorRole: string;
  action: string;
  target?: string;
  ticket?: string;
  detail?: Record<string, unknown>;
}

export interface AuditRow extends AuditPayload {
  prevHash: string;
  hash: string;
}

/** Synchronous so that an audit row is written atomically with the action it records. */
export function computeHash(prevHash: string, payload: AuditPayload): string {
  return toHex(sha256(new TextEncoder().encode(prevHash + canonicalJson(payload))));
}

function payloadOf(row: AuditRow): AuditPayload {
  const { prevHash: _p, hash: _h, ...payload } = row;
  return payload;
}

export class AuditLog {
  constructor(private readonly rows: AuditRow[], private readonly onAppend?: (row: AuditRow) => void) {}

  /** Read-only view; callers cannot mutate history. */
  all(): readonly AuditRow[] {
    return this.rows.map((r) => Object.freeze({ ...r }));
  }

  get head(): string {
    return this.rows.length ? this.rows[this.rows.length - 1].hash : GENESIS_HASH;
  }

  append(entry: Omit<AuditPayload, 'seq'>): AuditRow {
    const payload: AuditPayload = { ...entry, seq: this.rows.length + 1 };
    // Drop undefined so the canonical form is stable after a JSON round-trip.
    for (const k of Object.keys(payload) as (keyof AuditPayload)[]) if (payload[k] === undefined) delete payload[k];
    const prevHash = this.head;
    const hash = computeHash(prevHash, payload);
    const row: AuditRow = { ...payload, prevHash, hash };
    this.rows.push(row);
    try {
      this.onAppend?.({ ...row });
    } catch {
      /* forwarding must never break the write */
    }
    return { ...row };
  }
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: string;
  head: string;
}

export function verifyChain(rows: readonly AuditRow[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.seq !== i + 1) return { ok: false, checked: i, brokenAt: i + 1, reason: 'sequence gap or reorder', head: prev };
    if (row.prevHash !== prev) return { ok: false, checked: i, brokenAt: row.seq, reason: 'prev_hash mismatch', head: prev };
    const expected = computeHash(prev, payloadOf(row));
    if (expected !== row.hash) return { ok: false, checked: i, brokenAt: row.seq, reason: 'row content altered', head: prev };
    prev = row.hash;
  }
  return { ok: true, checked: rows.length, head: prev };
}
