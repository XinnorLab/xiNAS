import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../api/errors.js';
import { PlanEngine } from '../../../api/plan/engine.js';
import { xiraidArrayCreateProvider } from '../../../api/plan/providers/xiraid-array.js';
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
  return { kv, store, engine };
}

function seedDisk(
  kv: SqliteKvStore,
  id: string,
  over: Record<string, unknown> = {},
): void {
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

  it('blockers: name taken / system disk / unknown disk / claimed disk / double-booked spare', async () => {
    h.kv.put('/xinas/v1/observed/XiraidArray/taken', {
      kind: 'XiraidArray',
      id: 'taken',
      spec: { name: 'taken', level: 'raid1', member_disk_ids: ['nvme4n1'] },
      status: { state: 'optimal', volume_path: '/dev/xi_taken' },
    });
    seedDisk(h.kv, 'sysdisk', { system_disk: true, safe_for_use: false });

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...GOOD_SPEC, name: 'taken' }, 'name_taken'],
      [{ ...GOOD_SPEC, member_disk_ids: ['sysdisk', 'nvme1n1', 'nvme2n1', 'nvme3n1'] }, 'disk_is_system'],
      [{ ...GOOD_SPEC, member_disk_ids: ['ghost', 'nvme1n1', 'nvme2n1', 'nvme3n1'] }, 'disk_not_found'],
      [{ ...GOOD_SPEC, member_disk_ids: ['nvme4n1', 'nvme1n1', 'nvme2n1', 'nvme3n1'] }, 'disk_in_use'],
      // S4: spare_pool_deferred is gone — a spare double-booked with a
      // member of this very spec reads as disk_in_use instead.
      [{ ...GOOD_SPEC, spare_disk_ids: ['nvme1n1'] }, 'disk_in_use'],
    ];
    for (const [spec, code] of cases) {
      const { planResult } = await h.engine.plan(planArgs(spec));
      expect(planResult.blockers.map((b) => b.code), `expected ${code}`).toContain(code);
    }
  });

  it('structural junk → INVALID_ARGUMENT ApiException', async () => {
    await expect(h.engine.plan(planArgs({ name: 'x' }))).rejects.toThrowError(ApiException);
    await expect(h.engine.plan(planArgs({ name: 'x' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
