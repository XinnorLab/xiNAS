import type { Database, Statement } from 'better-sqlite3';
import type { KvStore, KvTransaction } from './store.js';
import type {
  CasResult,
  DeleteResult,
  ListOptions,
  PutOptions,
  RevisionedValue,
  ValidationStatus,
  WatchEvent,
  WatchHandle,
} from './types.js';

interface KvRow {
  key: string;
  value: Buffer;
  revision: number;
  created_at: number;
  modified_at: number;
  owner: string;
  source: string;
  validation_status: ValidationStatus;
}

function rowToValue<T>(row: KvRow): RevisionedValue<T> {
  return {
    key: row.key,
    value: JSON.parse(row.value.toString('utf8')) as T,
    revision: row.revision,
    created_at: row.created_at,
    modified_at: row.modified_at,
    owner: row.owner,
    source: row.source,
    validation_status: row.validation_status,
  };
}

export class SqliteKvStore implements KvStore {
  private readonly db: Database;
  private readonly getStmt: Statement;
  private readonly putExistingStmt: Statement;
  private readonly putNewStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    this.getStmt = db.prepare('SELECT * FROM kv WHERE key = ?');
    this.putExistingStmt = db.prepare(
      `UPDATE kv
         SET value = ?, revision = revision + 1,
             modified_at = ?, owner = ?, source = ?, validation_status = ?
       WHERE key = ?`,
    );
    this.putNewStmt = db.prepare(
      `INSERT INTO kv (key, value, revision, created_at, modified_at, owner, source, validation_status)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    );
  }

  get<T = unknown>(key: string): RevisionedValue<T> | null {
    const row = this.getStmt.get(key) as KvRow | undefined;
    return row ? rowToValue<T>(row) : null;
  }

  put<T = unknown>(key: string, value: T, opts: PutOptions = {}): CasResult<T> {
    const now = Date.now();
    const owner = opts.owner ?? 'system';
    const source = opts.source ?? 'unspecified';
    const status: ValidationStatus = opts.validation_status ?? 'valid';
    const payload = Buffer.from(JSON.stringify(value), 'utf8');

    const existing = this.getStmt.get(key) as KvRow | undefined;
    if (existing) {
      this.putExistingStmt.run(payload, now, owner, source, status, key);
    } else {
      this.putNewStmt.run(key, payload, now, now, owner, source, status);
    }
    const updated = this.getStmt.get(key) as KvRow;
    return { ok: true, value: rowToValue<T>(updated) };
  }

  // Placeholders to satisfy the interface; later tasks fill these in.
  patch<T = unknown>(
    _key: string,
    _mutator: (current: T | null) => T,
    _opts?: PutOptions,
  ): CasResult<T> {
    throw new Error('patch: not implemented in SS-6');
  }
  delete(_key: string, _expected_revision?: number): DeleteResult {
    throw new Error('delete: not implemented in SS-6');
  }
  list<T = unknown>(_opts?: ListOptions): RevisionedValue<T>[] {
    throw new Error('list: not implemented in SS-6');
  }
  watch(_prefix: string, _onChange: (event: WatchEvent) => void): WatchHandle {
    throw new Error('watch: not implemented in SS-6');
  }
  transaction<R>(_fn: (tx: KvTransaction) => R): R {
    throw new Error('transaction: not implemented in SS-6');
  }
  close(): void {
    this.db.close();
  }
}
