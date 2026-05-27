import type {
  CasResult,
  DeleteResult,
  ListOptions,
  PutOptions,
  RevisionedValue,
  WatchEvent,
  WatchHandle,
} from './types.js';

/**
 * KV store interface. Implementations exist for SQLite today (the
 * Phase 0 backend) and may exist for etcd in Phase 2 — call sites bind
 * to this type, not to any backend-specific module.
 *
 * Method semantics:
 *   - get/list: latest committed value(s); read-your-writes from
 *     within an open transaction.
 *   - put: writes value; if expected_revision is given, fails with
 *     CAS result when the current revision differs.
 *   - patch: read-modify-write inside an implicit transaction; the
 *     mutator receives the current value and returns the new one.
 *     Retries are NOT automatic — caller decides on stale_revision.
 *   - delete: removes the key; optional CAS via expected_revision.
 *   - watch: in-process event stream for the given prefix; events
 *     fire after the underlying transaction commits.
 *   - transaction: opens a synchronous transaction; the callback sees
 *     read-your-writes; commits on normal return, rolls back on throw.
 */
export interface KvStore {
  get<T = unknown>(key: string): RevisionedValue<T> | null;

  put<T = unknown>(key: string, value: T, opts?: PutOptions): CasResult<T>;

  patch<T = unknown>(
    key: string,
    mutator: (current: T | null) => T,
    opts?: PutOptions,
  ): CasResult<T>;

  delete(key: string, expected_revision?: number): DeleteResult;

  list<T = unknown>(opts?: ListOptions): RevisionedValue<T>[];

  watch(prefix: string, onChange: (event: WatchEvent) => void): WatchHandle;

  transaction<R>(fn: (tx: KvTransaction) => R): R;

  close(): void;
}

/**
 * Subset of KvStore available inside a transaction callback. Reads
 * see uncommitted writes from the same transaction; writes are
 * staged and only become visible to other readers on commit.
 */
export interface KvTransaction {
  get<T = unknown>(key: string): RevisionedValue<T> | null;

  put<T = unknown>(key: string, value: T, opts?: PutOptions): CasResult<T>;

  delete(key: string, expected_revision?: number): DeleteResult;
}
