import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('stub routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /events returns empty', async () => {
    const res = await request(setup.app).get('/api/v1/events').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /audit returns empty + warning', async () => {
    const res = await request(setup.app).get('/api/v1/audit').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(
      res.body.warnings.some((w: { code: string }) => w.code === 'AUDIT_QUERY_NOT_IMPLEMENTED'),
    ).toBe(true);
  });

  it('GET /config-history/snapshots returns empty + warning', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/snapshots')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(
      res.body.warnings.some((w: { code: string }) => w.code === 'CONFIG_HISTORY_NOT_INTEGRATED'),
    ).toBe(true);
  });

  it('GET /config-history/snapshots/{id} 404s', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/snapshots/abc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('POST /support-bundle returns EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .post('/api/v1/support-bundle')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('GET /support-bundle/{task_id} 404s', async () => {
    const res = await request(setup.app)
      .get('/api/v1/support-bundle/01902f25-7c54-7c10-b1f0-aaaabbbbcccc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });
});
