import type { Request, Response } from 'express';
import type { ApiContext, TaskEngines } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import type { ApplyPlan } from '../tasks/engine.js';
import type { DesiredMutation, ResourceRef, Task } from '../tasks/types.js';

/**
 * Shared plan/apply route machinery (S3 N5). Extracted from the T4 reference
 * route so every real mutating route (NFS shares/idmap now; arrays, fs,
 * network later) runs the SAME two-mode flow — and so the plan_binding-aware
 * `toApplyPlan` reconstruction exists in exactly ONE copy.
 *
 *   - `planMode`   — PlanEngine.plan → 200 + the rendered Plan envelope.
 *   - `applyMode`  — resolve the plan_only task (kind-checked), validate the
 *                    echoed expected_revision, TaskEngine.apply (atomic
 *                    idempotency+freshness+leases+desired_mutations+task),
 *                    idempotent-replay short-circuit, dispatch task.begin,
 *                    202 + the Task envelope.
 */

/** ctx.tasks, or the EXECUTOR_UNAVAILABLE error every engine route raises without it. */
export function requireTasks(ctx: ApiContext): TaskEngines {
  const tasks = ctx.tasks;
  if (!tasks) {
    // No engines wired (read-only context) — there is nothing to plan/apply.
    throw new ApiException(
      'INTERNAL',
      'task engine is not available in this build',
      { code: 'EXECUTOR_UNAVAILABLE' },
      'the api was started without a task engine',
    );
  }
  return tasks;
}

/**
 * Map a stored `plan_only` Task to the apply transaction's ApplyPlan.
 *
 * N0.3 (S3 §5.1): the N0 plan-side outputs (`observed_freshness_ref`,
 * `lease_resources`, `desired_mutations`) live in the `plan_binding` JSON blob,
 * not in dedicated columns — reconstruct them here so they survive plan→apply.
 * A reference plan has no `plan_binding` → all three absent → unchanged.
 */
export function toApplyPlan(planTask: Task): ApplyPlan {
  const binding = (planTask.plan_binding ?? {}) as {
    observed_freshness_ref?: { kind: string; id: string; revision: number };
    lease_resources?: ResourceRef[];
    desired_mutations?: DesiredMutation[];
  };
  return {
    plan_id: planTask.task_id,
    kind: planTask.kind,
    risk_level: planTask.risk_level,
    affected_resources: planTask.affected_resources,
    ...(planTask.spec !== undefined ? { spec: planTask.spec } : {}),
    ...(planTask.plan_hash !== undefined ? { plan_hash: planTask.plan_hash } : {}),
    ...(planTask.state_revision_expected !== undefined
      ? { state_revision_expected: planTask.state_revision_expected }
      : {}),
    ...(binding.observed_freshness_ref !== undefined
      ? { observed_freshness_ref: binding.observed_freshness_ref }
      : {}),
    ...(binding.lease_resources !== undefined ? { lease_resources: binding.lease_resources } : {}),
    ...(binding.desired_mutations !== undefined
      ? { desired_mutations: binding.desired_mutations }
      : {}),
  };
}

/** The Task envelope shape the 202 returns (subset the route needs to surface). */
export function taskEnvelope(task: Task): Record<string, unknown> {
  return {
    task_id: task.task_id,
    state: task.state,
    kind: task.kind,
    risk_level: task.risk_level,
    affected_resources: task.affected_resources,
    ...(task.plan_id !== undefined ? { plan_id: task.plan_id } : {}),
    ...(task.agent_acceptance_id !== undefined
      ? { agent_acceptance_id: task.agent_acceptance_id }
      : {}),
    ...(task.error_code !== undefined ? { error_code: task.error_code } : {}),
    ...(task.error_message !== undefined ? { error_message: task.error_message } : {}),
  };
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `'${name}' is required and must be a non-empty string`,
    );
  }
  return v;
}

/** Plain-language NFS-client impact for the Plan envelope. */
function clientImpact(riskLevel: string): string {
  return riskLevel === 'non_disruptive'
    ? 'No impact on NFS clients.'
    : 'May affect NFS clients; review the diff.';
}

/**
 * `mode=plan`: run the PlanEngine for `operationKind` and render the public
 * Plan envelope (api-v1.yaml `Plan`) from BOTH the durable `plan_only` row and
 * the in-memory PlanResult. `extra` lets a route surface route-specific fields
 * (share.create echoes the server-assigned `id`).
 */
export async function planMode(
  req: Request,
  res: Response,
  tasks: TaskEngines,
  operationKind: string,
  spec: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const rc = req.context!;
  const { task, planResult } = await tasks.planEngine.plan({
    operation_kind: operationKind,
    spec,
    principal: rc.principal,
    client_type: rc.client_type,
    request_id: rc.request_id,
    correlation_id: rc.correlation_id,
  });
  rc.operation_id = task.task_id;
  const revision = task.state_revision_expected ?? 0;
  sendOk(
    req,
    res,
    {
      plan_id: task.task_id,
      plan_hash: task.plan_hash,
      state_revision_expected: revision,
      observed_revision_expected: planResult.observed_revision_expected ?? null,
      observed_at: planResult.observed_at ?? null,
      affected_resources: task.affected_resources,
      risk_level: planResult.risk_level,
      client_impact: clientImpact(planResult.risk_level),
      blockers: planResult.blockers,
      warnings: planResult.warnings,
      diff: planResult.diff,
      rollback_model: planResult.rollback_model,
      ...extra,
    },
    [revision],
  );
}

export interface ApplyModeOptions {
  /** The plan's required kind — a plan for another kind resolves NOT_FOUND. */
  operationKind: string;
  /**
   * Validate `body.expected_revision` (required integer, OpenAPI ApplyRequest)
   * against the plan's `state_revision_expected ?? 0` — mismatch →
   * PRECONDITION_FAILED. Default true; the /reference engine-proof route
   * (absent from api-v1.yaml, predating the contract) opts out.
   */
  requireExpectedRevision?: boolean;
  /** Extra plan↔route binding (e.g. the plan's spec.id must match the URL id). */
  planTaskMatches?: (planTask: Task) => boolean;
}

/**
 * `mode=apply`: the standard apply flow shared by every mutating route.
 * Resolves the `plan_only` task, validates the expected_revision echo, runs
 * the atomic apply transaction, short-circuits idempotent replays, dispatches
 * `task.begin`, and answers 202 with the Task envelope. Engine conflicts
 * (CONFLICT / PRECONDITION_FAILED) and dispatch failures (503/422) propagate
 * as ApiExceptions for the error middleware to render.
 */
export async function applyMode(
  req: Request,
  res: Response,
  tasks: TaskEngines,
  body: Record<string, unknown>,
  opts: ApplyModeOptions,
): Promise<void> {
  const rc = req.context!;
  const planId = requireString(body.plan_id, 'plan_id');
  const idempotencyKey = requireString(body.idempotency_key, 'idempotency_key');

  // Resolve the plan_only task this apply binds against. Wrong state, wrong
  // KIND (a share plan applied via the idmap route), or a failed route-level
  // binding check all read as "no such plan for this operation" → re-plan.
  const planTask = tasks.store.get(planId);
  if (
    !planTask ||
    planTask.state !== 'plan_only' ||
    planTask.kind !== opts.operationKind ||
    (opts.planTaskMatches !== undefined && !opts.planTaskMatches(planTask))
  ) {
    throw new ApiException(
      'NOT_FOUND',
      `no plan_only ${opts.operationKind} task with plan_id ${planId} for this resource`,
      undefined,
      'Re-run mode=plan on this route to obtain a fresh plan_id.',
    );
  }

  // The client must echo the plan's revision (api-v1.yaml ApplyRequest requires
  // expected_revision). For observed-only operations (nfs-idmap.set) that is
  // the observed snapshot revision the plan returned (S3 §3.5); 0 on a fresh
  // install or when the plan pinned nothing.
  if (opts.requireExpectedRevision !== false) {
    const expected = body.expected_revision;
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        "'expected_revision' is required and must be an integer",
        undefined,
        "Echo the plan's state_revision_expected as expected_revision.",
      );
    }
    const planRevision = planTask.state_revision_expected ?? 0;
    if (expected !== planRevision) {
      throw new ApiException(
        'PRECONDITION_FAILED',
        `expected_revision ${expected} does not match the plan's state_revision_expected ${planRevision}`,
        { expected_revision: expected, plan_revision: planRevision },
        "Echo the plan's state_revision_expected as expected_revision, or re-run plan.",
      );
    }
  }

  const applyPlan = toApplyPlan(planTask);

  // Atomic: idempotency + freshness + desired_mutations + leases + queued
  // task. Throws (CONFLICT/PRECONDITION_FAILED) on every conflict; the route
  // lets the error middleware render those. Returns the original on a replay.
  const task = tasks.taskEngine.apply({
    plan: applyPlan,
    applyReq: {
      input_hash: planTask.input_hash,
      idempotency_key: idempotencyKey,
      principal: rc.principal,
      client_type: rc.client_type,
      request_id: rc.request_id,
      correlation_id: rc.correlation_id,
      // S9: destructive ops (config.rollback) ride the generic helper —
      // the engine enforces the flag (risk_level destructive).
      ...(body.dangerous === true ? { dangerous: true } : {}),
    },
  });
  rc.operation_id = task.task_id;

  // Idempotent replay: apply returned an EXISTING task (already dispatched).
  // Do NOT re-dispatch — return it as-is with 202.
  if (task.state !== 'queued') {
    res.status(202);
    sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
    return;
  }

  // Fresh queued task → hybrid pool admission (§5.3): slot free → inline
  // dispatch exactly as before (202 running, or failBeforeChange's 503/422);
  // pool full → no dispatch, 202 with the task still queued (the drainer
  // dispatches it FIFO when a slot frees). The engine treats an absent agent
  // client as a begin-unavailable failure, so the fail-task + Model-R desired
  // revert + release-leases + 503 contract lives in exactly one place.
  const admitted = await tasks.taskEngine.admitAndDispatch({
    task,
    agentClient: tasks.agentClient,
    spec: planTask.spec, // the RAW executor input, forwarded verbatim (T9b)
    plan: applyPlan,
  });

  res.status(202);
  sendOk(req, res, taskEnvelope(admitted), [admitted.state_revision_at_apply ?? 0]);
}
