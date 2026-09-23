/**
 * S20 (API-04, XMOD-14, audit F-08): the durable placement incarnation of a
 * desired Share — a UUID minted when the share is created and never changed
 * by an update, so a delete-and-recreate of the same path and fsid is a
 * NEW incarnation to the placement connector.
 *
 * It lives in its own desired row, `/xinas/v1/desired/SharePlacement/<id>`
 * (the fsid-marker pattern, lib/nfs-fsid.ts), NOT inside the Share's spec:
 * the boot-time backfill for pre-existing shares must not bump Share
 * revisions, because plans and pending MCP confirmations pin those
 * revisions and would fail PRECONDITION_FAILED after an upgrade restart.
 */

import type { KvTransaction, OpenedStateStore } from '../state/index.js';

export const SHARE_PLACEMENT_PREFIX = '/xinas/v1/desired/SharePlacement/';

export function sharePlacementKey(shareId: string): string {
  return `${SHARE_PLACEMENT_PREFIX}${shareId}`;
}

export interface SharePlacementMarker {
  share_id: string;
  placement_incarnation: string;
}

/** The marker's incarnation, or undefined when the row is absent/malformed. */
export function readPlacementIncarnation(
  kv: Pick<OpenedStateStore['kv'], 'get'> | Pick<KvTransaction, 'get'>,
  shareId: string,
): string | undefined {
  const row = kv.get<Partial<SharePlacementMarker>>(sharePlacementKey(shareId));
  const v = row?.value?.placement_incarnation;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
