/**
 * Real XiraidArray collector (S3 T6) — replaces XiraidArrayStubCollector.
 *
 * Poll-only: xiRAID has no event stream, so the PollDriver re-runs
 * initialSweep() every pollIntervalMs and flushes with complete-snapshot
 * semantics (vanished arrays are reconciled api-side; no delete tracking
 * needed here).
 *
 * Member device paths map back to control-path Disk ids via the SAME disk
 * probe instance the DiskCollector uses, so member_disk_ids share one
 * identity scheme.
 *
 * Daemon unavailable → health 'error: XIRAID_DAEMON_UNAVAILABLE…' and the
 * sweep rethrows (the node honestly reads degraded; the systemd-collector
 * precedent). Never fabricated or stale-as-fresh data.
 */

import { parseRaidShow } from '../../lib/parse/raid.js';
import type { XiraidClient } from '../xiraid/client.js';
import type { Collector, ObservationDelta } from './base.js';

interface DiskForMapping {
  id: string;
  status: { device_path?: string };
}

export interface XiraidArrayCollectorOptions {
  client: XiraidClient;
  /** The disk probe's snapshot — shared with DiskCollector for path→id mapping. */
  diskSnapshot: () => Promise<DiskForMapping[]>;
  now?: () => string;
  /** Poll cadence override (default 30 s; e2e shortens it via env). */
  pollIntervalMs?: number;
}

export class XiraidArrayCollector implements Collector<'XiraidArray'> {
  readonly kind = 'XiraidArray' as const;
  readonly pollIntervalMs: number;

  readonly #client: XiraidClient;
  readonly #diskSnapshot: () => Promise<DiskForMapping[]>;
  readonly #now: () => string;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };

  constructor({ client, diskSnapshot, now, pollIntervalMs }: XiraidArrayCollectorOptions) {
    this.#client = client;
    this.#diskSnapshot = diskSnapshot;
    this.#now = now ?? ((): string => new Date().toISOString());
    this.pollIntervalMs = pollIntervalMs ?? 30_000;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const [payload, pools, disks] = await Promise.all([
        this.#client.raidShow(),
        // S4 T5: pool membership joins the array's sparepool name to its
        // member drives so spec.spare_disk_ids is real in observed state.
        this.#client.poolShow(),
        this.#diskSnapshot(),
      ]);
      const diskIdByPath = new Map<string, string>();
      for (const d of disks) {
        if (d.status.device_path !== undefined) diskIdByPath.set(d.status.device_path, d.id);
      }
      const observedAt = this.#now();
      const deltas = parseRaidShow(payload, diskIdByPath, pools).map<ObservationDelta>((a) => ({
        kind: 'XiraidArray',
        id: a.id,
        op: 'upsert',
        value: {
          kind: a.kind,
          id: a.id,
          spec: a.spec,
          status: { ...a.status, observed_at: observedAt },
        },
      }));
      this.#health = { state: 'running' };
      return deltas;
    } catch (err) {
      this.#health = {
        state: 'error',
        reason: `XIRAID_DAEMON_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
      };
      throw err;
    }
  }

  // Poll-only collector: no event stream to subscribe or tear down.
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this.#health;
  }
}
