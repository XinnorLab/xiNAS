import { Router } from 'express';
import { ApiException } from '../errors.js';
import { buildEnvelope } from '../envelope.js';
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { driftNetplanCheck, driftNfsExportsCheck } from '../../lib/health/drift.js';
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

export function configHistoryRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/config-history/snapshots', (req, res) => emptyEnvelope(req, res, []));
  r.get('/config-history/snapshots/:id', (_req, _res) => {
    throw new ApiException(
      'NOT_FOUND',
      'snapshot not found (config-history bridge not integrated)',
    );
  });
  r.get('/config-history/diff', (req, res) => {
    // Per api-v1.yaml, both from and to are required string params.
    const from = req.query.from;
    const to = req.query.to;
    if (typeof from !== 'string' || from.length === 0) {
      throw new ApiException('INVALID_ARGUMENT', `query param 'from' is required`);
    }
    if (typeof to !== 'string' || to.length === 0) {
      throw new ApiException('INVALID_ARGUMENT', `query param 'to' is required`);
    }
    emptyEnvelope(req, res, { from, to, changes: [] });
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
