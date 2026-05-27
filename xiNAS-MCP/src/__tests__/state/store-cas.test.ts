import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — CAS', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('create-only (expected_revision: 0) succeeds when key is absent', () => {
    const result = store.put('/k', { x: 1 }, { expected_revision: 0 });
    expect(result.ok).toBe(true);
  });

  it('create-only fails when key already exists', () => {
    store.put('/k', { x: 1 });
    const result = store.put('/k', { x: 2 }, { expected_revision: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_exists');
    expect(result.current?.value).toEqual({ x: 1 });
  });

  it('CAS with matching revision succeeds', () => {
    const r1 = store.put('/k', { x: 1 });
    if (!r1.ok) throw new Error('seed failed');
    const r2 = store.put('/k', { x: 2 }, { expected_revision: r1.value.revision });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.revision).toBe(2);
  });

  it('CAS with stale revision fails and returns current', () => {
    const r1 = store.put('/k', { x: 1 });
    if (!r1.ok) throw new Error('seed failed');
    store.put('/k', { x: 2 }); // bump revision to 2

    const stale = store.put('/k', { x: 3 }, { expected_revision: r1.value.revision });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe('stale_revision');
    expect(stale.current?.revision).toBe(2);
    expect(stale.current?.value).toEqual({ x: 2 });
  });

  it('CAS with expected_revision > 0 on missing key returns not_found', () => {
    const result = store.put('/k', { x: 1 }, { expected_revision: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(result.current).toBeNull();
  });
});
