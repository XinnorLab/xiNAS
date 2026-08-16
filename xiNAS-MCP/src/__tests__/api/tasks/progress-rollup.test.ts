/**
 * The task progress rollup (2026-08-16 progress design §3). Pure unit test —
 * builds Task fixtures and asserts the summary, no DB and no HTTP.
 */

import { describe, expect, it } from 'vitest';
import { taskProgress } from '../../../api/tasks/render.js';
import type { Task, TaskStage } from '../../../api/tasks/types.js';

const T0 = 1_700_000_000_000; // task created_at
const NOW = T0 + 96_000; // 96 s later

function stage(over: Partial<TaskStage> & { stage_index: number; name: string }): TaskStage {
  return { status: 'success', output_size_bytes: 0, ...over } as TaskStage;
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    task_id: 't1',
    kind: 'fs.create',
    state: 'running',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    input_hash: 'abc',
    risk_level: 'changing_access',
    affected_resources: [],
    last_event_sequence: 4,
    created_at: T0,
    updated_at: NOW,
    stages: [],
    ...over,
  };
}

describe('taskProgress', () => {
  it('reports the running executor stage against stage_total', () => {
    const task = makeTask({
      stage_total: 5,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 55_000 }),
        stage({ stage_index: 2, name: 'mkfs', status: 'running', started_at: T0 + 55_000 }),
      ],
    });

    expect(taskProgress(task, NOW)).toEqual({
      phase: 'executing',
      stage_name: 'mkfs',
      stage_status: 'running',
      stage_index: 2,
      stage_position: 2,
      stage_total: 5,
      completed_stages: 1,
      elapsed_s: 96,
      stage_elapsed_s: 41,
    });
  });

  it('omits the denominator for a task that predates stage_total', () => {
    const task = makeTask({
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', status: 'running', started_at: T0 + 1_000 }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.stage_total).toBeUndefined();
    expect(p?.stage_position).toBe(1);
  });

  it('reports phase=preparing before the first executor stage starts', () => {
    const queued = makeTask({ state: 'queued', stages: [] });
    expect(taskProgress(queued, NOW)).toEqual({
      phase: 'preparing',
      completed_stages: 0,
      elapsed_s: 96,
    });
  });

  it('reports phase=rolling_back while the rollback stage runs, without counting it', () => {
    const task = makeTask({
      stage_total: 5,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 5_000 }),
        stage({
          stage_index: 2,
          name: 'mkfs',
          status: 'failed',
          started_at: T0 + 5_000,
          ended_at: T0 + 90_000,
        }),
        stage({ stage_index: 3, name: 'rollback', status: 'running', started_at: T0 + 90_000 }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.phase).toBe('rolling_back');
    expect(p?.stage_name).toBe('rollback');
    expect(p?.stage_position).toBeUndefined(); // synthetic rows have no position
    expect(p?.completed_stages).toBe(1);
  });

  it('reports phase=done and total elapsed for a terminal task', () => {
    const task = makeTask({
      state: 'success',
      stage_total: 5,
      terminal_at: T0 + 120_000,
      stages: [
        stage({ stage_index: 0, name: 'snapshot_before', started_at: T0, ended_at: T0 + 1_000 }),
        stage({ stage_index: 1, name: 'preflight', started_at: T0 + 1_000, ended_at: T0 + 5_000 }),
        stage({ stage_index: 2, name: 'mkfs', started_at: T0 + 5_000, ended_at: T0 + 100_000 }),
        stage({
          stage_index: 3,
          name: 'install_unit',
          started_at: T0 + 100_000,
          ended_at: T0 + 101_000,
        }),
        stage({ stage_index: 4, name: 'mount', started_at: T0 + 101_000, ended_at: T0 + 102_000 }),
        stage({ stage_index: 5, name: 'verify', started_at: T0 + 102_000, ended_at: T0 + 103_000 }),
        stage({
          stage_index: 6,
          name: 'snapshot_after',
          started_at: T0 + 119_000,
          ended_at: T0 + 120_000,
        }),
      ],
    });

    const p = taskProgress(task, NOW);
    expect(p?.phase).toBe('done');
    expect(p?.completed_stages).toBe(5);
    expect(p?.elapsed_s).toBe(120); // terminal_at − created_at, not now
  });

  it('has no progress at all for a plan_only task', () => {
    expect(taskProgress(makeTask({ state: 'plan_only', stages: [] }), NOW)).toBeUndefined();
  });
});
