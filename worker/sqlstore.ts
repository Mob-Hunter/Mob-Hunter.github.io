/**
 * Store backed by the Durable Object's SQLite database.
 * - The audit log is append-only in its own table (one row per entry, never updated).
 * - The rest of the state is saved as JSON split into 512 KiB chunks so it is
 *   not limited by SQLite's maximum value size.
 * Everything is synchronous, which the DO SQL API guarantees to be transactional
 * with respect to the request that issued it.
 */
import type { Store } from '../src/core/backend';
import type { AuditRow } from '../src/core/audit';
import type { BackendState } from '../src/core/types';

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const CHUNK = 512 * 1024;

export class SqlStore implements Store {
  private savedAuditSeq = 0;

  constructor(private readonly sql: SqlLike) {
    sql.exec('CREATE TABLE IF NOT EXISTS state_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, row TEXT NOT NULL)');
    const r = sql.exec('SELECT MAX(seq) AS m FROM audit').toArray()[0];
    this.savedAuditSeq = Number(r?.m ?? 0);
  }

  load(): BackendState | null {
    const chunks = this.sql.exec('SELECT data FROM state_chunks ORDER BY idx').toArray();
    if (!chunks.length) return null;
    const state = JSON.parse(chunks.map((c) => String(c.data)).join('')) as BackendState;
    state.audit = this.sql.exec('SELECT row FROM audit ORDER BY seq').toArray().map((r) => JSON.parse(String(r.row)) as AuditRow);
    return state;
  }

  save(state: BackendState): void {
    for (const row of state.audit) {
      if (row.seq > this.savedAuditSeq) {
        this.sql.exec('INSERT INTO audit (seq, row) VALUES (?, ?)', row.seq, JSON.stringify(row));
        this.savedAuditSeq = row.seq;
      }
    }
    const json = JSON.stringify({ ...state, audit: [] });
    const n = Math.max(1, Math.ceil(json.length / CHUNK));
    for (let i = 0; i < n; i++) this.sql.exec('INSERT OR REPLACE INTO state_chunks (idx, data) VALUES (?, ?)', i, json.slice(i * CHUNK, (i + 1) * CHUNK));
    this.sql.exec('DELETE FROM state_chunks WHERE idx >= ?', n);
  }

  clear(): void {
    this.sql.exec('DELETE FROM state_chunks');
    this.sql.exec('DELETE FROM audit');
    this.savedAuditSeq = 0;
  }
}
