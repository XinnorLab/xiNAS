import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-h4';

describe('POST /internal/v1/agent_started', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    const base = await buildTestApp();
    base.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

    const tracker = new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: CONTROLLER_ID,
      state: base.state,
      agentSocketPath: '/tmp/nonexistent.sock',
    });

    const { createAppWithTracker } = await import('../../api/app.js');
    const ctx = { config: base.config, state: base.state, tracker };
    const app = createAppWithTracker(ctx);

    setup = {
      ...base,
      app,
      tracker,
      async cleanup() {
        await base.cleanup();
      },
    };
  });

  afterEach(() => setup.cleanup());

  it('returns 204 and calls recordHeartbeatSuccess to clear startup grace', async () => {
    let successRecorded = false;
    const orig = setup.tracker.recordHeartbeatSuccess.bind(setup.tracker);
    setup.tracker.recordHeartbeatSuccess = (at) => {
      successRecorded = true;
      orig(at);
    };

    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ controller_id: CONTROLLER_ID });

    expect(res.status).toBe(204);
    expect(successRecorded).toBe(true);
    expect(setup.tracker.currentState()).toBe('healthy');
  });

  it('rejects wrong controller_id with 400', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ controller_id: 'wrong-id' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects without agent bearer with 401', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', 'Bearer tok-admin')
      .send({ controller_id: CONTROLLER_ID });

    expect(res.status).toBe(401);
  });
});
