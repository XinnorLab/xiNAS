import type { Database } from 'better-sqlite3';
import type { KvStore } from '../../state/index.js';
import type { LeaseManager } from '../../state/leases.js';
import { ApiException } from '../errors.js';
import type { TaskStore } from './store.js';
import type { ResourceRef, Task } from './types.js';

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
