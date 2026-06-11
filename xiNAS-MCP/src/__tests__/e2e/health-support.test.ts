// @vitest-environment node
/**
 * End-to-end (S7 T8): health profiles, drift, and the support bundle
 * against a REAL xinas-api + xinas-agent over UNIX sockets in fixture
 * probe mode.
 *
 * Scenario chain (sequential):
 *   1. baseline — healthy fixtures: quick health answers with the full
 *      catalog (nfs.server ok from systemd-units.json, tuning ok),
 *      /config-history/drift is empty.
 *   2. drift — desired Share with no observed ExportRule + a desired
 *      NetworkInterface diverging from the observed 99-xinas hash →
 *      drift.nfs-exports + drift.netplan degraded in /health AND
 *      /config-history/drift (nfs-conf not_evaluated).
 *   3. standard — the probe RPC: parsed license (warning <30 days, NO
 *      raw material in the response), rdma-live ok, collectors.
 *   4. deep — fake ProbeHost: one fs touch failure → filesystem.io
 *      critical; loopback attempted for the first export and UNMOUNTED
 *      (ops recorded).
 *   5. agent down — SIGSTOP: standard degrades ONLY probe-backed
 *      checks with EXECUTOR_UNAVAILABLE; SIGCONT recovers.
 *   6. bundle — POST /support-bundle → 202 → task success → GET streams
 *      a tar.gz whose extracted files carry no seeded secrets and a
 *      PARSED-only license.
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

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000c7e3';
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

function requestRaw(
  socketPath: string,
  path: string,
  token: string,
  method: 'GET' | 'POST',
  bodyObj?: unknown,
): Promise<{ status: number; buffer: Buffer }> {
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
        res.on('end', () =>
          resolveP({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function requestJson(
  socketPath: string,
  path: string,
  token: string,
  method: 'GET' | 'POST',
  bodyObj?: unknown,
): Promise<JsonResponse> {
  const { status, buffer } = await requestRaw(socketPath, path, token, method, bodyObj);
  return { status, body: JSON.parse(buffer.toString('utf8')) as JsonResponse['body'] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface HealthCheck {
  id: string;
  status: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
}

interface HealthReport {
  profile: string;
  overall: string;
  checks: HealthCheck[];
}

const DESIRED_IFACE = {
  name: 'ibp65s0',
  addresses: ['10.10.1.1/24'],
  enabled: true,
  pbr_table_id: 100,
};

describe.sequential('e2e: S7 health/drift/support (fixture mode)', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let bundleDir: string;
  let dbPath: string;
  let auditPath: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  function withAgentStderr(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${msg}\n--- agent stderr ---\n${agentStderr.join('')}`);
  }

  async function health(profile: string): Promise<HealthReport> {
    const res = await requestJson(
      apiSockPath,
      `/api/v1/health?profile=${profile}`,
      ADMIN_TOKEN,
      'GET',
    );
    expect(res.status).toBe(200);
    return res.body.result as HealthReport;
  }

  const byId = (report: HealthReport): Map<string, HealthCheck> =>
    new Map(report.checks.map((c) => [c.id, c]));

  async function seedDesired(key: string, value: unknown): Promise<void> {
    const store = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    store.kv.put(key, value);
    await store.close();
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-health-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    dbPath = join(tmpDir, 'xinas.db');
    auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');
    bundleDir = join(tmpDir, 'bundles');
    mkdirSync(bundleDir, { recursive: true });

    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({ arrays: [], pools: [], import_candidates: [], tombstones: [] }),
    );
    // a mounted managed filesystem (deep fs_io probe target)
    writeFileSync(
      join(fixtureDir, 'filesystems.json'),
      JSON.stringify([
        {
          kind: 'Filesystem',
          id: 'mnt-data.mount',
          status: {
            mountpoint: '/mnt/data',
            mounted: true,
            mount_unit_enabled: true,
            backing_device: '/dev/xi_data',
          },
        },
      ]),
    );
    // observed exports matching the desired share seeded in scenario 2/4
    writeFileSync(
      join(fixtureDir, 'nfs-exports.json'),
      JSON.stringify([
        { export_path: '/mnt/data', host_pattern: '*', options: ['rw', 'no_subtree_check'] },
      ]),
    );
    // systemd: real-promotion fixture rows
    writeFileSync(
      join(fixtureDir, 'systemd-units.json'),
      JSON.stringify({
        'nfs-server.service': {
          load_state: 'loaded',
          active_state: 'active',
          sub_state: 'exited',
          unit_file_state: 'enabled',
        },
        'rpcbind.service': { load_state: 'loaded', active_state: 'active', sub_state: 'running' },
        'xinas-api.service': { load_state: 'loaded', active_state: 'active', sub_state: 'running' },
        'xinas-agent.service': {
          load_state: 'loaded',
          active_state: 'active',
          sub_state: 'running',
        },
      }),
    );
    // tuning: one matching entry
    writeFileSync(
      join(fixtureDir, 'tuning.json'),
      JSON.stringify({
        entries: [{ key: 'sunrpc.tcp_max_slot_table_entries', expected: '128', actual: '128' }],
      }),
    );
    // license expiring in ~20 days → standard warning. NOTE the hwkey
    // line: recoverable material that must never surface anywhere.
    const expiry = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(
      join(fixtureDir, 'xicli-license.txt'),
      `hwkey: ZZZZ-RECOVERABLE-KEY\nstatus: valid\nexpiration date: ${expiry}\nlevels: 5 6 7\n`,
    );
    writeFileSync(join(fixtureDir, 'xicli-raid.json'), '{"arrays": []}');
    // the netplan world: 99-xinas rendered EXACTLY from the desired row
    // we seed later → drift.netplan starts clean, then we mutate.
    writeFileSync(
      join(fixtureDir, 'net-host-state.json'),
      JSON.stringify({
        netplan_files: { [XINAS_NETPLAN]: renderNetplan([DESIRED_IFACE]) },
        kernel: { addrs: { ibp65s0: ['10.10.1.1/24'] }, rules: [], tables: {} },
        sys_class_net: [
          { name: 'ibp65s0', driver: 'mlx5_core' },
          { name: 'eno1', driver: 'igb' },
        ],
        rdma_links: [
          { ifname: 'mlx5_0', netdev: 'ibp65s0', state: 'ACTIVE', physical_state: 'LINK_UP' },
        ],
        ops: [],
      }),
    );
    // probe host: touch fails on a second (phantom) mountpoint? No —
    // fail the loopback for nothing; scenario 4 sets fail_touch live.
    writeFileSync(join(fixtureDir, 'probe-host-state.json'), JSON.stringify({ ops: [] }));
    // helper dry render: match what we seed as observed effective_files
    writeFileSync(
      join(fixtureDir, 'nfs-profile-render.json'),
      JSON.stringify({ '/etc/nfs/nfsd.conf': 'sha256:feed' }),
    );
    writeFileSync(
      join(fixtureDir, 'nfs-profile.json'),
      JSON.stringify({
        effective_files: { '/etc/nfs/nfsd.conf': 'sha256:feed' },
        service: { active: true },
      }),
    );
    // bundle fixtures: journals/configs seeded WITH secrets
    writeFileSync(
      join(fixtureDir, 'journals.json'),
      JSON.stringify({
        'xinas-api.service': 'request ok Authorization: Bearer sk-e2e-LEAK\n',
        'xinas-agent.service': 'agent started\n',
        'xinas-nfs-helper.service': '',
        'nfs-server.service': 'nfsd running\n',
        'xiraid.service': '',
      }),
    );
    writeFileSync(
      join(fixtureDir, 'bundle-configs.json'),
      JSON.stringify({
        '/etc/exports': '/mnt/data *(rw,no_subtree_check)\n',
        '/etc/nfs/nfsd.conf': '[nfsd]\nthreads=64\n',
      }),
    );
    writeFileSync(join(fixtureDir, 'snapshots-index.json'), JSON.stringify(['snap-e2e-1']));

    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(
      join(shimBin, 'python3'),
      '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n',
      {
        mode: 0o755,
      },
    );

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
        support_bundle_dir: bundleDir,
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
    {
      const deadline = Date.now() + 8000;
      for (;;) {
        try {
          await requestJson(apiSockPath, '/api/v1/capabilities', ADMIN_TOKEN, 'GET');
          break;
        } catch {
          if (Date.now() > deadline) {
            throw new Error(`api never ready\n--- api stderr ---\n${apiStderr.join('')}`);
          }
          await sleep(100);
        }
      }
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${join(tmpDir, 'bin')}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: agentConfigPath,
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
        XINAS_AGENT_NETWORK_POLL_MS: '500',
        XINAS_AGENT_XIRAID_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    // settle: heartbeat healthy + the promoted systemd rows observed
    const deadline = Date.now() + 15_000;
    for (;;) {
      const report = await health('quick');
      const checks = byId(report);
      if (
        checks.get('agent.connectivity')?.status === 'ok' &&
        checks.get('nfs.server')?.status === 'ok' &&
        checks.get('tuning.sysctl')?.status === 'ok'
      ) {
        break;
      }
      if (Date.now() > deadline) {
        throw withAgentStderr(
          new Error(`baseline never healthy: ${JSON.stringify(report.checks)}`),
        );
      }
      await sleep(250);
    }
  }, 120_000);

  afterAll(async () => {
    agentProc?.kill('SIGKILL');
    apiProc?.kill('SIGKILL');
    await sleep(100);
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. baseline: quick catalog healthy; drift API empty', async () => {
    const report = await health('quick');
    const checks = byId(report);
    expect(report.overall).toBe('ok');
    expect(checks.get('xinas-api.alive')?.status).toBe('ok');
    expect(checks.get('systemd.units')?.status).toBe('ok');
    expect(checks.get('nfs.server')?.status).toBe('ok');
    expect(checks.get('tuning.sysctl')?.status).toBe('ok');
    // nothing desired yet → drift checks skipped
    expect(checks.get('drift.nfs-exports')?.status).toBe('skipped');
    expect(checks.get('drift.netplan')?.status).toBe('skipped');
    expect(checks.get('drift.nfs-conf')?.status).toBe('skipped');

    const drift = await requestJson(
      apiSockPath,
      '/api/v1/config-history/drift',
      ADMIN_TOKEN,
      'GET',
    );
    expect(drift.status).toBe(200);
    expect((drift.body.result as { drift: unknown[] }).drift).toEqual([]);
  });

  it('2. drift trio fires in /health and the drift API', async () => {
    // a desired share whose path has NO observed export
    await seedDesired('/xinas/v1/desired/Share/ghost', {
      kind: 'Share',
      id: 'ghost',
      spec: { path: '/mnt/ghost', clients: [{ pattern: '*', options: ['rw'] }] },
    });
    // a desired iface diverging from the rendered 99-xinas (mtu added)
    await seedDesired('/xinas/v1/desired/NetworkInterface/ibp65s0', {
      kind: 'NetworkInterface',
      id: 'ibp65s0',
      spec: { addresses: ['10.10.1.1/24'], mtu: 9000, enabled: true, pbr_table_id: 100 },
    });
    await seedDesired('/xinas/v1/desired/NfsProfile/default', {
      kind: 'NfsProfile',
      id: 'default',
      spec: { versions: {} },
    });

    const report = await health('quick');
    const checks = byId(report);
    expect(checks.get('drift.nfs-exports')?.status).toBe('degraded');
    expect((checks.get('drift.nfs-exports')?.evidence as { missing: string[] }).missing).toContain(
      '/mnt/ghost',
    );
    expect(checks.get('drift.netplan')?.status).toBe('degraded');
    expect(checks.get('drift.nfs-conf')?.status).toBe('skipped'); // quick
    expect(checks.get('nfs.exports')?.status).toBe('degraded');

    const drift = await requestJson(
      apiSockPath,
      '/api/v1/config-history/drift',
      ADMIN_TOKEN,
      'GET',
    );
    const entries = (drift.body.result as { drift: Array<{ artifact: string; status: string }> })
      .drift;
    expect(entries.find((e) => e.artifact === 'drift.nfs-exports')?.status).toBe('degraded');
    expect(entries.find((e) => e.artifact === 'drift.netplan')?.status).toBe('degraded');
    expect(entries.find((e) => e.artifact === 'drift.nfs-conf')?.status).toBe('not_evaluated');

    // repair the share drift for later scenarios (point it at the
    // actually-exported path)
    await seedDesired('/xinas/v1/desired/Share/ghost', {
      kind: 'Share',
      id: 'ghost',
      spec: {
        path: '/mnt/data',
        clients: [{ pattern: '*', options: ['rw', 'no_subtree_check'] }],
      },
    });
  });

  it('3. standard: parsed license warning, rdma-live, collectors — zero raw material', async () => {
    const report = await health('standard');
    const checks = byId(report);
    const license = checks.get('xiraid.license');
    expect(license?.status).toBe('warning');
    expect((license?.evidence as { days_left?: number }).days_left).toBeLessThan(30);
    expect(checks.get('network.rdma-live')?.status).toBe('ok');
    expect(checks.get('agent.collectors')?.status).toBe('ok');
    expect(checks.get('xiraid.service')?.status).toBe('ok');
    // drift.nfs-conf now evaluated: render matches the observed files
    expect(checks.get('drift.nfs-conf')?.status).toBe('ok');
    // the recoverable license material never crosses the wire
    expect(JSON.stringify(report)).not.toContain('RECOVERABLE-KEY');
    expect(JSON.stringify(report)).not.toContain('hwkey');
  });

  it('4. deep: fs touch failure critical; loopback attempted + unmounted', async () => {
    writeFileSync(
      join(fixtureDir, 'probe-host-state.json'),
      JSON.stringify({ fail_touch: ['/mnt/data'], ops: [] }),
    );
    const report = await health('deep');
    const checks = byId(report);
    expect(checks.get('filesystem.io')?.status).toBe('critical');
    expect(checks.get('nfs.loopback')?.status).toBe('ok');
    expect(report.overall).toBe('critical');

    const state = JSON.parse(readFileSync(join(fixtureDir, 'probe-host-state.json'), 'utf8')) as {
      ops: string[];
    };
    expect(state.ops).toContain('touch:/mnt/data');
    expect(state.ops).toContain('loopback:/mnt/data');
    expect(state.ops).toContain('loopback-umount:/mnt/data');

    // clear the failure; deep goes clean
    writeFileSync(join(fixtureDir, 'probe-host-state.json'), JSON.stringify({ ops: [] }));
    const clean = await health('deep');
    expect(byId(clean).get('filesystem.io')?.status).toBe('ok');
  });

  it('5. agent down: only probe-backed checks degrade; recovery restores', async () => {
    agentProc?.kill('SIGSTOP');
    try {
      const report = await health('standard');
      const checks = byId(report);
      for (const id of ['xiraid.license', 'network.rdma-live', 'drift.nfs-conf']) {
        expect(checks.get(id)?.status).toBe('degraded');
        expect((checks.get(id)?.evidence as { code?: string }).code).toBe('EXECUTOR_UNAVAILABLE');
      }
      // KV checks still answer
      expect(checks.get('nfs.server')?.status).toBe('ok');
      expect(checks.get('xinas-api.alive')?.status).toBe('ok');
    } finally {
      agentProc?.kill('SIGCONT');
    }
    // recovery
    const deadline = Date.now() + 10_000;
    for (;;) {
      const report = await health('standard');
      if (byId(report).get('xiraid.license')?.status === 'warning') break;
      if (Date.now() > deadline) throw withAgentStderr(new Error('agent never recovered'));
      await sleep(300);
    }
  }, 30_000);

  it('6. support bundle: 202 → success → streamed tar.gz, redacted, parsed-only license', async () => {
    const post = await requestJson(apiSockPath, '/api/v1/support-bundle', ADMIN_TOKEN, 'POST', {});
    expect(post.status).toBe(202);
    const taskId = (post.body.result as { task_id: string }).task_id;
    expect(taskId).toBeTruthy();

    const deadline = Date.now() + 20_000;
    for (;;) {
      const res = await requestJson(apiSockPath, `/api/v1/tasks/${taskId}`, ADMIN_TOKEN, 'GET');
      const t = res.body.result as { state: string; error_code?: string | null };
      if (TERMINAL.includes(t.state)) {
        expect(t.state, `task ended ${t.state} (${t.error_code})`).toBe('success');
        break;
      }
      if (Date.now() > deadline) throw withAgentStderr(new Error('bundle task never terminal'));
      await sleep(250);
    }

    const dl = await requestRaw(
      apiSockPath,
      `/api/v1/support-bundle/${taskId}`,
      ADMIN_TOKEN,
      'GET',
    );
    expect(dl.status).toBe(200);
    // gzip magic
    expect(dl.buffer[0]).toBe(0x1f);
    expect(dl.buffer[1]).toBe(0x8b);

    // extract + assert: no seeded secrets, license parsed-only, api half present
    const scratch = join(tmpDir, 'bundle-extract');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(tmpDir, 'dl.tar.gz'), dl.buffer);
    execSync(`tar -xzf ${join(tmpDir, 'dl.tar.gz')} -C ${scratch}`);
    const files = execSync(`find ${scratch} -type f`).toString().trim().split('\n');
    expect(files.some((f) => f.endsWith('meta.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('api/api.json'))).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('sk-e2e-LEAK');
      expect(text).not.toContain('RECOVERABLE-KEY');
      expect(text).not.toContain(ADMIN_TOKEN);
      expect(text).not.toContain(AGENT_TOKEN);
    }
    const license = JSON.parse(
      readFileSync(files.find((f) => f.endsWith('license.json')) as string, 'utf8'),
    ) as { status: string };
    expect(license.status).toBe('active');

    // a missing-task GET stays 404
    const missing = await requestRaw(
      apiSockPath,
      '/api/v1/support-bundle/never-existed',
      ADMIN_TOKEN,
      'GET',
    );
    expect(missing.status).toBe(404);
  }, 40_000);
});
