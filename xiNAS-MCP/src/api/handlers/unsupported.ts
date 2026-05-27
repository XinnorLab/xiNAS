import type { Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * Single stub used by every mutating endpoint in this PR. Per
 * ADR-0002 §Agent heartbeat, when the agent isn't reachable
 * mutating ops fail with INTERNAL/EXECUTOR_UNAVAILABLE.
 *
 * In the xinas-api skeleton the agent doesn't exist at all, so
 * every mutating verb routes here. When the agent ships, this
 * handler gets replaced with real plan/apply dispatch per route.
 */
export function executorUnavailable(req: Request, res: Response): void {
  const ctx = req.context!;
  res
    .status(errorStatus('INTERNAL'))
    .json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        errors: [
          makeError(
            'INTERNAL',
            'mutating operations are unavailable: xinas-agent is not running',
            { code: 'EXECUTOR_UNAVAILABLE' },
            'start xinas-agent.service; mutating endpoints will return once the agent is healthy',
          ),
        ],
        result: null,
      }),
    );
}
