import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { mergeWarnings } from '../../api/handlers/merge-warnings.js';
import { type TestSetup, buildTestApp, seedCluster, seedNode } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-sw-h5';

/**
 * Build a test app with a HeartbeatTracker that is already in the
 * 'degraded' state. We achieve degraded by recording a heartbeat
 * success with a timestamp 11 seconds in the past relative to
 * real wall-clock time (intervalMs=5000, so 2×interval=10s; 11s > 10s
 * → degraded). No fake timers needed — avoids supertest HTTP hangs.
 */
async function buildDegradedApp(): Promise<
  TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker }
> {
  const setup = await buildTestApp();
  seedCluster(setup.state);
  seedNode(setup.state);

  // Wire an agent token so the /internal/v1/observed test can authenticate.
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  // Simulate a heartbeat that occurred 11 seconds ago → degraded (> 2×5s).
  const past = new Date(Date.now() - 11_000);
  tracker.recordHeartbeatSuccess(past);

  const { createAppWithTracker } = await import('../../api/app.js');
  const ctx = { config: setup.config, state: setup.state, tracker };
  const app = createAppWithTracker(ctx);

  return {
    ...setup,
    app,
    tracker,
    async cleanup() {
      await setup.cleanup();
    },
  };
}

describe('mergeWarnings unit', () => {
  it('deduplicates by code, keeping first occurrence', () => {
    const handler = [{ code: 'FOO', message: 'handler foo' }];
    const system = [
      { code: 'FOO', message: 'system foo (duplicate)' },
      { code: 'BAR', message: 'system bar' },
    ];
    const result = mergeWarnings(handler, system);
    expect(result.map((w) => w.code)).toEqual(['FOO', 'BAR']);
    // First occurrence of FOO is from the handler.
    expect(result.find((w) => w.code === 'FOO')?.message).toBe('handler foo');
  });
});

describe('systemWarningsMiddleware + mergeWarnings', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    setup = await buildDegradedApp();
  });

  afterEach(() => setup.cleanup());

  it('read endpoint: degraded tracker does NOT inject EXECUTOR_DEGRADED warning', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin');

    expect(res.status).toBe(200);
    const warnings = res.body.warnings as Array<{ code: string }>;
    const hasDegraded = warnings.some((w) => w.code === 'EXECUTOR_DEGRADED');
    expect(hasDegraded).toBe(false);
  });

  it('mutating endpoint: degraded tracker DOES inject EXECUTOR_DEGRADED warning', async () => {
    // The mutating stub (POST /api/v1/config-history/rollback — /arrays,
    // /filesystems, and /shares all have real routes now) returns
    // UNSUPPORTED (422) because the tracker is online (degraded, not
    // offline) but the method isn't built yet. The envelope should carry
    // EXECUTOR_DEGRADED in warnings.
    const res = await request(setup.app)
      .post('/api/v1/config-history/rollback')
      .set('Authorization', 'Bearer tok-admin')
      .send({});

    // Status 422 (UNSUPPORTED) and warnings include EXECUTOR_DEGRADED
    expect(res.status).toBe(422);
    const warnings = res.body.warnings as Array<{ code: string }>;
    const hasDegraded = warnings.some((w) => w.code === 'EXECUTOR_DEGRADED');
    expect(hasDegraded).toBe(true);
  });

  it('healthy tracker: no EXECUTOR_DEGRADED warning on any route', async () => {
    // Record a very recent heartbeat → healthy state.
    setup.tracker.recordHeartbeatSuccess(new Date());

    const res = await request(setup.app)
      .post('/api/v1/config-history/rollback')
      .set('Authorization', 'Bearer tok-admin')
      .send({});

    const warnings = res.body.warnings as Array<{ code: string }>;
    expect(warnings.every((w) => w.code !== 'EXECUTOR_DEGRADED')).toBe(true);
  });

  it('degraded tracker: POST /internal/v1/observed does NOT receive EXECUTOR_DEGRADED warning', async () => {
    // The agent's own observation push goes to /internal/v1/observed which is
    // mounted BEFORE the /api/v1 sub-router that carries systemWarningsMiddleware.
    // This verifies the middleware is scoped only to /api/v1/* (Fix H-review-2).
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    // The response must be 200 (no auth error) and must carry no EXECUTOR_DEGRADED.
    expect(res.status).toBe(200);
    const warnings = (res.body.warnings ?? []) as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === 'EXECUTOR_DEGRADED')).toBe(false);
  });
});
