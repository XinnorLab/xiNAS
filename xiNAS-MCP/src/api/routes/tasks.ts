import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import { executorUnavailable } from '../handlers/unsupported.js';
import type { ApiContext } from '../context.js';

export function tasksRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/tasks', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/tasks/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/tasks/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.post('/tasks/:id/cancel', executorUnavailable);

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
