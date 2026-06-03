import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';

/**
 * Factory that returns the stub used by every mutating endpoint.
 * Per ADR-0002 §Agent heartbeat, behaviour depends on tracker state:
 *
 *   - No tracker OR tracker state === 'offline':
 *       INTERNAL / EXECUTOR_UNAVAILABLE (500). The executor can't be
 *       reached; remediation: restart xinas-agent.service.
 *
 *   - Tracker state === 'healthy' OR 'degraded':
 *       UNSUPPORTED / EXECUTOR_UNSUPPORTED (422). The executor is
 *       reachable but the mutating method isn't implemented in this
 *       S0+S1 build yet.
 *
 * The EXECUTOR_DEGRADED warning for the degraded case is injected
 * separately by systemWarningsMiddleware into the envelope warnings[].
 */
export function executorUnavailable(ctx: ApiContext) {
  return (_req: Request, _res: Response): void => {
    const offline = ctx.tracker ? ctx.tracker.currentState() === 'offline' : true;
    if (offline) {
      throw new ApiException(
        'INTERNAL',
        'xinas-agent is offline',
        { code: 'EXECUTOR_UNAVAILABLE' },
        'restart xinas-agent.service',
      );
    }
    // Executor reachable but the method isn't built yet in S0+S1.
    throw new ApiException('UNSUPPORTED', 'this operation is not implemented in this build', {
      code: 'EXECUTOR_UNSUPPORTED',
    });
  };
}
