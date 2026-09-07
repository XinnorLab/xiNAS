import { describe, expect, it } from 'vitest';
import {
  createTaskResultFor,
  formatElapsed,
  mcpStatusFor,
  pollIntervalFor,
  projectTask,
  publicTaskForMcp,
  residualNoteFor,
  statusMessageFor,
  terminalResultFor,
  ttlMsFor,
} from '../../../api/mcp/tasks/projection.js';
import type { Task, TaskStage } from '../../../api/tasks/types.js';

const T0 = 1_700_000_000_000;
const RET = 30 * 86400 * 1000;

function stage(
  i: number,
  name: string,
  status: TaskStage['status'],
  over: Partial<TaskStage> = {},
): TaskStage {
  return { stage_index: i, name, status, output_size_bytes: 0, ...over };
}

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'fs.create',
    task_id: 't-1',
    state: 'queued',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'r',
    correlation_id: 'c',
    input_hash: 'h',
    risk_level: 'non_disruptive',
    affected_resources: [{ kind: 'Filesystem', id: 'mnt-data.mount' }],
    last_event_sequence: 0,
    created_at: T0,
    updated_at: T0,
    stages: [],
    plan_document_hash: 'pd',
    plan_document: { schema: 1 } as unknown as NonNullable<Task['plan_document']>,
    ...over,
  };
}

const runningMkfs = () =>
  task({
    state: 'running',
    stage_total: 5,
    updated_at: T0 + 5000,
    stages: [
      stage(0, 'snapshot_before', 'success', { started_at: T0, ended_at: T0 + 1000 }),
      stage(1, 'preflight', 'success', { started_at: T0 + 1000, ended_at: T0 + 2000 }),
      stage(2, 'mkfs', 'running', { started_at: T0 + 2000, output_path: 'x/stage-2.log' }),
    ],
  });

describe('state map (S16 §6.1)', () => {
  it.each([
    ['queued', 'working'],
    ['running', 'working'],
    ['success', 'completed'],
    ['failed', 'completed'],
    ['requires_manual_recovery', 'completed'],
    ['cancelled', 'cancelled'],
    ['plan_only', null],
    ['imported', null],
  ] as const)('%s → %s', (state, status) => {
    expect(mcpStatusFor(state)).toBe(status);
  });
  it('plan_only / imported are not projectable', () => {
    expect(projectTask(task({ state: 'plan_only' }), { now: T0, retentionMs: RET })).toBeNull();
    expect(
      createTaskResultFor(task({ state: 'imported' }), { now: T0, retentionMs: RET }),
    ).toBeNull();
  });
});

describe('statusMessage (S16 §6.3, TASKS-FS-003)', () => {
  it('queued', () => {
    expect(statusMessageFor(task(), T0 + 3000)).toBe(
      'fs.create: queued, waiting for an executor slot; elapsed 3s',
    );
  });
  it('running mkfs: stage, position, elapsed, the percentage disclaimer, the point-of-no-return clause', () => {
    const m = statusMessageFor(runningMkfs(), T0 + 134_000);
    expect(m).toContain("fs.create: stage 'mkfs' (2 of 5) running for 2m 12s; elapsed 2m 14s");
    expect(m).toContain('mkfs.xfs does not report a completion percentage');
    expect(m).toContain('cancellation can no longer safely stop formatting');
    expect(m).not.toMatch(/\d+\s*%/);
  });
  it('running before the irreversible stage with a pending cancel', () => {
    const t = task({
      state: 'running',
      stage_total: 5,
      cancel_requested_at: T0 + 500,
      stages: [
        stage(0, 'snapshot_before', 'success'),
        stage(1, 'preflight', 'running', { started_at: T0 }),
      ],
    });
    const m = statusMessageFor(t, T0 + 4000);
    expect(m).toContain("stage 'preflight' (1 of 5)");
    expect(m).toContain('cancellation requested, stopping at the next safe point');
    expect(m).not.toContain('no longer');
  });
  it('rolling back names the failed stage', () => {
    const t = task({
      state: 'running',
      stages: [stage(1, 'mount', 'failed'), stage(2, 'rollback', 'running', { started_at: T0 })],
    });
    expect(statusMessageFor(t, T0 + 1000)).toContain("rolling back after stage 'mount'");
  });
  it('terminals freeze elapsed at terminal_at and never show a percentage', () => {
    const ok = task({ state: 'success', terminal_at: T0 + 252_000 });
    expect(statusMessageFor(ok, T0 + 999_000)).toBe('fs.create: succeeded in 4m 12s');
    const failed = task({
      state: 'failed',
      terminal_at: T0 + 10_000,
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
      error_message: 'enableNow exploded',
    });
    expect(statusMessageFor(failed, T0 + 999_000)).toBe(
      'fs.create: failed (FAILED_PARTIAL_ROLLED_BACK) after 10s: enableNow exploded',
    );
    const rmr = task({
      state: 'requires_manual_recovery',
      terminal_at: T0 + 10_000,
      error_code: 'FAILED_MANUAL_RECOVERY_REQUIRED',
    });
    expect(statusMessageFor(rmr, T0)).toContain(
      'requires manual recovery (FAILED_MANUAL_RECOVERY_REQUIRED)',
    );
    const cancelled = task({ state: 'cancelled', terminal_at: T0 + 3000 });
    expect(statusMessageFor(cancelled, T0)).toBe(
      'fs.create: cancelled at a safe point after 3s; partial work rolled back',
    );
  });
  it('formatElapsed', () => {
    expect(formatElapsed(5)).toBe('5s');
    expect(formatElapsed(134)).toBe('2m 14s');
    expect(formatElapsed(3780)).toBe('1h 3m');
  });
});

describe('pollIntervalMs / ttlMs (S16 §6.4, §6.5)', () => {
  it('2000 queued, 5000 while mkfs runs, absent on terminals', () => {
    expect(pollIntervalFor(task(), T0)).toBe(2000);
    expect(pollIntervalFor(runningMkfs(), T0 + 3000)).toBe(5000);
    expect(
      pollIntervalFor(
        task({ state: 'running', stages: [stage(1, 'preflight', 'running', { started_at: T0 })] }),
        T0,
      ),
    ).toBe(2000);
    expect(pollIntervalFor(task({ state: 'success', terminal_at: T0 + 1 }), T0)).toBeUndefined();
  });
  it('ttlMs null while live, total lifetime once terminal', () => {
    expect(ttlMsFor(task(), RET)).toBeNull();
    expect(ttlMsFor(task({ state: 'success', terminal_at: T0 + 252_000 }), RET)).toBe(
      252_000 + RET,
    );
  });
});

describe('terminal result and redaction (S16 §6.6, §9.5)', () => {
  it('strips plan_document* and output_url, keeps the rest of the public Task', () => {
    const pub = publicTaskForMcp(runningMkfs());
    expect(pub).not.toHaveProperty('plan_document');
    expect(pub).not.toHaveProperty('plan_document_hash');
    expect(pub).not.toHaveProperty('spec');
    for (const s of pub.stages as Array<Record<string, unknown>>)
      expect(s).not.toHaveProperty('output_url');
    expect(pub.task_id).toBe('t-1');
    expect(pub.progress).toBeDefined();
    expect(pub.created_at).toBe(new Date(T0).toISOString());
  });
  it('isError on failed / requires_manual_recovery only; residual note when mkfs succeeded before the failure', () => {
    const failedAfterMkfs = task({
      state: 'failed',
      terminal_at: T0 + 9000,
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
      stages: [
        stage(1, 'mkfs', 'success', { output_inline: 'mkfs.xfs -f -L data /dev/xi_data' }),
        stage(2, 'mount', 'failed'),
      ],
    });
    const r = terminalResultFor(failedAfterMkfs);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]?.text ?? '{}') as {
      result: { state: string };
      residual?: string;
    };
    expect(body.result.state).toBe('failed');
    expect(body.residual).toContain('/dev/xi_data may carry an unmanaged XFS filesystem');
    expect(body.residual).toContain('do not reformat');
    expect(
      residualNoteFor(
        task({ state: 'success', terminal_at: T0, stages: [stage(1, 'mkfs', 'success')] }),
      ),
    ).toBeUndefined();
    expect(
      residualNoteFor(
        task({ state: 'failed', terminal_at: T0, stages: [stage(1, 'preflight', 'failed')] }),
      ),
    ).toBeUndefined();
    expect(terminalResultFor(task({ state: 'success', terminal_at: T0 })).isError).toBeUndefined();
  });
  it('projectTask / createTaskResultFor are stable across renders and carry the row timestamps', () => {
    const t = runningMkfs();
    const a = projectTask(t, { now: T0 + 3000, retentionMs: RET });
    const b = projectTask(t, { now: T0 + 3000, retentionMs: RET });
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      taskId: 't-1',
      status: 'working',
      createdAt: new Date(T0).toISOString(),
      lastUpdatedAt: new Date(T0 + 5000).toISOString(),
      ttlMs: null,
      pollIntervalMs: 5000,
    });
    const h = createTaskResultFor(task({ state: 'success', terminal_at: T0 + 10 }), {
      now: T0,
      retentionMs: RET,
    });
    expect(h).toMatchObject({ resultType: 'task', status: 'completed', ttlMs: 10 + RET });
    expect(h).not.toHaveProperty('pollIntervalMs');
    expect(h).not.toHaveProperty('result');
  });
});

describe('createTaskResultFor warnings → _meta (review F2)', () => {
  const t = task({ state: 'success', terminal_at: T0 + 10 });

  it('adds _meta["io.xinas/warnings"] when warnings is a non-empty array', () => {
    const warnings = [{ code: 'EXECUTOR_DEGRADED', message: 'x' }];
    const h = createTaskResultFor(t, { now: T0, retentionMs: RET }, warnings);
    expect(h).toMatchObject({ _meta: { 'io.xinas/warnings': warnings } });
  });

  it('omits _meta when warnings is undefined or empty', () => {
    expect(createTaskResultFor(t, { now: T0, retentionMs: RET })).not.toHaveProperty('_meta');
    expect(createTaskResultFor(t, { now: T0, retentionMs: RET }, [])).not.toHaveProperty('_meta');
  });
});
