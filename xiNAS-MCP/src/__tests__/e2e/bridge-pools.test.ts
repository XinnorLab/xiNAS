// @vitest-environment node
/**
 * End-to-end (S9 T12): config-history, audit query, and pools against
 * a REAL xinas-api + xinas-agent over UNIX sockets in fixture mode.
 *
 *   1. snapshots — fixture manifests appear as projected observed
 *      rows; show serves one; diff round-trips the config.diff RPC.
 *   2. rollback — non-baseline target blocked; baseline plan→apply
 *      without dangerous → gate; with dangerous → task success (the
 *      python shim answers reset-to-baseline with success:true).
 *   3. audit — tail filters find the traffic; task_id exact lookup
 *      finds the rollback task's rows.
 *   4. pools — fixture pool observed with referenced_by; create →
 *      modify (add/activate) → delete blocked (active) → deactivate →
 *      delete blocked (referenced via fixture array) is exercised on
 *      the SECOND pool; the unreferenced pool deletes to completion;
 *      GET /pools reflects every step.
 *   5. xinasctl — pools list + the same create spec plans to the same
 *      plan_hash as REST.
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

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000f1a6';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const TERMINAL = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A python3 shim that answers per-subcommand (the bridge runs REAL subprocesses). */
const PYTHON_SHIM = `#!/bin/sh
case "$*" in
  *reset-to-baseline*) echo '{"success": true, "snapshot_id": "post-reset"}' ;;
  *"snapshot create"*) echo '{"id": "snap-shim"}' ;;
  *"snapshot list"*) echo '[]' ;;
  *"snapshot diff"*) echo '{"from_id": "a", "to_id": "b", "config_changes": []}' ;;
  *) echo '{}' ;;
esac
exit 0
`;

describe.sequential('e2e: S9 config-history / audit / pools (fixture mode)', () => {
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
      if (Date.now() > deadline) {
        throw new Error(`task ${taskId} never terminal\n${agentStderr.join('')}`);
      }
      await sleep(200);
    }
  }

  async function planApply(
    method: string,
    path: string,
    spec: Record<string, unknown>,
    dangerous = false,
  ): Promise<{ state: string; taskId: string }> {
    const plan = await rest(apiSockPath, method, path, { mode: 'plan', spec });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const planResult = plan.body.result as {
      plan_id: string;
      state_revision_expected?: number;
      blockers: Array<{ code: string }>;
    };
    const realBlockers = planResult.blockers.filter((b) => b.code !== 'dangerous_flag_required');
    expect(realBlockers, JSON.stringify(planResult.blockers)).toEqual([]);
    const apply = await rest(apiSockPath, method, path, {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: `${path}-${planResult.plan_id}`,
      expected_revision: planResult.state_revision_expected ?? 0,
      ...(dangerous ? { dangerous: true } : {}),
    });
    expect(apply.status, JSON.stringify(apply.body)).toBe(202);
    const taskId = (apply.body.result as { task_id: string }).task_id;
    const state = await waitForTask(taskId);
    return { state, taskId };
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-s9-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(join(shimBin, 'python3'), PYTHON_SHIM, { mode: 0o755 });

    writeFileSync(join(tmpDir, 'controller-id'), `${CONTROLLER_ID}\n`);
    writeFileSync(join(tmpDir, 'agent-token'), `${AGENT_TOKEN}\n`);
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({
        arrays: [
          {
            name: 'data1',
            level: 5,
            devices: ['/dev/nvme1n2'],
            state: 'online',
            sparepool: 'sp-used',
          },
        ],
        pools: [{ name: 'sp-used', drives: ['/dev/nvme8n1'], active: false }],
        import_candidates: [],
        tombstones: [],
      }),
    );
    writeFileSync(
      join(fixtureDir, 'config-snapshots.json'),
      JSON.stringify([
        {
          id: 'base-1',
          timestamp: '2026-01-01T00:00:00Z',
          user: 'root',
          source: 'installer',
          status: 'valid',
          type: 'baseline',
          rollback_class: 'destroying_data',
        },
        {
          id: 'snap-2',
          timestamp: '2026-06-01T12:00:00Z',
          user: 'admin:demo',
          source: 'mcp',
          status: 'valid',
          type: 'rollback_eligible',
          operation: 'raid_create',
          diff_summary: 'created data1',
        },
      ]),
    );
    writeFileSync(
      join(fixtureDir, 'config-diffs.json'),
      JSON.stringify({
        'base-1..snap-2': {
          from_id: 'base-1',
          to_id: 'snap-2',
          rollback_class: 'changing_access',
          config_changes: [{ file: 'etc_exports', change: 'added /mnt/data' }],
        },
      }),
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
    seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-host' },
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
    apiProc.stderr?.on('data', (c: Buffer) => agentStderr.push(`[api] ${c.toString()}`));
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const r = await rest(apiSockPath, 'GET', '/api/v1/arrays');
        if (r.status === 200) break;
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
        XINAS_AGENT_XIRAID_POLL_MS: '500',
        XINAS_AGENT_POOL_POLL_MS: '500',
        XINAS_AGENT_CONFIG_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));

    // settle: snapshots + pools observed AND the array sweep landed
    // (GET /pools joins referenced_by from observed arrays' spare_pool;
    // test 4 asserts it on its first read)
    const settleDeadline = Date.now() + 15_000;
    for (;;) {
      const snaps = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots');
      const pools = await rest(apiSockPath, 'GET', '/api/v1/pools');
      const used = (pools.body.result as Array<{ name: string; referenced_by?: string[] }>).find(
        (p) => p.name === 'sp-used',
      );
      if (
        (snaps.body.result as unknown[]).length >= 2 &&
        used?.referenced_by?.includes('data1') === true
      ) {
        break;
      }
      if (Date.now() > settleDeadline) {
        const disks = await rest(apiSockPath, 'GET', '/api/v1/users');
        throw new Error(
          `observation never settled\nsnaps=${JSON.stringify(snaps.body.result)}\npools=${JSON.stringify(pools.body.result)}\nusers=${JSON.stringify(disks.body.result).slice(0, 300)}\n${agentStderr.join('').slice(-3000)}`,
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

  it('1. snapshots projected + show + diff round-trip', async () => {
    const list = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots');
    const rows = list.body.result as Array<Record<string, unknown>>;
    const baseline = rows.find((r) => r.snapshot_id === 'base-1');
    expect(baseline).toMatchObject({ kind: 'baseline', history_type: 'baseline' });
    const after = rows.find((r) => r.snapshot_id === 'snap-2');
    expect(after).toMatchObject({ kind: 'after', operation: 'raid_create' });

    const show = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots/snap-2');
    expect((show.body.result as { diff_summary: string }).diff_summary).toBe('created data1');

    const diff = await rest(
      apiSockPath,
      'GET',
      '/api/v1/config-history/diff?from=base-1&to=snap-2',
    );
    expect(diff.status).toBe(200);
    expect((diff.body.result as { diff: { rollback_class: string } }).diff.rollback_class).toBe(
      'changing_access',
    );
    expect(diff.body.warnings).toEqual([]);
  });

  let rollbackTaskId = '';

  it('2. rollback: targeted non-restorable blocked; baseline needs dangerous; succeeds with it', async () => {
    // snap-2 is a fixture snapshot with no system_files payload → S11 blocks
    // it as non-restorable (the targeted_rollback_not_implemented blocker was
    // removed when targeted restore landed).
    const targeted = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-2', reason: 'nope' },
    });
    expect(JSON.stringify((targeted.body.result as { blockers: unknown[] }).blockers)).toContain(
      'no_restorable_payload',
    );

    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'baseline', reason: 'e2e reset' },
    });
    const planResult = plan.body.result as {
      plan_id: string;
      state_revision_expected?: number;
      risk_level: string;
    };
    expect(planResult.risk_level).toBe('destructive');

    // without dangerous → the engine gate refuses
    const refused = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: 'rollback-1',
      expected_revision: planResult.state_revision_expected ?? 0,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const applied = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: 'rollback-2',
      expected_revision: planResult.state_revision_expected ?? 0,
      dangerous: true,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    rollbackTaskId = (applied.body.result as { task_id: string }).task_id;
    expect(await waitForTask(rollbackTaskId)).toBe('success');
  }, 40_000);

  it('3. audit: tail filters + task_id exact lookup find the rollback', async () => {
    const byKind = await rest(
      apiSockPath,
      'GET',
      '/api/v1/audit?kind=http.POST./config-history/rollback&limit=10',
    );
    expect((byKind.body.result as unknown[]).length).toBeGreaterThanOrEqual(2);

    const byTask = await rest(apiSockPath, 'GET', `/api/v1/audit?task_id=${rollbackTaskId}`);
    expect((byTask.body.result as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('4. pools: lifecycle with delete blockers', async () => {
    // observed fixture pool carries referenced_by from the fixture array
    const initial = await rest(apiSockPath, 'GET', '/api/v1/pools');
    const used = (initial.body.result as Array<Record<string, unknown>>).find(
      (p) => p.name === 'sp-used',
    );
    expect(used?.referenced_by).toEqual(['data1']);

    // referenced pool delete → blocked at plan
    const refPlan = await rest(apiSockPath, 'DELETE', '/api/v1/pools/sp-used', {
      mode: 'plan',
      spec: {},
    });
    expect(JSON.stringify((refPlan.body.result as { blockers: unknown[] }).blockers)).toContain(
      'pool_referenced',
    );

    // create a fresh pool → observed
    await planApply('POST', '/api/v1/pools', { name: 'sp-new', drives: ['/dev/nvme9n1'] });
    const settle = Date.now() + 10_000;
    for (;;) {
      const pools = await rest(apiSockPath, 'GET', '/api/v1/pools');
      if ((pools.body.result as Array<{ name: string }>).some((p) => p.name === 'sp-new')) break;
      if (Date.now() > settle) throw new Error('sp-new never observed');
      await sleep(250);
    }

    // activate → observed active → delete blocked at plan
    await planApply('PATCH', '/api/v1/pools/sp-new', { active: true });
    const activeSettle = Date.now() + 10_000;
    for (;;) {
      const pools = await rest(apiSockPath, 'GET', '/api/v1/pools');
      const row = (pools.body.result as Array<{ name: string; active: boolean }>).find(
        (p) => p.name === 'sp-new',
      );
      if (row?.active === true) break;
      if (Date.now() > activeSettle) throw new Error('sp-new never active');
      await sleep(250);
    }
    const activePlan = await rest(apiSockPath, 'DELETE', '/api/v1/pools/sp-new', {
      mode: 'plan',
      spec: {},
    });
    expect(JSON.stringify((activePlan.body.result as { blockers: unknown[] }).blockers)).toContain(
      'pool_active',
    );

    // deactivate → delete to completion
    await planApply('PATCH', '/api/v1/pools/sp-new', { active: false });
    const inactiveSettle = Date.now() + 10_000;
    for (;;) {
      const pools = await rest(apiSockPath, 'GET', '/api/v1/pools');
      const row = (pools.body.result as Array<{ name: string; active: boolean }>).find(
        (p) => p.name === 'sp-new',
      );
      if (row?.active === false) break;
      if (Date.now() > inactiveSettle) throw new Error('sp-new never inactive');
      await sleep(250);
    }
    await planApply('DELETE', '/api/v1/pools/sp-new', {});
    const goneSettle = Date.now() + 10_000;
    for (;;) {
      const pools = await rest(apiSockPath, 'GET', '/api/v1/pools');
      if (!(pools.body.result as Array<{ name: string }>).some((p) => p.name === 'sp-new')) break;
      if (Date.now() > goneSettle) throw new Error('sp-new never removed');
      await sleep(250);
    }
  }, 60_000);

  it('5. xinasctl: pools list + plan-hash parity with REST', async () => {
    const ctl = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolveP) => {
        execFile(
          process.execPath,
          [CTL_ENTRY, ...args, '--socket', apiSockPath, '--token', ADMIN_TOKEN],
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

    const list = await ctl(['pools', 'list', '--json']);
    expect(list.code, list.stderr).toBe(0);
    expect(
      JSON.parse(list.stdout).result.some((p: { name: string }) => p.name === 'sp-used'),
      `stdout: ${list.stdout.slice(0, 400)}`,
    ).toBe(true);

    const SPEC = { name: 'parity-pool', drives: ['/dev/nvme9n2'] };
    const restPlan = await rest(apiSockPath, 'POST', '/api/v1/pools', {
      mode: 'plan',
      spec: SPEC,
    });
    const cliPlan = await ctl([
      'pools',
      'create',
      '--plan',
      '--spec',
      JSON.stringify(SPEC),
      '--json',
    ]);
    expect(cliPlan.code, cliPlan.stderr).toBe(0);
    expect(JSON.parse(cliPlan.stdout).result.plan_hash).toBe(
      (restPlan.body.result as { plan_hash: string }).plan_hash,
    );
  }, 30_000);
});
