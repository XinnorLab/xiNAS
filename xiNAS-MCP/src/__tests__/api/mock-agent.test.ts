import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

describe('buildTestAppWithMockAgent — helper round-trips', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
  });

  afterEach(async () => {
    await setup.teardown();
  });

  it('app starts and handles requests', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN)
      .expect(200);
    expect(res.body.result).toBeDefined();
  });

  it('postObservation seeds observed state readable via GET', async () => {
    await setup.mockAgent.postObservation({
      observed_at: new Date().toISOString(),
      controller_id: setup.controllerId,
      deltas: [
        {
          kind: 'User',
          id: '1000',
          op: 'upsert',
          value: {
            kind: 'User',
            id: '1000',
            metadata: { modified_at: new Date().toISOString() },
            spec: { name: 'testuser', uid: 1000, gid: 1000 },
            status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
          },
        },
      ],
      complete_snapshots: [],
    });
    const res = await request(setup.app)
      .get('/api/v1/users/1000')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.spec.name).toBe('testuser');
  });

  it('respondToHealth drives tracker to healthy after ticks', async () => {
    setup.mockAgent.respondToHealth({
      status: 'healthy',
      version: '0.0.1-test',
      uptime_seconds: 10,
      controller_id: setup.controllerId,
      in_flight_tasks: 0,
      collectors: { disk: 'running', users: 'running' },
    });
    // Allow at least one heartbeat tick to fire
    await new Promise((r) => setTimeout(r, setup.heartbeatIntervalMs + 100));
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.node.status.agent.state).toBe('healthy');
  });

  it('simulateOffline drives tracker to offline state', async () => {
    // First bring tracker healthy
    setup.mockAgent.respondToHealth({
      status: 'healthy',
      version: '0.0.1-test',
      uptime_seconds: 5,
      controller_id: setup.controllerId,
      in_flight_tasks: 0,
      collectors: {},
    });
    await new Promise((r) => setTimeout(r, setup.heartbeatIntervalMs + 100));
    // Now simulate offline
    await setup.mockAgent.simulateOffline();
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.node.status.agent.state).toBe('offline');
  });
});
