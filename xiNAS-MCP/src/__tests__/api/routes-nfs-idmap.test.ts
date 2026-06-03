import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('GET /api/v1/nfs-idmap', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('returns 404 when no snapshot has been observed yet', async () => {
    const res = await request(setup.app).get('/api/v1/nfs-idmap').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns the singleton when a snapshot exists', async () => {
    setup.state.kv.put('/xinas/v1/observed/nfs_idmap/snapshot', {
      kind: 'NfsIdmap',
      status: {
        conf_present: true,
        domain: 'example.com',
        local_realms: ['EXAMPLE.COM'],
        method: 'nsswitch',
        idmapd_active: true,
        idmapd_unit_state: 'active',
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app).get('/api/v1/nfs-idmap').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.kind).toBe('NfsIdmap');
    expect(res.body.result.status.domain).toBe('example.com');
    expect(res.body.result.status.method).toBe('nsswitch');
    expect(res.body.result.status.idmapd_active).toBe(true);
  });

  it('requires authentication (no anonymous access)', async () => {
    const res = await request(setup.app).get('/api/v1/nfs-idmap');
    expect(res.status).toBe(401);
  });
});
