// @vitest-environment node
/**
 * End-to-end (S13 T9, ADR-0017): TOMBSTONE adoption — restoring a snapshot
 * whose `absent_files` records that a managed file was REMOVED at capture time,
 * with adopt:true, must DELETE the current desired rows of that domain's
 * primary kind (a removed-domain tombstone). Driven against a REAL xinas-api +
 * xinas-agent over UNIX sockets (fixture probe mode). The python3 shim answers
 * `snapshot restore` with success so the config-rollback executor's restore
 * stage completes — the tombstone overlay (desired_mutations: delete the
 * primary-kind rows) rides the SAME plan→apply transaction and is asserted
 * against desired KV via GET /shares.
 *
 * Design note: the FILE-level delete (removing /etc/exports when etc_exports is
 * in the snapshot's absent_files) is runner-side and is covered by the python
 * unit tests (`tests/test_execute_restore_snapshot.py` — the S13 T3/T4
 * delete_set / recreate-on-rollback cases). Here the python3 shim returns
 * success for `snapshot restore`, so this e2e asserts the DESIRED-ROW tombstone
 * path over the real api+agent transaction, NOT the file bytes.
 *
 * Seeding (mirrors durable-adoption.test.ts):
 *   - Observed ConfigSnapshot rows come from the `config-snapshots.json` FIXTURE
 *     — NOT seeded directly into KV. The agent's ConfigSnapshotCollector
 *     re-emits one observed row per manifest on EVERY sweep (complete-snapshot
 *     reconcile), so a directly-KV-seeded observed/ConfigSnapshot/* row would be
 *     deleted on the first sweep. The fixture manifest's `absent_files` is
 *     projected (T5) onto the observed row's `status.absent_files`, which the
 *     provider reads for the tombstone gate.
 *   - `snap-tomb`: restorable, with `absent_files: ["etc_exports"]` (the file
 *     was absent at capture) → the etc_exports/Share domain tombstone-deletes.
 *   - `snap-old`: a pre-S13 snapshot with NO `absent_files` → no tombstone
 *     (proves the hinge: no absent_files → no tombstone, exact S11/S12
 *     behaviour).
 *   - `snapshot-desired/<id>` payloads (operator/api-internal prefix — NOT
 *     collector-reconciled) are seeded directly: BOTH carry an S12 payload
 *     (kinds present so neither is `not_adoptable`) but with EMPTY Share rows
 *     (the domain was removed) — so the only desired change is the tombstone.
 *   - `desired/Share/expA` — the current desired Share to be tombstone-deleted.
 *
 *   1. tombstone adopt: plan {to: snap-tomb, adopt:true} → diff.desired_deletes
 *      contains /xinas/v1/desired/Share/expA (the removed-domain tombstone is
 *      plan-visible); dangerous apply → task success; desired Share/expA GONE.
 *   2. pre-S13 skip: plan {to: snap-old, adopt:true} (no absent_files, empty
 *      Share payload) → diff.desired_deletes has NO Share/expA (no tombstone).
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

describe.sequential('e2e: S13 tombstone adoption (fixture mode)', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-s13-'));
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
    // the first sweep would delete an unbacked seed. The manifest's
    // `absent_files` (T5) is projected onto the observed row's
    // `status.absent_files`, which the tombstone overlay reads.
    //   - snap-tomb: etc_exports was ABSENT at capture → Share domain
    //     tombstone-deletes. restorable:true (absent_files non-empty widens
    //     restorable, but we set it explicitly here so the settle gate is
    //     deterministic). `type: rollback_eligible` projects to kind=after.
    //   - snap-old: pre-S13, NO absent_files (and files_changed present) → the
    //     hinge: no tombstone.
    writeFileSync(
      join(fixtureDir, 'config-snapshots.json'),
      JSON.stringify([
        {
          id: 'snap-tomb',
          timestamp: '2026-06-01T12:00:00Z',
          user: 'admin:demo',
          source: 'mcp',
          type: 'rollback_eligible',
          operation: 'share_delete',
          diff_summary: 'removed exports',
          restorable: true,
          files_changed: [],
          absent_files: ['etc_exports'],
        },
        {
          id: 'snap-old',
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
      spec: { display_name: 'e2e-s13' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seed.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-s13-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });

    // Observed ConfigSnapshot rows (snap-tomb, snap-old) come from the
    // config-snapshots fixture above, NOT seeded here — the agent's
    // complete-snapshot reconcile would delete an unbacked observed seed.

    // Current desired Share expA — the row the snap-tomb tombstone deletes.
    // Desired state is operator-owned (not pushed by the agent), so it survives
    // the agent's observed-state reconcile.
    seed.kv.put('/xinas/v1/desired/Share/expA', {
      kind: 'Share',
      id: 'expA',
      spec: { path: '/a', clients: [], fsid: 1 },
    });

    // snapshot-desired payloads (operator/api-internal prefix — NOT
    // collector-reconciled, so seeded directly). BOTH carry an S12 payload so
    // neither is `not_adoptable`; BOTH have EMPTY Share rows (the domain was
    // removed). snap-tomb's tombstone fires only because etc_exports ∈
    // absent_files; snap-old's does not (no absent_files).
    seed.kv.put('/xinas/v1/snapshot-desired/snap-tomb', {
      snapshot_id: 'snap-tomb',
      kinds: { Share: [], ExportGroup: [], NfsProfile: [], NetworkInterface: [] },
    });
    seed.kv.put('/xinas/v1/snapshot-desired/snap-old', {
      snapshot_id: 'snap-old',
      kinds: { Share: [], ExportGroup: [], NfsProfile: [], NetworkInterface: [] },
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

    // settle: the snap-tomb snapshot is observed with absent_files containing
    // etc_exports. This is the S13 readiness signal (the analogue of the S12
    // settle on `restorable`) — it proves both that the agent's ConfigSnapshot
    // collector has pushed the fixture rows AND projected absent_files onto
    // status, AND that the full bidirectional channel is warm so the first
    // api→agent `task.begin` does not race a still-establishing connection.
    const settle = Date.now() + 15_000;
    for (;;) {
      const snaps = await rest(apiSockPath, 'GET', '/api/v1/config-history/snapshots');
      const row = (
        snaps.body.result as Array<{ snapshot_id?: string; absent_files?: string[] }>
      ).find((s) => s.snapshot_id === 'snap-tomb');
      if (row?.absent_files?.includes('etc_exports') === true) break;
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

  it('1. tombstone adopt → plan shows desired_delete of Share/expA + dangerous apply → success; expA gone', async () => {
    // Sanity: the desired Share exists before the tombstone restore.
    expect(await shareIds()).toContain('expA');

    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-tomb', reason: 'restore the removed-NFS snapshot', adopt: true },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const planResult = plan.body.result as {
      plan_id: string;
      state_revision_expected?: number;
      risk_level: string;
      blockers: Array<{ code: string }>;
      diff: { adopt?: boolean; desired_puts?: string[]; desired_deletes?: string[] };
    };
    // adopt is feasible (payload present → NOT not_adoptable) → only the
    // always-on dangerous advisory blocks.
    expect(planResult.risk_level).toBe('destructive');
    expect(planResult.blockers.map((b) => b.code)).toEqual(['dangerous_flag_required']);
    // The removed-domain tombstone is plan-visible: Share/expA is deleted, and
    // there are no puts (the captured Share set is empty).
    expect(planResult.diff.adopt).toBe(true);
    expect(planResult.diff.desired_deletes).toContain('/xinas/v1/desired/Share/expA');
    expect(planResult.diff.desired_puts ?? []).not.toContain('/xinas/v1/desired/Share/expA');

    const apply = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'apply',
      plan_id: planResult.plan_id,
      idempotency_key: 'tomb-1',
      expected_revision: planResult.state_revision_expected ?? 0,
      dangerous: true,
    });
    expect(apply.status, JSON.stringify(apply.body)).toBe(202);
    const state = await waitForTask((apply.body.result as { task_id: string }).task_id);
    expect(state, agentStderr.join('').slice(-2000)).toBe('success');

    // Durable: the desired Share row is GONE (the tombstone delete committed in
    // the apply transaction). The FILE-level removal of /etc/exports is
    // runner-side and covered by tests/test_execute_restore_snapshot.py.
    expect(await shareIds()).not.toContain('expA');
  }, 40_000);

  it('2. pre-S13 snapshot (no absent_files) → plan has NO Share tombstone (the hinge)', async () => {
    const plan = await rest(apiSockPath, 'POST', '/api/v1/config-history/rollback', {
      mode: 'plan',
      spec: { to: 'snap-old', reason: 'restore a pre-S13 snapshot', adopt: true },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const planResult = plan.body.result as {
      diff: { desired_deletes?: string[] };
    };
    // No absent_files on snap-old AND an empty captured Share set → the overlay
    // neither puts nor tombstone-deletes any Share. (Proves: no absent_files →
    // no tombstone, exact S11/S12 behaviour.)
    expect(planResult.diff.desired_deletes ?? []).not.toContain('/xinas/v1/desired/Share/expA');
  });
});
