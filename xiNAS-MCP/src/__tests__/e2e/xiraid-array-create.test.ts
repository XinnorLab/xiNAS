// @vitest-environment node
/**
 * End-to-end (S3 T10): xiraid.array.create against a REAL xinas-api process +
 * a REAL xinas-agent process over UNIX sockets, with the agent in fixture
 * probe mode and the xiRAID daemon replaced by the file-backed fake
 * transport (agent/xiraid/fake-transport.ts — selected automatically in
 * fixture mode by convergence.ts).
 *
 *   POST /api/v1/arrays {mode:'plan'}  → 200 plan_id, 0 blockers
 *   POST /api/v1/arrays {mode:'apply', expected_revision: 0} → 202 →
 *     agent executor: preflight → create (fake raid_create writes
 *     xiraid-state.json) → wait_online → verify → terminal(success)
 *   the XiraidArray collector polls raid_show (XINAS_AGENT_XIRAID_POLL_MS)
 *     → GET /api/v1/arrays shows the new array.
 *
 * Three scenarios:
 *   1. success — full stage set + snapshots + the array observable via REST.
 *   2. failure→rollback — name 'roll-fail' triggers the fake transport's
 *      deterministic create failure → FAILED_PARTIAL_ROLLED_BACK; the array
 *      is NOT observable.
 *   3. blocked plan — a system-disk member → blocker disk_is_system; apply
 *      of that plan → 412 PRECONDITION_FAILED.
 *
 * Unlike the static __fixtures__ dir the other e2e suites share, this suite
 * builds a WRITABLE per-run fixture dir (the fake xiRAID transport mutates
 * xiraid-state.json inside it).
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000a3e2';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;

const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: Record<string, unknown> }>;
    warnings?: unknown[];
  };
}

function requestJson(
  socketPath: string,
  path: string,
  token: string,
  method: 'GET' | 'POST',
  bodyObj?: unknown,
): Promise<JsonResponse> {
  const payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
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

const getJson = (s: string, p: string, t: string) => requestJson(s, p, t, 'GET');
const postJson = (s: string, p: string, t: string, b: unknown) => requestJson(s, p, t, 'POST', b);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  error_code?: string | null;
  snapshot_before?: string | null;
  snapshot_after?: string | null;
  stages: Array<{ stage_index: number; name: string; status: string }>;
}

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
  throw new Error(`Task ${taskId} never terminal in ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

/** Poll a list endpoint until a predicate matches (observe convergence). */
async function waitForList(
  socketPath: string,
  path: string,
  token: string,
  isDone: (items: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 10_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, path, token);
    if (res.status === 200 && Array.isArray(res.body.result)) {
      last = res.body.result;
      if (isDone(res.body.result as Array<Record<string, unknown>>)) {
        return res.body.result as Array<Record<string, unknown>>;
      }
    }
    await sleep(200);
  }
  throw new Error(`${path} never converged in ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

const stagesByName = (t: TaskResult): Record<string, string> =>
  Object.fromEntries(t.stages.map((s) => [s.name, s.status]));

/** lsblk-shaped fixture: 1 system disk + 8 free data disks (numeric --bytes sizes). */
function disksFixture(): unknown {
  const data = Array.from({ length: 8 }, (_v, i) => ({
    name: `nvme${i + 1}n1`,
    size: 1_920_383_410_176,
    type: 'disk',
    model: 'E2E-NVME',
    serial: `E2E${String(i + 1).padStart(4, '0')}`,
    tran: 'nvme',
    mountpoints: [null],
  }));
  return {
    blockdevices: [
      {
        name: 'nvme0n1',
        size: 512_110_190_592,
        type: 'disk',
        model: 'E2E-SYS',
        serial: 'E2ESYS01',
        tran: 'nvme',
        mountpoints: [null],
        children: [
          { name: 'nvme0n1p1', size: 536_870_912, type: 'part', mountpoints: ['/boot/efi'] },
          { name: 'nvme0n1p2', size: 511_558_156_288, type: 'part', mountpoints: ['/'] },
        ],
      },
      ...data,
    ],
  };
}

function memberIds(from: number, count: number): string[] {
  return Array.from({ length: count }, (_v, i) => `nvme${from + i}n1`);
}

describe.sequential('e2e: S3 xiraid array create round-trip (fixture mode + fake xiRAID)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  function withAgentStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
  }

  async function plan(spec: Record<string, unknown>): Promise<JsonResponse> {
    return postJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, { mode: 'plan', spec });
  }

  async function apply(planId: string, idempotencyKey: string): Promise<JsonResponse> {
    return postJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId,
      expected_revision: 0,
      idempotency_key: idempotencyKey,
    });
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-xiraid-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');

    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    // Writable per-run fixture dir: enriched lsblk disks + (implicitly) the
    // fake xiRAID transport's xiraid-state.json, created on first write.
    const fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify(disksFixture()));

    // Fake python3 for the xinas_history bridge (same shim as the S2 e2e).
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    const python3Shim = join(shimBin, 'python3');
    writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
      mode: 0o755,
    });
    chmodSync(python3Shim, 0o755);

    // Pre-seed Cluster + Node singletons.
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

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
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
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    await sleep(HEARTBEAT_INTERVAL_MS * 3);

    // Observed disks must be present before any plan (the provider resolves
    // member ids from observed Disk state).
    try {
      await waitForList(
        apiSockPath,
        '/api/v1/disks?safe_for_use=true',
        ADMIN_TOKEN,
        (disks) => disks.length >= 8,
      );
    } catch (err) {
      throw withAgentStderr(err);
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

  it('success: plan(0 blockers) → apply → executor stages → terminal(success) → observable via GET /arrays', async () => {
    const planned = await plan({
      name: 'data',
      level: 'raid6',
      member_disk_ids: memberIds(1, 4),
      strip_size_kib: 64,
    });
    expect(planned.status).toBe(200);
    const p = planned.body.result as Record<string, unknown>;
    expect(p.blockers).toEqual([]);
    expect((p.affected_resources as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: 'XiraidArray',
      id: 'data',
    });

    const applied = await apply(p.plan_id as string, 'K-create-ok');
    expect(applied.status).toBe(202);
    const taskId = (applied.body.result as { task_id: string }).task_id;

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, taskId);
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('success');
    expect((task.snapshot_before ?? '').length).toBeGreaterThan(0);
    expect((task.snapshot_after ?? '').length).toBeGreaterThan(0);
    expect(stagesByName(task)).toMatchObject({
      snapshot_before: 'success',
      preflight: 'success',
      create: 'success',
      wait_online: 'success',
      verify: 'success',
      snapshot_after: 'success',
    });

    // Observe path: the collector's next raid_show poll publishes the array.
    let arrays: Array<Record<string, unknown>>;
    try {
      arrays = await waitForList(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, (items) =>
        items.some((a) => a.id === 'data'),
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    const data = arrays.find((a) => a.id === 'data') as Record<string, unknown>;
    expect((data.status as Record<string, unknown>).state).toBe('optimal');
    expect((data.status as Record<string, unknown>).volume_path).toBe('/dev/xi_data');
    expect((data.spec as Record<string, unknown>).member_disk_ids).toEqual(memberIds(1, 4));
  }, 30_000);

  it('failure→rollback: name roll-fail → FAILED_PARTIAL_ROLLED_BACK; array not observable', async () => {
    const planned = await plan({
      name: 'roll-fail',
      level: 'raid5',
      member_disk_ids: memberIds(5, 4),
    });
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    const applied = await apply((planned.body.result as { plan_id: string }).plan_id, 'K-fail');
    expect(applied.status).toBe(202);
    const taskId = (applied.body.result as { task_id: string }).task_id;

    let task: TaskResult;
    try {
      task = await waitForTaskState(apiSockPath, ADMIN_TOKEN, taskId);
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');
    const stages = stagesByName(task);
    expect(stages.create).toBe('failed');
    expect(stages.rollback).toBe('success');
    expect(stages.verify).toBeUndefined();

    // Never created → never observable.
    const res = await getJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN);
    const items = res.body.result as Array<Record<string, unknown>>;
    expect(items.some((a) => a.id === 'roll-fail')).toBe(false);
  }, 30_000);

  it('blocked plan: system-disk member → disk_is_system blocker; apply → 412', async () => {
    const planned = await plan({
      name: 'badidea',
      level: 'raid5',
      member_disk_ids: ['nvme0n1', 'nvme5n1', 'nvme6n1'],
    });
    expect(planned.status).toBe(200);
    const blockers = (planned.body.result as { blockers: Array<{ code: string }> }).blockers;
    expect(blockers.map((b) => b.code)).toContain('disk_is_system');

    const applied = await apply((planned.body.result as { plan_id: string }).plan_id, 'K-blocked');
    expect(applied.status).toBe(412);
    expect(applied.body.errors?.[0]?.details?.blockers).toBeDefined();
  }, 20_000);
});
