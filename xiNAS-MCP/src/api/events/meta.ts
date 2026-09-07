/**
 * Producer state that a previous-vs-current row compare cannot carry
 * (S17 §8.0): boot id, the restore-pending set, session candidates,
 * hysteresis levels, progress buckets, per-kind freshness. Backed by
 * `operational_event_meta` through the journal, so a write made inside the
 * observation transaction commits or rolls back with the events.
 */

import type { EventJournal } from './journal.js';

export const META_KEYS = {
  bootId: 'boot_id',
  restorePending: 'restore_pending',
  sessionCandidates: 'session_candidates',
  baselineDone: (kind: string): string => `baseline_done:${kind}`,
  collectorLastAccepted: (kind: string): string => `collector_last_accepted:${kind}`,
  collectorState: (kind: string): string => `collector_state:${kind}`,
  raidOp: (array: string, kind: string): string => `raid_op:${array}:${kind}`,
  raidCondition: (array: string): string => `raid_cond:${array}`,
  progress: (array: string, kind: string): string => `progress:${array}:${kind}`,
  unknownStateWarned: (array: string): string => `unknown_state_warned:${array}`,
  spareReplacementRecent: (pool: string): string => `spare_replacement_recent:${pool}`,
  poolExhausted: (pool: string): string => `pool_exhausted:${pool}`,
  capacity: (fsId: string): string => `capacity:${fsId}`,
  lockThreshold: (sessionId: string): string => `lock_threshold:${sessionId}`,
  backingUnavailable: (exportId: string): string => `backing_unavailable:${exportId}`,
  rdmaUnavailable: 'nfs_rdma_unavailable',
  agentState: 'agent_state',
  linkState: (iface: string): string => `link_state:${iface}`,
} as const;

export class MetaStore {
  readonly #journal: EventJournal;
  constructor(journal: EventJournal) {
    this.#journal = journal;
  }
  get<T = unknown>(key: string): T | null {
    return this.#journal.metaGet<T>(key);
  }
  set(key: string, value: unknown): void {
    this.#journal.metaSet(key, value);
  }
  delete(key: string): void {
    this.#journal.metaDelete(key);
  }
}
