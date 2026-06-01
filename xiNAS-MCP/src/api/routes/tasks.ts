import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import { executorUnavailable } from '../handlers/unsupported.js';
import type { ApiContext } from '../context.js';

/**
 * Per api-v1.yaml QueryLimit: integer, default 100, min 1, max 1000.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return 100;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param 'limit' must be a single value`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param 'limit' must be an integer, got '${raw}'`,
    );
  }
  if (n < 1 || n > 1000) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `query param 'limit' must be in [1, 1000], got ${n}`,
    );
  }
  return n;
}

function parseStringQuery(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', `query param '${name}' must be a single value`);
  }
  return raw;
}

export function tasksRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/tasks', (req, res) => {
    const stateFilter = parseStringQuery(req.query.state, 'state');
    const kindFilter = parseStringQuery(req.query.kind, 'kind');
    const limit = parseLimit(req.query.limit);
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/tasks/');
    let values = unwrapValues(rows);
    if (stateFilter !== undefined) {
      values = values.filter((v) => (v as { state?: string }).state === stateFilter);
    }
    if (kindFilter !== undefined) {
      values = values.filter((v) => (v as { kind?: string }).kind === kindFilter);
    }
    if (values.length > limit) values = values.slice(0, limit);
    sendOk(
      req,
      res,
      values,
      rows.map((x) => x.revision),
    );
  });

  r.get('/tasks/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.post('/tasks/:id/cancel', executorUnavailable(ctx));

  r.get('/tasks/:id/watch', (req, res) => {
    // Single-shot SSE: emit one snapshot event with the current state,
    // then close. Real streaming over kv.watch lands when there are
    // tasks to watch.
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify(row.value)}\n\n`);
    res.end();
  });

  return r;
}
