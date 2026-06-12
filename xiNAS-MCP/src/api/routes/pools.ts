/**
 * Pool mutating routes (S9 T8, ADR-0011): POST /pools (create),
 * PATCH /pools/{name} (one intent: add_drives | remove_drives |
 * active), DELETE /pools/{name}. Plain plan/apply over the shared
 * helpers; GET /pools lives in promoted-reads (KV-backed).
 */

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { applyMode, planMode, requireTasks } from './apply-helpers.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function poolsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.post('/pools', async (req, res, next) => {
    try {
      const tasks = requireTasks(ctx);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.mode === 'plan') {
        await planMode(req, res, tasks, 'pool.create', isRecord(body.spec) ? body.spec : {});
        return;
      }
      if (body.mode === 'apply') {
        await applyMode(req, res, tasks, body, { operationKind: 'pool.create' });
        return;
      }
      throw new ApiException('INVALID_ARGUMENT', "mode must be 'plan' or 'apply'");
    } catch (err) {
      next(err);
    }
  });

  const mutate =
    (operationKind: string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const tasks = requireTasks(ctx);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = req.params.name as string;
        if (body.mode === 'plan') {
          const spec = isRecord(body.spec) ? body.spec : {};
          await planMode(req, res, tasks, operationKind, { ...spec, name });
          return;
        }
        if (body.mode === 'apply') {
          await applyMode(req, res, tasks, body, {
            operationKind,
            planTaskMatches: (planTask) =>
              (planTask.spec as { name?: string } | undefined)?.name === name,
          });
          return;
        }
        throw new ApiException('INVALID_ARGUMENT', "mode must be 'plan' or 'apply'");
      } catch (err) {
        next(err);
      }
    };

  r.patch('/pools/:name', mutate('pool.modify'));
  r.delete('/pools/:name', mutate('pool.delete'));

  return r;
}
