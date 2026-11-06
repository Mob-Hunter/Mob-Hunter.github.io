import { describe, expect, it } from 'vitest';
import { AuditLog, GENESIS_HASH, verifyChain, type AuditRow } from '../src/core/audit';

async function build(n: number) {
  const rows: AuditRow[] = [];
  const log = new AuditLog(rows);
  for (let i = 0; i < n; i++) await log.append({ at: 1000 + i, actor: 'u1', actorRole: 'SUPER_ADMIN', action: `a.${i}`, detail: { i } });
  return { rows, log };
}

describe('hash-chained audit log', () => {
  it('chains from genesis and verifies', async () => {
    const { rows } = await build(5);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    const v = await verifyChain(rows);
    expect(v).toMatchObject({ ok: true, checked: 5, head: rows[4].hash });
  });

  it('survives a JSON round-trip (persistence)', async () => {
    const { rows } = await build(3);
    expect((await verifyChain(JSON.parse(JSON.stringify(rows)))).ok).toBe(true);
  });

  it('detects an edited row', async () => {
    const { rows } = await build(5);
    rows[2] = { ...rows[2], actor: 'attacker' };
    expect(await verifyChain(rows)).toMatchObject({ ok: false, brokenAt: 3, reason: 'row content altered' });
  });

  it('detects a deleted row', async () => {
    const { rows } = await build(5);
    rows.splice(1, 1);
    expect((await verifyChain(rows)).ok).toBe(false);
  });

  it('detects re-hashing of a single row (chain break downstream)', async () => {
    const { rows } = await build(4);
    const { computeHash } = await import('../src/core/audit');
    const { prevHash: _p, hash: _h, ...payload } = rows[1];
    const forged = { ...payload, action: 'forged' };
    rows[1] = { ...forged, prevHash: rows[0].hash, hash: await computeHash(rows[0].hash, forged) };
    expect(await verifyChain(rows)).toMatchObject({ ok: false, brokenAt: 3, reason: 'prev_hash mismatch' });
  });

  it('all() returns frozen copies', async () => {
    const { log, rows } = await build(1);
    const view = log.all();
    expect(() => {
      (view[0] as AuditRow).actor = 'x';
    }).toThrow();
    expect(rows[0].actor).toBe('u1');
  });
});
