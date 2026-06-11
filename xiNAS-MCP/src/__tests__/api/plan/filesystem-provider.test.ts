import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlanEngine } from '../../../api/plan/engine.js';
import {
  fsCreateProvider,
  fsGrowProvider,
  fsMountProvider,
  fsSetQuotaModeProvider,
  fsUnmanageProvider,
  fsUnmountProvider,
} from '../../../api/plan/providers/filesystem.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { runMigrations } from '../../../state/migrations.js';

function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);
  let idCounter = 0;
  const store = new TaskStore({
    db,
    now: () => 1_000,
    newId: () => `task-${String(++idCounter).padStart(4, '0')}`,
  });
  const engine = new PlanEngine({ store, ctx: { kv } });
  engine.register(fsCreateProvider);
  engine.register(fsMountProvider);
  engine.register(fsUnmountProvider);
  engine.register(fsGrowProvider);
  engine.register(fsSetQuotaModeProvider);
  engine.register(fsUnmanageProvider);
  return { kv, store, engine };
}

function seedArray(kv: SqliteKvStore, name: string, over: Record<string, unknown> = {}): void {
  kv.put(`/xinas/v1/observed/XiraidArray/${name}`, {
    kind: 'XiraidArray',
    id: name,
    spec: {
      name,
      level: 'raid5',
      member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
      strip_size_kib: 128,
      ...over,
    },
    status: { state: 'optimal', volume_path: `/dev/xi_${name}`, observed_at: '2026-06-10T12:00:00Z' },
  });
}

function planArgs(spec: Record<string, unknown>) {
  return {
    operation_kind: 'fs.create',
    spec,
    principal: 'admin:test',
    client_type: 'rest',
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

const GOOD = {
  backing_device: '/dev/xi_data',
  mountpoint: '/mnt/data',
  log_device: '/dev/xi_log',
  log_size: '1G',
};

describe('fsCreateProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'data');
    seedArray(h.kv, 'log', { level: 'raid10', member_disk_ids: ['e', 'f'], strip_size_kib: 16 });
  });

  it('valid spec → fs + both arrays leased; resolved mkfs inputs in the enriched spec', async () => {
    const { task, planResult } = await h.engine.plan(planArgs(GOOD));
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(planResult.rollback_model).toBe('non_disruptive');
    expect(task.affected_resources).toEqual([
      { kind: 'Filesystem', id: 'mnt-data.mount' },
      { kind: 'XiraidArray', id: 'data' },
      { kind: 'XiraidArray', id: 'log' },
    ]);

    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted.unit_name).toBe('mnt-data.mount');
    expect(persisted.resolved).toEqual({
      device: '/dev/xi_data',
      label: 'data',
      su_kb: 128,
      sw: 3,
      sector_size: 4096,
      log_device: '/dev/xi_log',
      log_size_bytes: 1073741824,
    });
    expect(persisted.unit_text).toContain('Where=/mnt/data');

    const diff = planResult.diff as Record<string, unknown>;
    expect(diff.mkfs_argv_preview).toEqual([
      '-f',
      '-L',
      'data',
      '-d',
      'su=128k,sw=3',
      '-l',
      'logdev=/dev/xi_log,size=1073741824',
      '-s',
      'size=4096',
      '/dev/xi_data',
    ]);
  });

  it('force:true → destructive + the advisory blocker only', async () => {
    const { planResult } = await h.engine.plan(planArgs({ ...GOOD, force: true }));
    expect(planResult.risk_level).toBe('destructive');
    expect(planResult.rollback_model).toBe('unsupported');
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
  });

  it('blockers reachable through the provider', async () => {
    h.kv.put('/xinas/v1/observed/Filesystem/mnt-data.mount', {
      kind: 'Filesystem',
      id: 'mnt-data.mount',
      status: { mountpoint: '/mnt/data', backing_device: '/dev/xi_old', observed_at: 'x' },
    });
    const { planResult } = await h.engine.plan(planArgs(GOOD));
    expect(planResult.blockers.map((b) => b.code)).toContain('mountpoint_taken');

    const notArray = await h.engine.plan(planArgs({ ...GOOD, backing_device: '/dev/sda' }));
    expect(notArray.planResult.blockers.map((b) => b.code)).toContain('backing_array_not_found');
  });

  it('re-parses its own enriched spec (apply re-check contract)', async () => {
    const first = await h.engine.plan(planArgs(GOOD));
    const persisted = h.store.get(first.task.task_id)?.spec as Record<string, unknown>;
    const again = await h.engine.plan(planArgs(persisted));
    expect(again.planResult.blockers).toEqual([]);
  });

  it('junk spec → INVALID_ARGUMENT', async () => {
    await expect(h.engine.plan(planArgs({ mountpoint: '/x' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

// ---- T9: mount / unmount providers ----

function seedFs(
  kv: SqliteKvStore,
  id: string,
  status: Record<string, unknown>,
): void {
  kv.put(`/xinas/v1/observed/Filesystem/${id}`, { kind: 'Filesystem', id, status });
}

describe('fsMountProvider / fsUnmountProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'data');
    seedFs(h.kv, 'mnt-data.mount', {
      mountpoint: '/mnt/data',
      backing_device: '/dev/xi_data',
      mounted: false,
      observed_at: 'x',
    });
  });

  const args = (kind: string, spec: Record<string, unknown>) => ({
    ...planArgs(spec),
    operation_kind: kind,
  });

  it('mount: fs + backing array leased; enriched spec carries the mountpoint', async () => {
    const { task, planResult } = await h.engine.plan(args('fs.mount', { id: 'mnt-data.mount' }));
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(task.affected_resources).toEqual([
      { kind: 'Filesystem', id: 'mnt-data.mount' },
      { kind: 'XiraidArray', id: 'data' },
    ]);
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted).toMatchObject({ id: 'mnt-data.mount', mounted: true, mountpoint: '/mnt/data' });
  });

  it('mount: failed backing array → backing_array_unhealthy; already mounted → warning', async () => {
    h.kv.put('/xinas/v1/observed/XiraidArray/data', {
      kind: 'XiraidArray',
      id: 'data',
      spec: { name: 'data', level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3', 'd4'] },
      status: { state: 'failed', volume_path: '/dev/xi_data', observed_at: 'x' },
    });
    const { planResult } = await h.engine.plan(args('fs.mount', { id: 'mnt-data.mount' }));
    expect(planResult.blockers.map((b) => b.code)).toEqual(['backing_array_unhealthy']);

    seedFs(h.kv, 'mnt-up.mount', {
      mountpoint: '/mnt/up',
      backing_device: '/dev/none',
      mounted: true,
      observed_at: 'x',
    });
    const up = await h.engine.plan(args('fs.mount', { id: 'mnt-up.mount' }));
    expect(up.planResult.warnings.map((w) => w.code)).toContain('fs_already_mounted');
  });

  it('unmount: sessions + exports under the mountpoint block; shares are blast radius', async () => {
    seedFs(h.kv, 'mnt-data.mount', {
      mountpoint: '/mnt/data',
      backing_device: '/dev/xi_data',
      mounted: true,
      observed_at: 'x',
    });
    h.kv.put('/xinas/v1/observed/NfsSession/s1', {
      kind: 'NfsSession',
      id: 's1',
      spec: { client_addr: '10.0.0.1', export_path: '/mnt/data/share' },
      status: { proto_version: 'v4.2', locked_files: 0 },
    });
    // N0b shape: the observed id is encExportId(path); the real path lives
    // in spec.export_path (what the provider reads).
    h.kv.put('/xinas/v1/observed/ExportRule/mnt-data-share', {
      kind: 'ExportRule',
      id: 'mnt-data-share',
      spec: { export_path: '/mnt/data/share' },
      status: {},
    });
    h.kv.put('/xinas/v1/desired/Share/share01', {
      kind: 'Share',
      id: 'share01',
      spec: { path: '/mnt/data/share' },
    });

    const { planResult } = await h.engine.plan(args('fs.unmount', { id: 'mnt-data.mount' }));
    expect(planResult.blockers.map((b) => b.code).sort()).toEqual([
      'dependent_share_active',
      'mountpoint_exported',
    ]);
    expect(planResult.risk_level).toBe('changing_access');
    expect((planResult.diff as { blast_radius?: unknown[] }).blast_radius).toEqual([
      { kind: 'Share', id: 'share01', path: '/mnt/data/share' },
    ]);
  });

  it('unmount of a quiet fs → no blockers; unknown id → NOT_FOUND', async () => {
    const { planResult } = await h.engine.plan(args('fs.unmount', { id: 'mnt-data.mount' }));
    expect(planResult.blockers).toEqual([]);
    await expect(h.engine.plan(args('fs.unmount', { id: 'ghost.mount' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ---- T10: grow / quota providers ----

describe('fsGrowProvider / fsSetQuotaModeProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'data');
    seedFs(h.kv, 'mnt-data.mount', {
      mountpoint: '/mnt/data',
      backing_device: '/dev/xi_data',
      mounted: true,
      observed_at: 'x',
    });
  });

  const args = (kind: string, spec: Record<string, unknown>) => ({
    ...planArgs(spec),
    operation_kind: kind,
  });

  it('grow: mounted → ok (rollback unsupported); unmounted → fs_not_mounted', async () => {
    const ok = await h.engine.plan(args('fs.grow', { id: 'mnt-data.mount', grow: true }));
    expect(ok.planResult.blockers).toEqual([]);
    expect(ok.planResult.rollback_model).toBe('unsupported');
    const persisted = h.store.get(ok.task.task_id)?.spec as Record<string, unknown>;
    expect(persisted).toMatchObject({ id: 'mnt-data.mount', grow: true, mountpoint: '/mnt/data' });

    seedFs(h.kv, 'mnt-down.mount', {
      mountpoint: '/mnt/down',
      backing_device: '/dev/none',
      mounted: false,
      observed_at: 'x',
    });
    const down = await h.engine.plan(args('fs.grow', { id: 'mnt-down.mount', grow: true }));
    expect(down.planResult.blockers.map((b) => b.code)).toEqual(['fs_not_mounted']);
  });

  it('quota: disruptive with the remount warning; bad mode → INVALID_ARGUMENT', async () => {
    const { task, planResult } = await h.engine.plan(
      args('fs.set_quota_mode', { id: 'mnt-data.mount', quota_mode: 'pquota' }),
    );
    expect(planResult.risk_level).toBe('changing_access');
    expect(planResult.warnings.map((w) => w.code)).toContain('remount_required');
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted).toMatchObject({ quota_mode: 'pquota', mountpoint: '/mnt/data' });

    await expect(
      h.engine.plan(args('fs.set_quota_mode', { id: 'mnt-data.mount', quota_mode: 'bogus' })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

// ---- T11: unmanage provider ----

describe('fsUnmanageProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'data');
  });

  it('mounted → fs_mounted blocker; unmounted → non-destructive plan with the data warning', async () => {
    seedFs(h.kv, 'mnt-data.mount', {
      mountpoint: '/mnt/data',
      backing_device: '/dev/xi_data',
      mounted: true,
      observed_at: 'x',
    });
    const planArgsFor = (spec: Record<string, unknown>) => ({
      ...planArgs(spec),
      operation_kind: 'fs.unmanage',
    });
    const mounted = await h.engine.plan(planArgsFor({ id: 'mnt-data.mount' }));
    expect(mounted.planResult.blockers.map((b) => b.code)).toEqual(['fs_mounted']);

    seedFs(h.kv, 'mnt-data.mount', {
      mountpoint: '/mnt/data',
      backing_device: '/dev/xi_data',
      mounted: false,
      observed_at: 'x',
    });
    const { task, planResult } = await h.engine.plan(planArgsFor({ id: 'mnt-data.mount' }));
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(planResult.warnings.map((w) => w.code)).toContain('data_left_in_place');
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted).toEqual({ id: 'mnt-data.mount', mountpoint: '/mnt/data' });
  });
});
