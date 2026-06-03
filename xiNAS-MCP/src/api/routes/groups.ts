/**
 * /api/v1/groups — list and get observed Group resources.
 *
 * Observed at: /xinas/v1/observed/Group/<gid-as-string>
 * Source filter: ?source=local|nss|all (default: all)
 *
 * Follows the live route shape (see the Phase-I route-handler contract):
 * factory takes ApiContext, sendOk(req, res, result, revisions), 404 via
 * ApiException, helpers from reads.js.
 */
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { getOrNull, listByPrefix, sendOk, unwrapValues } from '../handlers/reads.js';

export function groupsRouter(ctx: ApiContext): Router {
  const r = Router();

  // GET /api/v1/groups[?source=local|nss|all]
  r.get('/groups', (req, res) => {
    const source = (req.query.source as string | undefined) ?? 'all';
    if (source !== 'all' && source !== 'local' && source !== 'nss') {
      throw new ApiException('INVALID_ARGUMENT', `source must be local|nss|all, got '${source}'`);
    }
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Group/');
    let values = unwrapValues(rows);
    if (source !== 'all') {
      values = values.filter(
        (g) => (g.status as { source?: string } | undefined)?.source === source,
      );
    }
    sendOk(
      req,
      res,
      values,
      rows.map((x) => x.revision),
    );
  });

  // GET /api/v1/groups/:gid
  r.get('/groups/:gid', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/Group/${req.params.gid}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `group gid=${req.params.gid} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
