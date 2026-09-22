/**
 * S20 §5.2–§5.4: read-time projection of the stored PlacementObservations
 * row into the schema-v1 result — evidence ages from the api's receipt
 * clock, reconciliation with the desired Share rows, and the three 503
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
}

/**
 * Age of one record's evidence: time since THIS api stored the push, plus
 * the agent-reported gap between the evidence and the row's publication.
 * Both terms count against freshness (CON-10): a slow transfer or a slow
 * cycle can only make evidence older, never fresher.
 */
export function evidenceAgeMs(
  clock: ReadClock,
  publishedMonoMs: number,
  observedMonoMs: number | null,
): number | null {
  if (observedMonoMs === null) return null;
  const sinceReceipt = clock.now_mono_ms - clock.receipt.received_mono_ms;
  const intraCycle = publishedMonoMs - observedMonoMs;
  return Math.max(0, Math.round(sinceReceipt + Math.max(0, intraCycle)));
}

/** The three 503 conditions of spec §5.4, in evaluation order. */
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
  const ageMs = Math.max(0, Math.round(nowMono - receipt.received_mono_ms));
  const period = status?.collection_period_ms ?? 5_000;
  const limit = 2 * period + PLACEMENT_STALE_SLACK_MS;
  if (ageMs > limit) {
    throw new ApiException(
      'SOURCE_STALE',
      'placement observations are stale: the agent has stopped publishing',
      { age_ms: ageMs, limit_ms: limit, collection_period_ms: period },
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

  const shares: OutRecord<StoredShare>[] = [];
  const observedPaths = new Set<string>();
  for (const s of status.shares) {
    observedPaths.add(s.export_path);
    const out = withAge(s, clock, published);
    const d = desiredByPath.get(s.export_path);
    if (d === undefined) {
      // An export xiNAS did not create; the connector may still bind it.
      shares.push({ ...out, reason_codes: [...out.reason_codes, 'SHARE_UNMANAGED'] });
    } else {
      // The desired id is the connector-facing share id; the fsid the
      // exports role allocated is the incarnation discriminator (§4.3).
      shares.push({ ...out, share_id: d.id, incarnation: `${d.id}:${d.fsid ?? 'none'}` });
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
    if (present !== undefined) {
      // Exported, but not on a managed filesystem (§4.4).
      exportRef = present.id;
      reason = 'FILESYSTEM_UNRESOLVED';
      observedAt = present.observed_at;
      age = present.evidence_age_ms;
    } else if (exportsSource?.status === 'ok' && exportsSource.mono_ms !== undefined) {
      // Proof of absence (XMOD-14): the exports read succeeded and had no
      // line for this path — published as an EXPORT resource present: false.
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
          source: '/etc/exports',
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
      incarnation: `${d.id}:${d.fsid ?? 'none'}`,
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
