// @vitest-environment node
/**
 * End-to-end (S4 T11): the xiRAID array MUTATION surface against a REAL
 * xinas-api + xinas-agent over UNIX sockets, fixture probe mode + the
 * file-backed fake xiRAID transport (selected by convergence in fixture
 * mode; xiraid-state.json in the per-run fixture dir).
 *
 * Scenario chain (sequential — each builds on the previous state):
 *   1. create-with-spares  — POST plan/apply; pool xnsp_data provisioned +
 *      activated before raid_create; observed spec.spare_disk_ids real.
 *   2. modify              — PATCH: change the spare + set tuning → success;
 *      observed spares updated on the next sweep.
 *   3. import              — seeded candidate adopted under new_name;
 *      observable via GET /arrays.
 *   4. delete gates        — apply without dangerous → 412 (engine gate);
 *      a mounted dependent filesystem (filesystems.json fixture — the
 *      fixture probe feeds the collector, so the complete-snapshot sweep
 *      keeps it alive) → 412 dependent_filesystem_mounted.
 *   5. delete success      — the adopted array, dangerous:true → 202 →
 *      success → gone from GET /arrays.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000a4e2';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: Record<string, unknown> }>;
  };
}

function requestJson(
  socketPath: string,
  path: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForApi(socketPath: string, token: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await requestJson(socketPath, '/api/v1/capabilities', token, 'GET');
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
  stages: Array<{ stage_index: number; name: string; status: string }>;
}

async function waitForTaskState(
  socketPath: string,
  taskId: string,
  timeoutMs = 15_000,
): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    const res = await requestJson(socketPath, `/api/v1/tasks/${taskId}`, ADMIN_TOKEN, 'GET');
    last = res;
    if (res.status === 200) {
      const t = res.body.result as TaskResult;
      if (TERMINAL.includes(t.state)) return t;
    }
    await sleep(200);
  }
  throw new Error(`Task ${taskId} never terminal in ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function waitForArrays(
  socketPath: string,
  isDone: (items: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 10_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await requestJson(socketPath, '/api/v1/arrays', ADMIN_TOKEN, 'GET');
    if (res.status === 200 && Array.isArray(res.body.result)) {
      last = res.body.result;
      if (isDone(res.body.result as Array<Record<string, unknown>>)) {
        return res.body.result as Array<Record<string, unknown>>;
      }
    }
    await sleep(200);
  }
  throw new Error(`/arrays never converged in ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

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
  return { blockdevices: data };
}

describe.sequential('e2e: S4 xiraid array mutations (fixture mode + fake xiRAID)', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  function withAgentStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
  }

  function arrayRevision(id: string): Promise<number> {
    return requestJson(apiSockPath, `/api/v1/arrays/${id}`, ADMIN_TOKEN, 'GET').then((res) => {
      const meta = (res.body.result as { metadata?: { revision?: number } }).metadata;
      if (typeof meta?.revision !== 'number') {
        throw new Error(`no metadata.revision for array ${id}: ${JSON.stringify(res.body)}`);
      }
      return meta.revision;
    });
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-xiraid-mut-'));
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

    fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify(disksFixture()));
    // A mounted dependent filesystem on the to-be-created 'data' array,
    // present from BOOT (the fixture fs collector has no event stream and a
    // 60s poll backstop — a post-boot write would not be observed in time).
    // Harmless for scenarios 1-3; scenario 4b's delete blocker relies on it.
    writeFileSync(
      join(fixtureDir, 'filesystems.json'),
      JSON.stringify([
        {
          kind: 'Filesystem',
          id: 'fs-data',
          status: {
            backing_device: '/dev/xi_data',
            mountpoint: '/mnt/data',
            mounted: true,
            fs_type: 'xfs',
          },
        },
      ]),
    );
    // seed an importable foreign array for scenario 3
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({
        arrays: [],
        pools: [],
        import_candidates: [
          {
            uuid: 'u-e2e',
            name: 'foreign',
            level: '5',
            devices: ['/dev/legacy1', '/dev/legacy2', '/dev/legacy3'],
            recoverable: true,
          },
        ],
        tombstones: [],
      }),
    );

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

    // observed disks must be present before any plan
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await requestJson(
        apiSockPath,
        '/api/v1/disks?safe_for_use=true',
        ADMIN_TOKEN,
        'GET',
      );
      if (res.status === 200 && Array.isArray(res.body.result) && res.body.result.length >= 8) {
        break;
      }
      if (Date.now() > deadline) throw withAgentStderr(new Error('disks never observed'));
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

  it('1. create-with-spares: pool provisioned + activated; observed spares real', async () => {
    const planned = await requestJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, 'POST', {
      mode: 'plan',
      spec: {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['nvme1n1', 'nvme2n1', 'nvme3n1'],
        spare_disk_ids: ['nvme4n1'],
      },
    });
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    const applied = await requestJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: (planned.body.result as { plan_id: string }).plan_id,
      expected_revision: 0,
      idempotency_key: 'K-create-spares',
    });
    expect(applied.status).toBe(202);

    let task: TaskResult;
    try {
      task = await waitForTaskState(
        apiSockPath,
        (applied.body.result as { task_id: string }).task_id,
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('success');

    const arrays = await waitForArrays(apiSockPath, (items) =>
      items.some(
        (a) =>
          a.id === 'data' &&
          JSON.stringify((a.spec as { spare_disk_ids: string[] }).spare_disk_ids) ===
            JSON.stringify(['nvme4n1']),
      ),
    ).catch((err) => {
      throw withAgentStderr(err);
    });
    const data = arrays.find((a) => a.id === 'data') as Record<string, unknown>;
    expect((data.status as { state: string }).state).toBe('optimal');
  }, 30_000);

  it('2. modify: swap the spare + set tuning → success; observed spares update', async () => {
    const planned = await requestJson(apiSockPath, '/api/v1/arrays/data', ADMIN_TOKEN, 'PATCH', {
      mode: 'plan',
      spec: { spare_disk_ids: ['nvme5n1'], tuning: { init_prio: 25 } },
    });
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    const applied = await requestJson(apiSockPath, '/api/v1/arrays/data', ADMIN_TOKEN, 'PATCH', {
      mode: 'apply',
      plan_id: (planned.body.result as { plan_id: string }).plan_id,
      expected_revision: await arrayRevision('data'),
      idempotency_key: 'K-modify',
    });
    expect(applied.status).toBe(202);

    let task: TaskResult;
    try {
      task = await waitForTaskState(
        apiSockPath,
        (applied.body.result as { task_id: string }).task_id,
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('success');

    await waitForArrays(apiSockPath, (items) =>
      items.some(
        (a) =>
          a.id === 'data' &&
          JSON.stringify((a.spec as { spare_disk_ids: string[] }).spare_disk_ids) ===
            JSON.stringify(['nvme5n1']),
      ),
    ).catch((err) => {
      throw withAgentStderr(err);
    });
  }, 30_000);

  it('3. import: adopt the seeded candidate under new_name', async () => {
    const planned = await requestJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, 'POST', {
      mode: 'plan',
      spec: { uuid: 'u-e2e', new_name: 'adopted' },
    });
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    const applied = await requestJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: (planned.body.result as { plan_id: string }).plan_id,
      expected_revision: 0,
      idempotency_key: 'K-import',
    });
    expect(applied.status).toBe(202);

    let task: TaskResult;
    try {
      task = await waitForTaskState(
        apiSockPath,
        (applied.body.result as { task_id: string }).task_id,
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('success');

    await waitForArrays(apiSockPath, (items) => items.some((a) => a.id === 'adopted')).catch(
      (err) => {
        throw withAgentStderr(err);
      },
    );
  }, 30_000);

  it('4. delete gates: missing dangerous → 412; mounted dependent fs → 412', async () => {
    // 4a: the engine dangerous gate
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/arrays/adopted',
      ADMIN_TOKEN,
      'DELETE',
      {
        mode: 'plan',
      },
    );
    expect(planned.status).toBe(200);
    expect(
      (planned.body.result as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code),
    ).toEqual(['dangerous_flag_required']);

    const noFlag = await requestJson(apiSockPath, '/api/v1/arrays/adopted', ADMIN_TOKEN, 'DELETE', {
      mode: 'apply',
      plan_id: (planned.body.result as { plan_id: string }).plan_id,
      expected_revision: await arrayRevision('adopted'),
      idempotency_key: 'K-del-noflag',
    });
    expect(noFlag.status).toBe(412);
    expect(noFlag.body.errors?.[0]?.details?.reason).toBe('dangerous_flag_required');

    // 4b: the boot-seeded mounted dependent filesystem on 'data'
    // (filesystems.json fixture) must be observed by now; confirm.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'GET');
      if (
        res.status === 200 &&
        Array.isArray(res.body.result) &&
        (res.body.result as Array<{ id?: string }>).some((f) => f.id === 'fs-data')
      ) {
        break;
      }
      if (Date.now() > deadline) throw withAgentStderr(new Error('fs-data never observed'));
      await sleep(200);
    }

    const plannedData = await requestJson(
      apiSockPath,
      '/api/v1/arrays/data',
      ADMIN_TOKEN,
      'DELETE',
      {
        mode: 'plan',
      },
    );
    expect(plannedData.status).toBe(200);
    const blocked = await requestJson(apiSockPath, '/api/v1/arrays/data', ADMIN_TOKEN, 'DELETE', {
      mode: 'apply',
      plan_id: (plannedData.body.result as { plan_id: string }).plan_id,
      expected_revision: await arrayRevision('data'),
      idempotency_key: 'K-del-blocked',
      dangerous: true,
    });
    expect(blocked.status).toBe(412);
    const codes = (blocked.body.errors?.[0]?.details?.blockers as Array<{ code: string }>).map(
      (b) => b.code,
    );
    expect(codes).toContain('dependent_filesystem_mounted');
  }, 40_000);

  it('5. delete success: adopted array + dangerous:true → gone', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/arrays/adopted',
      ADMIN_TOKEN,
      'DELETE',
      {
        mode: 'plan',
      },
    );
    expect(planned.status).toBe(200);

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/arrays/adopted',
      ADMIN_TOKEN,
      'DELETE',
      {
        mode: 'apply',
        plan_id: (planned.body.result as { plan_id: string }).plan_id,
        expected_revision: await arrayRevision('adopted'),
        idempotency_key: 'K-del-ok',
        dangerous: true,
      },
    );
    expect(applied.status).toBe(202);

    let task: TaskResult;
    try {
      task = await waitForTaskState(
        apiSockPath,
        (applied.body.result as { task_id: string }).task_id,
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(task.state).toBe('success');

    await waitForArrays(apiSockPath, (items) => !items.some((a) => a.id === 'adopted')).catch(
      (err) => {
        throw withAgentStderr(err);
      },
    );
  }, 30_000);
});
