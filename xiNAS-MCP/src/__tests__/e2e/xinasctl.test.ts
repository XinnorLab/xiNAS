// @vitest-environment node
/**
 * End-to-end (S8 T10): xinasctl against a REAL xinas-api + xinas-agent
 * over UNIX sockets in fixture probe mode.
 *
 *   1. reads — arrays list / health check via UDS peer trust + --json.
 *   2. plan — shares create --plan returns a plan envelope through the
 *      same engine REST uses.
 *   3. apply+wait — support bundle --wait runs the full task to
 *      success; support download streams a gzip to stdout.
 *   4. token path — a viewer token may read but not plan.
 */

import { type ChildProcess, execFile, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const CTL_ENTRY = join(PROJECT_ROOT, 'dist/cli/xinasctl.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000d8e4';
const ADMIN_TOKEN = 'e2e-admin-tok';
const VIEWER_TOKEN = 'e2e-viewer-tok';
const AGENT_TOKEN = 'e2e-agent-tok';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CtlOut {
  code: number;
  stdout: string;
  stderr: string;
}

function ctl(args: string[], socket: string): Promise<CtlOut> {
  return new Promise((resolveP) => {
    execFile(
      process.execPath,
      [CTL_ENTRY, ...args, '--socket', socket],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        resolveP({
          code: err === null ? 0 : ((err as { code?: number }).code ?? 1),
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
        });
      },
    );
  });
}

describe.sequential('e2e: S8 xinasctl (fixture mode)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY) || !existsSync(CTL_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-ctl-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const bundleDir = join(tmpDir, 'bundles');
    mkdirSync(bundleDir, { recursive: true });
    const fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });

    writeFileSync(join(tmpDir, 'controller-id'), `${CONTROLLER_ID}\n`);
    writeFileSync(join(tmpDir, 'agent-token'), `${AGENT_TOKEN}\n`);
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({ arrays: [], pools: [], import_candidates: [], tombstones: [] }),
    );
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
    writeFileSync(join(fixtureDir, 'nfs-exports.json'), JSON.stringify([]));
    writeFileSync(join(fixtureDir, 'journals.json'), JSON.stringify({}));
    writeFileSync(join(fixtureDir, 'bundle-configs.json'), JSON.stringify({}));
    // the task runner's xinas_history bridge shells out to python3 —
    // shim it like the other e2e harnesses so snapshots no-op cleanly.
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
      spec: { display_name: 'e2e' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    await seedStore.close();

    writeFileSync(
      join(tmpDir, 'api-config.json'),
      JSON.stringify({
        controller_id: CONTROLLER_ID,
        listen: { kind: 'unix', socket: apiSockPath },
        tokens: {
          [ADMIN_TOKEN]: { principal: 'admin:e2e', role: 'admin' },
          [VIEWER_TOKEN]: { principal: 'viewer:e2e', role: 'viewer' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: 300 },
        support_bundle_dir: bundleDir,
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
        await new Promise<void>((resolveP, reject) => {
          const req = http.get(
            {
              socketPath: apiSockPath,
              path: '/api/v1/arrays',
              headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
            },
            (res) => {
              res.resume();
              res.statusCode === 200 ? resolveP() : reject(new Error(`status ${res.statusCode}`));
            },
          );
          req.on('error', reject);
        });
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`api never ready\n${apiStderr.join('')}`);
        }
        await sleep(100);
      }
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${join(tmpDir, 'bin')}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: join(tmpDir, 'agent-config.json'),
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));
    await sleep(1200); // first heartbeat + sweeps
  }, 120_000);

  afterAll(async () => {
    agentProc?.kill('SIGKILL');
    apiProc?.kill('SIGKILL');
    await sleep(100);
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads over UDS peer trust: arrays list + health check --json', async () => {
    const arrays = await ctl(['arrays', 'list', '--json'], apiSockPath);
    expect(arrays.code, arrays.stderr).toBe(0);
    expect(JSON.parse(arrays.stdout)).toHaveProperty('result');

    const health = await ctl(['health', 'check', '--profile', 'quick', '--json'], apiSockPath);
    expect(health.code, health.stderr).toBe(0);
    const env = JSON.parse(health.stdout) as { result: { overall: string } };
    expect(['ok', 'warning', 'degraded', 'critical']).toContain(env.result.overall);
  });

  it('plan through the CLI returns the same plan envelope REST gets', async () => {
    const plan = await ctl(
      [
        'shares',
        'create',
        '--plan',
        '--spec',
        JSON.stringify({
          path: '/mnt/data',
          fsid: 1,
          clients: [{ pattern: '*', options: ['rw'] }],
        }),
        '--json',
      ],
      apiSockPath,
    );
    expect(plan.code, plan.stderr).toBe(0);
    const env = JSON.parse(plan.stdout) as { result: { plan_id?: string } };
    expect(env.result.plan_id).toBeTruthy();
  });

  it(
    'apply + --wait: support bundle to success; download streams gzip',
    { timeout: 60_000 },
    async () => {
      const bundle = await ctl(['support', 'bundle', '--json', '--wait'], apiSockPath);
      expect(bundle.code, bundle.stderr).toBe(0);
      const env = JSON.parse(bundle.stdout) as { result: { task_id: string } };
      expect(bundle.stderr).toContain('success');

      const dl = await ctl(['support', 'download', env.result.task_id], apiSockPath);
      expect(dl.code, dl.stderr).toBe(0);
      expect(dl.stdout.length).toBeGreaterThan(0);
    },
  );

  it('viewer token reads but cannot plan', async () => {
    const list = await ctl(['arrays', 'list', '--token', VIEWER_TOKEN, '--json'], apiSockPath);
    expect(list.code, list.stderr).toBe(0);

    const plan = await ctl(
      [
        'shares',
        'create',
        '--plan',
        '--spec',
        '{"path":"/mnt/data","clients":[]}',
        '--token',
        VIEWER_TOKEN,
      ],
      apiSockPath,
    );
    expect(plan.code).toBe(1);
    expect(plan.stderr).toContain('PERMISSION_DENIED');
  });
});
