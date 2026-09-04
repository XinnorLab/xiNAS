import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PlanDocument, planDocumentHash } from '../../../api/plan/document.js';
import { startServer } from '../../../api/server.js';
import { type MockAgentServer, seedShare, startMockAgentServer } from '../_helpers.js';

/**
 * S15 Task 10 — the MRTR confirmation flow over the wire: a confirmable
 * tools/call turns into an `input_required` elicitation (form or url),
 * the client's retry is verified against the persisted requestState, and
 * an accepted/approved confirmation proceeds to a real apply that
 * dispatches to the agent.
 *
 * Deviations from the task brief (see task-10-report.md for the full
 * rationale — summarized here so the "why" travels with the test):
 *
 *  - The brief's suggested destructive path (`shares.delete` /
 *    `filesystems.delete`) is NOT destructive in the landed NFS/filesystem
 *    providers (`share.delete` → risk_level 'changing_access';
 *    `fs.unmanage` → 'non_disruptive', per ADR-0007 "DELETE never
 *    destroys"). `filesystems.create` with `spec.force: true` IS
 *    risk_level 'destructive' / rollback_model 'unsupported' with an
 *    EMPTY blockers array at plan time (unlike `arrays.delete` and
 *    `config.rollback`, whose providers always attach a static advisory
 *    `dangerous_flag_required` blocker that would trip Gate 7 before a
 *    url-mode confirmation could ever be minted) — so the destructive/url
 *    cases here use `filesystems.create` force:true instead.
 *  - The audit `kind` this repo actually records is
 *    `http.<METHOD>.<path-after-the-last-router-mount>` — e.g.
 *    `http.PATCH./shares/share-a`, NOT `http.PATCH./api/v1/shares/share-a`
 *    (confirmed against mcp-integration.test.ts's `http.GET./disks` and
 *    e2e/client-parity.test.ts's `http.POST./shares`).
 *  - Case 5's "cross-principal" sub-case, as literally described (present
 *    a valid requestState to a second principal and expect
 *    `-32602`/`replay_rejected`), is unreachable given the landed
 *    `handle()`: Gate 6's plan-ownership check
 *    (`doc.created_by.principal !== identity.principal`) runs BEFORE the
 *    initial/retry split and answers `PRECONDITION_FAILED`/`plan_binding`
 *    for ANY cross-principal presentation — initial or retry — before the
 *    deeper requestState/binding mismatch check in `retry()` is ever
 *    reached. The test below asserts the actual (Gate 6) behavior instead
 *    and folds the intended coverage into the dedicated plan-ownership
 *    test (6b), which exercises the same gate with a REST-created plan.
 */

interface RpcResult {
  status: number;
  body: Record<string, unknown>;
}

function rpc(port: number, message: unknown, opts: { token?: string } = {}): Promise<RpcResult> {
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
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

/** Plain REST call (loopback-free — a real client request) for the plan-ownership test. */
function restCall(
  port: number,
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1${path}`,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
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

const META = (elicitation?: Record<string, object>) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'conformance', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': elicitation === undefined ? {} : { elicitation },
});
const FORM = { form: {} };
const BOTH = { form: {}, url: {} };

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function call(
  port: number,
  token: string,
  id: string | number,
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  caps: Record<string, object> | undefined = FORM,
): Promise<RpcResult> {
  return rpc(
    port,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { _meta: META(caps), name, arguments: args, ...extra },
    },
    { token },
  );
}

interface ToolResultBody {
  resultType?: string;
  content?: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState?: string;
}

function toolResultOf(res: RpcResult): ToolResultBody {
  return (res.body.result ?? {}) as ToolResultBody;
}

interface ToolPayload {
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Parse the JSON text body of a COMPLETE (non-input_required) tool result. */
function payloadOf(res: RpcResult): ToolPayload {
  const r = toolResultOf(res);
  if (r.content === undefined) return {};
  return JSON.parse(r.content[0]?.text ?? '{}') as ToolPayload;
}

function rpcErrorOf(
  res: RpcResult,
): { code: number; message: string; data?: Record<string, unknown> } | undefined {
  return res.body.error as
    | { code: number; message: string; data?: Record<string, unknown> }
    | undefined;
}

interface AuditRow {
  kind?: string;
  principal?: string;
  client_type?: string;
}

function auditRows(dir: string): AuditRow[] {
  try {
    return readFileSync(join(dir, 'a.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRow);
  } catch {
    return [];
  }
}

describe('MCP MRTR confirmation over the wire (S15 Task 10)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let mockAgent: MockAgentServer;
  let port: number;

  function getConfirmationByPlanId(planId: string): Record<string, unknown> | undefined {
    return handle.state.db
      .prepare('SELECT * FROM mcp_confirmations WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(planId) as Record<string, unknown> | undefined;
  }

  function countConfirmations(): number {
    return (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM mcp_confirmations').get() as { n: number }
    ).n;
  }

  function countTasksByPlan(planId: string): number {
    return (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(planId) as {
        n: number;
      }
    ).n;
  }

  function countLeases(): number {
    return (handle.state.db.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-confirm-'));
    const agentSock = join(dir, 'agent.sock');
    mockAgent = await startMockAgentServer(agentSock);
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000c1',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: {
          'tok-admin': { principal: 'admin:test', role: 'admin' },
          'tok-admin2': { principal: 'admin:two', role: 'admin' },
        },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        agent: { socket: agentSock },
        mcp: {
          allow_apply: true,
          confirmation: {
            approval_url_base: 'http://127.0.0.1:1',
            url_wait_seconds: 1,
            // This suite drives many confirmable calls for the SAME
            // principal in well under a minute, and several intentionally
            // leave their record open (untouched pending/approved — a
            // tampered-state or cross-principal attempt never advances the
            // record it targets) — max out the limits/rate so cross-test
            // accumulation never trips CONFIRMATION_LIMIT_EXCEEDED /
            // CONFIRMATION_RATE_LIMITED (both covered directly by the unit
            // suite, confirmation-service.test.ts).
            max_pending_per_principal: 50,
            max_pending_total: 1000,
            create_rate_per_minute: 600,
          },
        },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');
    // A second, independent share so a test that dispatches a real apply
    // (which holds its lease forever — the mock agent never posts a
    // terminal task_progress event) never collides with another test's
    // apply on the SAME resource within this shared-server describe block.
    seedShare(handle.state, 'share-b');
    handle.state.kv.put('/xinas/v1/observed/XiraidArray/data', {
      kind: 'XiraidArray',
      id: 'data',
      spec: {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        strip_size_kib: 128,
      },
      status: {
        state: 'optimal',
        volume_path: '/dev/xi_data',
        observed_at: '2026-06-10T12:00:00Z',
      },
    });
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    await mockAgent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function planShareUpdate(
    token: string,
    shareId = 'share-a',
    clients: Array<{ pattern: string; options: string[] }> = [
      { pattern: '10.0.0.0/8', options: ['ro'] },
    ],
  ): Promise<{ plan_id: string; expected_revision: number; risk_level: string }> {
    const res = await call(port, token, nextId('plan-share'), 'shares.update', {
      id: shareId,
      mode: 'plan',
      spec: { clients },
    });
    const payload = payloadOf(res);
    const result = payload.result as {
      plan_id: string;
      state_revision_expected: number;
      risk_level: string;
    };
    return {
      plan_id: result.plan_id,
      expected_revision: result.state_revision_expected,
      risk_level: result.risk_level,
    };
  }

  /**
   * Every destructive plan_apply provider currently landed
   * (`config.rollback`, `arrays.delete`, `filesystems.create` force:true)
   * attaches a STATIC advisory `dangerous_flag_required` blocker at plan
   * time regardless of whether the eventual apply will carry
   * `dangerous: true` — real for REST/TUI clients (who read it and decide),
   * but it means Gate 7 (`doc.blockers.length > 0` → `PRECONDITION_FAILED`/
   * `plan_blocked`) refuses EVERY destructive plan before a url-mode
   * confirmation could ever be minted over MCP. There is currently no
   * catalog route that reaches risk_level 'destructive' with an empty
   * blockers array — see task-10-report.md "Concerns". To still exercise
   * the confirmation service's real url-mode mechanics (elicit → wait →
   * approve → engine dangerous gate) against the REAL provider-rendered
   * document, this plans normally then strips just the advisory blocker
   * and recomputes the document hash to match — the same "hand-edit the
   * stored plan_document" technique the brief itself uses for the
   * OPPOSITE case (injecting a blocker, case 12).
   */
  async function planFsCreateForce(
    token: string,
    mountpoint: string,
  ): Promise<{
    plan_id: string;
    expected_revision: number;
    risk_level: string;
    blockers: unknown[];
  }> {
    const res = await call(port, token, nextId('plan-fs'), 'filesystems.create', {
      mode: 'plan',
      spec: { backing_device: '/dev/xi_data', mountpoint, force: true },
    });
    const payload = payloadOf(res);
    const result = payload.result as {
      plan_id: string;
      state_revision_expected: number;
      risk_level: string;
      blockers: unknown[];
    };
    const row = handle.state.db
      .prepare('SELECT plan_document FROM tasks WHERE task_id = ?')
      .get(result.plan_id) as { plan_document: string };
    const doc = JSON.parse(row.plan_document) as PlanDocument;
    doc.blockers = [];
    handle.state.db
      .prepare('UPDATE tasks SET plan_document = ?, plan_document_hash = ? WHERE task_id = ?')
      .run(JSON.stringify(doc), planDocumentHash(doc), result.plan_id);
    return {
      plan_id: result.plan_id,
      expected_revision: result.state_revision_expected,
      risk_level: result.risk_level,
      blockers: [],
    };
  }

  // ── 1. form happy path + audit (brief case 1) ─────────────────────────────

  it('form happy path: elicits, retries with the exact requestState, applies, and audits', async () => {
    const { plan_id, expected_revision, risk_level } = await planShareUpdate('tok-admin');
    expect(risk_level).toBe('changing_access');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };

    await handle.state.drainer.drainNow();
    const before = auditRows(dir).length;

    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    expect(first.status).toBe(200);
    const r1 = toolResultOf(first);
    expect(r1.resultType).toBe('input_required');
    const confirm = r1.inputRequests?.confirm_apply;
    expect(confirm?.method).toBe('elicitation/create');
    expect(confirm?.params.mode).toBe('form');
    const schema = confirm?.params.requestedSchema as {
      properties: { decision: { enum: string[] } };
    };
    expect(schema.properties.decision.enum).toEqual(['APPLY']);
    expect(r1.requestState?.startsWith('xc1.')).toBe(true);
    expect(confirm?.params.message as string).toContain('share-a');
    expect(confirm?.params.message as string).toContain('changing_access');

    // No task exists yet, and no leases were taken.
    expect(countTasksByPlan(plan_id)).toBe(0);
    expect(countLeases()).toBe(0);
    const pending = getConfirmationByPlanId(plan_id);
    expect(pending?.status).toBe('pending');

    const second = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState: r1.requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    });
    const r2 = toolResultOf(second);
    expect(r2.resultType).toBe('complete');
    expect(r2.isError ?? false).toBe(false);
    const payload2 = payloadOf(second);
    const taskId = (payload2.result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');

    const consumed = getConfirmationByPlanId(plan_id);
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.consumed_task_id).toBe(taskId);

    await handle.state.drainer.drainNow();
    const rows = auditRows(dir).slice(before);
    // See file header: the actual audit kind has no /api/v1 prefix.
    expect(rows.some((r) => r.kind === 'http.PATCH./shares/share-a')).toBe(true);
    expect(rows.some((r) => r.kind === 'mcp.confirmation.requested')).toBe(true);
    expect(rows.some((r) => r.kind === 'mcp.confirmation.consumed')).toBe(true);
    expect(rows.some((r) => r.kind === 'mcp.confirmation.apply_task_created')).toBe(true);
  });

  // ── 2. identical replay (brief case 2) ────────────────────────────────────

  it('identical replay after success returns the same task_id and creates no new task', async () => {
    // A DISTINCT share (share-b): this test's apply succeeds and holds its
    // lease forever (the mock agent never posts a terminal task_progress
    // event), so it must not collide with another test's apply on share-a.
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin', 'share-b');
    const idem = nextId('ik');
    const args = {
      id: 'share-b',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };

    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;
    const accept = {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    };

    const applied = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, accept);
    const taskId = (payloadOf(applied).result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');
    expect(countTasksByPlan(plan_id)).toBe(1);

    const replay = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, accept);
    const replayed = toolResultOf(replay);
    expect(replayed.resultType).toBe('complete');
    const replayTaskId = (payloadOf(replay).result as { task_id?: string })?.task_id;
    expect(replayTaskId).toBe(taskId);
    expect(countTasksByPlan(plan_id)).toBe(1); // no second task
  });

  // ── 3. decline / cancel (brief case 3) ────────────────────────────────────

  it('decline returns CONFIRMATION_DECLINED, cancel returns CONFIRMATION_CANCELLED; no task either way', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
      const idem = nextId('ik');
      const args = {
        id: 'share-a',
        mode: 'apply',
        plan_id,
        expected_revision,
        idempotency_key: idem,
      };
      const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
      const requestState = toolResultOf(first).requestState;

      const res = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
        requestState,
        inputResponses: { confirm_apply: { action } },
      });
      const payload = payloadOf(res);
      expect(toolResultOf(res).isError).toBe(true);
      const expectedCode =
        action === 'decline' ? 'CONFIRMATION_DECLINED' : 'CONFIRMATION_CANCELLED';
      expect(payload.error?.code).toBe(expectedCode);
      expect(payload.error?.details?.task_created).toBe(false);

      const record = getConfirmationByPlanId(plan_id);
      expect(record?.status).toBe(action === 'decline' ? 'declined' : 'cancelled');
      expect(countTasksByPlan(plan_id)).toBe(0);
    }
  });

  // ── 4. wrong decision + round escalation to the limit (brief case 4) ─────

  it('a wrong decision value is treated as a decline', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;

    const res = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'yes' } } },
    });
    expect(payloadOf(res).error?.code).toBe('CONFIRMATION_DECLINED');
    expect(getConfirmationByPlanId(plan_id)?.status).toBe('declined');
  });

  it('a missing confirm_apply response re-issues, escalating rounds, until CONFIRMATION_ROUND_LIMIT', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };

    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    expect(toolResultOf(first).resultType).toBe('input_required');
    expect(getConfirmationByPlanId(plan_id)?.round).toBe(1);
    let state = toolResultOf(first).requestState;

    const round2 = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState: state,
    });
    expect(toolResultOf(round2).resultType).toBe('input_required');
    expect(getConfirmationByPlanId(plan_id)?.round).toBe(2);
    state = toolResultOf(round2).requestState;

    const round3 = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState: state,
    });
    expect(toolResultOf(round3).resultType).toBe('input_required');
    expect(getConfirmationByPlanId(plan_id)?.round).toBe(3);
    state = toolResultOf(round3).requestState;

    const limited = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState: state,
    });
    const payload = payloadOf(limited);
    expect(payload.error?.code).toBe('CONFIRMATION_ROUND_LIMIT');
    const record = getConfirmationByPlanId(plan_id);
    expect(record?.status).toBe('expired');
    expect(record?.expired_reason).toBe('round_limit');
    expect(countTasksByPlan(plan_id)).toBe(0);
  });

  // ── 5. tampered requestState (brief case 5) ───────────────────────────────

  it('a tampered requestState is refused -32602 "invalid request state" over HTTP 200, no task', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState as string;
    const tampered = `${requestState.slice(0, -1)}${requestState.endsWith('a') ? 'b' : 'a'}`;

    const res = await call(port, 'tok-admin', nextId('call'), 'shares.update', args, {
      requestState: tampered,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    });
    expect(res.status).toBe(200);
    const err = rpcErrorOf(res);
    expect(err?.code).toBe(-32602);
    expect(err?.message).toBe('invalid request state');
    expect(countTasksByPlan(plan_id)).toBe(0);
  });

  // See the file header: a cross-principal presentation is caught by Gate 6
  // (plan ownership) before retry()'s deeper binding-mismatch/replay_rejected
  // check is ever reached — for ANY call shape, initial or retry.
  it('a cross-principal presentation of a valid requestState is refused PRECONDITION_FAILED/plan_binding (Gate 6, not replay_rejected)', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;

    const res = await call(port, 'tok-admin2', nextId('call'), 'shares.update', args, {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    });
    const payload = payloadOf(res);
    expect(payload.error?.code).toBe('PRECONDITION_FAILED');
    expect(payload.error?.details?.reason).toBe('plan_binding');
    expect(getConfirmationByPlanId(plan_id)?.status).toBe('pending'); // untouched
  });

  // ── 6. changed arguments / revision / idempotency_key on retry (brief case 6) ─

  it('changed arguments or idempotency_key on the retry are refused -32602 (binding mismatch)', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;
    const inputResponses = {
      confirm_apply: { action: 'accept' as const, content: { decision: 'APPLY' } },
    };

    const changedArgs = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      { ...args, spec: { clients: [{ pattern: '192.168.0.0/16', options: ['rw'] }] } },
      { requestState, inputResponses },
    );
    expect(rpcErrorOf(changedArgs)?.code).toBe(-32602);

    const changedKey = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      { ...args, idempotency_key: nextId('other-ik') },
      { requestState, inputResponses },
    );
    expect(rpcErrorOf(changedKey)?.code).toBe(-32602);

    expect(getConfirmationByPlanId(plan_id)?.status).toBe('pending');
    expect(countTasksByPlan(plan_id)).toBe(0);
  });

  // A changed `expected_revision` is caught EARLIER than the requestState
  // binding check: `handle()`'s shared gate (ruling R-3.1) compares
  // `args.expected_revision` against the persisted document's
  // `state_revision_expected` before EVER branching to retry() — for both
  // the initial call AND a retry. Since the confirmation record can only
  // ever have been created with an expected_revision that already passed
  // that gate, a differing value on a retry is always rejected there first
  // (a plain PRECONDITION_FAILED tool result), so retry()'s own
  // `payload.rev !== bindings.expected_revision` binding check is
  // unreachable for this specific field given a document-consistent value.
  it('a changed expected_revision on the retry is refused PRECONDITION_FAILED before the requestState binding check runs', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    const idem = nextId('ik');
    const args = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
    };
    const first = await call(port, 'tok-admin', nextId('call'), 'shares.update', args);
    const requestState = toolResultOf(first).requestState;
    const inputResponses = {
      confirm_apply: { action: 'accept' as const, content: { decision: 'APPLY' } },
    };

    const changedRevision = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      { ...args, expected_revision: expected_revision + 1 },
      { requestState, inputResponses },
    );
    expect(rpcErrorOf(changedRevision)).toBeUndefined(); // no JSON-RPC protocol error
    const payload = payloadOf(changedRevision);
    expect(payload.error?.code).toBe('PRECONDITION_FAILED');

    expect(getConfirmationByPlanId(plan_id)?.status).toBe('pending');
    expect(countTasksByPlan(plan_id)).toBe(0);
  });

  // ── 6b. plan ownership (review P1) ────────────────────────────────────────

  it('a plan created over REST by another principal cannot be applied over MCP; the SAME principal can', async () => {
    const planRes = await restCall(port, 'tok-admin2', 'PATCH', '/shares/share-a', {
      mode: 'plan',
      spec: { clients: [{ pattern: '172.16.0.0/12', options: ['ro'] }] },
    });
    expect(planRes.status).toBe(200);
    const plan = planRes.body.result as { plan_id: string; state_revision_expected: number };

    const before = countConfirmations();
    const foreign = await call(port, 'tok-admin', nextId('call'), 'shares.update', {
      id: 'share-a',
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: plan.state_revision_expected,
      idempotency_key: nextId('ik'),
    });
    const foreignPayload = payloadOf(foreign);
    expect(foreignPayload.error?.code).toBe('PRECONDITION_FAILED');
    expect(foreignPayload.error?.details?.reason).toBe('plan_binding');
    expect(JSON.stringify(foreignPayload)).not.toContain('admin:two');
    expect(countConfirmations()).toBe(before); // no record created

    const own = await call(port, 'tok-admin2', nextId('call'), 'shares.update', {
      id: 'share-a',
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: plan.state_revision_expected,
      idempotency_key: nextId('ik'),
    });
    expect(toolResultOf(own).resultType).toBe('input_required');
  });

  it('a tampered stored plan_document (hash mismatch) is refused PRECONDITION_FAILED/plan_binding', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    handle.state.db
      .prepare(
        `UPDATE tasks SET plan_document = json_set(plan_document, '$.blockers', json('[{"code":"X","message":"m"}]')) WHERE task_id = ?`,
      )
      .run(plan_id);

    const res = await call(port, 'tok-admin', nextId('call'), 'shares.update', {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: nextId('ik'),
    });
    const payload = payloadOf(res);
    expect(payload.error?.code).toBe('PRECONDITION_FAILED');
    expect(payload.error?.details?.reason).toBe('plan_binding');
  });

  // ── 7. capability failures (brief case 7) ─────────────────────────────────

  it('a destructive (url-mode) plan with only form capability is refused -32021/400 naming url', async () => {
    const { plan_id, expected_revision, risk_level, blockers } = await planFsCreateForce(
      'tok-admin',
      '/mnt/t7a',
    );
    expect(risk_level).toBe('destructive');
    expect(blockers).toEqual([]);
    const before = countConfirmations();
    const res = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      { mode: 'apply', plan_id, expected_revision, idempotency_key: nextId('ik'), dangerous: true },
      {},
      FORM,
    );
    expect(res.status).toBe(400);
    const err = rpcErrorOf(res);
    expect(err?.code).toBe(-32021);
    expect(err?.data?.requiredCapabilities).toEqual({ elicitation: { url: {} } });
    expect(countConfirmations()).toBe(before); // no record created
  });

  it('a form-mode plan with no elicitation capability at all is refused -32021 naming form', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin');
    // `call()`'s `caps` parameter defaults to FORM when passed `undefined`
    // (JS default-parameter semantics trigger on `undefined` whether it is
    // omitted or explicit) — so "no elicitation at all" is built directly
    // via `rpc()`, whose `_meta.clientCapabilities` carries no
    // `elicitation` key.
    const res = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: nextId('call'),
        method: 'tools/call',
        params: {
          _meta: META(undefined),
          name: 'shares.update',
          arguments: {
            id: 'share-a',
            mode: 'apply',
            plan_id,
            expected_revision,
            idempotency_key: nextId('ik'),
          },
        },
      },
      { token: 'tok-admin' },
    );
    expect(res.status).toBe(400);
    const err = rpcErrorOf(res);
    expect(err?.code).toBe(-32021);
    expect(err?.data?.requiredCapabilities).toEqual({ elicitation: { form: {} } });
  });

  // ── 8. url mode (brief case 8) ────────────────────────────────────────────

  it('url mode: elicits a url naming the record id, re-issues after url_wait_seconds while pending, and proceeds once approved (with dangerous:true)', async () => {
    const { plan_id, expected_revision } = await planFsCreateForce('tok-admin', '/mnt/t8a');
    const idem = nextId('ik');
    const args = {
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: idem,
      dangerous: true,
    };

    const first = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      {},
      BOTH,
    );
    const r1 = toolResultOf(first);
    expect(r1.resultType).toBe('input_required');
    expect(r1.inputRequests?.confirm_apply?.params.mode).toBe('url');
    const record = getConfirmationByPlanId(plan_id);
    expect(record?.status).toBe('pending');
    expect(r1.inputRequests?.confirm_apply?.params.url).toBe(
      `http://127.0.0.1:1/mcp/approvals/${record?.confirmation_id as string}`,
    );

    // Still pending: retrying with {action:'accept'} waits url_wait_seconds
    // (1s in this config) and then re-issues rather than erroring. `caps`
    // must be BOTH on every retry too — requireCapability() re-checks the
    // CURRENT call's declared capabilities, not just the initial call's.
    const waited = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      { requestState: r1.requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
      BOTH,
    );
    const r2 = toolResultOf(waited);
    expect(r2.resultType).toBe('input_required');
    expect(getConfirmationByPlanId(plan_id)?.round).toBe(2);

    // Approve out of band, exactly as an operator's approval would.
    handle.state.db
      .prepare(
        `UPDATE mcp_confirmations SET status='approved', approved_by='admin:other', approved_at=? WHERE confirmation_id=?`,
      )
      .run(Date.now(), record?.confirmation_id as string);

    const approved = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      { requestState: r2.requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
      BOTH,
    );
    const r3 = toolResultOf(approved);
    expect(r3.resultType).toBe('complete');
    expect(r3.isError ?? false).toBe(false);
    const taskId = (payloadOf(approved).result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');
    const consumed = getConfirmationByPlanId(plan_id);
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.consumed_task_id).toBe(taskId);
  }, 10_000);

  it('url mode: an approved confirmation without dangerous:true fails PRECONDITION_FAILED/dangerous_flag_required and stays approved', async () => {
    const { plan_id, expected_revision } = await planFsCreateForce('tok-admin', '/mnt/t8b');
    const idem = nextId('ik');
    const args = { mode: 'apply', plan_id, expected_revision, idempotency_key: idem }; // no dangerous

    const first = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      {},
      BOTH,
    );
    const record = getConfirmationByPlanId(plan_id);
    handle.state.db
      .prepare(
        `UPDATE mcp_confirmations SET status='approved', approved_by='admin:other', approved_at=? WHERE confirmation_id=?`,
      )
      .run(Date.now(), record?.confirmation_id as string);

    const res = await call(
      port,
      'tok-admin',
      nextId('call'),
      'filesystems.create',
      args,
      {
        requestState: toolResultOf(first).requestState,
        inputResponses: { confirm_apply: { action: 'accept' } },
      },
      BOTH,
    );
    const payload = payloadOf(res);
    expect(payload.error?.code).toBe('PRECONDITION_FAILED');
    expect(payload.error?.details?.reason).toBe('dangerous_flag_required');
    expect(getConfirmationByPlanId(plan_id)?.status).toBe('approved'); // unchanged
    expect(countTasksByPlan(plan_id)).toBe(0);
  });

  // ── 9. legacy client (brief case 9) ───────────────────────────────────────

  it('a legacy (pre-2026-07-28) client cannot apply a confirmable tool; plan and reads are unaffected', async () => {
    interface RpcOut {
      status: number;
      body: Record<string, unknown>;
      session?: string;
    }
    function legacyRpc(message: unknown, session?: string): Promise<RpcOut> {
      const payload = JSON.stringify(message);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(payload),
              authorization: 'Bearer tok-admin',
              ...(session !== undefined ? { 'mcp-session-id': session } : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const sid = res.headers['mcp-session-id'];
              resolve({
                status: res.statusCode ?? 0,
                body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
                ...(typeof sid === 'string' ? { session: sid } : {}),
              });
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    const init = await legacyRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'legacy', version: '0' },
      },
    });
    const session = init.session as string;

    const apply = await legacyRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'shares.update',
          arguments: {
            id: 'share-a',
            mode: 'apply',
            plan_id: 'whatever',
            expected_revision: 0,
            idempotency_key: 'ik-legacy',
          },
        },
      },
      session,
    );
    const result = (apply.body.result ?? {}) as {
      content?: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('MCP_CONFIRMATION_UNSUPPORTED');

    const plan = await legacyRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'shares.update',
          arguments: {
            id: 'share-a',
            mode: 'plan',
            spec: { clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }] },
          },
        },
      },
      session,
    );
    const planResult = (plan.body.result ?? {}) as {
      content?: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(planResult.isError ?? false).toBe(false);

    const list = await legacyRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'arrays.list', arguments: {} },
      },
      session,
    );
    const listResult = (list.body.result ?? {}) as { isError?: boolean };
    expect(listResult.isError ?? false).toBe(false);
  });

  // ── 11. hidden entries (brief case 11) ────────────────────────────────────

  it('mcp_confirmations.approve is hidden from tools/call (NOT_FOUND), even for an admin', async () => {
    const res = await call(port, 'tok-admin', nextId('call'), 'mcp_confirmations.approve', {
      id: 'x',
    });
    const payload = payloadOf(res);
    expect(toolResultOf(res).isError).toBe(true);
    expect(payload.error?.code).toBe('NOT_FOUND');
  });
});

// ── 10. allow_apply: false (brief case 10) — a separate server/db ──────────

describe('MCP MRTR confirmation — mcp.allow_apply: false (S15 Task 10)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-confirm-noapply-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000c2',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    seedShare(handle.state, 'share-a');
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mode=apply on a confirmable tool is refused MCP_APPLY_DISABLED before any confirmation record is created', async () => {
    const planRes = await call(port, 'tok-admin', nextId('call'), 'shares.update', {
      id: 'share-a',
      mode: 'plan',
      spec: { clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }] },
    });
    const plan = payloadOf(planRes).result as { plan_id: string; state_revision_expected: number };

    const res = await call(port, 'tok-admin', nextId('call'), 'shares.update', {
      id: 'share-a',
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: plan.state_revision_expected,
      idempotency_key: 'ik-noapply',
    });
    const payload = payloadOf(res);
    expect(payload.error?.code).toBe('MCP_APPLY_DISABLED');
    const count = (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM mcp_confirmations').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});
