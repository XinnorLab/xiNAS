import type { NextFunction, Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';

interface AgentStartedBody {
  controller_id: string;
}

/**
 * POST /internal/v1/agent_started
 *
 * The agent calls this once after its initial sweep batch completes.
 * The api clears the HeartbeatTracker's startup grace by treating
 * agent_started as a successful heartbeat signal — the api starts in
 * 'offline' state and would sit there until the first 5s heartbeat
 * tick if agent_started were not posted.
 *
 * Returns 204 No Content on success.
 */
export function agentStartedHandler(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as AgentStartedBody;

      if (body.controller_id !== ctx.config.controller_id) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `controller_id mismatch: request has '${body.controller_id}', ` +
            `api is configured with '${ctx.config.controller_id}'`,
        );
      }

      // Treat agent_started as a synthetic successful heartbeat so the
      // tracker immediately transitions from 'offline' to 'healthy'.
      // This clears the startup grace window without waiting for the
      // first real heartbeat tick.
      ctx.tracker?.recordHeartbeatSuccess(new Date());

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };
}
