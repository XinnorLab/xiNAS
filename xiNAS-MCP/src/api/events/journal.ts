/**
 * The operational-event journal (S17 §7) over `operational_events` /
 * `operational_event_meta` (migration 007).
 *
 * Runs on the same better-sqlite3 handle the KV store uses, so an
 * `insert()` made inside `kv.transaction(...)` (the observation-ingest
 * transaction) is part of that transaction: the observed-state write and the
 * event either both commit or both roll back (spec §7.2, V-40). Outside a
 * transaction each insert is its own implicit one.
 *
 * `payload` stores the complete envelope — including the allocated
 * `sequence` — so a read returns the row exactly as committed. That needs
 * two statements (insert → learn the rowid → rewrite the payload); they are
 * wrapped in a nested `db.transaction`, which better-sqlite3 turns into a
 * savepoint when an outer transaction is open.
 */

import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { canonicalize } from '../../lib/canonical-json.js';
import type { EventEnvelope, EventInput, Feed } from './types.js';

/** One encoded event may not exceed this (spec §6.2, SUBS-EVENT-006). */
export const MAX_PAYLOAD_BYTES = 65_536;

export interface RetentionPolicy {
  retentionDays: number;
  maxRows: number;
  /** Rows per DELETE statement (each statement is its own transaction). */
  batchRows: number;
  /** Statements per sweep run; the remainder waits for the next run. */
  maxBatches: number;
}

export interface InsertResult {
  sequence: number;
  envelope: EventEnvelope;
  /** True when `dedupeKey` matched an existing row and nothing was written. */
  deduplicated: boolean;
}

const DAY_MS = 86_400_000;

export class EventJournal {
  readonly #db: Database;
  readonly #controllerId: string;
  readonly #now: () => number;
  readonly #insertStmt: Statement;
  readonly #setPayloadStmt: Statement;
  readonly #byDedupeStmt: Statement;
  readonly #afterStmt: Statement;
  readonly #latestStmt: Statement;
  readonly #hasAfterStmt: Statement;
  readonly #oldestStmt: Statement;
  readonly #lastStmt: Statement;
  readonly #countStmt: Statement;
  readonly #oldestDetectedStmt: Statement;
  readonly #deleteOlderThanStmt: Statement;
  readonly #deleteOldestStmt: Statement;
  readonly #metaGetStmt: Statement;
  readonly #metaSetStmt: Statement;
  readonly #metaDeleteStmt: Statement;
  readonly #insertTx: (input: EventInput, dedupeKey: string | undefined) => InsertResult;

  constructor(db: Database, opts: { controllerId: string; now?: () => number }) {
    this.#db = db;
    this.#controllerId = opts.controllerId;
    this.#now = opts.now ?? Date.now;
    this.#insertStmt = db.prepare(
      `INSERT INTO operational_events
         (event_id, controller_id, feed, type, severity, detected_at, occurred_at,
          subject_kind, subject_id, dedupe_key, cause_task_id, cause_operation_id, payload)
       VALUES (@event_id, @controller_id, @feed, @type, @severity, @detected_at, @occurred_at,
               @subject_kind, @subject_id, @dedupe_key, @cause_task_id, @cause_operation_id, '')`,
    );
    this.#setPayloadStmt = db.prepare(
      'UPDATE operational_events SET payload = ? WHERE sequence = ?',
    );
    this.#byDedupeStmt = db.prepare(
      'SELECT sequence, payload FROM operational_events WHERE dedupe_key = ?',
    );
    this.#afterStmt = db.prepare(
      'SELECT payload FROM operational_events WHERE feed = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
    );
    this.#latestStmt = db.prepare(
      `SELECT payload FROM (
         SELECT payload, sequence FROM operational_events WHERE feed = ? ORDER BY sequence DESC LIMIT ?
       ) ORDER BY sequence ASC`,
    );
    this.#hasAfterStmt = db.prepare(
      'SELECT 1 AS one FROM operational_events WHERE feed = ? AND sequence > ? LIMIT 1',
    );
    this.#oldestStmt = db.prepare('SELECT MIN(sequence) AS s FROM operational_events');
    this.#lastStmt = db.prepare(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'operational_events'), 0) AS s",
    );
    this.#countStmt = db.prepare('SELECT COUNT(*) AS n FROM operational_events');
    this.#oldestDetectedStmt = db.prepare('SELECT MIN(detected_at) AS t FROM operational_events');
    this.#deleteOlderThanStmt = db.prepare(
      `DELETE FROM operational_events WHERE sequence IN (
         SELECT sequence FROM operational_events WHERE detected_at < ? ORDER BY sequence ASC LIMIT ?
       )`,
    );
    this.#deleteOldestStmt = db.prepare(
      `DELETE FROM operational_events WHERE sequence IN (
         SELECT sequence FROM operational_events ORDER BY sequence ASC LIMIT ?
       )`,
    );
    this.#metaGetStmt = db.prepare('SELECT value FROM operational_event_meta WHERE key = ?');
    this.#metaSetStmt = db.prepare(
      `INSERT INTO operational_event_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.#metaDeleteStmt = db.prepare('DELETE FROM operational_event_meta WHERE key = ?');

    this.#insertTx = db.transaction((input: EventInput, dedupeKey: string | undefined) => {
      if (dedupeKey !== undefined) {
        const existing = this.#byDedupeStmt.get(dedupeKey) as
          | { sequence: number; payload: string }
          | undefined;
        if (existing !== undefined) {
          return {
            sequence: existing.sequence,
            envelope: JSON.parse(existing.payload) as EventEnvelope,
            deduplicated: true,
          };
        }
      }
      const eventId = randomUUID();
      const info = this.#insertStmt.run({
        event_id: eventId,
        controller_id: this.#controllerId,
        feed: input.feed,
        type: input.type,
        severity: input.severity,
        detected_at: Date.parse(input.detectedAt),
        occurred_at: input.occurredAt !== undefined ? Date.parse(input.occurredAt) : null,
        subject_kind: input.subject.kind,
        subject_id: input.subject.id,
        dedupe_key: dedupeKey ?? null,
        cause_task_id: input.cause?.taskId ?? null,
        cause_operation_id: input.cause?.operationId ?? null,
      });
      const sequence = Number(info.lastInsertRowid);
      const envelope: EventEnvelope = {
        ...input,
        eventId,
        sequence,
        controllerId: this.#controllerId,
      };
      const payload = canonicalize(envelope);
      if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        // Throwing inside db.transaction rolls the INSERT back (spec §6.2:
        // refuse, never truncate).
        throw new RangeError(
          `event payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${input.type} ${input.subject.kind}/${input.subject.id})`,
        );
      }
      this.#setPayloadStmt.run(payload, sequence);
      return { sequence, envelope, deduplicated: false };
    });
  }

  /** Insert one event; a matching `dedupeKey` returns the existing row instead. */
  insert(input: EventInput, opts: { dedupeKey?: string } = {}): InsertResult {
    return this.#insertTx(input, opts.dedupeKey);
  }

  /** Rows of `feed` with `sequence > afterSequence`, ascending, at most `limit`. */
  listAfter(feed: Feed, afterSequence: number, limit: number): EventEnvelope[] {
    return (this.#afterStmt.all(feed, afterSequence, limit) as { payload: string }[]).map(
      (r) => JSON.parse(r.payload) as EventEnvelope,
    );
  }

  /** The newest `limit` rows of `feed`, returned ascending. */
  listLatest(feed: Feed, limit: number): EventEnvelope[] {
    return (this.#latestStmt.all(feed, limit) as { payload: string }[]).map(
      (r) => JSON.parse(r.payload) as EventEnvelope,
    );
  }

  hasAfter(feed: Feed, sequence: number): boolean {
    return this.#hasAfterStmt.get(feed, sequence) !== undefined;
  }

  /** `oldest` retained sequence (null when empty) and the `last` allocated one. */
  bounds(): { oldest: number | null; last: number } {
    const oldest = (this.#oldestStmt.get() as { s: number | null }).s;
    const last = (this.#lastStmt.get() as { s: number }).s;
    return { oldest, last };
  }

  count(): number {
    return (this.#countStmt.get() as { n: number }).n;
  }

  /** Age in seconds of the oldest retained row, or null when empty. */
  oldestAgeSeconds(): number | null {
    const t = (this.#oldestDetectedStmt.get() as { t: number | null }).t;
    return t === null ? null : Math.max(0, Math.floor((this.#now() - t) / 1000));
  }

  /**
   * Bounded retention (spec §7.3): age first, then the row cap, oldest rows
   * first, `batchRows` per statement and at most `maxBatches` statements per
   * run. Each statement is its own short transaction so readers and writers
   * interleave; `exhausted` tells the sweeper the run hit its budget.
   */
  retentionSweep(p: RetentionPolicy): { deleted: number; exhausted: boolean } {
    let deleted = 0;
    let batches = 0;
    const cutoff = this.#now() - p.retentionDays * DAY_MS;
    while (batches < p.maxBatches) {
      const n = this.#deleteOlderThanStmt.run(cutoff, p.batchRows).changes;
      if (n === 0) break; // nothing aged out: a no-op statement spends no budget
      batches++;
      deleted += n;
      if (n < p.batchRows) break;
    }
    while (batches < p.maxBatches) {
      const excess = this.count() - p.maxRows;
      if (excess <= 0) break;
      const n = this.#deleteOldestStmt.run(Math.min(excess, p.batchRows)).changes;
      batches++;
      deleted += n;
      if (n === 0) break;
    }
    const exhausted = batches >= p.maxBatches && this.count() > p.maxRows;
    return { deleted, exhausted };
  }

  metaGet<T = unknown>(key: string): T | null {
    const row = this.#metaGetStmt.get(key) as { value: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.value) as T);
  }

  metaSet(key: string, value: unknown): void {
    this.#metaSetStmt.run(key, JSON.stringify(value), this.#now());
  }

  metaDelete(key: string): void {
    this.#metaDeleteStmt.run(key);
  }

  /** Exposed for the retention sweeper's metrics. */
  get db(): Database {
    return this.#db;
  }
}
