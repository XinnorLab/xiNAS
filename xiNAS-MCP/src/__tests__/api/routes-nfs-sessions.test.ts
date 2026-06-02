import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('GET /api/v1/shares/{id}/sessions — populated from observed state', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const SHARE_ID = 'share01';
  const EXPORT_PATH = '/srv/nfs/share01';

  beforeEach(async () => {
    setup = await buildTestApp();

    // Real Share shape: only spec.path (the exported directory, no export_path).
    // The sessions join keys share.spec.path against NfsSession.spec.export_path.
    setup.state.kv.put(`/xinas/v1/desired/Share/${SHARE_ID}`, {
      kind: 'Share',
      id: SHARE_ID,
      spec: {
        path: EXPORT_PATH,
        clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
        fsid: 42,
      },
    });

    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.3:share01', {
      kind: 'NfsSession',
      id: '10.1.2.3:/srv/nfs/share01',
      spec: { client_addr: '10.1.2.3', export_path: EXPORT_PATH },
      status: { proto_version: 'v4.2', locked_files: 0, observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.4:share01', {
      kind: 'NfsSession',
      id: '10.1.2.4:/srv/nfs/share01',
      spec: { client_addr: '10.1.2.4', export_path: EXPORT_PATH },
      status: { proto_version: 'v4.1', locked_files: 2, observed_at: new Date().toISOString() },
    });

    // A session for a DIFFERENT share — must NOT appear in results.
    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.5:other', {
      kind: 'NfsSession',
      id: '10.1.2.5:/srv/nfs/other',
      spec: { client_addr: '10.1.2.5', export_path: '/srv/nfs/other' },
      status: { proto_version: 'v4', locked_files: 0, observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('returns only NfsSession entries whose export_path matches the share', async () => {
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    const clientAddrs = res.body.result.map(
      (s: { spec: { client_addr: string } }) => s.spec.client_addr,
    );
    expect(clientAddrs).toContain('10.1.2.3');
    expect(clientAddrs).toContain('10.1.2.4');
    expect(clientAddrs).not.toContain('10.1.2.5');
  });

  it('returns an empty array when no sessions exist for the share', async () => {
    setup.state.kv.delete('/xinas/v1/observed/NfsSession/10.1.2.3:share01');
    setup.state.kv.delete('/xinas/v1/observed/NfsSession/10.1.2.4:share01');
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(0);
  });

  it('returns 404 when the share does not exist', async () => {
    const res = await request(setup.app)
      .get('/api/v1/shares/nonexistent/sessions')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('cross-share isolation: every returned session belongs to this share', async () => {
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const exportPaths = res.body.result.map(
      (s: { spec: { export_path: string } }) => s.spec.export_path,
    );
    expect(exportPaths.every((p: string) => p === EXPORT_PATH)).toBe(true);
  });
});
