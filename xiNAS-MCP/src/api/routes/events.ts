import { Router } from 'express';
import { sendOk, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function eventsRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/events', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/events/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });
  return r;
}
