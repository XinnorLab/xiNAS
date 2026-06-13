// @vitest-environment node
/**
 * End-to-end (S11 T9, ADR-0013): targeted snapshot rollback against a REAL
 * xinas-api + xinas-agent over UNIX sockets (fixture probe mode). The python3
 * shim answers `snapshot restore` with success — the bridge → CLI → runner
 * round-trip is proven here; the runner's file-level apply/rollback are unit-
 * covered in tests/test_execute_restore_snapshot.py.
 *
 *   1. targeted restore of a RESTORABLE snapshot: plan (only the dangerous
 *      advisory) → apply with dangerous → task success.
 *   2. NON-restorable snapshot → plan blocks with no_restorable_payload.
 *   3. unknown id → plan blocks with snapshot_not_found.
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

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000c0de';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PYTHON_SHIM = `#!/bin/sh
case "$*" in
  *"snapshot restore"*) echo '{"success": true, "snapshot_id": "post-restore"}' ;;
  *"snapshot create"*) echo '{"id": "snap-shim"}' ;;
  *reset-to-baseline*) echo '{"success": true, "snapshot_id": "post-reset"}' ;;
  *) echo '{}' ;;
esac
exit 0
`;

interface JsonResponse {
  status: number;
  body: { result?: unknown; errors?: Array<{ code?: string; details?: { reason?: string } }> };
}

function rest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolveP({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonResponse['body'],
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe.sequential('e2e: S11 targeted snapshot rollback (fixture mode)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const agentStderr: string[] = [];

  async function waitForTask(taskId: string, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await rest(apiSockPath, 'GET', `/api/v1/tasks/${taskId}`);
      const state = (res.body.result as { state?: string }).state ?? 'unknown';
      if (TERMINAL.includes(state)) return state;
      if (Date.now() > deadline)
        throw new Error(`task ${taskId} never terminal\n${agentStderr.join('')}`);
      await sleep(200);
    }
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-s11-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, 'python3'), PYTHON_SHIM, { mode: 0o755 });
    chmodSync(join(shimBin, 'python3'), 0o755);

    writeFileSync(join(tmpDir, 'controller-id'), `${CONTROLLER_ID}\n`);
    writeFileSync(join(tmpDir, 'agent-token'), `${AGENT_TOKEN}\n`);
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    writeFileSync(
      join(fixtureDir, 'config-snapshots.json'),
      JSON.stringify([
        {
          id: 'base-1',
          timestamp: '2026-01-01T00:00:00Z',
          user: 'root',
          source: 'installer',
          type: 'baseline',
        },
        {
          id: 'snap-restorable',
          timestamp: '2026-06-01T12:00:00Z',
          user: 'admin:demo',
          source: 'mcp',
          type: 'rollback_eligible',
          operation: 'share_create',
          diff_summary: 'edited exports',
          restorable: true,
          files_changed: ['etc_exports'],
        },
        {
          id: 'snap-bare',
          timestamp: '2026-05-01T00:00:00Z',
          user: 'root',
          source: 'installer',
          type: 'rollback_eligible',
          operation: 'raid_create',
        },
      ]),
    );

    const seed = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    seed.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-s11' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seed.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-s11-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });
    await seed.close();

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
        agent: { socket: agentSockPath, heartbeat_interval_ms: 300 },
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
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        if ((await rest(apiSockPath, 'GET', '/api/v1/capabilities')).status > 0) break;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) throw new Error('api never ready');
      await sleep(100);
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: join(tmpDir, 'agent-config.json'),
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
        XINAS_AGENT_CONFIG_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    // settle: the restorable snapshot is observed with restorable=true.
    const settle = Date.now() + 15_000;
    for (;;) {
      const snaps = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots');
      const row = (snaps.body.result as Array<{ snapshot_id?: string; restorable?: boolean }>).find(
        (s) => s.snapshot_id === 'snap-restorable',
      );
      if (row?.restorable === true) break;
      if (Date.now() > settle) {
        throw new Error(
          `snapshots never settled\n${JSON.stringify((await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots')).body.result)}\n${agentStderr.join('').slice(-2000)}`,
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

  it('1. targeted restore of a restorable snapshot → plan + dangerous apply → success', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-restorable', reason: 'undo exports' },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const planResult = plan.body.result as {
      plan_id: string;
      state_revision_expected?: number;
      risk_level: string;
      blockers: Array<{ code: string }>;
    };
    expect(planResult.risk_level).toBe('destructive');
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);

    const apply = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: 'restore-1',
      expected_revision: planResult.state_revision_expected ?? 0,
      dangerous: true,
    });
    expect(apply.status, JSON.stringify(apply.body)).toBe(202);
    const state = await waitForTask((apply.body.result as { task_id: string }).task_id);
    expect(state).toBe('success');
  }, 40_000);

  it('2. non-restorable snapshot → plan blocks with no_restorable_payload', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-bare', reason: 'x' },
    });
    expect(JSON.stringify((plan.body.result as { blockers: unknown[] }).blockers)).toContain(
      'no_restorable_payload',
    );
  });

  it('3. unknown id → plan blocks with snapshot_not_found', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'ghost', reason: 'x' },
    });
    expect(JSON.stringify((plan.body.result as { blockers: unknown[] }).blockers)).toContain(
      'snapshot_not_found',
    );
  });
});
