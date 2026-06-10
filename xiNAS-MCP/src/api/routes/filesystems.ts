/**
 * S5 — /api/v1/filesystems mutating routes (ADR-0007, s5-filesystem-spec
 * §4): POST (fs.create) here in T7; PATCH (one-intent mount/unmount/
 * grow/quota) and DELETE (unmanage) join in T9–T11.
 *
 * Same engine flow as the arrays routes: plan → blockers listed → apply
 * with the §S4-4 freshness binding + the §S4-8 filtered re-check →
 * leases → dispatch. Create binds expected_revision = 0 (the unit must
 * not exist); the engine's dangerous gate covers force:true plans.
 */

import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import {
  clientImpact,
  requireInteger,
  requireString,
  taskEnvelope,
  toApplyPlan,
} from '../handlers/plan-apply.js';
import { sendOk } from '../handlers/reads.js';
import { fsCreateProvider } from '../plan/providers/filesystem.js';

export function filesystemsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.post('/filesystems', async (req, res) => {
    const tasks = ctx.tasks;
    if (!tasks) {
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
        operation_kind: 'fs.create',
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
      const expectedRevision = requireInteger(body.expected_revision, 'expected_revision');

      const planTask = tasks.store.get(planId);
      if (!planTask || planTask.state !== 'plan_only' || planTask.kind !== 'fs.create') {
        throw new ApiException(
          'NOT_FOUND',
          `no fs.create plan_only task with plan_id ${planId}`,
          undefined,
          'Re-run mode=plan to obtain a fresh plan_id.',
        );
      }

      // ADR-0007 create-freshness convention: the unit must not exist.
      if (expectedRevision !== 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'create applies against a non-existent filesystem; expected_revision must be 0',
          { reason: 'create_expects_revision_zero', expected_revision: expectedRevision },
          'Send expected_revision: 0 for filesystem creation.',
        );
      }

      // §S4-8: re-run preflight against current state; everything except the
      // engine-owned dangerous code blocks the apply.
      const recheck = await fsCreateProvider.preflight({ kv: ctx.state.kv }, planTask.spec);
      const blocking = recheck.blockers.filter((b) => b.code !== 'dangerous_flag_required');
      if (blocking.length > 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the plan has unresolved blockers',
          { blockers: blocking },
          'Resolve every blocker, re-plan, then apply the fresh plan.',
        );
      }

      const applyPlan = toApplyPlan(planTask);
      // The engine enforces dangerous for destructive (force:true) plans.
      const task = tasks.taskEngine.apply({
        plan: applyPlan,
        applyReq: {
          input_hash: planTask.input_hash,
          idempotency_key: idempotencyKey,
          principal: rc.principal,
          client_type: rc.client_type,
          request_id: rc.request_id,
          correlation_id: rc.correlation_id,
          ...(body.dangerous === true ? { dangerous: true } : {}),
        },
      });
      rc.operation_id = task.task_id;

      if (task.state !== 'queued') {
        res.status(202);
        sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
        return;
      }

      const dispatched = await tasks.taskEngine.dispatch({
        task,
        agentClient: tasks.agentClient,
        spec: planTask.spec,
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
      "Send { mode: 'plan', spec } or { mode: 'apply', plan_id, expected_revision, idempotency_key }.",
    );
  });

  return r;
}
