import { describe, expect, it } from 'vitest';
import { ROLLBACK_MODELS } from '../../../api/plan/engine.js';
import { configRollbackProvider } from '../../../api/plan/providers/config-rollback.js';
import { poolCreateProvider } from '../../../api/plan/providers/pool.js';
import { supportBundleProvider } from '../../../api/plan/providers/support.js';

// S15 V-53 — spot-check that pool/support/config-rollback (the providers
// that carried the off-contract 'executor_managed' literal, plus pool's
// 'reversible') now emit values ROLLBACK_MODELS recognizes. nfs.ts (which
// carried 'reversible') is covered by providers-nfs.test.ts's own five
// assertions; this file exists so the vocabulary itself — not just five
// hand-picked nfs cases — has a regression test across the other three
// providers, including both config-rollback branches.

type Row = { key: string; value: unknown; revision: number };

// Mirrors the fake KvStore harness pool-providers.test.ts and
// config-rollback.test.ts already use for these exact providers.
const ctxWith = (rows: Row[] = []) =>
  ({
    kv: {
      list: (opts?: { prefix?: string }) =>
        rows
          .filter((r) => opts?.prefix === undefined || r.key.startsWith(opts.prefix))
          .map((r) => ({ key: r.key, value: r.value, revision: r.revision })),
      get: (key: string) => {
        const hit = rows.find((r) => r.key === key);
        return hit === undefined
          ? null
          : { key: hit.key, value: hit.value, revision: hit.revision };
      },
    },
  }) as never;

// pool-providers.test.ts's DISK fixture (a safe, non-array-volume drive).
const DISK = (path: string): Row => ({
  key: `/xinas/v1/observed/Disk/${path.replaceAll('/', '_')}`,
  value: { kind: 'Disk', status: { device_path: path, safe_for_use: true } },
  revision: 1,
});

// config-rollback.test.ts's baseline-branch fixture.
const BASELINE_ROW = {
  kind: 'ConfigSnapshot',
  id: 'base-1',
  status: {
    snapshot_id: 'base-1',
    kind: 'baseline',
    created_at: '2026-01-01T00:00:00Z',
    history_type: 'baseline',
  },
};

// config-rollback.test.ts's targeted-restore-branch fixture.
const RESTORABLE_ROW = {
  kind: 'ConfigSnapshot',
  id: 'snap-9',
  status: {
    snapshot_id: 'snap-9',
    kind: 'after',
    history_type: 'rollback_eligible',
    restorable: true,
    files_changed: ['etc_exports'],
  },
};

describe('S15 V-53: providers emit only api-v1.yaml Plan.rollback_model values', () => {
  it('pool.create', async () => {
    const result = await poolCreateProvider.preflight(ctxWith([DISK('/dev/a')]), {
      name: 'spare1',
      drives: ['/dev/a'],
    });
    expect(ROLLBACK_MODELS.has(result.rollback_model)).toBe(true);
  });

  it('support.bundle', async () => {
    const result = await supportBundleProvider.preflight(ctxWith(), {
      bundle_dir: '/tmp/bundle',
    });
    expect(ROLLBACK_MODELS.has(result.rollback_model)).toBe(true);
  });

  it('config.rollback — reset-to-baseline branch', async () => {
    const result = await configRollbackProvider.preflight(
      ctxWith([
        { key: '/xinas/v1/observed/ConfigSnapshot/base-1', value: BASELINE_ROW, revision: 4 },
      ]),
      { to: 'baseline', reason: 'lab reset' },
    );
    expect(ROLLBACK_MODELS.has(result.rollback_model)).toBe(true);
  });

  it('config.rollback — targeted restore branch', async () => {
    const result = await configRollbackProvider.preflight(
      ctxWith([
        { key: '/xinas/v1/observed/ConfigSnapshot/snap-9', value: RESTORABLE_ROW, revision: 7 },
      ]),
      { to: 'snap-9', reason: 'undo exports' },
    );
    expect(ROLLBACK_MODELS.has(result.rollback_model)).toBe(true);
  });
});
