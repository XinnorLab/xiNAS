import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — transaction', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('commits multiple writes atomically', () => {
    store.transaction((tx) => {
      tx.put('/a', { x: 1 });
      tx.put('/b', { x: 2 });
    });
    expect(store.get('/a')?.value).toEqual({ x: 1 });
    expect(store.get('/b')?.value).toEqual({ x: 2 });
  });

  it('rolls back all writes when callback throws', () => {
    expect(() =>
      store.transaction((tx) => {
        tx.put('/a', { x: 1 });
        tx.put('/b', { x: 2 });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(store.get('/a')).toBeNull();
    expect(store.get('/b')).toBeNull();
  });

  it('callback sees read-your-writes', () => {
    store.transaction((tx) => {
      const r = tx.put('/a', { x: 1 });
      expect(r.ok).toBe(true);
      const fetched = tx.get<{ x: number }>('/a');
      expect(fetched?.value).toEqual({ x: 1 });
    });
  });

  it('returns the callback return value', () => {
    const result = store.transaction(() => 42);
    expect(result).toBe(42);
  });
});
