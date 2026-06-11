// @vitest-environment node
/**
 * End-to-end (S5 T12): the filesystem adapter against a REAL xinas-api +
 * xinas-agent over UNIX sockets — fixture probe mode (filesystems.json +
 * nfs-sessions.json + nfs-exports.json feed the collectors) + the
 * file-backed fake FsHost (fs-host-state.json drives/records every host
 * command).
 *
 * Scenario chain (sequential):
 *   1. create        — POST plan/apply with an external log device whose
 *      fake blockdev size (512 MiB) is smaller than the requested 1G →
 *      the recorded mkfs argv carries the CLAMPED size=536870912 (the
 *      day-1 _effective_log_size golden, review P1).
 *   2. unmount gates — PATCH {mounted:false} on a filesystem with BOTH a
 *      live NFS session and an exported path under its mountpoint →
 *      blockers carry dependent_share_active AND mountpoint_exported
 *      (the WS6 milestone proof, review P1).
 *   3. unmount+mount — round-trip on a quiet filesystem.
 *   4. grow          — xfs_growfs recorded; rollback_model 'unsupported'.
 *   5. quota         — Options= rewritten to pquota + remount recorded.
 *   6. identity 422  — PATCH {label} → fs_identity_immutable.
 *   7. unmanage      — mounted target blocked (fs_mounted); cold target
 *      removed WITHOUT dangerous (DELETE never destroys data).
 *   8. force-create  — destructive plan; apply without dangerous → 412
 *      dangerous_flag_required (engine gate); with dangerous → success
 *      over the existing filesystem (the single destruction path).
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeFsHost } from '../../agent/fs/fake-host.js';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000f5e2';
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

function unitText(what: string, where: string): string {
  return `[Mount]\nWhat=${what}\nWhere=${where}\nOptions=defaults,noatime\nType=xfs\n`;
}

describe.sequential('e2e: S5 filesystem adapter (fixture mode + fake FsHost)', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  let fakeHost: ReturnType<typeof createFakeFsHost>;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  function withAgentStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
  }

  async function fsRevision(id: string): Promise<number> {
    const res = await requestJson(apiSockPath, `/api/v1/filesystems/${id}`, ADMIN_TOKEN, 'GET');
    const meta = (res.body.result as { metadata?: { revision?: number } }).metadata;
    if (typeof meta?.revision !== 'number') {
      throw new Error(`no metadata.revision for filesystem ${id}: ${JSON.stringify(res.body)}`);
    }
    return meta.revision;
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-fs-'));
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

    // Observed XiraidArrays: 'data' (the create target, raid5 strip 128 →
    // su=128k,sw=3) and 'log' (the external log device).
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({
        arrays: [
          {
            name: 'data',
            level: '5',
            devices: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
            state: 'online',
            strip_size: 128,
          },
          {
            name: 'log',
            level: '1',
            devices: ['/dev/nvme5n1', '/dev/nvme6n1'],
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

    // Observed Filesystems (static — the fixture probe re-reads each sweep):
    //  mnt-share: mounted, with a session + export under it (scenario 2/7a)
    //  mnt-free:  mounted, quiet (scenarios 3-6)
    //  mnt-cold:  unmounted (scenario 7b unmanage success)
    writeFileSync(
      join(fixtureDir, 'filesystems.json'),
      JSON.stringify([
        {
          kind: 'Filesystem',
          id: 'mnt-share.mount',
          status: {
            mountpoint: '/mnt/share',
            backing_device: '/dev/xi_share',
            mounted: true,
            fs_type: 'xfs',
          },
        },
        {
          kind: 'Filesystem',
          id: 'mnt-free.mount',
          status: {
            mountpoint: '/mnt/free',
            backing_device: '/dev/xi_free',
            mounted: true,
            fs_type: 'xfs',
          },
        },
        {
          kind: 'Filesystem',
          id: 'mnt-cold.mount',
          status: {
            mountpoint: '/mnt/cold',
            backing_device: '/dev/xi_cold',
            mounted: false,
            fs_type: 'xfs',
          },
        },
      ]),
    );

    // The unmount blockers' seeds (T6 passthrough): a live session AND an
    // exported path under /mnt/share.
    writeFileSync(
      join(fixtureDir, 'nfs-sessions.json'),
      JSON.stringify([
        {
          kind: 'NfsSession',
          id: '10.0.0.7:/mnt/share/proj',
          spec: { client_addr: '10.0.0.7', export_path: '/mnt/share/proj' },
          status: { proto_version: 'v4.2', locked_files: 2 },
        },
      ]),
    );
    writeFileSync(
      join(fixtureDir, 'nfs-exports.json'),
      JSON.stringify([{ export_path: '/mnt/share/proj', host_pattern: '*', options: ['rw'] }]),
    );

    // Live host state for the fake FsHost: the three seeded units (share +
    // free mounted), and the log device 512 MiB — SMALLER than the 1G the
    // create will request (the clamp golden).
    fakeHost = createFakeFsHost(fixtureDir);
    writeFileSync(
      join(fixtureDir, 'fs-host-state.json'),
      JSON.stringify({
        blkid: {},
        device_sizes: { '/dev/xi_log': 536870912 },
        units: {
          'mnt-share.mount': unitText('/dev/xi_share', '/mnt/share'),
          'mnt-free.mount': unitText('/dev/xi_free', '/mnt/free'),
          'mnt-cold.mount': unitText('/dev/xi_cold', '/mnt/cold'),
        },
        mounted: ['mnt-share.mount', 'mnt-free.mount'],
        statfs: {},
        ops: [],
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

    // observed filesystems + both arrays must be present before any plan
    const deadline = Date.now() + 10_000;
    for (;;) {
      const fsRes = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'GET');
      const arrRes = await requestJson(apiSockPath, '/api/v1/arrays', ADMIN_TOKEN, 'GET');
      const fsOk =
        fsRes.status === 200 &&
        Array.isArray(fsRes.body.result) &&
        fsRes.body.result.length >= 3;
      const arrOk =
        arrRes.status === 200 &&
        Array.isArray(arrRes.body.result) &&
        arrRes.body.result.length >= 2;
      if (fsOk && arrOk) break;
      if (Date.now() > deadline) {
        throw withAgentStderr(new Error('filesystems/arrays never observed'));
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

  it('1. create: day-1 mkfs with the CLAMPED log size + unit + mount', async () => {
    const planned = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'POST', {
      mode: 'plan',
      spec: {
        backing_device: '/dev/xi_data',
        mountpoint: '/mnt/data',
        log_device: '/dev/xi_log',
        log_size: '1G',
        quota_mode: 'uquota',
        mount_options: ['noatime'],
      },
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);
    // The plan PREVIEW shows the unclamped request (clamping is executor-side).
    expect((plan.diff as Record<string, unknown>).mkfs_argv_preview).toContain(
      'logdev=/dev/xi_log,size=1073741824',
    );

    const applied = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: 0,
      idempotency_key: 'e2e-fs-create',
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    ).catch((e) => {
      throw withAgentStderr(e);
    });
    expect(task.state, JSON.stringify(task)).toBe('success');

    // The recorded argv carries the CLAMPED size (512 MiB device < 1G ask).
    const mkfsOps = fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'));
    expect(mkfsOps).toHaveLength(1);
    expect(mkfsOps[0]).toContain('-d su=128k,sw=3');
    expect(mkfsOps[0]).toContain('logdev=/dev/xi_log,size=536870912');
    expect(mkfsOps[0]).toContain('-s size=4096');
    expect(mkfsOps[0]?.endsWith('/dev/xi_data')).toBe(true);

    // Unit installed with the day-1 shape + mounted.
    const text = fakeHost.unitText('mnt-data.mount');
    expect(text).toContain('What=/dev/xi_data');
    expect(text).toContain('logdev=/dev/xi_log');
    expect(text).toContain('uquota');
    expect(await fakeHost.readMounts()).toContainEqual({
      source: '/dev/xi_data',
      mountpoint: '/mnt/data',
    });
  });

  it('2. unmount gates: BOTH dependent_share_active and mountpoint_exported fire', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-share.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mounted: false } },
    );
    expect(planned.status).toBe(200);
    const codes = (planned.body.result as { blockers: Array<{ code: string }> }).blockers
      .map((b) => b.code)
      .sort();
    expect(codes).toEqual(['dependent_share_active', 'mountpoint_exported']);
  });

  it('3. unmount + mount round-trip on the quiet filesystem', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mounted: false } },
    );
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);
    expect(plan.risk_level).toBe('changing_access');

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: await fsRevision('mnt-free.mount'),
        idempotency_key: 'e2e-fs-unmount',
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');
    expect(await fakeHost.readMounts()).not.toContainEqual({
      source: '/dev/xi_free',
      mountpoint: '/mnt/free',
    });

    // remount
    const planned2 = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mounted: true } },
    );
    const plan2 = planned2.body.result as Record<string, unknown>;
    expect(plan2.blockers).toEqual([]);
    const applied2 = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: plan2.plan_id,
        expected_revision: await fsRevision('mnt-free.mount'),
        idempotency_key: 'e2e-fs-mount',
      },
    );
    expect(applied2.status, JSON.stringify(applied2.body)).toBe(202);
    const task2 = await waitForTaskState(
      apiSockPath,
      (applied2.body.result as { task_id: string }).task_id,
    );
    expect(task2.state, JSON.stringify(task2)).toBe('success');
    expect(await fakeHost.readMounts()).toContainEqual({
      source: '/dev/xi_free',
      mountpoint: '/mnt/free',
    });
  });

  it('4. grow: xfs_growfs recorded; rollback_model unsupported', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { grow: true } },
    );
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);
    expect(plan.rollback_model).toBe('unsupported');

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: await fsRevision('mnt-free.mount'),
        idempotency_key: 'e2e-fs-grow',
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');
    expect(fakeHost.ops()).toContain('xfs_growfs /mnt/free');
  });

  it('5. quota: Options= rewritten to pquota with a remount', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { quota_mode: 'pquota' } },
    );
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.risk_level).toBe('changing_access');
    expect((plan.warnings as Array<{ code: string }>).map((w) => w.code)).toContain(
      'remount_required',
    );

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: await fsRevision('mnt-free.mount'),
        idempotency_key: 'e2e-fs-quota',
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');
    expect(fakeHost.unitText('mnt-free.mount')).toContain('pquota');
    expect(fakeHost.ops()).toContain('stop:mnt-free.mount'); // the remount
  });

  it('6. identity field on PATCH → 422 fs_identity_immutable', async () => {
    const res = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-free.mount',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { label: 'nope' } },
    );
    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.details?.reason).toBe('fs_identity_immutable');
  });

  it('7. unmanage: mounted blocked; cold target removed WITHOUT dangerous', async () => {
    const blocked = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-share.mount',
      ADMIN_TOKEN,
      'DELETE',
      { mode: 'plan' },
    );
    expect(blocked.status).toBe(200);
    expect(
      (blocked.body.result as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code),
    ).toEqual(['fs_mounted']);

    const planned = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-cold.mount',
      ADMIN_TOKEN,
      'DELETE',
      { mode: 'plan' },
    );
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);
    expect(plan.risk_level).toBe('non_disruptive');

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/filesystems/mnt-cold.mount',
      ADMIN_TOKEN,
      'DELETE',
      {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: await fsRevision('mnt-cold.mount'),
        idempotency_key: 'e2e-fs-unmanage',
        // deliberately NO dangerous flag — unmanage never destroys data
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');
    expect(fakeHost.unitText('mnt-cold.mount')).toBeUndefined();
  });

  it('8. force-create: engine dangerous gate, then overwrite succeeds', async () => {
    const planned = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'POST', {
      mode: 'plan',
      spec: {
        backing_device: '/dev/xi_data',
        mountpoint: '/mnt/data2',
        force: true,
      },
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.risk_level).toBe('destructive');
    expect((plan.blockers as Array<{ code: string }>).map((b) => b.code)).toEqual([
      'dangerous_flag_required',
    ]);

    const refused = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: 0,
      idempotency_key: 'e2e-fs-force-no-flag',
    });
    expect(refused.status).toBe(412);
    expect(refused.body.errors?.[0]?.details?.reason).toBe('dangerous_flag_required');

    const applied = await requestJson(apiSockPath, '/api/v1/filesystems', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: 0,
      idempotency_key: 'e2e-fs-force',
      dangerous: true,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');

    // The second mkfs ran over the scenario-1 filesystem (force path: blkid
    // showed xfs and preflight let it through only because force was set).
    const mkfsOps = fakeHost.ops().filter((o) => o.startsWith('mkfs.xfs'));
    expect(mkfsOps).toHaveLength(2);
    expect(mkfsOps[1]).toContain('-L data2');
  });
});
