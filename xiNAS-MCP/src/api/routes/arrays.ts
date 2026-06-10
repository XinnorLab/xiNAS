/**
 * S3 T8 — POST /api/v1/arrays: the first REAL operation route on the S2
 * plan/apply engine (s3-xiraid-array-spec §6, ADR-0006 §API endpoints).
 *
 * Body:
 *   - `{ mode: 'plan', spec }` (create-shaped) → PlanEngine.plan
 *       ('xiraid.array.create') → 200 + the rendered Plan (blockers listed,
 *       never blocking the PLAN itself).
 *   - `{ mode: 'plan'|'apply', spec: { uuid } }` (import-shaped) →
 *       UNSUPPORTED (import is designed in ADR-0006, built in a follow-on
 *       plan).
 *   - `{ mode: 'apply', plan_id, expected_revision, idempotency_key }` —
 *       the FULL OpenAPI ApplyRequest. For create, expected_revision MUST
 *       be 0 (the array must not exist — ADR-0006 freshness convention).
 *       Blockers are re-checked against CURRENT observed state at apply:
 *       a still-blocked plan → PRECONDITION_FAILED with the blockers in
 *       details. Then the unchanged S2 path: atomic apply (idempotency +
 *       leases on the array + member disks) → dispatch task.begin → 202.
 *
 * PATCH/DELETE /arrays/{id} (modify/delete) stay on the
 * handlers/unsupported.ts stubs until their plans land (spec §1).
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
import { xiraidArrayCreateProvider } from '../plan/providers/xiraid-array.js';

export function arraysRouter(ctx: ApiContext): Router {
  const r = Router();

  r.post('/arrays', async (req, res) => {
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
      rejectImportShaped(body.spec);
      const { task, planResult } = await tasks.planEngine.plan({
        operation_kind: 'xiraid.array.create',
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
      if (!planTask || planTask.state !== 'plan_only' || planTask.kind !== 'xiraid.array.create') {
        throw new ApiException(
          'NOT_FOUND',
          `no xiraid.array.create plan_only task with plan_id ${planId}`,
          undefined,
          'Re-run mode=plan to obtain a fresh plan_id.',
        );
      }

      // ADR-0006 create-freshness convention: the array must not exist, so
      // the only valid expected_revision is 0.
      if (expectedRevision !== 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'create applies against a non-existent array; expected_revision must be 0',
          { reason: 'create_expects_revision_zero', expected_revision: expectedRevision },
          'Send expected_revision: 0 for array creation.',
        );
      }

      // Blockers are not persisted on the plan row — re-run preflight against
      // CURRENT observed state. This both enforces the plan's blockers and
      // catches drift since plan time (a disk claimed meanwhile, the name
      // taken, ...). The persisted (enriched) spec is structurally a valid
      // create spec, so it re-validates as-is.
      const recheck = await xiraidArrayCreateProvider.preflight(
        { kv: ctx.state.kv },
        planTask.spec,
      );
      if (recheck.blockers.length > 0) {
        throw new ApiException(
          'PRECONDITION_FAILED',
          'the plan has unresolved blockers',
          { blockers: recheck.blockers },
          'Resolve every blocker, re-plan, then apply the fresh plan.',
        );
      }

      const applyPlan = toApplyPlan(planTask);
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

      // Idempotent replay → return the existing task without re-dispatch.
      if (task.state !== 'queued') {
        res.status(202);
        sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
        return;
      }

      const dispatched = await tasks.taskEngine.dispatch({
        task,
        agentClient: tasks.agentClient,
        spec: planTask.spec, // enriched spec incl. device_by_id (T7)
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

/** Import-shaped specs (foreign-array uuid) are a follow-on plan (ADR-0006). */
function rejectImportShaped(spec: unknown): void {
  if (typeof spec === 'object' && spec !== null && 'uuid' in spec) {
    throw new ApiException(
      'UNSUPPORTED',
      'array import is not built yet (S3 ships create only)',
      { code: 'EXECUTOR_UNSUPPORTED' },
      'Import (raid_import_show/apply) lands in a follow-on plan per ADR-0006.',
    );
  }
}
