/**
 * Support bundle routes (S7 T7, ADR-0009 §Bundle).
 *
 * POST /support-bundle — the INTERNAL plan→apply→stage→admit composite
 * (review P0: admitAndDispatch only dispatches an EXISTING queued task,
 * so creation/idempotency/leases stay in the apply txn where they
 * live). The request_id doubles as the idempotency key. Between apply
 * (task_id known) and dispatch, the api stages the DB-owned half —
 * recent tasks, audit tail, observed+desired dumps, a quick health
 * report — as <bundle_dir>/<task_id>.api.json for the agent to fold in
 * (the agent has no DB access by design). The dispatch spec carries
 * the apply task_id (archive naming + staging pickup).
 *
 * GET /support-bundle/{task_id} — streams the finished archive; 404
 * until the executor's verify stage has passed.
 */

import { createReadStream } from 'node:fs';
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { QUICK_CHECKS } from '../../lib/health/checks.js';
import { overallOf } from '../../lib/health/engine.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { gatherHealthFacts } from '../handlers/health-facts.js';
import { sendOk } from '../handlers/reads.js';
import { taskEnvelope, toApplyPlan } from './apply-helpers.js';

const DEFAULT_BUNDLE_DIR = '/var/log/xinas/bundles';
const STAGED_TASKS = 200;
const STAGED_AUDIT_LINES = 1000;

async function stageApiHalf(ctx: ApiContext, bundleDir: string, taskId: string): Promise<void> {
  const tasks = ctx.tasks?.store.list({}).slice(-STAGED_TASKS) ?? [];

  let auditTail: string[] = [];
  try {
    const raw = await readFile(ctx.config.state.auditJsonlPath, 'utf8');
    auditTail = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-STAGED_AUDIT_LINES);
  } catch {
    /* audit log absent: staged as empty */
  }

  const observed = ctx.state.kv.list<unknown>({ prefix: '/xinas/v1/observed/' });
  const desired = ctx.state.kv.list<unknown>({ prefix: '/xinas/v1/desired/' });

  const gathered = gatherHealthFacts(ctx);
  const checks = QUICK_CHECKS.map((check) => check(gathered.facts));

  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    join(bundleDir, `${taskId}.api.json`),
    JSON.stringify(
      {
        staged_at: new Date().toISOString(),
        tasks,
        audit: auditTail.map((line) => JSON.parse(line) as unknown),
        observed,
        desired,
        health: { profile: 'quick', overall: overallOf(checks), checks },
      },
      null,
      2,
    ),
    'utf8',
  );
}

export function supportRouter(ctx: ApiContext): Router {
  const r = Router();
  const bundleDir = ctx.config.support_bundle_dir ?? DEFAULT_BUNDLE_DIR;

  r.post('/support-bundle', async (req, res, next) => {
    try {
      const tasks = ctx.tasks;
      if (tasks === undefined || tasks.agentClient === undefined) {
        throw new ApiException(
          'INTERNAL',
          'support bundle requires the task engine and an agent connection',
          { code: 'EXECUTOR_UNAVAILABLE' },
        );
      }
      const rc = req.context!;

      const { task: planTask } = await tasks.planEngine.plan({
        operation_kind: 'support.bundle',
        spec: { bundle_dir: bundleDir },
        principal: rc.principal,
        client_type: rc.client_type,
        request_id: rc.request_id,
        correlation_id: rc.correlation_id,
      });

      const persisted = tasks.store.get(planTask.task_id);
      if (persisted === null || persisted.state !== 'plan_only') {
        throw new ApiException('INTERNAL', 'bundle plan did not persist');
      }
      const applyPlan = toApplyPlan(persisted);
      const task = tasks.taskEngine.apply({
        plan: applyPlan,
        applyReq: {
          input_hash: persisted.input_hash,
          idempotency_key: rc.request_id,
          principal: rc.principal,
          client_type: rc.client_type,
          request_id: rc.request_id,
          correlation_id: rc.correlation_id,
        },
      });
      rc.operation_id = task.task_id;

      if (task.state !== 'queued') {
        // idempotent replay of a known task — no re-staging, no dispatch
        res.status(202);
        sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]);
        return;
      }

      // Stage the DB-owned half BEFORE dispatch so the collect stage
      // finds it; the dispatch spec carries the apply task_id.
      await stageApiHalf(ctx, bundleDir, task.task_id);

      const dispatchSpec = {
        ...(persisted.spec as Record<string, unknown>),
        task_id: task.task_id,
      };
      const dispatched = await tasks.taskEngine.admitAndDispatch({
        task,
        agentClient: tasks.agentClient,
        spec: dispatchSpec,
        plan: applyPlan,
      });

      res.status(202);
      sendOk(req, res, taskEnvelope(dispatched), [dispatched.state_revision_at_apply ?? 0]);
    } catch (err) {
      next(err);
    }
  });

  r.get('/support-bundle/:task_id', async (req, res, next) => {
    try {
      const taskId = req.params.task_id as string;
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
        throw new ApiException('INVALID_ARGUMENT', 'malformed task id');
      }
      const archive = join(bundleDir, `${taskId}.tar.gz`);
      try {
        await stat(archive);
      } catch {
        throw new ApiException('NOT_FOUND', 'no bundle for that task');
      }
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="xinas-support-${taskId}.tar.gz"`);
      createReadStream(archive).on('error', next).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
