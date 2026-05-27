import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — basic get/put', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('returns null for an unknown key', () => {
    expect(store.get('/xinas/v1/cluster')).toBeNull();
  });

  it('round-trips a value with default metadata', () => {
    const result = store.put('/xinas/v1/cluster', { mode: 'single_node' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.value).toEqual({ mode: 'single_node' });
    expect(result.value.revision).toBe(1);
    expect(result.value.owner).toBe('system');
    expect(result.value.source).toBe('unspecified');
    expect(result.value.validation_status).toBe('valid');

    const fetched = store.get<{ mode: string }>('/xinas/v1/cluster');
    expect(fetched).not.toBeNull();
    expect(fetched?.value).toEqual({ mode: 'single_node' });
    expect(fetched?.revision).toBe(1);
  });

  it('increments revision and updates modified_at on overwrite', async () => {
    const r1 = store.put('/k', { n: 1 });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Force a different ms timestamp.
    await new Promise((r) => setTimeout(r, 5));

    const r2 = store.put('/k', { n: 2 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.value.revision).toBe(2);
    expect(r2.value.modified_at).toBeGreaterThan(r1.value.modified_at);
    expect(r2.value.created_at).toBe(r1.value.created_at);
  });

  it('honors PutOptions for owner/source/validation_status', () => {
    const result = store.put(
      '/k',
      { x: 1 },
      { owner: 'admin:platonovsm', source: 'rest', validation_status: 'pending' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.owner).toBe('admin:platonovsm');
    expect(result.value.source).toBe('rest');
    expect(result.value.validation_status).toBe('pending');
  });

  it('delete returns ok:true with the deleted revision', () => {
    store.put('/k', { x: 1 });
    const result = store.delete('/k');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    expect(store.get('/k')).toBeNull();
  });

  it('delete on missing key returns ok:false / not_found', () => {
    const result = store.delete('/missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(result.current).toBeNull();
  });

  it('delete with stale expected_revision returns stale_revision', () => {
    store.put('/k', { x: 1 });
    store.put('/k', { x: 2 }); // rev 2
    const result = store.delete('/k', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_revision');
    expect(result.current?.revision).toBe(2);
    expect(store.get('/k')).not.toBeNull();
  });

  it('delete with matching expected_revision succeeds', () => {
    store.put('/k', { x: 1 });
    const result = store.delete('/k', 1);
    expect(result.ok).toBe(true);
  });
});
