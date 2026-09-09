import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, OPERATOR_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

/**
 * S8 T3 (ADR-0010 review P0): the first REST role enforcement.
 * NOTE: this api maps PERMISSION_DENIED to HTTP 401 (documented
 * Phase 0 simplification in errors.ts).
 */
describe('rbacMiddleware (S8 T3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const denied = (res: { status: number; body: unknown }): void => {
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain('PERMISSION_DENIED');
  };

  it('REGRESSION PIN: a viewer token can no longer hit mutating routes', async () => {
    // Before S8 T3 this request reached the route handler.
    denied(
      await request(setup.app)
        .post('/api/v1/arrays')
        .set('Authorization', VIEWER_TOKEN)
        .send({ mode: 'plan', spec: {} }),
    );
  });

  it('viewer: reads allowed, operator/admin operations denied', async () => {
    expect(
      (await request(setup.app).get('/api/v1/arrays').set('Authorization', VIEWER_TOKEN)).status,
    ).toBe(200);
    expect(
      (await request(setup.app).get('/api/v1/health').set('Authorization', VIEWER_TOKEN)).status,
    ).toBe(200);
    denied(
      await request(setup.app)
        .post('/api/v1/shares')
        .set('Authorization', VIEWER_TOKEN)
        .send({ mode: 'plan', spec: {} }),
    );
    denied(
      await request(setup.app)
        .post('/api/v1/support-bundle')
        .set('Authorization', VIEWER_TOKEN)
        .send({}),
    );
  });

  it('operator: share ops pass rbac, RAID mutation denied', async () => {
    // passes rbac → fails later in the handler (422 spec validation), NOT 401
    const share = await request(setup.app)
      .post('/api/v1/shares')
      .set('Authorization', OPERATOR_TOKEN)
      .send({ mode: 'plan', spec: {} });
    expect(share.status).not.toBe(401);
    denied(
      await request(setup.app)
        .post('/api/v1/arrays')
        .set('Authorization', OPERATOR_TOKEN)
        .send({ mode: 'plan', spec: {} }),
    );
    denied(
      await request(setup.app)
        .patch('/api/v1/network/interfaces/ibp0')
        .set('Authorization', OPERATOR_TOKEN)
        .send({ mode: 'plan', spec: {} }),
    );
  });

  it('G-04: a viewer may run the quick and standard health profiles but not deep', async () => {
    // deep writes a probe file on every mounted managed fs and performs a
    // PID1 loopback mount — the catalog entry escalates that one value to
    // operator while the entry itself stays a viewer read.
    expect(
      (
        await request(setup.app)
          .get('/api/v1/health?profile=standard')
          .set('Authorization', VIEWER_TOKEN)
      ).status,
    ).toBe(200);
    const deep = await request(setup.app)
      .get('/api/v1/health?profile=deep')
      .set('Authorization', VIEWER_TOKEN);
    denied(deep);
    const details = (deep.body as { errors: Array<{ details?: Record<string, unknown> }> })
      .errors[0]?.details;
    expect(details?.required_role).toBe('operator');
    expect(details?.operation).toBe('health.check');
  });

  it('G-04: an operator may run the deep health profile', async () => {
    const deep = await request(setup.app)
      .get('/api/v1/health?profile=deep')
      .set('Authorization', OPERATOR_TOKEN);
    expect(deep.status).toBe(200);
    expect(deep.body.result.profile).toBe('deep');
  });

  it('uncataloged public routes default to admin (deny-by-default)', async () => {
    // /reference is deliberately NOT in the catalog
    denied(
      await request(setup.app)
        .post('/api/v1/reference')
        .set('Authorization', OPERATOR_TOKEN)
        .send({ mode: 'plan', spec: {} }),
    );
    const admin = await request(setup.app)
      .post('/api/v1/reference')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: {} });
    expect(admin.status).not.toBe(401);
  });
});
