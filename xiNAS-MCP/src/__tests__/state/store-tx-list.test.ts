import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore, type OpenedStateStore } from '../../state/index.js';

describe('KvTransaction.list — atomic prefix scan inside a transaction', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-tx-list-'));
    state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: '00000000-0000-0000-0000-0000000000aa',
    });
  });
  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists keys under a prefix from within a transaction', () => {
    state.kv.put('/test/Kind/a', { v: 1 });
    state.kv.put('/test/Kind/b', { v: 2 });
    state.kv.put('/test/Other/c', { v: 3 });
    const result = state.kv.transaction((tx) =>
      tx.list<{ v: number }>({ prefix: '/test/Kind/' }).map((r) => r.value),
    );
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ v: 1 });
    expect(result).toContainEqual({ v: 2 });
  });

  it('reconcile pattern: list-then-delete-leftovers-by-key inside one tx', () => {
    state.kv.put('/test/Kind/a', { v: 'old' });
    state.kv.put('/test/Kind/b', { v: 'old' });
    state.kv.put('/test/Kind/c', { v: 'old' });
    // New authoritative snapshot is {a, b}; c must be deleted by the reconcile.
    const keep = new Set(['/test/Kind/a', '/test/Kind/b']);
    state.kv.transaction((tx) => {
      tx.put('/test/Kind/a', { v: 'new' });
      tx.put('/test/Kind/b', { v: 'new' });
      for (const row of tx.list<{ v: string }>({ prefix: '/test/Kind/' })) {
        if (!keep.has(row.key)) tx.delete(row.key);
      }
    });
    const after = state.kv.list<{ v: string }>({ prefix: '/test/Kind/' });
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.key).sort()).toEqual(['/test/Kind/a', '/test/Kind/b']);
    expect(after.every((r) => r.value.v === 'new')).toBe(true);
  });
});
