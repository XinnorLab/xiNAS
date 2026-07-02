// @vitest-environment node
/**
 * End-to-end (J3): a real xinas-api process + a real xinas-agent process,
 * talking over UNIX sockets, exercised against fixture-backed probes.
 *
 * The agent runs with XINAS_AGENT_PROBE_MODE=fixture:<__fixtures__> so its
 * probes return canned data (no lsblk/getent/idmapd.conf access). Its
 * collectors → publisher push observations to the api's /internal/v1/observed,
 * and the public GET routes then surface them. This proves the full
 * probe → collector → publisher → api → read path with no mocking.
 *
 * SLOW: each test spawns 2 processes and waits on socket I/O + timers. These
 * are EXCLUDED from the blocking `npm test` gate (see vitest.config.ts) and run
 * only via `npm run test:e2e`.
 *
 * Process model mirrors the C5 smoke test (agent-server.test.ts): we run the
 * BUILT dist/ entrypoints (self-build in beforeAll if dist is missing), not
 * ts-node/tsx, so the test matches how the binaries actually ship.
 *
 * Envelope shape (verified against src/api/envelope.ts + mutating.test.ts):
 * every response is { request_id, ..., warnings, errors, result } — there is NO
 * top-level `ok` field. Success = HTTP 200 with empty errors[]; an error =
 * non-2xx with errors[0].code (and a sub-code at errors[0].details.code for the
 * executor stubs, e.g. EXECUTOR_UNAVAILABLE / EXECUTOR_UNSUPPORTED).
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');

const CONTROLLER_ID = '00000000-0000-0000-0000-000000000e2e';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;

interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: { code?: string } }>;
    warnings?: unknown[];
  };
}

/** GET over UDS; resolves with the HTTP status + parsed envelope. */
function getJson(socketPath: string, path: string, token: string): Promise<JsonResponse> {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
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
    req.end();
  });
}

/** POST a JSON body over UDS; resolves with the HTTP status + parsed envelope. */
function postJson(
  socketPath: string,
  path: string,
  token: string,
  bodyObj: unknown,
  method = 'POST',
): Promise<JsonResponse> {
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the api UDS answers ANY GET (a 404 still means the server is up). */
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

/**
 * Poll a GET route until it returns HTTP 200 (observation present). A 404 with
 * errors[0].code === 'NOT_FOUND' means "not yet observed" → keep waiting.
 */
async function waitForObservation(
  socketPath: string,
  token: string,
  path: string,
  timeoutMs = 12_000,
): Promise<JsonResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, path, token);
    last = res;
    if (res.status === 200) return res;
    const code = res.body.errors?.[0]?.code;
    if (res.status !== 404 || (code !== undefined && code !== 'NOT_FOUND')) {
      throw new Error(`Unexpected response from ${path}: ${JSON.stringify(res)}`);
    }
    await sleep(200);
  }
  throw new Error(
    `Observation at ${path} never arrived within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

describe.sequential('e2e: agent -> api round-trip (fixture probe mode)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let agentSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  // Self-build dist/ if absent (matches the C5 smoke test). CI runs `npm test`
  // without a prior build; the e2e gate runs the compiled artifact.
  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-'));
    apiSockPath = join(tmpDir, 'api.sock');
    agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');

    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    // Pre-seed the Cluster + Node singletons with fixture values (display_name,
    // hostname, etc.). Since ADR-0016 startServer self-seeds defaults anyway —
    // explicit rows here make the assertions deterministic (create-if-absent
    // leaves them alone; the mirror refresh is a no-op because the fixture
    // already carries mcp.allow_apply=false, matching the mcp-less config).
    // Open the store, seed, close — the api process then reopens the same file.
    const seedStore = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    seedStore.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-cluster' },
      status: {
        mode: 'single_node',
        capabilities: { 'mcp.allow_apply': false },
        member_node_ids: [CONTROLLER_ID],
      },
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

    // Start the api.
    apiProc = spawn(process.execPath, [API_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, XINAS_API_CONFIG: apiConfigPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiProc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
    try {
      await waitForApi(apiSockPath, ADMIN_TOKEN);
    } catch (err) {
      // Surface the api's stderr so a CI startup failure is diagnosable.
      throw new Error(`${(err as Error).message}\n--- api stderr ---\n${apiStderr.join('')}`);
    }

    // Start the agent in fixture probe mode.
    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        XINAS_AGENT_CONFIG_PATH: agentConfigPath,
        XINAS_AGENT_PROBE_MODE: `fixture:${FIXTURE_DIR}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));
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

  it('slow: nfs-idmap singleton round-trips from fixture to GET /api/v1/nfs-idmap', async () => {
    // First observation to arrive — if the agent failed to boot in fixture
    // mode, this is where it surfaces, so append the agent's stderr on timeout.
    let res: JsonResponse;
    try {
      res = await waitForObservation(apiSockPath, ADMIN_TOKEN, '/api/v1/nfs-idmap');
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- agent stderr ---\n${agentStderr.join('')}`);
    }
    const status = (res.body.result as { status?: { domain?: string } }).status;
    expect(status?.domain).toBe('e2e-test.local');
  }, 20_000);

  it('slow: fixture users round-trip to GET /api/v1/users', async () => {
    const res = await waitForObservation(apiSockPath, ADMIN_TOKEN, '/api/v1/users');
    const rows = res.body.result as Array<{ spec?: { name?: string } }>;
    const names = rows.map((u) => u.spec?.name);
    expect(names).toContain('e2e-alice');
    expect(names).toContain('e2e-bob');
  }, 20_000);

  it('slow: fixture disk round-trips to GET /api/v1/disks', async () => {
    const res = await waitForObservation(apiSockPath, ADMIN_TOKEN, '/api/v1/disks');
    const rows = res.body.result as Array<{ id?: string; status?: { model?: string } }>;
    const disk = rows.find((d) => d.status?.model === 'E2E-TEST-NVME');
    expect(disk).toBeDefined();
  }, 20_000);

  it('slow: mutating stub returns EXECUTOR_UNSUPPORTED while the agent is ONLINE', async () => {
    // The agent is up + healthy (fixture mode), so the api's heartbeat tick has
    // recorded a successful agent.health within 2x interval -> tracker state is
    // 'healthy'/'degraded' (NOT offline). The executor is reachable but
    // PUT /shares (full replace) isn't built yet (POST /arrays,
    // /filesystems, /pools, and /config-history/rollback all have real
    // routes as of S9), so the tracker-aware stub returns UNSUPPORTED
    // (422 / EXECUTOR_UNSUPPORTED), not UNAVAILABLE. Guard against the
    // offline gate hollowly always returning UNAVAILABLE.
    // Give one heartbeat tick time to land.
    await sleep(HEARTBEAT_INTERVAL_MS * 3);
    const res = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, { name: 'x' }, 'PUT');
    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.details?.code).toBe('EXECUTOR_UNSUPPORTED');
  }, 20_000);

  it('slow: kill agent -> tracker goes offline -> mutating stub returns EXECUTOR_UNAVAILABLE', async () => {
    // SIGTERM the agent and wait > 6x heartbeat interval so the tracker's
    // probe fails (ENOENT once the socket is gone) and it transitions offline.
    if (agentProc && agentProc.exitCode === null && agentProc.signalCode === null) {
      await new Promise<void>((res) => {
        agentProc?.once('exit', () => res());
        agentProc?.kill('SIGTERM');
      });
    }
    await sleep(HEARTBEAT_INTERVAL_MS * 8 + 500);

    // /api/v1/system reflects offline.
    const sys = await getJson(apiSockPath, '/api/v1/system', ADMIN_TOKEN);
    const agent = (sys.body.result as { node?: { status?: { agent?: { state?: string } } } }).node
      ?.status?.agent;
    expect(agent?.state).toBe('offline');

    // And the mutating stub now reports the executor unavailable.
    const res = await postJson(apiSockPath, '/api/v1/shares', ADMIN_TOKEN, { name: 'x' }, 'PUT');
    expect(res.status).toBe(500);
    expect(res.body.errors?.[0]?.details?.code).toBe('EXECUTOR_UNAVAILABLE');
  }, 20_000);
});
