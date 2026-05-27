import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — list', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
    store.put('/xinas/v1/desired/Share/a', { n: 1 });
    store.put('/xinas/v1/desired/Share/b', { n: 2 });
    store.put('/xinas/v1/desired/Share/c', { n: 3 });
    store.put('/xinas/v1/desired/Filesystem/x', { n: 99 });
  });

  it('returns all rows in key order when no opts given', () => {
    const rows = store.list();
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Filesystem/x',
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });

  it('filters by prefix', () => {
    const rows = store.list({ prefix: '/xinas/v1/desired/Share/' });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });

  it('honors limit', () => {
    const rows = store.list({ prefix: '/xinas/v1/desired/Share/', limit: 2 });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
    ]);
  });

  it('honors start_after for pagination', () => {
    const rows = store.list({
      prefix: '/xinas/v1/desired/Share/',
      start_after: '/xinas/v1/desired/Share/a',
      limit: 10,
    });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });
});
