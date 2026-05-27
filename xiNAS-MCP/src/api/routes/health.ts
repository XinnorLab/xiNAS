import { Router } from 'express';
import { sendOk } from '../handlers/reads.js';
import { ApiException } from '../errors.js';
import type { ApiContext } from '../context.js';

// Per api-v1.yaml: { type: string, enum: [quick, standard, deep], default: quick }
const ALLOWED_PROFILES = new Set(['quick', 'standard', 'deep']);

export function healthRouter(_ctx: ApiContext): Router {
  const r = Router();

  r.get('/health', (req, res) => {
    const profile = (req.query.profile as string | undefined) ?? 'quick';
    if (!ALLOWED_PROFILES.has(profile)) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        `unknown health profile '${profile}'; must be one of: quick, standard, deep`,
        { profile },
      );
    }
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
