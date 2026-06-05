// @vitest-environment node
/**
 * End-to-end (T10): the S2 task engine, exercised against a REAL xinas-api
 * process + a REAL xinas-agent process talking over UNIX sockets.
 *
 * This proves the full plan/apply/execute/progress/terminal round-trip with no
 * mocking of the engine, the dispatch RPC, or the agent's executor pipeline:
 *
 *   POST /api/v1/reference {mode:'plan'}  → 200 plan_id
 *   POST /api/v1/reference {mode:'apply'} → 202 task_id (api dispatches
 *     task.begin → agent accepts → state 'running')
 *   agent runs the inert reference.echo executor, POSTing each stage to the
 *     api's /internal/v1/task_progress, which drives the durable tasks /
 *     task_stages rows to a terminal state.
 *   GET /api/v1/tasks/{id} surfaces state + snapshot_before/after + stages.
 *
 * Four scenarios:
 *   1. success  — plan→apply→execute→terminal(success); full stage set +
 *      snapshot before/after (the fake-python3 shim ids).
 *   2. failure→rollback — spec.fail_at_stage='apply' → apply FAILS → rollback →
 *      terminal(failed, FAILED_PARTIAL_ROLLED_BACK); NO verify, NO
 *      snapshot_after. This is the e2e GUARD for T9b spec-forwarding: if
 *      fail_at_stage did not reach the executor, the task would wrongly succeed.
 *   3. idempotency-conflict — same key + different plan → 409 CONFLICT
 *      (idempotency_key_reused); same key + original plan → 202 same task_id.
 *   4. crash/reconcile+sweep — a SEPARATE describe that opens a REAL on-disk
 *      store via openStateStore and drives TaskEngine.reconcile() +
 *      LeaseManager.sweepExpired() (proves the full 001/002/003 migration chain
 *      + file-backed SQLite, complementing the :memory: unit tests).
 *
 * The agent's xinas_history bridge shells out to `python3 -m xinas_history
 * snapshot create --format json`. In fixture mode that is the ONLY python3
 * caller, so we put a fake `python3` on the agent's PATH that emits a unique
 * snapshot id and exits 0 — the real package would touch /var/lib/xinas.
 *
 * SLOW: spawns 2 processes + waits on socket I/O + async executor timers.
 * EXCLUDED from the blocking `npm test` gate (see vitest.config.ts); runs only
 * via `npm run test:e2e`. Process model mirrors agent-api-roundtrip.test.ts: we
 * run the BUILT dist/ entrypoints, so the test matches how the binaries ship.
 *
 * Envelope shape (src/api/envelope.ts): every response is
 * { request_id, ..., warnings, errors, result } — there is NO top-level `ok`.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRpcClient } from '../../api/agent-client.js';
import { buildTaskEngines } from '../../api/tasks/build.js';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');

const CONTROLLER_ID = '00000000-0000-0000-0000-000000000e2e';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;

/** Terminal task states the polling helper resolves on. */
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: { code?: string; reason?: string } }>;
    warnings?: unknown[];
  };
}

/** GET over UDS; resolves with the HTTP status + parsed envelope. */
function getJson(socketPath: string, path: string, token: string): Promise<JsonResponse> {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
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
    req.end();
  });
}

/** POST a JSON body over UDS; resolves with the HTTP status + parsed envelope. */
function postJson(
  socketPath: string,
  path: string,
  token: string,
  bodyObj: unknown,
): Promise<JsonResponse> {
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

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

interface TaskResult {
  state: string;
  snapshot_before?: string | null;
  snapshot_after?: string | null;
  error_code?: string | null;
  stages: Array<{ stage_index: number; name: string; status: string }>;
}

/**
 * Poll GET /api/v1/tasks/{id} until `isDone(result)` (default: terminal state).
 * Resolves the full task `result`; throws with the last body on timeout.
 */
async function waitForTaskState(
  socketPath: string,
  token: string,
  taskId: string,
  isDone: (t: TaskResult) => boolean = (t) => TERMINAL.includes(t.state),
  timeoutMs = 15_000,
): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, `/api/v1/tasks/${taskId}`, token);
    last = res;
    if (res.status === 200) {
      const t = res.body.result as TaskResult;
      if (isDone(t)) return t;
    }
    await sleep(200);
  }
  throw new Error(
    `Task ${taskId} never reached the target state within ${timeoutMs}ms; last=${JSON.stringify(
      last,
    )}`,
  );
}

/** Map a task's stages to a name → status object for easy assertions. */
function stagesByName(t: TaskResult): Record<string, string> {
  return Object.fromEntries(t.stages.map((s) => [s.name, s.status]));
}

describe.sequential('e2e: S2 task engine round-trip (fixture probe mode)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let agentSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  // Append the agent's captured stderr to a thrown error so a CI failure in any
  // execute-and-poll scenario is diagnosable.
  function withAgentStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
  }

  beforeAll(async () => {
    // The e2e runs the BUILT dist/. We rely on the caller having run a fresh
    // `npm run build` (see the test:e2e run log); self-build only if dist is
    // entirely missing so the suite is still runnable standalone.
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-tasks-'));
    apiSockPath = join(tmpDir, 'api.sock');
    agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');

    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    // A fake `python3` for the agent's xinas_history bridge. The bridge runs
    // `python3 -m xinas_history snapshot create ... --format json` and parses
    // {"id": ...} from stdout; in fixture mode it is the ONLY python3 caller, so
    // a blanket shim is safe. `$$` is the shim's pid — distinct per invocation,
    // so snapshot_before and snapshot_after get DISTINCT ids.
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    const python3Shim = join(shimBin, 'python3');
    writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
      mode: 0o755,
    });
    // Defensive: umask can strip the exec bit from the writeFileSync mode.
    chmodSync(python3Shim, 0o755);

    // Pre-seed the Cluster + Node singletons (the agent never emits those) so
    // any /api/v1/system read returns 200; the api process reopens the file.
    const seedStore = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    seedStore.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-cluster' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-host' },
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
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
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
      throw new Error(`${(err as Error).message}\n--- api stderr ---\n${apiStderr.join('')}`);
    }

    // Start the agent in fixture probe mode, with the python3 shim prepended to
    // PATH so the xinas_history bridge resolves our fake interpreter.
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

    // Give the agent a moment to connect; the heartbeat tracker needs the agent
    // ONLINE before an apply will dispatch successfully (an offline agent fails
    // the begin). One read keeps the boot ordering deterministic.
    await waitForApi(agentSockPath, AGENT_TOKEN).catch(() => {
      /* agent socket may not answer plain GETs; the apply scenarios verify it */
    });
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
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('success: plan → apply → execute → terminal(success) with full stage set', async () => {
    const planned = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'plan',
      spec: { id: 'ok-ref', message: 'hello' },
    });
    expect(planned.status).toBe(200);
    const planId = (planned.body.result as { plan_id?: string }).plan_id;
    expect(typeof planId).toBe('string');

    const applied = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'K-ok',
    });
    expect(applied.status).toBe(202);
    const apply = applied.body.result as { task_id?: string; state?: string };
    expect(typeof apply.task_id).toBe('string');
    expect(apply.state).toBe('running');

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, apply.task_id as string);
    } catch (err) {
      throw withAgentStderr(err);
    }

    expect(task.state).toBe('success');
    // Snapshot ids come from the python3 shim (snap-<pid>); before/after differ.
    expect(typeof task.snapshot_before).toBe('string');
    expect((task.snapshot_before ?? '').length).toBeGreaterThan(0);
    expect(typeof task.snapshot_after).toBe('string');
    expect((task.snapshot_after ?? '').length).toBeGreaterThan(0);

    const stages = stagesByName(task);
    expect(stages).toMatchObject({
      snapshot_before: 'success',
      preflight: 'success',
      apply: 'success',
      verify: 'success',
      snapshot_after: 'success',
    });
  }, 20_000);

  it('failure→rollback: fail_at_stage=apply → failed(FAILED_PARTIAL_ROLLED_BACK), no verify/snapshot_after', async () => {
    const planned = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'plan',
      spec: { id: 'fail-ref', message: 'boom', fail_at_stage: 'apply' },
    });
    expect(planned.status).toBe(200);
    const planId = (planned.body.result as { plan_id?: string }).plan_id;

    const applied = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'K-fail',
    });
    expect(applied.status).toBe(202);
    const taskId = (applied.body.result as { task_id?: string }).task_id as string;

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, taskId);
    } catch (err) {
      throw withAgentStderr(err);
    }

    // The proof that spec.fail_at_stage reached the executor (T9b forwarding):
    // had it not, the task would have wrongly succeeded.
    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');

    const stages = stagesByName(task);
    expect(stages.apply).toBe('failed');
    expect(stages.rollback).toBe('success');
    // The failure path skips verify + snapshot_after entirely.
    expect(stages.verify).toBeUndefined();
    expect(task.stages.some((s) => s.name === 'verify')).toBe(false);
    expect(task.snapshot_after === undefined || task.snapshot_after === null).toBe(true);
    // snapshot_before still ran before the failed apply stage.
    expect(typeof task.snapshot_before).toBe('string');
    expect((task.snapshot_before ?? '').length).toBeGreaterThan(0);
  }, 20_000);

  it('idempotency-conflict: same key + different plan → 409; same key + original plan → 202 replay', async () => {
    // Plan P1 + apply key K-idem → 202 task_id_1.
    const planned1 = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'plan',
      spec: { id: 'idem-ref', message: 'one' },
    });
    expect(planned1.status).toBe(200);
    const planId1 = (planned1.body.result as { plan_id?: string }).plan_id;

    const apply1 = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId1,
      idempotency_key: 'K-idem',
    });
    expect(apply1.status).toBe(202);
    const taskId1 = (apply1.body.result as { task_id?: string }).task_id as string;
    expect(typeof taskId1).toBe('string');

    // Plan P2 (different message → different input_hash) + SAME key → 409.
    const planned2 = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'plan',
      spec: { id: 'idem-ref', message: 'two' },
    });
    expect(planned2.status).toBe(200);
    const planId2 = (planned2.body.result as { plan_id?: string }).plan_id;

    const conflict = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId2,
      idempotency_key: 'K-idem',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors?.[0]?.code).toBe('CONFLICT');
    expect(conflict.body.errors?.[0]?.details?.reason).toBe('idempotency_key_reused');

    // Re-apply key K-idem + the ORIGINAL plan P1 → idempotent replay, same task.
    const replay = await postJson(apiSockPath, '/api/v1/reference', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId1,
      idempotency_key: 'K-idem',
    });
    expect(replay.status).toBe(202);
    expect((replay.body.result as { task_id?: string }).task_id).toBe(taskId1);
  }, 20_000);
});

/**
 * Crash/reconcile + sweep over a REAL on-disk store opened via openStateStore.
 * No api/agent processes — this drives TaskEngine.reconcile() +
 * LeaseManager.sweepExpired() directly, proving the full 001/002/003 migration
 * chain runs against a FILE-backed SQLite db (the unit tests use :memory:).
 */
describe('e2e: reconcile + sweep over a real on-disk store', () => {
  const RECON_NODE = '00000000-0000-0000-0000-0000000recon';
  let tmpDir: string;
  let state: Awaited<ReturnType<typeof openStateStore>>;
  let engines: ReturnType<typeof buildTaskEngines>;

  /** Stub AgentRpcClient covering the reconcile RPC surface (no real agent). */
  const stubAgent: AgentRpcClient = {
    async call(method: string): Promise<unknown> {
      if (method === 'task.list_inflight') return { tasks: [] };
      if (method === 'task.begin') return { accepted: true, agent_acceptance_id: 'acc-recon' };
      throw new Error(`unexpected method ${method}`);
    },
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-recon-'));
    state = await openStateStore({
      databasePath: join(tmpDir, 'recon.db'),
      auditJsonlPath: join(tmpDir, 'recon-audit.jsonl'),
      nodeId: RECON_NODE,
    });
    engines = buildTaskEngines({ state });
  });

  afterEach(async () => {
    await state.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Case A: queued + lease, no agent inflight → reconcile redispatches to running', async () => {
    const created = engines.store.createApplyTask({
      kind: 'reference.echo',
      principal: 'admin:e2e',
      client_type: 'rest',
      request_id: 'r',
      correlation_id: 'c',
      input_hash: 'h-a',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Reference', id: 'recon-a' }],
    });
    const taskId = created.task_id;

    const lease = state.leases.acquire({
      resource_kind: 'Reference',
      resource_id: 'recon-a',
      task_id: taskId,
      ttl_seconds: 60,
    });
    expect(lease.ok).toBe(true);

    await engines.taskEngine.reconcile({ agentClient: stubAgent });

    const task = engines.store.get(taskId);
    expect(task?.state).toBe('running');
    expect(task?.agent_acceptance_id).toBe('acc-recon');
    // Lease consistency: redispatch keeps the resource held.
    const holder = state.db
      .prepare('SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?')
      .get('Reference', 'recon-a') as { task_id: string } | undefined;
    expect(holder?.task_id).toBe(taskId);
  });

  it('Case B: expired-lease running task → sweep → requires_manual_recovery + lease removed', async () => {
    const created = engines.store.createApplyTask({
      kind: 'reference.echo',
      principal: 'admin:e2e',
      client_type: 'rest',
      request_id: 'r',
      correlation_id: 'c',
      input_hash: 'h-b',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Reference', id: 'recon-b' }],
    });
    const taskId = created.task_id;
    engines.store.transition(taskId, { state: 'running' });

    const lease = state.leases.acquire({
      resource_kind: 'Reference',
      resource_id: 'recon-b',
      task_id: taskId,
      ttl_seconds: 60,
    });
    expect(lease.ok).toBe(true);
    // Force the lease expired: sweepExpired uses real Date.now(), so
    // heartbeat_at=0 + ttl_seconds=1 is in the past.
    state.db
      .prepare('UPDATE leases SET heartbeat_at = 0, ttl_seconds = 1 WHERE task_id = ?')
      .run(taskId);

    await engines.taskEngine.reconcile({ agentClient: stubAgent });

    const task = engines.store.get(taskId);
    expect(task?.state).toBe('requires_manual_recovery');
    expect(task?.error_code).toBe('FAILED_STATE_DESYNC');
    // The expired lease was swept.
    const remaining = state.db
      .prepare('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?')
      .get(taskId) as { n: number };
    expect(remaining.n).toBe(0);
  });
});
