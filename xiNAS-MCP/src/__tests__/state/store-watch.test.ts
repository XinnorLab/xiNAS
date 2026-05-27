import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import type { WatchEvent } from '../../state/types.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — watch', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('emits put events for keys matching the prefix', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/xinas/v1/desired/Share/', (e) => events.push(e));

    store.put('/xinas/v1/desired/Share/a', { n: 1 });
    store.put('/xinas/v1/desired/Filesystem/x', { n: 99 }); // not matching
    store.put('/xinas/v1/desired/Share/b', { n: 2 });

    handle.close();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'put', key: '/xinas/v1/desired/Share/a' });
    expect(events[1]).toMatchObject({ kind: 'put', key: '/xinas/v1/desired/Share/b' });
  });

  it('emits delete events with the prior revision', () => {
    store.put('/k', { x: 1 });
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));

    store.delete('/k');
    handle.close();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'delete', key: '/k', previous_revision: 1 });
  });

  it('does not emit events for rolled-back transactions', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));

    expect(() =>
      store.transaction((tx) => {
        tx.put('/a', { x: 1 });
        throw new Error('rollback');
      }),
    ).toThrow();

    handle.close();
    expect(events).toEqual([]);
  });

  it('close() stops further events', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));
    store.put('/a', { x: 1 });
    handle.close();
    store.put('/b', { x: 2 });
    expect(events).toHaveLength(1);
  });
});
