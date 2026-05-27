import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { OpenedStateStore } from '../../state/index.js';

/**
 * Hashes the request parameters (path + query + body) into a stable
 * digest for audit.parameters_hash.
 */
function parametersHash(req: Request): string {
  const obj = {
    method: req.method,
    path: req.path,
    query: req.query,
    body: typeof req.body === 'object' ? req.body : {},
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Queue an audit entry after the response finishes. For reads,
 * audit queueing is best-effort: a failure goes to the journal and
 * does not deny the response.
 */
export function auditMiddleware(state: OpenedStateStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const ctx = req.context;
      if (!ctx) return;
      try {
        // Conditional spread — exactOptionalPropertyTypes refuses
        // `operation_id: ctx.operation_id` when operation_id is optional
        // and may be undefined.
        const entry: Parameters<typeof state.audit.queue>[0] = {
          kind: `http.${req.method}.${req.path}`,
          principal: ctx.principal,
          client_type: ctx.client_type,
          request_id: ctx.request_id,
          parameters_hash: parametersHash(req),
          result_hash: 'sha256:' + createHash('sha256').update(String(res.statusCode)).digest('hex'),
          ...(ctx.operation_id !== undefined ? { operation_id: ctx.operation_id } : {}),
        };
        state.audit.queue(entry);
      } catch (err) {
        // Best-effort on reads; mutating-write semantics land
        // when mutating handlers actually do something.
        // eslint-disable-next-line no-console
        console.error('audit queue failed:', err);
      }
    });
    next();
  };
}
