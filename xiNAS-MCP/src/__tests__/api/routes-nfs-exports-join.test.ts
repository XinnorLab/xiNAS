import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('Share read-join: status.exports[] populated from observed ExportRule', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const SHARE_ID = 'share01';
  const EXPORT_PATH = '/srv/nfs/share01';

  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put(`/xinas/v1/desired/Share/${SHARE_ID}`, {
      kind: 'Share',
      id: SHARE_ID,
      spec: {
        path: '/data/share01',
        export_path: EXPORT_PATH,
        clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
        fsid: 42,
      },
      status: { exports: [] },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /shares list: status.exports is [] when no ExportRule observed', async () => {
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].status.exports).toEqual([]);
  });

  it('GET /shares list: status.exports populated when a matching ExportRule exists', async () => {
    setup.state.kv.put('/xinas/v1/observed/ExportRule/share01', {
      kind: 'ExportRule',
      id: 'share01',
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [
          { client: '10.0.0.0/8', options: ['rw', 'sync', 'no_root_squash'] },
          { client: '192.168.1.0/24', options: ['ro'] },
        ],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result[0].status.exports).toHaveLength(2);
    expect(res.body.result[0].status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports populated for a matching ExportRule', async () => {
    setup.state.kv.put('/xinas/v1/observed/ExportRule/share01', {
      kind: 'ExportRule',
      id: 'share01',
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [{ client: '10.0.0.0/8', options: ['rw', 'sync'] }],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toHaveLength(1);
    expect(res.body.result.status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports is [] when the only ExportRule is for a different path', async () => {
    setup.state.kv.put('/xinas/v1/observed/ExportRule/other', {
      kind: 'ExportRule',
      id: 'other',
      spec: { export_path: '/srv/nfs/other' },
      status: { rules: [{ client: '*', options: ['ro'] }], observed_at: new Date().toISOString() },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toEqual([]);
  });
});
