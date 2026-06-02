import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { getOrNull, listByPrefix, sendOk, unwrapValues } from '../handlers/reads.js';

export function nfsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/shares', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/Share/');
    sendOk(
      req,
      res,
      unwrapValues(rows),
      rows.map((x) => x.revision),
    );
  });

  r.get('/shares/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/Share/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/shares/:id/sessions', (req, res) => {
    // The Share itself lives in desired state (same prefix the list/get
    // handlers read). 404 if it doesn't exist.
    const shareRow = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/Share/${req.params.id}`,
    );
    if (!shareRow) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);

    // Sessions are observed NfsSession entries (pushed by the agent). Filter
    // the full observed set to those whose spec.export_path matches this
    // share's spec.export_path. A defensive client_addr type guard skips any
    // malformed observed row.
    const shareSpec = shareRow.value.spec as Record<string, unknown> | undefined;
    const exportPath = shareSpec?.export_path as string | undefined;
    const sessions = listByPrefix<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/NfsSession/',
    ).filter((row) => {
      const spec = row.value.spec as Record<string, unknown> | undefined;
      return typeof spec?.client_addr === 'string' && spec?.export_path === exportPath;
    });

    sendOk(
      req,
      res,
      unwrapValues(sessions),
      sessions.map((row) => row.revision),
    );
  });

  r.get('/nfs-profiles', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/NfsProfile/');
    sendOk(
      req,
      res,
      unwrapValues(rows),
      rows.map((x) => x.revision),
    );
  });

  r.get('/nfs-profiles/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/desired/NfsProfile/${req.params.id}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `nfs profile ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/export-groups', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ExportGroup/');
    sendOk(
      req,
      res,
      unwrapValues(rows),
      rows.map((x) => x.revision),
    );
  });

  return r;
}
