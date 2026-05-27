import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('network routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('GET /network/interfaces lists interfaces', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', {
      kind: 'NetworkInterface',
      id: 'ibp0s4',
      spec: { managed_by_xinas: true, addresses: ['10.0.0.1/24'] },
      status: { driver: 'mlx5_ib', rdma_capable: true, link_state: 'up', current_addresses: ['10.0.0.1/24'] },
    });
    const res = await request(setup.app).get('/api/v1/network/interfaces').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });

  it('GET /network/interfaces/{id} returns the interface', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', { kind: 'NetworkInterface', id: 'ibp0s4' });
    const res = await request(setup.app).get('/api/v1/network/interfaces/ibp0s4').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('ibp0s4');
  });

  it('GET /network returns a summary envelope', async () => {
    const res = await request(setup.app).get('/api/v1/network').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('GET /service-ips returns empty in Phase 0', async () => {
    const res = await request(setup.app).get('/api/v1/service-ips').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});
