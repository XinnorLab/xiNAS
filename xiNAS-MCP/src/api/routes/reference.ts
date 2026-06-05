import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import type { ApplyPlan } from '../tasks/engine.js';
import type { Task } from '../tasks/types.js';

/**
 * T4 — the first MUTATING route, `POST /api/v1/reference`, over the S2
 * plan/apply + task engine (s2-task-envelope-spec §5.2). It proves the engine
 * end-to-end against the built-in inert `reference.echo` executor without
 * touching any real OS state. Real executors (arrays/fs/nfs/network) register
 * their own providers and mount their own routes in S3–S6; their routes stay
 * `executorUnavailable` until then.
 *
 * Body:
 *   - `{ mode: 'plan', spec }`  → PlanEngine.plan → 200 + the rendered Plan.
 *   - `{ mode: 'apply', plan_id, idempotency_key, expected_revision? }`
 *       → TaskEngine.apply (atomic idempotency+freshness+leases+queued task)
 *       → inline dispatch (task.begin): accept → 202 running Task;
 *         unavailable → 503, rejected → 422 (both fail the task + release leases).
 *   - any other `mode` → INVALID_ARGUMENT (400).
 */
export function referenceRouter(ctx: ApiContext): Router {
  const r = Router();

  r.post('/reference', async (req, res) => {
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

    const rc = req.context!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode;

    if (mode === 'plan') {
      const { task, planResult } = await tasks.planEngine.plan({
        operation_kind: 'reference.echo',
        spec: body.spec,
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
        },
        [revision],
      );
      return;
    }

    if (mode === 'apply') {
      const planId = requireString(body.plan_id, 'plan_id');
      const idempotencyKey = requireString(body.idempotency_key, 'idempotency_key');

      // Resolve the plan_only task this apply binds against.
      const planTask = tasks.store.get(planId);
      if (!planTask || planTask.state !== 'plan_only') {
        throw new ApiException(
          'NOT_FOUND',
          `no plan_only task with plan_id ${planId}`,
          undefined,
          'Re-run mode=plan to obtain a fresh plan_id.',
        );
      }

      const applyPlan = toApplyPlan(planTask);

      // Atomic: idempotency + freshness + leases + queued task. Throws
      // (CONFLICT/PRECONDITION_FAILED) on every conflict; the route lets the
      // error middleware render those. Returns the original on a true replay.
      const task = tasks.taskEngine.apply({
        plan: applyPlan,
        applyReq: {
          input_hash: planTask.input_hash,
          idempotency_key: idempotencyKey,
          principal: rc.principal,
          client_type: rc.client_type,
          request_id: rc.request_id,
          correlation_id: rc.correlation_id,
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

      // Fresh queued task → dispatch task.begin. The engine treats an absent
      // agent client as a begin-unavailable failure, so the fail-task +
      // release-leases + 503 contract lives in exactly one place (the engine).
      const dispatched = await tasks.taskEngine.dispatch({
        task,
        agentClient: tasks.agentClient,
        spec: planTask.affected_resources, // S2 reference: spec is echoed; agent ignores
        plan: applyPlan,
      });

      res.status(202);
      sendOk(req, res, taskEnvelope(dispatched), [dispatched.state_revision_at_apply ?? 0]);
      return;
    }

    throw new ApiException(
      'INVALID_ARGUMENT',
      `unknown mode '${String(mode)}'; expected 'plan' or 'apply'`,
      undefined,
      "Send { mode: 'plan', spec } or { mode: 'apply', plan_id, idempotency_key }.",
    );
  });

  return r;
}

/** Map a stored `plan_only` Task to the apply transaction's ApplyPlan. */
function toApplyPlan(planTask: Task): ApplyPlan {
  return {
    plan_id: planTask.task_id,
    kind: planTask.kind,
    risk_level: planTask.risk_level,
    affected_resources: planTask.affected_resources,
    ...(planTask.plan_hash !== undefined ? { plan_hash: planTask.plan_hash } : {}),
    ...(planTask.state_revision_expected !== undefined
      ? { state_revision_expected: planTask.state_revision_expected }
      : {}),
  };
}

/** The Task envelope shape the 202 returns (subset the route needs to surface). */
function taskEnvelope(task: Task): Record<string, unknown> {
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

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `'${name}' is required and must be a non-empty string`,
    );
  }
  return v;
}

/** Plain-language NFS-client impact for the Plan envelope (reference = none). */
function clientImpact(riskLevel: string): string {
  return riskLevel === 'non_disruptive'
    ? 'No impact on NFS clients.'
    : 'May affect NFS clients; review the diff.';
}
