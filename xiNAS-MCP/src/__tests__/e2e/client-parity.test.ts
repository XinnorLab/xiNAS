// @vitest-environment node
/**
 * End-to-end (S8 T16): the WS12 parity criterion — the SAME operation
 * through REST, MCP (via the real xinas-mcp-stdio adapter), and
 * xinasctl produces the SAME plan, and MCP cannot apply by default.
 *
 *   1. plan parity — one share spec planned three ways → identical
 *      plan_hash; audit rows carry the same principal with
 *      client_type rest/mcp/rest.
 *   2. exit criterion over stdio — tools/call shares.create
 *      mode=apply → MCP_APPLY_DISABLED; the same plan applies fine
 *      via REST (202).
 *   3. adapter smoke — initialize + tools/list over stdin/stdout.
 */

import { type ChildProcess, execFile, execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACK_DATA_LOSS } from '../../api/mcp/confirmation/types.js';
import { openStateStore } from '../../state/index.js';
import { collectionNotEmpty, waitForAgentReady, waitForObservation } from './_helpers.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const CTL_ENTRY = join(PROJECT_ROOT, 'dist/cli/xinasctl.js');
const STDIO_ENTRY = join(PROJECT_ROOT, 'dist/mcp-stdio.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000e9f5';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';

// The same OPERATION needs the same id: POST /shares assigns a fresh
// UUID when spec.id is absent, which would (correctly) change the
// plan_hash per call.
const SHARE_SPEC = {
  id: 'parity-share',
  path: '/mnt/data',
  fsid: 7,
  clients: [{ pattern: '*', options: ['rw'] }],
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function restJson(
  socketPath: string,
  method: string,
  path: string,
  token: string,
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
          authorization: `Bearer ${token}`,
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

/**
 * POST .../approve over the UDS socket with NO Authorization header — the
 * one client shape that can reach `middleware/auth.ts`'s `local:uds`
 * peer-trust branch (S15 §9.2 break-glass). Used only to prove that path
 * is refused under the default `allow_uds_approval: false`; the real
 * approval in scenario 8 goes through a distinct admin's BEARER token
 * instead (the production path), which never touches this branch even
 * when presented over the same UDS socket.
 */
function udsApproveNoAuth(
  socketPath: string,
  confirmationId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify({});
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path: `/api/v1/mcp/confirmations/${confirmationId}/approve`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveP({
            status: res.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * A minimal stub `xinas-nfs-helper` (the spec-nfs-helper UDS protocol: one
 * newline-terminated JSON request → one JSON-line response per connection).
 * `share.create`/`share.update`'s agent-side executor (nfs-executor.ts)
 * talks to a real helper over this protocol — this e2e suite has no real
 * privileged helper installed, so it stands one up itself and points the
 * agent's `nfs_helper_socket` config at it. Adapted from the reference
 * stub in nfs-roundtrip.test.ts (S3 N6), trimmed to the ops this file's
 * scenarios actually exercise.
 */
interface StubExportEntry {
  path: string;
  clients: Array<{ host: string; options: string[] }>;
}

interface StubNfsHelper {
  exports: Map<string, StubExportEntry>;
  close(): Promise<void>;
}

function startStubNfsHelper(socketPath: string): Promise<StubNfsHelper> {
  const stub: StubNfsHelper = { exports: new Map(), close: () => Promise.resolve() };

  function dispatch(req: Record<string, unknown>): Record<string, unknown> {
    const op = String(req.op ?? '');
    switch (op) {
      case 'list_exports':
        return { ok: true, result: [...stub.exports.values()] };
      case 'add_export': {
        const entry = req.entry as StubExportEntry;
        stub.exports.set(entry.path, entry);
        return { ok: true, result: null };
      }
      case 'remove_export': {
        const path = String(req.path ?? '');
        if (!stub.exports.has(path))
          return { ok: false, code: 'NOT_FOUND', error: 'no such export' };
        stub.exports.delete(path);
        return { ok: true, result: null };
      }
      case 'update_export': {
        const path = String(req.path ?? '');
        const current = stub.exports.get(path);
        if (current === undefined) {
          return { ok: false, code: 'NOT_FOUND', error: 'no such export' };
        }
        const patch = (req.patch ?? {}) as Partial<StubExportEntry>;
        stub.exports.set(path, { ...current, ...patch });
        return { ok: true, result: null };
      }
      case 'set_idmapd_domain':
        return { ok: true, result: null };
      case 'render_nfs_profile':
        return {
          ok: true,
          result: { effective_files: {}, restarted: Boolean(req.restart), reloaded: !req.restart },
        };
      default:
        return { ok: false, code: 'UNSUPPORTED', error: `unknown op '${op}'` };
    }
  }

  const server = net.createServer((conn) => {
    let buf = '';
    let answered = false;
    conn.on('data', (chunk) => {
      if (answered) return;
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      answered = true;
      let resp: Record<string, unknown>;
      try {
        resp = dispatch(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch (e) {
        resp = { ok: false, code: 'INVALID_ARGUMENT', error: `bad request JSON: ${e}` };
      }
      conn.end(`${JSON.stringify(resp)}\n`);
    });
    conn.on('error', () => {
      /* client hangup after destroy() — ignore */
    });
  });
  stub.close = () => new Promise<void>((res) => server.close(() => res()));
  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolveP(stub));
  });
}

/** Drive the REAL stdio adapter: write JSON-RPC lines, collect replies by id. */
class StdioMcp {
  private proc: ChildProcess;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor(socketPath: string, token: string) {
    this.proc = spawn(process.execPath, [STDIO_ENTRY], {
      env: { ...process.env, XINAS_API_SOCKET: socketPath, XINAS_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: this.proc.stdout as NodeJS.ReadableStream });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') {
          this.pending.get(msg.id)?.(msg as Record<string, unknown>);
          this.pending.delete(msg.id);
        }
      } catch {
        /* ignore non-JSON noise */
      }
    });
  }

  send(message: { id: number; [k: string]: unknown }): Promise<Record<string, unknown>> {
    return new Promise((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error(`rpc ${message.id} timed out`)), 15_000);
      this.pending.set(message.id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  }

  /**
   * `opts.modern: true` adds the S15 `_meta` envelope (protocolVersion
   * 2026-07-28 + declared elicitation capabilities), and `requestState` /
   * `inputResponses` are passed through unchanged — this is what makes the
   * SAME adapter usable as either a legacy (S8) or a modern (S15 MRTR)
   * client. Omitting `opts` entirely preserves the original legacy-only
   * call shape byte for byte (backward compatible with every existing
   * caller in this file).
   */
  async callTool(
    id: number,
    name: string,
    args: Record<string, unknown>,
    opts: {
      modern?: boolean;
      caps?: Record<string, object>;
      requestState?: string | undefined;
      inputResponses?: Record<string, unknown>;
    } = {},
  ): Promise<{
    isError: boolean;
    payload: Record<string, unknown>;
    resultType?: string | undefined;
    requestState?: string | undefined;
    inputRequests?: Record<string, { method: string; params: Record<string, unknown> }> | undefined;
  }> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (opts.modern === true) {
      params._meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'parity', version: '0' },
        'io.modelcontextprotocol/clientCapabilities': { elicitation: opts.caps ?? { form: {} } },
      };
    }
    if (opts.requestState !== undefined) params.requestState = opts.requestState;
    if (opts.inputResponses !== undefined) params.inputResponses = opts.inputResponses;
    const res = await this.send({ jsonrpc: '2.0', id, method: 'tools/call', params });
    const result = (res.result ?? {}) as {
      content?: Array<{ text: string }>;
      isError?: boolean;
      resultType?: string;
      requestState?: string;
      inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
    };
    return {
      isError: result.isError ?? false,
      payload: JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>,
      resultType: result.resultType,
      requestState: result.requestState,
      inputRequests: result.inputRequests,
    };
  }

  kill(): void {
    this.proc.kill('SIGKILL');
  }
}

describe.sequential('e2e: S8 client parity (REST / MCP-stdio / xinasctl)', () => {
  let tmpDir: string;
  let apiSockPath: string;
  let auditPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  let mcp: StdioMcp | undefined;
  const apiStderr: string[] = [];

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(CTL_ENTRY) || !existsSync(STDIO_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-parity-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    auditPath = join(tmpDir, 'audit.jsonl');
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
    apiProc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const r = await restJson(apiSockPath, 'GET', '/api/v1/arrays', ADMIN_TOKEN);
        if (r.status === 200) break;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) throw new Error(`api never ready\n${apiStderr.join('')}`);
      await sleep(100);
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        XINAS_AGENT_CONFIG_PATH: join(tmpDir, 'agent-config.json'),
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The share plan needs the mounted fs, so wait for that observation to
    // land — and for the agent to be dispatchable — instead of guessing.
    await waitForAgentReady(apiSockPath, ADMIN_TOKEN);
    await waitForObservation(apiSockPath, ADMIN_TOKEN, '/api/v1/filesystems', {
      ready: collectionNotEmpty,
    });

    mcp = new StdioMcp(apiSockPath, ADMIN_TOKEN);
    await mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'parity', version: '0' },
      },
    });
  }, 120_000);

  afterAll(async () => {
    mcp?.kill();
    agentProc?.kill('SIGKILL');
    apiProc?.kill('SIGKILL');
    await sleep(100);
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adapter smoke: tools/list over stdio', async () => {
    const res = await (mcp as StdioMcp).send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const tools = ((res.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(tools).toContain('shares.create');
    expect(tools).toContain('health.check');
  });

  it(
    'PARITY: the same share spec plans to the same plan_hash via REST, MCP, and xinasctl',
    { timeout: 30_000 },
    async () => {
      // plan_hash pins observed revisions — wait until the boot sweeps
      // settle (two consecutive REST plans agree) before the parity trio.
      const planOnce = async (): Promise<string> => {
        const r = await restJson(apiSockPath, 'POST', '/api/v1/shares', ADMIN_TOKEN, {
          mode: 'plan',
          spec: SHARE_SPEC,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return (r.body.result as { plan_hash: string }).plan_hash;
      };
      let prev = await planOnce();
      const settleDeadline = Date.now() + 15_000;
      for (;;) {
        await sleep(700);
        const next = await planOnce();
        if (next === prev) break;
        prev = next;
        if (Date.now() > settleDeadline) throw new Error('observed state never settled');
      }

      // REST
      const rest = await restJson(apiSockPath, 'POST', '/api/v1/shares', ADMIN_TOKEN, {
        mode: 'plan',
        spec: SHARE_SPEC,
      });
      expect(rest.status, JSON.stringify(rest.body)).toBe(200);
      const restHash = (rest.body.result as { plan_hash?: string }).plan_hash;
      expect(restHash).toBeTruthy();

      // MCP via the stdio adapter
      const tool = await (mcp as StdioMcp).callTool(3, 'shares.create', {
        mode: 'plan',
        spec: SHARE_SPEC,
      });
      expect(tool.isError, JSON.stringify(tool.payload)).toBe(false);
      const mcpHash = (tool.payload.result as { plan_hash?: string }).plan_hash;

      // xinasctl
      const cli = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolveP) => {
          execFile(
            process.execPath,
            [
              CTL_ENTRY,
              'shares',
              'create',
              '--plan',
              '--spec',
              JSON.stringify(SHARE_SPEC),
              '--json',
              '--socket',
              apiSockPath,
              '--token',
              ADMIN_TOKEN,
            ],
            { timeout: 30_000 },
            (err, stdout, stderr) => {
              resolveP({
                code: err === null ? 0 : ((err as { code?: number }).code ?? 1),
                stdout: String(stdout),
                stderr: String(stderr),
              });
            },
          );
        },
      );
      expect(cli.code, cli.stderr).toBe(0);
      const cliHash = (JSON.parse(cli.stdout) as { result: { plan_hash?: string } }).result
        .plan_hash;

      expect(mcpHash).toBe(restHash);
      expect(cliHash).toBe(restHash);
    },
  );

  it('EXIT CRITERION over stdio: MCP apply → MCP_APPLY_DISABLED; the same UNSCOPED token applies the same plan over REST (A1: this is the surface: any default, not a guarantee)', async () => {
    const plan = await (mcp as StdioMcp).callTool(4, 'shares.create', {
      mode: 'plan',
      spec: SHARE_SPEC,
    });
    const planId = (plan.payload.result as { plan_id: string }).plan_id;

    const mcpApply = await (mcp as StdioMcp).callTool(5, 'shares.create', {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'parity-apply-1',
      expected_revision:
        (plan.payload.result as { state_revision_expected?: number }).state_revision_expected ?? 0,
    });
    expect(mcpApply.isError).toBe(true);
    expect(JSON.stringify(mcpApply.payload)).toContain('MCP_APPLY_DISABLED');

    // The SAME plan applies via REST (202) with the SAME bearer — because
    // that bearer carries no `surface` key and therefore defaults to
    // `any` (S15 §3.5 / A1). This is the honest default, not a security
    // property: scoping the token `surface: mcp` is what stops it (see
    // scenario 10 in the MRTR block below).
    const restApply = await restJson(apiSockPath, 'POST', '/api/v1/shares', ADMIN_TOKEN, {
      mode: 'apply',
      plan_id: planId,
      idempotency_key: 'parity-apply-1',
      expected_revision:
        (plan.payload.result as { state_revision_expected?: number }).state_revision_expected ?? 0,
    });
    expect(restApply.status, JSON.stringify(restApply.body)).toBe(202);
  });

  it('audit parity: same principal, client_type rest vs mcp', async () => {
    await sleep(600); // let the drainer flush
    const rows = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string; principal?: string; client_type?: string });
    const sharePlans = rows.filter((r) => r.kind === 'http.POST./shares');
    const types = new Set(sharePlans.map((r) => r.client_type));
    expect(types.has('rest')).toBe(true);
    expect(types.has('mcp')).toBe(true);
    for (const row of sharePlans) {
      expect(row.principal).toBe('admin:e2e');
    }
    // and no /mcp transport frames were audited
    expect(rows.some((r) => (r.kind ?? '').includes('/mcp'))).toBe(false);
  });
});

/**
 * S8 §7 scenarios 7-9 (S15) — the SAME confirmation-parity claim as the
 * describe block above, now with `mcp.allow_apply: true` and a
 * confirmation config wired in. This needs its OWN api + agent + stdio
 * stack: the block above deliberately runs with `mcp.allow_apply` unset
 * to prove the T15 exit criterion (MCP_APPLY_DISABLED by default), and
 * flipping that flag on the SAME server would break that assertion.
 *
 *   7. confirmation parity — REST and xinasctl apply a share update
 *      directly (no MCP gate applies to them); a modern MCP client gets
 *      `input_required` (form) first; all three planned copies of the
 *      identical spec share one `plan_hash`.
 *   8. destructive parity — `filesystems.create` force:true via MCP
 *      elicits a url naming the confirmation id; approving it over the
 *      bare UDS socket (no bearer — the peer-trust/break-glass branch) is
 *      refused under the default `allow_uds_approval: false`; a DISTINCT
 *      admin's bearer token (via xinasctl, the production path) approves
 *      it; the retry creates the task; a second flow proves `dangerous:
 *      true` was required even for an approved confirmation.
 *   9. legacy denial — a client with no `_meta` envelope gets
 *      `MCP_CONFIRMATION_UNSUPPORTED` on apply; its reads, plan,
 *      `support.bundle`, and `tasks.cancel` are unaffected.
 *  10. token surface (A1, S15 §3.5) — an agent bearer configured
 *      `surface: mcp` is refused on `/api/v1` (`PERMISSION_DENIED`,
 *      `details.reason: token_surface`) so the confirmation gate cannot be
 *      bypassed over REST, while the same token's MCP form flow still
 *      completes.
 */
describe.sequential('e2e: S8 §7 MCP confirmation parity (S15 scenarios 7-9)', () => {
  const MRTR_CONTROLLER_ID = '00000000-0000-0000-0000-00000000c17f';
  const MRTR_ADMIN_TOKEN = 'e2e-mrtr-admin-tok';
  const MRTR_ADMIN2_TOKEN = 'e2e-mrtr-admin2-tok';
  const MRTR_AGENT_TOKEN = 'e2e-mrtr-agent-tok';
  /** A1 (S15 §3.5): an agent bearer scoped to the MCP endpoint only. */
  const MRTR_MCP_SCOPED_TOKEN = 'e2e-mrtr-mcp-scoped-tok';
  const APPROVAL_URL_BASE = 'http://127.0.0.1:1';
  const BOTH_CAPS = { form: {}, url: {} };

  interface ToolPayload {
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  }

  let tmpDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  let mrtrMcp: StdioMcp | undefined;
  let nfsHelper: StubNfsHelper | undefined;
  const apiStderr: string[] = [];
  let rpcSeq = 100;
  const nextMrtrId = (): number => {
    rpcSeq += 1;
    return rpcSeq;
  };

  const TERMINAL_TASK_STATES = ['success', 'failed', 'cancelled', 'requires_manual_recovery'];

  /** Poll `/api/v1/tasks/{id}` to a terminal state; returns the final task body. */
  async function waitForTaskTerminal(
    taskId: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};
    for (;;) {
      const t = await restJson(apiSockPath, 'GET', `/api/v1/tasks/${taskId}`, MRTR_ADMIN_TOKEN);
      last = t.body.result as Record<string, unknown>;
      if (TERMINAL_TASK_STATES.includes(last.state as string)) return last;
      if (Date.now() > deadline) {
        throw new Error(
          `task ${taskId} never terminal in ${timeoutMs}ms; last=${JSON.stringify(last)}`,
        );
      }
      await sleep(200);
    }
  }

  function ctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveP) => {
      execFile(
        process.execPath,
        [CTL_ENTRY, ...args, '--socket', apiSockPath],
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
  }

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(CTL_ENTRY) || !existsSync(STDIO_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-mrtr-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });

    writeFileSync(join(tmpDir, 'controller-id'), `${MRTR_CONTROLLER_ID}\n`);
    writeFileSync(join(tmpDir, 'agent-token'), `${MRTR_AGENT_TOKEN}\n`);
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify({ blockdevices: [] }));
    // Two observed XiraidArrays (→ /dev/xi_confirma, /dev/xi_confirmb) so
    // scenario 8 can force-create against a real array volume without
    // colliding with the OTHER destructive flow in the same test file
    // (each apply's task holds its lease forever — the mock/fixture agent
    // never posts a terminal task_progress event).
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({
        arrays: [
          {
            // Backs /mnt/data's Filesystem fixture below — share.create's
            // apply-time preflight (EXPORT_PATH_NOT_ON_XIRAID) requires the
            // export path's backing device to be an OBSERVED XiraidArray
            // volume, not merely a plan-time-plausible one.
            name: 'data',
            level: '5',
            devices: ['/dev/nvme9n1', '/dev/nvme10n1'],
            state: 'online',
            strip_size: 128,
          },
          {
            name: 'confirma',
            level: '5',
            devices: ['/dev/nvme11n1', '/dev/nvme12n1', '/dev/nvme13n1', '/dev/nvme14n1'],
            state: 'online',
            strip_size: 128,
          },
          {
            name: 'confirmb',
            level: '5',
            devices: ['/dev/nvme15n1', '/dev/nvme16n1', '/dev/nvme17n1', '/dev/nvme18n1'],
            state: 'online',
            strip_size: 128,
          },
        ],
        pools: [],
        import_candidates: [],
        tombstones: [],
      }),
    );
    // One mounted filesystem so scenario 7's share create/update has a
    // valid path to export.
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

    // `share.create`'s AGENT-side preflight (nfs-executor.ts) re-checks the
    // export path against a LIVE mount table, independent of the api-side
    // Filesystem fixture above: in fixture mode that table is
    // `<dir>/mounts.json` (task/wiring.ts's `makeFixtureMounts`), a
    // SEPARATE mechanism from the FsHost `filesystems.create` uses — both
    // must agree with the Filesystem fixture or the apply fails
    // EXPORT_PATH_NOT_ON_XIRAID (nfs-executor.ts) even though the plan
    // itself already succeeded.
    writeFileSync(
      join(fixtureDir, 'mounts.json'),
      JSON.stringify([{ source: '/dev/xi_data', mountpoint: '/mnt/data' }]),
    );

    // The agent's task executor shells out to `python3 -m xinas_history` for
    // the pre/post-apply config-history snapshot (src/agent/task/
    // xinas-history-bridge.ts). This sandbox's python3 has no xinas_history
    // installed, which fails the snapshot and, in turn, the whole apply
    // (FAILED_BEFORE_CHANGE) before the desired mutation is ever written —
    // exactly the failure filesystem-adapter.test.ts's shim avoids. Stub it
    // out the same way.
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
      nodeId: MRTR_CONTROLLER_ID,
    });
    seedStore.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-mrtr' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [MRTR_CONTROLLER_ID] },
    });
    await seedStore.close();

    writeFileSync(
      join(tmpDir, 'api-config.json'),
      JSON.stringify({
        controller_id: MRTR_CONTROLLER_ID,
        listen: { kind: 'unix', socket: apiSockPath },
        tokens: {
          [MRTR_ADMIN_TOKEN]: { principal: 'admin:mrtr1', role: 'admin' },
          [MRTR_ADMIN2_TOKEN]: { principal: 'admin:mrtr2', role: 'admin' },
          [MRTR_AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
          [MRTR_MCP_SCOPED_TOKEN]: {
            principal: 'admin:mrtr-mcp',
            role: 'admin',
            surface: 'mcp',
          },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: 300 },
        // support.bundle defaults to /var/log/xinas/bundles, unwritable in
        // this sandbox; redirect it into the test's own tmp dir.
        support_bundle_dir: join(tmpDir, 'bundles'),
        mcp: {
          allow_apply: true,
          confirmation: {
            approval_url_base: APPROVAL_URL_BASE,
            url_wait_seconds: 1,
          },
        },
      }),
    );
    const nfsHelperSockPath = join(tmpDir, 'nfs-helper.sock');
    nfsHelper = await startStubNfsHelper(nfsHelperSockPath);
    writeFileSync(
      join(tmpDir, 'agent-config.json'),
      JSON.stringify({
        api_socket: apiSockPath,
        agent_socket: agentSockPath,
        controller_id_path: join(tmpDir, 'controller-id'),
        agent_token_path: join(tmpDir, 'agent-token'),
        socket_group: 'nogroup',
        // share.create/share.update's agent-side executor talks to a real
        // xinas-nfs-helper over this socket; point it at the in-test stub
        // above rather than the (unavailable, privileged) production path.
        nfs_helper_socket: nfsHelperSockPath,
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
        const r = await restJson(apiSockPath, 'GET', '/api/v1/arrays', MRTR_ADMIN_TOKEN);
        if (r.status === 200) break;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) throw new Error(`api never ready\n${apiStderr.join('')}`);
      await sleep(100);
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: join(tmpDir, 'agent-config.json'),
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForAgentReady(apiSockPath, MRTR_ADMIN_TOKEN);
    await waitForObservation(apiSockPath, MRTR_ADMIN_TOKEN, '/api/v1/filesystems', {
      ready: collectionNotEmpty,
    });
    await waitForObservation(apiSockPath, MRTR_ADMIN_TOKEN, '/api/v1/arrays', {
      ready: collectionNotEmpty,
    });

    mrtrMcp = new StdioMcp(apiSockPath, MRTR_ADMIN_TOKEN);
    await mrtrMcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mrtr-parity', version: '0' },
      },
    });
  }, 120_000);

  afterAll(async () => {
    mrtrMcp?.kill();
    agentProc?.kill('SIGKILL');
    apiProc?.kill('SIGKILL');
    await nfsHelper?.close();
    await sleep(100);
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    '7. confirmation parity: REST and xinasctl apply directly; modern MCP needs the form first; same plan_hash',
    { timeout: 30_000 },
    async () => {
      // Setup (not part of the parity claim): create the share directly over REST.
      const created = await restJson(apiSockPath, 'POST', '/api/v1/shares', MRTR_ADMIN_TOKEN, {
        mode: 'plan',
        spec: {
          id: 'confirm-share',
          path: '/mnt/data',
          fsid: 11,
          clients: [{ pattern: '*', options: ['rw'] }],
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const createPlan = created.body.result as {
        plan_id: string;
        state_revision_expected: number;
      };
      const createApply = await restJson(apiSockPath, 'POST', '/api/v1/shares', MRTR_ADMIN_TOKEN, {
        mode: 'apply',
        plan_id: createPlan.plan_id,
        expected_revision: createPlan.state_revision_expected,
        idempotency_key: 'mrtr-setup-create',
      });
      expect(createApply.status, JSON.stringify(createApply.body)).toBe(202);
      // Wait for the setup create to actually land: the desired mutation and
      // the task are not durable until the task clears its pre-change
      // snapshot stage, so later steps must not race ahead of it.
      const createTask = await waitForTaskTerminal(
        (createApply.body.result as { task_id: string }).task_id,
      );
      expect(createTask.state, JSON.stringify(createTask)).toBe('success');

      const updateSpec = { clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }] };

      // Three-way plan parity (same claim as the PARITY test above), now
      // with mcp.allow_apply: true — planning is never gated either way.
      const restPlan = await restJson(
        apiSockPath,
        'PATCH',
        '/api/v1/shares/confirm-share',
        MRTR_ADMIN_TOKEN,
        { mode: 'plan', spec: updateSpec },
      );
      expect(restPlan.status, JSON.stringify(restPlan.body)).toBe(200);
      const restPlanResult = restPlan.body.result as {
        plan_id: string;
        plan_hash: string;
        state_revision_expected: number;
      };

      const mcpPlan = await (mrtrMcp as StdioMcp).callTool(nextMrtrId(), 'shares.update', {
        id: 'confirm-share',
        mode: 'plan',
        spec: updateSpec,
      });
      const mcpPlanPayload = mcpPlan.payload as ToolPayload;
      const mcpPlanResult = mcpPlanPayload.result as { plan_hash: string };

      const cliPlan = await ctl([
        'shares',
        'update',
        'confirm-share',
        '--plan',
        '--spec',
        JSON.stringify(updateSpec),
        '--json',
        '--token',
        MRTR_ADMIN_TOKEN,
      ]);
      expect(cliPlan.code, cliPlan.stderr).toBe(0);
      const cliPlanResult = (JSON.parse(cliPlan.stdout) as { result: { plan_hash: string } })
        .result;

      expect(mcpPlanResult.plan_hash).toBe(restPlanResult.plan_hash);
      expect(cliPlanResult.plan_hash).toBe(restPlanResult.plan_hash);

      // REST applies its own plan directly — client_type 'rest' never hits
      // the MCP confirmation gate.
      const restApply = await restJson(
        apiSockPath,
        'PATCH',
        '/api/v1/shares/confirm-share',
        MRTR_ADMIN_TOKEN,
        {
          mode: 'apply',
          plan_id: restPlanResult.plan_id,
          expected_revision: restPlanResult.state_revision_expected,
          idempotency_key: 'mrtr-rest-apply',
        },
      );
      expect(restApply.status, JSON.stringify(restApply.body)).toBe(202);
      const restApplyTask = await waitForTaskTerminal(
        (restApply.body.result as { task_id: string }).task_id,
      );
      expect(restApplyTask.state, JSON.stringify(restApplyTask)).toBe('success');

      // xinasctl applies directly too (client_type stays 'rest' — ADR-0010).
      // Re-plan first: REST's apply above already advanced the share's
      // desired revision, so the CLI's earlier (revision-0) plan is stale.
      const cliPlan2 = await ctl([
        'shares',
        'update',
        'confirm-share',
        '--plan',
        '--spec',
        JSON.stringify(updateSpec),
        '--json',
        '--token',
        MRTR_ADMIN_TOKEN,
      ]);
      const cliPlan2Result = (
        JSON.parse(cliPlan2.stdout) as {
          result: { plan_id: string; state_revision_expected: number };
        }
      ).result;
      const cliApply = await ctl([
        'shares',
        'update',
        'confirm-share',
        '--apply',
        '--plan-id',
        cliPlan2Result.plan_id,
        '--expected-revision',
        String(cliPlan2Result.state_revision_expected),
        '--idempotency-key',
        'mrtr-cli-apply',
        '--json',
        '--token',
        MRTR_ADMIN_TOKEN,
      ]);
      expect(cliApply.code, cliApply.stderr).toBe(0);
      const cliApplyResult = (JSON.parse(cliApply.stdout) as { result: { task_id?: string } })
        .result;
      expect(typeof cliApplyResult.task_id).toBe('string');
      const cliApplyTask = await waitForTaskTerminal(cliApplyResult.task_id as string);
      expect(cliApplyTask.state, JSON.stringify(cliApplyTask)).toBe('success');

      // Modern MCP needs the form first — re-plan again (post CLI apply).
      const mcpPlan2 = await (mrtrMcp as StdioMcp).callTool(nextMrtrId(), 'shares.update', {
        id: 'confirm-share',
        mode: 'plan',
        spec: updateSpec,
      });
      const mcpPlan2Result = (mcpPlan2.payload as ToolPayload).result as {
        plan_id: string;
        state_revision_expected: number;
      };
      const mcpArgs = {
        id: 'confirm-share',
        mode: 'apply',
        plan_id: mcpPlan2Result.plan_id,
        expected_revision: mcpPlan2Result.state_revision_expected,
        idempotency_key: 'mrtr-mcp-apply',
      };
      const first = await (mrtrMcp as StdioMcp).callTool(nextMrtrId(), 'shares.update', mcpArgs, {
        modern: true,
      });
      expect(first.resultType, JSON.stringify(first)).toBe('input_required');
      expect(first.inputRequests?.confirm_apply?.params.mode).toBe('form');

      const accepted = await (mrtrMcp as StdioMcp).callTool(
        nextMrtrId(),
        'shares.update',
        mcpArgs,
        {
          modern: true,
          requestState: first.requestState,
          inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
        },
      );
      expect(accepted.resultType, JSON.stringify(accepted)).toBe('complete');
      expect(accepted.isError).toBe(false);
      const taskId = ((accepted.payload as ToolPayload).result as { task_id?: string })?.task_id;
      expect(typeof taskId).toBe('string');
      const mcpApplyTask = await waitForTaskTerminal(taskId as string);
      expect(mcpApplyTask.state, JSON.stringify(mcpApplyTask)).toBe('success');
    },
  );

  it(
    '8. destructive parity: filesystems.create via MCP returns a URL; a distinct admin approves ' +
      'over xinasctl (bearer, not UDS peer-trust); UDS approval is refused by default; the retry ' +
      'creates the task; dangerous:true was required',
    { timeout: 30_000 },
    async () => {
      // ── Part A: happy path — dangerous:true from the start ──
      const planA = await (mrtrMcp as StdioMcp).callTool(nextMrtrId(), 'filesystems.create', {
        mode: 'plan',
        spec: { backing_device: '/dev/xi_confirma', mountpoint: '/mnt/confirm-a', force: true },
      });
      const planAResult = (planA.payload as ToolPayload).result as {
        plan_id: string;
        state_revision_expected: number;
        risk_level: string;
      };
      expect(planAResult.risk_level).toBe('destructive');

      const argsA = {
        mode: 'apply',
        plan_id: planAResult.plan_id,
        expected_revision: planAResult.state_revision_expected,
        idempotency_key: 'mrtr-fs-a',
        dangerous: true,
      };
      const firstA = await (mrtrMcp as StdioMcp).callTool(
        nextMrtrId(),
        'filesystems.create',
        argsA,
        { modern: true, caps: BOTH_CAPS },
      );
      expect(firstA.resultType, JSON.stringify(firstA)).toBe('input_required');
      expect(firstA.inputRequests?.confirm_apply?.params.mode).toBe('url');
      const urlA = firstA.inputRequests?.confirm_apply?.params.url as string;
      const confirmationIdA = urlA.split('/').pop() as string;
      expect(urlA).toBe(`${APPROVAL_URL_BASE}/mcp/approvals/${confirmationIdA}`);

      // Negative: the bare UDS socket with NO bearer token hits the
      // local:uds peer-trust/break-glass branch, refused by default.
      const udsRefused = await udsApproveNoAuth(apiSockPath, confirmationIdA);
      expect(udsRefused.status).toBe(409);
      expect(
        (udsRefused.body.errors as Array<Record<string, unknown>> | undefined)?.[0]?.details,
      ).toMatchObject({ reason: 'approver_policy' });

      // Positive: a DISTINCT admin's bearer token — the production path —
      // approves via xinasctl. Presenting a bearer header short-circuits
      // the peer-trust check even over this same UDS socket
      // (middleware/auth.ts), so this exercises 'bearer', not
      // 'uds_break_glass'.
      const approve = await ctl([
        'mcp_confirmations',
        'approve',
        confirmationIdA,
        '--acknowledge',
        ACK_DATA_LOSS,
        '--json',
        '--token',
        MRTR_ADMIN2_TOKEN,
      ]);
      expect(approve.code, approve.stderr).toBe(0);
      const approveResult = (JSON.parse(approve.stdout) as { result: Record<string, unknown> })
        .result;
      expect(approveResult.status).toBe('approved');
      expect(approveResult.approval_channel).toBe('bearer');
      expect(approveResult.approved_by).toBe('admin:mrtr2');

      const retriedA = await (mrtrMcp as StdioMcp).callTool(
        nextMrtrId(),
        'filesystems.create',
        argsA,
        {
          modern: true,
          caps: BOTH_CAPS,
          requestState: firstA.requestState,
          inputResponses: { confirm_apply: { action: 'accept' } },
        },
      );
      expect(retriedA.resultType, JSON.stringify(retriedA)).toBe('complete');
      expect(retriedA.isError).toBe(false);
      const taskIdA = ((retriedA.payload as ToolPayload).result as { task_id?: string })?.task_id;
      expect(typeof taskIdA).toBe('string');
      const taskA = await waitForTaskTerminal(taskIdA as string);
      expect(taskA.state, JSON.stringify(taskA)).toBe('success');

      // ── Part B: dangerous:true was required, even for an approved confirmation ──
      const planB = await (mrtrMcp as StdioMcp).callTool(nextMrtrId(), 'filesystems.create', {
        mode: 'plan',
        spec: { backing_device: '/dev/xi_confirmb', mountpoint: '/mnt/confirm-b', force: true },
      });
      const planBResult = (planB.payload as ToolPayload).result as {
        plan_id: string;
        state_revision_expected: number;
        risk_level: string;
      };
      expect(planBResult.risk_level).toBe('destructive');
      const argsB = {
        mode: 'apply',
        plan_id: planBResult.plan_id,
        expected_revision: planBResult.state_revision_expected,
        idempotency_key: 'mrtr-fs-b',
        // no dangerous flag
      };
      const firstB = await (mrtrMcp as StdioMcp).callTool(
        nextMrtrId(),
        'filesystems.create',
        argsB,
        { modern: true, caps: BOTH_CAPS },
      );
      // A2: the refusal now lands BEFORE any elicitation — no URL is
      // handed out, so no operator approval is ever spent on a call the
      // apply transaction would refuse anyway (S15 §3.3 row 8, §3.4).
      expect(firstB.resultType, JSON.stringify(firstB)).toBe('complete');
      const firstBPayload = firstB.payload as ToolPayload;
      expect(firstBPayload.error?.code).toBe('PRECONDITION_FAILED');
      expect(firstBPayload.error?.details?.reason).toBe('dangerous_flag_required');
      expect(firstB.requestState).toBeUndefined();
      expect(firstB.inputRequests).toBeUndefined();

      // …and no mcp_confirmations row exists for that plan.
      const listed = await restJson(
        apiSockPath,
        'GET',
        '/api/v1/mcp/confirmations?limit=1000',
        MRTR_ADMIN2_TOKEN,
      );
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const rowsB = (listed.body.result as Array<{ plan_id?: string }>) ?? [];
      expect(rowsB.some((r) => r.plan_id === planBResult.plan_id)).toBe(false);

      // The SAME plan with dangerous:true still elicits the url flow, so
      // the refusal above is about the flag and nothing else.
      const withFlagB = await (mrtrMcp as StdioMcp).callTool(
        nextMrtrId(),
        'filesystems.create',
        { ...argsB, idempotency_key: 'mrtr-fs-b2', dangerous: true },
        { modern: true, caps: BOTH_CAPS },
      );
      expect(withFlagB.resultType, JSON.stringify(withFlagB)).toBe('input_required');
      expect(withFlagB.inputRequests?.confirm_apply?.params.mode).toBe('url');
    },
  );

  it(
    '9. legacy denial: the legacy session apply gets MCP_CONFIRMATION_UNSUPPORTED; ' +
      'reads/plan/support.bundle/tasks.cancel unchanged',
    { timeout: 30_000 },
    async () => {
      const legacy = new StdioMcp(apiSockPath, MRTR_ADMIN_TOKEN);
      try {
        await legacy.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'legacy', version: '0' },
          },
        });

        // plan — unaffected by the confirmation feature
        const plan = await legacy.callTool(2, 'shares.update', {
          id: 'confirm-share',
          mode: 'plan',
          spec: { clients: [{ pattern: '172.16.0.0/12', options: ['ro'] }] },
        });
        expect(plan.isError, JSON.stringify(plan.payload)).toBe(false);
        const planResult = (plan.payload as ToolPayload).result as {
          plan_id: string;
          state_revision_expected: number;
        };

        // apply — MCP_CONFIRMATION_UNSUPPORTED (no _meta ⇒ legacy client)
        const apply = await legacy.callTool(3, 'shares.update', {
          id: 'confirm-share',
          mode: 'apply',
          plan_id: planResult.plan_id,
          expected_revision: planResult.state_revision_expected,
          idempotency_key: 'mrtr-legacy-apply',
        });
        expect(apply.isError).toBe(true);
        expect(JSON.stringify(apply.payload)).toContain('MCP_CONFIRMATION_UNSUPPORTED');

        // reads — unaffected
        const list = await legacy.callTool(4, 'arrays.list', {});
        expect(list.isError, JSON.stringify(list.payload)).toBe(false);

        // support.bundle — direct entry, never gated by allow_apply or confirmation
        const bundle = await legacy.callTool(5, 'support.bundle', {});
        expect(bundle.isError, JSON.stringify(bundle.payload)).toBe(false);
        const bundleTaskId = ((bundle.payload as ToolPayload).result as { task_id?: string })
          ?.task_id;
        expect(typeof bundleTaskId).toBe('string');

        // tasks.cancel — direct entry, allowed via MCP without allow_apply
        const cancel = await legacy.callTool(6, 'tasks.cancel', { id: bundleTaskId });
        expect(cancel.isError, JSON.stringify(cancel.payload)).toBe(false);
      } finally {
        legacy.kill();
      }
    },
  );

  it(
    "10. token surface (A1, S15 §3.5): the agent's `surface: mcp` bearer is refused on REST " +
      'with PERMISSION_DENIED/token_surface, while its MCP form flow still completes',
    { timeout: 30_000 },
    async () => {
      const scopedMcp = new StdioMcp(apiSockPath, MRTR_MCP_SCOPED_TOKEN);
      try {
        await scopedMcp.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'scoped', version: '0' },
          },
        });

        const spec = { clients: [{ pattern: '192.168.0.0/16', options: ['ro'] }] };
        // The plan is created BY the scoped principal over MCP — a plan
        // belongs to its creator (gate 6, §5.3 item 7).
        const plan = await scopedMcp.callTool(2, 'shares.update', {
          id: 'confirm-share',
          mode: 'plan',
          spec,
        });
        expect(plan.isError, JSON.stringify(plan.payload)).toBe(false);
        const planResult = (plan.payload as ToolPayload).result as {
          plan_id: string;
          state_revision_expected: number;
        };

        // The bypass this closes: the SAME bearer applying over REST.
        const restApply = await restJson(
          apiSockPath,
          'PATCH',
          '/api/v1/shares/confirm-share',
          MRTR_MCP_SCOPED_TOKEN,
          {
            mode: 'apply',
            plan_id: planResult.plan_id,
            expected_revision: planResult.state_revision_expected,
            idempotency_key: 'mrtr-scoped-rest-apply',
          },
        );
        expect(restApply.status, JSON.stringify(restApply.body)).toBe(401);
        const restError = (restApply.body.errors as Array<Record<string, unknown>>)[0];
        expect(restError?.code).toBe('PERMISSION_DENIED');
        expect(restError?.details).toEqual({ reason: 'token_surface', surface: 'mcp' });
        // Nothing was applied: a read with an unscoped admin token still
        // shows the share, and no task was created for that key.
        const tasks = await restJson(
          apiSockPath,
          'GET',
          '/api/v1/tasks?limit=200',
          MRTR_ADMIN_TOKEN,
        );
        const rows = (tasks.body.result as Array<{ idempotency_key?: string }>) ?? [];
        expect(rows.some((t) => t.idempotency_key === 'mrtr-scoped-rest-apply')).toBe(false);

        // The same token's MCP flow is unaffected: form → accept → task.
        const mcpArgs = {
          id: 'confirm-share',
          mode: 'apply',
          plan_id: planResult.plan_id,
          expected_revision: planResult.state_revision_expected,
          idempotency_key: 'mrtr-scoped-mcp-apply',
        };
        const first = await scopedMcp.callTool(3, 'shares.update', mcpArgs, { modern: true });
        expect(first.resultType, JSON.stringify(first)).toBe('input_required');
        expect(first.inputRequests?.confirm_apply?.params.mode).toBe('form');

        const accepted = await scopedMcp.callTool(4, 'shares.update', mcpArgs, {
          modern: true,
          requestState: first.requestState,
          inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
        });
        expect(accepted.resultType, JSON.stringify(accepted)).toBe('complete');
        expect(accepted.isError, JSON.stringify(accepted.payload)).toBe(false);
        const taskId = ((accepted.payload as ToolPayload).result as { task_id?: string })?.task_id;
        expect(typeof taskId).toBe('string');
        const applied = await waitForTaskTerminal(taskId as string);
        expect(applied.state, JSON.stringify(applied)).toBe('success');
      } finally {
        scopedMcp.kill();
      }
    },
  );
});
