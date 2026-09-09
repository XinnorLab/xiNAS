import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp, buildTestAppWithMockAgent } from './_helpers.js';

/** S6 T9 — the first real KV-derived health checks. */
describe('GET /api/v1/health (S6 network checks)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  function seedConfig(duplicates: Record<string, string[]>): void {
    setup.state.kv.put('/xinas/v1/observed/NetworkConfig/default', {
      kind: 'NetworkConfig',
      id: 'default',
      status: {
        files: {},
        world_config_hash: 'w',
        xinas_file_hash: 'x',
        duplicates,
        observed_at: 'x',
      },
    });
  }

  function seedIface(name: string, over: Record<string, unknown> = {}): void {
    setup.state.kv.put(`/xinas/v1/observed/NetworkInterface/${name}`, {
      kind: 'NetworkInterface',
      id: name,
      status: {
        name,
        rdma_capable: true,
        rdma_link_state: 'up',
        current_addresses: ['10.10.1.1/24'],
        observed_at: 'x',
        ...over,
      },
    });
  }

  async function health() {
    const res = await request(setup.app).get('/api/v1/health').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    return res.body.result as {
      overall: string;
      checks: Array<{ id: string; status: string; evidence: Record<string, unknown> }>;
    };
  }

  it('quick profile shape: api.alive first + the two network checks; bad profile → 400', async () => {
    const res = await request(setup.app)
      .get('/api/v1/health?profile=quick')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.profile).toBe('quick');
    expect(res.body.result.checks[0].id).toBe('xinas-api.alive');
    expect(res.body.result.checks[0].status).toBe('ok');
    const ids = res.body.result.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain('network.duplicate-netplan');
    expect(ids).toContain('network.rdma-readiness');
    expect(ids).toContain('drift.nfs-exports');
    expect(ids).toContain('drift.netplan');
    expect(ids).toContain('drift.nfs-conf');

    const bad = await request(setup.app)
      .get('/api/v1/health?profile=bogus')
      .set('Authorization', ADMIN_TOKEN);
    expect(bad.status).toBe(400);
  });

  it('no observations yet → both checks skipped, overall ok', async () => {
    const result = await health();
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    expect(byId.get('network.duplicate-netplan')?.status).toBe('skipped');
    expect(byId.get('network.rdma-readiness')?.status).toBe('skipped');
    // S7: the test tracker never starts → agent offline IS critical now;
    // everything else on an empty store is ok/skipped.
    expect(byId.get('agent.connectivity')?.status).toBe('critical');
    const nonAgent = result.checks.filter((c) => c.id !== 'agent.connectivity');
    expect(nonAgent.every((c) => c.status === 'ok' || c.status === 'skipped')).toBe(true);
  });

  it('duplicates → critical with file evidence; overall critical', async () => {
    seedConfig({ ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] });
    seedIface('ibp65s0');
    const result = await health();
    const check = result.checks.find((c) => c.id === 'network.duplicate-netplan');
    expect(check?.status).toBe('critical');
    // S19a: every KV-derived check also carries `collection` (spec §7.2)
    expect(check?.evidence).toEqual({
      duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] },
      collection: { status: 'success', source: 'kv', observed_at: null },
    });
    expect(JSON.stringify(check)).toContain('cleanup: true');
    expect(result.overall).toBe('critical');
  });

  it('rdma readiness: all ready → ok; one leg down → degraded with per-iface evidence', async () => {
    seedConfig({});
    seedIface('ibp65s0');
    seedIface('ibp9s0f0');
    let result = await health();
    expect(result.checks.find((c) => c.id === 'network.rdma-readiness')?.status).toBe('ok');

    seedIface('ibp9s0f0', { rdma_link_state: 'down' });
    result = await health();
    const check = result.checks.find((c) => c.id === 'network.rdma-readiness');
    expect(check?.status).toBe('degraded');
    expect(
      (check?.evidence.interfaces as Array<{ name: string; rdma_link_state: string }>).find(
        (e) => e.name === 'ibp9s0f0',
      )?.rdma_link_state,
    ).toBe('down');
    // overall is critical in this app (S7: the never-started tracker
    // reports the agent offline); the rdma check itself is the degraded.
    expect(result.overall).toBe('critical');
  });

  it('unaddressed rdma iface → degraded (has_address leg)', async () => {
    seedConfig({});
    seedIface('ibp65s0', { current_addresses: [] });
    const result = await health();
    expect(result.checks.find((c) => c.id === 'network.rdma-readiness')?.status).toBe('degraded');
  });
});

// ---- S7 T6: profiles + the drift API surface ----

describe('GET /health profiles + /config-history/drift (S7 T6)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('standard without an agent client → probe-backed checks degraded EXECUTOR_UNAVAILABLE, KV checks intact', async () => {
    const res = await request(setup.app)
      .get('/api/v1/health?profile=standard')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const checks = res.body.result.checks as Array<{
      id: string;
      status: string;
      evidence: Record<string, unknown>;
    }>;
    const byId = new Map(checks.map((c) => [c.id, c]));
    for (const id of [
      'xiraid.license',
      'xiraid.service',
      'network.rdma-live',
      'agent.collectors',
      'drift.nfs-conf',
    ]) {
      expect(byId.get(id)?.status).toBe('degraded');
      expect(byId.get(id)?.evidence.code).toBe('EXECUTOR_UNAVAILABLE');
    }
    // deep-only checks are NOT in a standard report
    expect(byId.has('filesystem.io')).toBe(false);
    // KV checks still answered
    expect(byId.get('xinas-api.alive')?.status).toBe('ok');
  });

  it('quick reports drift.nfs-conf skipped pointing at standard when a profile is desired', async () => {
    setup.state.kv.put('/xinas/v1/desired/NfsProfile/default', {
      kind: 'NfsProfile',
      id: 'default',
      spec: { versions: {} },
    });
    const res = await request(setup.app)
      .get('/api/v1/health?profile=quick')
      .set('Authorization', ADMIN_TOKEN);
    const check = (
      res.body.result.checks as Array<{ id: string; status: string; recommended_action: string }>
    ).find((c) => c.id === 'drift.nfs-conf');
    expect(check?.status).toBe('skipped');
    expect(check?.recommended_action).toContain('standard');
  });

  it('drift API: empty when clean; entries for drifted exports; not_evaluated for nfs-conf', async () => {
    const clean = await request(setup.app)
      .get('/api/v1/config-history/drift')
      .set('Authorization', ADMIN_TOKEN);
    expect(clean.status).toBe(200);
    expect(clean.body.result.drift).toEqual([]);

    // a desired share with NO observed ExportRule → drift.nfs-exports
    setup.state.kv.put('/xinas/v1/desired/Share/s1', {
      kind: 'Share',
      id: 's1',
      spec: { path: '/mnt/a', clients: [{ pattern: '*', options: ['rw'] }] },
    });
    setup.state.kv.put('/xinas/v1/desired/NfsProfile/default', {
      kind: 'NfsProfile',
      id: 'default',
      spec: { versions: {} },
    });
    const drifted = await request(setup.app)
      .get('/api/v1/config-history/drift')
      .set('Authorization', ADMIN_TOKEN);
    const entries = drifted.body.result.drift as Array<{ artifact: string; status: string }>;
    expect(entries.find((e) => e.artifact === 'drift.nfs-exports')?.status).toBe('degraded');
    expect(entries.find((e) => e.artifact === 'drift.nfs-conf')?.status).toBe('not_evaluated');
  });

  it('drift.nfs-exports + nfs.exports fire in /health for the same seeded drift', async () => {
    setup.state.kv.put('/xinas/v1/desired/Share/s1', {
      kind: 'Share',
      id: 's1',
      spec: { path: '/mnt/a', clients: [{ pattern: '*', options: ['rw'] }] },
    });
    const res = await request(setup.app)
      .get('/api/v1/health?profile=quick')
      .set('Authorization', ADMIN_TOKEN);
    const byId = new Map(
      (res.body.result.checks as Array<{ id: string; status: string }>).map((c) => [c.id, c]),
    );
    expect(byId.get('drift.nfs-exports')?.status).toBe('degraded');
    expect(byId.get('nfs.exports')?.status).toBe('degraded');
  });
});

// ---- S19a T1: coverage_status + collection (spec §7.3) ----

describe('GET /health coverage_status and collection (S19a, spec §7.3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestAppWithMockAgent>>;
  const at = '2023-11-14T22:13:20.000Z';
  const section = (value: unknown, status = 'success') => ({ status, observed_at: at, value });
  type Check = { id: string; status: string; evidence: Record<string, unknown> };

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    // A healthy heartbeat, so `agent.connectivity` does not colour `overall`
    // and the assertions below see only what the probe sections contribute.
    setup.mockAgent.respondToHealth({
      status: 'ok',
      version: 'test',
      uptime_seconds: 1,
      controller_id: setup.controllerId,
      in_flight_tasks: 0,
      collectors: {},
    });
    const deadline = Date.now() + 5_000;
    while (setup.ctx.tracker?.currentState() !== 'healthy' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(setup.ctx.tracker?.currentState()).toBe('healthy');
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const get = (profile: string) =>
    request(setup.app).get(`/api/v1/health?profile=${profile}`).set('Authorization', ADMIN_TOKEN);

  it('quick: complete coverage, agent not_needed, every check carries kv collection evidence', async () => {
    const res = await get('quick');
    expect(res.status).toBe(200);
    expect(res.body.result.coverage_status).toBe('complete');
    expect(res.body.result.collection).toEqual({ agent: 'not_needed', sources: {} });
    for (const c of res.body.result.checks as Check[]) {
      expect(c.evidence.collection, c.id).toEqual({
        status: 'success',
        source: 'kv',
        observed_at: null,
      });
    }
  });

  it('standard with a schema-2 probe: sources listed; a not_supported source keeps coverage complete', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({
      result: {
        schema: 2,
        sections: {
          license: {
            status: 'not_supported',
            observed_at: at,
            error: { code: 'TOOL_ABSENT', message: 'ENOENT' },
          },
          rdma_links: section([]),
          collectors: section({ XiraidArray: 'running' }),
          nfs_profile_render: section(null),
        },
      },
    }));
    const res = await get('standard');
    expect(res.status).toBe(200);
    expect(res.body.result.collection).toEqual({
      agent: 'answered',
      sources: {
        license: 'not_supported',
        rdma_links: 'success',
        collectors: 'success',
        nfs_profile_render: 'success',
      },
    });
    expect(res.body.result.coverage_status).toBe('complete');
    const byId = new Map((res.body.result.checks as Check[]).map((c) => [c.id, c]));
    expect(byId.get('xiraid.license')).toMatchObject({
      status: 'skipped',
      evidence: { collection: { status: 'not_supported', code: 'TOOL_ABSENT' } },
    });
    expect(byId.get('xiraid.service')).toMatchObject({
      status: 'ok',
      evidence: { collection: { status: 'success', observed_at: at } },
    });
  });

  it('standard with a failed source: coverage partial, the check is degraded, overall follows', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({
      result: {
        schema: 2,
        sections: {
          license: section({ status: 'active', days_left: 90, features: [] }),
          rdma_links: {
            status: 'timeout',
            observed_at: at,
            error: { code: 'TIMEOUT', message: 'rdma link show' },
          },
          collectors: section({}),
          nfs_profile_render: section(null),
        },
      },
    }));
    const res = await get('standard');
    expect(res.body.result.coverage_status).toBe('partial');
    expect(res.body.result.collection.sources.rdma_links).toBe('timeout');
    const byId = new Map((res.body.result.checks as Check[]).map((c) => [c.id, c]));
    expect(byId.get('network.rdma-live')).toMatchObject({
      status: 'degraded',
      evidence: { collection: { status: 'timeout', code: 'TIMEOUT' } },
    });
    expect(res.body.result.overall).toBe('degraded');
  });

  it('deep lists the probes source and feeds the deep checks', async () => {
    setup.mockAgent.respondToRpc('health.probe', (params) => ({
      result: {
        schema: 2,
        sections: {
          license: section(null),
          rdma_links: section([]),
          collectors: section({}),
          nfs_profile_render: section(null),
          ...((params as { level?: string }).level === 'deep'
            ? {
                probes: section({
                  fs_io: [{ mountpoint: '/mnt/a', ok: false, error: 'EIO: write' }],
                  nfs_loopback: null,
                }),
              }
            : {}),
        },
      },
    }));
    const res = await get('deep');
    expect(res.body.result.collection.sources.probes).toBe('success');
    const byId = new Map((res.body.result.checks as Check[]).map((c) => [c.id, c]));
    expect(byId.get('filesystem.io')?.status).toBe('critical');
    expect(byId.get('nfs.loopback')?.status).toBe('skipped');
    expect(res.body.result.overall).toBe('critical');
  });

  it('a legacy (schema 1) probe result is mapped to error/LEGACY_AGENT on every section', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({
      result: { license: null, rdma_links: [], collectors: {}, nfs_profile_render: null },
    }));
    const res = await get('standard');
    expect(res.body.result.coverage_status).toBe('partial');
    expect(Object.values(res.body.result.collection.sources)).toEqual([
      'error',
      'error',
      'error',
      'error',
    ]);
    const lic = (res.body.result.checks as Check[]).find((c) => c.id === 'xiraid.license');
    expect((lic?.evidence.collection as { code: string }).code).toBe('LEGACY_AGENT');
  });

  it('agent error on standard: coverage partial, collection.agent unavailable', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({
      error: { code: -32603, message: 'down' },
    }));
    const res = await get('standard');
    expect(res.body.result.collection).toEqual({ agent: 'unavailable', sources: {} });
    expect(res.body.result.coverage_status).toBe('partial');
    const byId = new Map((res.body.result.checks as Check[]).map((c) => [c.id, c]));
    expect(byId.get('agent.collectors')?.evidence.collection).toMatchObject({
      status: 'error',
      code: 'EXECUTOR_UNAVAILABLE',
    });
  });
});
