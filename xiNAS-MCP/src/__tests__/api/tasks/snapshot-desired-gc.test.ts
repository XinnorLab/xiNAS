import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStateStore } from '../../../state/index.js';
import {
  SNAPSHOT_DESIRED_PREFIX,
  gcSnapshotDesired,
  snapshotDesiredKey,
} from '../../../api/tasks/snapshot-desired.js';
import type { OpenedStateStore } from '../../../state/index.js';

let tmpDir: string;
let store: OpenedStateStore;

async function mkStore(): Promise<OpenedStateStore> {
  tmpDir = mkdtempSync(join(tmpdir(), 'xinas-snap-desired-gc-'));
  return openStateStore({
    databasePath: join(tmpDir, 'xinas.db'),
    auditJsonlPath: join(tmpDir, 'audit.jsonl'),
    nodeId: 'n1',
  });
}

describe('gcSnapshotDesired', () => {
  beforeEach(async () => {
    store = await mkStore();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes snapshot-desired entries with no matching observed ConfigSnapshot row', () => {
    // Seed an observed ConfigSnapshot row for id 'a' (value carries .id like
    // observed rows for this kind; confirmed by config-rollback.ts r.value.id).
    store.kv.put('/xinas/v1/observed/ConfigSnapshot/a', { id: 'a', status: { kind: 'after' } });

    // Two snapshot-desired payloads: 'a' has an observed row, 'b' does not.
    store.kv.put(snapshotDesiredKey('a'), { snapshot_id: 'a', kinds: {} });
    store.kv.put(snapshotDesiredKey('b'), { snapshot_id: 'b', kinds: {} });

    const pruned = gcSnapshotDesired(store.kv);

    expect(pruned).toEqual(['b']);
    expect(store.kv.get(snapshotDesiredKey('a'))).not.toBeNull();
    expect(store.kv.get(snapshotDesiredKey('b'))).toBeNull();
  });

  it('prunes all payloads when there are no observed ConfigSnapshot rows', () => {
    store.kv.put(snapshotDesiredKey('x'), { snapshot_id: 'x', kinds: {} });
    store.kv.put(snapshotDesiredKey('y'), { snapshot_id: 'y', kinds: {} });

    const pruned = gcSnapshotDesired(store.kv);

    expect(pruned.sort()).toEqual(['x', 'y']);
    expect(store.kv.get(snapshotDesiredKey('x'))).toBeNull();
    expect(store.kv.get(snapshotDesiredKey('y'))).toBeNull();
  });

  it('returns empty array and deletes nothing when there are no snapshot-desired payloads', () => {
    // Observed row exists but no payload → nothing to prune.
    store.kv.put('/xinas/v1/observed/ConfigSnapshot/a', { id: 'a', status: {} });

    const pruned = gcSnapshotDesired(store.kv);

    expect(pruned).toEqual([]);
  });

  it('keeps payloads whose id matches an observed row even when other payloads are pruned', () => {
    store.kv.put('/xinas/v1/observed/ConfigSnapshot/keep', {
      id: 'keep',
      status: { kind: 'baseline' },
    });
    store.kv.put(snapshotDesiredKey('keep'), { snapshot_id: 'keep', kinds: {} });
    store.kv.put(snapshotDesiredKey('orphan'), { snapshot_id: 'orphan', kinds: {} });

    const pruned = gcSnapshotDesired(store.kv);

    expect(pruned).toEqual(['orphan']);
    expect(store.kv.get(snapshotDesiredKey('keep'))).not.toBeNull();
    expect(store.kv.get(snapshotDesiredKey('orphan'))).toBeNull();
  });

  it('is a no-op when both observed rows and payloads are empty', () => {
    const pruned = gcSnapshotDesired(store.kv);
    expect(pruned).toEqual([]);
    // Nothing under the prefix means list returns [] — already covered by the
    // implementation scanning SNAPSHOT_DESIRED_PREFIX; confirm prefix is right.
    expect(SNAPSHOT_DESIRED_PREFIX).toBe('/xinas/v1/snapshot-desired/');
  });

  it('payload with missing snapshot_id field is pruned (defensive: cannot match any observed row)', () => {
    // A malformed / legacy payload with no snapshot_id should be pruned so
    // it does not accumulate indefinitely.
    store.kv.put('/xinas/v1/observed/ConfigSnapshot/z', { id: 'z', status: {} });
    store.kv.put(snapshotDesiredKey('no-id'), {} as { snapshot_id: string; kinds: object });

    const pruned = gcSnapshotDesired(store.kv);

    // 'no-id' payload has no snapshot_id → treated as unmatched → pruned.
    expect(pruned).toContain('no-id');
    expect(store.kv.get(snapshotDesiredKey('no-id'))).toBeNull();
  });
});
