/**
 * S20: GET /api/v1/placement/observations — the placement-observations
 * source for the pNFS placement connector
 * (docs/control-path/s20-placement-observations-spec.md §5).
 *
 * Read-only, viewer rank. The stored row is the agent's last 5 s cycle;
 * this route stamps evidence ages from the api's own receipt clock,
 * reconciles the share list with the desired Share rows and answers 503
 * (SOURCE_NOT_READY / SOURCE_STALE / SNAPSHOT_TOO_LARGE) instead of ever
 * serving an answer it cannot vouch for.
 */

import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { getOrNull, listByPrefix, sendOk } from '../handlers/reads.js';
import {
  type DesiredShare,
  PLACEMENT_ROW_KEY,
  type StoredPlacementStatus,
  assertServable,
  projectPlacement,
} from '../placement/read.js';

interface DesiredShareRow {
  id?: string;
  spec?: { path?: string; fsid?: number | string };
}

function desiredShares(ctx: ApiContext): DesiredShare[] {
  const out: DesiredShare[] = [];
  for (const row of listByPrefix<DesiredShareRow>(ctx.state, '/xinas/v1/desired/Share/')) {
    const path = row.value?.spec?.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    const id = row.value.id ?? row.key.slice(row.key.lastIndexOf('/') + 1);
    const fsid = row.value.spec?.fsid;
    out.push({ id, path, ...(fsid !== undefined ? { fsid } : {}) });
  }
  return out;
}

export function placementRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/placement/observations', (req, res, next) => {
    try {
      const row = getOrNull<{ status?: StoredPlacementStatus }>(ctx.state, PLACEMENT_ROW_KEY);
      const receipts = ctx.observed_receipts;
      const receipt = receipts?.lookup('PlacementObservations', 'default');
      const nowMono = receipts?.now() ?? performance.now();
      const status = row?.value?.status ?? null;
      assertServable(row, receipt, nowMono, status);
      if (status === null || receipt === undefined) {
        // assertServable proved row + receipt; a row without a status is a
        // malformed push and reads as not ready.
        assertServable(null, undefined, nowMono, null);
        return;
      }
      const result = projectPlacement(status, desiredShares(ctx), {
        now_mono_ms: nowMono,
        receipt,
      });
      sendOk(req, res, result, [row.revision]);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
