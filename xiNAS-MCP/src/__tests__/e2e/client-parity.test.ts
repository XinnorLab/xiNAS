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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';

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

  async callTool(
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    const res = await this.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const result = (res.result ?? {}) as { content?: Array<{ text: string }>; isError?: boolean };
    return {
      isError: result.isError ?? false,
      payload: JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>,
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
    await sleep(1500); // sweeps land (the share plan needs the mounted fs)

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

  it('EXIT CRITERION over stdio: MCP apply → MCP_APPLY_DISABLED; REST applies the same plan', async () => {
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

    // The SAME plan applies via REST (202) — only the MCP transport is gated.
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
