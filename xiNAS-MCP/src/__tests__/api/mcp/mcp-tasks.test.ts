import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../../api/server.js';
import { encodeMcpHeaderValue } from '../../../api/mcp/tasks/headers.js';
import { CreateTaskResultSchema, GetTaskResultSchema } from '../../../api/mcp/tasks/schema.js';
import { type MockAgentServer, seedShare, startMockAgentServer } from '../_helpers.js';

/**
 * S16 Task 10 — the MCP Tasks extension (`io.modelcontextprotocol/tasks`)
 * over the wire: a real in-process api (`startServer`) plus a mock agent,
 * driving task state through the SAME `/internal/v1/task_progress` receiver
 * the real xinas-agent posts to. Proves the §16.2 evidence for S16.
 *
 * Modeled on `mcp-confirmation.test.ts` (S15 Task 10) — same `rpc`/`call`/
 * `payloadOf`/`toolResultOf` helper shapes, same server config style,
 * `seedShare`, `startMockAgentServer`. `rpc()` here additionally accepts an
 * optional `headers` map (S16 needs `Mcp-Method`/`Mcp-Name`/
 * `MCP-Protocol-Version` on the three task methods, per spec §5.6).
 *
 * Each `it` is named after the case in
 * `docs/control-path/s16-mcp-tasks-spec.md` §16.2 / the task-10 brief it
 * proves — see the report for the exact case → `it` mapping.
 */

interface RpcResult {
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

/** POST one JSON-RPC message to /mcp. `opts.headers` is merged into the request headers (S16 §5.6). */
function rpc(
  port: number,
  message: unknown,
  opts: { token?: string; headers?: Record<string, string> } = {},
): Promise<RpcResult> {
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
          ...(opts.headers ?? {}),
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
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** GET a REST path (no body — GET requests never need one). */
function restGet(
  port: number,
  token: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1${path}`,
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
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
    req.end();
  });
}

/** POST a bare (non-/mcp) internal route — used for /internal/v1/task_progress. */
function internalCall(
  port: number,
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
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

const TASKS_CAP = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const META = (caps: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'conformance', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': caps,
});
const FORM_TASKS = { elicitation: { form: {} }, ...TASKS_CAP };
const FORM_ONLY = { elicitation: { form: {} } };

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
  caps: Record<string, unknown> = FORM_ONLY,
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

/** The three `io.modelcontextprotocol/tasks` methods (S16 §5.2–§5.4). */
function taskRpc(
  port: number,
  method: 'tasks/get' | 'tasks/update' | 'tasks/cancel' | 'tasks/list' | 'tasks/result',
  taskId: unknown,
  token: string,
  caps: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> | 'auto' = 'auto',
): Promise<RpcResult> {
  const h: Record<string, string> =
    headers === 'auto'
      ? {
          'mcp-method': method,
          'mcp-name': String(taskId),
          'mcp-protocol-version': '2026-07-28',
        }
      : headers;
  return rpc(
    port,
    { jsonrpc: '2.0', id: nextId('t'), method, params: { _meta: META(caps), taskId, ...extra } },
    { token, headers: h },
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
  next?: { tool?: string; args?: Record<string, unknown>; note?: string };
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Parse the JSON text body of a COMPLETE (non-input_required, non-task) tool result. */
function payloadOf(res: RpcResult): ToolPayload {
  const r = toolResultOf(res);
  if (r.content === undefined) return {};
  return JSON.parse(r.content[0]?.text ?? '{}') as ToolPayload;
}

/** The raw `result` object of a task-method / CreateTaskResult response (flat, no `content` wrapper). */
function resultOf(res: RpcResult): Record<string, unknown> {
  return (res.body.result ?? {}) as Record<string, unknown>;
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
  task_id?: string;
  payload?: Record<string, unknown>;
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

describe('MCP Tasks extension over the wire (S16 Task 10)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let mockAgent: MockAgentServer;
  let port: number;
  /** Set by case 4 — a fully terminal (`success`) task owned by admin:test, reused by cases 6/7/8/10/11/13. */
  let completedTaskId: string;

  function countTasksByPlan(planId: string): number {
    return (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(planId) as {
        n: number;
      }
    ).n;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-tasks-'));
    const agentSock = join(dir, 'agent.sock');
    mockAgent = await startMockAgentServer(agentSock);
    // The REST cancel route refuses to even ask the agent when the
    // HeartbeatTracker reports offline (routes/tasks.ts `trackerOffline`) —
    // the tracker starts 'offline' until its first successful agent.health
    // probe, so seed one BEFORE startServer() so the tracker's very first
    // tick (fired immediately on start()) already succeeds, and a fast
    // (50ms) interval keeps it healthy for the whole suite (case 9).
    mockAgent.respondToHealth({
      status: 'ok',
      version: '1.0.0',
      uptime_seconds: 1,
      controller_id: '00000000-0000-0000-0000-0000000000c4',
      in_flight_tasks: 0,
      collectors: {},
    });
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000c4',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: {
          'tok-admin': { principal: 'admin:test', role: 'admin' },
          'tok-admin2': { principal: 'admin:two', role: 'admin' },
          'tok-viewer': { principal: 'viewer:v', role: 'viewer' },
          'tok-agent': { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        agent: { socket: agentSock, heartbeat_interval_ms: 50 },
        mcp: {
          allow_apply: true,
          confirmation: {
            approval_url_base: 'http://127.0.0.1:1',
            url_wait_seconds: 1,
            max_pending_per_principal: 50,
            max_pending_total: 1000,
            create_rate_per_minute: 600,
          },
        },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    // Each apply needs its OWN share: a running mock-agent task holds its
    // lease forever unless driven to a terminal task_progress event.
    for (const id of [
      'share-a',
      'share-b',
      'share-c',
      'share-d',
      'share-e',
      'share-f',
      'share-g',
      'share-h',
    ]) {
      seedShare(handle.state, id);
    }
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    await mockAgent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function planShareUpdate(
    token: string,
    shareId: string,
  ): Promise<{ plan_id: string; expected_revision: number }> {
    const res = await call(
      port,
      token,
      nextId('plan-share'),
      'shares.update',
      {
        id: shareId,
        mode: 'plan',
        spec: { clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }] },
      },
      {},
      FORM_ONLY,
    );
    const payload = payloadOf(res);
    const result = payload.result as { plan_id: string; state_revision_expected: number };
    return { plan_id: result.plan_id, expected_revision: result.state_revision_expected };
  }

  /**
   * Form-mode apply helper (task-10 brief §2): plan `shares.update` on a
   * fresh share, apply with `mode: 'apply'` (round 1 → `input_required`),
   * retry with the APPLY decision under the SAME capability set. Returns
   * both rounds plus everything needed to replay the retry under a
   * DIFFERENT capability set later (case 3).
   */
  async function applyFormAccept(
    token: string,
    shareId: string,
    caps: Record<string, unknown>,
  ): Promise<{
    plan_id: string;
    expected_revision: number;
    args: Record<string, unknown>;
    acceptExtra: Record<string, unknown>;
    first: RpcResult;
    second: RpcResult;
  }> {
    const { plan_id, expected_revision } = await planShareUpdate(token, shareId);
    const args = {
      id: shareId,
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: nextId('ik'),
    };
    const first = await call(port, token, nextId('call'), 'shares.update', args, {}, caps);
    const requestState = toolResultOf(first).requestState;
    const acceptExtra = {
      requestState,
      inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
    };
    const second = await call(
      port,
      token,
      nextId('call'),
      'shares.update',
      args,
      acceptExtra,
      caps,
    );
    return { plan_id, expected_revision, args, acceptExtra, first, second };
  }

  /** Drive a task through `/internal/v1/task_progress` (the real agent's push route), sequences 1..n. */
  async function progress(taskId: string, events: Array<Record<string, unknown>>): Promise<void> {
    let s = 0;
    for (const partial of events) {
      s += 1;
      const res = await internalCall(port, 'tok-agent', '/internal/v1/task_progress', {
        task_id: taskId,
        sequence: s,
        observed_at: new Date().toISOString(),
        ...partial,
      });
      if (res.status !== 200) {
        throw new Error(`task_progress POST failed (${res.status}): ${JSON.stringify(res.body)}`);
      }
    }
  }

  // ── 1. discover advertises the extension; tasks/get is served for it ─────

  it('server/discover advertises the extension under capabilities.extensions; a made-up id under tasks/get is -32602, not -32601 (served)', async () => {
    const disc = await rpc(
      port,
      { jsonrpc: '2.0', id: nextId('d'), method: 'server/discover', params: { _meta: META({}) } },
      { token: 'tok-admin' },
    );
    expect(disc.status).toBe(200);
    const result = disc.body.result as { capabilities?: { extensions?: unknown } };
    expect(result.capabilities?.extensions).toMatchObject({ 'io.modelcontextprotocol/tasks': {} });

    const res = await taskRpc(port, 'tasks/get', randomUUID(), 'tok-admin', TASKS_CAP);
    const err = rpcErrorOf(res);
    expect(err?.code).toBe(-32602);
    expect(err?.message).toBe('task not found or expired');
  });

  // ── 2. capability present → CreateTaskResult, taskId === REST task_id ────

  it('form apply with the Tasks capability returns a CreateTaskResult whose taskId matches the REST task, schema-valid', async () => {
    const { second } = await applyFormAccept('tok-admin', 'share-a', FORM_TASKS);
    const handleResult = resultOf(second);
    expect(handleResult.resultType).toBe('task');
    expect(typeof handleResult.taskId).toBe('string');
    const taskId = handleResult.taskId as string;

    const rest = await restGet(port, 'tok-admin', `/tasks/${taskId}`);
    expect(rest.status).toBe(200);
    const restTask = rest.body.result as {
      task_id: string;
      created_at: string;
      updated_at: string;
    };
    expect(restTask.task_id).toBe(taskId);
    expect(restTask.created_at).toBe(handleResult.createdAt);
    expect(restTask.updated_at).toBe(handleResult.lastUpdatedAt);

    expect(handleResult.status).toBe('working');
    expect(handleResult.ttlMs).toBeNull();
    expect(handleResult.pollIntervalMs).toBe(2000);

    expect(() => CreateTaskResultSchema.parse(handleResult)).not.toThrow();
  });

  // ── 3. capability absent → fallback; capability switching never duplicates execution ─

  it('fallback without the capability, then the identical retry under the capability returns the SAME task exactly once (no duplicate execution)', async () => {
    const { plan_id, args, acceptExtra, second } = await applyFormAccept(
      'tok-admin',
      'share-b',
      FORM_ONLY,
    );
    expect(toolResultOf(second).resultType).toBe('complete');
    const fallbackPayload = payloadOf(second);
    const taskId = (fallbackPayload.result as { task_id?: string } | undefined)?.task_id;
    expect(typeof taskId).toBe('string');
    expect(fallbackPayload.next?.tool).toBe('tasks.wait');

    // The IDENTICAL retry (same idempotency key, same args, same requestState)
    // now declaring the Tasks capability → a handle for the SAME task.
    const withTasks = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      args,
      acceptExtra,
      FORM_TASKS,
    );
    const handleResult = resultOf(withTasks);
    expect(handleResult.resultType).toBe('task');
    expect(handleResult.taskId).toBe(taskId);

    // Again without the capability → the same fallback task_id, still no duplicate.
    const withoutAgain = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      args,
      acceptExtra,
      FORM_ONLY,
    );
    expect((payloadOf(withoutAgain).result as { task_id?: string } | undefined)?.task_id).toBe(
      taskId,
    );

    expect(countTasksByPlan(plan_id)).toBe(1);

    await handle.state.drainer.drainNow();
    const rows = auditRows(dir);
    expect(
      rows.filter((r) => r.kind === 'mcp.task.handle_returned' && r.task_id === taskId).length,
    ).toBe(1);
    expect(
      rows.filter((r) => r.kind === 'mcp.confirmation.consumed' && r.payload?.plan_id === plan_id)
        .length,
    ).toBe(1);
  });

  // ── 4. tasks/get: -32021 without the capability; working → completed (success) ─

  it('tasks/get: -32021 without the capability (exact requiredCapabilities); with it, queued → running → completed(success), schema-valid, no plan_document/output_url', async () => {
    const { second } = await applyFormAccept('tok-admin', 'share-c', FORM_TASKS);
    const taskId = resultOf(second).taskId as string;

    const noCap = await taskRpc(port, 'tasks/get', taskId, 'tok-admin', {});
    expect(noCap.status).toBe(400);
    const err = rpcErrorOf(noCap);
    expect(err?.code).toBe(-32021);
    expect(err?.data?.requiredCapabilities).toEqual({
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    });

    const working = await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP);
    expect(working.status).toBe(200);
    const workingBody = resultOf(working);
    expect(workingBody.status).toBe('working');
    expect(String(workingBody.statusMessage)).toMatch(/queued|preparing/);

    await progress(taskId, [
      { event_type: 'accepted', stage_total: 3 },
      { event_type: 'stage_started', stage_index: 0, stage_name: 'apply' },
      { event_type: 'stage_succeeded', stage_index: 0, stage_name: 'apply' },
      { event_type: 'terminal', status: 'success', snapshot_id: 's' },
    ]);

    const done = await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP);
    expect(done.status).toBe(200);
    const doneBody = resultOf(done);
    expect(doneBody.status).toBe('completed');
    expect(typeof doneBody.ttlMs).toBe('number');
    expect(doneBody.ttlMs as number).toBeGreaterThanOrEqual(30 * 86400 * 1000);
    expect(doneBody.pollIntervalMs).toBeUndefined();

    const result = doneBody.result as { content: Array<{ type: 'text'; text: string }> };
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      result: { task_id: string; state: string; plan_document?: unknown; stages?: unknown[] };
    };
    expect(parsed.result.task_id).toBe(taskId);
    expect(parsed.result.state).toBe('success');
    expect(parsed.result).not.toHaveProperty('plan_document');
    expect(parsed.result).not.toHaveProperty('plan_document_hash');
    for (const stage of (parsed.result.stages ?? []) as Array<Record<string, unknown>>) {
      expect(stage).not.toHaveProperty('output_url');
    }

    expect(() => GetTaskResultSchema.parse(doneBody)).not.toThrow();

    completedTaskId = taskId;
  }, 15_000);

  // ── 5. failed / requires_manual_recovery → completed + isError ───────────

  it('a task driven to terminal failed, and another to requires_manual_recovery, both project completed + isError', async () => {
    const { second: second1 } = await applyFormAccept('tok-admin', 'share-d', FORM_TASKS);
    const failedId = resultOf(second1).taskId as string;
    await progress(failedId, [
      { event_type: 'accepted' },
      {
        event_type: 'terminal',
        status: 'failed',
        error_code: 'FAILED_PARTIAL_ROLLED_BACK',
        error_message: 'the mount step failed after a partial apply',
      },
    ]);
    const failedGet = await taskRpc(port, 'tasks/get', failedId, 'tok-admin', TASKS_CAP);
    const failedBody = resultOf(failedGet);
    expect(failedBody.status).toBe('completed');
    const failedResult = failedBody.result as { isError?: boolean };
    expect(failedResult.isError).toBe(true);

    const { second: second2 } = await applyFormAccept('tok-admin', 'share-e', FORM_TASKS);
    const manualId = resultOf(second2).taskId as string;
    await progress(manualId, [
      { event_type: 'accepted' },
      {
        event_type: 'terminal',
        status: 'requires_manual_recovery',
        error_code: 'FAILED_MANUAL_RECOVERY_REQUIRED',
        error_message: 'the executor needs an operator to reconcile the host',
      },
    ]);
    const manualGet = await taskRpc(port, 'tasks/get', manualId, 'tok-admin', TASKS_CAP);
    const manualBody = resultOf(manualGet);
    expect(manualBody.status).toBe('completed');
    const manualResult = manualBody.result as { isError?: boolean };
    expect(manualResult.isError).toBe(true);
    expect(String(manualBody.statusMessage)).toContain('requires manual recovery');
  }, 15_000);

  // ── 6. no existence oracle: plan_only, imported, cross-principal, role, random id ─

  it('plan_only and a synthetic imported row, a second principal, a role-insufficient cancel, and a random UUID all answer the SAME -32602 bytes', async () => {
    const { plan_id: planOnlyId } = await planShareUpdate('tok-admin', 'share-a');
    const planOnly = await taskRpc(port, 'tasks/get', planOnlyId, 'tok-admin', TASKS_CAP);
    expect(rpcErrorOf(planOnly)).toEqual({ code: -32602, message: 'task not found or expired' });

    // A synthetic `imported` row: a plan_only row promoted directly via SQL
    // (mirrors the S15 suite's direct-db style) — imported is equally
    // non-projectable (S16 §6.1).
    const { plan_id: importedId } = await planShareUpdate('tok-admin', 'share-a');
    handle.state.db
      .prepare(`UPDATE tasks SET state = 'imported' WHERE task_id = ?`)
      .run(importedId);
    const imported = await taskRpc(port, 'tasks/get', importedId, 'tok-admin', TASKS_CAP);
    expect(rpcErrorOf(imported)).toEqual({ code: -32602, message: 'task not found or expired' });

    const crossPrincipal = await taskRpc(
      port,
      'tasks/get',
      completedTaskId,
      'tok-admin2',
      TASKS_CAP,
    );
    const viewerCancel = await taskRpc(
      port,
      'tasks/cancel',
      completedTaskId,
      'tok-viewer',
      TASKS_CAP,
    );
    const randomId = await taskRpc(port, 'tasks/get', randomUUID(), 'tok-admin', TASKS_CAP);

    const fixed = { code: -32602, message: 'task not found or expired' };
    expect(rpcErrorOf(crossPrincipal)).toEqual(fixed);
    expect(rpcErrorOf(viewerCancel)).toEqual(fixed);
    expect(rpcErrorOf(randomId)).toEqual(fixed);
    expect(rpcErrorOf(crossPrincipal)).toEqual(rpcErrorOf(viewerCancel));
    expect(rpcErrorOf(viewerCancel)).toEqual(rpcErrorOf(randomId));
  });

  // ── 7. per-request capability is not cached ───────────────────────────────

  it('the Tasks capability is read per request, not cached: with it then without it on the same task', async () => {
    const withCap = await taskRpc(port, 'tasks/get', completedTaskId, 'tok-admin', TASKS_CAP);
    expect(withCap.status).toBe(200);
    const withoutCap = await taskRpc(port, 'tasks/get', completedTaskId, 'tok-admin', {});
    expect(rpcErrorOf(withoutCap)?.code).toBe(-32021);
  });

  // ── 8. tasks/update: no-op acknowledgement, audited by response keys only ─

  it('tasks/update acknowledges without changing the row; audits response_keys only; a malformed inputResponses is -32602', async () => {
    const before = handle.state.db
      .prepare('SELECT updated_at FROM tasks WHERE task_id = ?')
      .get(completedTaskId) as { updated_at: number };

    const res = await taskRpc(port, 'tasks/update', completedTaskId, 'tok-admin', TASKS_CAP, {
      inputResponses: { confirm_apply: { action: 'accept' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ resultType: 'complete' });

    const after = handle.state.db
      .prepare('SELECT updated_at FROM tasks WHERE task_id = ?')
      .get(completedTaskId) as { updated_at: number };
    expect(after.updated_at).toBe(before.updated_at);

    await handle.state.drainer.drainNow();
    const rows = auditRows(dir).filter(
      (r) => r.kind === 'mcp.task.update_accepted' && r.task_id === completedTaskId,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.payload?.detail).toEqual({ response_keys: ['confirm_apply'] });

    const bad = await taskRpc(port, 'tasks/update', completedTaskId, 'tok-admin', TASKS_CAP, {
      inputResponses: [],
    });
    expect(rpcErrorOf(bad)?.code).toBe(-32602);
  });

  // ── 9. tasks/cancel: accepted, irreversible refusal, refusal on a terminal task ─

  it('tasks/cancel acknowledges every core verdict; REST + audit reflect accepted vs irreversible-refused vs refused', async () => {
    // accepted, on a running task
    mockAgent.respondToTaskCancel({ cancel_requested: true });
    const { second: acceptedSecond } = await applyFormAccept('tok-admin', 'share-f', FORM_TASKS);
    const runningId = resultOf(acceptedSecond).taskId as string;
    await progress(runningId, [{ event_type: 'accepted', stage_total: 1 }]);
    const acceptedCancel = await taskRpc(port, 'tasks/cancel', runningId, 'tok-admin', TASKS_CAP);
    expect(acceptedCancel.status).toBe(200);
    expect(acceptedCancel.body.result).toEqual({ resultType: 'complete' });
    const acceptedRest = await restGet(port, 'tok-admin', `/tasks/${runningId}`);
    expect(
      (acceptedRest.body.result as { cancel_requested_at?: unknown }).cancel_requested_at,
    ).not.toBeUndefined();

    // refused: the operation passed its point of no return
    mockAgent.respondToTaskCancel({
      cancel_requested: false,
      reason: 'irreversible_stage_started',
      stage: 'mkfs',
    });
    const { second: irrSecond } = await applyFormAccept('tok-admin', 'share-g', FORM_TASKS);
    const irrId = resultOf(irrSecond).taskId as string;
    await progress(irrId, [{ event_type: 'accepted', stage_total: 1 }]);

    await handle.state.drainer.drainNow();
    const before = auditRows(dir).length;
    const irrCancel = await taskRpc(port, 'tasks/cancel', irrId, 'tok-admin', TASKS_CAP);
    expect(irrCancel.status).toBe(200);
    expect(irrCancel.body.result).toEqual({ resultType: 'complete' });
    const irrRest = await restGet(port, 'tok-admin', `/tasks/${irrId}`);
    expect((irrRest.body.result as { cancel_refused_reason?: string }).cancel_refused_reason).toBe(
      'irreversible_stage_started',
    );
    await handle.state.drainer.drainNow();
    const irrRows = auditRows(dir).slice(before);
    expect(
      irrRows.some((r) => r.kind === 'mcp.task.cancel_refused_irreversible' && r.task_id === irrId),
    ).toBe(true);
    const irrGet = await taskRpc(port, 'tasks/get', irrId, 'tok-admin', TASKS_CAP);
    expect(String(resultOf(irrGet).statusMessage)).toContain('no longer safely stop');

    // reset the mock agent so later tests aren't affected by the refusal reply
    mockAgent.respondToTaskCancel({ cancel_requested: true });

    // refused: already terminal (success) — the core never reaches the agent
    const { second: successSecond } = await applyFormAccept('tok-admin', 'share-h', FORM_TASKS);
    const successId = resultOf(successSecond).taskId as string;
    await progress(successId, [
      { event_type: 'accepted' },
      { event_type: 'terminal', status: 'success', snapshot_id: 'sh' },
    ]);
    await handle.state.drainer.drainNow();
    const beforeRefused = auditRows(dir).length;
    const refusedCancel = await taskRpc(port, 'tasks/cancel', successId, 'tok-admin', TASKS_CAP);
    expect(refusedCancel.status).toBe(200);
    expect(refusedCancel.body.result).toEqual({ resultType: 'complete' });
    await handle.state.drainer.drainNow();
    const refusedRows = auditRows(dir).slice(beforeRefused);
    expect(
      refusedRows.some(
        (r) =>
          r.kind === 'mcp.task.cancel_requested' &&
          r.task_id === successId &&
          r.payload?.detail !== undefined &&
          (r.payload.detail as { outcome?: string }).outcome === 'refused',
      ),
    ).toBe(true);

    // Every audit outcome enumerated by S16 §10.2 was exercised above.
    const allRows = auditRows(dir);
    expect(
      allRows.some(
        (r) =>
          r.kind === 'mcp.task.cancel_requested' &&
          (r.payload?.detail as { outcome?: string } | undefined)?.outcome === 'accepted',
      ),
    ).toBe(true);
    expect(
      allRows.some(
        (r) =>
          r.kind === 'mcp.task.cancel_requested' &&
          (r.payload?.detail as { outcome?: string } | undefined)?.outcome === 'refused',
      ),
    ).toBe(true);
  }, 15_000);

  // ── 10. Streamable HTTP header agreement (S16 §5.6) ───────────────────────

  it('task-method headers: wrong Mcp-Name / missing Mcp-Method / mismatched protocol version → -32020/400; base64 sentinel and header-less tools/call both succeed', async () => {
    const wrongName = await taskRpc(
      port,
      'tasks/get',
      completedTaskId,
      'tok-admin',
      TASKS_CAP,
      {},
      {
        'mcp-method': 'tasks/get',
        'mcp-name': 'other',
        'mcp-protocol-version': '2026-07-28',
      },
    );
    expect(wrongName.status).toBe(400);
    expect(rpcErrorOf(wrongName)?.code).toBe(-32020);
    expect(rpcErrorOf(wrongName)?.message).toContain('Mcp-Name');

    const missingMethod = await taskRpc(
      port,
      'tasks/get',
      completedTaskId,
      'tok-admin',
      TASKS_CAP,
      {},
      { 'mcp-name': completedTaskId, 'mcp-protocol-version': '2026-07-28' },
    );
    expect(missingMethod.status).toBe(400);
    expect(rpcErrorOf(missingMethod)?.code).toBe(-32020);
    expect(rpcErrorOf(missingMethod)?.message).toContain('Mcp-Method');

    const encoded = await taskRpc(
      port,
      'tasks/get',
      completedTaskId,
      'tok-admin',
      TASKS_CAP,
      {},
      {
        'mcp-method': 'tasks/get',
        'mcp-name': encodeMcpHeaderValue(completedTaskId),
        'mcp-protocol-version': '2026-07-28',
      },
    );
    expect(encoded.status).toBe(200);

    const badVersion = await taskRpc(
      port,
      'tasks/get',
      completedTaskId,
      'tok-admin',
      TASKS_CAP,
      {},
      {
        'mcp-method': 'tasks/get',
        'mcp-name': completedTaskId,
        'mcp-protocol-version': '2025-11-25',
      },
    );
    expect(badVersion.status).toBe(400);
    expect(rpcErrorOf(badVersion)?.code).toBe(-32020);

    const noHeaders = await call(
      port,
      'tok-admin',
      nextId('call'),
      'arrays.list',
      {},
      {},
      FORM_ONLY,
    );
    expect(noHeaders.status).toBe(200);
    expect(toolResultOf(noHeaders).resultType).toBe('complete');
  });

  // ── 11. absent methods, legacy era ─────────────────────────────────────

  it('tasks/list and tasks/result are -32601; a legacy 2025-11-25 session never sees tasks/get or a task handle', async () => {
    const list = await taskRpc(port, 'tasks/list', completedTaskId, 'tok-admin', TASKS_CAP);
    expect(rpcErrorOf(list)?.code).toBe(-32601);
    const resultMethod = await taskRpc(
      port,
      'tasks/result',
      completedTaskId,
      'tok-admin',
      TASKS_CAP,
    );
    expect(rpcErrorOf(resultMethod)?.code).toBe(-32601);

    interface LegacyOut {
      status: number;
      body: Record<string, unknown>;
      session?: string;
    }
    function legacyRpc(message: unknown, session?: string): Promise<LegacyOut> {
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
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy', version: '0' },
      },
    });
    const session = init.session as string;

    const legacyGet = await legacyRpc(
      { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: completedTaskId } },
      session,
    );
    expect((legacyGet.body.error as { code?: number } | undefined)?.code).toBe(-32601);

    const bundle = await legacyRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'support.bundle', arguments: {} },
      },
      session,
    );
    const bundleResult = bundle.body.result as
      | { resultType?: string; taskId?: string; content?: unknown }
      | undefined;
    expect(bundleResult?.resultType).toBeUndefined();
    expect(bundleResult?.taskId).toBeUndefined();
  });

  // ── 12. composition with S15 MRTR (no task before accept) ────────────────

  it('MRTR: input_required and a decline create no task row; the accepted retry produces the handle, and the confirmation is consumed_task_id-linked', async () => {
    const { plan_id, expected_revision } = await planShareUpdate('tok-admin', 'share-a');
    const declineArgs = {
      id: 'share-a',
      mode: 'apply',
      plan_id,
      expected_revision,
      idempotency_key: nextId('ik'),
    };
    const first = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      declineArgs,
      {},
      FORM_TASKS,
    );
    expect(toolResultOf(first).resultType).toBe('input_required');
    expect(countTasksByPlan(plan_id)).toBe(0);

    const decline = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      declineArgs,
      {
        requestState: toolResultOf(first).requestState,
        inputResponses: { confirm_apply: { action: 'decline' } },
      },
      FORM_TASKS,
    );
    expect(payloadOf(decline).error?.code).toBe('CONFIRMATION_DECLINED');
    expect(countTasksByPlan(plan_id)).toBe(0);

    // A fresh plan, accepted this time.
    const { second } = await applyFormAccept('tok-admin', 'share-c', FORM_TASKS);
    const handleResult = resultOf(second);
    expect(handleResult.resultType).toBe('task');
    const taskId = handleResult.taskId as string;

    const rec = handle.state.db
      .prepare('SELECT consumed_task_id FROM mcp_confirmations WHERE consumed_task_id = ?')
      .get(taskId) as { consumed_task_id: string } | undefined;
    expect(rec?.consumed_task_id).toBe(taskId);
  });

  // ── 12b. S15 follow-up: cancel does not disturb the consumed record ──────

  it('tasks/cancel after an MRTR-gated apply leaves the confirmation record consumed, and the identical retry still answers the SAME task (no re-elicitation)', async () => {
    const freshShare = 'share-cancel-consumed';
    seedShare(handle.state, freshShare);
    // Belt and braces: case 9 above already leaves the mock agent set to
    // accept a cancel, but this test's assertion is about the CONFIRMATION
    // record, not the cancel verdict — pin the agent's reply explicitly so
    // this test does not silently depend on suite ordering.
    mockAgent.respondToTaskCancel({ cancel_requested: true });

    const { plan_id, args, acceptExtra, second } = await applyFormAccept(
      'tok-admin',
      freshShare,
      FORM_TASKS,
    );
    const handleResult = resultOf(second);
    expect(handleResult.resultType).toBe('task');
    const taskId = handleResult.taskId as string;

    function getConfirmation(): { status: string; consumed_task_id: string | null } | undefined {
      return handle.state.db
        .prepare('SELECT status, consumed_task_id FROM mcp_confirmations WHERE plan_id = ?')
        .get(plan_id) as { status: string; consumed_task_id: string | null } | undefined;
    }

    const beforeCancel = getConfirmation();
    expect(beforeCancel?.status).toBe('consumed');
    expect(beforeCancel?.consumed_task_id).toBe(taskId);

    // Move the task past 'queued' so the cancel exercises a real running
    // task. Either core verdict (accepted, or refused because the operation
    // is past its point of no return) is fine here — the property under
    // test is the confirmation record, not the cancel outcome itself (S16
    // Task 10 case 9, above, already covers every cancel verdict).
    await progress(taskId, [{ event_type: 'accepted', stage_total: 1 }]);
    const cancel = await taskRpc(port, 'tasks/cancel', taskId, 'tok-admin', TASKS_CAP);
    expect(cancel.status).toBe(200);
    expect(cancel.body.result).toEqual({ resultType: 'complete' });

    // The confirmation record is untouched by the cancel: still consumed,
    // still linked to the SAME task. Cancel is a task-lifecycle operation,
    // not a confirmation-lifecycle one — a future refactor that let a
    // cancel reopen or reissue the confirmation record would be a gate
    // reordering bug, exactly what this pins against.
    const afterCancel = getConfirmation();
    expect(afterCancel?.status).toBe('consumed');
    expect(afterCancel?.consumed_task_id).toBe(taskId);

    // The identical retry (same requestState + inputResponses, same args)
    // must still answer the SAME task — no re-elicitation, no second task —
    // even though the underlying task has since been asked to cancel.
    const replay = await call(
      port,
      'tok-admin',
      nextId('call'),
      'shares.update',
      args,
      acceptExtra,
      FORM_TASKS,
    );
    const replayResult = resultOf(replay);
    expect(replayResult.resultType).toBe('task');
    expect(replayResult.taskId).toBe(taskId);
    expect(countTasksByPlan(plan_id)).toBe(1);

    const finalConfirmation = getConfirmation();
    expect(finalConfirmation?.status).toBe('consumed');
    expect(finalConfirmation?.consumed_task_id).toBe(taskId);
  }, 15_000);

  // ── 13. polling is read-only ───────────────────────────────────────────

  it('ten tasks/get in a row leave lastUpdatedAt unchanged and write no new audit rows', async () => {
    await handle.state.drainer.drainNow();
    const totalBefore = auditRows(dir).length;
    let lastUpdatedAt: unknown;
    for (let i = 0; i < 10; i += 1) {
      const res = await taskRpc(port, 'tasks/get', completedTaskId, 'tok-admin', TASKS_CAP);
      expect(res.status).toBe(200);
      const body = resultOf(res);
      if (lastUpdatedAt === undefined) lastUpdatedAt = body.lastUpdatedAt;
      else expect(body.lastUpdatedAt).toBe(lastUpdatedAt);
    }
    await handle.state.drainer.drainNow();
    expect(auditRows(dir).length).toBe(totalBefore);
  });
});
