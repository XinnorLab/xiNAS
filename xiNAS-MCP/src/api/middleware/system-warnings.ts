import type { NextFunction, Request, Response } from 'express';
import type { ApiContext } from '../context.js';

/** HTTP methods that represent mutating operations. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * systemWarningsMiddleware — populates req.context.system_warnings
 * from HeartbeatTracker.currentWarnings() on every request.
 *
 * Must run after authMiddleware (req.context must be populated).
 * Must run before route handlers so system_warnings is available when
 * sendOk() or errorMiddleware() builds the response envelope.
 *
 * Semantics per spec §Observability:
 *   EXECUTOR_DEGRADED is injected only on mutating-route requests
 *   (POST/PUT/PATCH/DELETE) when the tracker is in 'degraded' state.
 *   Read endpoints (GET) do NOT carry the warning.
 */
export function systemWarningsMiddleware(ctx: ApiContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const context = req.context;
    if (!context) {
      next();
      return;
    }
    // Ensure system_warnings is initialized even when no tracker exists.
    context.system_warnings = [];

    const tracker = ctx.tracker;
    if (tracker) {
      const routeIsMutating = MUTATING_METHODS.has(req.method);
      context.system_warnings = tracker.currentWarnings({ routeIsMutating });
    }

    next();
  };
}
