/**
 * Shared harness for the transition-engine and producer tests: a real
 * EventJournal on an in-memory SQLite, a real TransitionEngine, and a tiny
 * in-memory stand-in for the KvTransaction reads producers make
 * (`get` / `list` by prefix). Every `step()` runs one observation batch
 * inside a db.transaction exactly as the observed handler does.
 */
import Database from 'better-sqlite3';
import type { Kind } from '../../../agent/collectors/base.js';
import { observedSegment } from '../../../agent/collectors/base.js';
import {
  type EngineConfig,
  type EngineKv,
  type Producer,
  type TaskLookup,
  TransitionEngine,
} from '../../../api/events/engine.js';
import { EventJournal } from '../../../api/events/journal.js';
import type { EventEnvelope } from '../../../api/events/types.js';
import { runMigrations } from '../../../state/migrations.js';

export const CID = '00000000-0000-0000-0000-0000000000aa';
export const OBSERVED_AT = '2026-09-04T12:00:00.000Z';

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  progress: { bucket_pct: 10, min_interval_s: 30, max_silence_s: 600 },
  capacity: {
    warning_enter: 80,
    warning_clear: 75,
    critical_enter: 90,
    critical_clear: 85,
    per_filesystem: {},
  },
  nfs_lock_threshold: { enter: 0, clear: 0 },
  staleness_multiplier: 3,
};

export type Row = Record<string, unknown>;

export class FakeKv implements EngineKv {
  readonly rows = new Map<string, { value: Row; revision: number }>();
  put(kind: Kind, id: string, value: Row, revision = 1): void {
    this.rows.set(`/xinas/v1/observed/${observedSegment(kind)}/${id}`, { value, revision });
  }
  putKey(key: string, value: Row, revision = 1): void {
    this.rows.set(key, { value, revision });
  }
  remove(kind: Kind, id: string): void {
    this.rows.delete(`/xinas/v1/observed/${observedSegment(kind)}/${id}`);
  }
  get<T = unknown>(key: string): { key: string; value: T; revision: number } | null {
    const r = this.rows.get(key);
    return r === undefined ? null : { key, value: r.value as T, revision: r.revision };
  }
  list<T = unknown>(opts?: { prefix?: string }): Array<{
    key: string;
    value: T;
    revision: number;
  }> {
    const out: Array<{ key: string; value: T; revision: number }> = [];
    for (const [key, r] of this.rows) {
      if (opts?.prefix === undefined || key.startsWith(opts.prefix)) {
        out.push({ key, value: r.value as T, revision: r.revision });
      }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}

export interface Harness {
  db: Database.Database;
  journal: EventJournal;
  engine: TransitionEngine;
  kv: FakeKv;
  clock: { now: number };
  /** Apply one change inside a batch and return the events it produced. */
  step(
    kind: Kind,
    id: string,
    previous: Row | null,
    current: Row | null,
    opts?: { completeSnapshots?: Kind[]; present?: string[] },
  ): EventEnvelope[];
  /** Run a batch with only a complete snapshot (no deltas). */
  snapshot(kind: Kind, present: string[]): EventEnvelope[];
  /** Run an arbitrary batch body. */
  batch(
    body: (engine: TransitionEngine) => void,
    opts?: { completeSnapshots?: Kind[] },
  ): EventEnvelope[];
  close(): void;
}

export function makeHarness(opts: {
  producers: Producer[];
  config?: Partial<EngineConfig>;
  taskLookup?: TaskLookup;
  log?: (level: string, msg: string, fields?: Record<string, unknown>) => void;
}): Harness {
  const db = new Database(':memory:');
  runMigrations(db);
  const clock = { now: Date.parse(OBSERVED_AT) };
  const journal = new EventJournal(db, { controllerId: CID, now: () => clock.now });
  const kv = new FakeKv();
  const engine = new TransitionEngine(
    {
      journal,
      db,
      controllerId: CID,
      config: { ...DEFAULT_ENGINE_CONFIG, ...(opts.config ?? {}) },
      now: () => clock.now,
      ...(opts.taskLookup !== undefined ? { taskLookup: opts.taskLookup } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    },
    opts.producers,
  );
  let lastSeen = 0;
  const drain = (): EventEnvelope[] => {
    const out: EventEnvelope[] = [];
    for (const feed of [
      'raid',
      'raid/progress',
      'storage',
      'nfs',
      'nfs/sessions',
      'system',
    ] as const) {
      out.push(...journal.listAfter(feed, lastSeen, 1000));
    }
    out.sort((a, b) => a.sequence - b.sequence);
    if (out.length > 0) lastSeen = out[out.length - 1]?.sequence ?? lastSeen;
    return out;
  };
  const batch: Harness['batch'] = (body, o) => {
    const tx = db.transaction(() => {
      engine.begin({
        observedAt: new Date(clock.now).toISOString(),
        completeSnapshots: o?.completeSnapshots ?? [],
        kv,
      });
      body(engine);
      engine.commit();
    });
    tx();
    return drain();
  };
  return {
    db,
    journal,
    engine,
    kv,
    clock,
    step: (kind, id, previous, current, o) =>
      batch(
        (e) => {
          // The observed handler writes the row before the engine sees it,
          // so reads through kv return the current value (or nothing).
          if (current === null) kv.remove(kind, id);
          else kv.put(kind, id, current);
          e.onChange({
            kind,
            id,
            previous,
            current,
            previousRevision: previous === null ? null : 1,
          });
          if (o?.present !== undefined) e.onSnapshot(kind, new Set(o.present));
        },
        { completeSnapshots: o?.completeSnapshots ?? (o?.present !== undefined ? [kind] : []) },
      ),
    snapshot: (kind, present) =>
      batch((e) => e.onSnapshot(kind, new Set(present)), { completeSnapshots: [kind] }),
    batch,
    close: () => db.close(),
  };
}

export const types = (events: EventEnvelope[]): string[] => events.map((e) => e.type);
