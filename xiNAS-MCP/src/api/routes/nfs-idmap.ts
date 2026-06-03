/**
 * /api/v1/nfs-idmap — singleton NfsIdmap resource.
 *
 * Observed at: /xinas/v1/observed/nfs_idmap/snapshot (snake_case
 * singleton per ADR-0003 locked layout — the agent uses observedSegment(Kind)
 * which maps NfsIdmap → nfs_idmap, so the key is nfs_idmap/snapshot,
 * NOT NfsIdmap/snapshot).
 *
 * Returns NOT_FOUND when the agent has not yet posted the snapshot.
 *
 * Follows the live route shape (see the Phase-I route-handler contract):
 * factory takes ApiContext, sendOk(req, res, result, revisions), 404 via
 * ApiException, helpers from reads.js.
 */
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { getOrNull, sendOk } from '../handlers/reads.js';

const SNAPSHOT_KEY = '/xinas/v1/observed/nfs_idmap/snapshot';

export function nfsIdmapRouter(ctx: ApiContext): Router {
  const r = Router();

  // GET /api/v1/nfs-idmap
  r.get('/nfs-idmap', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, SNAPSHOT_KEY);
    if (!row) {
      throw new ApiException(
        'NOT_FOUND',
        'NfsIdmap snapshot not yet observed; agent may not be running',
      );
    }
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
