import { Router } from 'express';
import { sendOk } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function healthRouter(_ctx: ApiContext): Router {
  const r = Router();

  r.get('/health', (req, res) => {
    const profile = (req.query.profile as string | undefined) ?? 'quick';
    const now = new Date().toISOString();
    sendOk(req, res, {
      profile,
      started_at: now,
      completed_at: now,
      overall: 'ok',
      checks: [
        {
          id: 'xinas-api.alive',
          category: 'api',
          status: 'ok',
          symptom: 'xinas-api is responding',
          impact: 'none',
          evidence: {},
          recommended_action: 'no action required',
        },
      ],
    });
  });

  return r;
}
