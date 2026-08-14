import { collectUsedFsids, shareFsidKey } from '../lib/nfs-fsid.js';
import type { OpenedStateStore } from '../state/index.js';

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** Origin tag on every bootstrap write (mirrors seed-shares.ts). */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

/**
 * Ensure every desired Share's `fsid` has a marker row (design §7).
 *
 * Shares created before server-side allocation have no marker, so their numbers
 * look free to the create provider's absence pin. This runs on EVERY boot, not
 * once: that also self-heals a marker lost to a rolled-back task or a restored
 * snapshot. It writes only missing rows, so a healthy store sees no revision
 * churn.
 *
 * Runs in the bootstrap window alongside seedShares, before any listener binds,
 * so plain put() with no CAS is safe — the api is the sole writer.
 */
export function backfillShareFsidMarkers(state: OpenedStateStore): void {
  const rows = state.kv.list<{ id?: unknown; spec?: { fsid?: unknown } }>({
    prefix: DESIRED_SHARE_PREFIX,
  });
  for (const [fsid, shareId] of collectUsedFsids(rows)) {
    const key = shareFsidKey(fsid);
    if (state.kv.get(key) === null) {
      state.kv.put(key, { fsid, share_id: shareId }, PUT_SOURCE);
    }
  }
}
