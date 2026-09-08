import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../../api/server.js';
import { type HandoffArguments, handoffArguments } from '../../../mcp-apps/plan-facts.js';
import { type MockAgentServer, startMockAgentServer } from '../_helpers.js';

/**
 * Task 7 (S-03) composition test — proves the handoff arguments built by
 * `handoffArguments()` (`mcp-apps/plan-facts.ts`) drive a real `arrays.create`
 * apply through the S15 MRTR confirmation flow into BOTH result shapes a
 * host can receive on the final confirmation retry (S16 §8 item 4): the
 * fallback `resultType: "complete"` + `tasks.wait` next hint, and the native
 * `resultType: "task"` handle followed to a terminal, `isError`-carrying
 * `tasks/get` result.
 *
 * Modeled on `mcp-tasks.test.ts` (S16 Task 10) — same `rpc`/`internalCall`/
 * `META`/`call`/`taskRpc`/`toolResultOf`/`payloadOf`/`resultOf`/`nextId`/
 * `progress` helper shapes and the same server `beforeAll` config, copied
 * here rather than imported from a test file. Disks are seeded instead of
 * shares — the RAID Create App plans `xiraid.array.create`, not
 * `shares.update`.
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

/** Seed one observed Disk (the RAID Create plan provider's inventory source). */
function seedDisk(handle: Awaited<ReturnType<typeof startServer>>, index: number): string {
  const id = `serial-disk-${index}`;
  handle.state.kv.put(`/xinas/v1/observed/Disk/${id}`, {
    kind: 'Disk',
    id,
    status: {
      device_path: `/dev/nvme${index}n1`,
      serial: `S-${index}`,
      model: 'X',
      capacity_bytes: 1_000_000_000_000,
      safe_for_use: true,
      system_disk: false,
      mounted: false,
      observed_at: new Date().toISOString(),
    },
  });
  return id;
}

describe('RAID Create App handoff → MRTR → task result (S18 §8, S-03)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let mockAgent: MockAgentServer;
  let port: number;
  let disks: string[];

  function countTasksByPlan(planId: string): number {
    return (
      handle.state.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?').get(planId) as {
        n: number;
      }
    ).n;
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

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-apps-handoff-'));
    const agentSock = join(dir, 'agent.sock');
    mockAgent = await startMockAgentServer(agentSock);
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
    disks = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => seedDisk(handle, index));
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    await mockAgent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function planArray(
    name: string,
    members: string[],
  ): Promise<{ plan_id: string; state_revision_expected?: number }> {
    const res = await call(port, 'tok-admin', nextId('plan'), 'arrays.create', {
      mode: 'plan',
      spec: {
        name,
        level: 'raid5',
        member_disk_ids: members,
        strip_size_kib: 128,
        block_size: 4096,
      },
    });
    const result = payloadOf(res).result as {
      plan_id: string;
      state_revision_expected?: number;
      blockers?: unknown[];
    };
    expect(result.blockers ?? []).toEqual([]);
    return result;
  }

  async function applyWithHandoff(
    args: HandoffArguments,
    caps: Record<string, unknown>,
  ): Promise<RpcResult> {
    const wireArgs: Record<string, unknown> = { ...args };
    const first = await call(
      port,
      'tok-admin',
      nextId('call'),
      'arrays.create',
      wireArgs,
      {},
      caps,
    );
    expect(toolResultOf(first).resultType).toBe('input_required');
    expect(toolResultOf(first).inputRequests?.confirm_apply?.params.mode).toBe('form');
    return call(
      port,
      'tok-admin',
      nextId('call'),
      'arrays.create',
      wireArgs,
      {
        requestState: toolResultOf(first).requestState,
        inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
      },
      caps,
    );
  }

  it('fallback: the exact handoff arguments reach a task with a tasks.wait next hint', async () => {
    const plan = await planArray('data_a', disks.slice(0, 4));
    const args = handoffArguments(plan, randomUUID());
    const second = await applyWithHandoff(args, FORM_ONLY);
    expect(toolResultOf(second).resultType).toBe('complete');
    const payload = payloadOf(second);
    const taskId = (payload.result as { task_id?: string })?.task_id;
    expect(typeof taskId).toBe('string');
    expect(payload.next).toMatchObject({ tool: 'tasks.wait', args: { id: taskId, timeout_s: 25 } });
    expect(countTasksByPlan(plan.plan_id)).toBe(1);
  });

  it('native: the same arguments under the Tasks capability return a task handle; tasks/get reaches completed with isError telling success from failure', async () => {
    const plan = await planArray('data_b', disks.slice(4, 8));
    const args = handoffArguments(plan, randomUUID());
    const second = await applyWithHandoff(args, FORM_TASKS);
    const body = resultOf(second);
    expect(body.resultType).toBe('task');
    const taskId = body.taskId as string;
    expect(typeof taskId).toBe('string');
    expect(typeof body.pollIntervalMs).toBe('number');
    expect(countTasksByPlan(plan.plan_id)).toBe(1);

    let got = resultOf(await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP));
    expect(got.status).toBe('working');
    await progress(taskId, [
      { event_type: 'accepted' },
      {
        event_type: 'terminal',
        status: 'failed',
        error_code: 'FAILED_PARTIAL_ROLLED_BACK',
        error_message: 'the mount step failed after a partial apply',
      },
    ]);
    got = resultOf(await taskRpc(port, 'tasks/get', taskId, 'tok-admin', TASKS_CAP));
    expect(got.status).toBe('completed'); // "completed" is the protocol word, not success
    expect((got.result as { isError?: boolean }).isError).toBe(true);
    expect(got.pollIntervalMs).toBeUndefined();
  }, 15_000);
});
