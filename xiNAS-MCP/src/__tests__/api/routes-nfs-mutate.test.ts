import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NFS_PROFILE_SPEC } from '../../lib/nfs-profile.js';
import {
  ADMIN_TOKEN,
  type MockAgentSetup,
  buildTestAppWithMockAgent,
  seedShare,
} from './_helpers.js';

/**
 * N5.2 + N7.3 — the real NFS mutating routes (s3-nfs-executor-spec §7,
 * §3.1–3.5): POST /shares, PATCH/DELETE /shares/{id}, PATCH
 * /nfs-profiles/{id}, PATCH /nfs-idmap, all plan/apply over the N4 providers
 * + the N0 engine. Drives the full path against the mock-agent UDS
 * (buildTestAppWithMockAgent), like routes-reference.test.ts, and asserts the
 * N0 effects the reference route never exercised: desired-KV writes, Model-R
 * revert, the fsid CONFLICT, and expected_revision echo validation.
 */
describe('NFS mutating routes (N5)', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
  });
  afterEach(async () => {
    await setup.teardown();
  });

  /** Raw create spec WITHOUT an id — the server must assign one. */
  const CREATE_SPEC = {
    path: '/srv/nfs/projects',
    clients: [{ pattern: '10.0.0.0/8', options: ['rw'] }],
    fsid: 7,
  };

  function desiredShare(id: string) {
    return setup.state.kv.get<Record<string, unknown>>(`/xinas/v1/desired/Share/${id}`);
  }

  function count(sql: string, ...args: unknown[]): number {
    return (setup.state.db.prepare(sql).get(...args) as { n: number }).n;
  }

  async function post(path: string, body: Record<string, unknown>) {
    return request(setup.app)
      .post(path)
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function patch(path: string, body: Record<string, unknown>) {
    return request(setup.app)
      .patch(path)
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  async function del(path: string, body: Record<string, unknown>) {
    return request(setup.app)
      .delete(path)
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('share.create plan→apply: server-assigned id, 202 running, desired row + lease', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-create' });

    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    expect(typeof plan.plan_id).toBe('string');
    // No spec.id was sent → the route assigned one and echoes it in the envelope.
    expect(typeof plan.id).toBe('string');
    expect(plan.id.length).toBeGreaterThan(0);
    expect(plan.state_revision_expected).toBe(0); // absence pin: no desired row yet
    expect(plan.affected_resources[0]).toMatchObject({ kind: 'Share', id: plan.id, revision: 0 });
    expect(plan.blockers).toEqual([]);
    // The diff previews the compiled /etc/exports entry (lib/nfs-exports).
    expect(plan.diff.action).toBe('create');
    expect(plan.diff.export_entry).toEqual({
      path: '/srv/nfs/projects',
      clients: [{ host: '10.0.0.0/8', options: ['rw', 'async', 'no_subtree_check'] }],
    });

    const applyRes = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-create-1',
      expected_revision: 0,
    });
    expect(applyRes.status).toBe(202);
    const task = applyRes.body.result;
    expect(task.state).toBe('running');
    expect(task.kind).toBe('share.create');
    expect(task.agent_acceptance_id).toBe('acc-create');

    // The desired Share row EXISTS in KV (apply txn's desired_mutations write),
    // with the assigned id hoisted out of spec (the GET-route / seedShare shape).
    const row = desiredShare(plan.id);
    expect(row).not.toBeNull();
    expect(row?.value).toEqual({ kind: 'Share', id: plan.id, spec: CREATE_SPEC });

    // Lease held on Share/{id} by the running apply task.
    expect(
      count(
        'SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND resource_kind = ? AND resource_id = ?',
        task.task_id,
        'Share',
        plan.id,
      ),
    ).toBe(1);

    // The RAW spec — including the assigned id — reached the executor (T9b).
    expect(setup.mockAgent.lastTaskBeginParams()?.kind).toBe('share.create');
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual({ ...CREATE_SPEC, id: plan.id });
  });

  it('share.create plan with a duplicate fsid → 409 CONFLICT(fsid_in_use)', async () => {
    seedShare(setup.state, 'existing'); // seeds fsid 42
    const res = await post('/api/v1/shares', {
      mode: 'plan',
      spec: { path: '/srv/nfs/other', clients: [{ pattern: '*', options: ['ro'] }], fsid: 42 },
    });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].code).toBe('CONFLICT');
    expect(res.body.errors[0].details?.reason).toBe('fsid_in_use');
  });

  it('apply with a wrong expected_revision → 412 PRECONDITION_FAILED, no residue', async () => {
    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    const plan = planRes.body.result;

    const res = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-rev',
      expected_revision: 5, // plan said 0
    });
    expect(res.status).toBe(412);
    expect(res.body.errors[0].code).toBe('PRECONDITION_FAILED');
    // Rejected before the apply txn: no desired row, no lease, no apply task.
    expect(desiredShare(plan.id)).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM leases')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key = ?', 'idem-rev')).toBe(0);
  });

  it('apply with a non-integer expected_revision → 400 INVALID_ARGUMENT', async () => {
    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    const plan = planRes.body.result;

    for (const bad of ['1', 1.5, null]) {
      const res = await post('/api/v1/shares', {
        mode: 'apply',
        plan_id: plan.plan_id,
        idempotency_key: 'idem-type',
        expected_revision: bad,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
    }
  });

  it('idempotent replay → 202 same task, no re-dispatch; key reuse with a different plan → 409', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-dup' });
    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    const planId = planRes.body.result.plan_id as string;

    const first = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'idem-replay',
      expected_revision: 0,
    });
    expect(first.status).toBe(202);
    const before = setup.mockAgent.taskBeginCallCount();

    const second = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'idem-replay',
      expected_revision: 0,
    });
    expect(second.status).toBe(202);
    expect(second.body.result.task_id).toBe(first.body.result.task_id);
    expect(setup.mockAgent.taskBeginCallCount()).toBe(before); // replay must not re-begin

    // Same key + DIFFERENT plan → CONFLICT(idempotency_key_reused).
    const otherPlan = await post('/api/v1/shares', {
      mode: 'plan',
      spec: { ...CREATE_SPEC, path: '/srv/nfs/other', fsid: 8 },
    });
    const reused = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: otherPlan.body.result.plan_id,
      idempotency_key: 'idem-replay',
      expected_revision: 0,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.errors[0].details?.reason).toBe('idempotency_key_reused');
  });

  it('share.update plan→apply: route merges the PATCH into a full spec; desired row updated', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-upd' });
    seedShare(setup.state, 's1'); // path /srv/nfs/s1, fsid 42, revision 1

    const newClients = [{ pattern: '192.168.0.0/16', options: ['ro'] }];
    const planRes = await patch('/api/v1/shares/s1', {
      mode: 'plan',
      spec: { clients: newClients },
    });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    expect(plan.state_revision_expected).toBe(1);
    expect(plan.risk_level).toBe('changing_access');
    // The MERGED spec is what got planned: clients replaced wholesale, the
    // existing path/fsid retained — visible in the compiled diff.
    expect(plan.diff.action).toBe('update');
    expect(plan.diff.export_entry).toEqual({
      path: '/srv/nfs/s1',
      clients: [{ host: '192.168.0.0/16', options: ['ro', 'async', 'no_subtree_check'] }],
    });

    const applyRes = await patch('/api/v1/shares/s1', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-upd',
      expected_revision: 1,
    });
    expect(applyRes.status).toBe(202);
    expect(applyRes.body.result.state).toBe('running');

    const row = desiredShare('s1');
    expect(row?.value).toEqual({
      kind: 'Share',
      id: 's1',
      spec: { path: '/srv/nfs/s1', clients: newClients, fsid: 42 },
    });
    expect(row?.revision).toBe(2);
  });

  it('share.update plan with a changed path → 400 (spec.path is immutable)', async () => {
    seedShare(setup.state, 's1'); // path /srv/nfs/s1
    const res = await patch('/api/v1/shares/s1', {
      mode: 'plan',
      spec: { path: '/srv/nfs/elsewhere' },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0].message).toBe(
      'spec.path is immutable; delete and re-create the share to move it',
    );
  });

  it('share.delete plan→apply: desired row removed; spec is {id, path}', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-del' });
    seedShare(setup.state, 's2');

    const planRes = await del('/api/v1/shares/s2', { mode: 'plan' });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    expect(plan.diff).toEqual({ action: 'delete', export_path: '/srv/nfs/s2' });
    expect(plan.state_revision_expected).toBe(1);

    const applyRes = await del('/api/v1/shares/s2', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-del',
      expected_revision: 1,
    });
    expect(applyRes.status).toBe(202);
    expect(applyRes.body.result.state).toBe('running');
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual({ id: 's2', path: '/srv/nfs/s2' });
    expect(desiredShare('s2')).toBeNull();
  });

  it('nfs-idmap.set plan→apply: 202 running, {domain} forwarded, NfsIdmap/snapshot leased', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-idmap' });

    const planRes = await patch('/api/v1/nfs-idmap', { mode: 'plan', domain: 'corp.example.com' });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    // Observed-only operation: no public affected resource; the plan's revision
    // is the observed nfs_idmap/snapshot revision (0 on a fresh install, §3.5).
    expect(plan.affected_resources).toEqual([]);
    expect(plan.state_revision_expected).toBe(0);
    expect(plan.diff).toEqual({
      action: 'set_domain',
      domain: 'corp.example.com',
      prior_domain: null,
    });

    const applyRes = await patch('/api/v1/nfs-idmap', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-idmap',
      expected_revision: 0,
    });
    expect(applyRes.status).toBe(202);
    const task = applyRes.body.result;
    expect(task.state).toBe('running');
    expect(task.kind).toBe('nfs-idmap.set');
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual({ domain: 'corp.example.com' });
    // lease_resources override: the synthetic NfsIdmap/snapshot is locked.
    expect(
      count(
        'SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND resource_kind = ? AND resource_id = ?',
        task.task_id,
        'NfsIdmap',
        'snapshot',
      ),
    ).toBe(1);
  });

  it('nfs-profile.update first-update plan→apply: no desired row → absence pin 0, row created, executor gets {profile, prior_profile}', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-prof' });

    // No desired NfsProfile row exists — the merge base is the ADR-0005
    // default spec (create-on-first-update, §3.4).
    const planRes = await patch('/api/v1/nfs-profiles/default', {
      mode: 'plan',
      spec: { threads: { count: 128 } },
    });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    expect(plan.state_revision_expected).toBe(0); // absence pin
    expect(plan.affected_resources).toEqual([{ kind: 'NfsProfile', id: 'default', revision: 0 }]);
    // Thread change under the ADR default on_thread_count_change: reload.
    expect(plan.risk_level).toBe('non_disruptive');
    const expectedProfile = { ...DEFAULT_NFS_PROFILE_SPEC, threads: { count: 128 } };
    expect(plan.diff).toEqual({
      action: 'update',
      changed: ['thread_count'],
      restart: false,
      profile: expectedProfile,
    });
    expect(plan.blockers).toEqual([]);

    const applyRes = await patch('/api/v1/nfs-profiles/default', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-prof-1',
      expected_revision: 0, // first update: nothing to pin yet
    });
    expect(applyRes.status).toBe(202);
    const task = applyRes.body.result;
    expect(task.state).toBe('running');
    expect(task.kind).toBe('nfs-profile.update');
    expect(task.agent_acceptance_id).toBe('acc-prof');

    // The desired NfsProfile row was CREATED by the apply txn's mutation.
    const row = setup.state.kv.get<Record<string, unknown>>('/xinas/v1/desired/NfsProfile/default');
    expect(row).not.toBeNull();
    expect(row?.value).toEqual({ kind: 'NfsProfile', id: 'default', spec: expectedProfile });

    // Lease held on NfsProfile/default (no lease_resources override, §3.4).
    expect(
      count(
        'SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND resource_kind = ? AND resource_id = ?',
        task.task_id,
        'NfsProfile',
        'default',
      ),
    ).toBe(1);

    // The executor received the {profile, prior_profile} operation spec (T9b)
    // — the restart flag is NOT in it (derived on both sides, never stored).
    expect(setup.mockAgent.lastTaskBeginParams()?.kind).toBe('nfs-profile.update');
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual({
      profile: expectedProfile,
      prior_profile: DEFAULT_NFS_PROFILE_SPEC,
    });
  });

  it('nfs-profile.update plan: thread change under a restart policy → changing_access', async () => {
    // Seed a desired profile whose service_policy demands restart on thread
    // changes; the merge base is now this stored spec (revision 1).
    setup.state.kv.put('/xinas/v1/desired/NfsProfile/default', {
      kind: 'NfsProfile',
      id: 'default',
      spec: {
        ...DEFAULT_NFS_PROFILE_SPEC,
        service_policy: {
          on_thread_count_change: 'restart',
          on_version_change: 'restart',
          on_rdma_change: 'restart',
          on_v3_settings_change: 'restart',
        },
      },
    });

    const planRes = await patch('/api/v1/nfs-profiles/default', {
      mode: 'plan',
      spec: { threads: { count: 256 } },
    });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result;
    expect(plan.state_revision_expected).toBe(1);
    expect(plan.risk_level).toBe('changing_access');
    expect(plan.diff).toMatchObject({ changed: ['thread_count'], restart: true });
  });

  it('nfs-profile.update plan: a readOnly-section PATCH (v4_recovery) → 400 INVALID_ARGUMENT', async () => {
    const res = await patch('/api/v1/nfs-profiles/default', {
      mode: 'plan',
      spec: { v4_recovery: { server_scope: 'ha-scope' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0].message).toContain('v4_recovery');
  });

  it('PATCH /nfs-profiles/{id≠default} → 404 (Phase-0 singleton); PUT stays stubbed', async () => {
    const res = await patch('/api/v1/nfs-profiles/other', {
      mode: 'plan',
      spec: { threads: { count: 128 } },
    });
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');

    // PUT (full replace) is NOT built in S3 — it must still hit the
    // executorUnavailable stub (422/500 depending on tracker state), not the
    // real route and not the 404 catch-all.
    const put = await request(setup.app)
      .put('/api/v1/nfs-profiles/default')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'plan', spec: {} });
    expect([422, 500]).toContain(put.status);
    expect(put.body.errors[0].details?.code).toMatch(/^EXECUTOR_UN(AVAILABLE|SUPPORTED)$/);
  });

  it('begin-unavailable apply → 503; desired Share REVERTED (Model R), task failed (FAILED_BEFORE_CHANGE)', async () => {
    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    const plan = planRes.body.result;

    // Take the agent offline so dispatch's task.begin gets ECONNREFUSED.
    await setup.mockAgent.simulateOffline();

    const applyRes = await post('/api/v1/shares', {
      mode: 'apply',
      plan_id: plan.plan_id,
      idempotency_key: 'idem-revert',
      expected_revision: 0,
    });
    expect(applyRes.status).toBe(503);
    expect(applyRes.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');

    // Model R end-to-end over HTTP: the apply txn wrote the desired Share, the
    // begin failure reverted it — a failed task leaves no trace.
    expect(desiredShare(plan.id)).toBeNull();
    const row = setup.state.db
      .prepare('SELECT state, error_code FROM tasks WHERE idempotency_key = ?')
      .get('idem-revert') as { state: string; error_code: string };
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('FAILED_BEFORE_CHANGE');
    expect(count('SELECT COUNT(*) AS n FROM leases')).toBe(0);
  });

  it('a share plan_id applied via PATCH /nfs-idmap → 404 (kind-checked plan resolution)', async () => {
    const planRes = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    const res = await patch('/api/v1/nfs-idmap', {
      mode: 'apply',
      plan_id: planRes.body.result.plan_id,
      idempotency_key: 'idem-kind',
      expected_revision: 0,
    });
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
    expect(res.body.errors[0].message).toContain('nfs-idmap.set');
  });

  it('a plan for share A applied via /shares/B → 404 (plan must target the URL resource)', async () => {
    seedShare(setup.state, 'sA');
    seedShare(setup.state, 'sB');
    // seedShare gives both shares fsid 42; the update patch leaves fsid alone
    // so no uniqueness re-check fires — this test isolates the id binding.
    const planRes = await patch('/api/v1/shares/sA', {
      mode: 'plan',
      spec: { clients: [{ pattern: '*', options: ['ro'] }] },
    });
    expect(planRes.status).toBe(200);

    const res = await patch('/api/v1/shares/sB', {
      mode: 'apply',
      plan_id: planRes.body.result.plan_id,
      idempotency_key: 'idem-cross',
      expected_revision: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('plan against a missing share → 404; unknown mode → 400 INVALID_ARGUMENT', async () => {
    const missing = await patch('/api/v1/shares/ghost', { mode: 'plan', spec: { fsid: 1 } });
    expect(missing.status).toBe(404);

    const missingDel = await del('/api/v1/shares/ghost', { mode: 'plan' });
    expect(missingDel.status).toBe(404);

    const bogus = await post('/api/v1/shares', { mode: 'bogus' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });
});
