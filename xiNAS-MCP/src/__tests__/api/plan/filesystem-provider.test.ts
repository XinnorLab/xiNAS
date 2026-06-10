import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlanEngine } from '../../../api/plan/engine.js';
import { fsCreateProvider } from '../../../api/plan/providers/filesystem.js';
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
