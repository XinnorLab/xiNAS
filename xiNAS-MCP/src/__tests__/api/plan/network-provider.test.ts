import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlanEngine } from '../../../api/plan/engine.js';
import { netIfaceUpdateProvider } from '../../../api/plan/providers/network.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { runMigrations } from '../../../state/migrations.js';
import { XINAS_NETPLAN, parseNetplanFiles } from '../../../lib/parse/netplan.js';

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
  engine.register(netIfaceUpdateProvider);
  return { kv, store, engine };
}

function seedIface(
  kv: SqliteKvStore,
  name: string,
  over: { driver?: string; netplan?: Record<string, unknown>; duplicates?: string[] } = {},
): void {
  kv.put(`/xinas/v1/observed/NetworkInterface/${name}`, {
    kind: 'NetworkInterface',
    id: name,
    status: {
      name,
      driver: over.driver ?? 'mlx5_core',
      rdma_capable: (over.driver ?? 'mlx5_core').includes('mlx'),
      ...(over.netplan !== undefined ? { netplan: over.netplan } : {}),
      duplicates_detected_in: over.duplicates ?? [],
      observed_at: 'x',
    },
  });
}

function seedConfig(
  kv: SqliteKvStore,
  over: { world?: string; duplicates?: Record<string, string[]> } = {},
): void {
  kv.put('/xinas/v1/observed/NetworkConfig/default', {
    kind: 'NetworkConfig',
    id: 'default',
    status: {
      files: {},
      world_config_hash: over.world ?? 'w-1',
      xinas_file_hash: 'x-1',
      duplicates: over.duplicates ?? {},
      observed_at: 'x',
    },
  });
}

function planArgs(spec: Record<string, unknown>) {
  return {
    operation_kind: 'net.iface.update',
    spec,
    principal: 'admin:test',
    client_type: 'rest',
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

describe('netIfaceUpdateProvider', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    seedIface(h.kv, 'ibp65s0', {
      netplan: { addresses: ['10.10.1.1/24'], mtu: 4092, pbr_table_id: 100 },
    });
    seedIface(h.kv, 'ibp9s0f0', {
      netplan: { addresses: ['10.10.2.1/24'], pbr_table_id: 101 },
    });
    seedIface(h.kv, 'eno1', { driver: 'igb' });
    seedConfig(h.kv);
  });

  it('pre-adoption update: both managed ifaces adopted, singleton lease, rev-0 pin, full render', async () => {
    const { task, planResult } = await h.engine.plan(
      planArgs({ id: 'ibp65s0', addresses: ['10.10.5.1/24'] }),
    );
    expect(planResult.blockers).toEqual([]);
    expect(planResult.risk_level).toBe('changing_access');
    expect(planResult.rollback_model).toBe('non_disruptive');

    // per-resource pin: pre-adoption → revision 0
    expect(task.affected_resources).toEqual([
      { kind: 'NetworkInterface', id: 'ibp65s0', revision: 0 },
    ]);
    expect(task.state_revision_expected).toBe(0);

    // singleton lease + target + the OTHER adopted iface
    expect(planResult.lease_resources).toEqual([
      { kind: 'NetworkConfig', id: '99-xinas' },
      { kind: 'NetworkInterface', id: 'ibp65s0' },
      { kind: 'NetworkInterface', id: 'ibp9s0f0' },
    ]);

    // adoption seeds BOTH ifaces; target overlaid; tables preserved
    const mutations = planResult.desired_mutations ?? [];
    expect(mutations).toHaveLength(2);
    const target = mutations.find((m) => m.key.endsWith('/ibp65s0'));
    expect((target as { value: { spec: Record<string, unknown> } }).value.spec).toMatchObject({
      managed_by_xinas: true,
      addresses: ['10.10.5.1/24'],
      mtu: 4092,
      pbr_table_id: 100,
    });
    const other = mutations.find((m) => m.key.endsWith('/ibp9s0f0'));
    expect((other as { value: { spec: Record<string, unknown> } }).value.spec).toMatchObject({
      addresses: ['10.10.2.1/24'],
      pbr_table_id: 101,
    });

    // enriched spec: full render with BOTH stanzas + the world pin
    const persisted = h.store.get(task.task_id)?.spec as Record<string, unknown>;
    expect(persisted.world_config_hash).toBe('w-1');
    expect(persisted.surgical).toEqual({ dev: 'ibp65s0', pbr_table_id: 100 });
    const stanzas = parseNetplanFiles({ [XINAS_NETPLAN]: persisted.render as string }).stanzas;
    expect(stanzas.ibp65s0?.addresses).toEqual(['10.10.5.1/24']);
    expect(stanzas.ibp9s0f0?.addresses).toEqual(['10.10.2.1/24']);
    expect(stanzas.ibp9s0f0?.pbr_table_id).toBe(101);
  });

  it('post-adoption: pins the CURRENT desired revision; no re-adoption seeds for adopted ifaces', async () => {
    const put = h.kv.put('/xinas/v1/desired/NetworkInterface/ibp65s0', {
      kind: 'NetworkInterface',
      id: 'ibp65s0',
      spec: { managed_by_xinas: true, addresses: ['10.10.1.1/24'], enabled: true, pbr_table_id: 100 },
    });
    const rev = put.ok ? put.value.revision : 0;

    const { task, planResult } = await h.engine.plan(planArgs({ id: 'ibp65s0', mtu: 9000 }));
    expect(task.affected_resources).toEqual([
      { kind: 'NetworkInterface', id: 'ibp65s0', revision: rev },
    ]);
    // ibp9s0f0 still unadopted → still seeded + leased
    expect((planResult.desired_mutations ?? []).some((m) => m.key.endsWith('/ibp9s0f0'))).toBe(true);
  });

  it('duplicates: blocked without cleanup; cleanup → warning + cleanup_files', async () => {
    seedConfig(h.kv, { duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] } });
    const blocked = await h.engine.plan(planArgs({ id: 'ibp65s0', addresses: ['10.10.5.1/24'] }));
    expect(blocked.planResult.blockers.map((b) => b.code)).toEqual([
      'duplicate_netplan_definition',
    ]);

    const repaired = await h.engine.plan(
      planArgs({ id: 'ibp65s0', addresses: ['10.10.5.1/24'], cleanup: true }),
    );
    expect(repaired.planResult.blockers).toEqual([]);
    expect(repaired.planResult.warnings.map((w) => w.code)).toContain('netplan_cleanup_planned');
    const persisted = h.store.get(repaired.task.task_id)?.spec as Record<string, unknown>;
    expect(persisted.cleanup_files).toEqual({ ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] });
  });

  it('management ethernet → UNSUPPORTED iface_not_managed; unknown → NOT_FOUND', async () => {
    await expect(h.engine.plan(planArgs({ id: 'eno1', mtu: 9000 }))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'iface_not_managed' },
    });
    await expect(h.engine.plan(planArgs({ id: 'ghost', mtu: 9000 }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('nfs sessions present → warning; address conflict → blocker', async () => {
    h.kv.put('/xinas/v1/observed/NfsSession/s1', {
      kind: 'NfsSession',
      id: 's1',
      spec: { client_addr: '10.0.0.1', export_path: '/mnt/x' },
      status: { proto_version: 'v4.2', locked_files: 0 },
    });
    const { planResult } = await h.engine.plan(
      planArgs({ id: 'ibp65s0', addresses: ['10.10.2.1/24'] }), // ibp9s0f0's address
    );
    expect(planResult.warnings.map((w) => w.code)).toContain('nfs_sessions_may_drop');
    expect(planResult.blockers.map((b) => b.code)).toContain('address_conflict');
  });

  it('re-parses its own enriched spec (apply re-check contract)', async () => {
    const first = await h.engine.plan(planArgs({ id: 'ibp65s0', addresses: ['10.10.5.1/24'] }));
    const persisted = h.store.get(first.task.task_id)?.spec as Record<string, unknown>;
    const again = await h.engine.plan(planArgs(persisted));
    expect(again.planResult.blockers).toEqual([]);
  });
});
