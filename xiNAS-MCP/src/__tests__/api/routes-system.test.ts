import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedCluster, seedNode } from './_helpers.js';

describe('GET /api/v1/system', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    seedCluster(setup.state);
    seedNode(setup.state);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('returns envelope-wrapped Cluster + Node', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.result.cluster.id).toBe('default');
    expect(res.body.result.cluster.status.mode).toBe('single_node');
    expect(res.body.result.node.id).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(res.body.result.node.status.agent_state).toBe('offline');
  });
});

describe('GET /api/v1/capabilities', () => {
  it('returns the capabilities envelope', async () => {
    const setup = await buildTestApp();
    seedCluster(setup.state);
    try {
      const res = await request(setup.app)
        .get('/api/v1/capabilities')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.result.ha).toBe('not_enabled');
      expect(res.body.result['nfs.recovery_state_managed']).toBe(false);
    } finally {
      await setup.cleanup();
    }
  });
});

describe('GET /api/v1/controllers', () => {
  it('returns the singleton Node as a single-element array', async () => {
    const setup = await buildTestApp();
    seedNode(setup.state);
    try {
      const res = await request(setup.app)
        .get('/api/v1/controllers')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.result)).toBe(true);
      expect(res.body.result).toHaveLength(1);
      expect(res.body.result[0].id).toBe('00000000-0000-0000-0000-0000000000aa');
    } finally {
      await setup.cleanup();
    }
  });
});
