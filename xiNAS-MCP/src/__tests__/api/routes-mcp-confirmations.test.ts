import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfirmationConfig } from '../../api/config.js';
import type { KeyRing } from '../../api/mcp/confirmation/state.js';
import { ConfirmationService } from '../../api/mcp/confirmation/service.js';
import type { CreateConfirmationInput } from '../../api/mcp/confirmation/store.js';
import { ACK_DATA_LOSS, type ConfirmationRecord } from '../../api/mcp/confirmation/types.js';
import { publicPlan } from '../../api/plan/document.js';
import {
  ADMIN2_TOKEN,
  ADMIN_TOKEN,
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
});
