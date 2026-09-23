/**
 * S20 §5.2–§5.4 as pure functions: evidence ages (with the transfer
 * delay), servability, and the read-time reconciliation with desired
 * shares.
 */

import { describe, expect, it } from 'vitest';
import { encExportId } from '../../lib/nfs-export-id.js';
import { ApiException } from '../../api/errors.js';
import {
  PLACEMENT_MAX_SHARES,
  type StoredPlacementStatus,
  assertServable,
  desiredIncarnation,
  evidenceAgeMs,
  projectPlacement,
  rowAgeMs,
} from '../../api/placement/read.js';
import type { Receipt } from '../../api/placement/receipts.js';

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
        details: {
          kind: 'EXPORT',
          export_path: '/mnt/data/a',
          present: true,
          rules: [],
          source: 'etab',
        },
      },
      {
        id: `export:${encExportId('/srv/other')}`,
        incarnation: 'x',
        collection_status: 'SUCCESS',
        observed_at: AT,
        observed_mono_ms: 1_000,
        reason_codes: [],
        details: {
          kind: 'EXPORT',
          export_path: '/srv/other',
          present: true,
          rules: [],
          source: 'etab',
        },
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
      nfsd_threads: { status: 'ok', observed_at: AT, mono_ms: 1_100 },
    },
    published_mono_ms: 1_200,
    collector: { cycle_ms: 200, deadline_hit: false, skipped_ticks: 0 },
    ...over,
  };
}

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  revision: 3,
  received_mono_ms: 50_000,
  received_at_ms: 1_800_000_000_000,
  transfer_delay_ms: 0,
  ...over,
});
const clock = (nowMono: number, r: Partial<Receipt> = {}) => ({
  now_mono_ms: nowMono,
  receipt: receipt(r),
});

describe('evidenceAgeMs (F-02)', () => {
  it('adds the time since the api stored the push to the intra-cycle offset (CON-10)', () => {
    // Stored at api-mono 50_000, now 50_400 → 400 ms since receipt; the
    // record was observed 200 ms before the row was published → 600.
    expect(evidenceAgeMs(clock(50_400), 1_200, 1_000)).toBe(600);
    expect(evidenceAgeMs(clock(50_400), 1_200, 1_200)).toBe(400);
    expect(evidenceAgeMs(clock(50_400), 1_200, null)).toBeNull();
  });

  it('adds the measured transfer delay: a push that arrived late can only read older', () => {
    expect(evidenceAgeMs(clock(50_400, { transfer_delay_ms: 3_000 }), 1_200, 1_000)).toBe(3_600);
    expect(rowAgeMs(receipt({ transfer_delay_ms: 3_000 }), 50_400)).toBe(3_400);
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
  const code = (fn: () => void): string => {
    try {
      fn();
    } catch (e) {
      return (e as ApiException).code;
    }
    throw new Error('expected an ApiException');
  };

  it('no row → SOURCE_NOT_READY', () => {
    expect(code(() => assertServable(null, undefined, 1, null))).toBe('SOURCE_NOT_READY');
  });

  it('a row without a receipt (api restarted since the push) → SOURCE_NOT_READY', () => {
    expect(() => assertServable(row, undefined, 1, stored())).toThrow(/no agent push/);
  });

  it('a receipt for another revision → SOURCE_NOT_READY', () => {
    expect(() => assertServable(row, receipt({ revision: 2 }), 1, stored())).toThrow(
      /no agent push/,
    );
  });

  it('a receipt without a parsable generated_at → SOURCE_NOT_READY', () => {
    expect(
      code(() => assertServable(row, receipt({ transfer_delay_ms: null }), 50_001, stored())),
    ).toBe('SOURCE_NOT_READY');
  });

  it('older than 2 × period + 2 s → SOURCE_STALE with the age; the transfer delay counts', () => {
    const r = receipt({ received_mono_ms: 0 });
    expect(() => assertServable(row, r, 12_000, stored())).not.toThrow();
    try {
      assertServable(row, r, 12_001, stored());
      throw new Error('expected SOURCE_STALE');
    } catch (e) {
      expect((e as ApiException).code).toBe('SOURCE_STALE');
      expect((e as ApiException).details).toEqual({
        age_ms: 12_001,
        limit_ms: 12_000,
        collection_period_ms: 5_000,
        transfer_delay_ms: 0,
      });
    }
    // F-02: a push delivered 11 s late is stale after 1 s on the api clock.
    const late = receipt({ received_mono_ms: 0, transfer_delay_ms: 11_000 });
    expect(() => assertServable(row, late, 1_000, stored())).not.toThrow();
    expect(code(() => assertServable(row, late, 1_001, stored()))).toBe('SOURCE_STALE');
  });

  it('F-10: a FAILED snapshot is a 503 SOURCE_FAILED, not an answer', () => {
    const failed = stored({
      snapshot_status: 'FAILED',
      sources: { arrays: { status: 'failed' }, filesystems: { status: 'timeout' } },
    });
    try {
      assertServable(row, receipt(), 50_100, failed);
      throw new Error('expected SOURCE_FAILED');
    } catch (e) {
      expect((e as ApiException).code).toBe('SOURCE_FAILED');
      expect((e as ApiException).details).toMatchObject({
        sources: { arrays: 'failed', filesystems: 'timeout' },
      });
    }
  });
});

describe('desiredIncarnation (F-08)', () => {
  it('is id:fsid:creation-uuid when the row carries one, id:fsid before the backfill', () => {
    expect(desiredIncarnation({ id: 'a', path: '/x', fsid: 3, placement_incarnation: 'u-1' })).toBe(
      'a:3:u-1',
    );
    expect(desiredIncarnation({ id: 'a', path: '/x', fsid: 3 })).toBe('a:3');
    expect(desiredIncarnation({ id: 'a', path: '/x' })).toBe('a:none');
  });
});

describe('projectPlacement', () => {
  const sid = encExportId('/mnt/data/a');

  it('stamps evidence ages, drops the mono stamps, keeps the revision-free fields, reports the delay', () => {
    const r = projectPlacement(
      stored(),
      [{ id: sid, path: '/mnt/data/a', fsid: 1 }],
      clock(50_400),
    );
    expect(r.source_generation).toBe(7);
    expect(r.transfer_delay_ms).toBe(0);
    expect(r.shares[0]).toMatchObject({ share_id: sid, evidence_age_ms: 600, reason_codes: [] });
    expect(r.shares[0]).not.toHaveProperty('observed_mono_ms');
    expect(r.resources.find((x) => x.id === 'nfs:nfs-server')?.evidence_age_ms).toBe(500);
    expect(r.sources).toEqual({
      arrays: { status: 'ok' },
      filesystems: { status: 'ok' },
      exports: { status: 'ok' },
      nfs_service: { status: 'ok' },
      nfsd_versions: { status: 'ok' },
      nfsd_threads: { status: 'ok' },
    });
  });

  it('desired + observed: the desired id, fsid and creation uuid are the share identity', () => {
    const r = projectPlacement(
      stored(),
      [{ id: 'share-a', path: '/mnt/data/a', fsid: 42, placement_incarnation: 'c0ffee' }],
      clock(50_400),
    );
    expect(r.shares[0]).toMatchObject({ share_id: 'share-a', incarnation: 'share-a:42:c0ffee' });
  });

  it('F-08: a recreate with the same path and fsid is a different incarnation', () => {
    const before = projectPlacement(
      stored(),
      [{ id: 'share-a', path: '/mnt/data/a', fsid: 42, placement_incarnation: 'gen-1' }],
      clock(50_400),
    );
    const after = projectPlacement(
      stored(),
      [{ id: 'share-a', path: '/mnt/data/a', fsid: 42, placement_incarnation: 'gen-2' }],
      clock(50_400),
    );
    expect(before.shares[0]?.incarnation).not.toBe(after.shares[0]?.incarnation);
  });

  it('F-13: a desired row modified after the observation was received cannot be joined — UNKNOWN', () => {
    const received = 1_800_000_000_000;
    const r = projectPlacement(
      stored(),
      [
        {
          id: 'share-a',
          path: '/mnt/data/a',
          fsid: 42,
          placement_incarnation: 'new',
          modified_at: received + 1,
        },
      ],
      clock(50_400, { received_at_ms: received }),
    );
    expect(r.shares[0]).toMatchObject({
      share_id: 'share-a',
      collection_status: 'UNKNOWN',
      reason_codes: ['DESIRED_CHANGED_SINCE_OBSERVATION'],
    });
    // Modified before receipt: joined normally.
    const ok = projectPlacement(
      stored(),
      [{ id: 'share-a', path: '/mnt/data/a', fsid: 42, modified_at: received - 1 }],
      clock(50_400, { received_at_ms: received }),
    );
    expect(ok.shares[0]?.collection_status).toBe('SUCCESS');
    // A desired-only share changed since receipt: UNKNOWN for that reason, no proof of absence claimed.
    const only = projectPlacement(
      stored(),
      [{ id: 'share-b', path: '/mnt/data/b', modified_at: received + 5 }],
      clock(50_400, { received_at_ms: received }),
    );
    expect(only.shares.find((s) => s.share_id === 'share-b')?.reason_codes).toEqual([
      'DESIRED_CHANGED_SINCE_OBSERVATION',
    ]);
    expect(only.resources.some((x) => x.id === `export:${encExportId('/mnt/data/b')}`)).toBe(false);
  });

  it('observed, not desired → SHARE_UNMANAGED, status unchanged', () => {
    const r = projectPlacement(stored(), [], clock(50_400));
    expect(r.shares[0]).toMatchObject({
      collection_status: 'SUCCESS',
      reason_codes: ['SHARE_UNMANAGED'],
    });
  });

  it('desired, not exported → UNKNOWN / EXPORT_ABSENT with a present:false EXPORT resource (proof of absence from etab)', () => {
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
      details: {
        kind: 'EXPORT',
        export_path: '/mnt/data/b',
        present: false,
        rules: [],
        source: 'etab',
      },
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
