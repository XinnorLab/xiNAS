// @vitest-environment node
/**
 * End-to-end (S6 T10): the network adapter against a REAL xinas-api +
 * xinas-agent over UNIX sockets — fixture probe mode + the file-backed
 * fake NetHost. net-host-state.json is the SINGLE source of truth: the
 * fixture network probe reads it (observe) and the executors mutate it
 * (host), so executor effects are visible to the collector.
 *
 * Scenario chain (sequential):
 *   1. duplicate blocker — PATCH plan on an iface duplicated in
 *      50-cloud-init.yaml → duplicate_netplan_definition; GET /health
 *      shows network.duplicate-netplan at critical.
 *   2. cleanup + update — re-plan {addresses, cleanup:true} → apply →
 *      success; full-file re-render with BOTH stanzas (adoption), tables
 *      preserved, foreign file cleaned (mgmt ethernet kept), SURGICAL
 *      flush ops only for the target, generate ordered before any
 *      flush; merged GET shows the desired spec + stable revision.
 *   3. identity/unmanaged/unknown — 422 net_identity_immutable,
 *      422 iface_not_managed (ethernet), 404.
 *   4. netplan_changed gate — out-of-band netplan edit between plan and
 *      apply (observed via the per-iface duplicates signal of the same
 *      sweep) → 412.
 *   5. pool apply — addresses-only reallocation (tables UNCHANGED),
 *      GLOBAL flush ops, both ifaces re-addressed; health
 *      rdma-readiness ok.
 *   6. rollback — APPLY-FAIL marker pinned INTO the plan; apply fails;
 *      files restored byte-identical; desired rows reverted (Model R
 *      through the real api: non-success terminal).
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderNetplan } from '../../lib/net/render.js';
import { XINAS_NETPLAN } from '../../lib/parse/netplan.js';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000b6e2';
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

const PRIOR_XINAS = renderNetplan([
  { name: 'ibp65s0', addresses: ['10.10.1.1/24'], mtu: 4092, enabled: true, pbr_table_id: 100 },
  { name: 'ibp9s0f0', addresses: ['10.10.2.1/24'], enabled: true, pbr_table_id: 105 },
]);
const CLOUD_INIT =
  'network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: true\n    ibp65s0:\n      addresses: [192.168.99.5/24]\n';

describe.sequential('e2e: S6 network adapter (fixture mode + fake NetHost)', () => {
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

  function hostState(): {
    netplan_files: Record<string, string>;
    kernel: { addrs: Record<string, string[]>; rules: unknown[]; tables: Record<string, unknown> };
    ops: string[];
  } {
    return JSON.parse(readFileSync(join(fixtureDir, 'net-host-state.json'), 'utf8'));
  }

  function patchHostState(mutate: (state: Record<string, unknown>) => void): void {
    const state = JSON.parse(readFileSync(join(fixtureDir, 'net-host-state.json'), 'utf8'));
    mutate(state);
    writeFileSync(join(fixtureDir, 'net-host-state.json'), JSON.stringify(state, null, 2));
  }

  async function ifaceRow(id: string): Promise<Record<string, unknown>> {
    const res = await requestJson(
      apiSockPath,
      `/api/v1/network/interfaces/${id}`,
      ADMIN_TOKEN,
      'GET',
    );
    expect(res.status).toBe(200);
    return res.body.result as Record<string, unknown>;
  }

  /** Wait until the observed singleton reflects no duplicates for `iface`
   *  (the sweep after a cleanup/edit has landed). */
  async function waitForDuplicatesCleared(iface: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await ifaceRow(iface);
      const dups = (row.status as { duplicates_detected_in?: string[] }).duplicates_detected_in;
      if ((dups ?? []).length === 0) return;
      if (Date.now() > deadline) {
        throw withAgentStderr(new Error(`${iface} duplicates never cleared`));
      }
      await sleep(200);
    }
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-net-'));
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
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({ arrays: [], pools: [], import_candidates: [], tombstones: [] }),
    );

    // The single source of truth for observe AND the executors.
    writeFileSync(
      join(fixtureDir, 'net-host-state.json'),
      JSON.stringify({
        netplan_files: {
          [XINAS_NETPLAN]: PRIOR_XINAS,
          '/etc/netplan/50-cloud-init.yaml': CLOUD_INIT,
        },
        kernel: {
          addrs: { ibp65s0: ['10.10.1.1/24'], ibp9s0f0: ['10.10.2.1/24'] },
          rules: [
            { from: '10.10.1.1', table: 100, priority: 100 },
            { from: '10.10.2.1', table: 105, priority: 105 },
          ],
          tables: { '100': ['10.10.1.0/24 dev ibp65s0'], '105': ['10.10.2.0/24 dev ibp9s0f0'] },
        },
        sys_class_net: [
          { name: 'ibp65s0', driver: 'mlx5_core' },
          { name: 'ibp9s0f0', driver: 'mlx5_core' },
          { name: 'eno1', driver: 'igb' },
        ],
        rdma_links: [
          { ifname: 'mlx5_0', netdev: 'ibp65s0', state: 'ACTIVE', physical_state: 'LINK_UP' },
          { ifname: 'mlx5_1', netdev: 'ibp9s0f0', state: 'ACTIVE', physical_state: 'LINK_UP' },
        ],
        ops: [],
      }),
    );

    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    const python3Shim = join(shimBin, 'python3');
    writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
      mode: 0o755,
    });

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
        XINAS_AGENT_NETWORK_POLL_MS: '500',
        XINAS_AGENT_XIRAID_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    await sleep(HEARTBEAT_INTERVAL_MS * 3);

    // observed interfaces + the NetworkConfig singleton must land first
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ifaces = await requestJson(apiSockPath, '/api/v1/network/interfaces', ADMIN_TOKEN, 'GET');
      const health = await requestJson(apiSockPath, '/api/v1/health', ADMIN_TOKEN, 'GET');
      const dup = (
        (health.body.result as { checks?: Array<{ id: string; status: string }> }).checks ?? []
      ).find((c) => c.id === 'network.duplicate-netplan');
      if (
        ifaces.status === 200 &&
        Array.isArray(ifaces.body.result) &&
        ifaces.body.result.length >= 3 &&
        dup !== undefined &&
        dup.status !== 'skipped'
      ) {
        break;
      }
      if (Date.now() > deadline) {
        throw withAgentStderr(new Error('interfaces/NetworkConfig never observed'));
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

  it('1. duplicate blocker + health critical', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { addresses: ['10.10.5.1/24'] } },
    );
    expect(planned.status).toBe(200);
    const blockers = (planned.body.result as { blockers: Array<{ code: string; message: string }> })
      .blockers;
    expect(blockers.map((b) => b.code)).toEqual(['duplicate_netplan_definition']);
    expect(blockers[0]?.message).toContain('50-cloud-init.yaml');

    const health = await requestJson(apiSockPath, '/api/v1/health', ADMIN_TOKEN, 'GET');
    const checks = (health.body.result as { overall: string; checks: Array<{ id: string; status: string }> });
    expect(checks.checks.find((c) => c.id === 'network.duplicate-netplan')?.status).toBe('critical');
    expect(checks.overall).toBe('critical');
  });

  it('2. cleanup + update: adoption, surgical flush, foreign cleanup, merged read', async () => {
    const planned = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { addresses: ['10.10.5.1/24'], cleanup: true } },
    );
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);
    expect((plan.warnings as Array<{ code: string }>).map((w) => w.code)).toContain(
      'netplan_cleanup_planned',
    );
    expect((plan.diff as { cleanup_files?: unknown }).cleanup_files).toEqual({
      ibp65s0: ['/etc/netplan/50-cloud-init.yaml'],
    });

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: plan.plan_id,
        expected_revision: 0,
        idempotency_key: 'e2e-net-update',
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    ).catch((e) => {
      throw withAgentStderr(e);
    });
    expect(task.state, JSON.stringify(task)).toBe('success');

    const state = hostState();
    // full-file render: BOTH stanzas present (adoption), tables preserved
    expect(state.netplan_files[XINAS_NETPLAN]).toContain('10.10.5.1');
    expect(state.netplan_files[XINAS_NETPLAN]).toContain('ibp9s0f0');
    expect(state.netplan_files[XINAS_NETPLAN]).toContain('table: 105');
    // foreign cleanup: ibp65s0 gone, mgmt ethernet kept
    expect(state.netplan_files['/etc/netplan/50-cloud-init.yaml']).toContain('eno1');
    expect(state.netplan_files['/etc/netplan/50-cloud-init.yaml']).not.toContain('ibp65s0');
    // surgical: sibling untouched; generate before any flush
    expect(state.ops).toContain('ip-addr-flush:ibp65s0');
    expect(state.ops.filter((o) => o === 'ip-addr-flush:ibp9s0f0')).toEqual([]);
    expect(state.ops.indexOf('netplan-generate')).toBeLessThan(
      state.ops.indexOf('ip-addr-flush:ibp65s0'),
    );
    // kernel end state
    expect(state.kernel.addrs.ibp65s0).toEqual(['10.10.5.1/24']);
    expect(state.kernel.addrs.ibp9s0f0).toContain('10.10.2.1/24');

    // merged read: desired spec + desired revision
    const row = await ifaceRow('ibp65s0');
    expect((row.spec as { addresses: string[] }).addresses).toEqual(['10.10.5.1/24']);
    expect((row.spec as { pbr_table_id: number }).pbr_table_id).toBe(100);
  });

  it('3. identity 422, unmanaged 422, unknown 404', async () => {
    const identity = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { pbr_table_id: 150 } },
    );
    expect(identity.status).toBe(422);
    expect(identity.body.errors?.[0]?.details?.reason).toBe('net_identity_immutable');

    const mgmt = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/eno1',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mtu: 9000 } },
    );
    expect(mgmt.status).toBe(422);
    expect(mgmt.body.errors?.[0]?.details?.reason).toBe('iface_not_managed');

    const ghost = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ghost0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mtu: 9000 } },
    );
    expect(ghost.status).toBe(404);
  });

  it('4. netplan_changed gate: out-of-band netplan edit 412s the in-flight plan', async () => {
    // scenario 2's cleanup must be reflected in the observed singleton
    // before planning (the 500ms sweep), or the plan re-reports the
    // already-repaired duplicate.
    await waitForDuplicatesCleared('ibp65s0');
    const row = await ifaceRow('ibp65s0');
    const revision = (row.metadata as { revision: number }).revision;

    const planned = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { mtu: 9000 } },
    );
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    // Out-of-band edit: a rogue file defining ibp9s0f0 — its
    // duplicates_detected_in flipping non-empty is the deterministic
    // signal that the SAME sweep re-emitted the NetworkConfig singleton.
    patchHostState((state) => {
      (state.netplan_files as Record<string, string>)['/etc/netplan/77-rogue.yaml'] =
        'network:\n  version: 2\n  ethernets:\n    ibp9s0f0:\n      addresses: [172.16.0.1/24]\n';
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const sibling = await ifaceRow('ibp9s0f0');
      const dups = (sibling.status as { duplicates_detected_in?: string[] })
        .duplicates_detected_in;
      if ((dups ?? []).length > 0) break;
      if (Date.now() > deadline) throw withAgentStderr(new Error('rogue file never observed'));
      await sleep(200);
    }

    const res = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: (planned.body.result as { plan_id: string }).plan_id,
        expected_revision: revision,
        idempotency_key: 'e2e-net-worldhash',
      },
    );
    expect(res.status).toBe(412);
    expect(res.body.errors?.[0]?.details?.reason).toBe('netplan_changed');

    // tidy: remove the rogue file and wait for the sweep so later plans
    // pin the restored world state
    patchHostState((state) => {
      delete (state.netplan_files as Record<string, string>)['/etc/netplan/77-rogue.yaml'];
    });
    const deadline2 = Date.now() + 10_000;
    for (;;) {
      const sibling = await ifaceRow('ibp9s0f0');
      const dups = (sibling.status as { duplicates_detected_in?: string[] })
        .duplicates_detected_in;
      if ((dups ?? []).length === 0) break;
      if (Date.now() > deadline2) throw withAgentStderr(new Error('rogue file never cleared'));
      await sleep(200);
    }
  });

  it('5. pool apply: addresses-only reallocation, tables preserved, GLOBAL flush; rdma ok', async () => {
    await waitForDuplicatesCleared('ibp65s0');
    await waitForDuplicatesCleared('ibp9s0f0');
    const planned = await requestJson(apiSockPath, '/api/v1/network/ip-pool', ADMIN_TOKEN, 'POST', {
      mode: 'plan',
      spec: { start: '10.20.1.1', prefix: 24 },
    });
    expect(planned.status).toBe(200);
    const plan = planned.body.result as Record<string, unknown>;
    expect(plan.blockers).toEqual([]);

    const applied = await requestJson(apiSockPath, '/api/v1/network/ip-pool', ADMIN_TOKEN, 'POST', {
      mode: 'apply',
      plan_id: plan.plan_id,
      expected_revision: plan.state_revision_expected,
      idempotency_key: 'e2e-net-pool',
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    expect(task.state, JSON.stringify(task)).toBe('success');

    const state = hostState();
    expect(state.kernel.addrs.ibp65s0).toEqual(['10.20.1.1/24']);
    expect(state.kernel.addrs.ibp9s0f0).toEqual(['10.20.2.1/24']);
    // tables preserved through the pool
    expect(state.netplan_files[XINAS_NETPLAN]).toContain('table: 100');
    expect(state.netplan_files[XINAS_NETPLAN]).toContain('table: 105');
    // GLOBAL flush this time (both mlx devs; ethernet untouched)
    const poolOps = state.ops.slice(state.ops.lastIndexOf('netplan-generate'));
    expect(poolOps).toContain('ip-addr-flush:ibp65s0');
    expect(poolOps).toContain('ip-addr-flush:ibp9s0f0');
    expect(poolOps.filter((o) => o === 'ip-addr-flush:eno1')).toEqual([]);

    // health: duplicates repaired in scenario 2, links up, addressed → ok
    const deadline = Date.now() + 10_000;
    for (;;) {
      const health = await requestJson(apiSockPath, '/api/v1/health', ADMIN_TOKEN, 'GET');
      const checks = (health.body.result as { checks: Array<{ id: string; status: string }> })
        .checks;
      const dup = checks.find((c) => c.id === 'network.duplicate-netplan')?.status;
      const rdma = checks.find((c) => c.id === 'network.rdma-readiness')?.status;
      if (dup === 'ok' && rdma === 'ok') break;
      if (Date.now() > deadline) {
        throw withAgentStderr(new Error(`health never ok: dup=${dup} rdma=${rdma}`));
      }
      await sleep(200);
    }
  });

  it('6. rollback: apply failure restores files byte-identical + desired reverted (Model R)', async () => {
    // Pin the APPLY-FAIL marker INTO the plan: add the file FIRST, wait
    // for the sweep, then plan (the world hash covers it).
    patchHostState((state) => {
      (state.netplan_files as Record<string, string>)['/etc/netplan/60-applyfail.yaml'] =
        '# APPLY-FAIL\n';
    });
    await sleep(1500); // > 2 sweeps at 500ms — the singleton re-emits

    const before = hostState().netplan_files;
    const rowBefore = await ifaceRow('ibp65s0');
    const specBefore = rowBefore.spec as { addresses: string[] };
    const revision = (rowBefore.metadata as { revision: number }).revision;

    const planned = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      { mode: 'plan', spec: { addresses: ['10.30.1.1/24'] } },
    );
    expect(planned.status).toBe(200);
    expect((planned.body.result as { blockers: unknown[] }).blockers).toEqual([]);

    const applied = await requestJson(
      apiSockPath,
      '/api/v1/network/interfaces/ibp65s0',
      ADMIN_TOKEN,
      'PATCH',
      {
        mode: 'apply',
        plan_id: (planned.body.result as { plan_id: string }).plan_id,
        expected_revision: revision,
        idempotency_key: 'e2e-net-rollback',
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    const task = await waitForTaskState(
      apiSockPath,
      (applied.body.result as { task_id: string }).task_id,
    );
    // netplan apply fails; the executor restores the files (its own
    // re-apply rethrows on the static marker → non-success terminal
    // either way).
    expect(task.state).not.toBe('success');

    // files restored byte-identical
    const after = hostState().netplan_files;
    expect(after[XINAS_NETPLAN]).toBe(before[XINAS_NETPLAN]);
    expect(after['/etc/netplan/60-applyfail.yaml']).toBe('# APPLY-FAIL\n');

    // desired reverted (Model R through the real api on non-success)
    const rowAfter = await ifaceRow('ibp65s0');
    expect((rowAfter.spec as { addresses: string[] }).addresses).toEqual(specBefore.addresses);
  });
});
