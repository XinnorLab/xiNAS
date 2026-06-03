import { EventEmitter } from 'node:events';
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
  private readonly putCasStmt: Statement;
  private readonly deleteStmt: Statement;
  private readonly deleteCasStmt: Statement;
  private readonly emitter = new EventEmitter();
  private txBuffer: WatchEvent[] | null = null;

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
    this.putCasStmt = db.prepare(
      `UPDATE kv
         SET value = ?, revision = revision + 1,
             modified_at = ?, owner = ?, source = ?, validation_status = ?
       WHERE key = ? AND revision = ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM kv WHERE key = ?');
    this.deleteCasStmt = db.prepare('DELETE FROM kv WHERE key = ? AND revision = ?');
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

    // Last-writer-wins (no CAS): UPSERT-style.
    if (opts.expected_revision === undefined) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (existing) {
        this.putExistingStmt.run(payload, now, owner, source, status, key);
      } else {
        this.putNewStmt.run(key, payload, now, now, owner, source, status);
      }
      const updated = this.getStmt.get(key) as KvRow;
      this.fireEvent({ kind: 'put', key, value: rowToValue(updated) });
      return { ok: true, value: rowToValue<T>(updated) };
    }

    // Create-only: try INSERT; UNIQUE conflict = already_exists.
    if (opts.expected_revision === 0) {
      try {
        this.putNewStmt.run(key, payload, now, now, owner, source, status);
      } catch (err) {
        if (String(err).includes('UNIQUE')) {
          const existing = this.getStmt.get(key) as KvRow;
          return { ok: false, reason: 'already_exists', current: rowToValue<T>(existing) };
        }
        throw err;
      }
      const inserted = this.getStmt.get(key) as KvRow;
      this.fireEvent({ kind: 'put', key, value: rowToValue(inserted) });
      return { ok: true, value: rowToValue<T>(inserted) };
    }

    // CAS: UPDATE ... WHERE revision = ?. 0 changes = stale or missing.
    const info = this.putCasStmt.run(
      payload,
      now,
      owner,
      source,
      status,
      key,
      opts.expected_revision,
    );
    if (info.changes === 0) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      return { ok: false, reason: 'stale_revision', current: rowToValue<T>(existing) };
    }
    const updated = this.getStmt.get(key) as KvRow;
    this.fireEvent({ kind: 'put', key, value: rowToValue(updated) });
    return { ok: true, value: rowToValue<T>(updated) };
  }

  // Placeholders to satisfy the interface; later tasks fill these in.
  patch<T = unknown>(
    key: string,
    mutator: (current: T | null) => T,
    opts: PutOptions = {},
  ): CasResult<T> {
    return this.transaction((tx) => {
      const current = tx.get<T>(key);
      const next = mutator(current?.value ?? null);
      return tx.put<T>(key, next, opts);
    });
  }
  delete(key: string, expected_revision?: number): DeleteResult {
    if (expected_revision === undefined) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      this.deleteStmt.run(key);
      this.fireEvent({ kind: 'delete', key, previous_revision: existing.revision });
      return { ok: true, revision: existing.revision };
    }
    const info = this.deleteCasStmt.run(key, expected_revision);
    if (info.changes === 0) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      return { ok: false, reason: 'stale_revision', current: rowToValue(existing) };
    }
    this.fireEvent({ kind: 'delete', key, previous_revision: expected_revision });
    return { ok: true, revision: expected_revision };
  }
  list<T = unknown>(opts: ListOptions = {}): RevisionedValue<T>[] {
    const prefix = opts.prefix ?? '';
    const limit = opts.limit ?? 1000;
    const startAfter = opts.start_after ?? '';

    const params: (string | number)[] = [];
    const clauses: string[] = ['1=1'];

    if (prefix) {
      // ESCAPE attaches to the LIKE expression, not the trailing
      // ORDER BY clause. The pattern itself escapes %, _, \.
      clauses.push("key LIKE ? ESCAPE '\\'");
      params.push(`${prefix.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (startAfter) {
      clauses.push('key > ?');
      params.push(startAfter);
    }

    const sql = `SELECT * FROM kv WHERE ${clauses.join(' AND ')} ORDER BY key ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as KvRow[];
    return rows.map((row) => rowToValue<T>(row));
  }
  watch(prefix: string, onChange: (event: WatchEvent) => void): WatchHandle {
    const listener = (event: WatchEvent) => {
      if (event.key.startsWith(prefix)) onChange(event);
    };
    this.emitter.on('event', listener);
    return {
      close: () => {
        this.emitter.off('event', listener);
      },
    };
  }

  private fireEvent(event: WatchEvent): void {
    if (this.txBuffer !== null) {
      this.txBuffer.push(event);
    } else {
      this.emitter.emit('event', event);
    }
  }
  transaction<R>(fn: (tx: KvTransaction) => R): R {
    const txFacade: KvTransaction = {
      get: (key) => this.get(key),
      put: (key, value, opts) => this.put(key, value, opts),
      delete: (key, expected_revision) => this.delete(key, expected_revision),
      list: (opts) => this.list(opts),
    };
    this.txBuffer = [];
    const run = this.db.transaction(() => fn(txFacade));
    try {
      const result = run();
      // Commit succeeded → flush buffered events.
      const buffer = this.txBuffer;
      this.txBuffer = null;
      for (const e of buffer) this.emitter.emit('event', e);
      return result;
    } catch (err) {
      // Rollback → drop buffer.
      this.txBuffer = null;
      throw err;
    }
  }
  close(): void {
    this.db.close();
  }
}
