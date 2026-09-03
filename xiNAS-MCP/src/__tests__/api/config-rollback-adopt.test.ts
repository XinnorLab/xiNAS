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

/**
 * S13 T6 (ADR-0017): tombstone-delete path.
 *
 * When the snapshot's `status.absent_files` contains a domain's backing file
 * AND the payload has NO rows for that domain's PRIMARY kind, the adopt overlay
 * must delete current desired rows of the PRIMARY kind only. Secondary kinds
 * (ExportGroup, NfsProfile) are NEVER tombstone-deleted.
 */
function tombstoneCtx(absentFiles: string[]): PlanContext {
  return ctxWith({
    [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: {
      value: {
        id: SNAP,
        status: {
          restorable: true,
          files_changed: [],
          absent_files: absentFiles,
        },
      },
      revision: 7,
    },
    // Current desired rows: one Share, one ExportGroup (singleton), one NetworkInterface.
    '/xinas/v1/desired/Share/expA': {
      value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
      revision: 3,
    },
    '/xinas/v1/desired/ExportGroup/default': {
      value: { kind: 'ExportGroup', id: 'default', spec: {} },
      revision: 1,
    },
    '/xinas/v1/desired/NetworkInterface/eth0': {
      value: { kind: 'NetworkInterface', id: 'eth0', spec: { address: '10.0.0.1/24' } },
      revision: 9,
    },
    // Captured payload has NO Share rows (domain was removed) and NO NetworkInterface rows.
    [snapshotDesiredKey(SNAP)]: {
      value: {
        snapshot_id: SNAP,
        kinds: {
          Share: [],
          ExportGroup: [],
          NfsProfile: [],
          NetworkInterface: [],
        },
      },
      revision: 1,
    },
  });
}

describe('config.rollback adopt branch — S13 tombstone (ADR-0017)', () => {
  it('S13 tombstone: primary empty + etc_exports absent → deletes current Share ONLY', async () => {
    const plan = await configRollbackProvider.preflight(tombstoneCtx(['etc_exports']), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expA', delete: true });
    expect(m.some((x) => x.key.includes('/ExportGroup/'))).toBe(false); // singleton kept
    expect(m.some((x) => x.key.includes('/NetworkInterface/'))).toBe(false); // netplan NOT absent → untouched
    expect(plan.affected_resources).toContainEqual({ kind: 'Share', id: 'expA', revision: 3 });
    expect((plan.diff as { desired_deletes?: string[] }).desired_deletes).toContain(
      '/xinas/v1/desired/Share/expA',
    );
  });

  it('S13 tombstone: primary empty but file NOT in absent_files → skips (no deletes)', async () => {
    const plan = await configRollbackProvider.preflight(tombstoneCtx([]), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect((plan.desired_mutations ?? []).some((x) => x.key.includes('/Share/'))).toBe(false);
  });

  it('S13 tombstone: netplan absent → deletes NetworkInterface, leaves Share untouched', async () => {
    const plan = await configRollbackProvider.preflight(tombstoneCtx(['netplan']), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: '/xinas/v1/desired/NetworkInterface/eth0', delete: true });
    expect(plan.affected_resources).toContainEqual({
      kind: 'NetworkInterface',
      id: 'eth0',
      revision: 9,
    });
    // Share domain: etc_exports NOT absent → Share left untouched.
    expect(m.some((x) => x.key.includes('/Share/'))).toBe(false);
  });

  it('S13 tombstone: both files absent → deletes both Share and NetworkInterface, never ExportGroup', async () => {
    const plan = await configRollbackProvider.preflight(tombstoneCtx(['etc_exports', 'netplan']), {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: '/xinas/v1/desired/Share/expA', delete: true });
    expect(m).toContainEqual({ key: '/xinas/v1/desired/NetworkInterface/eth0', delete: true });
    expect(m.some((x) => x.key.includes('/ExportGroup/'))).toBe(false);
    expect(m.some((x) => x.key.includes('/NfsProfile/'))).toBe(false);
  });
});

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

/**
 * fsid marker reconciliation: adopting the Share domain must leave the
 * `ShareFsid/{n}` marker rows matching the adopted Share rows, or the next
 * share.create pins a stale marker and fails PRECONDITION_FAILED forever.
 */
describe('config.rollback adopt — ShareFsid marker reconciliation', () => {
  const MARKER = '/xinas/v1/desired/ShareFsid/';
  const snapRow = {
    value: { id: SNAP, status: { restorable: true, files_changed: ['exports'] } },
    revision: 7,
  };
  function payload(shares: { id: string; spec: unknown }[]) {
    return {
      value: {
        snapshot_id: SNAP,
        kinds: { Share: shares, ExportGroup: [], NfsProfile: [], NetworkInterface: [] },
      },
      revision: 1,
    };
  }

  it('deletes the marker of a pruned orphan share, keeps a correct marker untouched', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: snapRow,
      '/xinas/v1/desired/Share/expA': {
        value: { kind: 'Share', id: 'expA', spec: { path: '/a', fsid: 5 } },
        revision: 3,
      },
      '/xinas/v1/desired/Share/expB': {
        value: { kind: 'Share', id: 'expB', spec: { path: '/b', fsid: 7 } },
        revision: 4,
      },
      [`${MARKER}5`]: { value: { fsid: 5, share_id: 'expA' }, revision: 2 },
      [`${MARKER}7`]: { value: { fsid: 7, share_id: 'expB' }, revision: 3 },
      [snapshotDesiredKey(SNAP)]: payload([{ id: 'expA', spec: { path: '/a', fsid: 5 } }]),
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: `${MARKER}7`, delete: true });
    expect(plan.affected_resources).toContainEqual({ kind: 'ShareFsid', id: '7', revision: 3 });
    // Marker 5 already matches the adopted row → no churn, no pin.
    expect(m.some((x) => x.key === `${MARKER}5`)).toBe(false);
    expect(plan.affected_resources.some((r) => r.kind === 'ShareFsid' && r.id === '5')).toBe(false);
    expect((plan.diff as { desired_deletes?: string[] }).desired_deletes).toContain(`${MARKER}7`);
  });

  it('re-points markers when the captured fsid differs from the current one', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: snapRow,
      '/xinas/v1/desired/Share/expA': {
        value: { kind: 'Share', id: 'expA', spec: { path: '/a', fsid: 9 } },
        revision: 3,
      },
      [`${MARKER}9`]: { value: { fsid: 9, share_id: 'expA' }, revision: 6 },
      [snapshotDesiredKey(SNAP)]: payload([{ id: 'expA', spec: { path: '/a', fsid: 5 } }]),
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    const m = plan.desired_mutations ?? [];
    expect(m).toContainEqual({ key: `${MARKER}5`, value: { fsid: 5, share_id: 'expA' } });
    expect(plan.affected_resources).toContainEqual({ kind: 'ShareFsid', id: '5', revision: 0 });
    expect(m).toContainEqual({ key: `${MARKER}9`, delete: true });
    expect(plan.affected_resources).toContainEqual({ kind: 'ShareFsid', id: '9', revision: 6 });
  });

  it('rewrites a marker whose share_id no longer matches, pinned at its current revision', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: snapRow,
      [`${MARKER}5`]: { value: { fsid: 5, share_id: 'old' }, revision: 4 },
      [snapshotDesiredKey(SNAP)]: payload([{ id: 'expA', spec: { path: '/a', fsid: 5 } }]),
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect(plan.desired_mutations).toContainEqual({
      key: `${MARKER}5`,
      value: { fsid: 5, share_id: 'expA' },
    });
    expect(plan.affected_resources).toContainEqual({ kind: 'ShareFsid', id: '5', revision: 4 });
  });

  it('S13 tombstone: deleting every Share also deletes every marker', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: {
        value: {
          id: SNAP,
          status: { restorable: true, files_changed: [], absent_files: ['etc_exports'] },
        },
        revision: 7,
      },
      '/xinas/v1/desired/Share/expA': {
        value: { kind: 'Share', id: 'expA', spec: { path: '/a', fsid: 5 } },
        revision: 3,
      },
      [`${MARKER}5`]: { value: { fsid: 5, share_id: 'expA' }, revision: 2 },
      [snapshotDesiredKey(SNAP)]: payload([]),
    });
    const plan = await configRollbackProvider.preflight(ctx, {
      to: SNAP,
      reason: 'r',
      adopt: true,
    });
    expect(plan.desired_mutations).toContainEqual({ key: `${MARKER}5`, delete: true });
    expect(plan.affected_resources).toContainEqual({ kind: 'ShareFsid', id: '5', revision: 2 });
  });

  it('network-only adoption leaves markers alone', async () => {
    const ctx = ctxWith({
      [`/xinas/v1/observed/ConfigSnapshot/${SNAP}`]: snapRow,
      [`${MARKER}5`]: { value: { fsid: 5, share_id: 'gone' }, revision: 2 },
      [snapshotDesiredKey(SNAP)]: {
        value: {
          snapshot_id: SNAP,
          kinds: {
            Share: [],
            ExportGroup: [],
            NfsProfile: [],
            NetworkInterface: [{ id: 'eth0', spec: { address: '10.0.0.1/24' } }],
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
    expect((plan.desired_mutations ?? []).some((x) => x.key.startsWith(MARKER))).toBe(false);
  });
});
