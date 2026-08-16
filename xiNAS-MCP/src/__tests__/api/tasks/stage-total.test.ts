/**
 * `stage_total` travels agent → api → durable task row (2026-08-16 progress
 * design §1). Drives applyEvent directly — no HTTP, no DB.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyEvent } from '../../../api/tasks/progress.js';
import type { Task } from '../../../api/tasks/types.js';

function makeStore() {
  return { transition: vi.fn(), upsertStage: vi.fn() };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-abc',
    kind: 'fs.create',
    state: 'queued',
    principal: 'admin:test',
    client_type: 'mcp',
    request_id: 'req-1',
    correlation_id: 'corr-1',
    input_hash: 'abc',
    risk_level: 'changing_access',
    affected_resources: [],
    last_event_sequence: 0,
    created_at: 1000,
    updated_at: 1000,
    stages: [],
    ...overrides,
  };
}

const deps = (store: ReturnType<typeof makeStore>, task: Task, event: unknown) =>
  ({
    store,
    task,
    event,
    spillDir: '/tmp/does-not-matter',
    heartbeat: vi.fn(),
    releaseLeases: vi.fn(),
    revertDesired: vi.fn(),
    captureDesired: vi.fn(),
  }) as unknown as Parameters<typeof applyEvent>[0];

describe('applyEvent — accepted carries stage_total', () => {
  it('persists stage_total alongside the queued→running transition', () => {
    const store = makeStore();
    const task = makeTask();

    applyEvent(
      deps(store, task, {
        task_id: task.task_id,
        sequence: 1,
        event_type: 'accepted',
        stage_total: 5,
      }),
    );

    expect(store.transition).toHaveBeenCalledWith(task.task_id, {
      last_event_sequence: 1,
      state: 'running',
      stage_total: 5,
    });
  });

  it('omits stage_total when the agent did not send one (older agent)', () => {
    const store = makeStore();
    const task = makeTask();

    applyEvent(deps(store, task, { task_id: task.task_id, sequence: 1, event_type: 'accepted' }));

    expect(store.transition).toHaveBeenCalledWith(task.task_id, {
      last_event_sequence: 1,
      state: 'running',
    });
  });
});
