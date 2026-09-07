// @vitest-environment node
/**
 * End-to-end (S16 Task 13, spec §9 / §16.4): the mandatory `filesystems.create`
 * scenario over TWO REAL processes (xinas-api + xinas-agent, UNIX sockets,
 * fixture probe mode, the fake filesystem host with a deliberately BLOCKED
 * `mkfs`) — proving the `io.modelcontextprotocol/tasks` extension end to end:
 * a plan/apply over MCP returns a task handle while `mkfs` is held open,
 * `tasks/get` reports honest progress (no percentage, the correct stage
 * position, the long-stage disclaimer), a cancel sent during `mkfs` is
 * acknowledged but refused (the operation passed its point of no return), the
 * handle survives an api restart, releasing `mkfs` completes the task with a
 * clean terminal projection, and a task that is merely QUEUED (never touched
 * `mkfs`) can still be cancelled.
 *
 * Harness modeled on:
 *  - `filesystem-adapter.test.ts` — process spawning, fixture layout
 *    (`xiraid-state.json`, `disks.json`, `filesystems.json`,
 *    `fs-host-state.json`), the python3 xinas_history-bridge shim,
 *    `waitForApi`/`waitForAgentReady`.
 *  - `task-cancel.test.ts` — the `tasks: { max_inflight: 1 }` pool cap that
 *    makes queueing trivial to force.
 *  - `mcp-tasks.test.ts` (Task 10's wire suite) — the JSON-RPC shapes
 *    (`META`, `TASKS_CAP`, `taskRpc`'s `Mcp-Method`/`Mcp-Name`/
 *    `MCP-Protocol-Version` headers).
 *  - `mcp-confirmation.test.ts` (S15 Task 10/11) — the url-mode elicitation
 *    flow (`filesystems.create` is ALWAYS url-mode: `rollback_model:
 *    'unsupported'` maps to `url` regardless of `force`, S16 §9.1) and the
 *    REST `POST /mcp/confirmations/:id/approve` happy path.
 *
 * The fake `FsHost`'s block gate (`src/agent/fs/fake-host.ts`): a device path
 * ending `-block` OR `_block` holds `mkfsXfs` until `<fixtureDir>/mkfs-release`
 * exists. Both create targets here (`data_block`, `data2_block`) are fixture
 * xiRAID arrays exposed as volumes `/dev/xi_data_block` / `/dev/xi_data2_block`
 * (`src/lib/parse/raid.ts`: `volume_path: /dev/xi_${name}`).
 *
 * Two deviations from the task-13 brief / spec §16.4, both confirmed against
 * shipped code rather than assumed:
 *
 *  1. The brief and spec §16.4 both name the create target `/dev/xi_data-block`
 *     (hyphen). A REAL xiRAID array name cannot contain a hyphen — CI-gated
 *     in `docs/control-path/api-v1.yaml` (`pattern: "^[A-Za-z0-9_]{1,28}$"`)
 *     and in code as `NAME_RE` (`src/lib/xiraid/schema.ts`), both citing
 *     xiRAID's own `xicli raid create -n` reference. `/dev/xi_${name}` can
 *     therefore never end in `-block` for an array actually observed through
 *     the real plan/apply pipeline (confirmed empirically: the agent's
 *     observation batch is rejected 400 INVALID_ARGUMENT before any plan
 *     ever sees the array). Task 3's own unit test reaches `-block` only by
 *     calling `host.mkfsXfs(['-f', '/dev/xi_data-block'])` directly, bypassing
 *     array-name validation entirely — not a path available to an e2e test
 *     that must go through real validation. Fix (fixture-shape, not a
 *     production defect): use schema-valid array names ending `_block`
 *     (`data_block`, `data2_block`) and extend the fake host's gate to also
 *     recognize the `_block` suffix (`src/agent/fs/fake-host.ts`, additive —
 *     the existing `-block` convention and Task 3's test are unchanged).
 *  2. Confirmed against the actual `ConfirmationService.operatorDecide`
 *     acknowledge table (`src/api/mcp/confirmation/service.ts`): the brief
 *     says a REST approval body of `{}` suffices because this create is
 *     "non-destructive". That table keys the required `acknowledge` phrase
 *     off `rollback_model === 'unsupported'` FIRST (before `risk_level`), and
 *     `fsCreateProvider` returns `rollback_model: 'unsupported'` for every
 *     create — force or not (S16 §9.1). So this (non-force) create's
 *     approval requires `ACK_NO_ROLLBACK` ("ROLLBACK IS NOT SUPPORTED"),
 *     exactly like the S15 suite's own `planFsCreateForce` cases.
 *
 * Both are harness/fixture corrections to an inaccurate brief description,
 * not production defects — see the report for the full analysis.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeFsHost, mkfsReleasePath } from '../../agent/fs/fake-host.js';
import { ACK_NO_ROLLBACK } from '../../api/mcp/confirmation/types.js';
import { openStateStore } from '../../state/index.js';
import { waitForAgentReady } from './_helpers.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000fc13';
const ADMIN_TOKEN = 'e2e-admin-tok';
const ADMIN2_TOKEN = 'e2e-admin2-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;
const PROTOCOL_VERSION = '2026-07-28';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── wire helpers ────────────────────────────────────────────────────────────

interface RpcResult {
  status: number;
  body: Record<string, unknown>;
}

/** POST one JSON-RPC message to /mcp over the UDS. */
function rpc(
  socketPath: string,
  message: unknown,
  opts: { token?: string; headers?: Record<string, string> } = {},
): Promise<RpcResult> {
  const payload = JSON.stringify(message);
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
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
          try {
            resolveP({
              status: res.statusCode ?? 0,
              body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** REST call under /api/v1 over the UDS. */
function restCall(
  socketPath: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path: `/api/v1${path}`,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolveP({
              status: res.statusCode ?? 0,
              body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const restGet = (
  socketPath: string,
  token: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  restCall(socketPath, token, 'GET', path);

async function waitForApi(socketPath: string, token: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await restGet(socketPath, token, '/capabilities');
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`API at ${socketPath} did not become ready within ${timeoutMs}ms`);
}

// ── MCP tools/call + tasks/* helpers (S16 §5.6, §16.2 wire shapes) ──────────

const TASKS_CAP = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
/** The create scenarios need BOTH elicitation modes: `filesystems.create` is
 * always url-mode (S16 §9.1), so `url` must be declared alongside `form`. */
const BOTH_TASKS = { elicitation: { form: {}, url: {} }, ...TASKS_CAP };

const META = (caps: Record<string, unknown>) => ({
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'e2e-mcp-tasks-fs-create', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': caps,
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function call(
  socketPath: string,
  token: string,
  id: string | number,
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
  caps: Record<string, unknown>,
): Promise<RpcResult> {
  return rpc(
    socketPath,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { _meta: META(caps), name, arguments: args, ...extra },
    },
    { token },
  );
}

/** The three `io.modelcontextprotocol/tasks` methods (S16 §5.2/§5.4) — headers mirrored per §5.6. */
function taskRpc(
  socketPath: string,
  method: 'tasks/get' | 'tasks/cancel',
  taskId: string,
  token: string,
  caps: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    'mcp-method': method,
    'mcp-name': taskId,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  return rpc(
    socketPath,
    { jsonrpc: '2.0', id: nextId('t'), method, params: { _meta: META(caps), taskId, ...extra } },
    { token, headers },
  );
}

interface ToolResultBody {
  resultType?: string;
  content?: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState?: string;
}

/** The raw `result` of a tools/call response (input_required / task handle shapes). */
function toolResultOf(res: RpcResult): ToolResultBody {
  return (res.body.result ?? {}) as ToolResultBody;
}

/** The raw `result` of a task-method response (flat CreateTaskResult / DetailedTask). */
function resultOf(res: RpcResult): Record<string, unknown> {
  return (res.body.result ?? {}) as Record<string, unknown>;
}

interface ToolPayload {
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Parse the JSON text body of a COMPLETE (non-input_required, non-task) tool result. */
function payloadOf(res: RpcResult): ToolPayload {
  const r = toolResultOf(res);
  if (r.content === undefined) return {};
  return JSON.parse(r.content[0]?.text ?? '{}') as ToolPayload;
}

// ── audit ────────────────────────────────────────────────────────────────

interface AuditRow {
  kind?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
}

function auditRows(auditPath: string): AuditRow[] {
  try {
    return readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRow);
  } catch {
    return [];
  }
}

async function waitForAuditRow(
  auditPath: string,
  predicate: (r: AuditRow) => boolean,
  timeoutMs = 8000,
): Promise<AuditRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = auditRows(auditPath).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `no audit row matched within ${timeoutMs}ms; rows=${JSON.stringify(auditRows(auditPath))}`,
      );
    }
    await sleep(150);
  }
}

// ── tasks/get polling ────────────────────────────────────────────────────

async function pollTasksGet(
  socketPath: string,
  taskId: string,
  predicate: (body: Record<string, unknown>) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  for (;;) {
    const res = await taskRpc(socketPath, 'tasks/get', taskId, ADMIN_TOKEN, TASKS_CAP);
    if (res.status !== 200) {
      throw new Error(`tasks/get ${taskId} failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    last = resultOf(res);
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`tasks/get ${taskId} never matched predicate; last=${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
  }
}

// ── confirmation approval ────────────────────────────────────────────────

/** Extract the confirmation id from an `input_required` url-mode result's `params.url`. */
function confirmationIdFromUrl(url: string): string {
  const id = url.split('/').pop();
  if (id === undefined || id.length === 0) {
    throw new Error(`could not extract a confirmation id from url ${url}`);
  }
  return id;
}

/** Approve a url-mode confirmation over REST as a SECOND admin principal (distinct_principal policy). */
async function approveConfirmation(
  socketPath: string,
  confirmationId: string,
): Promise<Record<string, unknown>> {
  const res = await restCall(
    socketPath,
    ADMIN2_TOKEN,
    'POST',
    `/mcp/confirmations/${confirmationId}/approve`,
    { acknowledge: ACK_NO_ROLLBACK },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const record = res.body.result as Record<string, unknown>;
  expect(record.status).toBe('approved');
  return record;
}

describe.sequential(
  'e2e: S16 MCP Tasks — blocked mkfs create, restart, refused cancel, terminal result',
  () => {
    let tmpDir: string;
    let fixtureDir: string;
    let apiSockPath: string;
    let agentSockPath: string;
    let apiConfigPath: string;
    let agentConfigPath: string;
    let auditPath: string;
    let shimBin: string;
    let apiProc: ChildProcess | undefined;
    let agentProc: ChildProcess | undefined;
    let fakeHost: ReturnType<typeof createFakeFsHost>;
    const apiStderr: string[] = [];
    const agentStderr: string[] = [];

    /** Scenario 1's task handle, reused by scenarios 2-5. */
    let taskId: string;

    function withAgentStderr(err: unknown): Error {
      const msg = err instanceof Error ? err.message : String(err);
      return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
    }

    async function spawnApi(): Promise<ChildProcess> {
      const proc = spawn(process.execPath, [API_ENTRY], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, XINAS_API_CONFIG: apiConfigPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Assign to the outer handle BEFORE awaiting readiness: if waitForApi
      // times out below, the throw must not orphan an already-running child
      // that afterAll can no longer reach to kill.
      apiProc = proc;
      proc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
      try {
        await waitForApi(apiSockPath, ADMIN_TOKEN);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- api stderr ---\n${apiStderr.join('')}`);
      }
      return proc;
    }

    async function spawnAgent(): Promise<ChildProcess> {
      const proc = spawn(process.execPath, [AGENT_ENTRY], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PATH: `${shimBin}:${process.env.PATH ?? ''}`,
          XINAS_AGENT_CONFIG_PATH: agentConfigPath,
          XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
          XINAS_AGENT_XIRAID_POLL_MS: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Same reasoning as spawnApi(): assign before awaiting readiness so a
      // waitForAgentReady timeout still leaves the child reachable by afterAll.
      agentProc = proc;
      proc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));
      try {
        await waitForAgentReady(apiSockPath, ADMIN_TOKEN, {
          diagnostics: () => agentStderr.join('').slice(-2000),
        });
      } catch (err) {
        throw withAgentStderr(err);
      }
      return proc;
    }

    beforeAll(async () => {
      if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
        execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
      }

      tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-mcp-tasks-fs-'));
      apiSockPath = join(tmpDir, 'api.sock');
      agentSockPath = join(tmpDir, 'agent.sock');
      const dbPath = join(tmpDir, 'xinas.db');
      auditPath = join(tmpDir, 'audit.jsonl');
      apiConfigPath = join(tmpDir, 'api-config.json');
      agentConfigPath = join(tmpDir, 'agent-config.json');
      const controllerIdPath = join(tmpDir, 'controller-id');
      const agentTokenPath = join(tmpDir, 'agent-token');

      writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
      writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

      fixtureDir = join(tmpDir, 'fixtures');
      mkdirSync(fixtureDir, { recursive: true });

      // Observed XiraidArrays: two '_block' create targets + the shared log
      // array. Names carry the '_block' suffix because volume_path is
      // `/dev/xi_${name}` (src/lib/parse/raid.ts) and the fake FsHost's block
      // gate keys off the DEVICE path's suffix (S16 §16.4) — see the file
      // header for why '_block' (underscore) rather than the spec's '-block'.
      writeFileSync(
        join(fixtureDir, 'xiraid-state.json'),
        JSON.stringify({
          arrays: [
            {
              name: 'data_block',
              level: '5',
              devices: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
              state: 'online',
              strip_size: 128,
            },
            {
              name: 'data2_block',
              level: '5',
              devices: ['/dev/nvme5n1', '/dev/nvme6n1', '/dev/nvme7n1', '/dev/nvme8n1'],
              state: 'online',
              strip_size: 128,
            },
            {
              name: 'log',
              level: '1',
              devices: ['/dev/nvme9n1', '/dev/nvme10n1'],
              state: 'online',
              strip_size: 16,
            },
          ],
          pools: [],
          import_candidates: [],
          tombstones: [],
        }),
      );
      writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
      writeFileSync(join(fixtureDir, 'filesystems.json'), JSON.stringify([]));

      fakeHost = createFakeFsHost(fixtureDir);
      writeFileSync(
        join(fixtureDir, 'fs-host-state.json'),
        JSON.stringify({
          blkid: {},
          device_sizes: { '/dev/xi_log': 536870912 },
          units: {},
          mounted: [],
          statfs: {},
          ops: [],
        }),
      );

      shimBin = join(tmpDir, 'bin');
      mkdirSync(shimBin, { recursive: true });
      const python3Shim = join(shimBin, 'python3');
      writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
        mode: 0o755,
      });
      chmodSync(python3Shim, 0o755);

      const seedStore = await openStateStore({
        databasePath: dbPath,
        auditJsonlPath: auditPath,
        nodeId: CONTROLLER_ID,
      });
      seedStore.kv.put('/xinas/v1/cluster', {
        kind: 'Cluster',
        id: 'default',
        spec: { display_name: 'e2e-mcp-tasks-fs' },
        status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
      });
      seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
        kind: 'Node',
        id: CONTROLLER_ID,
        spec: { hostname: 'e2e-mcp-tasks-fs-host' },
        status: { agent_state: 'offline', observation_age_seconds: 0 },
      });
      await seedStore.close();

      writeFileSync(
        apiConfigPath,
        JSON.stringify({
          controller_id: CONTROLLER_ID,
          listen: { kind: 'unix', socket: apiSockPath },
          tokens: {
            [ADMIN_TOKEN]: { principal: 'admin:e2e', role: 'admin' },
            [ADMIN2_TOKEN]: { principal: 'admin:two', role: 'admin' },
            [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
          },
          state: { databasePath: dbPath, auditJsonlPath: auditPath },
          agent: { socket: agentSockPath, heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
          mcp: {
            allow_apply: true,
            confirmation: { approval_url_base: 'http://127.0.0.1:1', url_wait_seconds: 1 },
          },
          tasks: { max_inflight: 1 },
          // support.bundle (scenario 6) defaults to /var/log/xinas/bundles,
          // which a non-root test process cannot create — redirect under tmpDir.
          support_bundle_dir: join(tmpDir, 'bundles'),
        }),
      );

      writeFileSync(
        agentConfigPath,
        JSON.stringify({
          api_socket: apiSockPath,
          agent_socket: agentSockPath,
          controller_id_path: controllerIdPath,
          agent_token_path: agentTokenPath,
          socket_group: 'nogroup',
        }),
      );

      apiProc = await spawnApi();
      agentProc = await spawnAgent();

      // Every plan below resolves backing/log devices against OBSERVED
      // XiraidArray volumes — wait for all three before touching any of them.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await restGet(apiSockPath, ADMIN_TOKEN, '/arrays');
        const rows = res.status === 200 && Array.isArray(res.body.result) ? res.body.result : [];
        if (rows.length >= 3) break;
        if (Date.now() > deadline) {
          throw withAgentStderr(
            new Error(`observed arrays never reached 3: ${JSON.stringify(res.body)}`),
          );
        }
        await sleep(200);
      }
    }, 200_000);

    afterAll(async () => {
      for (const p of [agentProc, apiProc]) {
        if (p && p.exitCode === null && p.signalCode === null) {
          await new Promise<void>((res) => {
            p.once('exit', () => res());
            p.kill('SIGTERM');
          });
        }
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('1. apply over MCP returns a task handle while mkfs is held open (url elicitation + REST approval)', async () => {
      const planned = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('plan'),
        'filesystems.create',
        {
          mode: 'plan',
          spec: {
            backing_device: '/dev/xi_data_block',
            mountpoint: '/mnt/blocked',
            log_device: '/dev/xi_log',
            log_size: '1G',
          },
        },
        {},
        BOTH_TASKS,
      );
      const planPayload = payloadOf(planned);
      const plan = planPayload.result as {
        plan_id: string;
        state_revision_expected: number;
        rollback_model: string;
        blockers: unknown[];
      };
      expect(plan.blockers).toEqual([]);
      expect(plan.rollback_model).toBe('unsupported');

      const applyArgs = {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: 0,
        idempotency_key: 'e2e-mcp-fs-1',
      };

      const first = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('apply'),
        'filesystems.create',
        applyArgs,
        {},
        BOTH_TASKS,
      );
      const r1 = toolResultOf(first);
      expect(r1.resultType).toBe('input_required');
      const confirmReq = r1.inputRequests?.confirm_apply;
      expect(confirmReq?.params.mode).toBe('url');
      const confirmationId = confirmationIdFromUrl(confirmReq?.params.url as string);

      await approveConfirmation(apiSockPath, confirmationId);

      const start = Date.now();
      const second = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('apply'),
        'filesystems.create',
        applyArgs,
        { requestState: r1.requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
        BOTH_TASKS,
      );
      const elapsed = Date.now() - start;
      expect(elapsed, `retry took ${elapsed}ms while mkfs is blocked`).toBeLessThan(5000);

      const handle = resultOf(second);
      expect(handle.resultType, JSON.stringify(handle)).toBe('task');
      expect(typeof handle.taskId).toBe('string');
      taskId = handle.taskId as string;

      // Not recorded yet: mkfs is blocked before the fake host appends the op.
      expect(fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'))).toHaveLength(0);
    }, 60_000);

    it("2. tasks/get reports honest progress while mkfs is blocked: stage '(2 of 5)', elapsed, the percentage disclaimer, no %, pollIntervalMs 5000", async () => {
      const body = await pollTasksGet(
        apiSockPath,
        taskId,
        (b) => String(b.statusMessage ?? '').includes('mkfs'),
        { timeoutMs: 20_000 },
      );
      expect(body.status).toBe('working');
      const msg = String(body.statusMessage);
      expect(msg).toContain("'mkfs'");
      expect(msg).toContain('(2 of 5)');
      expect(msg).toMatch(/elapsed \d+s/);
      expect(msg).toContain('mkfs.xfs does not report a completion percentage');
      // The point-of-no-return clause is proactive: it appears in tasks/get
      // as soon as the 'mkfs' stage starts, before any tasks/cancel has been
      // sent (scenario 3 sends the first cancel) — S16 §9.2.
      expect(msg).toContain('cancellation can no longer safely stop formatting');
      expect(msg).not.toContain('%');
      expect(body.pollIntervalMs).toBe(5000);

      // The fake host has not recorded the op yet — it is still blocked inside it.
      expect(fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'))).toHaveLength(0);
    }, 30_000);

    it('3. tasks/cancel is acknowledged but refused: past the point of no return', async () => {
      const cancelRes = await taskRpc(apiSockPath, 'tasks/cancel', taskId, ADMIN_TOKEN, TASKS_CAP);
      expect(cancelRes.status).toBe(200);
      expect(resultOf(cancelRes)).toEqual({ resultType: 'complete' });

      const restRow = await restGet(apiSockPath, ADMIN_TOKEN, `/tasks/${taskId}`);
      expect(restRow.status).toBe(200);
      expect(
        (restRow.body.result as { cancel_refused_reason?: string }).cancel_refused_reason,
      ).toBe('irreversible_stage_started');

      const getRes = await taskRpc(apiSockPath, 'tasks/get', taskId, ADMIN_TOKEN, TASKS_CAP);
      const body = resultOf(getRes);
      expect(body.status).toBe('working');
      expect(String(body.statusMessage)).toContain('no longer safely stop formatting');

      const auditRow = await waitForAuditRow(
        auditPath,
        (r) => r.kind === 'mcp.task.cancel_refused_irreversible' && r.task_id === taskId,
      );
      // detail is nested inside payload (src/api/mcp/tasks/audit.ts
      // queueTaskEvent), and fs.create's irreversible_from stage is 'mkfs'
      // (src/lib/tasks/irreversible-stages.ts IRREVERSIBLE_STAGE_BY_KIND).
      const detail = auditRow.payload?.detail as { stage?: string } | undefined;
      expect(detail?.stage).toBe('mkfs');

      // The fake host still shows no completed mkfs.xfs — the refusal did not
      // let the operation proceed any further than it already had.
      expect(fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'))).toHaveLength(0);
    }, 30_000);

    it('4. the task handle survives an api restart (same taskId, still working, same createdAt)', async () => {
      const beforeRes = await taskRpc(apiSockPath, 'tasks/get', taskId, ADMIN_TOKEN, TASKS_CAP);
      const before = resultOf(beforeRes);
      expect(before.status).toBe('working');

      await new Promise<void>((resolveP) => {
        apiProc?.once('exit', () => resolveP());
        apiProc?.kill('SIGTERM');
      });
      apiProc = await spawnApi();
      await waitForAgentReady(apiSockPath, ADMIN_TOKEN, {
        diagnostics: () => agentStderr.join('').slice(-2000),
      });

      const afterRes = await taskRpc(apiSockPath, 'tasks/get', taskId, ADMIN_TOKEN, TASKS_CAP);
      const after = resultOf(afterRes);
      expect(after.taskId).toBe(taskId);
      expect(after.status).toBe('working');
      expect(after.createdAt).toBe(before.createdAt);

      // The agent's mkfs kept running through the restart — still blocked.
      expect(fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'))).toHaveLength(0);
    }, 60_000);

    it('5. releasing mkfs completes the task: a clean terminal projection and ttlMs arithmetic', async () => {
      writeFileSync(mkfsReleasePath(fixtureDir), 'go');

      const body = await pollTasksGet(apiSockPath, taskId, (b) => b.status !== 'working', {
        timeoutMs: 60_000,
        intervalMs: 2000,
      });
      expect(body.status).toBe('completed');

      const terminal = body.result as {
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
      };
      expect(terminal.isError).toBeUndefined();
      const parsed = JSON.parse(terminal.content[0]?.text ?? '{}') as {
        result: { task_id: string; state: string; stages?: unknown[] };
      };
      expect(parsed.result.task_id).toBe(taskId);
      expect(parsed.result.state).toBe('success');
      expect(parsed.result).not.toHaveProperty('plan_document');
      expect(parsed.result).not.toHaveProperty('plan_document_hash');
      for (const stage of (parsed.result.stages ?? []) as Array<Record<string, unknown>>) {
        expect(stage).not.toHaveProperty('output_url');
      }

      const restRow = await restGet(apiSockPath, ADMIN_TOKEN, `/tasks/${taskId}`);
      expect(restRow.status).toBe(200);
      const restTask = restRow.body.result as {
        state: string;
        created_at: string;
        terminal_at: string;
      };
      expect(restTask.state).toBe('success');
      const expectedTtl =
        Date.parse(restTask.terminal_at) - Date.parse(restTask.created_at) + 30 * 86400 * 1000;
      expect(body.ttlMs).toBe(expectedTtl);

      const mkfsOps = fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'));
      expect(mkfsOps).toHaveLength(1);
      expect(mkfsOps[0]?.endsWith('/dev/xi_data_block')).toBe(true);
    }, 70_000);

    it('6. a queued task can still be cancelled (pool full with a second blocked create)', async () => {
      // Re-arm the block gate: the NEXT '_block' mkfs blocks again.
      unlinkSync(mkfsReleasePath(fixtureDir));

      // Create A on data2_block, NO log_device — it leases only its own array
      // and filesystem, not the shared 'log' array.
      const plannedA = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('plan'),
        'filesystems.create',
        {
          mode: 'plan',
          spec: { backing_device: '/dev/xi_data2_block', mountpoint: '/mnt/blocked2' },
        },
        {},
        BOTH_TASKS,
      );
      const planAPayload = payloadOf(plannedA);
      const planA = planAPayload.result as {
        plan_id: string;
        state_revision_expected: number;
        rollback_model: string;
        blockers: unknown[];
      };
      expect(planA.blockers).toEqual([]);
      expect(planA.rollback_model).toBe('unsupported');

      const applyArgsA = {
        mode: 'apply',
        plan_id: planA.plan_id,
        expected_revision: 0,
        idempotency_key: 'e2e-mcp-fs-2',
      };
      const firstA = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('apply'),
        'filesystems.create',
        applyArgsA,
        {},
        BOTH_TASKS,
      );
      const r1A = toolResultOf(firstA);
      expect(r1A.resultType).toBe('input_required');
      const confirmationIdA = confirmationIdFromUrl(
        r1A.inputRequests?.confirm_apply?.params.url as string,
      );
      await approveConfirmation(apiSockPath, confirmationIdA);

      const secondA = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('apply'),
        'filesystems.create',
        applyArgsA,
        { requestState: r1A.requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
        BOTH_TASKS,
      );
      const handleA = resultOf(secondA);
      expect(handleA.resultType, JSON.stringify(handleA)).toBe('task');
      expect(handleA.status).toBe('working');
      const taskIdA = handleA.taskId as string;

      // A now holds the single pool slot (tasks.max_inflight: 1) and will soon
      // be blocked in mkfs. support.bundle needs no confirmation at all — it
      // should be admitted as a task immediately but stay QUEUED (pool full).
      const bundleRes = await call(
        apiSockPath,
        ADMIN_TOKEN,
        nextId('bundle'),
        'support.bundle',
        {},
        {},
        TASKS_CAP,
      );
      const bundleHandle = resultOf(bundleRes);
      expect(bundleHandle.resultType, JSON.stringify(bundleHandle)).toBe('task');
      expect(String(bundleHandle.statusMessage)).toContain('queued');
      const bundleTaskId = bundleHandle.taskId as string;

      const cancelBundle = await taskRpc(
        apiSockPath,
        'tasks/cancel',
        bundleTaskId,
        ADMIN_TOKEN,
        TASKS_CAP,
      );
      expect(cancelBundle.status).toBe(200);
      expect(resultOf(cancelBundle)).toEqual({ resultType: 'complete' });

      const bundleDone = await pollTasksGet(
        apiSockPath,
        bundleTaskId,
        (b) => b.status !== 'working',
      );
      expect(bundleDone.status).toBe('cancelled');
      expect(String(bundleDone.statusMessage)).toContain('cancelled at a safe point');

      // A's mkfs was never recorded — it is still blocked; the only recorded
      // mkfs.xfs op remains scenario 1/5's.
      expect(fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'))).toHaveLength(1);

      // Release mkfs again and let A finish so afterAll shuts down cleanly.
      writeFileSync(mkfsReleasePath(fixtureDir), 'go');
      const aDone = await pollTasksGet(apiSockPath, taskIdA, (b) => b.status !== 'working', {
        timeoutMs: 60_000,
        intervalMs: 2000,
      });
      expect(aDone.status).toBe('completed');
      const mkfsOpsFinal = fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'));
      expect(mkfsOpsFinal).toHaveLength(2);
      expect(mkfsOpsFinal[1]?.endsWith('/dev/xi_data2_block')).toBe(true);
    }, 90_000);
  },
);
