/**
 * The per-process S17 events bundle (`ApiContext.events`): the journal, the
 * transition engine with the Phase 1 producers, and the post-commit notify
 * hook the subscription registry attaches (spec §7.2). Built once by
 * `server.ts`; tests build it over an in-memory store.
 */

import type { Database } from 'better-sqlite3';
import {
  type EngineConfig,
  type EngineLog,
  type Producer,
  type TaskLookup,
  TransitionEngine,
} from './engine.js';
import { EventJournal } from './journal.js';
import { nfsProducer } from './producers/nfs.js';
import { poolProducer, raidProducer } from './producers/raid.js';
import { sessionsProducer } from './producers/sessions.js';
import { storageProducer } from './producers/storage.js';
import { systemProducer } from './producers/system.js';
import type { Feed } from './types.js';

/** Spec §10 defaults for the parts the engine reads (Task 7 derives them from config). */
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

export interface EventsContext {
  journal: EventJournal;
  engine: TransitionEngine;
  engineConfig: EngineConfig;
  /**
   * Called after a transaction that added rows commits, with the feeds that
   * gained rows. The subscription registry (S17 §5.6) installs it; absent
   * until then, and events are still journaled.
   */
  notify?: (feeds: ReadonlySet<Feed>) => void;
}

/** The Phase 1 producers, in dispatch order. */
export function defaultProducers(): Producer[] {
  return [
    raidProducer,
    poolProducer,
    storageProducer,
    nfsProducer,
    sessionsProducer,
    systemProducer,
  ];
}

export function createEventsContext(opts: {
  db: Database;
  controllerId: string;
  config?: Partial<EngineConfig>;
  now?: () => number;
  log?: EngineLog;
  taskLookup?: TaskLookup;
  producers?: Producer[];
}): EventsContext {
  const now = opts.now ?? Date.now;
  const engineConfig: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...(opts.config ?? {}) };
  const journal = new EventJournal(opts.db, { controllerId: opts.controllerId, now });
  const engine = new TransitionEngine(
    {
      journal,
      db: opts.db,
      controllerId: opts.controllerId,
      config: engineConfig,
      now,
      ...(opts.taskLookup !== undefined ? { taskLookup: opts.taskLookup } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    },
    opts.producers ?? defaultProducers(),
  );
  return { journal, engine, engineConfig };
}
