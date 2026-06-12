import { Router } from 'express';
import { ApiException } from '../errors.js';
import { buildEnvelope } from '../envelope.js';
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { driftNetplanCheck, driftNfsExportsCheck } from '../../lib/health/drift.js';
import { getOrNull, listByPrefix } from '../handlers/reads.js';
import { applyMode, planMode, requireTasks } from './apply-helpers.js';
import { gatherHealthFacts } from '../handlers/health-facts.js';
import { sendOk } from '../handlers/reads.js';

const WARN = {
  code: 'CONFIG_HISTORY_NOT_INTEGRATED',
  message: 'config-history bridge to xinas_history is a later PR; returning empty result',
};

function emptyEnvelope(req: Request, res: Response, result: unknown) {
  const ctx = req.context!;
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision: 0,
      warnings: [WARN],
      result,
    }),
  );
}

/** Observed ConfigSnapshot row → the public schema shape. */
function publicSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const status = (value.status ?? {}) as Record<string, unknown>;
  const { observed_at: _dropped, ...fields } = status;
  return fields;
}

export function configHistoryRouter(ctx: ApiContext): Router {
  const r = Router();

  // S9 T4 (ADR-0011): snapshots/show/diff are LIVE — KV rows pushed by
  // the agent's ConfigSnapshotCollector (already projected onto the
  // public shape) + the config.diff RPC. The NOT_INTEGRATED warning
  // survives only on the remaining stubs (rollback until T5).
  r.get('/config-history/snapshots', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/ConfigSnapshot/',
    );
    sendOk(
      req,
      res,
      rows.map((row) => publicSnapshot(row.value)),
      rows.map((row) => row.revision),
    );
  });

  r.get('/config-history/snapshots/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/ConfigSnapshot/${req.params.id}`,
    );
    if (row === null) {
      throw new ApiException('NOT_FOUND', `no such snapshot: ${req.params.id}`);
    }
    sendOk(req, res, publicSnapshot(row.value), [row.revision]);
  });

  r.get('/config-history/diff', async (req, res, next) => {
    try {
      const from = req.query.from;
      const to = req.query.to;
      if (typeof from !== 'string' || from.length === 0) {
        throw new ApiException('INVALID_ARGUMENT', `query param 'from' is required`);
      }
      if (typeof to !== 'string' || to.length === 0) {
        throw new ApiException('INVALID_ARGUMENT', `query param 'to' is required`);
      }
      const agentClient = ctx.tasks?.agentClient;
      if (agentClient === undefined) {
        sendOk(req, res, { from, to, diff: null }, [], [
          {
            code: 'EXECUTOR_UNAVAILABLE',
            message: 'no agent connection — the snapshot store is agent-readable only',
          },
        ]);
        return;
      }
      let diff: unknown;
      try {
        diff = await agentClient.call('config.diff', { from, to }, 5_000);
      } catch (err) {
        sendOk(req, res, { from, to, diff: null }, [], [
          {
            code: 'EXECUTOR_UNAVAILABLE',
            message: `config.diff failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
        return;
      }
      sendOk(req, res, { from, to, diff });
    } catch (err) {
      next(err);
    }
  });
  // S9 T5 (ADR-0011): baseline-only rollback as a destructive
  // plan/apply operation (replaces the executorUnavailable stub).
  r.post('/config-history/rollback', async (req, res, next) => {
    try {
      const tasks = requireTasks(ctx);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.mode === 'plan') {
        const spec = typeof body.spec === 'object' && body.spec !== null ? body.spec : {};
        await planMode(req, res, tasks, 'config.rollback', spec);
        return;
      }
      if (body.mode === 'apply') {
        await applyMode(req, res, tasks, body, { operationKind: 'config.rollback' });
        return;
      }
      throw new ApiException('INVALID_ARGUMENT', "mode must be 'plan' or 'apply'");
    } catch (err) {
      next(err);
    }
  });

  // S7 T6 (ADR-0009 §drift API surface): the SAME drift engine health
  // uses. The two KV-anchored comparisons run here; drift.nfs-conf needs
  // the agent's dry-render oracle, so it is reported not_evaluated with
  // a pointer at the standard health profile. One entry per NON-OK
  // check; a clean system returns { drift: [] }.
  r.get('/config-history/drift', (req, res) => {
    const gathered = gatherHealthFacts(ctx);
    const results = [
      driftNfsExportsCheck(gathered.desiredEntries, gathered.observedRules),
      driftNetplanCheck(gathered.desiredNetRows, gathered.xinasFileHash),
    ];
    const drift: Array<Record<string, unknown>> = results
      .filter((c) => c.status !== 'ok' && c.status !== 'skipped')
      .map((c) => ({
        artifact: c.id,
        status: c.status,
        symptom: c.symptom,
        evidence: c.evidence,
        recommended_action: c.recommended_action,
      }));
    if (gathered.desiredProfileSpec !== null) {
      drift.push({
        artifact: 'drift.nfs-conf',
        status: 'not_evaluated',
        symptom: 'requires the helper dry-render oracle',
        evidence: {},
        recommended_action: 'GET /health?profile=standard',
      });
    }
    sendOk(req, res, { drift });
  });
  return r;
}
