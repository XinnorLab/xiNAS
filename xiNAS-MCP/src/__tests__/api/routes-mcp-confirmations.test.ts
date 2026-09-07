import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirmationConfig } from '../../api/config.js';
import type { KeyRing } from '../../api/mcp/confirmation/state.js';
import { ConfirmationService } from '../../api/mcp/confirmation/service.js';
import {
  ConfirmationStore,
  type CreateConfirmationInput,
} from '../../api/mcp/confirmation/store.js';
import { ACK_DATA_LOSS, type ConfirmationRecord } from '../../api/mcp/confirmation/types.js';
import { publicPlan } from '../../api/plan/document.js';
import { channelOf } from '../../api/routes/mcp-confirmations.js';
import { startServer } from '../../api/server.js';
import {
  ADMIN2_TOKEN,
  ADMIN_TOKEN,
  INTERNAL_AGENT_TOKEN,
  OPERATOR_TOKEN,
  VIEWER_TOKEN,
  buildTestAppWithMockAgent,
} from './_helpers.js';
import type { MockAgentSetup } from './_helpers.js';

/**
 * S15 Task 11 — the operator approval surface over REST:
 * GET/POST /api/v1/mcp/confirmations… (list, view, approve, decline).
 * Exercises `mcpConfirmationsRouter` end-to-end over the mock-agent app
 * (RBAC, envelope rendering) and `ConfirmationService.view()` /
 * `operatorDecide()` directly for the one case supertest cannot reach:
 * the UDS peer-trust caller (there is no real Unix socket in this harness).
 */

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Seed one confirmation row directly through the store (no plan/doc needed
 *  unless the test calls GET one, which resolves a real plan — see
 *  `seedPlan`). Defaults to a destructive url record so most tests can
 *  override just the fields they care about. */
function seedRecord(
  setup: MockAgentSetup,
  overrides: Partial<CreateConfirmationInput> = {},
): ConfirmationRecord {
  const input: CreateConfirmationInput = {
    mode: 'url',
    principal: 'admin:test',
    role: 'admin',
    tool_name: 'filesystems.create',
    operation_kind: 'fs.create',
    arguments_hash: `ah-${uniq('h')}`,
    plan_id: uniq('plan'),
    plan_hash: `ph-${uniq('h')}`,
    plan_document_hash: `pdh-${uniq('h')}`,
    idempotency_key: uniq('ik'),
    expected_revision: 0,
    risk_level: 'changing_access',
    rollback_model: 'changing_access',
    request_state_nonce_hash: `nonce-${uniq('h')}`,
    ttl_ms: 300_000,
    correlation_id: uniq('corr'),
    request_id: uniq('req'),
    node_id: setup.controllerId,
    ...overrides,
  };
  return setup.tasks.confirmations.create(input);
}

/** Create a real share.create plan over REST and return its plan_id plus
 *  the persisted (task, document) pair `view()` needs to resolve. */
async function seedPlan(
  setup: MockAgentSetup,
): Promise<{ plan_id: string; plan_hash: string; plan_document_hash: string }> {
  const res = await request(setup.app)
    .post('/api/v1/shares')
    .set('Authorization', ADMIN_TOKEN)
    .send({
      mode: 'plan',
      spec: {
        path: `/srv/nfs/${uniq('view-share')}`,
        clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }],
      },
    });
  expect(res.status).toBe(200);
  const plan_id = res.body.result.plan_id as string;
  const task = setup.tasks.store.get(plan_id);
  expect(task?.plan_hash).toBeDefined();
  expect(task?.plan_document_hash).toBeDefined();
  return {
    plan_id,
    plan_hash: task!.plan_hash!,
    plan_document_hash: task!.plan_document_hash!,
  };
}

/** Rows queued via AuditAppender in this mock-agent app's db. */
function auditRows(
  setup: MockAgentSetup,
): Array<{ kind: string; principal: string; payload: Record<string, unknown> }> {
  const rows = setup.state.db
    .prepare('SELECT entry_json FROM audit_outbox ORDER BY audit_seq')
    .all() as Array<{ entry_json: Buffer }>;
  return rows.map(
    (r) =>
      JSON.parse(r.entry_json.toString('utf8')) as {
        kind: string;
        principal: string;
        payload: Record<string, unknown>;
      },
  );
}

function fakeKeyRing(): KeyRing {
  return { active: 'k1', keys: new Map([['k1', Buffer.alloc(32, 9)]]) };
}

describe('channelOf (S15 Task 11 fix1, F2a)', () => {
  it('maps the UDS peer-trust principal to uds_break_glass and every bearer principal to bearer', () => {
    expect(channelOf('local:uds')).toBe('uds_break_glass');
    expect(channelOf('admin:test')).toBe('bearer');
    expect(channelOf('mcp:local_admin')).toBe('bearer');
    expect(channelOf('internal_agent')).toBe('bearer');
  });
});

describe('mcp-confirmations routes (S15 Task 11)', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
  });
  afterEach(async () => {
    await setup.teardown();
  });

  it('viewer/operator tokens are refused (admin only)', async () => {
    const record = seedRecord(setup);
    for (const token of [VIEWER_TOKEN, OPERATOR_TOKEN]) {
      const list = await request(setup.app)
        .get('/api/v1/mcp/confirmations')
        .set('Authorization', token);
      expect(list.status).toBe(401);
      expect(list.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');

      const one = await request(setup.app)
        .get(`/api/v1/mcp/confirmations/${record.confirmation_id}`)
        .set('Authorization', token);
      expect(one.status).toBe(401);
      expect(one.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');

      const approve = await request(setup.app)
        .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
        .set('Authorization', token)
        .send({});
      expect(approve.status).toBe(401);
      expect(approve.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');

      const decline = await request(setup.app)
        .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/decline`)
        .set('Authorization', token)
        .send({});
      expect(decline.status).toBe(401);
      expect(decline.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    }
  });

  it('GET list filters and renders ISO timestamps without the nonce hash', async () => {
    const pending = seedRecord(setup, { principal: 'admin:test' });
    const other = seedRecord(setup, { principal: 'admin:other' });
    setup.tasks.confirmations.decline(other.confirmation_id, 'admin:two', 'bearer');

    const filtered = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ status: 'pending' })
      .set('Authorization', ADMIN_TOKEN);
    expect(filtered.status).toBe(200);
    const ids = (filtered.body.result as Array<Record<string, unknown>>).map(
      (r) => r.confirmation_id,
    );
    expect(ids).toContain(pending.confirmation_id);
    expect(ids).not.toContain(other.confirmation_id);

    const row = (filtered.body.result as Array<Record<string, unknown>>).find(
      (r) => r.confirmation_id === pending.confirmation_id,
    )!;
    expect(row.created_at).toBe(new Date(pending.created_at).toISOString());
    expect(row.expires_at).toBe(new Date(pending.expires_at).toISOString());
    expect('request_state_nonce_hash' in row).toBe(false);

    const byPrincipal = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ principal: 'admin:other' })
      .set('Authorization', ADMIN_TOKEN);
    const byPrincipalIds = (byPrincipal.body.result as Array<Record<string, unknown>>).map(
      (r) => r.confirmation_id,
    );
    expect(byPrincipalIds).toEqual([other.confirmation_id]);

    const badStatus = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ status: 'not-a-status' })
      .set('Authorization', ADMIN_TOKEN);
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
  });

  it('GET one returns the record + plan (deep-equal publicPlan(stored)) + summary, and audits viewed', async () => {
    const { plan_id, plan_hash, plan_document_hash } = await seedPlan(setup);
    const record = seedRecord(setup, { plan_id, plan_hash, plan_document_hash });
    const doc = setup.tasks.store.get(plan_id)!.plan_document!;

    const res = await request(setup.app)
      .get(`/api/v1/mcp/confirmations/${record.confirmation_id}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.confirmation_id).toBe(record.confirmation_id);
    expect(res.body.result.plan).toEqual(publicPlan(doc));
    expect(typeof res.body.result.summary?.message).toBe('string');
    expect(typeof res.body.result.summary?.consequences).toBe('string');
    expect(typeof res.body.result.summary?.rollback_limitation).toBe('string');
    expect('request_state_nonce_hash' in res.body.result).toBe(false);

    const missing = await request(setup.app)
      .get('/api/v1/mcp/confirmations/no-such-id')
      .set('Authorization', ADMIN_TOKEN);
    expect(missing.status).toBe(404);

    const rows = auditRows(setup);
    const viewed = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.viewed' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(viewed).toBeDefined();
    expect(viewed?.principal).toBe('admin:test');
  });

  it('approve: distinct_principal refuses the requester (CONFLICT approver_policy), accepts another admin', async () => {
    const record = seedRecord(setup, { principal: 'admin:test' });

    const ownAttempt = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN_TOKEN)
      .send({});
    expect(ownAttempt.status).toBe(409);
    expect(ownAttempt.body.errors?.[0]?.details?.reason).toBe('approver_policy');
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');

    const otherAttempt = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(otherAttempt.status).toBe(200);
    expect(otherAttempt.body.result.status).toBe('approved');
    expect(otherAttempt.body.result.approved_by).toBe('admin:two');
    expect(otherAttempt.body.result.approval_channel).toBe('bearer');
  });

  it('approve: destructive needs the exact phrase; wrong phrase is INVALID_ARGUMENT and no transition', async () => {
    const record = seedRecord(setup, {
      principal: 'admin:test',
      risk_level: 'destructive',
      rollback_model: 'destructive',
    });

    const wrong = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
    expect(wrong.body.errors?.[0]?.details?.required_acknowledge).toBe(ACK_DATA_LOSS);
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');

    const missing = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(missing.status).toBe(400);
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');

    const right = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_DATA_LOSS });
    expect(right.status).toBe(200);
    expect(right.body.result.status).toBe('approved');
  });

  it('approve on a form record is CONFLICT form_mode; approve on a terminal record is CONFLICT not_pending', async () => {
    const formRecord = seedRecord(setup, { principal: 'admin:test', mode: 'form' });
    const formRes = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${formRecord.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(formRes.status).toBe(409);
    expect(formRes.body.errors?.[0]?.details?.reason).toBe('form_mode');

    const terminalRecord = seedRecord(setup, { principal: 'admin:test' });
    setup.tasks.confirmations.decline(terminalRecord.confirmation_id, 'admin:two', 'bearer');
    const terminalRes = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${terminalRecord.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(terminalRes.status).toBe(409);
    expect(terminalRes.body.errors?.[0]?.details?.reason).toBe('not_pending');
    expect(terminalRes.body.errors?.[0]?.details?.status).toBe('declined');
  });

  it('decline works from pending and approved; declined twice is CONFLICT not_pending', async () => {
    const fromPending = seedRecord(setup, { principal: 'admin:test' });
    const declined1 = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${fromPending.confirmation_id}/decline`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ reason: 'no longer needed' });
    expect(declined1.status).toBe(200);
    expect(declined1.body.result.status).toBe('declined');

    const fromApproved = seedRecord(setup, { principal: 'admin:test' });
    setup.tasks.confirmations.approve(fromApproved.confirmation_id, 'admin:two', 'bearer');
    const declined2 = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${fromApproved.confirmation_id}/decline`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(declined2.status).toBe(200);
    expect(declined2.body.result.status).toBe('declined');

    const again = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${fromApproved.confirmation_id}/decline`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.errors?.[0]?.details?.reason).toBe('not_pending');
    expect(again.body.errors?.[0]?.details?.status).toBe('declined');
  });

  it('UDS peer trust (local:uds) is REFUSED by default (CONFLICT approver_policy) and accepted only with allow_uds_approval:true, which also audits break_glass_used', async () => {
    expect(setup.ctx.mcpConfirmations).toBeDefined();
    const defaultService = setup.ctx.mcpConfirmations!;
    const udsService = new ConfirmationService({
      store: setup.tasks.confirmations,
      tasks: setup.tasks.store,
      keyRing: fakeKeyRing(),
      config: { ...resolveConfirmationConfig(setup.config), allow_uds_approval: true },
      now: () => Date.now(),
      nodeId: setup.controllerId,
      hostname: 'test-host',
      audit: setup.state.audit,
    });

    const record = seedRecord(setup, { principal: 'admin:test' });
    const udsApprover = { principal: 'local:uds', role: 'admin' } as const;

    // operatorDecide is synchronous and throws — wrap the call so the
    // exception lands on the assertion, not the test body.
    expect(() =>
      defaultService.operatorDecide({
        id: record.confirmation_id,
        decision: 'approve',
        approver: udsApprover,
        channel: 'uds_break_glass',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'approver_policy' }),
      }),
    );
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');

    const decided = udsService.operatorDecide({
      id: record.confirmation_id,
      decision: 'approve',
      approver: udsApprover,
      channel: 'uds_break_glass',
    });
    expect(decided.status).toBe('approved');
    expect(decided.approved_by).toBe('local:uds');
    expect(decided.approval_channel).toBe('uds_break_glass');

    const rows = auditRows(setup);
    const breakGlass = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.break_glass_used' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(breakGlass).toBeDefined();
    expect(breakGlass?.principal).toBe('local:uds');
  });

  it('approval_channel is bearer for a token request regardless of X-Xinas-Approval-Interface; the header lands in approval_interface only, and a web-labelled request with a mismatching Origin is refused', async () => {
    const labelled = seedRecord(setup, { principal: 'someone:else' });
    const res = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${labelled.confirmation_id}/decline`)
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Approval-Interface', 'web')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.result.approval_channel).toBe('bearer');
    expect(res.body.result.approval_interface).toBe('web');

    // The router reads ctx.config.mcp?.confirmation?.approval_url_base fresh
    // on every request (never cached at startup) — poking it here targets
    // just this one request without needing a second app instance.
    setup.config.mcp = {
      confirmation: { approval_url_base: 'https://approvals.xinas.example' },
    };
    const crossOrigin = seedRecord(setup, { principal: 'someone:else2' });
    const refused = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${crossOrigin.confirmation_id}/decline`)
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Approval-Interface', 'web')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(refused.status).toBe(401);
    expect(refused.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(setup.tasks.confirmations.get(crossOrigin.confirmation_id)?.status).toBe('pending');
  });

  it('Origin is compared as an ORIGIN, not a string prefix: a same-prefix near-miss host is refused, the exact origin is accepted (F4, S15 §9.3)', async () => {
    setup.config.mcp = { confirmation: { approval_url_base: 'https://nas.example.com/' } };

    const nearMiss = seedRecord(setup, { principal: 'someone:else3' });
    const refused = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${nearMiss.confirmation_id}/decline`)
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Approval-Interface', 'web')
      .set('Origin', 'https://nas.example.co') // a STRING PREFIX of the base, not the same origin
      .send({});
    expect(refused.status).toBe(401);
    expect(refused.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(setup.tasks.confirmations.get(nearMiss.confirmation_id)?.status).toBe('pending');

    const exact = seedRecord(setup, { principal: 'someone:else4' });
    const accepted = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${exact.confirmation_id}/decline`)
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Approval-Interface', 'web')
      .set('Origin', 'https://nas.example.com') // the resolved (trailing-slash-stripped) base's exact origin
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.status).toBe('declined');
  });

  it('approve on a pending url record past its TTL is CONFLICT not_pending/expired even with the right acknowledge phrase; decline still succeeds (F1, S15 §6.3)', async () => {
    const record = seedRecord(setup, {
      principal: 'admin:test',
      risk_level: 'destructive',
      rollback_model: 'destructive',
      ttl_ms: -1000, // already expired at creation: expires_at = created_at - 1000
    });

    const res = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/approve`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({ acknowledge: ACK_DATA_LOSS });
    expect(res.status).toBe(409);
    expect(res.body.errors?.[0]?.code).toBe('CONFLICT');
    expect(res.body.errors?.[0]?.details?.reason).toBe('not_pending');
    expect(res.body.errors?.[0]?.details?.status).toBe('expired');
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');
    const approvedAudit = auditRows(setup).find(
      (r) =>
        r.kind === 'mcp.confirmation.approved' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(approvedAudit).toBeUndefined();

    const declined = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/decline`)
      .set('Authorization', ADMIN2_TOKEN)
      .send({});
    expect(declined.status).toBe(200);
    expect(declined.body.result.status).toBe('declined');
  });

  it('the UDS channel gets no distinct_principal exemption: a same-principal approve over uds_break_glass is refused too (F3, S15 §9.2)', () => {
    const udsService = new ConfirmationService({
      store: setup.tasks.confirmations,
      tasks: setup.tasks.store,
      keyRing: fakeKeyRing(),
      config: { ...resolveConfirmationConfig(setup.config), allow_uds_approval: true },
      now: () => Date.now(),
      nodeId: setup.controllerId,
      hostname: 'test-host',
      audit: setup.state.audit,
    });
    const record = seedRecord(setup, { principal: 'local:uds' });

    expect(() =>
      udsService.operatorDecide({
        id: record.confirmation_id,
        decision: 'approve',
        approver: { principal: 'local:uds', role: 'admin' },
        channel: 'uds_break_glass',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'approver_policy' }),
      }),
    );
    expect(setup.tasks.confirmations.get(record.confirmation_id)?.status).toBe('pending');
  });

  it('the requester may decline (withdraw) their own pending record; distinct_principal applies to approve only (F5, S15 §9.2)', async () => {
    const record = seedRecord(setup, { principal: 'admin:test' });
    const res = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${record.confirmation_id}/decline`)
      .set('Authorization', ADMIN_TOKEN)
      .send({ reason: 'changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('declined');
    expect(res.body.result.declined_by).toBe('admin:test');
  });

  // F9's brief text expects "409 approver_policy" for an internal_agent decision —
  // that was the CURRENT (unfixed) shape of operatorDecide's own
  // `approver.role !== 'admin'` check. F11, landed in this SAME commit,
  // moves exactly that check to PERMISSION_DENIED/{required_role:'admin'}
  // (matching middleware/rbac.ts and the service's Gate-2 RBAC check,
  // service.ts:136-140) — and internal_agent's role ('internal_agent') is
  // the ONLY role that can ever reach this check via the route (RBAC
  // admits it as admin-rank; viewer/operator are already stopped at 401
  // by rbacMiddleware before the service is called). Applying F11
  // necessarily changes this test's expected outcome from CONFLICT
  // approver_policy to PERMISSION_DENIED; see task-11-fix1-report.md
  // "Deviations" for the full reasoning.
  it('internal_agent is admin-rank at RBAC but not the required admin role: the service refuses approve/decline (PERMISSION_DENIED, required_role admin) and the record is unchanged (F9 + F11, S15 §9.2)', async () => {
    const approveRecord = seedRecord(setup, { principal: 'admin:test' });
    const approveRes = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${approveRecord.confirmation_id}/approve`)
      .set('Authorization', INTERNAL_AGENT_TOKEN)
      .send({});
    expect(approveRes.status).toBe(401);
    expect(approveRes.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(approveRes.body.errors?.[0]?.details?.required_role).toBe('admin');
    expect(setup.tasks.confirmations.get(approveRecord.confirmation_id)?.status).toBe('pending');

    const declineRecord = seedRecord(setup, { principal: 'admin:test' });
    const declineRes = await request(setup.app)
      .post(`/api/v1/mcp/confirmations/${declineRecord.confirmation_id}/decline`)
      .set('Authorization', INTERNAL_AGENT_TOKEN)
      .send({});
    expect(declineRes.status).toBe(401);
    expect(declineRes.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(declineRes.body.errors?.[0]?.details?.required_role).toBe('admin');
    expect(setup.tasks.confirmations.get(declineRecord.confirmation_id)?.status).toBe('pending');
  });

  it('GET list rejects a repeated (array) query param for limit/status/principal; limit range/type errors are INVALID_ARGUMENT (F9)', async () => {
    const record = seedRecord(setup, { principal: 'admin:test' });

    const arrayLimit = await request(setup.app)
      .get('/api/v1/mcp/confirmations?limit=1&limit=2')
      .set('Authorization', ADMIN_TOKEN);
    expect(arrayLimit.status).toBe(400);
    expect(arrayLimit.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');

    const zeroLimit = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ limit: 0 })
      .set('Authorization', ADMIN_TOKEN);
    expect(zeroLimit.status).toBe(400);
    expect(zeroLimit.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');

    const nanLimit = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ limit: 'abc' })
      .set('Authorization', ADMIN_TOKEN);
    expect(nanLimit.status).toBe(400);
    expect(nanLimit.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');

    const oneLimit = await request(setup.app)
      .get('/api/v1/mcp/confirmations')
      .query({ limit: 1 })
      .set('Authorization', ADMIN_TOKEN);
    expect(oneLimit.status).toBe(200);
    expect((oneLimit.body.result as unknown[]).length).toBe(1);
    expect((oneLimit.body.result as Array<Record<string, unknown>>)[0]?.confirmation_id).toBe(
      record.confirmation_id,
    );

    const arrayPrincipal = await request(setup.app)
      .get('/api/v1/mcp/confirmations?principal=a&principal=b')
      .set('Authorization', ADMIN_TOKEN);
    expect(arrayPrincipal.status).toBe(400);
    expect(arrayPrincipal.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');

    const arrayStatus = await request(setup.app)
      .get('/api/v1/mcp/confirmations?status=pending&status=approved')
      .set('Authorization', ADMIN_TOKEN);
    expect(arrayStatus.status).toBe(400);
    expect(arrayStatus.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
  });

  it('not_pending reports the LIVE status when the guarded UPDATE misses a race, not the pre-transition snapshot (F10)', () => {
    const record = seedRecord(setup, { principal: 'admin:test' });
    const svc = setup.ctx.mcpConfirmations!;
    const store = setup.tasks.confirmations;
    const spy = vi.spyOn(store, 'approve').mockImplementationOnce((id: string) => {
      // Simulate a second writer declining the record between operatorDecide's
      // read and its own guarded UPDATE: decline for real, then report the
      // guarded UPDATE as having missed (changes() === 0 -> null), exactly as
      // the store itself would if a real race had beaten it there.
      store.decline(id, 'admin:two', 'bearer');
      return null;
    });
    try {
      expect(() =>
        svc.operatorDecide({
          id: record.confirmation_id,
          decision: 'approve',
          approver: { principal: 'admin:two', role: 'admin' },
          channel: 'bearer',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'CONFLICT',
          details: expect.objectContaining({ reason: 'not_pending', status: 'declined' }),
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * F2(b) — the `local:uds` channel derivation, proven end-to-end over a REAL
 * Unix-domain socket. `buildTestAppWithMockAgent` (used by the describe
 * block above) drives `createApp` directly with supertest's own ephemeral
 * TCP listener, so `middleware/auth.ts`'s UDS peer-trust branch (no bearer
 * header AND `req.socket.remoteAddress` is falsy) is never reachable there.
 * This describe block boots a REAL `xinas-api` with `startServer` bound to
 * `listen: { kind: 'unix', socket: <path> }` and drives it with a raw
 * `http.request({ socketPath, ... })` carrying no Authorization header — the
 * one client shape that can actually produce the `local:uds` verdict.
 */
describe('local:uds channel over a REAL Unix socket (S15 Task 11 fix1, F2b)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(
    allowUdsApproval: boolean,
  ): Promise<{ socketPath: string; controllerId: string }> {
    // os.tmpdir() + a short prefix: macOS caps AF_UNIX socket paths around
    // 104 bytes: a long temp path here would make server.listen(socketPath)
    // fail with ENAMETOOLONG before the test body ever runs.
    dir = mkdtempSync(join(tmpdir(), 'xinas-uds-'));
    const socketPath = join(dir, 'a.sock');
    const controllerId = '00000000-0000-0000-0000-0000000000c9';
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        controller_id: controllerId,
        listen: { kind: 'unix', socket: socketPath },
        tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        mcp: { confirmation: { allow_uds_approval: allowUdsApproval } },
      }),
    );
    handle = await startServer({ configPath: join(dir, 'config.json') });
    return { socketPath, controllerId };
  }

  /** Seed a pending url-mode record directly through a second ConfirmationStore
   *  instance over the SAME db handle `startServer` opened — no plan/doc needed
   *  since this suite only exercises approve, never GET .../{id}. */
  function seedPendingUrlRecord(controllerId: string): ConfirmationRecord {
    const store = new ConfirmationStore({ db: handle!.state.db, now: () => Date.now() });
    return store.create({
      mode: 'url',
      principal: 'admin:test',
      role: 'admin',
      tool_name: 'filesystems.create',
      operation_kind: 'fs.create',
      arguments_hash: `ah-${uniq('h')}`,
      plan_id: uniq('plan'),
      plan_hash: `ph-${uniq('h')}`,
      plan_document_hash: `pdh-${uniq('h')}`,
      idempotency_key: uniq('ik'),
      expected_revision: 0,
      risk_level: 'changing_access',
      rollback_model: 'changing_access',
      request_state_nonce_hash: `nonce-${uniq('h')}`,
      ttl_ms: 300_000,
      correlation_id: uniq('corr'),
      request_id: uniq('req'),
      node_id: controllerId,
    });
  }

  /** POST .../approve with NO Authorization header, over the real Unix socket. */
  function udsApprove(
    socketPath: string,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = JSON.stringify({});
    return new Promise((resolveP, reject) => {
      const req = http.request(
        {
          socketPath,
          path: `/api/v1/mcp/confirmations/${id}/approve`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolveP({
              status: res.statusCode ?? 0,
              body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function auditRowsOf(): Array<{
    kind: string;
    principal: string;
    payload: Record<string, unknown>;
  }> {
    const rows = handle!.state.db
      .prepare('SELECT entry_json FROM audit_outbox ORDER BY audit_seq')
      .all() as Array<{ entry_json: Buffer }>;
    return rows.map(
      (r) =>
        JSON.parse(r.entry_json.toString('utf8')) as {
          kind: string;
          principal: string;
          payload: Record<string, unknown>;
        },
    );
  }

  it('is refused by default (allow_uds_approval: false): 409 approver_policy, record still pending, no audit row', async () => {
    const { socketPath, controllerId } = await boot(false);
    const record = seedPendingUrlRecord(controllerId);

    const res = await udsApprove(socketPath, record.confirmation_id);
    expect(res.status).toBe(409);
    expect(
      (res.body.errors as Array<Record<string, unknown>> | undefined)?.[0]?.details,
    ).toMatchObject({ reason: 'approver_policy' });

    const store = new ConfirmationStore({ db: handle!.state.db, now: () => Date.now() });
    expect(store.get(record.confirmation_id)?.status).toBe('pending');
    const rows = auditRowsOf();
    const approved = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.approved' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(approved).toBeUndefined();
    // (f): and no break-glass row either. `break_glass_used` is the row an
    // operator greps to answer "was the boundary ever crossed on this
    // node?" — a refused attempt must not appear in that answer.
    const breakGlass = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.break_glass_used' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(breakGlass).toBeUndefined();
  });

  it('with allow_uds_approval: true: 200, approval_channel uds_break_glass, both approved + break_glass_used audited with principal local:uds', async () => {
    const { socketPath, controllerId } = await boot(true);
    const record = seedPendingUrlRecord(controllerId);

    const res = await udsApprove(socketPath, record.confirmation_id);
    expect(res.status).toBe(200);
    const result = res.body.result as Record<string, unknown>;
    expect(result?.approval_channel).toBe('uds_break_glass');
    expect(result?.approved_by).toBe('local:uds');
    expect(result?.status).toBe('approved');

    const rows = auditRowsOf();
    const approved = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.approved' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    const breakGlass = rows.find(
      (r) =>
        r.kind === 'mcp.confirmation.break_glass_used' &&
        r.payload.confirmation_id === record.confirmation_id,
    );
    expect(approved).toBeDefined();
    expect(approved?.principal).toBe('local:uds');
    expect(breakGlass).toBeDefined();
    expect(breakGlass?.principal).toBe('local:uds');
  });
});
