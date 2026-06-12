import { describe, expect, it } from 'vitest';
import { ConfigSnapshotCollector } from '../../../agent/collectors/config-snapshot.js';
import type { HistoryManifest } from '../../../agent/task/xinas-history-bridge.js';

const M = (id: string, type: string, extra: Partial<HistoryManifest> = {}): HistoryManifest => ({
  id,
  timestamp: '2026-06-12T00:00:00Z',
  type,
  user: 'root',
  ...extra,
});

describe('ConfigSnapshotCollector (S9 T2)', () => {
  it('emits ALL projected rows on EVERY sweep (complete-snapshot semantics)', async () => {
    let manifests = [M('base-1', 'baseline'), M('snap-2', 'rollback_eligible')];
    const collector = new ConfigSnapshotCollector({
      source: { snapshotList: async () => manifests },
    });

    const first = await collector.initialSweep();
    expect(first).toHaveLength(2);
    const row = first.find((d) => d.id === 'base-1');
    expect(row?.op).toBe('upsert');
    const status = (row?.value as { status: Record<string, unknown> }).status;
    expect(status.kind).toBe('baseline');
    expect(status.snapshot_id).toBe('base-1');

    // unchanged sweep → SAME full row set, never []: PollDriver flushes with
    // complete-snapshot semantics, so suppressed rows would be
    // reconcile-deleted api-side (the bridge-pools e2e regression).
    const second = await collector.initialSweep();
    expect(second.map((d) => [d.id, d.op])).toEqual([
      ['base-1', 'upsert'],
      ['snap-2', 'upsert'],
    ]);

    // GC removes snap-2; a new snapshot appears. No delete delta — the
    // api-side reconcile drops vanished ids.
    manifests = [M('base-1', 'baseline'), M('snap-3', 'ephemeral')];
    const third = await collector.initialSweep();
    expect(third.map((d) => d.id).sort()).toEqual(['base-1', 'snap-3']);
    expect(third.every((d) => d.op === 'upsert')).toBe(true);
    const added = third.find((d) => d.id === 'snap-3');
    expect((added?.value as { status: { kind: string } }).status.kind).toBe('before');
  });

  it('a failing source degrades health and throws', async () => {
    const collector = new ConfigSnapshotCollector({
      source: {
        snapshotList: async () => {
          throw new Error('store unreadable');
        },
      },
    });
    await expect(collector.initialSweep()).rejects.toThrow('store unreadable');
    expect(collector.health().state).toBe('error');
  });
});
