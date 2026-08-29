import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../api/errors.js';
import { PlanEngine } from '../../../api/plan/engine.js';
import {
  xiraidArrayCreateProvider,
  xiraidArrayDeleteProvider,
  xiraidArrayImportProvider,
  xiraidArrayModifyProvider,
} from '../../../api/plan/providers/xiraid-array.js';
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
  engine.register(xiraidArrayCreateProvider);
  engine.register(xiraidArrayModifyProvider);
  engine.register(xiraidArrayImportProvider);
  engine.register(xiraidArrayDeleteProvider);
  return { kv, store, engine };
}

function seedArray(
  kv: SqliteKvStore,
  name: string,
  over: { member_disk_ids?: string[]; spare_pool?: string } = {},
): void {
  kv.put(`/xinas/v1/observed/XiraidArray/${name}`, {
    kind: 'XiraidArray',
    id: name,
    spec: {
      name,
      level: 'raid6',
      member_disk_ids: over.member_disk_ids ?? ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1'],
      // Observed-only join (the pool's drives resolved to Disk ids); the
      // collector emits it, no writer may send it.
      spare_disk_ids: [],
      ...(over.spare_pool !== undefined ? { spare_pool: over.spare_pool } : {}),
    },
    status: {
      state: 'optimal',
      volume_path: `/dev/xi_${name}`,
      ...(over.spare_pool !== undefined ? { spare_pool: over.spare_pool } : {}),
      observed_at: '2026-06-10T12:00:00Z',
    },
  });
}

/** An observed spare pool, as the Pool collector writes it (id = name). */
function seedPool(
  kv: SqliteKvStore,
  name: string,
  over: { drives?: string[]; active?: boolean } = {},
): void {
  kv.put(`/xinas/v1/observed/Pool/${name}`, {
    kind: 'Pool',
    id: name,
    status: {
      name,
      drives: over.drives ?? ['/dev/nvme5n1'],
      active: over.active ?? true,
      observed_at: '2026-06-10T12:00:00Z',
    },
  });
}

function seedDisk(kv: SqliteKvStore, id: string, over: Record<string, unknown> = {}): void {
  kv.put(`/xinas/v1/observed/Disk/${id}`, {
    kind: 'Disk',
    id,
    status: {
      name: id,
      device_path: `/dev/${id}`,
      safe_for_use: true,
      system_disk: false,
      mounted: false,
      observed_at: '2026-06-10T12:00:00Z',
      ...over,
    },
  });
}

function planArgs(spec: Record<string, unknown>) {
  return {
    operation_kind: 'xiraid.array.create',
    spec,
    principal: 'admin:test',
    client_type: 'rest',
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

const GOOD_SPEC = {
  name: 'data',
  level: 'raid6',
  member_disk_ids: ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1'],
};

describe('xiraidArrayCreateProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    for (const d of ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1']) seedDisk(h.kv, d);
  });

  it('valid spec → no blockers, array first + member disks leased, enriched spec persisted', async () => {
    const { task, planResult } = await h.engine.plan(planArgs(GOOD_SPEC));

    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(planResult.rollback_model).toBe('non_disruptive');
    expect(planResult.state_revision_expected).toBeUndefined();

    expect(task.affected_resources[0]).toEqual({ kind: 'XiraidArray', id: 'data' });
    expect(task.affected_resources.slice(1)).toEqual([
      { kind: 'Disk', id: 'nvme1n1' },
      { kind: 'Disk', id: 'nvme2n1' },
      { kind: 'Disk', id: 'nvme3n1' },
      { kind: 'Disk', id: 'nvme4n1' },
    ]);

    // The persisted spec carries the resolved device map (ADR-0006).
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted.device_by_id).toEqual({
      nvme1n1: '/dev/nvme1n1',
      nvme2n1: '/dev/nvme2n1',
      nvme3n1: '/dev/nvme3n1',
      nvme4n1: '/dev/nvme4n1',
    });

    // diff previews the rendered gRPC request.
    expect((planResult.diff as Record<string, unknown>).raid_create_request).toMatchObject({
      name: 'data',
      level: '6',
      drives: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
    });
  });

  it('blockers: name taken / system disk / unknown disk / claimed disk', async () => {
    h.kv.put('/xinas/v1/observed/XiraidArray/taken', {
      kind: 'XiraidArray',
      id: 'taken',
      spec: { name: 'taken', level: 'raid1', member_disk_ids: ['nvme4n1'] },
      status: { state: 'optimal', volume_path: '/dev/xi_taken' },
    });
    seedDisk(h.kv, 'sysdisk', { system_disk: true, safe_for_use: false });

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...GOOD_SPEC, name: 'taken' }, 'name_taken'],
      [
        { ...GOOD_SPEC, member_disk_ids: ['sysdisk', 'nvme1n1', 'nvme2n1', 'nvme3n1'] },
        'disk_is_system',
      ],
      [
        { ...GOOD_SPEC, member_disk_ids: ['ghost', 'nvme1n1', 'nvme2n1', 'nvme3n1'] },
        'disk_not_found',
      ],
      [
        { ...GOOD_SPEC, member_disk_ids: ['nvme4n1', 'nvme1n1', 'nvme2n1', 'nvme3n1'] },
        'disk_in_use',
      ],
    ];
    for (const [spec, code] of cases) {
      const { planResult } = await h.engine.plan(planArgs(spec));
      expect(
        planResult.blockers.map((b) => b.code),
        `expected ${code}`,
      ).toContain(code);
    }
  });

  it('create-with-pool: the POOL is leased, its drives are not, and none reach device_by_id', async () => {
    seedDisk(h.kv, 'nvme5n1');
    seedPool(h.kv, 'sp01', { drives: ['/dev/nvme5n1'] });
    const { task, planResult } = await h.engine.plan(
      planArgs({ ...GOOD_SPEC, spare_pool: 'sp01' }),
    );
    expect(planResult.blockers).toEqual([]);
    expect(task.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp01' });
    expect(task.affected_resources).not.toContainEqual({ kind: 'Disk', id: 'nvme5n1' });

    // device_by_id carries MEMBERS only — the pool's drives belong to the
    // pool surface, and the executor never resolves them.
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(Object.keys(persisted.device_by_id as Record<string, string>)).toEqual(
      GOOD_SPEC.member_disk_ids,
    );
    expect(persisted.spare_pool).toBe('sp01');
    expect(
      (planResult.diff as { raid_create_request?: { sparepool?: string } }).raid_create_request
        ?.sparepool,
    ).toBe('sp01');
  });

  it('blockers: spare_pool_not_found for an unknown name, spare_pool_empty for a drive-less pool', async () => {
    seedPool(h.kv, 'empty', { drives: [] });
    const ghost = await h.engine.plan(planArgs({ ...GOOD_SPEC, spare_pool: 'ghost' }));
    expect(ghost.planResult.blockers.map((b) => b.code)).toContain('spare_pool_not_found');
    const empty = await h.engine.plan(planArgs({ ...GOOD_SPEC, spare_pool: 'empty' }));
    expect(empty.planResult.blockers.map((b) => b.code)).toContain('spare_pool_empty');
  });

  it('structural junk → INVALID_ARGUMENT ApiException; spare_disk_ids is rejected on write', async () => {
    await expect(h.engine.plan(planArgs({ name: 'x' }))).rejects.toThrowError(ApiException);
    await expect(h.engine.plan(planArgs({ name: 'x' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    // The retired write field: a stale client sending disk ids must not be
    // silently accepted (2026-08-29 field failure).
    await expect(
      h.engine.plan(planArgs({ ...GOOD_SPEC, spare_disk_ids: ['nvme5n1'] })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('xiraidArrayModifyProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    for (const d of ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1', 'nvme5n1', 'nvme6n1']) {
      seedDisk(h.kv, d);
    }
    seedArray(h.kv, 'data');
  });

  function modifyArgs(spec: Record<string, unknown>) {
    return { ...planArgs(spec), operation_kind: 'xiraid.array.modify' };
  }

  it('leases the referenced pool instead of its drives', async () => {
    seedPool(h.kv, 'sp01', { drives: ['/dev/nvme5n1'], active: true });
    const { task, planResult } = await h.engine.plan(
      modifyArgs({ id: 'data', spare_pool: 'sp01', tuning: { init_prio: 10 } }),
    );
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(planResult.rollback_model).toBe('non_disruptive');
    expect(planResult.observed_revision_expected).toBeUndefined(); // route binds freshness (S4 §4)
    expect(task.affected_resources[0]).toEqual({ kind: 'XiraidArray', id: 'data' });
    expect(task.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp01' });
    // The pool's drives are the POOL's business now — leasing them here
    // would serialize against unrelated array work and miss the pool.
    expect(task.affected_resources.some((r) => r.kind === 'Disk')).toBe(false);

    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted.id).toBe('data');
    expect(persisted.spare_pool).toBe('sp01');
    expect(persisted.device_by_id).toEqual({});

    const diff = planResult.diff as Record<string, Record<string, unknown>>;
    expect(diff.before?.spare_pool).toBeNull();
    expect(diff.after?.spare_pool).toBe('sp01');
  });

  it('blocks a modify naming an unknown pool', async () => {
    const { planResult } = await h.engine.plan(modifyArgs({ id: 'data', spare_pool: 'ghost' }));
    expect(planResult.blockers.map((b) => b.code)).toContain('spare_pool_not_found');
  });

  it('re-point: both the target and the currently-attached pool are leased', async () => {
    seedArray(h.kv, 'data', { spare_pool: 'sp01' });
    seedPool(h.kv, 'sp01', { drives: ['/dev/nvme5n1'] });
    seedPool(h.kv, 'sp02', { drives: ['/dev/nvme6n1'] });
    const { task, planResult } = await h.engine.plan(
      modifyArgs({ id: 'data', spare_pool: 'sp02' }),
    );
    expect(planResult.blockers).toEqual([]);
    expect(task.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp02' });
    expect(task.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp01' });
    expect((planResult.diff as Record<string, Record<string, unknown>>).before?.spare_pool).toBe(
      'sp01',
    );
  });

  it('detach (null): the currently-attached pool is still leased', async () => {
    seedArray(h.kv, 'data', { spare_pool: 'sp01' });
    seedPool(h.kv, 'sp01', { drives: ['/dev/nvme5n1'] });
    const { task, planResult } = await h.engine.plan(modifyArgs({ id: 'data', spare_pool: null }));
    expect(planResult.blockers).toEqual([]);
    expect(task.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp01' });
    expect(
      (planResult.diff as Record<string, Record<string, unknown>>).after?.spare_pool,
    ).toBeNull();
  });

  it('unknown array id → NOT_FOUND; junk spec → INVALID_ARGUMENT', async () => {
    await expect(h.engine.plan(modifyArgs({ id: 'ghost', tuning: {} }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(h.engine.plan(modifyArgs({ id: 'data', spare_pool: 42 }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('re-parses its own enriched spec (apply re-check contract)', async () => {
    seedPool(h.kv, 'sp01', { drives: ['/dev/nvme5n1'] });
    const first = await h.engine.plan(
      modifyArgs({ id: 'data', spare_pool: 'sp01', tuning: { init_prio: 10 } }),
    );
    const persisted = h.store.get(first.task.task_id)?.spec as Record<string, unknown>;
    const again = await h.engine.plan(modifyArgs(persisted));
    expect(again.planResult.blockers).toEqual([]);
  });
});

describe('xiraidArrayImportProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'taken');
  });

  function importArgs(spec: Record<string, unknown>) {
    return { ...planArgs(spec), operation_kind: 'xiraid.array.import' };
  }

  it('adopt plan: target name = new_name ?? uuid; single array resource; enriched spec', async () => {
    const { task, planResult } = await h.engine.plan(
      importArgs({ uuid: 'u-1', new_name: 'adopted' }),
    );
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(task.affected_resources).toEqual([{ kind: 'XiraidArray', id: 'adopted' }]);
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted).toEqual({ uuid: 'u-1', new_name: 'adopted' });
    expect((planResult.diff as Record<string, unknown>).adopt).toEqual({
      uuid: 'u-1',
      as: 'adopted',
    });
  });

  it('blockers: name_taken; name_invalid when the uuid itself is not a usable name', async () => {
    const taken = await h.engine.plan(importArgs({ uuid: 'u-2', new_name: 'taken' }));
    expect(taken.planResult.blockers.map((b) => b.code)).toContain('name_taken');
    // no new_name → the uuid becomes the target id; uuids with dots fail NAME_RE
    const bad = await h.engine.plan(importArgs({ uuid: 'uuid.with.dots' }));
    expect(bad.planResult.blockers.map((b) => b.code)).toContain('name_invalid');
  });

  it('empty/missing uuid → INVALID_ARGUMENT', async () => {
    await expect(h.engine.plan(importArgs({ new_name: 'x' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(h.engine.plan(importArgs({ uuid: '' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('xiraidArrayDeleteProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedArray(h.kv, 'data');
  });

  function deleteArgs(spec: Record<string, unknown>) {
    return { ...planArgs(spec), operation_kind: 'xiraid.array.delete' };
  }

  function seedDeps(): void {
    // LIVE collector shape: status-only, NO spec (S4 review P1).
    h.kv.put('/xinas/v1/observed/Filesystem/fs1', {
      kind: 'Filesystem',
      id: 'fs1',
      status: {
        backing_device: '/dev/xi_data',
        mountpoint: '/mnt/d',
        mounted: true,
        observed_at: '2026-06-10T12:00:00Z',
      },
    });
    h.kv.put('/xinas/v1/desired/Share/s1', {
      kind: 'Share',
      id: 's1',
      spec: { path: '/mnt/d/share', clients: [], fsid: 1 },
    });
    h.kv.put('/xinas/v1/observed/NfsSession/10.0.0.1:s1', {
      kind: 'NfsSession',
      id: '10.0.0.1:s1',
      spec: { client_addr: '10.0.0.1', export_path: '/mnt/d/share' },
      status: { observed_at: '2026-06-10T12:00:00Z' },
    });
  }

  it('clean array → blockers = exactly [dangerous_flag_required]; destructive/unsupported', async () => {
    const { task, planResult } = await h.engine.plan(deleteArgs({ id: 'data' }));
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
    expect(planResult.risk_level).toBe('destructive');
    expect(planResult.rollback_model).toBe('unsupported');
    expect(task.affected_resources).toEqual([{ kind: 'XiraidArray', id: 'data' }]);
    const diff = planResult.diff as Record<string, unknown>;
    expect((diff.destroys as Record<string, unknown>).volume_path).toBe('/dev/xi_data');
  });

  it('dependents: mounted fs + active share session → blockers + leases + blast radius', async () => {
    seedDeps();
    const { task, planResult } = await h.engine.plan(deleteArgs({ id: 'data' }));
    const codes = planResult.blockers.map((b) => b.code);
    expect(codes).toContain('dangerous_flag_required');
    expect(codes).toContain('dependent_filesystem_mounted');
    expect(codes).toContain('dependent_share_active');
    expect(task.affected_resources).toEqual([
      { kind: 'XiraidArray', id: 'data' },
      { kind: 'Filesystem', id: 'fs1' },
      { kind: 'Share', id: 's1' },
    ]);
    const diff = planResult.diff as Record<string, unknown[]>;
    expect(diff.dependent_filesystems).toHaveLength(1);
    expect(diff.dependent_shares).toHaveLength(1);
    expect(diff.active_sessions).toHaveLength(1);
  });

  it('unmounted dependent fs is blast radius but not a blocker', async () => {
    h.kv.put('/xinas/v1/observed/Filesystem/fs2', {
      kind: 'Filesystem',
      id: 'fs2',
      status: {
        backing_device: '/dev/xi_data',
        mountpoint: '/mnt/d2',
        mounted: false,
        observed_at: '2026-06-10T12:00:00Z',
      },
    });
    const { planResult } = await h.engine.plan(deleteArgs({ id: 'data' }));
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
    expect((planResult.diff as Record<string, unknown[]>).dependent_filesystems).toHaveLength(1);
  });

  it('unknown array → NOT_FOUND', async () => {
    await expect(h.engine.plan(deleteArgs({ id: 'ghost' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
