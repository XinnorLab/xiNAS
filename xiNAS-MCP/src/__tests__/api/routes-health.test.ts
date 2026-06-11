import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

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
    expect(res.body.result.checks).toHaveLength(3);

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
    expect(result.overall).toBe('ok');
  });

  it('duplicates → critical with file evidence; overall critical', async () => {
    seedConfig({ ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] });
    seedIface('ibp65s0');
    const result = await health();
    const check = result.checks.find((c) => c.id === 'network.duplicate-netplan');
    expect(check?.status).toBe('critical');
    expect(check?.evidence).toEqual({
      duplicates: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] },
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
    expect(result.overall).toBe('ok');

    seedIface('ibp9s0f0', { rdma_link_state: 'down' });
    result = await health();
    const check = result.checks.find((c) => c.id === 'network.rdma-readiness');
    expect(check?.status).toBe('degraded');
    expect(
      (check?.evidence.interfaces as Array<{ name: string; rdma_link_state: string }>).find(
        (e) => e.name === 'ibp9s0f0',
      )?.rdma_link_state,
    ).toBe('down');
    expect(result.overall).toBe('degraded');
  });

  it('unaddressed rdma iface → degraded (has_address leg)', async () => {
    seedConfig({});
    seedIface('ibp65s0', { current_addresses: [] });
    const result = await health();
    expect(result.checks.find((c) => c.id === 'network.rdma-readiness')?.status).toBe('degraded');
  });
});
