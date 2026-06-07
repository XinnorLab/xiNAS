import type { Database } from 'better-sqlite3';
import type { KvStore } from '../../state/index.js';
import type { LeaseManager } from '../../state/leases.js';
import { AgentRpcError, type AgentRpcClient } from '../agent-client.js';
import { ApiException } from '../errors.js';
import type { TaskStore } from './store.js';
import type { DesiredMutation, ResourceRef, Task } from './types.js';

/**
 * S2 task engine — the apply transaction (ADR-0004 §Plan/apply binding,
 * s2-task-envelope-spec §5.2). This file owns ONLY the atomic
 * `apply()` step: idempotency + freshness + lease acquisition + task
 * insert, all inside one `db.transaction`. Dispatch / the worker pool /
 * the reconciler are later S2 tasks and land in this same file.
 *
 * ## Why one `db.transaction`
 *
 * The whole point is atomicity: if ANY step throws, SQLite rolls the
 * transaction back so NO task row, NO lease, and NO idempotency entry
 * persists. The leases FK references `tasks(task_id)` and is NOT
 * deferrable, and `foreign_keys = ON` is set by the KV backend — so the
 * task row must be inserted BEFORE its leases are acquired. A lease
 * conflict that throws after the insert rolls the insert back too.
 *
 * ## Why idempotency is a SELECT, not a caught UNIQUE violation
 *
 * A throw inside `db.transaction(...)` both rolls the transaction back
 * AND propagates — so catching the `UNIQUE(idempotency_key, principal)`
 * violation *inside* the txn to then return the original row would mean
 * returning a row from a transaction that has already aborted (and, on a
 * true retry, we want to do no work at all, not re-run freshness/leases).
 * Instead we `SELECT` the existing row up front (`getByIdempotency`):
 *   - present, same `input_hash` → idempotent replay: return it, touch
 *     nothing else.
 *   - present, different `input_hash` → `CONFLICT` (`idempotency_key_reused`).
 *   - absent → proceed to freshness → leases → insert.
 * The `UNIQUE` index remains the DB-level backstop against a racing
 * duplicate insert (impossible in Phase 0 — xinas-api is the single
 * synchronous SQLite writer, ADR-0002 — but defense in depth).
 */

/** Risk levels the plan may carry (ADR-0004 §tasks table). */
export type RiskLevel =
  | 'non_disruptive'
  | 'changing_access'
  | 'destructive'
  | 'unsupported_rollback';

/**
 * The plan-side inputs the apply transaction binds against. Produced by
 * the plan engine (T3) from the `plan_only` task row plus its computed
 * `affected_resources` / `state_revision_expected` / observation freshness.
 */
export interface ApplyPlan {
  /** The `plan_only` task this apply derives from (becomes `plan_id`). */
  plan_id: string;
  /** Operation kind, e.g. "reference.echo". */
  kind: string;
  risk_level: RiskLevel | string;
  plan_hash?: string;
  /** Raw executor spec, persisted on the apply task + forwarded at dispatch. */
  spec?: unknown;
  /** {kind,id,revision?} pinned at plan time. */
  affected_resources: ResourceRef[];
  /** Highest expected desired revision across affected resources. */
  state_revision_expected?: number;
  /**
   * Observation-freshness pin: the observed-row revision the plan was
   * computed against. When set, the apply txn re-reads the observed row
   * and rejects with CONFLICT(plan_stale) if it drifted forward.
   */
  observed_revision_expected?: number;
  // ── N0 plan-side outputs (S3 §5.1), reconstructed from tasks.plan_binding.
  //    Mirror PlanResult exactly so the apply step (N0.3) can consume them. ──
  /**
   * The OBSERVED resource to TOCTOU-pin when its identity differs from the
   * desired `affected_resources[0]`. When set, the apply txn reads
   * `/xinas/v1/observed/<kind>/<id>` and rejects CONFLICT(plan_stale) on drift,
   * instead of the S2 default `observed_revision_expected` vs
   * `affected_resources[0]` (§5.2). Consumed in N0.3.
   */
  observed_freshness_ref?: { kind: string; id: string; revision: number };
  /**
   * Overrides the lease set when it differs from `affected_resources` (only
   * `nfs-idmap.set` needs this; §5.2). When set, this is the lease set; else
   * lease `affected_resources` (S2 behavior). Consumed in N0.3.
   */
  lease_resources?: ResourceRef[];
  /**
   * Desired-KV mutations the apply txn applies atomically with the task +
   * lease insert, recording prior values into `tasks.desired_rollback` for
   * Model R revert (§5.3). Consumed in N0.3.
   */
  desired_mutations?: DesiredMutation[];
}

/** The apply-call request envelope (the `mode=apply` HTTP body fields). */
export interface ApplyRequest {
  /** sha256 of canonicalized inputs; must match the plan's for a replay. */
  input_hash: string;
  idempotency_key: string;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
}

export interface ApplyArgs {
  plan: ApplyPlan;
  applyReq: ApplyRequest;
}

export interface TaskEngineDeps {
  db: Database;
  store: TaskStore;
  leases: LeaseManager;
  kv: KvStore;
}

/** Default lease TTL (seconds). Heartbeats extend it during execution. */
const DEFAULT_LEASE_TTL_SECONDS = 60;

/** Hard cap on a single `task.begin` round-trip. */
const TASK_BEGIN_TIMEOUT_MS = 5_000;

/** Hard cap on the single task.list_inflight reconcile RPC. */
const TASK_LIST_INFLIGHT_TIMEOUT_MS = 5_000;

/**
 * Outcome of one `TaskEngine.reconcile()` pass (s2-task-envelope-spec §9).
 * `leases_removed` / `tasks_recovered` come from the always-first
 * `LeaseManager.sweepExpired()`; the rest count the per-task recovery actions.
 */
export interface ReconcileSummary {
  leases_removed: number;
  tasks_recovered: number;
  acceptances_adopted: number;
  redispatched: number;
  failed: number;
  /** false when the in-flight fetch failed or no agent client was available. */
  agent_reachable: boolean;
  /** true when a concurrent reconcile was already running (re-entrancy guard). */
  skipped: boolean;
}

/** One stale-resource entry in a PRECONDITION_FAILED `details.stale[]`. */
interface StaleEntry {
  kind: string;
  id: string;
  expected: number;
  current: number;
}

export class TaskEngine {
  private readonly db: Database;
  private readonly store: TaskStore;
  private readonly leases: LeaseManager;
  private readonly kv: KvStore;
  /** Re-entrancy guard: true while a reconcile() pass is in flight. */
  private reconciling = false;

  constructor(deps: TaskEngineDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.leases = deps.leases;
    this.kv = deps.kv;
  }

  /**
   * The atomic apply transaction. Returns the created `queued` task on
   * success, or the original task on an idempotent replay. Throws
   * `ApiException` (CONFLICT / PRECONDITION_FAILED) on every conflict
   * path — and every throw rolls the transaction back to zero residue.
   */
  apply(args: ApplyArgs): Task {
    const { plan, applyReq } = args;

    const run = this.db.transaction((): Task => {
      // 1. Idempotency (SELECT-first; see file header for why).
      const existing = this.store.getByIdempotency(applyReq.idempotency_key, applyReq.principal);
      if (existing) {
        if (existing.input_hash === applyReq.input_hash) {
          // True retry — return the original, do no further work.
          return existing;
        }
        throw new ApiException(
          'CONFLICT',
          'idempotency key reused with a different request',
          { reason: 'idempotency_key_reused' },
          'Use a fresh idempotency_key for a different request, or re-send the original request.',
        );
      }

      // 2. Freshness (TOCTOU guard). Capture the apply-time revision of the
      //    highest-pinned resource for `state_revision_at_apply`.
      const stale: StaleEntry[] = [];
      let stateRevisionAtApply = plan.state_revision_expected;
      for (const r of plan.affected_resources) {
        const expected = r.revision ?? plan.state_revision_expected;
        if (expected === undefined) continue; // nothing pinned → nothing to check
        // Absent row (deleted since plan) reads as revision 0 — guaranteed to
        // mismatch any pinned revision >= 1, so it lands in `stale`.
        const current = this.currentRevision('desired', r.kind, r.id) ?? 0;
        if (current !== expected) {
          stale.push({ kind: r.kind, id: r.id, expected, current });
        } else if (stateRevisionAtApply === undefined || current > stateRevisionAtApply) {
          stateRevisionAtApply = current;
        }
      }
      if (stale.length > 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'resource revision changed since plan',
          { stale },
          'Re-run plan to capture the current revision, then apply against the fresh plan.',
        );
      }

      // Observation drift → plan is stale (a separate, coarser signal than
      // a desired-revision bump: the world the plan observed has moved on).
      //
      // CONTRACT (T3 must uphold): `observed_revision_expected` is a single
      // plan-level scalar, so it is checked against the plan's PRIMARY affected
      // resource — `affected_resources[0]`. The PlanProvider that populates a
      // plan MUST therefore place the resource whose observed projection backs
      // the freshness pin first in `affected_resources`. (S2's reference plan is
      // single-resource, so this is trivially satisfied; revisit if a future
      // multi-resource plan needs per-resource observed freshness.)
      if (plan.observed_revision_expected !== undefined) {
        const first = plan.affected_resources[0];
        if (first) {
          const observedNow = this.currentRevision('observed', first.kind, first.id);
          if (observedNow !== undefined && observedNow > plan.observed_revision_expected) {
            throw new ApiException(
              'CONFLICT',
              'plan is stale',
              { reason: 'plan_stale' },
              'Re-run plan; the observed system state changed since this plan was computed.',
            );
          }
        }
      }

      // 3. Insert the apply task FIRST (the leases FK needs a real task_id).
      //    Optionals are spread conditionally — under exactOptionalPropertyTypes
      //    CreateApplyInput's `?:` fields reject an explicit `undefined`.
      const task = this.store.createApplyTask({
        kind: plan.kind,
        principal: applyReq.principal,
        client_type: applyReq.client_type,
        request_id: applyReq.request_id,
        correlation_id: applyReq.correlation_id,
        input_hash: applyReq.input_hash,
        risk_level: plan.risk_level,
        affected_resources: plan.affected_resources,
        plan_id: plan.plan_id,
        idempotency_key: applyReq.idempotency_key,
        // Carry the raw executor spec onto the apply task so dispatch + reconcile
        // re-dispatch forward it verbatim (s2-task-envelope-spec §5.2/§9).
        ...(plan.spec !== undefined ? { spec: plan.spec } : {}),
        ...(plan.plan_hash !== undefined ? { plan_hash: plan.plan_hash } : {}),
        ...(plan.state_revision_expected !== undefined
          ? { state_revision_expected: plan.state_revision_expected }
          : {}),
        ...(stateRevisionAtApply !== undefined
          ? { state_revision_at_apply: stateRevisionAtApply }
          : {}),
      });

      // 4. Acquire a lease per affected resource. A conflict throws →
      //    rolls back the insert above. (LeaseManager.acquire catches the
      //    UNIQUE(resource_kind,resource_id) violation internally.)
      for (const r of plan.affected_resources) {
        const res = this.leases.acquire({
          resource_kind: r.kind,
          resource_id: r.id,
          task_id: task.task_id,
          ttl_seconds: DEFAULT_LEASE_TTL_SECONDS,
        });
        if (!res.ok) {
          throw new ApiException(
            'CONFLICT',
            'resource is locked by another task',
            { reason: 'lease_held', holder_task_id: res.holder_task_id },
            'Wait for the holding task to finish or be cancelled, then retry.',
          );
        }
      }

      return task;
    });

    return run();
  }

  /**
   * Dispatch a `queued` apply task to the agent (s2-task-envelope-spec §5.2
   * step 3). This is the minimal inline dispatch for S2 (the full worker pool
   * + reconcile is T9): send `task.begin(task_id, kind, spec, plan)` over the
   * agent RPC client, then —
   *   - **accepted** → transition the task to `running` + store the
   *     `agent_acceptance_id`; return the running Task.
   *   - **unavailable** (agent offline / connect-refused / timeout) → transition
   *     to `failed (FAILED_BEFORE_CHANGE)`, RELEASE the task's leases, and throw
   *     `INTERNAL`/`EXECUTOR_UNAVAILABLE` (→ 503).
   *   - **rejected** (JSON-RPC error, e.g. `EXECUTOR_UNSUPPORTED`) → transition
   *     to `failed (FAILED_BEFORE_CHANGE)`, RELEASE leases, and throw
   *     `UNSUPPORTED`/`EXECUTOR_UNSUPPORTED` (→ 422).
   * Never leaves a `queued` task holding leases with no in-flight begin.
   *
   * @param plan the public plan envelope rendered for the agent (diff etc.)
   */
  async dispatch(args: {
    task: Task;
    agentClient: AgentRpcClient | undefined;
    spec: unknown;
    plan: unknown;
  }): Promise<Task> {
    const { task, agentClient, spec, plan } = args;

    // No agent configured (read-only/test context) is just one more flavor of
    // "begin couldn't reach an executor" — route it through the single
    // begin-unavailable cleanup path (fail task + release leases + 503).
    if (!agentClient) {
      return this.failBeforeChange(
        task,
        new AgentRpcError(
          -32000,
          'no agent RPC client configured to dispatch task.begin',
          undefined,
        ),
      );
    }

    let result: unknown;
    try {
      result = await agentClient.call(
        'task.begin',
        { task_id: task.task_id, kind: task.kind, spec, plan },
        TASK_BEGIN_TIMEOUT_MS,
      );
    } catch (err) {
      return this.failBeforeChange(task, err);
    }

    const accepted =
      result !== null &&
      typeof result === 'object' &&
      (result as { accepted?: unknown }).accepted === true;
    if (!accepted) {
      // A well-formed-but-not-accepted response is treated as a rejection.
      return this.failBeforeChange(
        task,
        new AgentRpcError(-32000, 'agent did not accept task.begin', undefined),
      );
    }

    const acceptanceId = (result as { agent_acceptance_id?: unknown }).agent_acceptance_id;
    return this.store.transition(task.task_id, {
      state: 'running',
      ...(typeof acceptanceId === 'string' ? { agent_acceptance_id: acceptanceId } : {}),
    });
  }

  /**
   * Begin-failure cleanup: mark the task `failed (FAILED_BEFORE_CHANGE)`,
   * release its leases (so no orphan queued/failed task holds a resource),
   * and throw the api error the route surfaces. A `task.begin` that never
   * reached an accept means NO host change happened — safe to fail clean.
   */
  private failBeforeChange(task: Task, err: unknown): never {
    const unsupported =
      err instanceof AgentRpcError &&
      typeof err.data === 'object' &&
      err.data !== null &&
      (err.data as { code?: unknown }).code === 'EXECUTOR_UNSUPPORTED';

    const errorMessage = err instanceof Error ? err.message : String(err);
    this.store.transition(task.task_id, {
      state: 'failed',
      error_code: 'FAILED_BEFORE_CHANGE',
      error_message: errorMessage,
    });
    this.leases.releaseByTask(task.task_id);

    if (unsupported) {
      // Executor reachable but operation unbuilt → UNSUPPORTED/422 (default map).
      throw new ApiException(
        'UNSUPPORTED',
        'this operation is not implemented by the executor',
        { code: 'EXECUTOR_UNSUPPORTED' },
        'the agent is reachable but does not implement this operation in this build',
      );
    }
    // Agent offline / connect-refused / timeout → INTERNAL/EXECUTOR_UNAVAILABLE
    // envelope, surfaced as HTTP 503 (the mutating-route contract for an
    // unreachable executor; INTERNAL alone would map to 500). No new ErrorCode.
    throw new ApiException(
      'INTERNAL',
      'xinas-agent did not accept the task',
      { code: 'EXECUTOR_UNAVAILABLE' },
      'restart xinas-agent.service and retry',
      503,
    );
  }

  /**
   * Crash/restart recovery (s2-task-envelope-spec §9). Runs on api startup
   * and on the agent offline→healthy reconnect edge. Idempotent and
   * re-entrancy-guarded.
   *
   * 1. ALWAYS sweep expired leases first (non-terminal tasks with an expired
   *    lease → `requires_manual_recovery`), even when the agent is down.
   * 2. Fetch the agent in-flight set once via `task.list_inflight`. If the
   *    agent is unreachable (no client / connect-refused / timeout / reject)
   *    → STOP after the sweep, leaving queued + running tasks untouched; the
   *    offline→healthy reconnect trigger retries once the agent is back. A
   *    `queued` task is NEVER failed just because the agent was momentarily
   *    down.
   * 3. With the in-flight set, walk non-terminal (`queued` + `running`) tasks:
   *    - `running` + no acceptance + inflight → adopt the in-flight acceptance.
   *    - `running` + (any acceptance) + not inflight → no-op (lease/sweep owns
   *      running-task recovery; reconcile never re-dispatches a running task).
   *    - `queued` → no host change yet → apply `queuedPolicy` (`redispatch`
   *      default, idempotent `task.begin` by task_id; or `fail`).
   */
  async reconcile(args: {
    agentClient: AgentRpcClient | undefined;
    queuedPolicy?: 'redispatch' | 'fail';
  }): Promise<ReconcileSummary> {
    if (this.reconciling) {
      return {
        leases_removed: 0,
        tasks_recovered: 0,
        acceptances_adopted: 0,
        redispatched: 0,
        failed: 0,
        agent_reachable: false,
        skipped: true,
      };
    }
    this.reconciling = true;
    try {
      const { agentClient } = args;
      const queuedPolicy = args.queuedPolicy ?? 'redispatch';

      // 1. Sweep first, always — runs even when the agent is unreachable.
      const sweep = this.leases.sweepExpired();

      // 2. Fetch the agent in-flight set once (best-effort, hard-capped). Any
      //    failure (no client / connect-refused / timeout / reject) → undefined.
      let inflight: Map<string, string | null> | undefined;
      if (agentClient) {
        try {
          const res = await agentClient.call(
            'task.list_inflight',
            {},
            TASK_LIST_INFLIGHT_TIMEOUT_MS,
          );
          inflight = parseInflight(res);
        } catch {
          inflight = undefined;
        }
      }

      // Agent unreachable → stop after the sweep; the reconnect trigger retries.
      if (inflight === undefined) {
        return {
          leases_removed: sweep.leases_removed,
          tasks_recovered: sweep.tasks_recovered,
          acceptances_adopted: 0,
          redispatched: 0,
          failed: 0,
          agent_reachable: false,
          skipped: false,
        };
      }

      let acceptancesAdopted = 0;
      let redispatched = 0;
      let failed = 0;

      // 3. Walk non-terminal tasks (queued + running only). plan_only /
      //    imported / terminal are excluded by construction.
      const tasks = [
        ...this.store.list({ state: 'queued' }),
        ...this.store.list({ state: 'running' }),
      ];
      for (const task of tasks) {
        const isInflight = inflight.has(task.task_id);

        if (task.state === 'running') {
          if (
            (task.agent_acceptance_id === null || task.agent_acceptance_id === undefined) &&
            isInflight
          ) {
            // Adopt the acceptance the api lost across a restart; keep running.
            const acceptance = inflight.get(task.task_id);
            if (typeof acceptance === 'string') {
              this.store.transition(task.task_id, { agent_acceptance_id: acceptance });
              acceptancesAdopted += 1;
            }
          }
          // All other running cases are a no-op: lease/sweep owns running-task
          // recovery, and reconcile never re-dispatches a running task.
          continue;
        }

        // state === 'queued' → never accepted → no host change → apply policy.
        if (queuedPolicy === 'fail') {
          this.store.transition(task.task_id, {
            state: 'failed',
            error_code: 'FAILED_BEFORE_CHANGE',
            error_message: 'queued task never dispatched; reconciled to failed',
          });
          this.leases.releaseByTask(task.task_id);
          failed += 1;
          continue;
        }

        // 'redispatch' (default): idempotent task.begin by task_id. Wrap each so
        // one begin-failure (dispatch's failBeforeChange already fails the task
        // + releases its leases, then THROWS) doesn't abort the rest of the sweep.
        try {
          await this.dispatch({ task, agentClient, ...this.rebuildDispatchInputs(task) });
          redispatched += 1;
        } catch {
          failed += 1;
        }
      }

      return {
        leases_removed: sweep.leases_removed,
        tasks_recovered: sweep.tasks_recovered,
        acceptances_adopted: acceptancesAdopted,
        redispatched,
        failed,
        agent_reachable: true,
        skipped: false,
      };
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Rebuild the `{ spec, plan }` dispatch inputs for a re-dispatch from the
   * apply task's OWN columns (no plan_only refetch). `plan` is an `ApplyPlan`
   * projected from the apply task; `spec` is the task's persisted `spec` column
   * (migration 003) — the same executor input the original dispatch forwarded,
   * NOT the `affected_resources` echo stopgap. This works for any executor.
   */
  private rebuildDispatchInputs(task: Task): { spec: unknown; plan: ApplyPlan } {
    const plan: ApplyPlan = {
      plan_id: task.plan_id ?? task.task_id,
      kind: task.kind,
      risk_level: task.risk_level,
      affected_resources: task.affected_resources,
      ...(task.plan_hash !== undefined ? { plan_hash: task.plan_hash } : {}),
      ...(task.state_revision_expected !== undefined
        ? { state_revision_expected: task.state_revision_expected }
        : {}),
    };
    return { spec: task.spec, plan };
  }

  /**
   * Current revision of a resource row in the state store, or undefined
   * when the row is absent. `space` selects the desired vs observed
   * projection (`/xinas/v1/<space>/<Kind>/<id>`).
   */
  private currentRevision(
    space: 'desired' | 'observed',
    kind: string,
    id: string,
  ): number | undefined {
    const row = this.kv.get(`/xinas/v1/${space}/${kind}/${id}`);
    return row?.revision;
  }
}

/**
 * Defensively parse a `task.list_inflight` result into a
 * `task_id → agent_acceptance_id ?? null` map. Reads `{ tasks: [{ task_id,
 * agent_acceptance_id }] }`; ignores malformed entries (missing/non-string
 * `task_id`). A task is "inflight" iff the returned map `.has(task_id)`.
 */
function parseInflight(res: unknown): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (res === null || typeof res !== 'object') return map;
  const tasks = (res as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return map;
  for (const entry of tasks) {
    if (entry === null || typeof entry !== 'object') continue;
    const taskId = (entry as { task_id?: unknown }).task_id;
    if (typeof taskId !== 'string') continue;
    const acceptance = (entry as { agent_acceptance_id?: unknown }).agent_acceptance_id;
    map.set(taskId, typeof acceptance === 'string' ? acceptance : null);
  }
  return map;
}
