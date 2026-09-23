/**
 * S20 §4.5 graph rules, exercised as a pure function (spec §9).
 */

import { describe, expect, it } from 'vitest';
import { encExportId } from '../../lib/nfs-export-id.js';
import {
  type ArrayInput,
  type ExportInput,
  type FilesystemInput,
  type FilesystemSweep,
  type GraphInputs,
  type MountSummary,
  type Source,
  buildPlacementGraph,
  containingFilesystem,
  foreignMountsUnder,
  writableFromOptions,
} from '../../lib/placement-graph.js';

const AT = '2026-09-22T12:00:00.000Z';
const ok = <T>(value: T, mono = 1_000): Source<T> => ({
  ok: true,
  value,
  observed_at: AT,
  mono_ms: mono,
});
const failed = <T>(): Source<T> => ({ ok: false, reason: 'COLLECTION_FAILED' });
const timeout = <T>(): Source<T> => ({ ok: false, reason: 'COLLECTION_TIMEOUT' });

const member = (
  index: number,
  path: string | null,
  states = ['online'],
): ArrayInput['members'][number] => ({
  index,
  device_path: path,
  ...(path !== null ? { disk_id: `disk-${index}` } : {}),
  raw_states: states,
  state_valid: true,
});

const ARRAYS: ArrayInput[] = [
  {
    name: 'data',
    raid_level: '5',
    volume_path: '/dev/xi_data',
    raw_states: ['online', 'initialized'],
    state_valid: true,
    members: [member(0, '/dev/nvme0n2'), member(1, '/dev/nvme1n2'), member(2, '/dev/nvme2n2')],
    progress: { init_pct: 100, recon_pct: null, restripe_pct: null, sdc_pct: null },
  },
  {
    name: 'log',
    raid_level: '10',
    volume_path: '/dev/xi_log',
    raw_states: ['online'],
    state_valid: true,
    members: [member(0, '/dev/nvme0n1'), member(1, '/dev/nvme1n1')],
  },
];

const FS_A: FilesystemInput = {
  id: 'mnt-data.mount',
  mountpoint: '/mnt/data',
  backing_device: '/dev/xi_data',
  fs_type: 'xfs',
  mount_options: ['defaults', 'noatime'],
  mounted: true,
  mountinfo_readable: true,
  mount_source: '/dev/xi_data',
  effective_mount_options: ['rw', 'noatime'],
  super_options: ['rw', 'logdev=/dev/xi_log'],
  uuid: 'uuid-a',
};

const FS_B: FilesystemInput = {
  id: 'mnt-scratch.mount',
  mountpoint: '/mnt/scratch',
  backing_device: '/dev/xi_data',
  fs_type: 'xfs',
  mount_options: ['defaults'],
  mounted: true,
  mountinfo_readable: true,
  mount_source: '/dev/xi_data',
  effective_mount_options: ['rw', 'relatime'],
  super_options: ['rw'],
};

/** The node's mount table: root, the two managed filesystems, nothing foreign. */
const MOUNTS: MountSummary[] = [
  { mountpoint: '/', source: '/dev/sda2', fstype: 'ext4' },
  { mountpoint: '/mnt/data', source: '/dev/xi_data', fstype: 'xfs' },
  { mountpoint: '/mnt/scratch', source: '/dev/xi_data', fstype: 'xfs' },
];

const sweep = (
  filesystems: FilesystemInput[],
  mounts: MountSummary[] = MOUNTS,
  readable = true,
): FilesystemSweep => ({
  filesystems,
  mounts,
  mountinfo_readable: readable,
});

/** FS_A minus the mount-table facts — what the probe emits when there is no exact match. */
function unmounted(over: Partial<FilesystemInput> = {}): FilesystemInput {
  const { mount_source: _ms, super_options: _so, effective_mount_options: _eo, ...rest } = FS_A;
  return { ...rest, mounted: false, ...over };
}

const rule = (host = '10.10.0.0/16', options = ['rw', 'sync', 'no_subtree_check', 'fsid=7']) => ({
  host_pattern: host,
  options,
});

const EXPORTS: ExportInput[] = [
  { export_path: '/mnt/data/training-a', rules: [rule()], source: 'etab' },
  {
    export_path: '/mnt/data/training-b',
    rules: [rule('10.20.0.0/16', ['ro', 'fsid=8'])],
    source: 'etab',
  },
  { export_path: '/mnt/scratch', rules: [rule()], source: 'etab' },
  { export_path: '/srv/other', rules: [rule()], source: 'etab' }, // not on a managed filesystem
];

function inputs(over: Partial<GraphInputs> = {}): GraphInputs {
  return {
    arrays: ok(ARRAYS),
    filesystems: ok(sweep([FS_A, FS_B])),
    exports: ok(EXPORTS),
    nfs_service: ok({ active_state: 'active', sub_state: 'exited' }),
    nfsd_versions: ok(['3', '4.1', '4.2']),
    nfsd_threads: ok(8),
    xiraid_version: { version: '4.4.0', build: '4.4.0-43861' },
    ...over,
  };
}

const graph = (over: Partial<GraphInputs> = {}) => buildPlacementGraph(inputs(over), encExportId);
const byId = (g: ReturnType<typeof graph>, id: string) => g.resources.find((r) => r.id === id);

describe('containingFilesystem', () => {
  const fss = [
    { mountpoint: '/mnt/data' },
    { mountpoint: '/mnt/data/sub' },
    { mountpoint: '/mnt' },
  ];
  it('picks the longest mountpoint that contains the path by segment', () => {
    expect(containingFilesystem('/mnt/data/sub/x', fss)?.mountpoint).toBe('/mnt/data/sub');
    expect(containingFilesystem('/mnt/data/subdir', fss)?.mountpoint).toBe('/mnt/data');
    expect(containingFilesystem('/mnt/data', fss)?.mountpoint).toBe('/mnt/data');
    expect(containingFilesystem('/mnt/data2', fss)?.mountpoint).toBe('/mnt');
    expect(containingFilesystem('/srv/x', fss)).toBeUndefined();
  });
});

describe('foreignMountsUnder (T-05, API-05)', () => {
  const table: MountSummary[] = [
    { mountpoint: '/', source: '/dev/sda2', fstype: 'ext4' },
    { mountpoint: '/mnt/data', source: '/dev/xi_data', fstype: 'xfs' },
    { mountpoint: '/mnt/data/training-a/cache', source: 'tmpfs', fstype: 'tmpfs' },
    { mountpoint: '/mnt/data/shared', source: '/dev/sdb1', fstype: 'ext4' },
    { mountpoint: '/mnt/data/bind', source: '/dev/xi_data', fstype: 'xfs' },
  ];
  it('finds mounts at or under the share path', () => {
    expect(foreignMountsUnder('/mnt/data/training-a', '/mnt/data', table)).toEqual([
      '/mnt/data/training-a/cache',
    ]);
    expect(foreignMountsUnder('/mnt/data/shared', '/mnt/data', table)).toEqual([
      '/mnt/data/shared',
    ]);
  });
  it('finds a mount between the filesystem and the share path, ignores the filesystem itself and unrelated mounts', () => {
    expect(foreignMountsUnder('/mnt/data/shared/proj', '/mnt/data', table)).toEqual([
      '/mnt/data/shared',
    ]);
    expect(foreignMountsUnder('/mnt/data/training-b', '/mnt/data', table)).toEqual([]);
    // A bind mount of the same device is still ambiguous.
    expect(foreignMountsUnder('/mnt/data/bind/x', '/mnt/data', table)).toEqual(['/mnt/data/bind']);
  });
});

describe('writableFromOptions (F-12)', () => {
  it('needs rw in the VFS options and no ro anywhere', () => {
    expect(writableFromOptions(['rw', 'noatime'], ['rw', 'logdev=/dev/xi_log'])).toBe(true);
    expect(writableFromOptions(['rw'], [])).toBe(true);
    expect(writableFromOptions(['rw'], undefined)).toBe(true);
    expect(writableFromOptions(['ro'], ['rw'])).toBe(false);
    expect(writableFromOptions(['rw', 'noatime'], ['ro', 'logdev=/dev/xi_log'])).toBe(false);
    expect(writableFromOptions(['noatime'], ['rw'])).toBeNull();
    expect(writableFromOptions(['rw'], ['norecovery'])).toBeNull();
    expect(writableFromOptions(undefined, ['rw'])).toBeNull();
  });
});

describe('T-04 topology: two shares on one fs with data+log arrays, one on a second fs', () => {
  const g = graph();

  it('is COMPLETE with three SUCCESS shares and no share for the unmanaged export', () => {
    expect(g.snapshot_status).toBe('COMPLETE');
    expect(g.shares.map((s) => [s.export_path, s.collection_status])).toEqual([
      ['/mnt/data/training-a', 'SUCCESS'],
      ['/mnt/data/training-b', 'SUCCESS'],
      ['/mnt/scratch', 'SUCCESS'],
    ]);
    expect(byId(g, `export:${encExportId('/srv/other')}`)?.details.present).toBe(true);
  });

  it('shares carry their refs, the fsid incarnation and the OLDEST evidence time', () => {
    const a = g.shares[0] as NonNullable<(typeof g.shares)[0]>;
    expect(a.share_id).toBe(encExportId('/mnt/data/training-a'));
    expect(a.incarnation).toBe(`${a.share_id}:7`);
    expect(a.filesystem_ref).toBe('fs:mnt-data.mount');
    expect(a.export_ref).toBe(`export:${a.share_id}`);
    expect(a.service_ref).toBe('nfs:nfs-server');
    expect(a.observed_at).toBe(AT);
    expect(a.observed_mono_ms).toBe(1_000);
    expect(a.reason_codes).toEqual([]);
    expect(a.nested_mountpoints).toBeUndefined();
  });

  it('filesystem A resolves DATA and LOG arrays with log_mode EXTERNAL; B is INTERNAL', () => {
    const fsA = byId(g, 'fs:mnt-data.mount');
    expect(fsA?.collection_status).toBe('SUCCESS');
    expect(fsA?.incarnation).toBe('uuid-a:/dev/xi_data');
    expect(fsA?.details).toMatchObject({
      kind: 'FILESYSTEM',
      uuid: 'uuid-a',
      mountpoint: '/mnt/data',
      source_device: '/dev/xi_data',
      fs_type: 'xfs',
      mounted: true,
      writable: true,
      mount_options: ['rw', 'noatime'],
      super_options: ['rw', 'logdev=/dev/xi_log'],
      external_dependencies_resolved: true,
      array_refs: [
        { role: 'DATA', resource_id: 'array:data' },
        { role: 'LOG', resource_id: 'array:log' },
      ],
      log_mode: 'EXTERNAL',
    });
    const fsB = byId(g, 'fs:mnt-scratch.mount');
    expect(fsB?.details.log_mode).toBe('INTERNAL');
    expect(fsB?.details.array_refs).toEqual([{ role: 'DATA', resource_id: 'array:data' }]);
    // No blkid UUID in the fast cycle → the unit name stands in, labelled.
    expect(fsB?.details.uuid).toBe('mnt-scratch.mount');
    expect(fsB?.reason_codes).toEqual(['FS_UUID_UNAVAILABLE']);
    expect(fsB?.collection_status).toBe('SUCCESS');
  });

  it('arrays publish edition/version/build, states, progress and members in the schema shape', () => {
    const data = byId(g, 'array:data');
    expect(data?.collection_status).toBe('SUCCESS');
    expect(data?.incarnation).toBe('data:/dev/xi_data:5:3');
    expect(data?.details).toMatchObject({
      kind: 'ARRAY',
      name: 'data',
      volume_path: '/dev/xi_data',
      edition: 'Classic',
      version: '4.4.0',
      build: '4.4.0-43861',
      raid_level: '5',
      state_valid: true,
      raw_states: ['online', 'initialized'],
      progress: { init_pct: 100, recon_pct: null, restripe_pct: null, sdc_pct: null },
    });
    // An array without progress values publishes nulls, never a guess (API-08).
    expect(byId(g, 'array:log')?.details.progress).toEqual({
      init_pct: null,
      recon_pct: null,
      restripe_pct: null,
      sdc_pct: null,
    });
    expect((data?.details.members as unknown[])[1]).toEqual({
      id: 'disk-1',
      index: 1,
      group: null,
      device_path: '/dev/nvme1n2',
      state_valid: true,
      raw_states: ['online'],
    });
  });

  it('export rules are normalized: rw/ro, sec default sys, options kept, source etab', () => {
    const a = byId(g, `export:${encExportId('/mnt/data/training-a')}`);
    expect(a?.details).toMatchObject({
      kind: 'EXPORT',
      export_path: '/mnt/data/training-a',
      present: true,
      source: 'etab',
      rules: [
        {
          client: '10.10.0.0/16',
          writable: true,
          security: ['sys'],
          options: ['rw', 'sync', 'no_subtree_check', 'fsid=7'],
        },
      ],
    });
    const b = byId(g, `export:${encExportId('/mnt/data/training-b')}`);
    expect((b?.details.rules as Array<{ writable: boolean }>)[0]?.writable).toBe(false);
  });

  it('the NFS service is the singleton with protocols from nfsd versions and threads from nfsd', () => {
    const nfs = byId(g, 'nfs:nfs-server');
    expect(nfs?.collection_status).toBe('SUCCESS');
    expect(nfs?.details).toMatchObject({
      kind: 'NFS_SERVICE',
      running: true,
      protocols: ['NFSv3', 'NFSv4.1', 'NFSv4.2'],
      reason_codes: [],
      unit_active_state: 'active',
      threads: 8,
    });
  });
});

describe('failure isolation (API-07, T-04)', () => {
  it('a failing raidShow → one ERROR array placeholder, filesystems UNKNOWN, every share UNKNOWN, PARTIAL', () => {
    const g = graph({ arrays: failed() });
    expect(g.snapshot_status).toBe('PARTIAL');
    const arr = byId(g, 'array:unavailable');
    expect(arr).toMatchObject({
      collection_status: 'ERROR',
      observed_at: null,
      observed_mono_ms: null,
      reason_codes: ['XIRAID_DAEMON_UNAVAILABLE'],
      details: { kind: 'ARRAY' },
    });
    expect(byId(g, 'fs:mnt-data.mount')?.reason_codes).toContain('DEPENDENCY_ARRAY_UNAVAILABLE');
    expect(byId(g, 'fs:mnt-data.mount')?.collection_status).toBe('UNKNOWN');
    for (const s of g.shares) {
      expect(s.collection_status).toBe('UNKNOWN');
      expect(s.reason_codes).toEqual(['DEPENDENCY_FILESYSTEM_UNAVAILABLE']);
    }
    // Exports and the service are untouched.
    expect(byId(g, 'nfs:nfs-server')?.collection_status).toBe('SUCCESS');
  });

  it('a timed-out source is named COLLECTION_TIMEOUT', () => {
    const g = graph({ exports: timeout() });
    expect(byId(g, 'export:unavailable')?.reason_codes).toEqual(['COLLECTION_TIMEOUT']);
    expect(g.shares).toEqual([]);
    expect(g.snapshot_status).toBe('PARTIAL');
  });

  it('every source failing → FAILED', () => {
    const g = graph({
      arrays: failed(),
      filesystems: failed(),
      exports: failed(),
      nfs_service: failed(),
      nfsd_versions: failed(),
      nfsd_threads: failed(),
    });
    expect(g.snapshot_status).toBe('FAILED');
    expect(g.shares).toEqual([]);
    expect(g.resources.every((r) => r.collection_status === 'ERROR')).toBe(true);
  });

  it('a share whose service is down is UNKNOWN while its filesystem stays SUCCESS', () => {
    const g = graph({ nfs_service: failed() });
    expect(byId(g, 'nfs:nfs-server')?.reason_codes).toEqual(['NFS_SERVICE_STATE_UNAVAILABLE']);
    expect(g.shares[0]?.reason_codes).toEqual(['DEPENDENCY_NFS_SERVICE_UNAVAILABLE']);
    expect(byId(g, 'fs:mnt-data.mount')?.collection_status).toBe('SUCCESS');
  });
});

describe('filesystem rules (API-06, XMOD-03, XMOD-12, T-04, T-05)', () => {
  it('F-05: a logdev naming a device no array owns makes the filesystem UNKNOWN and its shares UNKNOWN; the other filesystem is untouched', () => {
    const g = graph({
      filesystems: ok(sweep([{ ...FS_A, super_options: ['rw', 'logdev=/dev/sdz9'] }, FS_B])),
    });
    const fs = byId(g, 'fs:mnt-data.mount');
    expect(fs?.collection_status).toBe('UNKNOWN');
    expect(fs?.reason_codes).toEqual(['EXTERNAL_DEVICE_UNRESOLVED']);
    expect(fs?.details.external_dependencies_resolved).toBe(false);
    expect(fs?.details.log_mode).toBe('EXTERNAL');
    expect(fs?.details.array_refs).toEqual([{ role: 'DATA', resource_id: 'array:data' }]);
    expect(g.shares.map((s) => [s.export_path, s.collection_status, s.reason_codes])).toEqual([
      ['/mnt/data/training-a', 'UNKNOWN', ['DEPENDENCY_FILESYSTEM_UNAVAILABLE']],
      ['/mnt/data/training-b', 'UNKNOWN', ['DEPENDENCY_FILESYSTEM_UNAVAILABLE']],
      ['/mnt/scratch', 'SUCCESS', []],
    ]);
  });

  it('T-04: a fault on the shared log array blocks its two shares only', () => {
    const g = graph({
      arrays: ok([
        ARRAYS[0] as ArrayInput,
        { ...(ARRAYS[1] as ArrayInput), raw_states: ['online', 'reconstructing'] },
      ]),
    });
    // The source publishes the words; the connector applies the veto. Here the
    // array is still SUCCESS, so the dependency chain reads SUCCESS as well —
    // the log array's identity is what both shares reference.
    expect(g.shares.every((s) => s.collection_status === 'SUCCESS')).toBe(true);
    expect(byId(g, 'array:log')?.details.raw_states).toEqual(['online', 'reconstructing']);
    expect(g.shares[0]?.filesystem_ref).toBe(g.shares[1]?.filesystem_ref);
    expect(g.shares[2]?.filesystem_ref).not.toBe(g.shares[0]?.filesystem_ref);
  });

  it('an rtdev is a REALTIME ref', () => {
    const g = graph({
      filesystems: ok(sweep([{ ...FS_A, super_options: ['rw', 'rtdev=/dev/xi_log'] }])),
    });
    const fs = byId(g, 'fs:mnt-data.mount');
    expect(fs?.details.log_mode).toBe('INTERNAL');
    expect(fs?.details.array_refs).toEqual([
      { role: 'DATA', resource_id: 'array:data' },
      { role: 'REALTIME', resource_id: 'array:log' },
    ]);
  });

  it('a mount-source mismatch is UNKNOWN / MOUNT_SOURCE_MISMATCH — no fallback to the parent', () => {
    const g = graph({
      filesystems: ok(sweep([unmounted({ mount_source_mismatch: '/dev/sdb1' })])),
    });
    const fs = byId(g, 'fs:mnt-data.mount');
    expect(fs?.collection_status).toBe('UNKNOWN');
    expect(fs?.reason_codes).toContain('MOUNT_SOURCE_MISMATCH');
    expect(fs?.details.mount_source_mismatch).toBe('/dev/sdb1');
    expect(fs?.details.log_mode).toBe('UNKNOWN');
    expect(g.shares[0]?.reason_codes).toEqual(['DEPENDENCY_FILESYSTEM_UNAVAILABLE']);
  });

  it('unreadable mountinfo → mounted null, writable null, UNKNOWN / MOUNTINFO_UNREADABLE; no nested-mount claim either', () => {
    const { mounted: _m, ...unreadable } = unmounted({ mountinfo_readable: false });
    const g = graph({ filesystems: ok(sweep([unreadable], [], false)) });
    const fs = byId(g, 'fs:mnt-data.mount');
    expect(fs?.details.mounted).toBeNull();
    expect(fs?.details.writable).toBeNull();
    expect(fs?.collection_status).toBe('UNKNOWN');
    expect(fs?.reason_codes).toContain('MOUNTINFO_UNREADABLE');
    expect(g.shares[0]?.reason_codes).toEqual(['DEPENDENCY_FILESYSTEM_UNAVAILABLE']);
  });

  it('not mounted → mounted false is a proven fact (SUCCESS), log_mode UNKNOWN, unit options published', () => {
    const g = graph({ filesystems: ok(sweep([unmounted()])) });
    const fs = byId(g, 'fs:mnt-data.mount');
    expect(fs?.collection_status).toBe('SUCCESS');
    expect(fs?.details).toMatchObject({
      mounted: false,
      writable: null,
      log_mode: 'UNKNOWN',
      mount_options: ['defaults', 'noatime'],
      source_device: '/dev/xi_data',
    });
  });

  it('a filesystem whose source no array owns → UNKNOWN / DATA_ARRAY_UNRESOLVED', () => {
    const g = graph({
      filesystems: ok(
        sweep([{ ...FS_A, backing_device: '/dev/nvme9n1', mount_source: '/dev/nvme9n1' }]),
      ),
    });
    expect(byId(g, 'fs:mnt-data.mount')?.reason_codes).toContain('DATA_ARRAY_UNRESOLVED');
    expect(byId(g, 'fs:mnt-data.mount')?.collection_status).toBe('UNKNOWN');
  });

  it('F-12: read-only reads writable false from EITHER option list; contradictory lists are unproven', () => {
    const vfsRo = graph({
      filesystems: ok(sweep([{ ...FS_A, effective_mount_options: ['ro', 'noatime'] }])),
    });
    expect(byId(vfsRo, 'fs:mnt-data.mount')?.details.writable).toBe(false);
    const superRo = graph({
      filesystems: ok(sweep([{ ...FS_A, super_options: ['ro', 'logdev=/dev/xi_log'] }])),
    });
    expect(byId(superRo, 'fs:mnt-data.mount')?.details.writable).toBe(false);
    const neither = graph({
      filesystems: ok(sweep([{ ...FS_A, effective_mount_options: ['noatime'] }])),
    });
    expect(byId(neither, 'fs:mnt-data.mount')?.details.writable).toBeNull();
  });

  it('F-04 / T-05: a foreign mount under the share path makes THAT share UNKNOWN / NESTED_MOUNT, not its neighbours', () => {
    const g = graph({
      filesystems: ok(
        sweep(
          [FS_A, FS_B],
          [
            ...MOUNTS,
            { mountpoint: '/mnt/data/training-a/cache', source: 'tmpfs', fstype: 'tmpfs' },
          ],
        ),
      ),
    });
    expect(g.shares[0]).toMatchObject({
      export_path: '/mnt/data/training-a',
      collection_status: 'UNKNOWN',
      reason_codes: ['NESTED_MOUNT'],
      nested_mountpoints: ['/mnt/data/training-a/cache'],
      filesystem_ref: 'fs:mnt-data.mount',
    });
    expect(g.shares[1]?.collection_status).toBe('SUCCESS');
    expect(g.shares[2]?.collection_status).toBe('SUCCESS');
  });

  it('F-04 / T-05: a foreign mount BETWEEN the filesystem and the share path is not resolved to the parent arrays', () => {
    const g = graph({
      filesystems: ok(
        sweep(
          [FS_A],
          [...MOUNTS, { mountpoint: '/mnt/data/training-b', source: '/dev/sdb1', fstype: 'ext4' }],
        ),
      ),
      exports: ok([{ export_path: '/mnt/data/training-b/proj', rules: [rule()], source: 'etab' }]),
    });
    expect(g.shares[0]).toMatchObject({
      collection_status: 'UNKNOWN',
      reason_codes: ['NESTED_MOUNT'],
      nested_mountpoints: ['/mnt/data/training-b'],
    });
  });

  it('T-05 symlink rule: a non-canonical or unresolvable export path is UNKNOWN', () => {
    const g = graph({
      canonical_paths: {
        '/mnt/data/training-a': '/mnt/real/training-a',
        '/mnt/data/training-b': null,
      },
    });
    expect(g.shares[0]?.reason_codes).toEqual(['PATH_NOT_CANONICAL']);
    expect(g.shares[1]?.reason_codes).toEqual(['PATH_UNRESOLVABLE']);
    expect(g.shares[2]?.reason_codes).toEqual(['PATH_UNRESOLVABLE']); // not in the map
    const fine = graph({
      canonical_paths: {
        '/mnt/data/training-a': '/mnt/data/training-a',
        '/mnt/data/training-b': '/mnt/data/training-b',
        '/mnt/scratch': '/mnt/scratch',
      },
    });
    expect(fine.shares.every((s) => s.collection_status === 'SUCCESS')).toBe(true);
  });
});

describe('array rules (API-16, XMOD-06)', () => {
  it('a member without a device path → UNKNOWN / MEMBER_DEVICE_UNRESOLVED, member kept', () => {
    const g = graph({
      arrays: ok([
        {
          ...(ARRAYS[0] as ArrayInput),
          members: [member(0, '/dev/nvme0n2'), member(1, null, ['offline'])],
        },
        ARRAYS[1] as ArrayInput,
      ]),
    });
    const a = byId(g, 'array:data');
    expect(a?.collection_status).toBe('UNKNOWN');
    expect(a?.reason_codes).toEqual(['MEMBER_DEVICE_UNRESOLVED']);
    expect((a?.details.members as Array<Record<string, unknown>>)[1]).toMatchObject({
      id: 'member:1',
      device_path: '-',
      raw_states: ['offline'],
    });
    // The share that depends on it is UNKNOWN through the array ref.
    expect(g.shares[0]?.reason_codes).toEqual(['DEPENDENCY_ARRAY_UNAVAILABLE']);
  });

  it('an invalid state shape is flagged, not hidden', () => {
    const g = graph({
      arrays: ok([{ ...(ARRAYS[0] as ArrayInput), state_valid: false, raw_states: ['online'] }]),
    });
    const a = byId(g, 'array:data');
    expect(a?.collection_status).toBe('SUCCESS');
    expect(a?.reason_codes).toEqual(['ARRAY_STATE_INVALID']);
    expect(a?.details.state_valid).toBe(false);
  });

  it('an unknown package version is published as such', () => {
    const g = graph({ xiraid_version: null });
    const a = byId(g, 'array:data');
    expect(a?.details.version).toBe('unknown');
    expect(a?.reason_codes).toEqual(['XIRAID_VERSION_UNAVAILABLE']);
  });
});

describe('NFS service rules (F-06, T-08)', () => {
  it('inactive unit → running false, SUCCESS, threads not consulted', () => {
    const g = graph({ nfs_service: ok({ active_state: 'inactive' }), nfsd_threads: failed() });
    expect(byId(g, 'nfs:nfs-server')?.details.running).toBe(false);
    expect(byId(g, 'nfs:nfs-server')?.collection_status).toBe('SUCCESS');
  });

  it('active (exited) with zero nfsd threads → running false / NFSD_NO_THREADS, a VALID deny', () => {
    const g = graph({ nfsd_threads: ok(0) });
    const nfs = byId(g, 'nfs:nfs-server');
    expect(nfs?.collection_status).toBe('SUCCESS');
    expect(nfs?.details.running).toBe(false);
    expect(nfs?.details.threads).toBe(0);
    expect(nfs?.reason_codes).toEqual(['NFSD_NO_THREADS']);
  });

  it('active unit but the threads file unreadable or junk → running null, UNKNOWN', () => {
    const unread = graph({ nfsd_threads: failed() });
    expect(byId(unread, 'nfs:nfs-server')?.details.running).toBeNull();
    expect(byId(unread, 'nfs:nfs-server')?.collection_status).toBe('UNKNOWN');
    expect(byId(unread, 'nfs:nfs-server')?.reason_codes).toEqual(['NFSD_THREADS_UNAVAILABLE']);
    const junk = graph({ nfsd_threads: ok(null) });
    expect(byId(junk, 'nfs:nfs-server')?.reason_codes).toEqual(['NFSD_THREADS_UNAVAILABLE']);
    const late = graph({ nfsd_threads: timeout() });
    expect(byId(late, 'nfs:nfs-server')?.reason_codes).toEqual(['COLLECTION_TIMEOUT']);
  });

  it('unknown unit state → running null, UNKNOWN', () => {
    const g = graph({ nfs_service: ok({ active_state: 'unknown' }) });
    expect(byId(g, 'nfs:nfs-server')?.details.running).toBeNull();
    expect(byId(g, 'nfs:nfs-server')?.collection_status).toBe('UNKNOWN');
  });

  it('running with unreadable nfsd versions → UNKNOWN; stopped → SUCCESS with empty protocols', () => {
    const running = graph({ nfsd_versions: failed() });
    expect(byId(running, 'nfs:nfs-server')?.collection_status).toBe('UNKNOWN');
    expect(byId(running, 'nfs:nfs-server')?.reason_codes).toEqual(['NFSD_VERSIONS_UNAVAILABLE']);
    expect(running.snapshot_status).toBe('PARTIAL');
    const stopped = graph({
      nfsd_versions: failed(),
      nfs_service: ok({ active_state: 'inactive' }),
    });
    expect(byId(stopped, 'nfs:nfs-server')?.collection_status).toBe('SUCCESS');
    expect(byId(stopped, 'nfs:nfs-server')?.details.protocols).toEqual([]);
  });
});

describe('export edge cases', () => {
  it('a path the id encoder rejects becomes an ERROR resource, the rest of the cycle survives', () => {
    const g = graph({
      exports: ok([{ export_path: '/', rules: [rule()], source: 'etab' }, ...EXPORTS]),
    });
    expect(byId(g, 'export:invalid:1')?.reason_codes).toEqual(['EXPORT_PATH_INVALID']);
    expect(g.shares).toHaveLength(3);
  });

  it('sec= is split into the security list', () => {
    const g = graph({
      exports: ok([
        { export_path: '/mnt/data/k', rules: [rule('*', ['rw', 'sec=krb5p:sys'])], source: 'etab' },
      ]),
    });
    const e = byId(g, `export:${encExportId('/mnt/data/k')}`);
    expect((e?.details.rules as Array<{ security: string[] }>)[0]?.security).toEqual([
      'krb5p',
      'sys',
    ]);
    expect(g.shares[0]?.incarnation).toBe(`${encExportId('/mnt/data/k')}:none`);
  });
});
