import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import { ApiException, errorStatus, makeError } from '../errors.js';
import { mergeWarnings } from '../handlers/merge-warnings.js';

/**
 * Express body-parser (express.json) signals malformed JSON by
 * calling next(err) with a SyntaxError whose `type` is set to
 * 'entity.parse.failed' (raw-body) or whose `body` property is the
 * unparseable buffer. We translate those to INVALID_ARGUMENT/400
 * rather than letting them collapse into the generic INTERNAL/500
 * branch.
 */
function isBodyParseError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) return false;
  const e = err as SyntaxError & { type?: string; body?: unknown; status?: number };
  if (e.type === 'entity.parse.failed') return true;
  if (e.body !== undefined) return true;
  // body-parser also sets err.status=400 on its own errors.
  if (e.status === 400) return true;
  return false;
}

export function errorMiddleware(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const ctx = req.context;
    if (err instanceof ApiException) {
      res.status(err.httpStatusOverride ?? errorStatus(err.code)).json(
        buildEnvelope({
          request_id: ctx?.request_id ?? 'unknown',
          correlation_id: ctx?.correlation_id ?? 'unknown',
          state_revision: 0,
          warnings: mergeWarnings([], ctx?.system_warnings ?? []),
          errors: [makeError(err.code, err.message, err.details, err.remediation)],
          result: null,
        }),
      );
      return;
    }
    if (isBodyParseError(err)) {
      const msg = err instanceof Error ? err.message : 'malformed request body';
      res.status(errorStatus('INVALID_ARGUMENT')).json(
        buildEnvelope({
          request_id: ctx?.request_id ?? 'unknown',
          correlation_id: ctx?.correlation_id ?? 'unknown',
          state_revision: 0,
          warnings: mergeWarnings([], ctx?.system_warnings ?? []),
          errors: [makeError('INVALID_ARGUMENT', `malformed JSON body: ${msg}`)],
          result: null,
        }),
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(errorStatus('INTERNAL')).json(
      buildEnvelope({
        request_id: ctx?.request_id ?? 'unknown',
        correlation_id: ctx?.correlation_id ?? 'unknown',
        state_revision: 0,
        warnings: mergeWarnings([], ctx?.system_warnings ?? []),
        errors: [makeError('INTERNAL', msg)],
        result: null,
      }),
    );
  };
}
