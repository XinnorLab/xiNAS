import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('/api/v1/* catch-all', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('unknown GET under /api/v1 returns 404 with NOT_FOUND envelope (not Express HTML)', async () => {
    const res = await request(setup.app)
      .get('/api/v1/does-not-exist')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.errors?.[0]?.code).toBe('NOT_FOUND');
    expect(res.body).toHaveProperty('request_id');
    expect(res.body).toHaveProperty('correlation_id');
  });

  it('unknown POST under /api/v1 returns 404 envelope (mutating but unknown route)', async () => {
    const res = await request(setup.app)
      .post('/api/v1/no-such-thing')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors?.[0]?.code).toBe('NOT_FOUND');
  });
});
