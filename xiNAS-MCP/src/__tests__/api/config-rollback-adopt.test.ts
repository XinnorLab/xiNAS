import { describe, expect, it } from 'vitest';
import { configRollbackProvider } from '../../api/plan/providers/config-rollback.js';
import type { PlanContext } from '../../api/plan/engine.js';
import { snapshotDesiredKey } from '../../api/tasks/snapshot-desired.js';

/**
 * S12 T4 (ADR-0015): the `adopt` branch of the config.rollback provider.
 *
 * A prefix-aware in-memory KV fake — the adopt overlay reads BOTH the
 * captured payload (`get`) and the CURRENT desired rows per kind
 * (`list({prefix})`), so the fake must filter `list` by prefix (unlike the
 * S11 provider tests, whose path lists only the observed prefix).
 */
function ctxWith(rows: Record<string, { value: unknown; revision: number }>): PlanContext {
  return {
    kv: {
      list: ({ prefix }: { prefix?: string } = {}) =>
        Object.entries(rows)
          .filter(([k]) => (prefix === undefined ? true : k.startsWith(prefix)))
          .map(([, v]) => v),
      get: (k: string) => rows[k] ?? null,
    },
  } as unknown as PlanContext;
}

const SNAP = 'snap-1';

/** snap-1 restorable + a captured payload with only Share/expA; current desired
 *  has Share/expA (rev 3) + Share/expB (rev 4); network domain empty. */
function adoptableCtx(): PlanContext {
  return ctxWith({
    [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: {
      value: { id: SNAP, status: { restorable: true, files_changed: ['exports'] } },
      revision: 7,
    },
    '/xinas/v1/desired/Share/expA': {
      value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
      revision: 3,
    },
    '/xinas/v1/desired/Share/expB': {
      value: { kind: 'Share', id: 'expB', spec: { path: '/b' } },
      revision: 4,
    },
    '/xinas/v1/desired/NetworkInterface/eth0': {
      value: { kind: 'NetworkInterface', id: 'eth0', spec: { address: '10.0.0.1/24' } },
      revision: 9,
    },
    [snapshotDesiredKey(SNAP)]: {
      value: {
        snapshot_id: SNAP,
        kinds: {
          Share: [{ id: 'expA', spec: { path: '/a' } }],
          ExportGroup: [],
          NfsProfile: [],
          NetworkInterface: [],
        },
      },
      revision: 1,
    },
  });
}

describe('config.rollback adopt branch (S12 T4)', () => {
  it('per-domain: puts captured Share, deletes orphan Share, leaves untouched domains alone', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({
      key: '/xinas/v1/desired/Share/expA',
      value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
    });
    expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expB', delete: true }); // orphan
    // NetworkInterface domain absent in payload → that domain is untouched.
    expect(m.some((x) => x.key.includes('/NetworkInterface/'))).toBe(false);
    // P1 #1: the network domain is absent from the payload, so the live
    // NetworkInterface desired row must NOT be deleted and must NOT be pinned.
    expect(plan.affected_resources.some((r) => r.kind === 'NetworkInterface')).toBe(false);
    expect(m).not.toContainEqual(
      expect.objectContaining({ key: '/xinas/v1/desired/NetworkInterface/eth0' }),
    );
  });

  it('revision pins: existing put → current rev, orphan delete → current rev', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expA', revision: 3 });
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expB', revision: 4 });
  });

  it('revision pin: a captured row absent in current desired → revision 0 (create)', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: {
        value: { id: SNAP, status: { restorable: true, files_changed: ['exports'] } },
        revision: 7,
      },
      // current desired has NO Share rows at all.
      [snapshotDesiredKey(SNAP)]: {
        value: {
          snapshot_id: SNAP,
          kinds: {
            Share: [{ id: 'expNew', spec: { path: '/new' } }],
            ExportGroup: [],
            NfsProfile: [],
            NetworkInterface: [],
          },
        },
        revision: 1,
      },
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expNew', revision: 0 });
    expect(plan.desired_mutations).toContainEqual({
      key: '/xinas/v1/desired/Share/expNew',
      value: { kind: 'Share', id: 'expNew', spec: { path: '/new' } },
    });
  });

  it('blocks not_adoptable when no captured payload, emits no mutations', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: {
        value: { id: SNAP, status: { restorable: true } },
        revision: 7,
      },
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect(plan.blockers.map((b) => b.code)).toContain('not_adoptable');
    expect(plan.desired_mutations ?? []).toEqual([]);
  });

  it('INVALID_ARGUMENT for baseline + adopt', async () => {
    await expect(
      configRollbackProvider.preflight(adoptableCtx(), {
        to: 'baseline',
        reason: 'r',
        adopt: true,
      }),
    ).rejects.toThrow(/baseline/i);
  });

  it('adopt:false is the S11 plan (no desired_mutations) and sets enriched_spec.adopt=false', async () => {
    const plan = await configRollbackProvider.preflight(adoptableCtx(), { to: SNAP, reason: 'r' });
    expect(plan.desired_mutations ?? []).toEqual([]);
    expect(plan.risk_level).toBe('destructive');
    expect(plan.affected_resources).toEqual([{ kind: 'ConfigSnapshot', id: SNAP }]);
    expect((plan.enriched_spec as { adopt?: boolean }).adopt).toBe(false);
  });
});
