import { randomUUID } from 'node:crypto';
import { sharePlacementKey } from '../lib/nfs-placement.js';
import type { OpenedStateStore } from '../state/index.js';

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** Origin tag on every bootstrap write (mirrors seed-shares.ts). */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

/**
 * S20 (API-04, XMOD-14, audit F-08): every desired Share has a placement
 * marker row (`/xinas/v1/desired/SharePlacement/<id>`) carrying a UUID
 * minted when the share was created and never changed by an update, so a
 * delete-and-recreate of the same path and fsid is a NEW incarnation to the
 * placement connector.
 *
 * The create provider mints one; this backfill covers shares that predate
 * it (seeded or created on an older release). It runs on every boot in the
 * bootstrap window (api is the sole writer, plain put is safe) and writes
 * only MISSING marker rows — never the Share row itself, whose revision
 * plans and pending confirmations pin — so a healthy store sees no churn.
 */
export function backfillPlacementIncarnation(state: OpenedStateStore): number {
  let written = 0;
  const rows = state.kv.list<{ id?: unknown }>({ prefix: DESIRED_SHARE_PREFIX });
  for (const row of rows) {
    const id =
      typeof row.value?.id === 'string' && row.value.id.length > 0
        ? row.value.id
        : row.key.slice(DESIRED_SHARE_PREFIX.length);
    if (id.length === 0) continue;
    if (state.kv.get(sharePlacementKey(id)) !== null) continue;
    state.kv.put(
      sharePlacementKey(id),
      { share_id: id, placement_incarnation: randomUUID() },
      PUT_SOURCE,
    );
    written++;
  }
  return written;
}
