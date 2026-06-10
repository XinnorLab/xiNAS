import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { applyMode, planMode, requireTasks } from './apply-helpers.js';

/**
 * T4 — the first MUTATING route, `POST /api/v1/reference`, over the S2
 * plan/apply + task engine (s2-task-envelope-spec §5.2). It proves the engine
 * end-to-end against the built-in inert `reference.echo` executor without
 * touching any real OS state. The shared two-mode flow lives in
 * `apply-helpers.ts` (extracted in S3 N5, when the first REAL mutating routes
 * — nfs-mutate.ts — landed); this route is now the thinnest consumer of it.
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
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body.mode;

    if (mode === 'plan') {
      await planMode(req, res, tasks, 'reference.echo', body.spec);
      return;
    }

    if (mode === 'apply') {
      // expected_revision stays optional here: /reference is the S2
      // engine-proof route (absent from api-v1.yaml), predating the
      // ApplyRequest contract the real mutating routes enforce.
      await applyMode(req, res, tasks, body, {
        operationKind: 'reference.echo',
        requireExpectedRevision: false,
      });
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
