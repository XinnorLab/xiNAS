import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../api/app.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { buildTaskEngines } from '../../api/tasks/build.js';
import type { CreateApplyInput } from '../../api/tasks/store.js';
import { TaskWatch } from '../../api/tasks/watch.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

/**
 * T8 — resumable SSE `/tasks/{id}/watch` + tasks metadata fold-in.
 *
 * The engine-wired app build mirrors internal-task-progress.test.ts
 * (buildTestApp + buildTaskEngines + an internal-agent token to POST
 * /internal/v1/task_progress), with the addition of a live TaskWatch on
 * ctx.taskWatch so the T5 progress receiver's notify() reaches subscribers.
 *
 * SSE without hanging: the live/resume cases drive a raw http.request against
 * a REAL listening server (the in-process app), read a BOUNDED number of SSE
 * frames, then destroy the request and close the server. supertest buffers
 * until the stream ends, so it is unsuitable for a never-ending stream — it is
 * used only for the (terminating) metadata reads.
 */

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-t8';
const ADMIN_TOKEN = 'Bearer tok-admin';

interface WatchSetup extends TestSetup {
  cleanup(): Promise<void>;
  watch: TaskWatch;
  /** Seed a queued apply task; returns its task_id. */
  seedTask(input?: Partial<CreateApplyInput>): string;
}

async function buildAppWithWatch(): Promise<WatchSetup> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  const tasks = buildTaskEngines({ state: setup.state });
  const watch = new TaskWatch();
  const spillDir = join(setup.dir, 'task-logs');

  const ctx: ApiContext = {
    config: setup.config,
    state: setup.state,
    tracker,
    tasks,
    taskWatch: watch,
    taskProgressSpillDir: spillDir,
  };
  const app = createApp(ctx);

  return {
    ...setup,
    app,
    ctx,
    watch,
    seedTask(input) {
      const task = tasks.store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'rest',
        request_id: 'req-1',
        correlation_id: 'corr-1',
        input_hash: 'deadbeef',
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
        ...input,
      });
      return task.task_id;
    },
    async cleanup() {
      await setup.cleanup();
    },
  };
}

function postProgress(setup: WatchSetup, body: Record<string, unknown>) {
  return request(setup.app)
    .post('/internal/v1/task_progress')
    .set('Authorization', `Bearer ${AGENT_TOKEN}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

/** Split a raw SSE buffer into complete `id:/data:` frame blocks. */
function parseFrames(buf: string): string[] {
  return buf
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Open a real SSE connection to the in-process app and resolve once `minFrames`
 * complete frames have arrived (or the deadline fires). Always tears the socket
 * + server down so no handle leaks into the runner.
 *
 * `afterOpen` runs after the response headers land (so a live notify fired from
 * it races against an already-attached subscriber, not a still-connecting one).
 */
async function readSse(
  setup: WatchSetup,
  path: string,
  opts: {
    minFrames: number;
    headers?: Record<string, string>;
    afterOpen?: () => void | Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ status: number; contentType: string | undefined; frames: string[] }> {
  const server = http.createServer(setup.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Authorization: ADMIN_TOKEN, ...(opts.headers ?? {}) },
      },
      (res) => {
        let buf = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          server.close(() => {
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers['content-type'],
              frames: parseFrames(buf),
            });
          });
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          if (parseFrames(buf).length >= opts.minFrames) finish();
        });
        res.on('end', finish);
        res.on('error', () => finish());
        // The headers are in by the time this callback runs; trigger the live
        // event now so the subscriber is already attached.
        void Promise.resolve(opts.afterOpen?.());
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      server.close(() => reject(new Error(`SSE timed out waiting for ${opts.minFrames} frame(s)`)));
    }, opts.timeoutMs ?? 3_000);
    timer.unref();
    req.on('error', (err) => {
      // A destroy() after we've settled surfaces here; ignore once settled.
      clearTimeout(timer);
      if (!server.listening) return;
      server.close(() => reject(err));
    });
    req.end();
  });
}

describe('GET /tasks/{id}/watch — resumable SSE', () => {
  let setup: WatchSetup;
  beforeEach(async () => {
    setup = await buildAppWithWatch();
  });
  afterEach(() => setup.cleanup());

  it('404s for an unknown task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-deadbeefdead/watch')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('no Last-Event-ID: sends the current Task snapshot first, then a live event', async () => {
    // Seed the internal-only columns so the snapshot frame's strip is exercised.
    const taskId = setup.seedTask({
      spec: { fail_at_stage: 'apply', secret: 'do-not-echo' },
      plan_binding: {
        observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision: 1 },
      },
      desired_rollback: [{ key: '/xinas/v1/desired/Share/s1', prior_value: null }],
    });

    const out = await readSse(setup, `/api/v1/tasks/${taskId}/watch`, {
      minFrames: 2,
      afterOpen: async () => {
        // Drive a live event through the T5 receiver; it calls
        // ctx.taskWatch.notify() after applying, which fans out to subscribers.
        await postProgress(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
      },
    });

    expect(out.status).toBe(200);
    expect(out.contentType).toMatch(/text\/event-stream/);
    expect(out.frames.length).toBeGreaterThanOrEqual(2);

    // Frame 1: the current snapshot — carries the seeded task.
    const snapshot = JSON.parse(dataOf(out.frames[0]!));
    expect(snapshot.task_id).toBe(taskId);
    expect(snapshot.state).toBe('queued');
    // The internal-only columns must NOT cross the wire on the SSE snapshot.
    expect(snapshot.spec).toBeUndefined();
    expect(snapshot.plan_binding).toBeUndefined();
    expect(snapshot.desired_rollback).toBeUndefined();

    // A later frame is the live 'accepted' event the receiver applied.
    const live = out.frames.slice(1).map((f) => JSON.parse(dataOf(f)));
    expect(live.some((e) => e.event_type === 'accepted')).toBe(true);
  });

  it('Last-Event-ID behind the current sequence: resyncs the current snapshot, then live', async () => {
    const taskId = setup.seedTask();

    // Build durable history → last_event_sequence advances to 3.
    await postProgress(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    await postProgress(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'preflight',
      output_inline: 'ok-0',
    });
    await postProgress(setup, {
      task_id: taskId,
      sequence: 3,
      event_type: 'stage_succeeded',
      stage_index: 1,
      stage_name: 'apply',
      output_inline: 'ok-1',
    });

    // Reconnect having seen only sequence 1 (Last-Event-ID: 1), behind the
    // current high-water mark (3). RESYNC: the durable record is the rolled-up
    // task_stages — not a per-event log — so the catch-up is one current-Task
    // snapshot frame keyed at last_event_sequence (3), then the live event.
    const out = await readSse(setup, `/api/v1/tasks/${taskId}/watch`, {
      minFrames: 2,
      headers: { 'Last-Event-ID': '1' },
      afterOpen: async () => {
        await postProgress(setup, {
          task_id: taskId,
          sequence: 4,
          event_type: 'terminal',
          status: 'success',
        });
      },
    });

    expect(out.status).toBe(200);

    // Frame 1 is the resync snapshot: the full Task (no event_type), carrying
    // the rolled-up high-water mark, keyed at the current sequence (3).
    const first = out.frames[0]!;
    const snapshot = JSON.parse(dataOf(first));
    expect(snapshot.task_id).toBe(taskId);
    expect(snapshot.event_type).toBeUndefined();
    expect(snapshot.last_event_sequence).toBe(3);
    expect(idOf(first)).toBe('3');

    // A live terminal event (sequence 4) follows, keyed at its own sequence —
    // the SSE id space is a single, coherent event-sequence space.
    const terminal = out.frames
      .slice(1)
      .map((f) => ({ id: idOf(f), data: JSON.parse(dataOf(f)) }))
      .find((e) => e.data.event_type === 'terminal');
    expect(terminal).toBeDefined();
    expect(terminal?.id).toBe('4');
  });

  it('Last-Event-ID at the current sequence: no resync snapshot, only live frames', async () => {
    const taskId = setup.seedTask();

    // Advance the high-water mark to 3.
    await postProgress(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    await postProgress(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_started',
      stage_index: 0,
      stage_name: 'preflight',
    });
    await postProgress(setup, {
      task_id: taskId,
      sequence: 3,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'preflight',
    });

    // Reconnect already current (Last-Event-ID: 3 == last_event_sequence). No
    // snapshot is re-sent; the client attaches live and only sees NEW events.
    const out = await readSse(setup, `/api/v1/tasks/${taskId}/watch`, {
      minFrames: 1,
      headers: { 'Last-Event-ID': '3' },
      afterOpen: async () => {
        await postProgress(setup, {
          task_id: taskId,
          sequence: 4,
          event_type: 'terminal',
          status: 'success',
        });
      },
    });

    expect(out.status).toBe(200);

    // Every frame is a live progress event (has event_type); none is the Task
    // resync snapshot (which would carry no event_type).
    const datas = out.frames.map((f) => JSON.parse(dataOf(f)));
    expect(datas.length).toBeGreaterThanOrEqual(1);
    for (const d of datas) expect(d.event_type).toBeDefined();

    // The first (and only required) frame is the live terminal, keyed at its
    // own sequence.
    const terminal = out.frames
      .map((f) => ({ id: idOf(f), data: JSON.parse(dataOf(f)) }))
      .find((e) => e.data.event_type === 'terminal');
    expect(terminal).toBeDefined();
    expect(terminal?.id).toBe('4');
  });

  it('cleans up the subscriber on client disconnect', async () => {
    const taskId = setup.seedTask();
    await readSse(setup, `/api/v1/tasks/${taskId}/watch`, { minFrames: 1 });
    // The server-side res.on('close') unsubscribe fires asynchronously after the
    // client tears the socket down; wait for the bucket to drain (bounded).
    const deadline = Date.now() + 1_000;
    while (setup.watch.subscriberCount(taskId) > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // After cleanup the watch holds no subscribers for the task, so a later
    // notify is a no-op (does not throw / write to a dead res).
    expect(setup.watch.subscriberCount(taskId)).toBe(0);
    expect(() =>
      setup.watch.notify(taskId, { task_id: taskId, sequence: 99, event_type: 'terminal' }),
    ).not.toThrow();
  });
});

describe('tasks metadata fold-in (engine-backed reads)', () => {
  let setup: WatchSetup;
  beforeEach(async () => {
    setup = await buildAppWithWatch();
  });
  afterEach(() => setup.cleanup());

  it('GET /tasks returns a metadata object per task', async () => {
    const taskId = setup.seedTask();
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    const task = res.body.result[0];
    expect(task.task_id).toBe(taskId);
    expect(task.metadata).toMatchObject({
      revision: expect.any(Number),
      owner: 'admin:test',
      source: 'rest',
      validation_status: 'valid',
    });
    expect(typeof task.metadata.created_at).toBe('string');
    expect(typeof task.metadata.modified_at).toBe('string');
    // created_at/modified_at are ISO strings (the metadata projection).
    expect(new Date(task.metadata.created_at).toString()).not.toBe('Invalid Date');
  });

  it('GET /tasks/{id} returns a metadata object', async () => {
    const taskId = setup.seedTask();
    const res = await request(setup.app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.task_id).toBe(taskId);
    expect(res.body.result.metadata).toMatchObject({
      owner: 'admin:test',
      source: 'rest',
      validation_status: 'valid',
    });
  });

  it('GET /tasks/{id} 404s when no such task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-deadbeefdead')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /tasks and /tasks/{id} do NOT leak the internal columns (spec, plan_binding, desired_rollback)', async () => {
    const taskId = setup.seedTask({
      spec: { fail_at_stage: 'apply', secret: 'do-not-echo' },
      plan_binding: {
        observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision: 1 },
      },
      desired_rollback: [{ key: '/xinas/v1/desired/Share/s1', prior_value: null }],
    });

    const one = await request(setup.app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(one.status).toBe(200);
    expect(one.body.result.task_id).toBe(taskId);
    // spec/plan_binding/desired_rollback are internal-only columns — never part
    // of the public Task read.
    expect(one.body.result.spec).toBeUndefined();
    expect(one.body.result.plan_binding).toBeUndefined();
    expect(one.body.result.desired_rollback).toBeUndefined();

    const list = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(list.status).toBe(200);
    const seeded = (
      list.body.result as Array<{
        task_id: string;
        spec?: unknown;
        plan_binding?: unknown;
        desired_rollback?: unknown;
      }>
    ).find((t) => t.task_id === taskId);
    expect(seeded).toBeDefined();
    expect(seeded?.spec).toBeUndefined();
    expect(seeded?.plan_binding).toBeUndefined();
    expect(seeded?.desired_rollback).toBeUndefined();
  });
});

/** Extract the `data:` payload from a single SSE frame block. */
function dataOf(frame: string): string {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (line === undefined) throw new Error(`frame has no data: line:\n${frame}`);
  return line.slice('data:'.length).trim();
}

/** Extract the `id:` value from a single SSE frame block (or undefined). */
function idOf(frame: string): string | undefined {
  const line = frame.split('\n').find((l) => l.startsWith('id:'));
  return line ? line.slice('id:'.length).trim() : undefined;
}
