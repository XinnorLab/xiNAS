import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('tasks routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /tasks returns empty array on fresh install', async () => {
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /tasks/{id} 404s when no such task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /tasks returns seeded tasks', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'share.create',
      state: 'plan_only',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '00000000-0000-0000-0000-000000000010',
      correlation_id: 'fixture-task-1',
      input_hash: 'sha256:fixture',
      risk_level: 'non_disruptive',
      affected_resources: [],
      created_at: '2026-05-27T11:00:00Z',
      updated_at: '2026-05-27T11:00:00Z',
    });
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].kind).toBe('share.create');
  });

  it('POST /tasks/{id}/cancel without a task engine returns EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .post('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/cancel')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('GET /tasks/{id}/watch emits one SSE event then closes', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'k',
      state: 'running',
    });
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/watch')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: snapshot');
    expect(res.text).toContain('"state":"running"');
  });
});

// ── S10 T5 (s2 spec §16.1): the real cancel route over the mock-agent app ────

import { VIEWER_TOKEN, buildTestAppWithMockAgent } from './_helpers.js';
import type { MockAgentSetup } from './_helpers.js';

describe('POST /tasks/{id}/cancel (S10, real route)', () => {
  let m: MockAgentSetup;
  beforeEach(async () => {
    m = await buildTestAppWithMockAgent();
  });
  afterEach(async () => {
    await m.teardown();
  });

  function seedApply(): string {
    m.state.kv.put('/xinas/v1/desired/Share/sc1', { id: 'sc1' });
    const task = m.tasks.taskEngine.apply({
      plan: {
        plan_id: 'plan-c1',
        kind: 'reference.echo',
        risk_level: 'non_disruptive',
        plan_hash: 'ph-c1',
        affected_resources: [{ kind: 'Share', id: 'sc1', revision: 1 }],
        state_revision_expected: 1,
      },
      applyReq: {
        input_hash: 'ih-c1',
        idempotency_key: `idem-${Math.random()}`,
        principal: 'admin:test',
        client_type: 'rest',
        request_id: '33333333-3333-3333-3333-333333333333',
        correlation_id: 'corr-c1',
      },
    });
    return task.task_id;
  }

  it('404 for an unknown task', async () => {
    const res = await request(m.app)
      .post('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/cancel')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('409 not_cancellable on a terminal row; 200 idempotent on cancelled', async () => {
    const id = seedApply();
    m.tasks.store.transition(id, { state: 'success' });
    const conflict = await request(m.app)
      .post(`/api/v1/tasks/${id}/cancel`)
      .set('Authorization', ADMIN_TOKEN);
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors[0].details?.reason).toBe('not_cancellable');

    m.tasks.store.transition(id, { state: 'cancelled' });
    const again = await request(m.app)
      .post(`/api/v1/tasks/${id}/cancel`)
      .set('Authorization', ADMIN_TOKEN);
    expect(again.status).toBe(200);
    expect(again.body.result.state).toBe('cancelled');
  });

  it('200 queued → cancelled (engine-local) with the row in the envelope', async () => {
    const id = seedApply();
    const res = await request(m.app)
      .post(`/api/v1/tasks/${id}/cancel`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.state).toBe('cancelled');
    expect(res.body.result.cancel_requested_at).not.toBeNull();
    expect(m.tasks.store.get(id)?.state).toBe('cancelled');
  });

  it('viewer is refused by RBAC; operator allowed', async () => {
    const id = seedApply();
    const denied = await request(m.app)
      .post(`/api/v1/tasks/${id}/cancel`)
      .set('Authorization', VIEWER_TOKEN);
    // Phase 0 convention: PERMISSION_DENIED maps to HTTP 401 (rbac.test.ts).
    expect(denied.status).toBe(401);
    const ok = await request(m.app)
      .post(`/api/v1/tasks/${id}/cancel`)
      .set('Authorization', 'Bearer tok-operator');
    expect([200, 403]).toContain(ok.status);
    expect(ok.status).toBe(200);
  });
});
