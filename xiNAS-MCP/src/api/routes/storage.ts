import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function storageRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/disks', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Disk/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/arrays', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/XiraidArray/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/arrays/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/XiraidArray/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `array ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/filesystems', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Filesystem/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/filesystems/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/Filesystem/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `filesystem ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
