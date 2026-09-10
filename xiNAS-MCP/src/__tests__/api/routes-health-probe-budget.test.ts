import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, buildTestAppWithMockAgent } from './_helpers.js';

/**
 * S19b T5 — spec §9.5 (CFG-05, D-10): `probes_per_run` is counted in the
 * run ledger per `run_id` and enforced BEFORE the agent is asked; an
 * unknown run is accepted with a RUN_UNKNOWN warning (SAFE-04).
 */
describe('POST /api/v1/health/probe — probes_per_run budget (S19b)', () => {
  let setup: Awaited<ReturnType<typeof buildTestAppWithMockAgent>>;
  const TOOL = 'health.probe.run';
  const okOutcome = {
    ok: true,
    started_at: '2026-09-09T10:00:00.000Z',
    completed_at: '2026-09-09T10:00:01.000Z',
    artifact: { kind: 'file', path: '/mnt/data/.xinas-health/probe-none-abcd' },
    cleanup: { status: 'clean' },
  };

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/Filesystem/fs-data', {
      kind: 'Filesystem',
      id: 'fs-data',
      status: { mountpoint: '/mnt/data', mounted: true },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const post = (body: Record<string, unknown>) =>
    request(setup.app).post('/api/v1/health/probe').set('Authorization', OPERATOR_TOKEN).send(body);

  it('the fifth probe of a run is PRECONDITION_FAILED probe_budget_exhausted and never reaches the agent', async () => {
    let calls = 0;
    setup.mockAgent.respondToRpc(TOOL, () => {
      calls += 1;
      return { result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome } };
    });
    const ctxRes = await request(setup.app)
      .get('/api/v1/health/context')
      .set('Authorization', OPERATOR_TOKEN);
    const runId = ctxRes.body.result.run.run_id as string;
    expect(ctxRes.body.result.run.limits.probes_per_run).toBe(4);

    for (let i = 0; i < 4; i += 1) {
      const res = await post({ probe: 'fs_io', target: 'fs-data', run_id: runId });
      expect(res.status, `probe ${i + 1}`).toBe(200);
      expect(res.body.result.run_id).toBe(runId);
      expect(res.body.warnings).toEqual([]);
    }
    const fifth = await post({ probe: 'fs_io', target: 'fs-data', run_id: runId });
    expect(fifth.status).toBe(412);
    expect(fifth.body.errors[0]).toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { reason: 'probe_budget_exhausted', run_id: runId, probes_per_run: 4 },
    });
    expect(calls).toBe(4);

    const entry = setup.ctx.healthPrompt?.ledger.get(runId);
    expect(entry?.probes_started).toBe(4);
    expect(entry?.reports.map((r) => r.tool)).toEqual(Array(4).fill(TOOL));
  });

  it('an unknown run_id is accepted with a RUN_UNKNOWN warning', async () => {
    setup.mockAgent.respondToRpc(TOOL, () => ({
      result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome },
    }));
    // A UUID that health.context never minted (e.g. from before an api
    // restart) — still the right *shape*, just unknown to this ledger.
    const runId = randomUUID();
    const res = await post({ probe: 'fs_io', target: 'fs-data', run_id: runId });
    expect(res.status).toBe(200);
    expect(res.body.result.run_id).toBe(runId);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({ code: 'RUN_UNKNOWN', details: { run_id: runId } }),
    ]);
  });
});
