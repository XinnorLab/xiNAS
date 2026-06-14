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

/**
 * GC orphan snapshot-desired payloads (ADR-0015, S12 T6).
 *
 * Deletes every `snapshot-desired/{id}` payload whose snapshot id has NO
 * matching `/xinas/v1/observed/ConfigSnapshot/{id}` row. This prevents
 * unbounded accumulation when the Python-side GC removes a config snapshot
 * from history and the agent's next complete-snapshot reconcile deletes the
 * corresponding `observed/ConfigSnapshot/{id}` row — at that point the
 * `snapshot-desired/{id}` payload is orphaned and must be pruned.
 *
 * The id match uses `row.value.id` on the observed ConfigSnapshot row, which
 * is authoritative (confirmed by config-rollback.ts: `r.value.id === spec.to`).
 *
 * Returns the snapshot ids that were pruned.
 */
export function gcSnapshotDesired(kv: KvStore): string[] {
  // Collect the set of snapshot ids that still have an observed ConfigSnapshot row.
  const observed = new Set(
    kv
      .list<{ id?: string }>({ prefix: '/xinas/v1/observed/ConfigSnapshot/' })
      .map((r) => r.value.id)
      .filter((id): id is string => id !== undefined),
  );

  const pruned: string[] = [];
  for (const row of kv.list<{ snapshot_id?: string }>({ prefix: SNAPSHOT_DESIRED_PREFIX })) {
    const snapshotId = row.value.snapshot_id;
    if (snapshotId === undefined || !observed.has(snapshotId)) {
      kv.delete(row.key);
      // Derive the id from the key suffix (the payload's snapshot_id may be
      // absent for malformed/legacy rows, so use the key suffix as the prune id).
      pruned.push(row.key.slice(SNAPSHOT_DESIRED_PREFIX.length));
    }
  }
  return pruned;
}
