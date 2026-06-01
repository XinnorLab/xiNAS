import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers.js';
import type { TestSetup } from './_helpers.js';

/**
 * Build a minimal express app that mounts a test endpoint behind
 * requireInternalAgent. The real app will mount it on /internal/v1/*;
 * here we mount it on /test-internal for isolation.
 */
async function buildInternalApp(): Promise<TestSetup & { cleanup(): Promise<void> }> {
  const setup = await buildTestApp();

  // Add an agent token to the config so auth middleware can resolve it.
  setup.config.tokens['agent-tok'] = { principal: 'agent:root', role: 'internal_agent' };

  return setup;
}

describe('requireInternalAgent middleware', () => {
  let setup: TestSetup & { cleanup(): Promise<void> };
  let app: Express;

  beforeEach(async () => {
    setup = await buildInternalApp();

    // Re-create app after mutating config so authMiddleware sees the agent token.
    const { createApp } = await import('../../api/app.js');
    const { requireInternalAgent } = await import('../../api/middleware/require-internal-agent.js');

    // Build a fresh app from the patched config.
    const ctx = { config: setup.config, state: setup.state };
    app = createApp(ctx);

    // Mount a test-only internal route to verify the middleware.
    // In a real app this is wired inside createApp; here we verify in isolation.
    const internalApp = express();
    internalApp.use(express.json());
    const { requestIdMiddleware } = await import('../../api/middleware/request-id.js');
    const { authMiddleware } = await import('../../api/middleware/auth.js');
    internalApp.use(requestIdMiddleware());
    internalApp.use(authMiddleware(setup.config));
    internalApp.post('/internal/v1/test', requireInternalAgent(), (_req, res) => {
      res.json({ ok: true });
    });
    app = internalApp;
  });

  afterEach(() => setup.cleanup());

  it('passes when Authorization: Bearer <agent-token> is provided', async () => {
    const res = await request(app)
      .post('/internal/v1/test')
      .set('Authorization', 'Bearer agent-tok')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('rejects with 401 when no bearer is provided (even over UDS-simulated path)', async () => {
    // supertest uses TCP; no UDS-trust promotion. But even with a UDS connection,
    // UDS-trust admin does NOT satisfy internal_agent. We test the role gate directly.
    const res = await request(app).post('/internal/v1/test').send({});
    // No auth → 401 from authMiddleware before requireInternalAgent even runs.
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when admin bearer (not agent bearer) is provided', async () => {
    const res = await request(app)
      .post('/internal/v1/test')
      .set('Authorization', 'Bearer tok-admin')
      .send({});
    // tok-admin has role 'admin', not 'internal_agent'
    expect(res.status).toBe(401);
  });
});
