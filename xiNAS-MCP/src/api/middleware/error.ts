import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ApiException, errorStatus, makeError } from '../errors.js';
import { buildEnvelope } from '../envelope.js';

export function errorMiddleware(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const ctx = req.context;
    if (err instanceof ApiException) {
      res
        .status(errorStatus(err.code))
        .json(
          buildEnvelope({
            request_id: ctx?.request_id ?? 'unknown',
            correlation_id: ctx?.correlation_id ?? 'unknown',
            state_revision: 0,
            errors: [makeError(err.code, err.message, err.details, err.remediation)],
            result: null,
          }),
        );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res
      .status(errorStatus('INTERNAL'))
      .json(
        buildEnvelope({
          request_id: ctx?.request_id ?? 'unknown',
          correlation_id: ctx?.correlation_id ?? 'unknown',
          state_revision: 0,
          errors: [makeError('INTERNAL', msg)],
          result: null,
        }),
      );
  };
}
