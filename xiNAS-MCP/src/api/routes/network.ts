import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function networkRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/network', (req, res) => {
    const ifaces = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/NetworkInterface/');
    sendOk(
      req,
      res,
      { interfaces: unwrapValues(ifaces) },
      ifaces.map((x) => x.revision),
    );
  });

  r.get('/network/interfaces', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/NetworkInterface/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/network/interfaces/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/NetworkInterface/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `interface ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/service-ips', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ServiceIP/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  return r;
}
