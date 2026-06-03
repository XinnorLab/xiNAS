import type { NextFunction, Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * requireInternalAgent — role gate for /internal/v1/* routes.
 *
 * Rejects unless req.context.role === 'internal_agent'. This is
 * explicitly stricter than the normal auth middleware:
 *
 *   - UDS-trust admin promotion (role='admin') is NOT sufficient.
 *     Even a root-level local connection gets 401 here.
 *   - A bearer token with role='admin' or 'operator' is NOT sufficient.
 *   - Only a bearer token whose TokenPrincipal.role is 'internal_agent'
 *     passes.
 *
 * Rationale (ADR-0002 line 221, spec §"API processing" step 1):
 * The /internal/v1/ family is the agent's exclusive write path.
 * Allowing operators or admin tokens would let a local admin push
 * arbitrary state bypassing the privilege boundary.
 *
 * Must run AFTER authMiddleware (which populates req.context).
 */
export function requireInternalAgent() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (!ctx) {
      next(new Error('requireInternalAgent requires authMiddleware to run first'));
      return;
    }
    if (ctx.role === 'internal_agent') {
      next();
      return;
    }
    res.status(errorStatus('PERMISSION_DENIED')).json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        errors: [
          makeError(
            'PERMISSION_DENIED',
            'this route requires the internal_agent role; ' +
              'UDS admin trust and operator/admin bearer tokens are not accepted',
          ),
        ],
        result: null,
      }),
    );
  };
}
