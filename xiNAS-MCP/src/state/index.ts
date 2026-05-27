import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { SqliteKvStore } from './backend-sqlite.js';
import { LeaseManager } from './leases.js';
import { AuditAppender } from './audit.js';
import { AuditDrainer } from './audit-drainer.js';
import { GcSweeper } from './gc.js';
import type { KvStore } from './store.js';

export type { KvStore, KvTransaction } from './store.js';
export type {
  AuditEntry,
  AuditEntryInput,
  CasResult,
  ClientType,
  DeleteResult,
  ListOptions,
  PutOptions,
  QueuedAuditEntry,
  RevisionedValue,
  ValidationStatus,
  WatchEvent,
  WatchHandle,
} from './types.js';
// Concrete classes are exported by name for tests and for internal
// agent-side wiring. Public callers should bind to KvStore (the
// interface) via OpenedStateStore.kv to keep the Phase 2 etcd swap
// path open.
export { AuditAppender } from './audit.js';
export { AuditDrainer } from './audit-drainer.js';
export { LeaseManager } from './leases.js';
export { GcSweeper } from './gc.js';

export interface OpenStateStoreOptions {
  databasePath: string; // e.g. /var/lib/xinas/state/xinas.db
  auditJsonlPath: string; // e.g. /var/log/xinas/audit.jsonl
  nodeId: string; // controller_id used in audit genesis hash
  archiveDir?: string; // passed to GcSweeper; default per gc.ts
}

export interface OpenedStateStore {
  /**
   * KV interface, not the SqliteKvStore concrete class — Phase 2's
   * etcd backend will return a different implementation behind the
   * same OpenedStateStore type.
   */
  kv: KvStore;
  leases: LeaseManager;
  audit: AuditAppender;
  drainer: AuditDrainer;
  gc: GcSweeper;
  close(): Promise<void>;
}

/**
 * Open the state store and run startup recovery.
 *
 * Async because per ADR-0003 §Crash recovery the audit drainer's
 * recover() MUST complete before any request handler runs. Callers
 * await openStateStore() and then begin serving traffic.
 */
export async function openStateStore(opts: OpenStateStoreOptions): Promise<OpenedStateStore> {
  mkdirSync(dirname(opts.databasePath), { recursive: true });
  mkdirSync(dirname(opts.auditJsonlPath), { recursive: true });

  const db = new Database(opts.databasePath);
  runMigrations(db);

  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);
  const audit = new AuditAppender(db, opts.nodeId);
  // Wire the drainer back to the appender so notifyJsonlAdvanced()
  // keeps AuditAppender.jsonlTail fresh after every drain.
  const drainer = new AuditDrainer(db, { path: opts.auditJsonlPath, audit });
  const gc = new GcSweeper(db, opts.archiveDir ? { archiveDir: opts.archiveDir } : undefined);

  // Per ADR-0003: drain any rows left pending from a prior process
  // BEFORE returning. recover() handles both clean-restart and
  // crash-after-fsync-before-mark windows.
  await drainer.recover();

  // After recovery, if the outbox is empty (steady restart case), tail
  // -hash reload from JSONL re-seeds the chain so subsequent queue()s
  // link correctly.
  const outboxCount = db.prepare('SELECT COUNT(*) AS n FROM audit_outbox').get() as { n: number };
  if (outboxCount.n === 0) {
    audit.reloadTailHash(opts.auditJsonlPath);
  }

  return {
    kv,
    leases,
    audit,
    drainer,
    gc,
    async close() {
      await drainer.stop();
      kv.close();
    },
  };
}
