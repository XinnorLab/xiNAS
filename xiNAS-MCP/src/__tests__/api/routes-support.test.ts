import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('support-bundle routes (S7 T7)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('POST without an agent connection → INTERNAL EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .post('/api/v1/support-bundle')
      .set('Authorization', ADMIN_TOKEN)
      .send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body.errors)).toContain('EXECUTOR_UNAVAILABLE');
  });

  it('GET for an unknown task → 404; malformed id → 400', async () => {
    const missing = await request(setup.app)
      .get('/api/v1/support-bundle/no-such-task')
      .set('Authorization', ADMIN_TOKEN);
    expect(missing.status).toBe(404);

    const malformed = await request(setup.app)
      .get('/api/v1/support-bundle/..%2Fetc')
      .set('Authorization', ADMIN_TOKEN);
    expect(malformed.status).toBe(400);
  });
});
