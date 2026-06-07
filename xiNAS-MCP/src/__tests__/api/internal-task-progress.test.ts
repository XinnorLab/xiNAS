import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../api/app.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { buildTaskEngines } from '../../api/tasks/build.js';
import type { CreateApplyInput } from '../../api/tasks/store.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-t5';

interface ProgressSetup extends TestSetup {
  cleanup(): Promise<void>;
  spillDir: string;
  /** Seed a `running`-eligible queued apply task; returns its task_id. */
  seedTask(input?: Partial<CreateApplyInput>): string;
}

async function buildAppWithProgress(): Promise<ProgressSetup> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  // Deterministic-enough clock/id; the store needs them but tests don't assert on them.
  const tasks = buildTaskEngines({ state: setup.state });
  const spillDir = join(setup.dir, 'task-logs');

  const ctx: ApiContext = {
    config: setup.config,
    state: setup.state,
    tracker,
    tasks,
    taskProgressSpillDir: spillDir,
  };
  const app = createApp(ctx);

  return {
    ...setup,
    app,
    ctx,
    spillDir,
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

function post(setup: ProgressSetup, body: Record<string, unknown>) {
  return request(setup.app)
    .post('/internal/v1/task_progress')
    .set('Authorization', `Bearer ${AGENT_TOKEN}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /internal/v1/task_progress', () => {
  let setup: ProgressSetup;

  beforeEach(async () => {
    setup = await buildAppWithProgress();
  });
  afterEach(() => setup.cleanup());

  function getTask(id: string) {
    return setup.ctx.tasks!.store.get(id);
  }

  it('applies accepted → stage_started → stage_succeeded (transitions + stage rows)', async () => {
    const taskId = setup.seedTask();

    const r1 = await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    expect(r1.status).toBe(200);
    expect(r1.body.result).toMatchObject({ applied: true, sequence: 1 });
    expect(getTask(taskId)?.state).toBe('running');

    const r2 = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_started',
      stage_index: 0,
      stage_name: 'apply',
    });
    expect(r2.status).toBe(200);
    let task = getTask(taskId)!;
    expect(task.last_event_sequence).toBe(2);
    let stage = task.stages.find((s) => s.stage_index === 0)!;
    expect(stage.name).toBe('apply');
    expect(stage.status).toBe('running');
    expect(stage.started_at).toBeDefined();

    const r3 = await post(setup, {
      task_id: taskId,
      sequence: 3,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'apply',
      output_inline: 'all good',
      output_size_bytes: 8,
    });
    expect(r3.status).toBe(200);
    task = getTask(taskId)!;
    expect(task.last_event_sequence).toBe(3);
    stage = task.stages.find((s) => s.stage_index === 0)!;
    expect(stage.status).toBe('success');
    expect(stage.ended_at).toBeDefined();
    expect(stage.output_inline).toBe('all good');
    expect(stage.output_size_bytes).toBe(8);
  });

  it('records a stage_failed with error code/message', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_failed',
      stage_index: 1,
      stage_name: 'verify',
      error_code: 'EVERIFY',
      error_message: 'verification failed',
      output_size_bytes: 0,
    });
    expect(res.status).toBe(200);
    const stage = getTask(taskId)!.stages.find((s) => s.stage_index === 1)!;
    expect(stage.status).toBe('failed');
    expect(stage.error_code).toBe('EVERIFY');
    expect(stage.error_message).toBe('verification failed');
  });

  it('treats a duplicate / lower sequence as a 200 no-op (nothing changes)', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_started',
      stage_index: 0,
      stage_name: 'apply',
    });

    const before = getTask(taskId)!;
    expect(before.last_event_sequence).toBe(2);

    // Replay sequence 2 with a DIFFERENT payload — must be ignored.
    const dup = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'apply',
      output_inline: 'should-not-apply',
      output_size_bytes: 17,
    });
    expect(dup.status).toBe(200);
    expect(dup.body.result).toMatchObject({ applied: false, sequence: 2 });

    // Lower sequence too.
    const lower = await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    expect(lower.status).toBe(200);
    expect(lower.body.result.applied).toBe(false);

    const after = getTask(taskId)!;
    expect(after.last_event_sequence).toBe(2);
    const stage = after.stages.find((s) => s.stage_index === 0)!;
    // Still 'running' from seq 2 — the replayed stage_succeeded did NOT apply.
    expect(stage.status).toBe('running');
    expect(stage.output_inline).toBeUndefined();
  });

  it('terminal{state:success, snapshot_id} → terminal task, snapshot_after set, leases released', async () => {
    const taskId = setup.seedTask();
    // Seed a lease held by this task.
    const acq = setup.state.leases.acquire({
      resource_kind: 'Reference',
      resource_id: 'r1',
      task_id: taskId,
      ttl_seconds: 60,
    });
    expect(acq.ok).toBe(true);
    expect(
      (
        setup.state.db
          .prepare('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?')
          .get(taskId) as { n: number }
      ).n,
    ).toBe(1);

    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'terminal',
      status: 'success',
      snapshot_id: 'snap-after-123',
    });
    expect(res.status).toBe(200);

    const task = getTask(taskId)!;
    expect(task.state).toBe('success');
    expect(task.snapshot_after).toBe('snap-after-123');
    expect(task.terminal_at).toBeDefined();

    // Leases released.
    expect(
      (
        setup.state.db
          .prepare('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?')
          .get(taskId) as { n: number }
      ).n,
    ).toBe(0);
  });

  it('terminal{state:failed} carries error_code/error_message', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'terminal',
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
      error_message: 'apply failed, rolled back',
    });
    expect(res.status).toBe(200);
    const task = getTask(taskId)!;
    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');
    expect(task.error_message).toBe('apply failed, rolled back');
  });

  it('records rollback stage events', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    await post(setup, { task_id: taskId, sequence: 2, event_type: 'rollback_started' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 3,
      event_type: 'rollback_succeeded',
    });
    expect(res.status).toBe(200);
    const stage = getTask(taskId)!.stages.find((s) => s.name === 'rollback')!;
    expect(stage).toBeDefined();
    expect(stage.status).toBe('success');
  });

  it('snapshot_before stage writes tasks.snapshot_before', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'snapshot_before',
      snapshot_id: 'snap-before-9',
      output_size_bytes: 0,
    });
    expect(getTask(taskId)?.snapshot_before).toBe('snap-before-9');
  });

  it('spills output_inline > 64 KiB to a file under the injected dir; output_path set, inline null', async () => {
    const taskId = setup.seedTask();
    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });

    const big = 'x'.repeat(70 * 1024); // > 64 KiB
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'stage_succeeded',
      stage_index: 0,
      stage_name: 'apply',
      output_inline: big,
      output_size_bytes: big.length,
    });
    expect(res.status).toBe(200);

    const stage = getTask(taskId)!.stages.find((s) => s.stage_index === 0)!;
    expect(stage.output_inline).toBeUndefined();
    expect(stage.output_path).toBeDefined();
    expect(stage.output_size_bytes).toBe(big.length);

    // The file exists under the injected spill dir and holds the content.
    const abs = join(setup.spillDir, stage.output_path!);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(big);
    // Path is relative (no leading slash, no traversal).
    expect(stage.output_path!.startsWith('/')).toBe(false);
    expect(stage.output_path).toContain(taskId);
  });

  it('unknown event_type → 400 INVALID_ARGUMENT', async () => {
    const taskId = setup.seedTask();
    const res = await post(setup, {
      task_id: taskId,
      sequence: 1,
      event_type: 'not_a_real_event',
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('missing task_id / sequence → 400 INVALID_ARGUMENT', async () => {
    const res = await post(setup, { event_type: 'accepted' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('unknown task → 404 NOT_FOUND', async () => {
    const res = await post(setup, {
      task_id: 'no-such-task',
      sequence: 1,
      event_type: 'accepted',
    });
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('path-traversal task_id is rejected with 400 (spill-path defense-in-depth)', async () => {
    for (const taskId of ['../etc/passwd', 'a/b', '..', 'x\\y']) {
      const res = await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
    }
  });

  // ── N0.4: Model R desired-state revert on terminal-failed ─────────────────
  it('terminal{state:failed} reverts the task desired_mutations (prior absent → key deleted)', async () => {
    const taskId = setup.seedTask({
      desired_rollback: [{ key: '/xinas/v1/desired/Share/sY', prior_value: null }],
    });
    // The apply would have written this desired key; seed it directly here.
    setup.state.kv.put('/xinas/v1/desired/Share/sY', { id: 'sY' });
    expect(setup.state.kv.get('/xinas/v1/desired/Share/sY')?.value).toEqual({ id: 'sY' });

    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'terminal',
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
      error_message: 'apply failed, rolled back',
    });
    expect(res.status).toBe(200);
    expect(getTask(taskId)?.state).toBe('failed');
    // Prior was absent → the desired write is reverted (key deleted).
    expect(setup.state.kv.get('/xinas/v1/desired/Share/sY')).toBeNull();
  });

  it('terminal{state:success} KEEPS the task desired_mutations (no revert)', async () => {
    const taskId = setup.seedTask({
      desired_rollback: [{ key: '/xinas/v1/desired/Share/sZ', prior_value: null }],
    });
    setup.state.kv.put('/xinas/v1/desired/Share/sZ', { id: 'sZ' });

    await post(setup, { task_id: taskId, sequence: 1, event_type: 'accepted' });
    const res = await post(setup, {
      task_id: taskId,
      sequence: 2,
      event_type: 'terminal',
      status: 'success',
    });
    expect(res.status).toBe(200);
    expect(getTask(taskId)?.state).toBe('success');
    // Terminal-success keeps the desired write intact.
    expect(setup.state.kv.get('/xinas/v1/desired/Share/sZ')?.value).toEqual({ id: 'sZ' });
  });

  it('rejects without the internal-agent bearer with 401', async () => {
    const taskId = setup.seedTask();
    const res = await request(setup.app)
      .post('/internal/v1/task_progress')
      .set('Authorization', 'Bearer tok-admin')
      .send({ task_id: taskId, sequence: 1, event_type: 'accepted' });
    expect(res.status).toBe(401);
  });
});
