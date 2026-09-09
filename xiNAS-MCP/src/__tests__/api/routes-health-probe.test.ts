import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { argumentsHash } from '../../api/mcp/confirmation/policy.js';
import { OPERATOR_TOKEN, VIEWER_TOKEN, buildTestAppWithMockAgent } from './_helpers.js';

/**
 * S19a T2 — POST /health/probe (spec §9.1 gate matrix, §9.2 request /
 * response). REST operators need no confirmation; a forwarded MCP call
 * must carry a pending form confirmation bound to this principal, tool
 * and arguments, which the route consumes BEFORE running the probe.
 */
describe('POST /api/v1/health/probe (S19a)', () => {
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
    setup.state.kv.put('/xinas/v1/observed/Filesystem/fs-down', {
      kind: 'Filesystem',
      id: 'fs-down',
      status: { mountpoint: '/mnt/down', mounted: false },
    });
    setup.state.kv.put('/xinas/v1/desired/Share/sh-1', {
      kind: 'Share',
      id: 'sh-1',
      spec: { path: '/mnt/data', clients: [] },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const post = (token: string, body: Record<string, unknown>) =>
    request(setup.app).post('/api/v1/health/probe').set('Authorization', token).send(body);

  it('REST operator: runs fs_io on the filesystem mountpoint, no confirmation needed', async () => {
    let seen: unknown;
    setup.mockAgent.respondToRpc(TOOL, (p) => {
      seen = p;
      return { result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome } };
    });
    const res = await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'fs-data', timeout_s: 10 });
    expect(res.status).toBe(200);
    expect(seen).toEqual({ probe: 'fs_io', path: '/mnt/data', run_id: null, timeout_ms: 10_000 });
    expect(res.body.result).toMatchObject({
      probe: 'fs_io',
      target: 'fs-data',
      path: '/mnt/data',
      run_id: null,
      ok: true,
      artifact: { kind: 'file' },
      cleanup: { status: 'clean' },
    });
    expect(res.body.result.proves).toContain('4 KiB write');
    expect(res.body.result.confirmation_id).toBeUndefined();
  });

  it('nfs_loopback resolves the share export path; run_id and the 20 s default travel to the agent', async () => {
    let seen: unknown;
    setup.mockAgent.respondToRpc(TOOL, (p) => {
      seen = p;
      return {
        result: {
          probe: 'nfs_loopback',
          path: '/mnt/data',
          ...okOutcome,
          artifact: { kind: 'mountpoint', path: '/run/xinas/health-probe/r1-x/mnt' },
        },
      };
    });
    const res = await post(OPERATOR_TOKEN, { probe: 'nfs_loopback', target: 'sh-1', run_id: 'r1' });
    expect(res.status).toBe(200);
    expect(seen).toEqual({
      probe: 'nfs_loopback',
      path: '/mnt/data',
      run_id: 'r1',
      timeout_ms: 20_000,
    });
    expect(res.body.result.proves).toContain('NFS-mounted from the node itself');
    expect(res.body.result.run_id).toBe('r1');
  });

  it('a viewer is refused by the catalog rank', async () => {
    const res = await post(VIEWER_TOKEN, { probe: 'fs_io', target: 'fs-data' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain('PERMISSION_DENIED');
  });

  it('bad body → 400; unknown target → 404; unmounted filesystem → 412 not_mounted', async () => {
    expect((await post(OPERATOR_TOKEN, { probe: 'scrub', target: 'fs-data' })).status).toBe(400);
    expect((await post(OPERATOR_TOKEN, { probe: 'fs_io' })).status).toBe(400);
    expect(
      (await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'fs-data', timeout_s: 0 })).status,
    ).toBe(400);
    expect((await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'nope' })).status).toBe(404);
    expect((await post(OPERATOR_TOKEN, { probe: 'nfs_loopback', target: 'nope' })).status).toBe(
      404,
    );
    const down = await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'fs-down' });
    expect(down.status).toBe(412);
    expect(down.body.errors[0].details.reason).toBe('not_mounted');
  });

  it('a probe already in flight on the agent → 409 CONFLICT', async () => {
    setup.mockAgent.respondToRpc(TOOL, () => ({
      error: { code: -32000, message: 'busy', data: { code: 'PROBE_IN_PROGRESS', probe: 'fs_io' } },
    }));
    const res = await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'fs-data' });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].details.reason).toBe('PROBE_IN_PROGRESS');
  });

  it('a failed probe is a 200 result with ok:false, never an error', async () => {
    setup.mockAgent.respondToRpc(TOOL, () => ({
      result: {
        probe: 'fs_io',
        path: '/mnt/data',
        ...okOutcome,
        ok: false,
        error: { code: 'EIO', message: 'write failed', stage: 'write' },
        cleanup: { status: 'failed', detail: 'EACCES: unlink' },
      },
    }));
    const res = await post(OPERATOR_TOKEN, { probe: 'fs_io', target: 'fs-data' });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      ok: false,
      error: { code: 'EIO', stage: 'write' },
      cleanup: { status: 'failed' },
    });
  });

  describe('forwarded MCP calls (spec §9.1: mcp.allow_apply + a form confirmation)', () => {
    const LOOPBACK = 'lb-test-token';
    const PRINCIPAL = 'operator:test';
    const body = { probe: 'fs_io', target: 'fs-data' };
    const hash = argumentsHash(TOOL, body);

    const mcpPost = (confirmationId?: string, override: Record<string, unknown> = body) => {
      let req = request(setup.app)
        .post('/api/v1/health/probe')
        .set('Authorization', `Bearer ${LOOPBACK}`)
        .set('x-xinas-forwarded-principal', PRINCIPAL)
        .set('x-xinas-forwarded-role', 'operator')
        .set('x-xinas-client-type', 'mcp');
      if (confirmationId !== undefined) req = req.set('x-xinas-confirmation', confirmationId);
      return req.send(override);
    };

    const pendingRecord = (argsHash: string) =>
      setup.ctx.tasks?.confirmations.create({
        mode: 'form',
        principal: PRINCIPAL,
        role: 'operator',
        tool_name: TOOL,
        operation_kind: TOOL,
        arguments_hash: argsHash,
        plan_id: `direct:${argsHash}`,
        plan_hash: argsHash,
        plan_document_hash: 'doc',
        idempotency_key: argsHash,
        expected_revision: 0,
        risk_level: 'non_disruptive',
        rollback_model: 'non_disruptive',
        request_state_nonce_hash: 'nonce',
        ttl_ms: 300_000,
        correlation_id: 'corr',
        request_id: 'req',
        node_id: setup.controllerId,
      });

    beforeEach(() => {
      setup.ctx.loopback_token = LOOPBACK;
      setup.mockAgent.respondToRpc(TOOL, () => ({
        result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome },
      }));
    });

    it('without a confirmation → 412 confirmation_required; the agent is never called', async () => {
      let called = false;
      setup.mockAgent.respondToRpc(TOOL, () => {
        called = true;
        return { result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome } };
      });
      const res = await mcpPost();
      expect(res.status).toBe(412);
      expect(res.body.errors[0].details.reason).toBe('confirmation_required');
      expect(called).toBe(false);
    });

    it('with a pending form record bound to these arguments → consumed, 200, confirmation_id echoed', async () => {
      const rec = pendingRecord(hash);
      const res = await mcpPost(rec?.confirmation_id);
      expect(res.status).toBe(200);
      expect(res.body.result.confirmation_id).toBe(rec?.confirmation_id);
      const after = setup.ctx.tasks?.confirmations.get(rec?.confirmation_id ?? '');
      expect(after?.status).toBe('consumed');
      expect(after?.consumed_task_id).toMatch(/^probe:/);
    });

    it('a record for other arguments → 412 confirmation_binding', async () => {
      const rec = pendingRecord(argumentsHash(TOOL, { probe: 'fs_io', target: 'fs-other' }));
      const res = await mcpPost(rec?.confirmation_id);
      expect(res.status).toBe(412);
      expect(res.body.errors[0].details.reason).toBe('confirmation_binding');
    });

    it('a consumed record cannot be reused → 412 confirmation_not_approved', async () => {
      const rec = pendingRecord(hash);
      expect((await mcpPost(rec?.confirmation_id)).status).toBe(200);
      const again = await mcpPost(rec?.confirmation_id);
      expect(again.status).toBe(412);
      expect(again.body.errors[0].details.reason).toBe('confirmation_not_approved');
    });

    it('an unknown confirmation id → 412 confirmation_binding', async () => {
      const res = await mcpPost('c-does-not-exist');
      expect(res.status).toBe(412);
      expect(res.body.errors[0].details.reason).toBe('confirmation_binding');
    });
  });
});
