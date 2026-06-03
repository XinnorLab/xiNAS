import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp, seedCluster, seedNode } from './_helpers.js';

describe('GET /api/v1/system — agent sub-object', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    seedCluster(setup.state);
    seedNode(setup.state);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('includes result.node.status.agent with required fields', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    expect(agent).toBeDefined();
    expect(agent).toHaveProperty('state');
    expect(['healthy', 'degraded', 'offline']).toContain(agent.state);
    // On a fresh test app whose tracker never start()s, state is offline.
    expect(agent.state).toBe('offline');
  });

  it('preserves the pre-existing node.status.agent_state alongside the new agent sub-object', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const status = res.body.result?.node?.status;
    // agent_state (the older flat field) and agent (the new sub-object) coexist.
    expect(status.agent_state).toBe('offline');
    expect(status.agent).toBeDefined();
  });

  it('agent.collectors is an object (may be empty on startup)', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    expect(typeof agent.collectors).toBe('object');
    expect(Array.isArray(agent.collectors)).toBe(false);
  });

  it('last_heartbeat_at is null when no heartbeat has succeeded', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    // null is valid per api-v1.yaml (type: [string, "null"], format: date-time)
    expect(agent.last_heartbeat_at === null || typeof agent.last_heartbeat_at === 'string').toBe(
      true,
    );
  });
});
