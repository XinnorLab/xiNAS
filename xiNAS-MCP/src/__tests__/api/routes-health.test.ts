import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('GET /api/v1/health', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('returns a minimal one-check HealthReport for the quick profile', async () => {
    const res = await request(setup.app)
      .get('/api/v1/health?profile=quick')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.profile).toBe('quick');
    expect(res.body.result.overall).toBe('ok');
    expect(res.body.result.checks).toHaveLength(1);
    expect(res.body.result.checks[0].id).toBe('xinas-api.alive');
    expect(res.body.result.checks[0].status).toBe('ok');
  });
});
