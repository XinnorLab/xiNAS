/**
 * S2 T7 — agent task RPC handlers (task.begin / task.cancel / task.list_inflight).
 *
 * Hermetic: a fake runner + fake registry let us assert idempotent begin
 * (run called once for a repeated task_id), the EXECUTOR_UNSUPPORTED rejection
 * for an unknown kind, the in-flight listing, and cooperative cancel — without
 * spawning python or pushing progress to a real api.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutorRegistry } from '../../../../agent/task/registry.js';
import type { InflightTask, TaskRunner } from '../../../../agent/task/runner.js';
import { makeTaskHandlers } from '../../../../agent/rpc/methods/task.js';
import type { Executor, PublishProgress } from '../../../../agent/task/types.js';

/** A no-op publisher — the fake runner ignores it; the real one wouldn't. */
const noopPublish: PublishProgress = async () => {};

// ---- fakes ---------------------------------------------------------------

const dummyExecutor: Executor = {
  operation_kind: 'reference.echo',
  stages: [],
  async rollback(): Promise<void> {},
};

/** A registry that knows only `reference.echo`. */
function fakeRegistry(): ExecutorRegistry {
  return {
    get(kind: string): Executor | undefined {
      return kind === 'reference.echo' ? dummyExecutor : undefined;
    },
  } as unknown as ExecutorRegistry;
}

interface FakeRunner {
  runner: TaskRunner;
  runCalls: Array<{ task_id: string; operation_kind: string }>;
  inflight: Map<string, InflightTask>;
  /** Resolve the in-flight run for a task (simulating the runner finishing). */
  finish(taskId: string): void;
}

/**
 * A runner stand-in: `run` records the call and (unless `autoComplete`) leaves
 * the task in-flight until `finish(task_id)` is called, so tests can observe
 * the in-flight window deterministically.
 */
function fakeRunner(opts: { autoComplete?: boolean } = {}): FakeRunner {
  const inflight = new Map<string, InflightTask>();
  const runCalls: Array<{ task_id: string; operation_kind: string }> = [];
  const pending = new Map<string, () => void>();

  const runner = {
    getInflight(): ReadonlyMap<string, InflightTask> {
      return inflight;
    },
    requestCancel(taskId: string): void {
      const t = inflight.get(taskId);
      if (t) t.cancelRequested = true;
    },
    run(begin: { task_id: string; operation_kind: string }): Promise<void> {
      runCalls.push({ task_id: begin.task_id, operation_kind: begin.operation_kind });
      inflight.set(begin.task_id, {
        task_id: begin.task_id,
        operation_kind: begin.operation_kind,
        cancelRequested: false,
        sequence: 0,
      });
      if (opts.autoComplete) {
        inflight.delete(begin.task_id);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        pending.set(begin.task_id, () => {
          inflight.delete(begin.task_id);
          resolve();
        });
      });
    },
  } as unknown as TaskRunner;

  return {
    runner,
    runCalls,
    inflight,
    finish(taskId: string): void {
      pending.get(taskId)?.();
      pending.delete(taskId);
    },
  };
}

const fixedId = (): string => 'acc-fixed-0001';

// ---- task.begin ----------------------------------------------------------

describe('task.begin', () => {
  it('accepts a known kind, starts the runner once, returns an acceptance id', async () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    const result = (await handlers['task.begin']?.({
      task_id: 't1',
      operation_kind: 'reference.echo',
      spec: { message: 'hi' },
    })) as { accepted: boolean; agent_acceptance_id: string };

    expect(result.accepted).toBe(true);
    expect(result.agent_acceptance_id).toBe('acc-fixed-0001');
    expect(fr.runCalls).toHaveLength(1);
    expect(fr.inflight.has('t1')).toBe(true);
  });

  it('accepts the api wire param name `kind` as well as `operation_kind`', async () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    const result = (await handlers['task.begin']?.({
      task_id: 't-wire',
      kind: 'reference.echo',
      spec: {},
    })) as { accepted: boolean };

    expect(result.accepted).toBe(true);
    expect(fr.runCalls[0]?.operation_kind).toBe('reference.echo');
  });

  it('is idempotent by task_id: a second begin returns the SAME acceptance id and does NOT re-run', async () => {
    let n = 0;
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: () => `acc-${++n}`,
    });

    const first = (await handlers['task.begin']?.({
      task_id: 't2',
      operation_kind: 'reference.echo',
      spec: {},
    })) as { agent_acceptance_id: string };
    const second = (await handlers['task.begin']?.({
      task_id: 't2',
      operation_kind: 'reference.echo',
      spec: {},
    })) as { agent_acceptance_id: string };

    expect(second.agent_acceptance_id).toBe(first.agent_acceptance_id);
    expect(fr.runCalls).toHaveLength(1);
  });

  it('rejects an unknown operation_kind with EXECUTOR_UNSUPPORTED', async () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    let thrown: unknown;
    try {
      await handlers['task.begin']?.({
        task_id: 't3',
        operation_kind: 'does.not.exist',
        spec: {},
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const typed = thrown as Error & { code?: string; rpcMethod?: string };
    expect(typed.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(typed.rpcMethod).toBe('task.begin');
    expect(fr.runCalls).toHaveLength(0);
  });

  it('absorbs a runner.run rejection (does not crash / reject the begin call)', async () => {
    const inflight = new Map<string, InflightTask>();
    const rejecting = {
      getInflight: () => inflight,
      requestCancel: () => {},
      run: () => Promise.reject(new Error('runner blew up')),
    } as unknown as TaskRunner;

    const handlers = makeTaskHandlers({
      runner: rejecting,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    // The begin must resolve to accepted even though run() rejects.
    const result = (await handlers['task.begin']?.({
      task_id: 't4',
      operation_kind: 'reference.echo',
      spec: {},
    })) as { accepted: boolean };
    expect(result.accepted).toBe(true);

    // Give the rejected promise a tick to settle; an uncaught rejection here
    // would surface as an unhandled-rejection test failure.
    await new Promise((r) => setImmediate(r));
  });
});

// ---- task.list_inflight --------------------------------------------------

describe('task.list_inflight', () => {
  it('lists the in-flight task with its acceptance id and started_at', async () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    await handlers['task.begin']?.({
      task_id: 't5',
      operation_kind: 'reference.echo',
      spec: {},
    });

    const result = handlers['task.list_inflight']?.({}) as {
      tasks: Array<{ task_id: string; operation_kind: string; agent_acceptance_id: string }>;
    };
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.task_id).toBe('t5');
    expect(result.tasks[0]?.operation_kind).toBe('reference.echo');
    expect(result.tasks[0]?.agent_acceptance_id).toBe('acc-fixed-0001');
    expect(typeof (result.tasks[0] as { started_at?: unknown }).started_at).toBe('string');
  });

  it('returns an empty list when nothing is in-flight', () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });
    const result = handlers['task.list_inflight']?.({}) as { tasks: unknown[] };
    expect(result.tasks).toEqual([]);
  });
});

// ---- task.cancel ---------------------------------------------------------

describe('task.cancel', () => {
  it('requests cancel of an in-flight task and sets the runner cancel flag', async () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    await handlers['task.begin']?.({
      task_id: 't6',
      operation_kind: 'reference.echo',
      spec: {},
    });

    const result = handlers['task.cancel']?.({ task_id: 't6' }) as { cancel_requested: boolean };
    expect(result.cancel_requested).toBe(true);
    expect(fr.inflight.get('t6')?.cancelRequested).toBe(true);
  });

  it('returns a not-found shape for a task that is not in-flight', () => {
    const fr = fakeRunner();
    const handlers = makeTaskHandlers({
      runner: fr.runner,
      publish: noopPublish,
      registry: fakeRegistry(),
      newAcceptanceId: fixedId,
    });

    const result = handlers['task.cancel']?.({ task_id: 'nope' }) as {
      cancel_requested: boolean;
      reason?: string;
    };
    expect(result.cancel_requested).toBe(false);
    expect(result.reason).toBe('not_found');
  });
});
