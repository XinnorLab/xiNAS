import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configRollbackProvider } from '../../api/plan/providers/config-rollback.js';
import { makeConfigRollbackExecutor } from '../../agent/task/config-rollback-executor.js';
import { XinasHistoryBridge } from '../../agent/task/xinas-history-bridge.js';
import type { ExecutorContext } from '../../agent/task/types.js';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

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

describe('config.rollback provider (S9 T5)', () => {
  const ctxWith = (rows: Array<{ key: string; value: unknown; revision: number }>) =>
    ({
      kv: {
        list: () => rows.map((r) => ({ key: r.key, value: r.value, revision: r.revision })),
        get: () => null,
      },
    }) as never;

  it('baseline target with an observed baseline → clean destructive plan', async () => {
    const result = await configRollbackProvider.preflight(
      ctxWith([
        { key: '/xinas/v1/observed/ConfigSnapshot/base-1', value: BASELINE_ROW, revision: 4 },
      ]),
      { to: 'baseline', reason: 'lab reset' },
    );
    expect(result.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
    expect(result.risk_level).toBe('destructive');
    // review P0: display-only affected (no revision); the REAL pin is observed
    expect(result.affected_resources).toEqual([{ kind: 'ConfigSnapshot', id: 'base-1' }]);
    expect(result.observed_freshness_ref).toEqual({
      kind: 'ConfigSnapshot',
      id: 'base-1',
      revision: 4,
    });
    expect(result.lease_resources).toEqual([{ kind: 'ConfigHistory', id: 'default' }]);
    expect(result.enriched_spec).toMatchObject({ baseline_id: 'base-1', reason: 'lab reset' });
  });

  it('non-baseline target and absent baseline both block', async () => {
    const targeted = await configRollbackProvider.preflight(
      ctxWith([{ key: 'x', value: BASELINE_ROW, revision: 1 }]),
      { to: 'snap-9', reason: 'r' },
    );
    expect(targeted.blockers.map((b) => b.code)).toContain('targeted_rollback_not_implemented');

    const noBaseline = await configRollbackProvider.preflight(ctxWith([]), {
      to: 'baseline',
      reason: 'r',
    });
    expect(noBaseline.blockers.map((b) => b.code)).toContain('baseline_snapshot_absent');
    expect(noBaseline.observed_freshness_ref).toBeUndefined();
  });

  it('missing reason / to are 422s', async () => {
    await expect(configRollbackProvider.preflight(ctxWith([]), { to: 'baseline' })).rejects.toThrow(
      /reason/,
    );
    await expect(configRollbackProvider.preflight(ctxWith([]), { reason: 'r' })).rejects.toThrow(
      /spec.to/,
    );
  });
});

describe('config.rollback executor', () => {
  const ctxFor = (spec: unknown): ExecutorContext => ({
    spec,
    emitOutput: () => {},
    isCancelRequested: () => false,
    stash: {},
  });

  it('calls resetToBaseline; success=false throws; rollback is a no-op', async () => {
    const calls: string[][] = [];
    const bridge = new XinasHistoryBridge({
      runSubprocess: async (argv) => {
        calls.push(argv);
        return { stdout: JSON.stringify({ success: true }), code: 0 };
      },
    });
    const exec = makeConfigRollbackExecutor({ bridge });
    await exec.stages[0]?.run(ctxFor({ reason: 'lab reset', baseline_id: 'base-1' }));
    expect(calls[0]).toContain('reset-to-baseline');
    await expect(exec.rollback(ctxFor({ reason: 'r' }))).resolves.toBeUndefined();

    const failing = makeConfigRollbackExecutor({
      bridge: new XinasHistoryBridge({
        runSubprocess: async () => ({
          stdout: JSON.stringify({ success: false, error: 'validation failed' }),
          code: 0,
        }),
      }),
    });
    await expect(failing.stages[0]?.run(ctxFor({ reason: 'r' }))).rejects.toThrow(
      /reset-to-baseline failed/,
    );
  });
});

describe('POST /config-history/rollback route', () => {
  let setup: MockAgentSetup;
  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/ConfigSnapshot/base-1', BASELINE_ROW);
  });
  afterEach(async () => {
    await setup.teardown();
  });

  it('plan returns the destructive plan with the dangerous advisory blocker', async () => {
    const res = await request(setup.app)
      .post('/api/v1/config-history/rollback')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: { to: 'baseline', reason: 'test' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.risk_level).toBe('destructive');
    expect(res.body.result.plan_id).toBeTruthy();
    // the engine's advisory blocker for destructive ops
    expect(JSON.stringify(res.body.result.blockers)).toContain('dangerous');
  });

  it('bad mode → 400; missing reason → 400/422', async () => {
    const bad = await request(setup.app)
      .post('/api/v1/config-history/rollback')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'nope' });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const noReason = await request(setup.app)
      .post('/api/v1/config-history/rollback')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: { to: 'baseline' } });
    expect(noReason.status).toBeGreaterThanOrEqual(400);
  });
});
