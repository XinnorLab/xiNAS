/**
 * Agent task RPC handlers (S2 T7, s2-task-envelope-spec §4.2/§9).
 *
 * The api dispatches `task.begin` over the agent UDS (T4); these handlers wire
 * that dispatch into the agent's {@link TaskRunner} + {@link ExecutorRegistry}
 * (T6). T0 already removed the four `task.*` from `STUB_METHODS`, so registering
 * the real handlers here shadows nothing.
 *
 * Three methods:
 *  - `task.begin`        — idempotent by `task_id`; looks up the executor, fires
 *                          the runner fire-and-forget, returns the acceptance id.
 *  - `task.cancel`       — cooperative: sets the runner's per-task cancel flag.
 *  - `task.list_inflight`— what the agent is still running (api reconciler, T9).
 *
 * ## Idempotent begin
 *
 * The acceptance id + accept-time are tracked in a closure map keyed by
 * `task_id` (the runner's `InflightTask` carries neither). A repeated
 * `task.begin` for an already-in-flight `task_id` returns the SAME
 * `agent_acceptance_id` and does NOT start a second run — this is what makes the
 * api's reconcile re-dispatch (§9) safe (`task.begin` is idempotent by
 * `task_id`). The accept record is dropped once the run settles, so a brand-new
 * begin after the task finished re-runs (the api's task-state machine, not the
 * agent, is the durable dedup).
 *
 * ## Cooperative cancel
 *
 * `task.cancel` only sets the runner's cancel flag (`requestCancel`); the runner
 * surfaces it via `ctx.isCancelRequested()` and an executor honors it at a safe
 * stage boundary. S2's reference executor does NOT check the flag mid-stage, so
 * a cancel of a fast reference task is a no-op in practice — that is expected;
 * cancel is best-effort and the flag is set for executors that do check it.
 *
 * ## Errors never crash the agent
 *
 * `runner.run` is invoked fire-and-forget (`void`) with a `.catch` so a thrown
 * runner promise can never become an unhandled rejection. The runner already
 * reports terminal/failed via progress events; a rejection here is only the
 * pathological case (e.g. the bridge throwing), and the api reconciler is the
 * durable backstop.
 */

import type { RpcHandler } from '../dispatch.js';
import type { ExecutorRegistry } from '../../task/registry.js';
import type { TaskRunner } from '../../task/runner.js';
import type { PublishProgress, TaskBegin } from '../../task/types.js';

export interface TaskHandlerOptions {
  runner: TaskRunner;
  registry: ExecutorRegistry;
  /** Push progress events to the api (injected so tests stay hermetic). */
  publish: PublishProgress;
  /** Generate an `agent_acceptance_id`. Injected for deterministic tests. */
  newAcceptanceId: () => string;
  /** Clock for `started_at` on the accept record. Default: `Date.now`-backed ISO. */
  now?: () => string;
}

/** What the agent tracks per accepted task (beyond the runner's InflightTask). */
interface AcceptRecord {
  readonly agent_acceptance_id: string;
  readonly started_at: string;
}

/** Build an EXECUTOR_UNSUPPORTED sentinel the dispatcher maps to -32000/422. */
function executorUnsupported(): Error & { code: string; rpcMethod: string } {
  const err = new Error('no executor registered for operation_kind') as Error & {
    code: string;
    rpcMethod: string;
  };
  err.code = 'EXECUTOR_UNSUPPORTED';
  err.rpcMethod = 'task.begin';
  return err;
}

/**
 * Read the operation kind from the begin params. **`kind` is the canonical wire
 * field** — the api dispatches `{ task_id, kind, spec, plan }` (engine.ts) and
 * ADR-0002 names it `kind`. `operation_kind` is accepted only as a transitional
 * alias for the S2 plan's wording; it never arrives on the real wire and should
 * be dropped once the spec/plan converge on `kind`. The agent's internal
 * `TaskBegin.operation_kind` field name is unaffected (internal type only).
 */
function readBeginParams(params: unknown): {
  task_id: string;
  operation_kind: string;
  spec: unknown;
  plan?: unknown;
} | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const task_id = p['task_id'];
  const operation_kind = p['operation_kind'] ?? p['kind'];
  if (typeof task_id !== 'string' || task_id.length === 0) return null;
  if (typeof operation_kind !== 'string' || operation_kind.length === 0) return null;
  return {
    task_id,
    operation_kind,
    spec: p['spec'],
    ...(p['plan'] !== undefined ? { plan: p['plan'] } : {}),
  };
}

/**
 * Build the three agent task RPC handlers over a shared accept-record map.
 */
export function makeTaskHandlers(opts: TaskHandlerOptions): {
  'task.begin': RpcHandler;
  'task.cancel': RpcHandler;
  'task.list_inflight': RpcHandler;
} {
  const { runner, registry, publish, newAcceptanceId } = opts;
  const now = opts.now ?? ((): string => new Date().toISOString());

  /** Accepted tasks keyed by task_id: the acceptance id + accept time. */
  const accepted = new Map<string, AcceptRecord>();

  function begin(params: unknown): { accepted: true; agent_acceptance_id: string } {
    const parsed = readBeginParams(params);
    if (parsed === null) {
      const err = new Error('task.begin requires task_id + operation_kind') as Error & {
        code: string;
      };
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    const { task_id, operation_kind, spec, plan } = parsed;

    // Idempotent by task_id: if still in-flight (or we already accepted it and
    // the run has not yet settled), return the SAME acceptance id, no re-run.
    const existing = accepted.get(task_id);
    if (existing !== undefined && runner.getInflight().has(task_id)) {
      return { accepted: true, agent_acceptance_id: existing.agent_acceptance_id };
    }

    const executor = registry.get(operation_kind);
    if (executor === undefined) {
      throw executorUnsupported();
    }

    const agent_acceptance_id = existing?.agent_acceptance_id ?? newAcceptanceId();
    accepted.set(task_id, { agent_acceptance_id, started_at: now() });

    // Fire-and-forget: the runner pushes progress asynchronously; begin returns
    // immediately. A thrown runner promise must never crash the agent — absorb
    // it (the runner reports terminal/failed via progress; the api reconciler is
    // the durable backstop). Drop the accept record once the run settles so a
    // later fresh begin for the same id can re-run.
    const beginPayload: TaskBegin = {
      task_id,
      operation_kind,
      spec,
      ...(plan !== undefined ? { plan } : {}),
    };
    void runner
      .run(beginPayload, executor, publish)
      .catch(() => {
        /* runner reports failure via progress; nothing to do here */
      })
      .finally(() => {
        accepted.delete(task_id);
      });

    return { accepted: true, agent_acceptance_id };
  }

  function cancel(
    params: unknown,
  ): { cancel_requested: true } | { cancel_requested: false; reason: 'not_found' } {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
      string,
      unknown
    >;
    const task_id = typeof p['task_id'] === 'string' ? p['task_id'] : '';
    if (task_id.length === 0 || !runner.getInflight().has(task_id)) {
      return { cancel_requested: false, reason: 'not_found' };
    }
    runner.requestCancel(task_id);
    return { cancel_requested: true };
  }

  function listInflight(): {
    tasks: Array<{
      task_id: string;
      operation_kind: string;
      agent_acceptance_id: string | null;
      started_at: string | null;
      sequence: number;
      cancel_requested: boolean;
    }>;
  } {
    const tasks: Array<{
      task_id: string;
      operation_kind: string;
      agent_acceptance_id: string | null;
      started_at: string | null;
      sequence: number;
      cancel_requested: boolean;
    }> = [];
    for (const t of runner.getInflight().values()) {
      const record = accepted.get(t.task_id);
      tasks.push({
        task_id: t.task_id,
        operation_kind: t.operation_kind,
        agent_acceptance_id: record?.agent_acceptance_id ?? null,
        started_at: record?.started_at ?? null,
        sequence: t.sequence,
        cancel_requested: t.cancelRequested,
      });
    }
    return { tasks };
  }

  return {
    'task.begin': begin,
    'task.cancel': cancel,
    'task.list_inflight': listInflight,
  };
}
