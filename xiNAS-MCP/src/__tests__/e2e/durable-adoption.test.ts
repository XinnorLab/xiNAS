// @vitest-environment node
/**
 * End-to-end (S12 T8, ADR-0015): durable adoption of a targeted snapshot
 * restore against a REAL xinas-api + xinas-agent over UNIX sockets (fixture
 * probe mode). The python3 shim answers `snapshot restore` with success so the
 * config-rollback executor's restore stage completes — the adopt overlay
 * (desired_mutations: put captured rows + delete orphans) rides the SAME
 * plan→apply transaction and is asserted against desired KV via GET /shares.
 *
 * Design note: in fixture mode the python3 shim returns a FIXED snapshot id, so
 * the real create→capture→observe choreography would collide (the
 * ConfigSnapshot collector reads a static fixture). Capture is unit-covered in
 * tests for snapshot-desired (T2) and the adopt apply transaction is unit-
 * covered in adopt-apply.test.ts (T5). Here the adopt PRECONDITIONS are SEEDED
 * directly via the state store in beforeAll, then the ADOPT plan→apply path is
 * driven over the real api+agent:
 *   - observed ConfigSnapshot `snap-adopt` (restorable) + its snapshot-desired
 *     payload capturing ONLY Share expA → the provider resolves it + adopts;
 *   - observed ConfigSnapshot `snap-bare` (restorable) with NO snapshot-desired
 *     payload → not_adoptable;
 *   - current desired Shares expA (/a) and expB (/b).
 *
 *   1. adopt happy path: plan {to: snap-adopt, adopt:true} → only the dangerous
 *      advisory blocker, diff shows put expA + delete expB; dangerous apply →
 *      task success; desired KV shows expA present and expB GONE.
 *   2. not_adoptable: plan {to: snap-bare, adopt:true} → blockers include
 *      not_adoptable (observed, restorable, but no captured desired payload).
 *   3. baseline + adopt: plan {to: baseline, adopt:true} → 4xx INVALID_ARGUMENT.
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

describe.sequential('e2e: S12 durable adoption (fixture mode)', () => {
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

  /** Read the current desired Share ids over the real api (post-apply assertion). */
  async function shareIds(): Promise<string[]> {
    const res = await rest(apiSockPath, 'GET', '/api/v1/shares');
    return (res.body.result as Array<{ id?: string }>).map((s) => s.id ?? '');
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-s12-'));
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
    // config-snapshots fixture: the agent's ConfigSnapshotCollector re-emits one
    // observed ConfigSnapshot row PER manifest on EVERY sweep (complete-snapshot
    // reconcile), so observed/ConfigSnapshot/* rows can NOT be seeded directly —
    // the first sweep would delete an unbacked seed. Both target snapshots are
    // marked restorable:true (file-level restore is possible). The adopt gate is
    // independent: snap-adopt has a captured snapshot-desired payload (adoptable)
    // seeded below; snap-bare has none (not_adoptable) even though it IS
    // restorable. `type: rollback_eligible` projects to kind=after.
    writeFileSync(
      join(fixtureDir, 'config-snapshots.json'),
      JSON.stringify([
        {
          id: 'snap-adopt',
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
          user: 'admin:demo',
          source: 'mcp',
          type: 'rollback_eligible',
          operation: 'share_create',
          diff_summary: 'edited exports',
          restorable: true,
          files_changed: ['etc_exports'],
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
      spec: { display_name: 'e2e-s12' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seed.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-s12-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });

    // Observed ConfigSnapshot rows (snap-adopt, snap-bare) come from the
    // config-snapshots fixture above, NOT seeded here — the agent's
    // complete-snapshot reconcile would delete an unbacked observed seed.

    // Current desired Shares: expA (kept/re-asserted), expB (orphan → deleted).
    // Desired state is operator-owned (not pushed by the agent), so these
    // survive the agent's observed-state reconcile.
    seed.kv.put('/xinas/v1/desired/Share/expA', {
      kind: 'Share',
      id: 'expA',
      spec: { path: '/a', clients: [], fsid: 1 },
    });
    seed.kv.put('/xinas/v1/desired/Share/expB', {
      kind: 'Share',
      id: 'expB',
      spec: { path: '/b', clients: [], fsid: 2 },
    });

    // The snapshot-desired payload capturing ONLY Share expA (matches the shape
    // captureSnapshotDesired writes: snapshot_id + kinds keyed by ADOPT_KINDS).
    seed.kv.put('/xinas/v1/snapshot-desired/snap-adopt', {
      snapshot_id: 'snap-adopt',
      kinds: {
        Share: [{ id: 'expA', spec: { path: '/a', clients: [], fsid: 1 } }],
        ExportGroup: [],
        NfsProfile: [],
        NetworkInterface: [],
      },
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

    // settle: the snap-adopt snapshot is observed with restorable=true. This is
    // the same end-to-end readiness the S11 targeted-rollback settle uses — it
    // proves both that the agent's ConfigSnapshot collector has pushed the
    // fixture rows AND that the full bidirectional channel is warm, so the first
    // api→agent `task.begin` does not race a still-establishing connection.
    const settle = Date.now() + 15_000;
    for (;;) {
      const snaps = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots');
      const row = (snaps.body.result as Array<{ snapshot_id?: string; restorable?: boolean }>).find(
        (s) => s.snapshot_id === 'snap-adopt',
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

  it('1. adopt happy path → plan (dangerous-only) + dangerous apply → success; expA kept, expB gone', async () => {
    // Sanity: both shares exist before adoption.
    expect((await shareIds()).sort()).toEqual(['expA', 'expB']);

    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-adopt', reason: 'make exports durable', adopt: true },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const planResult = plan.body.result as {
      plan_id: string;
      state_revision_expected?: number;
      risk_level: string;
      blockers: Array<{ code: string }>;
      diff: { adopt?: boolean; desired_puts?: string[]; desired_deletes?: string[] };
    };
    // adopt is feasible → only the always-on dangerous advisory blocks.
    expect(planResult.risk_level).toBe('destructive');
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
    // The plan diff exposes the desired blast radius: put expA, delete expB.
    expect(planResult.diff.adopt).toBe(true);
    expect(planResult.diff.desired_puts).toEqual(['/xinas/v1/desired/Share/expA']);
    expect(planResult.diff.desired_deletes).toEqual(['/xinas/v1/desired/Share/expB']);

    const apply = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: 'adopt-1',
      expected_revision: planResult.state_revision_expected ?? 0,
      dangerous: true,
    });
    expect(apply.status, JSON.stringify(apply.body)).toBe(202);
    const state = await waitForTask((apply.body.result as { task_id: string }).task_id);
    expect(state, agentStderr.join('').slice(-2000)).toBe('success');

    // Durable: desired KV now has expA and NO expB (the orphan was deleted by
    // the adopt overlay's desired_mutations, committed in the apply transaction).
    const ids = await shareIds();
    expect(ids).toContain('expA');
    expect(ids).not.toContain('expB');
  }, 40_000);

  it('2. observed-but-not-captured snapshot → plan blocks with not_adoptable', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-bare', reason: 'x', adopt: true },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(JSON.stringify((plan.body.result as { blockers: unknown[] }).blockers)).toContain(
      'not_adoptable',
    );
  });

  it('3. baseline + adopt → 4xx INVALID_ARGUMENT', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'baseline', reason: 'x', adopt: true },
    });
    expect(plan.status).toBeGreaterThanOrEqual(400);
    expect(plan.status).toBeLessThan(500);
    expect(JSON.stringify(plan.body.errors)).toContain('INVALID_ARGUMENT');
  });
});
