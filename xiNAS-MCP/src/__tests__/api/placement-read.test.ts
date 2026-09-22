/**
 * S20 §5.2–§5.4 as pure functions: evidence ages, servability, and the
 * read-time reconciliation with desired shares.
 */

import { describe, expect, it } from 'vitest';
import { encExportId } from '../../lib/nfs-export-id.js';
import { ApiException } from '../../api/errors.js';
import {
  PLACEMENT_MAX_SHARES,
  type StoredPlacementStatus,
  assertServable,
  evidenceAgeMs,
  projectPlacement,
} from '../../api/placement/read.js';

const AT = '2026-09-22T12:00:00.000Z';

function stored(over: Partial<StoredPlacementStatus> = {}): StoredPlacementStatus {
  const sid = encExportId('/mnt/data/a');
  return {
    schema_version: '1.0',
    controller_id: 'ctl-1',
    server_epoch: 'ctl-1:boot:1',
    source_generation: 7,
    generated_at: AT,
    snapshot_status: 'COMPLETE',
    collection_period_ms: 5_000,
    capabilities: ['identity'],
    coverage: [],
    shares: [
      {
        share_id: sid,
        incarnation: `${sid}:1`,
        export_path: '/mnt/data/a',
        collection_status: 'SUCCESS',
        observed_at: AT,
        observed_mono_ms: 1_000,
        filesystem_ref: 'fs:mnt-data.mount',
        export_ref: `export:${sid}`,
        service_ref: 'nfs:nfs-server',
        reason_codes: [],
      },
    ],
    resources: [
      {
        id: `export:${sid}`,
        incarnation: `export:${sid}:1`,
        collection_status: 'SUCCESS',
        observed_at: AT,
        observed_mono_ms: 1_000,
        reason_codes: [],
        details: { kind: 'EXPORT', export_path: '/mnt/data/a', present: true, rules: [] },
      },
      {
        id: `export:${encExportId('/srv/other')}`,
        incarnation: 'x',
        collection_status: 'SUCCESS',
        observed_at: AT,
        observed_mono_ms: 1_000,
        reason_codes: [],
        details: { kind: 'EXPORT', export_path: '/srv/other', present: true, rules: [] },
      },
      {
        id: 'nfs:nfs-server',
        incarnation: 'nfs:nfs-server:active',
        collection_status: 'SUCCESS',
        observed_at: AT,
        observed_mono_ms: 1_100,
        reason_codes: [],
        details: { kind: 'NFS_SERVICE', running: true, protocols: ['NFSv3'], reason_codes: [] },
      },
    ],
    sources: {
      arrays: { status: 'ok', observed_at: AT, mono_ms: 1_000 },
      filesystems: { status: 'ok', observed_at: AT, mono_ms: 1_000 },
      exports: { status: 'ok', observed_at: AT, mono_ms: 1_000 },
      nfs_service: { status: 'ok', observed_at: AT, mono_ms: 1_100 },
      nfsd_versions: { status: 'ok', observed_at: AT, mono_ms: 1_100 },
    },
    published_mono_ms: 1_200,
    collector: { cycle_ms: 200, deadline_hit: false, skipped_ticks: 0 },
    ...over,
  };
}

const clock = (nowMono: number, receivedMono = 50_000, revision = 3) => ({
  now_mono_ms: nowMono,
  receipt: { revision, received_mono_ms: receivedMono },
});

describe('evidenceAgeMs', () => {
  it('adds the time since the api stored the push to the intra-cycle offset (CON-10)', () => {
    // Stored at api-mono 50_000, now 50_400 → 400 ms since receipt; the
    // record was observed 200 ms before the row was published → 600.
    expect(evidenceAgeMs(clock(50_400), 1_200, 1_000)).toBe(600);
    expect(evidenceAgeMs(clock(50_400), 1_200, 1_200)).toBe(400);
    expect(evidenceAgeMs(clock(50_400), 1_200, null)).toBeNull();
  });

  it('never goes negative and never lets a bad offset make evidence fresher', () => {
    expect(evidenceAgeMs(clock(50_000), 1_200, 1_000)).toBe(200);
    expect(evidenceAgeMs(clock(50_000), 1_000, 1_200)).toBe(0);
  });

  it('grows between two reads (API-14)', () => {
    const a = evidenceAgeMs(clock(50_100), 1_200, 1_000);
    const b = evidenceAgeMs(clock(52_100), 1_200, 1_000);
    expect(b).toBe((a as number) + 2_000);
  });
});

describe('assertServable', () => {
  const row = { revision: 3 };
  it('no row → SOURCE_NOT_READY', () => {
    expect(() => assertServable(null, undefined, 1, null)).toThrow(ApiException);
    try {
      assertServable(null, undefined, 1, null);
    } catch (e) {
      expect((e as ApiException).code).toBe('SOURCE_NOT_READY');
    }
  });

  it('a row without a receipt (api restarted since the push) → SOURCE_NOT_READY', () => {
    expect(() => assertServable(row, undefined, 1, stored())).toThrow(/no agent push/);
  });

  it('a receipt for another revision → SOURCE_NOT_READY', () => {
    expect(() => assertServable(row, { revision: 2, received_mono_ms: 0 }, 1, stored())).toThrow(
      /no agent push/,
    );
  });

  it('older than 2 × period + 2 s → SOURCE_STALE with the age', () => {
    const receipt = { revision: 3, received_mono_ms: 0 };
    expect(() => assertServable(row, receipt, 12_000, stored())).not.toThrow();
    try {
      assertServable(row, receipt, 12_001, stored());
      throw new Error('expected SOURCE_STALE');
    } catch (e) {
      expect((e as ApiException).code).toBe('SOURCE_STALE');
      expect((e as ApiException).details).toEqual({
        age_ms: 12_001,
        limit_ms: 12_000,
        collection_period_ms: 5_000,
      });
    }
  });
});

describe('projectPlacement', () => {
  const sid = encExportId('/mnt/data/a');

  it('stamps evidence ages, drops the mono stamps, keeps the revision-free fields', () => {
    const r = projectPlacement(
      stored(),
      [{ id: sid, path: '/mnt/data/a', fsid: 1 }],
      clock(50_400),
    );
    expect(r.source_generation).toBe(7);
    expect(r.shares[0]).toMatchObject({ share_id: sid, evidence_age_ms: 600, reason_codes: [] });
    expect(r.shares[0]).not.toHaveProperty('observed_mono_ms');
    expect(r.resources.find((x) => x.id === 'nfs:nfs-server')?.evidence_age_ms).toBe(500);
    expect(r.sources).toEqual({
      arrays: { status: 'ok' },
      filesystems: { status: 'ok' },
      exports: { status: 'ok' },
      nfs_service: { status: 'ok' },
      nfsd_versions: { status: 'ok' },
    });
  });

  it('desired + observed: the desired id and fsid are the share identity', () => {
    const r = projectPlacement(
      stored(),
      [{ id: 'share-a', path: '/mnt/data/a', fsid: 42 }],
      clock(50_400),
    );
    expect(r.shares[0]).toMatchObject({ share_id: 'share-a', incarnation: 'share-a:42' });
  });

  it('observed, not desired → SHARE_UNMANAGED, status unchanged', () => {
    const r = projectPlacement(stored(), [], clock(50_400));
    expect(r.shares[0]).toMatchObject({
      collection_status: 'SUCCESS',
      reason_codes: ['SHARE_UNMANAGED'],
    });
  });

  it('desired, not exported → UNKNOWN / EXPORT_ABSENT with a present:false EXPORT resource (proof of absence)', () => {
    const r = projectPlacement(
      stored(),
      [{ id: 'share-b', path: '/mnt/data/b', fsid: 9 }],
      clock(50_400),
    );
    const b = r.shares.find((s) => s.share_id === 'share-b');
    const absentId = `export:${encExportId('/mnt/data/b')}`;
    expect(b).toMatchObject({
      incarnation: 'share-b:9',
      collection_status: 'UNKNOWN',
      reason_codes: ['EXPORT_ABSENT'],
      filesystem_ref: null,
      export_ref: absentId,
      service_ref: 'nfs:nfs-server',
      observed_at: AT,
      evidence_age_ms: 600,
    });
    expect(r.resources.find((x) => x.id === absentId)).toMatchObject({
      collection_status: 'SUCCESS',
      evidence_age_ms: 600,
      details: { kind: 'EXPORT', export_path: '/mnt/data/b', present: false, rules: [] },
    });
  });

  it('desired, exported but not on a managed filesystem → FILESYSTEM_UNRESOLVED', () => {
    const r = projectPlacement(stored(), [{ id: 'other', path: '/srv/other' }], clock(50_400));
    expect(r.shares.find((s) => s.share_id === 'other')).toMatchObject({
      collection_status: 'UNKNOWN',
      reason_codes: ['FILESYSTEM_UNRESOLVED'],
      export_ref: `export:${encExportId('/srv/other')}`,
      incarnation: 'other:none',
    });
  });

  it('desired, exports read failed → DEPENDENCY_EXPORT_UNAVAILABLE (no proof of absence)', () => {
    const st = stored({
      shares: [],
      resources: [],
      snapshot_status: 'PARTIAL',
      sources: { ...stored().sources, exports: { status: 'failed' } },
    });
    const r = projectPlacement(st, [{ id: 'share-b', path: '/mnt/data/b' }], clock(50_400));
    expect(r.shares[0]).toMatchObject({
      collection_status: 'UNKNOWN',
      reason_codes: ['DEPENDENCY_EXPORT_UNAVAILABLE'],
      export_ref: null,
      service_ref: null,
      evidence_age_ms: null,
    });
    expect(r.resources).toEqual([]);
  });

  it('more than 256 shares → SNAPSHOT_TOO_LARGE, never truncated (API-03)', () => {
    const desired = Array.from({ length: PLACEMENT_MAX_SHARES }, (_, i) => ({
      id: `s${i}`,
      path: `/mnt/data/s${i}`,
    }));
    try {
      projectPlacement(stored(), desired, clock(50_400));
      throw new Error('expected SNAPSHOT_TOO_LARGE');
    } catch (e) {
      expect((e as ApiException).code).toBe('SNAPSHOT_TOO_LARGE');
      expect((e as ApiException).details).toEqual({
        shares: PLACEMENT_MAX_SHARES + 1,
        max_shares: PLACEMENT_MAX_SHARES,
      });
    }
  });
});
