import { Router } from 'express';
import type { Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import type { ApiContext } from '../context.js';

export function auditRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.get('/audit', (req: Request, res: Response) => {
    const ctx = req.context!;
    res.json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        warnings: [{
          code: 'AUDIT_QUERY_NOT_IMPLEMENTED',
          message: 'audit query against the JSONL is not implemented in this PR; result is empty',
        }],
        result: [],
      }),
    );
  });
  return r;
}
