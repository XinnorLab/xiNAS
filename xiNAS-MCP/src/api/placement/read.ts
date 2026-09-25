/**
 * S20 §5.2–§5.4: read-time projection of the stored PlacementObservations
 * row into the schema-v1 result — evidence ages from the api's receipt
 * clock, reconciliation with the desired Share rows, and the 503
 * conditions. Pure: the route supplies the row, the receipt, the desired
 * shares and the clock.
 */

import { encExportId } from '../../lib/nfs-export-id.js';
import { ApiException } from '../errors.js';
import type { Receipt } from './receipts.js';

export const PLACEMENT_ROW_KEY = '/xinas/v1/observed/PlacementObservations/default';
export const PLACEMENT_MAX_SHARES = 256;
export const PLACEMENT_MAX_BYTES = 16 * 1024 * 1024;
/** Staleness slack on top of two collection periods (spec §5.4). */
export const PLACEMENT_STALE_SLACK_MS = 2_000;

type CollectionStatus = 'SUCCESS' | 'ERROR' | 'UNKNOWN';

interface StoredRecord {
  collection_status: CollectionStatus;
  observed_at: string | null;
  observed_mono_ms: number | null;
  reason_codes: string[];
}

export interface StoredResource extends StoredRecord {
  id: string;
  incarnation: string;
  details: Record<string, unknown> & { kind: string };
}

export interface StoredShare extends StoredRecord {
  share_id: string;
  incarnation: string;
  export_path: string;
  filesystem_ref: string | null;
  export_ref: string | null;
  service_ref: string | null;
  nested_mountpoints?: string[];
}

interface SourceSummary {
  status: 'ok' | 'failed' | 'timeout';
  observed_at?: string;
  mono_ms?: number;
}

/** The agent's row `status` (collectors/placement PlacementRowStatus), read structurally. */
export interface StoredPlacementStatus {
  schema_version: string;
  controller_id: string;
  server_epoch: string;
  source_generation: number;
  generated_at: string;
  snapshot_status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  collection_period_ms: number;
  capabilities: string[];
  coverage: unknown[];
  shares: StoredShare[];
  resources: StoredResource[];
  sources: Record<string, SourceSummary>;
  published_mono_ms: number;
  collector?: Record<string, unknown>;
  observed_at?: string;
}

export interface DesiredShare {
  id: string;
  path: string;
  fsid?: number | string;
  /** The durable creation id (F-08); absent on rows older than the backfill. */
  placement_incarnation?: string;
  /** KV `modified_at` (epoch ms) of the desired row (F-13). */
  modified_at?: number;
}

export interface ReadClock {
  /** Same monotonic clock the receipts use. */
  now_mono_ms: number;
  receipt: Receipt;
}

type OutRecord<T extends StoredRecord> = Omit<T, 'observed_mono_ms'> & {
  evidence_age_ms: number | null;
};

export interface PlacementResult {
  schema_version: string;
  controller_id: string;
  server_epoch: string;
  source_generation: number;
  generated_at: string;
  snapshot_status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  collection_period_ms: number;
  capabilities: string[];
  coverage: unknown[];
  shares: OutRecord<StoredShare>[];
  resources: OutRecord<StoredResource>[];
  sources: Record<string, { status: 'ok' | 'failed' | 'timeout' }>;
  collector?: Record<string, unknown>;
  /** How old the row was when this api received it (diagnostic, additive). */
  transfer_delay_ms: number;
}

/**
 * Age of one record's evidence: the time since THIS api stored the push,
 * plus the transfer delay the ingest measured (the row's `generated_at` to
 * receipt), plus the agent-reported gap between the evidence and the row's
 * publication. Every term counts against freshness (CON-10): a slow
 * transfer, a retried push or a slow cycle can only make evidence older.
 */
export function evidenceAgeMs(
  clock: ReadClock,
  publishedMonoMs: number,
  observedMonoMs: number | null,
): number | null {
  if (observedMonoMs === null) return null;
  const sinceReceipt = clock.now_mono_ms - clock.receipt.received_mono_ms;
  const delay = clock.receipt.transfer_delay_ms ?? 0;
  const intraCycle = publishedMonoMs - observedMonoMs;
  return Math.max(0, Math.round(sinceReceipt + delay + Math.max(0, intraCycle)));
}

/** Age of the whole row: time since receipt plus the measured transfer delay. */
export function rowAgeMs(receipt: Receipt, nowMono: number): number {
  return Math.max(
    0,
    Math.round(nowMono - receipt.received_mono_ms + (receipt.transfer_delay_ms ?? 0)),
  );
}

/** The 503 conditions of spec §5.4, in evaluation order. */
export function assertServable(
  row: { revision: number } | null,
  receipt: Receipt | undefined,
  nowMono: number,
  status: StoredPlacementStatus | null,
): asserts row is { revision: number } {
  if (row === null || receipt === undefined || receipt.revision !== row.revision) {
    throw new ApiException(
      'SOURCE_NOT_READY',
      'placement observations are not available: no agent push has been received by this api process yet',
      { row_present: row !== null },
    );
  }
  if (receipt.transfer_delay_ms === null) {
    throw new ApiException(
      'SOURCE_NOT_READY',
      'placement observations are not available: the stored row carries no parsable generated_at',
      { row_present: true, reason: 'generated_at_unparsable' },
    );
  }
  const ageMs = rowAgeMs(receipt, nowMono);
  const period = status?.collection_period_ms ?? 5_000;
  const limit = 2 * period + PLACEMENT_STALE_SLACK_MS;
  if (ageMs > limit) {
    throw new ApiException(
      'SOURCE_STALE',
      'placement observations are stale: the agent has stopped publishing',
      {
        age_ms: ageMs,
        limit_ms: limit,
        collection_period_ms: period,
        transfer_delay_ms: receipt.transfer_delay_ms,
      },
    );
  }
  // API-20: a global FAILED snapshot is a source failure, not an answer —
  // 503 with the typed code (the connector blocks every bound DS).
  if (status?.snapshot_status === 'FAILED') {
    throw new ApiException(
      'SOURCE_FAILED',
      'placement observations: every source failed in the last cycle',
      {
        age_ms: ageMs,
        sources: Object.fromEntries(
          Object.entries(status.sources ?? {}).map(([k, v]) => [k, v.status]),
        ),
      },
    );
  }
}

function withAge<T extends StoredRecord>(
  rec: T,
  clock: ReadClock,
  publishedMonoMs: number,
): OutRecord<T> {
  const { observed_mono_ms, ...rest } = rec;
  return { ...rest, evidence_age_ms: evidenceAgeMs(clock, publishedMonoMs, observed_mono_ms) };
}

/** The desired Share's connector-facing incarnation (F-08). */
export function desiredIncarnation(d: DesiredShare): string {
  const base = `${d.id}:${d.fsid ?? 'none'}`;
  return d.placement_incarnation !== undefined ? `${base}:${d.placement_incarnation}` : base;
}

/**
 * Reconcile the agent's export-derived share list with the desired Share
 * rows (spec §5.3) and stamp evidence ages. Throws SNAPSHOT_TOO_LARGE
 * (API-03) instead of truncating.
 */
export function projectPlacement(
  status: StoredPlacementStatus,
  desired: readonly DesiredShare[],
  clock: ReadClock,
): PlacementResult {
  const published = status.published_mono_ms;
  const resources: OutRecord<StoredResource>[] = status.resources.map((r) =>
    withAge(r, clock, published),
  );
  const exportByPath = new Map<string, OutRecord<StoredResource>>();
  let nfsRef: string | null = null;
  for (const r of resources) {
    if (r.details.kind === 'EXPORT' && typeof r.details.export_path === 'string') {
      exportByPath.set(r.details.export_path, r);
    }
    if (r.details.kind === 'NFS_SERVICE') nfsRef = r.id;
  }
  const desiredByPath = new Map(desired.map((d) => [d.path, d]));
  // F-13: a desired row that changed at or after the evidence it would be
  // joined with (a share recreated, its path or fsid edited) cannot be
  // joined with that older evidence — refused until a newer cycle lands.
  // Ordered against the record's own observed_at, not the receipt: a push
  // observed before a recreate can be received after it. An evidence time
  // that cannot be parsed cannot be ordered, so it counts as a change.
  const changedSince = (d: DesiredShare, observedAt: string | null | undefined): boolean => {
    if (d.modified_at === undefined) return false;
    const t = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
    return Number.isNaN(t) || d.modified_at >= t;
  };

  const shares: OutRecord<StoredShare>[] = [];
  const observedPaths = new Set<string>();
  for (const s of status.shares) {
    observedPaths.add(s.export_path);
    const out = withAge(s, clock, published);
    const d = desiredByPath.get(s.export_path);
    if (d === undefined) {
      // An export xiNAS did not create; the connector may still bind it.
      shares.push({ ...out, reason_codes: [...out.reason_codes, 'SHARE_UNMANAGED'] });
    } else if (changedSince(d, s.observed_at)) {
      shares.push({
        ...out,
        share_id: d.id,
        incarnation: desiredIncarnation(d),
        collection_status: 'UNKNOWN',
        reason_codes: [...out.reason_codes, 'DESIRED_CHANGED_SINCE_OBSERVATION'],
      });
    } else {
      // The desired id is the connector-facing share id; the fsid the
      // exports role allocated plus the durable creation id are the
      // incarnation discriminators (§4.3, F-08).
      shares.push({ ...out, share_id: d.id, incarnation: desiredIncarnation(d) });
    }
  }

  const exportsSource = status.sources.exports;
  for (const d of desired) {
    if (observedPaths.has(d.path)) continue;
    const present = exportByPath.get(d.path);
    let exportRef: string | null = null;
    let reason: string;
    let observedAt: string | null = null;
    let age: number | null = null;
    const exportsRead = exportsSource?.status === 'ok' && exportsSource.mono_ms !== undefined;
    // The evidence this record would rest on; none (the exports source
    // failed) means nothing is joined, so the dependency reason stands.
    const evidenceAt =
      present !== undefined
        ? present.observed_at
        : exportsRead
          ? (exportsSource?.observed_at ?? null)
          : undefined;
    if (evidenceAt !== undefined && changedSince(d, evidenceAt)) {
      reason = 'DESIRED_CHANGED_SINCE_OBSERVATION';
    } else if (present !== undefined) {
      // Exported, but not on a managed filesystem (§4.4).
      exportRef = present.id;
      reason = 'FILESYSTEM_UNRESOLVED';
      observedAt = present.observed_at;
      age = present.evidence_age_ms;
    } else if (exportsSource?.status === 'ok' && exportsSource.mono_ms !== undefined) {
      // Proof of absence (XMOD-14): the effective export table was read and
      // had no line for this path — published as an EXPORT resource
      // present: false.
      let id: string;
      try {
        id = `export:${encExportId(d.path)}`;
      } catch {
        id = `export:invalid:${d.id}`;
      }
      const absent: OutRecord<StoredResource> = {
        id,
        incarnation: `${id}:absent`,
        collection_status: 'SUCCESS',
        observed_at: exportsSource.observed_at ?? null,
        evidence_age_ms: evidenceAgeMs(clock, published, exportsSource.mono_ms),
        reason_codes: [],
        details: {
          kind: 'EXPORT',
          export_path: d.path,
          present: false,
          source: 'etab',
          rules: [],
        },
      };
      resources.push(absent);
      exportRef = id;
      reason = 'EXPORT_ABSENT';
      observedAt = absent.observed_at;
      age = absent.evidence_age_ms;
    } else {
      reason =
        exportsSource?.status === 'timeout'
          ? 'COLLECTION_TIMEOUT'
          : 'DEPENDENCY_EXPORT_UNAVAILABLE';
    }
    shares.push({
      share_id: d.id,
      incarnation: desiredIncarnation(d),
      export_path: d.path,
      collection_status: 'UNKNOWN',
      observed_at: observedAt,
      evidence_age_ms: age,
      filesystem_ref: null,
      export_ref: exportRef,
      service_ref: nfsRef,
      reason_codes: [reason],
    });
  }

  const result: PlacementResult = {
    schema_version: status.schema_version,
    controller_id: status.controller_id,
    server_epoch: status.server_epoch,
    source_generation: status.source_generation,
    generated_at: status.generated_at,
    snapshot_status: status.snapshot_status,
    collection_period_ms: status.collection_period_ms,
    capabilities: status.capabilities,
    coverage: status.coverage,
    shares,
    resources,
    sources: Object.fromEntries(
      Object.entries(status.sources).map(([k, v]) => [k, { status: v.status }]),
    ),
    ...(status.collector !== undefined ? { collector: status.collector } : {}),
    transfer_delay_ms: clock.receipt.transfer_delay_ms ?? 0,
  };

  if (shares.length > PLACEMENT_MAX_SHARES) {
    throw new ApiException('SNAPSHOT_TOO_LARGE', 'placement snapshot exceeds the share limit', {
      shares: shares.length,
      max_shares: PLACEMENT_MAX_SHARES,
    });
  }
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > PLACEMENT_MAX_BYTES) {
    throw new ApiException('SNAPSHOT_TOO_LARGE', 'placement snapshot exceeds the size limit', {
      shares: shares.length,
      bytes,
      max_bytes: PLACEMENT_MAX_BYTES,
    });
  }
  return result;
}
