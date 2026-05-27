import { Router } from 'express';
import { ApiException } from '../errors.js';
import { buildEnvelope } from '../envelope.js';
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

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

export function configHistoryRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.get('/config-history/snapshots', (req, res) => emptyEnvelope(req, res, []));
  r.get('/config-history/snapshots/:id', (_req, _res) => {
    throw new ApiException('NOT_FOUND', 'snapshot not found (config-history bridge not integrated)');
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
  r.get('/config-history/drift', (req, res) => emptyEnvelope(req, res, { drift: [] }));
  return r;
}
