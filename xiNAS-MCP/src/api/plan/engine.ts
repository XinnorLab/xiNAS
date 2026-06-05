import { createHash } from 'node:crypto';
import type { KvStore } from '../../state/index.js';
import { ApiException } from '../errors.js';
import type { TaskStore } from '../tasks/store.js';
import type { ResourceRef, Task } from '../tasks/types.js';

/**
 * S2 plan engine (s2-task-envelope-spec §5.1, ADR-0004 §Plan/apply
 * binding). `plan` mode runs a registered `PlanProvider.preflight` to
 * compute a deterministic preflight result, writes it as a durable
 * **`state=plan_only` task row**, and returns the row (its `task_id` is
 * the `plan_id` a later `apply` binds against).
 *
 * The engine owns ONLY plan-time work: provider lookup, the preflight
 * call, the deterministic `plan_hash`/`input_hash`, and the
 * `store.createPlanOnly` insert. The apply transaction, dispatch, and
 * the route live in `tasks/engine.ts` (T2) and the route layer (T4).
 *
 * ## Determinism
 *
 * `plan_hash` and `input_hash` are sha256 over a *canonicalized*
 * (recursively key-sorted, whitespace-free) JSON so two callers that
 * pass the same content in a different key order get the same hash —
 * apply replays compare hashes (§5.2), so a key-order flip must not
 * read as a different request. `stableStringify` below is the
 * canonical form (mirrors state/audit.ts::canonicalize).
 */

/**
 * The minimal slice of per-process context a `PlanProvider` needs:
 * read access to the KV store so it can stamp real resource revisions
 * and observation freshness. The route (T4) builds this from
 * `ApiContext.state` and hands it to the engine.
 */
export interface PlanContext {
  kv: KvStore;
}

/**
 * The result a `PlanProvider.preflight` returns. `affected_resources`
 * MUST place the primary/observed resource FIRST — `tasks/engine.ts`
 * checks `observed_revision_expected` against `affected_resources[0]`
 * (see the freshness CONTRACT comment there).
 */
export interface PlanResult {
  /** Pinned {kind,id,revision?}; primary/observed resource FIRST. */
  affected_resources: ResourceRef[];
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  diff: unknown;
  /** 'non_disruptive' | 'changing_access' | 'destructive' | 'unsupported_rollback'. */
  risk_level: string;
  rollback_model: string;
  /** Highest desired revision across affected resources (TOCTOU pin). */
  state_revision_expected?: number;
  /** Observed-row revision the plan was computed against (freshness pin). */
  observed_revision_expected?: number;
  /** ISO-8601 stamp of the observation backing the freshness pin. */
  observed_at?: string;
}

/** A pluggable preflight for one operation kind (keyed in the registry). */
export interface PlanProvider {
  /** e.g. 'reference.echo'. */
  operation_kind: string;
  preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult>;
}

/** The `mode=plan` request fields the engine threads onto the row. */
export interface PlanArgs {
  operation_kind: string;
  spec: unknown;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
  idempotency_key?: string;
}

/**
 * What `plan()` returns: the persisted `plan_only` Task plus the full
 * `PlanResult`. The Task row cannot carry every plan field
 * (`blockers`/`warnings`/`diff`/`observed_*`/`rollback_model` have no
 * column), so the route (T4) renders the public `Plan` envelope from
 * BOTH — the durable row for ids/hashes/risk, the `PlanResult` for the
 * rest.
 */
export interface PlanOutcome {
  task: Task;
  planResult: PlanResult;
}

export interface PlanEngineDeps {
  store: TaskStore;
  ctx: PlanContext;
}

export class PlanEngine {
  private readonly store: TaskStore;
  private readonly ctx: PlanContext;
  private readonly providers = new Map<string, PlanProvider>();

  constructor(deps: PlanEngineDeps) {
    this.store = deps.store;
    this.ctx = deps.ctx;
  }

  /** Register a provider, keyed by its `operation_kind`. Last wins. */
  register(provider: PlanProvider): void {
    this.providers.set(provider.operation_kind, provider);
  }

  /**
   * Run preflight for `operation_kind`, persist a `plan_only` task row
   * with deterministic `plan_hash`/`input_hash`, and return both the
   * row and the full `PlanResult`. Unknown kind → UNSUPPORTED.
   */
  async plan(args: PlanArgs): Promise<PlanOutcome> {
    const provider = this.providers.get(args.operation_kind);
    if (!provider) {
      throw new ApiException(
        'UNSUPPORTED',
        `no plan provider for ${args.operation_kind}`,
        undefined,
        'Use a supported operation kind. Reference: reference.echo.',
      );
    }

    const result = await provider.preflight(this.ctx, args.spec);

    // input_hash pins the request inputs (operation_kind + spec). plan_hash
    // additionally pins what preflight resolved (affected_resources, diff,
    // the revision pins) so apply can detect a divergent re-plan.
    const inputHash = sha256(
      stableStringify({ operation_kind: args.operation_kind, spec: args.spec }),
    );
    const planHash = sha256(
      stableStringify({
        operation_kind: args.operation_kind,
        spec: args.spec,
        affected_resources: result.affected_resources,
        diff: result.diff,
        state_revision_expected: result.state_revision_expected,
        observed_revision_expected: result.observed_revision_expected,
      }),
    );

    const task = this.store.createPlanOnly({
      kind: args.operation_kind,
      principal: args.principal,
      client_type: args.client_type,
      request_id: args.request_id,
      correlation_id: args.correlation_id,
      input_hash: inputHash,
      risk_level: result.risk_level,
      affected_resources: result.affected_resources,
      plan_hash: planHash,
      // Spread conditionally — under exactOptionalPropertyTypes the
      // `?:` optionals on CreatePlanOnlyInput reject an explicit undefined.
      ...(args.idempotency_key !== undefined ? { idempotency_key: args.idempotency_key } : {}),
      ...(result.state_revision_expected !== undefined
        ? { state_revision_expected: result.state_revision_expected }
        : {}),
    });

    return { task, planResult: result };
  }
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * JCS-style canonical JSON: recursive key sort, no whitespace. Mirrors
 * state/audit.ts::canonicalize — kept local so the plan engine does not
 * reach across into the state layer for a pure helper. Determinism
 * across key orders is proven by engine.test.ts.
 *
 * The two copies intentionally differ in one way: audit's version guards
 * `Buffer` values (audit payloads can carry binary), whereas plan inputs are
 * always JSON specs + resolved revisions, so no Buffer case is needed here.
 * If a third caller appears, promote this to a layer-neutral shared helper
 * (e.g. lib/canonical-json.ts) that both the api and state layers import.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
