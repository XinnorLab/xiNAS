/**
 * S20 §4 — the placement cycle: one call per source, the deadline, the
 * re-entrancy guard, identities and the published row (spec §9).
 */

import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_CAPABILITIES,
  PlacementObservationCollector,
  type PlacementRowStatus,
  type PlacementSources,
} from '../../../agent/collectors/placement.js';
import { encExportId } from '../../../lib/nfs-export-id.js';

const RAID_SHOW = [
  {
    name: 'data',
    level: '5',
    devices: [
      [0, '/dev/nvme0n2', ['online']],
      [1, '/dev/nvme1n2', ['online']],
      [2, '/dev/nvme2n2', ['online']],
    ],
    state: ['online', 'initialized'],
    init_progress: 100,
  },
  {
    name: 'log',
    level: '10',
    devices: [
      [0, '/dev/nvme0n1', ['online']],
      [1, '/dev/nvme1n1', ['online']],
    ],
    state: ['online'],
  },
];

function sources(
  over: Partial<PlacementSources> = {},
): PlacementSources & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  return {
    calls,
    raidShow: async () => {
      count('raidShow');
      return RAID_SHOW;
    },
    filesystems: async () => {
      count('filesystems');
      return {
        filesystems: [
          {
            id: 'mnt-data.mount',
            mountpoint: '/mnt/data',
            backing_device: '/dev/xi_data',
            fs_type: 'xfs',
            mount_options: ['defaults'],
            mounted: true,
            mountinfo_readable: true,
            mount_source: '/dev/xi_data',
            effective_mount_options: ['rw', 'noatime'],
            super_options: ['rw', 'logdev=/dev/xi_log'],
          },
        ],
        mounts: [
          { mountpoint: '/', source: '/dev/sda2', fstype: 'ext4' },
          { mountpoint: '/mnt/data', source: '/dev/xi_data', fstype: 'xfs' },
        ],
        mountinfo_readable: true,
      };
    },
    listExports: async () => {
      count('listExports');
      return [
        {
          export_path: '/mnt/data/a',
          host_pattern: '10.0.0.0/8',
          options: ['rw', 'fsid=1'],
          source: 'etab',
        },
        {
          export_path: '/mnt/data/a',
          host_pattern: '10.1.0.0/16',
          options: ['ro', 'fsid=1'],
          source: 'etab',
        },
        {
          export_path: '/mnt/data/b',
          host_pattern: '*',
          options: ['rw', 'fsid=2'],
          source: 'etab',
        },
      ];
    },
    nfsServiceState: async () => {
      count('nfsServiceState');
      return { active_state: 'active', sub_state: 'exited' };
    },
    nfsdVersions: async () => {
      count('nfsdVersions');
      return '-2 +3 +4 +4.1 +4.2\n';
    },
    nfsdThreads: async () => {
      count('nfsdThreads');
      return '8\n';
    },
    realpath: async (p) => {
      count('realpath');
      return p;
    },
    xiraidVersion: async () => ({ version: '4.4.0', build: '4.4.0-43861' }),
    diskIdByPath: () => new Map([['/dev/nvme0n2', 'disk-0']]),
    filesystemUuid: (id) => (id === 'mnt-data.mount' ? 'uuid-data' : undefined),
    ...over,
  };
}

function collector(
  src: PlacementSources,
  over: Partial<ConstructorParameters<typeof PlacementObservationCollector>[0]> = {},
) {
  let mono = 1_000;
  return new PlacementObservationCollector({
    controllerId: 'ctl-1',
    sources: src,
    pid: 4242,
    bootAt: '2026-09-22T10:00:00.000Z',
    now: () => '2026-09-22T12:00:00.000Z',
    mono: () => (mono += 10),
    ...over,
  });
}

async function sweep(c: PlacementObservationCollector): Promise<PlacementRowStatus> {
  const deltas = await c.initialSweep();
  expect(deltas).toHaveLength(1);
  const d = deltas[0] as NonNullable<(typeof deltas)[0]>;
  expect(d).toMatchObject({ kind: 'PlacementObservations', id: 'default', op: 'upsert' });
  return (d.value as { status: PlacementRowStatus }).status;
}

describe('PlacementObservationCollector', () => {
  it('publishes one COMPLETE row from one call per source (XMOD-02); realpath once per export path', async () => {
    const src = sources();
    const c = collector(src);
    const row = await sweep(c);
    expect(src.calls).toEqual({
      raidShow: 1,
      filesystems: 1,
      listExports: 1,
      nfsServiceState: 1,
      nfsdVersions: 1,
      nfsdThreads: 1,
      realpath: 2,
    });
    expect(row).toMatchObject({
      schema_version: '1.0',
      controller_id: 'ctl-1',
      server_epoch: 'ctl-1:2026-09-22T10:00:00.000Z:4242',
      source_generation: 1,
      snapshot_status: 'COMPLETE',
      collection_period_ms: 5_000,
      capabilities: [...PLACEMENT_CAPABILITIES],
      sources: {
        arrays: { status: 'ok' },
        filesystems: { status: 'ok' },
        exports: { status: 'ok' },
        nfs_service: { status: 'ok' },
        nfsd_versions: { status: 'ok' },
        nfsd_threads: { status: 'ok' },
      },
      collector: { deadline_hit: false, skipped_ticks: 0 },
    });
    expect(row.coverage.filter((c) => c.status === 'EVALUATED')).toHaveLength(8);
    expect(row.coverage.find((c) => c.check === 'export.effective_access')?.details).toEqual({
      source: 'etab',
    });
    expect(row.coverage.filter((c) => c.status === 'NOT_IMPLEMENTED').map((c) => c.reason)).toEqual(
      ['OUT_OF_MVP', 'OUT_OF_MVP', 'OUT_OF_MVP'],
    );
    // Two shares (three rules collapse onto two paths), both SUCCESS.
    expect(row.shares.map((s) => [s.share_id, s.collection_status, s.incarnation])).toEqual([
      [encExportId('/mnt/data/a'), 'SUCCESS', `${encExportId('/mnt/data/a')}:1`],
      [encExportId('/mnt/data/b'), 'SUCCESS', `${encExportId('/mnt/data/b')}:2`],
    ]);
    const ids = row.resources.map((r) => r.id);
    expect(ids).toEqual([
      'array:data',
      'array:log',
      'fs:mnt-data.mount',
      `export:${encExportId('/mnt/data/a')}`,
      `export:${encExportId('/mnt/data/b')}`,
      'nfs:nfs-server',
    ]);
    // Identity caches feed the graph without re-running the slow sweeps.
    const data = row.resources.find((r) => r.id === 'array:data');
    expect((data?.details.members as Array<{ id: string }>)[0]?.id).toBe('disk-0');
    expect((data?.details.members as Array<{ id: string }>)[1]?.id).toBe('/dev/nvme1n2');
    expect(data?.details.progress).toEqual({
      init_pct: 100,
      recon_pct: null,
      restripe_pct: null,
      sdc_pct: null,
    });
    const fs = row.resources.find((r) => r.id === 'fs:mnt-data.mount');
    expect(fs?.details.uuid).toBe('uuid-data');
    expect(fs?.details.log_mode).toBe('EXTERNAL');
    const nfs = row.resources.find((r) => r.id === 'nfs:nfs-server');
    expect(nfs?.details.threads).toBe(8);
    expect(nfs?.details.running).toBe(true);
    // Every record carries its monotonic stamp; the row its publication stamp.
    for (const r of row.resources) expect(typeof r.observed_mono_ms).toBe('number');
    expect(row.published_mono_ms).toBeGreaterThan(row.resources[0]?.observed_mono_ms as number);
    expect(c.health()).toEqual({ state: 'running' });
  });

  it('increments source_generation per cycle under a constant server_epoch', async () => {
    const c = collector(sources());
    const a = await sweep(c);
    const b = await sweep(c);
    expect(a.server_epoch).toBe(b.server_epoch);
    expect([a.source_generation, b.source_generation]).toEqual([1, 2]);
  });

  it('a failing raidShow → PARTIAL with the ERROR placeholder, health still running', async () => {
    const c = collector(
      sources({
        raidShow: async () => {
          throw new Error('daemon down');
        },
      }),
    );
    const row = await sweep(c);
    expect(row.snapshot_status).toBe('PARTIAL');
    expect(row.sources.arrays).toEqual({ status: 'failed' });
    expect(row.resources.find((r) => r.id === 'array:unavailable')?.reason_codes).toEqual([
      'XIRAID_DAEMON_UNAVAILABLE',
    ]);
    expect(row.shares.every((s) => s.collection_status === 'UNKNOWN')).toBe(true);
    expect(c.health()).toEqual({ state: 'running' });
  });

  it('every source failing → FAILED and health error', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('boom');
    };
    const c = collector(
      sources({
        raidShow: boom,
        filesystems: boom,
        listExports: boom,
        nfsServiceState: boom,
        nfsdVersions: boom,
        nfsdThreads: boom,
      }),
    );
    const row = await sweep(c);
    expect(row.snapshot_status).toBe('FAILED');
    expect(c.health()).toEqual({ state: 'error', reason: 'PLACEMENT_SOURCES_UNAVAILABLE' });
  });

  it('the deadline bounds the cycle: a hanging source is COLLECTION_TIMEOUT, the rest is published', async () => {
    const never = new Promise<never>(() => {});
    const c = collector(sources({ listExports: () => never }), { deadlineMs: 30 });
    const started = Date.now();
    const row = await sweep(c);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(row.snapshot_status).toBe('PARTIAL');
    expect(row.collector.deadline_hit).toBe(true);
    expect(row.sources.exports).toEqual({ status: 'timeout' });
    expect(row.resources.find((r) => r.id === 'export:unavailable')?.reason_codes).toEqual([
      'COLLECTION_TIMEOUT',
    ]);
    expect(row.resources.find((r) => r.id === 'array:data')?.collection_status).toBe('SUCCESS');
  });

  it('F-09: a hanging version source is bounded by the same deadline and reads as unavailable', async () => {
    const never = new Promise<never>(() => {});
    const c = collector(sources({ xiraidVersion: () => never }), { deadlineMs: 30 });
    const started = Date.now();
    const row = await sweep(c);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(row.resources.find((r) => r.id === 'array:data')?.reason_codes).toEqual([
      'XIRAID_VERSION_UNAVAILABLE',
    ]);
    // The version is not one of the graph's sources: the snapshot stays COMPLETE.
    expect(row.snapshot_status).toBe('COMPLETE');
  });

  it('a tick that fires during a running cycle is skipped, never stacked', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let raidCalls = 0;
    const src = sources({
      raidShow: async () => {
        raidCalls++;
        await gate;
        return RAID_SHOW;
      },
    });
    const c = collector(src, { deadlineMs: 5_000 });
    const first = c.initialSweep();
    await expect(c.initialSweep()).rejects.toThrow(/skipped/);
    expect(c.skippedTicks).toBe(1);
    release();
    const deltas = await first;
    expect(raidCalls).toBe(1);
    const row = (deltas[0]?.value as { status: PlacementRowStatus }).status;
    expect(row.collector.skipped_ticks).toBe(1);
    // The guard is released: the next sweep runs.
    await expect(c.initialSweep()).resolves.toHaveLength(1);
  });

  it('a null package version is published as XIRAID_VERSION_UNAVAILABLE, a throwing source likewise', async () => {
    const c = collector(
      sources({
        xiraidVersion: async () => {
          throw new Error('dpkg missing');
        },
      }),
    );
    const row = await sweep(c);
    expect(row.resources.find((r) => r.id === 'array:data')?.reason_codes).toEqual([
      'XIRAID_VERSION_UNAVAILABLE',
    ]);
  });

  it('a symlinked export path is UNKNOWN / PATH_NOT_CANONICAL; a realpath failure is PATH_UNRESOLVABLE', async () => {
    const c = collector(
      sources({
        realpath: async (p) => {
          if (p === '/mnt/data/a') return '/mnt/real/a';
          throw new Error('ENOENT');
        },
      }),
    );
    const row = await sweep(c);
    expect(row.shares.map((s) => s.reason_codes)).toEqual([
      ['PATH_NOT_CANONICAL'],
      ['PATH_UNRESOLVABLE'],
    ]);
  });
});
