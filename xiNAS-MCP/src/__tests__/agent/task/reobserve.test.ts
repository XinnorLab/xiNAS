import { describe, expect, it, vi } from 'vitest';
import type { Collector, Kind, ObservationDelta } from '../../../agent/collectors/base.js';
import { CollectorRegistry } from '../../../agent/collectors/base.js';
import { REOBSERVE_KINDS, makeReobserve } from '../../../agent/task/reobserve.js';

/** A minimal in-memory collector whose initialSweep returns fixed deltas. */
function fakeCollector(kind: Kind, sweep: () => Promise<ObservationDelta[]>): Collector {
  return {
    kind,
    initialSweep: sweep,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    health() {
      return { state: 'running' as const };
    },
  };
}

/** A fake publisher recording enqueues + flushWithSnapshot calls. */
function fakePublisher() {
  const enqueued: ObservationDelta[] = [];
  const flushed: Kind[][] = [];
  return {
    enqueued,
    flushed,
    enqueue(delta: ObservationDelta): void {
      enqueued.push(delta);
    },
    async flushWithSnapshot(kinds: Kind[]): Promise<void> {
      flushed.push(kinds);
    },
  };
}

describe('makeReobserve', () => {
  it('sweeps only the collectors mapped for the operation kind and flushes them', async () => {
    const fsSweep = vi.fn(
      async (): Promise<ObservationDelta[]> => [
        {
          kind: 'Filesystem',
          id: 'mnt-data.mount',
          op: 'upsert',
          value: { status: { mounted: false } },
        },
      ],
    );
    const arraySweep = vi.fn(async (): Promise<ObservationDelta[]> => []);
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('Filesystem', fsSweep));
    registry.register(fakeCollector('XiraidArray', arraySweep));
    const pub = fakePublisher();

    const reobserve = makeReobserve(registry, pub);
    await reobserve('fs.unmount');

    // Only the Filesystem collector was swept.
    expect(fsSweep).toHaveBeenCalledTimes(1);
    expect(arraySweep).not.toHaveBeenCalled();
    // Its delta was enqueued and the kind flushed with complete-snapshot semantics.
    expect(pub.enqueued).toHaveLength(1);
    expect(pub.enqueued[0]?.id).toBe('mnt-data.mount');
    expect(pub.flushed).toEqual([['Filesystem']]);
  });

  it('is a no-op for an operation kind not in the settle table', async () => {
    const fsSweep = vi.fn(async (): Promise<ObservationDelta[]> => []);
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('Filesystem', fsSweep));
    const pub = fakePublisher();

    await makeReobserve(registry, pub)('reference.echo');

    expect(fsSweep).not.toHaveBeenCalled();
    expect(pub.enqueued).toHaveLength(0);
    expect(pub.flushed).toHaveLength(0);
  });

  it('flushes with complete-snapshot semantics even when the sweep returns no rows', async () => {
    // A filesystem removed from the host yields an empty sweep; the kind must
    // still be flushed so the reconcile deletes the stale observed row.
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('Filesystem', async () => []));
    const pub = fakePublisher();

    await makeReobserve(registry, pub)('fs.unmanage');

    expect(pub.flushed).toEqual([['Filesystem']]);
  });

  it('swallows a collector sweep error and still resolves (poll backstop recovers)', async () => {
    const registry = new CollectorRegistry();
    registry.register(
      fakeCollector('Filesystem', async () => {
        throw new Error('probe blew up');
      }),
    );
    const pub = fakePublisher();

    await expect(makeReobserve(registry, pub)('fs.unmount')).resolves.toBeUndefined();
    // Sweep failed → nothing to flush.
    expect(pub.flushed).toHaveLength(0);
  });

  it('swallows a flush error and still resolves', async () => {
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('Filesystem', async () => []));
    const pub = {
      enqueue(): void {},
      async flushWithSnapshot(): Promise<void> {
        throw new Error('api unreachable');
      },
    };

    await expect(makeReobserve(registry, pub)('fs.unmount')).resolves.toBeUndefined();
  });

  it('maps every fs / xiraid.array / pool / share mutation to its observed kinds', () => {
    expect(REOBSERVE_KINDS['fs.create']).toEqual(['Filesystem']);
    expect(REOBSERVE_KINDS['fs.unmount']).toEqual(['Filesystem']);
    expect(REOBSERVE_KINDS['fs.unmanage']).toEqual(['Filesystem']);
    expect(REOBSERVE_KINDS['xiraid.array.create']).toEqual(['XiraidArray']);
    expect(REOBSERVE_KINDS['xiraid.array.delete']).toEqual(['XiraidArray']);
    expect(REOBSERVE_KINDS['pool.delete']).toEqual(['Pool']);
    // share.* settles BOTH the NFS collector's kinds so a chained fs.unmount
    // sees a just-removed export gone.
    expect(REOBSERVE_KINDS['share.delete']).toEqual(['NfsSession', 'ExportRule']);
    expect(REOBSERVE_KINDS['share.create']).toEqual(['NfsSession', 'ExportRule']);
    // Non-mutating / unmapped kinds are absent.
    expect(REOBSERVE_KINDS['reference.echo']).toBeUndefined();
  });

  // ── share.* : multi-kind NFS collector (kind NfsSession, also emits ExportRule) ──

  it('share.delete: sweeps the NFS collector and flushes BOTH NfsSession + ExportRule', async () => {
    const nfsSweep = vi.fn(
      async (): Promise<ObservationDelta[]> => [
        { kind: 'NfsSession', id: 'sess-1', op: 'upsert', value: {} },
        { kind: 'ExportRule', id: 'srv-data', op: 'upsert', value: {} },
      ],
    );
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('NfsSession', nfsSweep));
    const pub = fakePublisher();

    await makeReobserve(registry, pub)('share.delete');

    expect(nfsSweep).toHaveBeenCalledTimes(1);
    expect(pub.enqueued.map((d) => d.kind)).toEqual(['NfsSession', 'ExportRule']);
    expect(pub.flushed).toEqual([['NfsSession', 'ExportRule']]);
  });

  it('share.delete: flushes ExportRule complete-snapshot even when the LAST export is gone (zero-export sweep)', async () => {
    // The critical hazard: removing the last export yields a sweep with no
    // ExportRule rows. The stale observed ExportRule must still reconcile away,
    // so the complete-snapshot flush MUST include ExportRule.
    const registry = new CollectorRegistry();
    registry.register(fakeCollector('NfsSession', async () => []));
    const pub = fakePublisher();

    await makeReobserve(registry, pub)('share.delete');

    expect(pub.flushed).toEqual([['NfsSession', 'ExportRule']]);
  });

  it('share.delete: a failed NFS sweep flushes NOTHING (no complete-snapshot delete of ExportRule)', async () => {
    const registry = new CollectorRegistry();
    registry.register(
      fakeCollector('NfsSession', async () => {
        throw new Error('nfs helper down');
      }),
    );
    const pub = fakePublisher();

    await expect(makeReobserve(registry, pub)('share.delete')).resolves.toBeUndefined();
    expect(pub.flushed).toHaveLength(0);
  });
});
