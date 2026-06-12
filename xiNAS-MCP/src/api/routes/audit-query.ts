/**
 * GET /audit (S9 T6, ADR-0011) — the live audit query.
 *
 * Tail filters or ONE exact lookup (request_id | operation_id |
 * task_id); see handlers/audit-query.ts for the engine (drain-first
 * index resolution with the audit_outbox fallback).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { queryAudit } from '../handlers/audit-query.js';
import { sendOk } from '../handlers/reads.js';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export function auditRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/audit', (req: Request, res: Response, next) => {
    void (async () => {
      const limitRaw = str(req.query.limit);
      const limit = Math.min(Math.max(Number.parseInt(limitRaw ?? '100', 10) || 100, 1), 1000);
      const exact = [str(req.query.request_id), str(req.query.operation_id), str(req.query.task_id)];
      if (exact.filter((v) => v !== undefined).length > 1) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          'use exactly one of request_id, operation_id, task_id',
        );
      }
      const requestId = str(req.query.request_id);
      const operationId = str(req.query.operation_id);
      const taskId = str(req.query.task_id);
      const kind = str(req.query.kind);
      const principal = str(req.query.principal);
      const clientType = str(req.query.client_type);
      const since = str(req.query.since);
      const until = str(req.query.until);
      const rows = await queryAudit(ctx, {
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        ...(operationId !== undefined ? { operation_id: operationId } : {}),
        ...(taskId !== undefined ? { task_id: taskId } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(clientType !== undefined ? { client_type: clientType } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit,
      });
      sendOk(req, res, rows);
    })().catch(next);
  });
  return r;
}
