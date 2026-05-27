import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function nfsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/shares', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/Share/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/shares/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/desired/Share/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/shares/:id/sessions', (req, res) => {
    // Sessions are runtime observation state; not in the store yet.
    // The agent will populate /xinas/v1/observed/Share/<id>/sessions
    // when it ships. Until then, return an empty array.
    const exists = getOrNull(ctx.state, `/xinas/v1/desired/Share/${req.params.id}`);
    if (!exists) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, []);
  });

  r.get('/nfs-profiles', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/NfsProfile/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/nfs-profiles/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/desired/NfsProfile/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `nfs profile ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/export-groups', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ExportGroup/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  return r;
}
