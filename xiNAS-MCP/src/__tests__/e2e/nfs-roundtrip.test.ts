// @vitest-environment node
/**
 * End-to-end (S3 N6, s3-nfs-executor-spec §9): the FULL NFS write stack over
 * real processes — a real xinas-api + a real xinas-agent over UNIX sockets,
 * with a STUB nfs-helper (an in-test UDS server speaking the spec-nfs-helper
 * newline-JSON protocol) standing in for the privileged Python daemon.
 *
 * Nothing between the HTTP route and the helper socket is mocked: the N5
 * routes run the N4 PlanProviders, the N0 apply transaction writes the
 * desired row + leases + task, task.begin dispatches to the agent, the N3
 * executors recompile via the shared N1 lib and drive the helper client at
 * the config-pointed socket (the new AgentConfig.nfs_helper_socket — Part 1
 * of N6), and progress flows back to the api's durable task rows.
 *
 * Three scenarios:
 *   1. share.create success — plan → apply → execute → success; the stub
 *      received the COMPILED entry (rw,async,no_subtree_check) and holds the
 *      path; the desired row is live (GET /shares/{id} → 200); both task
 *      snapshots set (python3 shim ids).
 *   2. forced failure → rollback + Model-R revert — the stub's one-shot
 *      failNext makes add_export fail INTERNAL; the executor rolls back
 *      (remove_export observed), the task terminates
 *      failed(FAILED_PARTIAL_ROLLED_BACK), and the desired row is REVERTED:
 *      GET /shares/{id} → 404. Model R proven over the full stack.
 *   3. nfs-idmap.set — plan/apply PATCH /nfs-idmap; the stub's idmapDomain
 *      flips and a set_idmapd_domain call is logged.
 *
 * The stub runs IN-PROCESS (same vitest worker), so the forced-failure
 * control is direct field assignment (`stub.failNext = {...}`) — no control
 * op over the socket is needed.
 *
 * The agent's xinas_history bridge shells out to `python3 -m xinas_history`;
 * as in task-engine-roundtrip.test.ts, a fake `python3` on the agent's PATH
 * emits a unique snapshot id per invocation.
 *
 * SLOW: spawns 2 processes + a stub UDS server. EXCLUDED from the blocking
 * `npm test` gate (vitest.config.ts); runs only via `npm run test:e2e`. The
 * test runs the BUILT dist/ entrypoints — run a fresh `npm run build` first.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000ef5e';
const ADMIN_TOKEN = 'e2e-nfs-admin-tok';
const AGENT_TOKEN = 'e2e-nfs-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;

/** Terminal task states the polling helper resolves on. */
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

// ─── HTTP-over-UDS helpers ───────────────────────────────────────────────────

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: { code?: string; reason?: string } }>;
    warnings?: unknown[];
  };
}

/** One JSON request over the api UDS (any method); resolves status + envelope. */
function requestJson(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  bodyObj?: unknown,
): Promise<JsonResponse> {
  const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolveP({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
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

const getJson = (sock: string, path: string, token: string): Promise<JsonResponse> =>
  requestJson(sock, 'GET', path, token);
const postJson = (
  sock: string,
  path: string,
  token: string,
  body: unknown,
): Promise<JsonResponse> => requestJson(sock, 'POST', path, token, body);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the api UDS answers ANY GET (a 404 still means the server is up). */
async function waitForApi(socketPath: string, token: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getJson(socketPath, '/api/v1/capabilities', token);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`API at ${socketPath} did not become ready within ${timeoutMs}ms`);
}

/** Poll a GET until it answers 200 (observed snapshot landed); resolves the response. */
async function waitForObservation(
  socketPath: string,
  token: string,
  path: string,
  timeoutMs = 15_000,
): Promise<JsonResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    last = await getJson(socketPath, path, token);
    if (last.status === 200) return last;
    await sleep(200);
  }
  throw new Error(
    `GET ${path} never returned 200 within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

interface TaskResult {
  state: string;
  snapshot_before?: string | null;
  snapshot_after?: string | null;
  error_code?: string | null;
  stages: Array<{ stage_index: number; name: string; status: string }>;
}

/** Poll GET /api/v1/tasks/{id} until terminal; throws with the last body on timeout. */
async function waitForTaskState(
  socketPath: string,
  token: string,
  taskId: string,
  timeoutMs = 15_000,
): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, `/api/v1/tasks/${taskId}`, token);
    last = res;
    if (res.status === 200) {
      const t = res.body.result as TaskResult;
      if (TERMINAL.includes(t.state)) return t;
    }
    await sleep(200);
  }
  throw new Error(
    `Task ${taskId} never reached a terminal state within ${timeoutMs}ms; last=${JSON.stringify(
      last,
    )}`,
  );
}

// ─── The stub nfs-helper ─────────────────────────────────────────────────────

/** A stored export entry (the helper wire shape add_export carries). */
interface StubExportEntry {
  path: string;
  clients: Array<{ host: string; options: string[] }>;
}

interface StubCall {
  op: string;
  req: Record<string, unknown>;
}

/** One-shot scriptable failure: the NEXT request whose op matches fails. */
interface StubFailNext {
  op: string;
  code: string;
  error: string;
}

interface StubNfsHelper {
  exports: Map<string, StubExportEntry>;
  idmapDomain: string | undefined;
  calls: StubCall[];
  failNext: StubFailNext | null;
  close(): Promise<void>;
}

/**
 * Start a tiny in-test UDS server speaking the spec-nfs-helper protocol:
 * SOCK_STREAM, ONE newline-terminated JSON request → ONE JSON-line response
 * per connection, then the socket is ended. State is in-memory; every request
 * is logged to `calls`; `failNext` forces a one-shot `{ok:false}` for the
 * matching op (consumed on use). Runs in the vitest process, so tests rig
 * failures by direct assignment — no control op needed.
 */
function startStubNfsHelper(socketPath: string): Promise<StubNfsHelper> {
  const stub: StubNfsHelper = {
    exports: new Map(),
    idmapDomain: undefined,
    calls: [],
    failNext: null,
    close: () => Promise.resolve(),
  };

  function dispatch(req: Record<string, unknown>): Record<string, unknown> {
    const op = String(req.op ?? '');
    stub.calls.push({ op, req });

    if (stub.failNext !== null && stub.failNext.op === op) {
      const f = stub.failNext;
      stub.failNext = null; // one-shot: consumed whether or not asserted
      return { ok: false, code: f.code, error: f.error };
    }

    switch (op) {
      case 'list_exports':
        return { ok: true, result: [...stub.exports.values()] };
      case 'add_export': {
        const entry = req.entry as StubExportEntry;
        stub.exports.set(entry.path, entry);
        return { ok: true, result: null };
      }
      case 'remove_export': {
        const path = String(req.path ?? '');
        if (!stub.exports.has(path)) {
          return { ok: false, code: 'NOT_FOUND', error: 'no such export' };
        }
        stub.exports.delete(path);
        return { ok: true, result: null };
      }
      case 'update_export': {
        const path = String(req.path ?? '');
        const current = stub.exports.get(path);
        if (current === undefined) {
          return { ok: false, code: 'NOT_FOUND', error: 'no such export' };
        }
        // Clients are replaced wholesale (the real helper rewrites the line).
        const patch = (req.patch ?? {}) as Partial<StubExportEntry>;
        stub.exports.set(path, { ...current, ...patch });
        return { ok: true, result: null };
      }
      case 'set_idmapd_domain': {
        stub.idmapDomain = String(req.domain ?? '');
        return { ok: true, result: null };
      }
      default:
        return { ok: false, code: 'UNSUPPORTED', error: `unknown op '${op}'` };
    }
  }

  const server = net.createServer((conn) => {
    let buf = '';
    let answered = false;
    conn.on('data', (chunk) => {
      if (answered) return;
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      answered = true;
      let resp: Record<string, unknown>;
      try {
        resp = dispatch(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch (e) {
        resp = { ok: false, code: 'INVALID_ARGUMENT', error: `bad request JSON: ${e}` };
      }
      conn.end(`${JSON.stringify(resp)}\n`);
    });
    conn.on('error', () => {
      /* client hangup after destroy() — ignore */
    });
  });

  stub.close = () =>
    new Promise<void>((res) => {
      server.close(() => res());
    });

  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolveP(stub));
  });
}

// ─── The suite ───────────────────────────────────────────────────────────────

describe.sequential('e2e: NFS round-trip via stub nfs-helper (S3 N6)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let stub: StubNfsHelper;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  /** Append both processes' stderr to a thrown error for CI diagnosability. */
  function withProcStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(
      `${msg}\n--- api stderr ---\n${apiStderr.join('')}\n--- agent stderr ---\n${agentStderr.join('')}`,
    );
  }

  beforeAll(async () => {
    // The e2e runs the BUILT dist/. We rely on the caller having run a fresh
    // `npm run build`; self-build only if dist is entirely missing.
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-nfs-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const helperSockPath = join(tmpDir, 'nfs-helper.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');

    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    // The stub helper listens BEFORE the agent boots (the executor connects
    // lazily per request, but starting first removes any ordering question).
    stub = await startStubNfsHelper(helperSockPath);

    // Fake `python3` for the agent's xinas_history bridge (the runner snapshots
    // every task). `$$` is the shim's pid — distinct per invocation, so
    // snapshot_before and snapshot_after get DISTINCT ids.
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    const python3Shim = join(shimBin, 'python3');
    writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
      mode: 0o755,
    });
    chmodSync(python3Shim, 0o755); // defensive: umask can strip the mode bits

    // Pre-seed the Cluster + Node singletons (the agent never emits those);
    // the api process reopens the same db file.
    const seedStore = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    seedStore.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-nfs-cluster' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-nfs-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });
    await seedStore.close();

    writeFileSync(
      apiConfigPath,
      JSON.stringify({
        controller_id: CONTROLLER_ID,
        listen: { kind: 'unix', socket: apiSockPath },
        tokens: {
          [ADMIN_TOKEN]: { principal: 'admin:e2e-nfs', role: 'admin' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
      }),
    );

    // The agent config points the NFS executor's helper client at the STUB
    // via the new optional nfs_helper_socket (N6 Part 1).
    writeFileSync(
      agentConfigPath,
      JSON.stringify({
        api_socket: apiSockPath,
        agent_socket: agentSockPath,
        controller_id_path: controllerIdPath,
        agent_token_path: agentTokenPath,
        socket_group: 'nogroup',
        nfs_helper_socket: helperSockPath,
      }),
    );

    // Start the api.
    apiProc = spawn(process.execPath, [API_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, XINAS_API_CONFIG: apiConfigPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiProc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
    try {
      await waitForApi(apiSockPath, ADMIN_TOKEN);
    } catch (err) {
      throw withProcStderr(err);
    }

    // Start the agent in fixture probe mode (no privileged probes on the test
    // host), with the python3 shim prepended to PATH.
    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: agentConfigPath,
        XINAS_AGENT_PROBE_MODE: `fixture:${FIXTURE_DIR}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    // The heartbeat tracker needs the agent ONLINE before an apply dispatches.
    await sleep(HEARTBEAT_INTERVAL_MS * 3);
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
    if (stub) await stub.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('share.create: plan → apply → execute → success; compiled entry at the stub; desired row live', async () => {
    const planned = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, {
      mode: 'plan',
      spec: {
        path: '/srv/e2e-share',
        clients: [{ pattern: '10.0.0.0/24', options: ['rw'] }],
        fsid: 101,
      },
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as {
      plan_id?: string;
      id?: string;
      state_revision_expected?: number;
    };
    expect(typeof plan.plan_id).toBe('string');
    expect(typeof plan.id).toBe('string'); // server-assigned share id
    expect(plan.state_revision_expected).toBe(0); // create absence-pin

    const applied = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: 0,
      idempotency_key: 'K-e2e-create',
    });
    expect(applied.status).toBe(202);
    const apply = applied.body.result as { task_id?: string; state?: string };
    expect(typeof apply.task_id).toBe('string');
    expect(apply.state).toBe('running');

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, apply.task_id as string);
    } catch (err) {
      throw withProcStderr(err);
    }
    expect(task.state).toBe('success');

    // The stub received add_export with the COMPILED entry: client options are
    // authoritative ('rw'), then the folded defaults 'async' (Share-level sync
    // default) and the 'no_subtree_check' hardening default (N1.1 compile).
    const add = stub.calls.find((c) => c.op === 'add_export');
    expect(add).toBeDefined();
    expect(add?.req.entry).toEqual({
      path: '/srv/e2e-share',
      clients: [{ host: '10.0.0.0/24', options: ['rw', 'async', 'no_subtree_check'] }],
    });
    expect(add?.req.create_path).toBe(true);
    expect(stub.exports.has('/srv/e2e-share')).toBe(true);

    // The desired row is live: the apply txn wrote it, and success kept it.
    const got = await getJson(apiSockPath, `/api/v1/shares/${plan.id}`, ADMIN_TOKEN);
    expect(got.status).toBe(200);
    const share = got.body.result as { spec?: { path?: string } };
    expect(share.spec?.path).toBe('/srv/e2e-share');

    // Snapshots came from the python3 shim — both set, distinct per invocation.
    expect(typeof task.snapshot_before).toBe('string');
    expect((task.snapshot_before ?? '').length).toBeGreaterThan(0);
    expect(typeof task.snapshot_after).toBe('string');
    expect((task.snapshot_after ?? '').length).toBeGreaterThan(0);
  }, 20_000);

  it('forced add_export failure → rollback (remove_export) + Model-R desired revert (404)', async () => {
    const planned = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, {
      mode: 'plan',
      spec: {
        path: '/srv/e2e-fail',
        clients: [{ pattern: '10.0.0.0/24', options: ['rw'] }],
        fsid: 102,
      },
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as { plan_id?: string; id?: string };

    // Rig the ONE-SHOT failure: the next add_export fails INTERNAL. The stub
    // runs in this process, so direct assignment is the control surface.
    stub.failNext = { op: 'add_export', code: 'INTERNAL', error: 'exportfs exploded' };

    const applied = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: 0,
      idempotency_key: 'K-e2e-fail',
    });
    expect(applied.status).toBe(202);
    const taskId = (applied.body.result as { task_id?: string }).task_id as string;

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, taskId);
    } catch (err) {
      throw withProcStderr(err);
    }

    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');
    expect(stub.failNext).toBeNull(); // the forced failure was consumed

    // The executor's rollback issued remove_export for the failed path (the
    // stub answers NOT_FOUND — nothing was stored — which share.create's
    // rollback treats as already-rolled-back).
    const rollbackCall = stub.calls.find(
      (c) => c.op === 'remove_export' && c.req.path === '/srv/e2e-fail',
    );
    expect(rollbackCall).toBeDefined();
    expect(stub.exports.has('/srv/e2e-fail')).toBe(false);

    // Model R over the FULL stack: the apply txn wrote the desired row; the
    // terminal failure REVERTED it — the share no longer exists.
    const got = await getJson(apiSockPath, `/api/v1/shares/${plan.id}`, ADMIN_TOKEN);
    expect(got.status).toBe(404);
  }, 20_000);

  it('nfs-idmap.set: plan → apply → execute → success; stub domain flipped', async () => {
    // Wait for the agent's boot sweep to land the observed idmap snapshot so
    // the plan pins a STABLE observed revision (the idmap collector re-polls
    // only every 60s — far beyond the plan→apply gap below).
    await waitForObservation(apiSockPath, ADMIN_TOKEN, '/api/v1/nfs-idmap').catch((err) => {
      throw withProcStderr(err);
    });

    const planned = await requestJson(apiSockPath, 'PATCH', '/api/v1/nfs-idmap', ADMIN_TOKEN, {
      mode: 'plan',
      domain: 'e2e.example.com',
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as { plan_id?: string; state_revision_expected?: number };
    expect(typeof plan.plan_id).toBe('string');
    // Observed-only op: the plan's revision is the observed snapshot revision
    // (>= 1 here — the fixture-mode agent posted nfs-idmap.json at boot).
    expect(Number.isInteger(plan.state_revision_expected)).toBe(true);

    const applied = await requestJson(apiSockPath, 'PATCH', '/api/v1/nfs-idmap', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: plan.state_revision_expected,
      idempotency_key: 'K-e2e-idmap',
    });
    expect(applied.status).toBe(202);
    const taskId = (applied.body.result as { task_id?: string }).task_id as string;

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, taskId);
    } catch (err) {
      throw withProcStderr(err);
    }
    expect(task.state).toBe('success');

    expect(stub.idmapDomain).toBe('e2e.example.com');
    expect(
      stub.calls.some((c) => c.op === 'set_idmapd_domain' && c.req.domain === 'e2e.example.com'),
    ).toBe(true);
  }, 20_000);
});
