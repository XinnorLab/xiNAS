/**
 * GET /tasks/{id}/wait — bounded long-poll (s2-task-envelope-spec §10.2).
 *
 * Needs an ENGINE-WIRED app (the default buildTestApp has no task engine), so
 * it mirrors the builder in tasks-watch.test.ts: buildTestApp + buildTaskEngines
 * + an internal-agent token to POST progress events.
 */

import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../api/app.js';
import type { ApiContext } from '../../../api/context.js';
import { buildTaskEngines } from '../../../api/tasks/build.js';
import { type TestSetup, buildTestApp } from '../_helpers.js';

const AGENT_TOKEN = 'agent-tok-wait';
const ADMIN_TOKEN = 'Bearer tok-admin';

interface WaitSetup extends TestSetup {
  cleanup(): Promise<void>;
  seedTask(): string;
  emit(taskId: string, body: Record<string, unknown>): Promise<unknown>;
}

async function buildApp(): Promise<WaitSetup> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tasks = buildTaskEngines({ state: setup.state });
  const ctx: ApiContext = {
    config: setup.config,
    state: setup.state,
    tasks,
    taskProgressSpillDir: join(setup.dir, 'task-logs'),
  };
  const app = createApp(ctx);

  return {
    ...setup,
    app,
    ctx,
    seedTask() {
      return tasks.store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'mcp',
        request_id: 'req-1',
        correlation_id: 'corr-1',
        input_hash: 'deadbeef',
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
      }).task_id;
    },
    emit(taskId, body) {
      return request(app)
        .post('/internal/v1/task_progress')
        .set('Authorization', `Bearer ${AGENT_TOKEN}`)
        .send({ task_id: taskId, observed_at: new Date().toISOString(), ...body });
    },
    async cleanup() {
      await setup.cleanup();
    },
  };
}

describe('GET /tasks/{id}/wait', () => {
  let setup: WaitSetup;
  beforeEach(async () => {
    setup = await buildApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('404s on an unknown task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/wait')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('returns immediately when the task already moved past since_revision', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=0&timeout_s=5`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.changed).toBe(true);
    expect(res.body.result.task.state).toBe('running');
    expect(res.body.result.task.progress.stage_total).toBe(3);
  });

  it('wakes on a progress event that lands mid-wait', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    // .then() is what DISPATCHES a supertest request — a bare reference is
    // lazy and would never reach the app.
    const pending = request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=10`)
      .set('Authorization', ADMIN_TOKEN)
      .then((r) => r);

    const midFlight = new Promise<void>((resolve) => {
      setTimeout(() => {
        void setup
          .emit(id, {
            sequence: 2,
            event_type: 'stage_started',
            stage_index: 1,
            stage_name: 'apply',
            status: 'running',
          })
          .then(() => resolve());
      }, 300);
    });

    const res = await pending;
    await midFlight;
    expect(res.body.result.changed).toBe(true);
    expect(res.body.result.task.progress.stage_name).toBe('apply');
  });

  it('returns changed:false at the timeout when nothing happened', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=1`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.changed).toBe(false);
    expect(res.body.result.waited_s).toBeGreaterThanOrEqual(1);
  });

  it('rejects a timeout_s outside [1, 60]', async () => {
    const id = setup.seedTask();
    const res = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?timeout_s=600`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('over the per-task cap, returns immediately with a WAIT_CAPACITY warning', async () => {
    const id = setup.seedTask();
    await setup.emit(id, { sequence: 1, event_type: 'accepted', stage_total: 3 });

    // Four waiters occupy the per-task cap; the fifth must not queue. The
    // trailing .then() is what dispatches each request — without it supertest
    // never sends, and no waiter would be live to fill the cap.
    const held = Array.from({ length: 4 }, () =>
      request(setup.app)
        .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=2`)
        .set('Authorization', ADMIN_TOKEN)
        .then((r) => r),
    );
    await new Promise((r) => setTimeout(r, 200));

    const overflow = await request(setup.app)
      .get(`/api/v1/tasks/${id}/wait?since_revision=1&timeout_s=2`)
      .set('Authorization', ADMIN_TOKEN);

    expect(overflow.status).toBe(200);
    expect(overflow.body.result.changed).toBe(false);
    expect(overflow.body.result.waited_s).toBe(0);
    expect(overflow.body.warnings.map((w: { code: string }) => w.code)).toContain('WAIT_CAPACITY');

    await Promise.all(held);
  });
});
