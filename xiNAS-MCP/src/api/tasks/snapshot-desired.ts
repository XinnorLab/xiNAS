import type { KvStore } from '../../state/store.js';

/** The desired kinds S12 captures + adopts (the kinds S11 restore renders to). */
export const ADOPT_KINDS = ['Share', 'ExportGroup', 'NfsProfile', 'NetworkInterface'] as const;
export type AdoptKind = (typeof ADOPT_KINDS)[number];

export const SNAPSHOT_DESIRED_PREFIX = '/xinas/v1/snapshot-desired/';
export const snapshotDesiredKey = (snapshotId: string): string =>
  `${SNAPSHOT_DESIRED_PREFIX}${snapshotId}`;

export interface CapturedRow {
  id: string;
  spec: unknown;
}
export interface SnapshotDesiredPayload {
  snapshot_id: string;
  kinds: Record<AdoptKind, CapturedRow[]>;
}

interface DesiredRowValue {
  id?: string;
  spec?: unknown;
}

/** Read the in-scope desired rows from KV and persist them as a single payload
 *  keyed by `snapshotId`. Synchronous; the caller guarantees timing. */
export function captureSnapshotDesired(kv: KvStore, snapshotId: string): void {
  const kinds = {} as Record<AdoptKind, CapturedRow[]>;
  for (const kind of ADOPT_KINDS) {
    const rows = kv.list<DesiredRowValue>({ prefix: `/xinas/v1/desired/${kind}/` });
    kinds[kind] = rows.map((r) => ({ id: r.value.id ?? '', spec: r.value.spec ?? {} }));
  }
  const payload: SnapshotDesiredPayload = { snapshot_id: snapshotId, kinds };
  kv.put(snapshotDesiredKey(snapshotId), payload);
}

export function readSnapshotDesired(
  kv: KvStore,
  snapshotId: string,
): SnapshotDesiredPayload | null {
  const row = kv.get<SnapshotDesiredPayload>(snapshotDesiredKey(snapshotId));
  return row !== null ? row.value : null;
}
