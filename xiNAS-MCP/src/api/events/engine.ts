/**
 * The transition engine (S17 §8.0): runs the per-kind producers inside the
 * observation-ingest transaction and writes what they emit to the journal
 * in the same transaction, so an event can never point at state that
 * rolled back (spec §7.2).
 *
 * Batch lifecycle, driven by `api/internal/observed.ts`:
 *
 *   begin(batch)                  once per observation batch
 *   onChange(...)                 per applied delta and per reconcile delete
 *   onSnapshot(kind, presentIds)  per kind in complete_snapshots
 *   commit()                      inserts the collected events; returns feeds
 *
 * Two batch-level rules live here rather than in every producer:
 *   - baseline (SUBS-GEN-001): an event emitted for a first observation
 *     (`previous === null`) is dropped unless its type is one of the
 *     enumerated baseline exceptions;
 *   - a producer bug (off-schema details) is logged and skipped, never
 *     allowed to fail the observation batch. A journal write failure
 *     (disk full) does propagate — the agent retries the batch.
 *
 * Heartbeat- and inventory-derived events use `emitDirect()` outside a
 * batch: one row, its own transaction.
 */

import type { Database, Statement } from 'better-sqlite3';
import type { Kind } from '../../agent/collectors/base.js';
import { type EventSpec, buildEvent } from './envelope.js';
import type { EventJournal } from './journal.js';
import { META_KEYS, MetaStore } from './meta.js';
import type { Feed } from './types.js';

export type Row = Record<string, unknown>;

/** The subset of KvTransaction producers read through (transaction-snapshot reads). */
export interface EngineKv {
  get<T = unknown>(key: string): { key: string; value: T; revision: number } | null;
  list<T = unknown>(opts?: { prefix?: string }): Array<{ key: string; value: T; revision: number }>;
}

export interface EngineConfig {
  progress: { bucket_pct: number; min_interval_s: number; max_silence_s: number };
  capacity: {
    warning_enter: number;
    warning_clear: number;
    critical_enter: number;
    critical_clear: number;
    per_filesystem: Record<
      string,
      Partial<{
        warning_enter: number;
        warning_clear: number;
        critical_enter: number;
        critical_clear: number;
      }>
    >;
  };
  nfs_lock_threshold: { enter: number; clear: number };
  /** `stale` after this many poll intervals without an accepted batch. */
  staleness_multiplier: number;
}

export interface Cause {
  taskId: string;
  operationId?: string;
}
/**
 * Durable task correlation (S4 amendment): kinds + subject identity, never
 * timing. `states` defaults to `['running', 'success']`; `filesystem.mount.failed`
 * asks for `['failed']`.
 */
export type TaskLookup = (
  kinds: string[],
  subject: { kind: string; id: string },
  states?: string[],
) => Cause | null;

export type EngineLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface EngineDeps {
  journal: EventJournal;
  db: Database;
  controllerId: string;
  config: EngineConfig;
  now: () => number;
  taskLookup?: TaskLookup;
  log?: EngineLog;
}

/** What a producer emits; the engine fills `detectedAtMs` and defaults `source`. */
export type EmitSpec = Omit<EventSpec, 'detectedAtMs' | 'source'> & {
  source?: EventSpec['source'];
  dedupeKey?: string;
};
export type Emit = (spec: EmitSpec) => void;

export interface BatchInfo {
  observedAt: string;
  completeSnapshots: ReadonlySet<Kind>;
  detectedAtMs: number;
  /** Monotonic per engine instance; lets a producer tell "a later batch" apart. */
  seq: number;
}

interface CommonCtx {
  batch: BatchInfo;
  kv: EngineKv;
  meta: MetaStore;
  emit: Emit;
  config: EngineConfig;
  controllerId: string;
  log: EngineLog;
  correlate(
    kinds: string[],
    subject?: { kind: string; id: string },
    states?: string[],
  ): Cause | undefined;
  /** Whether `kind` had a complete snapshot before this batch started. */
  baselineDone(kind: Kind): boolean;
}

export interface ChangeCtx extends CommonCtx {
  kind: Kind;
  id: string;
  previous: Row | null;
  current: Row | null;
  previousRevision: number | null;
}

export interface SnapshotCtx extends CommonCtx {
  kind: Kind;
  present: ReadonlySet<string>;
}

/** The kinds an accepted observation batch carried (spec §8.6 freshness). */
export interface AcceptedCtx extends CommonCtx {
  kinds: readonly Kind[];
}

export interface Producer {
  readonly kinds: readonly Kind[];
  onChange?(ctx: ChangeCtx): void;
  onSnapshot?(ctx: SnapshotCtx): void;
  /** Every producer that opts in sees every accepted batch, whatever its kinds. */
  onAccepted?(ctx: AcceptedCtx): void;
}

/** Types a producer may emit for a first observation (spec §8.0). */
const BASELINE_ALLOWED: ReadonlySet<string> = new Set([
  'raid.operation.observed_running',
  'raid.state.offline',
  'raid.state.unrecovered',
  'raid.source.unknown_state',
  'raid.array.created',
  'filesystem.capacity.warning',
  'filesystem.capacity.critical',
  'filesystem.definition.added',
  'nfs.export.added',
  'nfs.session.connected',
  'system.reboot.detected',
]);

interface PendingEvent {
  spec: EmitSpec;
  firstObservation: boolean;
}

interface Batch {
  info: BatchInfo;
  kv: EngineKv;
  pending: PendingEvent[];
  snapshotKinds: Set<Kind>;
}

const noopLog: EngineLog = () => {};

export class TransitionEngine {
  readonly #deps: EngineDeps;
  readonly #producers: Producer[];
  readonly #meta: MetaStore;
  readonly #log: EngineLog;
  #baseline = new Map<Kind, boolean>();
  #batch: Batch | null = null;
  #seq = 0;

  constructor(deps: EngineDeps, producers: Producer[] = []) {
    this.#deps = deps;
    this.#producers = producers;
    this.#meta = new MetaStore(deps.journal);
    this.#log = deps.log ?? noopLog;
  }

  get meta(): MetaStore {
    return this.#meta;
  }

  get config(): EngineConfig {
    return this.#deps.config;
  }

  /** Whether `kind` has had a complete snapshot (as of the last commit). */
  baselineDone(kind: Kind): boolean {
    const cached = this.#baseline.get(kind);
    if (cached !== undefined) return cached;
    const v = this.#meta.get<boolean>(META_KEYS.baselineDone(kind)) === true;
    this.#baseline.set(kind, v);
    return v;
  }

  begin(batch: { observedAt: string; completeSnapshots: readonly Kind[]; kv: EngineKv }): void {
    this.#batch = {
      info: {
        observedAt: batch.observedAt,
        completeSnapshots: new Set(batch.completeSnapshots),
        detectedAtMs: this.#deps.now(),
        seq: ++this.#seq,
      },
      kv: batch.kv,
      pending: [],
      snapshotKinds: new Set(),
    };
  }

  onChange(c: {
    kind: Kind;
    id: string;
    previous: Row | null;
    current: Row | null;
    previousRevision: number | null;
  }): void {
    const batch = this.#requireBatch();
    const ctx: ChangeCtx = {
      ...this.#common(batch, c.previous === null, { kind: c.kind, id: c.id }),
      kind: c.kind,
      id: c.id,
      previous: c.previous,
      current: c.current,
      previousRevision: c.previousRevision,
    };
    for (const p of this.#producers) {
      if (p.onChange === undefined || !p.kinds.includes(c.kind)) continue;
      try {
        p.onChange(ctx);
      } catch (err) {
        this.#log('error', 'event_producer_failed', {
          kind: c.kind,
          id: c.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  onSnapshot(kind: Kind, present: ReadonlySet<string>): void {
    const batch = this.#requireBatch();
    batch.snapshotKinds.add(kind);
    const ctx: SnapshotCtx = { ...this.#common(batch, false), kind, present };
    for (const p of this.#producers) {
      if (p.onSnapshot === undefined || !p.kinds.includes(kind)) continue;
      try {
        p.onSnapshot(ctx);
      } catch (err) {
        this.#log('error', 'event_producer_failed', {
          kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Record that the open batch carried `kinds` (the per-kind freshness stamp,
   * D-24) and let producers react (a stale collector recovers here).
   */
  markAccepted(kinds: readonly Kind[]): void {
    const batch = this.#requireBatch();
    if (kinds.length === 0) return;
    const ctx: AcceptedCtx = { ...this.#common(batch, false), kinds };
    for (const p of this.#producers) {
      if (p.onAccepted === undefined) continue;
      try {
        p.onAccepted(ctx);
      } catch (err) {
        this.#log('error', 'event_producer_failed', {
          hook: 'onAccepted',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Insert the batch's events; returns the feeds that gained rows. Idempotent. */
  commit(): { feeds: Set<Feed>; count: number } {
    const batch = this.#batch;
    const feeds = new Set<Feed>();
    let count = 0;
    if (batch === null) return { feeds, count };
    this.#batch = null;
    for (const { spec } of batch.pending) {
      if (this.#insert(spec, batch.info.detectedAtMs)) {
        feeds.add(spec.feed);
        count++;
      }
    }
    for (const kind of batch.snapshotKinds) {
      if (!this.baselineDone(kind)) {
        this.#meta.set(META_KEYS.baselineDone(kind), true);
      }
      this.#baseline.set(kind, true);
    }
    return { feeds, count };
  }

  /** One event outside a batch (heartbeat, inventory): its own transaction. */
  emitDirect(spec: EmitSpec): { feeds: Set<Feed> } {
    const feeds = new Set<Feed>();
    if (this.#insert(spec, this.#deps.now())) feeds.add(spec.feed);
    return { feeds };
  }

  #insert(spec: EmitSpec, detectedAtMs: number): boolean {
    const { dedupeKey, source, ...rest } = spec;
    let input: ReturnType<typeof buildEvent>;
    try {
      input = buildEvent({
        ...rest,
        detectedAtMs,
        source: source ?? { kind: 'observed_transition', component: spec.subject.kind },
      });
    } catch (err) {
      // A producer bug (unknown type / off-schema details) must not fail
      // the observation batch; it is logged and the event is skipped.
      this.#log('error', 'event_build_failed', {
        type: spec.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    const r = this.#deps.journal.insert(input, dedupeKey !== undefined ? { dedupeKey } : {});
    return !r.deduplicated;
  }

  #common(
    batch: Batch,
    firstObservation: boolean,
    defaultSubject?: { kind: string; id: string },
  ): CommonCtx {
    const emit: Emit = (spec) => {
      if (firstObservation && !BASELINE_ALLOWED.has(spec.type)) {
        this.#log('warn', 'event_dropped_baseline', {
          type: spec.type,
          subject: spec.subject,
          reason: 'first observation is a baseline, not a transition',
        });
        return;
      }
      batch.pending.push({ spec, firstObservation });
    };
    return {
      batch: batch.info,
      kv: batch.kv,
      meta: this.#meta,
      emit,
      config: this.#deps.config,
      controllerId: this.#deps.controllerId,
      log: this.#log,
      correlate: (kinds, subject, states) => {
        const target = subject ?? defaultSubject;
        if (this.#deps.taskLookup === undefined || target === undefined) return undefined;
        return this.#deps.taskLookup(kinds, target, states) ?? undefined;
      },
      baselineDone: (kind) => this.baselineDone(kind),
    };
  }

  #requireBatch(): Batch {
    if (this.#batch === null) throw new Error('TransitionEngine: no batch is open (call begin())');
    return this.#batch;
  }
}

/** The recency window a correlated task must fall in (matches journal retention). */
const TASK_LOOKUP_WINDOW_MS = 7 * 86_400_000;

/**
 * The production TaskLookup over the `tasks` table (S4 amendment): a task
 * correlates only when its kind is one of the operation kinds that can
 * produce the transition AND its persisted `affected_resources` names the
 * event subject, in state `running` or `success`. Timing proximity alone
 * never links; the recency window only keeps an ancient task from matching.
 */
export function createTaskLookup(db: Database, now: () => number = Date.now): TaskLookup {
  const byCount = new Map<string, Statement>();
  return (kinds, subject, states = ['running', 'success']) => {
    if (kinds.length === 0 || states.length === 0) return null;
    const cacheKey = `${kinds.length}:${states.length}`;
    let stmt = byCount.get(cacheKey);
    if (stmt === undefined) {
      const placeholders = kinds.map(() => '?').join(', ');
      const statePlaceholders = states.map(() => '?').join(', ');
      stmt = db.prepare(
        `SELECT task_id, correlation_id FROM tasks
         WHERE kind IN (${placeholders})
           AND state IN (${statePlaceholders})
           AND updated_at >= ?
           AND EXISTS (
             SELECT 1 FROM json_each(tasks.affected_resources) AS r
             WHERE json_extract(r.value, '$.kind') = ? AND json_extract(r.value, '$.id') = ?
           )
         ORDER BY updated_at DESC LIMIT 1`,
      );
      byCount.set(cacheKey, stmt);
    }
    const row = stmt.get(
      ...kinds,
      ...states,
      now() - TASK_LOOKUP_WINDOW_MS,
      subject.kind,
      subject.id,
    ) as { task_id: string; correlation_id: string } | undefined;
    if (row === undefined) return null;
    return { taskId: row.task_id, operationId: row.correlation_id };
  };
}
