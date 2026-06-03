import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Middleware that ensures every request has a request_id (server-
 * generated UUID) and a correlation_id (caller-provided via
 * X-Correlation-ID, else equal to request_id). Both are attached to
 * req.context and echoed in the response headers.
 *
 * Auth fields (principal, role) are filled later by the auth
 * middleware; this one just seeds the shape.
 */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const request_id = randomUUID();
    const correlation_id =
      req.header('X-Correlation-ID') ?? req.header('x-correlation-id') ?? request_id;
    req.context = {
      request_id,
      correlation_id,
      principal: 'anonymous',
      role: 'viewer',
      client_type: 'rest',
      system_warnings: [],
    };
    res.setHeader('X-Request-ID', request_id);
    res.setHeader('X-Correlation-ID', correlation_id);
    next();
  };
}
