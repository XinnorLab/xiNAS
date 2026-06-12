// @vitest-environment node
/**
 * End-to-end (S10 T8, ADR-0012): task cancel against a REAL xinas-api +
 * xinas-agent over UNIX sockets (fixture probe mode, python3 shim for the
 * xinas_history bridge). Worker pool capped at 1 so queueing is trivial.
 *
 *   1. running cancel — apply a sleep_ms reference task, cancel mid-sleep:
 *      200 (row still running, cancel_requested_at set) → terminal
 *      `cancelled`, rollback stage ran, NO error_code, NO snapshot_after;
 *      the lease is freed (a follow-up apply on the SAME resource succeeds).
 *   2. queued cancel + watch — a sleeping task holds the one slot; the next
 *      apply stays `queued`; an SSE watcher receives the engine's SYNTHETIC
 *      terminal(cancelled) frame at sequence 1 when the queued task is
 *      cancelled (no agent involvement).
 *   3. late/terminal cancel — a completed task answers 409 not_cancellable;
 *      re-cancelling a cancelled task answers 200 (idempotent).
 *   4. CLI — `xinasctl tasks cancel --id <id>` cancels a running task.
 *
 * Process model mirrors task-engine-roundtrip.test.ts (built dist/ entrypoints).
 */

import { type ChildProcess, execFile, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const CTL_ENTRY = join(PROJECT_ROOT, 'dist/cli/xinasctl.js');
const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000c4ce1';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: { code?: string; reason?: string } }>;
  };
}

function reqJson(
  socketPath: string,
  method: string,
  path: string,
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
          Authorization: `Bearer ${ADMIN_TOKEN}`,
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TaskResult {
  task_id: string;
  state: string;
  error_code?: string | null;
  cancel_requested_at?: string | number | null;
  snapshot_after?: string | null;
  stages: Array<{ stage_index: number; name: string; status: string }>;
}

describe.sequential('e2e: S10 task cancel (fixture mode)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  async function waitForTask(
    taskId: string,
    isDone: (t: TaskResult) => boolean = (t) => TERMINAL.includes(t.state),
    timeoutMs = 20_000,
  ): Promise<TaskResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await reqJson(apiSockPath, 'GET', `/api/v1/tasks/${taskId}`);
      if (res.status === 200 && isDone(res.body.result as TaskResult)) {
        return res.body.result as TaskResult;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `task ${taskId} never reached the target state\nlast=${JSON.stringify(res.body)}\n--- agent stderr ---\n${agentStderr.join('').slice(-2000)}`,
        );
      }
      await sleep(150);
    }
  }

  let applySeq = 0;

  /** plan+apply a reference task; returns the task_id (202 expected). */
  async function applyReference(
    id: string,
    spec: Record<string, unknown> = {},
  ): Promise<{ taskId: string; state: string }> {
    const planned = await reqJson(apiSockPath, 'POST', '/api/v1/reference', {
      mode: 'plan',
      spec: { id, ...spec },
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    const planId = (planned.body.result as { plan_id: string }).plan_id;
    const applied = await reqJson(apiSockPath, 'POST', '/api/v1/reference', {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: `K-${id}-${++applySeq}`,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const result = applied.body.result as { task_id: string; state: string };
    return { taskId: result.task_id, state: result.state };
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-cancel-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');

    writeFileSync(join(tmpDir, 'controller-id'), `${CONTROLLER_ID}\n`);
    writeFileSync(join(tmpDir, 'agent-token'), `${AGENT_TOKEN}\n`);

    const shimBin = join(tmpDir, 'bin');
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
      spec: { display_name: 'e2e-cancel' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-cancel-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });
    await seedStore.close();

    writeFileSync(
      join(tmpDir, 'api-config.json'),
      JSON.stringify({
        controller_id: CONTROLLER_ID,
        listen: { kind: 'unix', socket: apiSockPath },
        tokens: {
          [ADMIN_TOKEN]: { principal: 'admin:e2e', role: 'admin' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
        // ONE slot: the first sleeping apply runs, the next stays queued.
        tasks: { max_inflight: 1 },
      }),
    );
    writeFileSync(
      join(tmpDir, 'agent-config.json'),
      JSON.stringify({
        api_socket: apiSockPath,
        agent_socket: agentSockPath,
        controller_id_path: join(tmpDir, 'controller-id'),
        agent_token_path: join(tmpDir, 'agent-token'),
        socket_group: 'nogroup',
      }),
    );

    apiProc = spawn(process.execPath, [API_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, XINAS_API_CONFIG: join(tmpDir, 'api-config.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiProc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const r = await reqJson(apiSockPath, 'GET', '/api/v1/capabilities');
        if (r.status > 0) break;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) {
        throw new Error(`api never ready\n${apiStderr.join('')}`);
      }
      await sleep(100);
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: join(tmpDir, 'agent-config.json'),
        XINAS_AGENT_PROBE_MODE: `fixture:${FIXTURE_DIR}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));
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

  it('1. running cancel: rollback ran, cancelled, no error_code, lease freed', async () => {
    const { taskId } = await applyReference('cancel-run', { sleep_ms: 20_000 });
    // Let the executor reach the apply-stage sleep.
    await waitForTask(taskId, (t) => t.state === 'running');
    await sleep(400);

    const res = await reqJson(apiSockPath, 'POST', `/api/v1/tasks/${taskId}/cancel`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.result as TaskResult;
    expect(row.state).toBe('running'); // terminal arrives via progress push
    expect(row.cancel_requested_at).not.toBeNull();

    const done = await waitForTask(taskId);
    expect(done.state).toBe('cancelled');
    expect(done.error_code == null).toBe(true);
    expect(done.snapshot_after == null).toBe(true);
    const rollback = done.stages.find((s) => s.name === 'rollback');
    expect(rollback?.status).toBe('success');

    // Lease freed: a fresh apply on the SAME resource id completes.
    const again = await applyReference('cancel-run', { message: 'after-cancel' });
    const ok = await waitForTask(again.taskId);
    expect(ok.state).toBe('success');
  }, 40_000);

  it('2. queued cancel: engine-local, synthetic terminal frame on /watch', async () => {
    const blocker = await applyReference('cancel-blocker', { sleep_ms: 20_000 });
    await waitForTask(blocker.taskId, (t) => t.state === 'running');

    const queued = await applyReference('cancel-queued');
    expect(queued.state).toBe('queued');

    // Attach a live SSE watcher BEFORE cancelling.
    const frames: string[] = [];
    const sawTerminal = new Promise<void>((resolveP, reject) => {
      const req = http.request(
        {
          socketPath: apiSockPath,
          path: `/api/v1/tasks/${queued.taskId}/watch`,
          method: 'GET',
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
        (res) => {
          res.on('data', (c: Buffer) => {
            frames.push(c.toString());
            if (frames.join('').includes('"event_type":"terminal"')) {
              res.destroy();
              resolveP();
            }
          });
          res.on('error', () => resolveP());
        },
      );
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error(`no terminal frame; got: ${frames.join('')}`)), 15_000);
    });
    await sleep(200); // let the subscription attach

    const res = await reqJson(apiSockPath, 'POST', `/api/v1/tasks/${queued.taskId}/cancel`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.result as TaskResult).state).toBe('cancelled');

    await sawTerminal;
    const stream = frames.join('');
    expect(stream).toContain('id: 1'); // the synthetic event advanced the sequence
    expect(stream).toContain('"status":"cancelled"');

    // Cleanup: cancel the blocker through the REAL agent RPC path.
    const cleanup = await reqJson(apiSockPath, 'POST', `/api/v1/tasks/${blocker.taskId}/cancel`);
    expect(cleanup.status).toBe(200);
    const done = await waitForTask(blocker.taskId);
    expect(done.state).toBe('cancelled');
  }, 40_000);

  it('3. late/terminal cancel: 409 not_cancellable; idempotent 200 on cancelled', async () => {
    const { taskId } = await applyReference('cancel-late', { message: 'fast' });
    const done = await waitForTask(taskId);
    expect(done.state).toBe('success');

    const conflict = await reqJson(apiSockPath, 'POST', `/api/v1/tasks/${taskId}/cancel`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors?.[0]?.details?.reason).toBe('not_cancellable');

    // Re-cancel a cancelled task (scenario 1's) → 200, idempotent.
    const tasksRes = await reqJson(apiSockPath, 'GET', '/api/v1/tasks?state=cancelled&limit=10');
    const cancelledRow = (tasksRes.body.result as TaskResult[])[0];
    expect(cancelledRow).toBeDefined();
    const again = await reqJson(
      apiSockPath,
      'POST',
      `/api/v1/tasks/${(cancelledRow as TaskResult).task_id}/cancel`,
    );
    expect(again.status).toBe(200);
    expect((again.body.result as TaskResult).state).toBe('cancelled');
  }, 30_000);

  it('4. xinasctl tasks cancel --id <id> cancels a running task', async () => {
    const { taskId } = await applyReference('cancel-cli', { sleep_ms: 20_000 });
    await waitForTask(taskId, (t) => t.state === 'running');

    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveP) => {
      execFile(
        process.execPath,
        [
          CTL_ENTRY,
          'tasks',
          'cancel',
          '--id',
          taskId,
          '--socket',
          apiSockPath,
          '--token',
          ADMIN_TOKEN,
          '--json',
        ],
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          resolveP({
            code: err === null ? 0 : ((err as { code?: number }).code ?? 1),
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
    expect(out.code, out.stderr).toBe(0);

    const done = await waitForTask(taskId);
    expect(done.state).toBe('cancelled');
  }, 40_000);
});
