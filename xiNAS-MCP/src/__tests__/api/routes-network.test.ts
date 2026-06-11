import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('network routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /network/interfaces lists interfaces', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', {
      kind: 'NetworkInterface',
      id: 'ibp0s4',
      spec: { managed_by_xinas: true, addresses: ['10.0.0.1/24'] },
      status: {
        driver: 'mlx5_ib',
        rdma_capable: true,
        link_state: 'up',
        current_addresses: ['10.0.0.1/24'],
      },
    });
    const res = await request(setup.app)
      .get('/api/v1/network/interfaces')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });

  it('GET /network/interfaces/{id} returns the interface', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', {
      kind: 'NetworkInterface',
      id: 'ibp0s4',
    });
    const res = await request(setup.app)
      .get('/api/v1/network/interfaces/ibp0s4')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('ibp0s4');
  });

  it('GET /network returns a summary envelope', async () => {
    const res = await request(setup.app).get('/api/v1/network').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('GET /service-ips returns empty in Phase 0', async () => {
    const res = await request(setup.app)
      .get('/api/v1/service-ips')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});

// ---- S6 T6: merged reads + PATCH /network/interfaces/:id ----

import { type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

describe('network routes (S6 merged reads + PATCH)', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp65s0', {
      kind: 'NetworkInterface',
      id: 'ibp65s0',
      status: {
        name: 'ibp65s0',
        driver: 'mlx5_core',
        rdma_capable: true,
        netplan: { addresses: ['10.10.1.1/24'], pbr_table_id: 100 },
        duplicates_detected_in: [],
        observed_at: 'x',
      },
    });
    setup.state.kv.put('/xinas/v1/observed/NetworkConfig/default', {
      kind: 'NetworkConfig',
      id: 'default',
      status: {
        files: {},
        world_config_hash: 'w-1',
        xinas_file_hash: 'x-1',
        duplicates: {},
        observed_at: 'x',
      },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  async function patchIface(body: Record<string, unknown>) {
    return request(setup.app)
      .patch('/api/v1/network/interfaces/ibp65s0')
      .set('Authorization', ADMIN_TOKEN)
      .send(body);
  }

  it('merged reads: spec-less before adoption; desired spec + revision after', async () => {
    const before = await request(setup.app)
      .get('/api/v1/network/interfaces/ibp65s0')
      .set('Authorization', ADMIN_TOKEN);
    expect(before.status).toBe(200);
    expect(before.body.result.spec).toBeUndefined();

    const put = setup.state.kv.put('/xinas/v1/desired/NetworkInterface/ibp65s0', {
      kind: 'NetworkInterface',
      id: 'ibp65s0',
      spec: { managed_by_xinas: true, addresses: ['10.10.1.1/24'], enabled: true, pbr_table_id: 100 },
    });
    const rev = put.ok ? put.value.revision : 0;

    const after = await request(setup.app)
      .get('/api/v1/network/interfaces/ibp65s0')
      .set('Authorization', ADMIN_TOKEN);
    expect(after.body.result.spec).toMatchObject({ pbr_table_id: 100 });
    expect(after.body.result.metadata.revision).toBe(rev);

    const list = await request(setup.app)
      .get('/api/v1/network/interfaces')
      .set('Authorization', ADMIN_TOKEN);
    expect(list.body.result[0]?.spec).toMatchObject({ pbr_table_id: 100 });
  });

  it('identity keys → 422 net_identity_immutable before any plan', async () => {
    const res = await patchIface({ mode: 'plan', spec: { pbr_table_id: 105 } });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].details?.reason).toBe('net_identity_immutable');
    expect(res.body.errors[0].details?.field).toBe('pbr_table_id');
  });

  it('plan → apply happy path: adoption mutations land, singleton leased, render dispatched', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-net' });
    const planned = await patchIface({ mode: 'plan', spec: { addresses: ['10.10.5.1/24'] } });
    expect(planned.status).toBe(200);
    expect(planned.body.result.blockers).toEqual([]);
    expect(planned.body.result.state_revision_expected).toBe(0);

    const res = await patchIface({
      mode: 'apply',
      plan_id: planned.body.result.plan_id,
      expected_revision: 0,
      idempotency_key: 'idem-net-1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.result.kind).toBe('net.iface.update');
    expect(res.body.result.state).toBe('running');

    const desired = setup.state.kv.get('/xinas/v1/desired/NetworkInterface/ibp65s0');
    expect((desired?.value as { spec?: { addresses?: string[] } }).spec?.addresses).toEqual([
      '10.10.5.1/24',
    ]);

    const leases = setup.state.db
      .prepare('SELECT resource_kind, resource_id FROM leases WHERE task_id = ?')
      .all(res.body.result.task_id) as Array<{ resource_kind: string; resource_id: string }>;
    expect(leases).toContainEqual({ resource_kind: 'NetworkConfig', resource_id: '99-xinas' });

    const begin = setup.mockAgent.lastTaskBeginParams();
    expect((begin?.spec as { render?: string }).render).toContain('ibp65s0');
    expect((begin?.spec as { world_config_hash?: string }).world_config_hash).toBe('w-1');
  });

  it('netplan_changed gate: world hash drift between plan and apply → 412', async () => {
    const planned = await patchIface({ mode: 'plan', spec: { addresses: ['10.10.5.1/24'] } });
    expect(planned.status).toBe(200);

    setup.state.kv.put('/xinas/v1/observed/NetworkConfig/default', {
      kind: 'NetworkConfig',
      id: 'default',
      status: {
        files: {},
        world_config_hash: 'w-2',
        xinas_file_hash: 'x-1',
        duplicates: {},
        observed_at: 'x',
      },
    });

    const res = await patchIface({
      mode: 'apply',
      plan_id: planned.body.result.plan_id,
      expected_revision: 0,
      idempotency_key: 'idem-net-stale',
    });
    expect(res.status).toBe(412);
    expect(res.body.errors[0].details?.reason).toBe('netplan_changed');
  });

  it('apply re-check: duplicates appearing after plan block the apply (hash unchanged)', async () => {
    const planned = await patchIface({ mode: 'plan', spec: { addresses: ['10.10.5.1/24'] } });
    expect(planned.body.result.blockers).toEqual([]);
    setup.state.kv.put('/xinas/v1/observed/NetworkConfig/default', {
      kind: 'NetworkConfig',
      id: 'default',
      status: {
        files: {},
        world_config_hash: 'w-1',
        xinas_file_hash: 'x-1',
        duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] },
        observed_at: 'x',
      },
    });
    const res = await patchIface({
      mode: 'apply',
      plan_id: planned.body.result.plan_id,
      expected_revision: 0,
      idempotency_key: 'idem-net-dup',
    });
    expect(res.status).toBe(412);
    expect(
      (res.body.errors[0].details?.blockers as Array<{ code: string }>).map((b) => b.code),
    ).toContain('duplicate_netplan_definition');
  });
});

// ---- T8: POST /network/ip-pool ----

describe('POST /api/v1/network/ip-pool (S6 T8)', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    for (const [name, table] of [
      ['ibp65s0', 100],
      ['ibp9s0f0', 105],
    ] as const) {
      setup.state.kv.put(`/xinas/v1/observed/NetworkInterface/${name}`, {
        kind: 'NetworkInterface',
        id: name,
        status: {
          name,
          driver: 'mlx5_core',
          rdma_capable: true,
          netplan: { addresses: ['10.10.1.1/24'], pbr_table_id: table },
          duplicates_detected_in: [],
          observed_at: 'x',
        },
      });
    }
    setup.state.kv.put('/xinas/v1/observed/NetworkConfig/default', {
      kind: 'NetworkConfig',
      id: 'default',
      status: {
        files: {},
        world_config_hash: 'w-1',
        xinas_file_hash: 'x-1',
        duplicates: {},
        observed_at: 'x',
      },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  function pool(body: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/network/ip-pool')
      .set('Authorization', ADMIN_TOKEN)
      .send(body);
  }

  it('plan → apply: per-resource pins enforced by the ENGINE (one bumped row stales the pool apply)', async () => {
    const planned = await pool({ mode: 'plan', spec: { start: '10.20.1.1', prefix: 24 } });
    expect(planned.status).toBe(200);
    expect(planned.body.result.blockers).toEqual([]);
    expect(planned.body.result.affected_resources).toEqual([
      { kind: 'NetworkInterface', id: 'ibp65s0', revision: 0 },
      { kind: 'NetworkInterface', id: 'ibp9s0f0', revision: 0 },
    ]);

    // Bump ONE target's desired row post-plan: the route's scalar echo
    // still matches (primary's revision is unchanged), so this is the
    // ENGINE's per-resource stale check firing — a scalar-only design
    // would have let it through.
    setup.state.kv.put('/xinas/v1/desired/NetworkInterface/ibp9s0f0', {
      kind: 'NetworkInterface',
      id: 'ibp9s0f0',
      spec: { managed_by_xinas: true, addresses: ['10.10.2.1/24'], enabled: true, pbr_table_id: 105 },
    });

    const stale = await pool({
      mode: 'apply',
      plan_id: planned.body.result.plan_id,
      expected_revision: 0,
      idempotency_key: 'idem-pool-stale',
    });
    expect(stale.status).toBe(412);
    expect(JSON.stringify(stale.body.errors[0].details)).toContain('ibp9s0f0');
  });

  it('fresh pool apply dispatches with addresses-only reallocation', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-pool' });
    const planned = await pool({ mode: 'plan', spec: { start: '10.20.1.1', prefix: 24 } });
    const res = await pool({
      mode: 'apply',
      plan_id: planned.body.result.plan_id,
      expected_revision: 0,
      idempotency_key: 'idem-pool',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.result.kind).toBe('net.pool.apply');

    const begin = setup.mockAgent.lastTaskBeginParams();
    const targets = (begin?.spec as { targets?: Array<{ dev: string; pbr_table_id: number }> })
      .targets;
    expect(targets).toEqual([
      { dev: 'ibp65s0', addresses: ['10.20.1.1/24'], pbr_table_id: 100 },
      { dev: 'ibp9s0f0', addresses: ['10.20.2.1/24'], pbr_table_id: 105 },
    ]);
  });
});
