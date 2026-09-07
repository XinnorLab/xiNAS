import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventJournal, MAX_PAYLOAD_BYTES } from '../../../api/events/journal.js';
import type { EventInput } from '../../../api/events/types.js';
import { runMigrations } from '../../../state/migrations.js';

const CID = '00000000-0000-0000-0000-0000000000aa';
const input = (over: Partial<EventInput> = {}): EventInput => ({
  schemaVersion: '1',
  feed: 'raid',
  type: 'raid.state.degraded',
  severity: 'error',
  detectedAt: '2026-09-04T12:00:00.000Z',
  timeAccuracy: 'observed',
  source: { kind: 'observed_transition', component: 'XiraidArray' },
  subject: { kind: 'XiraidArray', id: 'data' },
  summary: 'RAID array data: degraded',
  ...over,
});

describe('EventJournal (S17 §7)', () => {
  let db: Database.Database;
  let j: EventJournal;
  let now = 1_000_000_000_000;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    now = 1_000_000_000_000;
    j = new EventJournal(db, { controllerId: CID, now: () => now });
  });
  afterEach(() => db.close());

  it('allocates increasing sequences across feeds and fills id + controller', () => {
    const a = j.insert(input());
    const b = j.insert(input({ feed: 'nfs' }));
    expect(b.sequence).toBe(a.sequence + 1);
    expect(a.envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.envelope.controllerId).toBe(CID);
    expect(a.envelope.sequence).toBe(a.sequence);
    expect(a.deduplicated).toBe(false);
    expect(j.listAfter('raid', 0, 10)).toEqual([a.envelope]);
    expect(j.listAfter('nfs', 0, 10)).toEqual([b.envelope]);
  });

  it('stores the payload with its sequence so reads return the committed row verbatim', () => {
    const a = j.insert(input());
    const row = db
      .prepare('SELECT payload, detected_at FROM operational_events WHERE sequence = ?')
      .get(a.sequence) as { payload: string; detected_at: number };
    expect(JSON.parse(row.payload)).toEqual(a.envelope);
    expect(row.detected_at).toBe(Date.parse('2026-09-04T12:00:00.000Z'));
  });

  it('dedupes on the key without allocating a sequence', () => {
    const a = j.insert(input(), { dedupeKey: 'k' });
    const b = j.insert(input({ summary: 'retry' }), { dedupeKey: 'k' });
    expect(b.deduplicated).toBe(true);
    expect(b.sequence).toBe(a.sequence);
    expect(b.envelope).toEqual(a.envelope);
    expect(j.count()).toBe(1);
  });

  it('lists the newest N ascending and answers hasAfter', () => {
    for (let i = 0; i < 5; i++) j.insert(input({ summary: `e${i}` }));
    expect(j.listLatest('raid', 2).map((e) => e.summary)).toEqual(['e3', 'e4']);
    expect(j.listLatest('nfs', 2)).toEqual([]);
    expect(j.hasAfter('raid', 3)).toBe(true);
    expect(j.hasAfter('raid', 5)).toBe(false);
    expect(j.listAfter('raid', 3, 1).map((e) => e.summary)).toEqual(['e3']);
  });

  it('never reuses a sequence after deletes', () => {
    j.insert(input());
    j.insert(input());
    db.prepare('DELETE FROM operational_events').run();
    expect(j.bounds()).toEqual({ oldest: null, last: 2 });
    expect(j.insert(input()).sequence).toBe(3);
    expect(j.bounds()).toEqual({ oldest: 3, last: 3 });
  });

  it('retention deletes the oldest rows first, in bounded batches', () => {
    for (let i = 0; i < 12; i++) {
      now += 1000;
      j.insert(input({ detectedAt: new Date(now).toISOString() }));
    }
    const first = j.retentionSweep({ retentionDays: 30, maxRows: 5, batchRows: 2, maxBatches: 2 });
    expect(first).toEqual({ deleted: 4, exhausted: true });
    expect(j.bounds().oldest).toBe(5);
    const second = j.retentionSweep({
      retentionDays: 30,
      maxRows: 5,
      batchRows: 500,
      maxBatches: 50,
    });
    expect(second).toEqual({ deleted: 3, exhausted: false });
    expect(j.count()).toBe(5);
    expect(j.bounds().oldest).toBe(8);
  });

  it('age retention uses detected_at', () => {
    j.insert(input({ detectedAt: new Date(now - 8 * 86_400_000).toISOString() }));
    j.insert(input({ detectedAt: new Date(now).toISOString() }));
    const r = j.retentionSweep({ retentionDays: 7, maxRows: 1000, batchRows: 500, maxBatches: 50 });
    expect(r.deleted).toBe(1);
    expect(j.count()).toBe(1);
  });

  it('refuses a payload over 64 KiB instead of truncating it', () => {
    const big = { text: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    expect(() => j.insert(input({ details: big }))).toThrow(RangeError);
    expect(j.count()).toBe(0);
  });

  it('meta get/set round-trips JSON', () => {
    expect(j.metaGet('boot_id')).toBeNull();
    j.metaSet('boot_id', 'abc');
    expect(j.metaGet<string>('boot_id')).toBe('abc');
    j.metaSet('boot_id', { nested: [1, 2] });
    expect(j.metaGet('boot_id')).toEqual({ nested: [1, 2] });
    j.metaDelete('boot_id');
    expect(j.metaGet('boot_id')).toBeNull();
  });

  it('participates in an enclosing better-sqlite3 transaction', () => {
    const tx = db.transaction(() => {
      j.insert(input());
      throw new Error('boom');
    });
    expect(() => tx()).toThrow('boom');
    expect(j.count()).toBe(0);
  });
});
