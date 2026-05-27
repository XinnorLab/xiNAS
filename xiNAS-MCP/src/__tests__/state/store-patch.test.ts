import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — patch', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('mutator receives null when key is absent', () => {
    let seen: unknown;
    const result = store.patch<{ n: number }>('/k', (current) => {
      seen = current;
      return { n: 1 };
    });
    expect(seen).toBeNull();
    expect(result.ok).toBe(true);
    expect(store.get<{ n: number }>('/k')?.value).toEqual({ n: 1 });
  });

  it('mutator receives current value and updates atomically', () => {
    store.put('/counter', { n: 5 });
    const result = store.patch<{ n: number }>('/counter', (current) => ({
      n: (current?.n ?? 0) + 1,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toEqual({ n: 6 });
    expect(result.value.revision).toBe(2);
  });

  it('rolls back if mutator throws', () => {
    store.put('/k', { n: 1 });
    expect(() =>
      store.patch('/k', () => {
        throw new Error('mutator failed');
      }),
    ).toThrow('mutator failed');
    expect(store.get('/k')?.value).toEqual({ n: 1 });
  });
});
