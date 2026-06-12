import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';

/**
 * S8 T8 (ADR-0010): the WS12 exit criterion over the wire — gate
 * matrix, RBAC parity REST-vs-MCP, exactly one audit row per call.
 */

interface RpcOut {
  status: number;
  body: Record<string, unknown>;
  session?: string;
}

function rpc(
  port: number,
  message: unknown,
  opts: { session?: string; token?: string } = {},
): Promise<RpcOut> {
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(opts.session !== undefined ? { 'mcp-session-id': opts.session } : {}),
          ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const session = res.headers['mcp-session-id'];
          resolve({
            status: res.statusCode ?? 0,
            body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
            ...(typeof session === 'string' ? { session } : {}),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'parity-test', version: '0' },
  },
};

let seq = 10;
async function callTool(
  port: number,
  session: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  seq += 1;
  const res = await rpc(
    port,
    { jsonrpc: '2.0', id: seq, method: 'tools/call', params: { name, arguments: args } },
    { session },
  );
  const result = (res.body.result ?? {}) as {
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  return {
    isError: result.isError ?? false,
    payload: JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

function bootConfig(dir: string, allowApply: boolean): string {
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      controller_id: '00000000-0000-0000-0000-000000000888',
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      tokens: {
        'tok-admin': { principal: 'admin:test', role: 'admin' },
        'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
      },
      state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
      ...(allowApply ? { mcp: { allow_apply: true } } : {}),
    }),
  );
  return configPath;
}

describe('MCP integration: default posture (S8 T8)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let adminSession: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-int-'));
    handle = await startServer({ configPath: bootConfig(dir, false) });
    port = (handle.address as AddressInfo).port;
    const init = await rpc(port, INITIALIZE, { token: 'tok-admin' });
    adminSession = init.session as string;
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('EXIT CRITERION: apply via MCP is blocked by default; plan passes the gate', async () => {
    const apply = await callTool(port, adminSession, 'shares.create', {
      mode: 'apply',
      plan_id: 'p-1',
    });
    expect(apply.isError).toBe(true);
    expect(JSON.stringify(apply.payload)).toContain('MCP_APPLY_DISABLED');

    const plan = await callTool(port, adminSession, 'shares.create', {
      mode: 'plan',
      spec: {},
    });
    // passes the GATE — whatever the handler says, it is not the gate error
    expect(JSON.stringify(plan.payload)).not.toContain('MCP_APPLY_DISABLED');
  });

  it('direct exemptions pass the gate (support.bundle, tasks.cancel)', async () => {
    const bundle = await callTool(port, adminSession, 'support.bundle', {});
    expect(JSON.stringify(bundle.payload)).not.toContain('MCP_APPLY_DISABLED');
    const cancel = await callTool(port, adminSession, 'tasks.cancel', { id: 't-1' });
    expect(JSON.stringify(cancel.payload)).not.toContain('MCP_APPLY_DISABLED');
  });

  it('RBAC parity: a viewer session reads but cannot plan mutations', async () => {
    const init = await rpc(port, INITIALIZE, { token: 'tok-viewer' });
    const viewerSession = init.session as string;

    const list = await callTool(port, viewerSession, 'arrays.list', {});
    expect(list.isError).toBe(false);

    const plan = await callTool(port, viewerSession, 'shares.create', {
      mode: 'plan',
      spec: {},
    });
    expect(plan.isError).toBe(true);
    expect(JSON.stringify(plan.payload)).toContain('PERMISSION_DENIED');
  });

  it('degraded honesty: config_history.snapshots returns the stub WITH its warning', async () => {
    const out = await callTool(port, adminSession, 'config_history.snapshots', {});
    expect(out.isError).toBe(false);
    expect(JSON.stringify(out.payload)).toContain('CONFIG_HISTORY_NOT_INTEGRATED');
  });

  it('legacy names answer with structured replacement pointers', async () => {
    const out = await callTool(port, adminSession, 'raid.list', {});
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.payload)).toContain('arrays.list');
  });

  it('exactly ONE audit row per tool call, carrying the MCP principal', async () => {
    await handle.state.drainer.drainNow();
    const before = auditRows(dir).length;
    await callTool(port, adminSession, 'disks.list', {});
    await handle.state.drainer.drainNow();
    const rows = auditRows(dir);
    const diskRows = rows.filter((r) => r.kind === 'http.GET./disks');
    expect(rows.length - before).toBe(1);
    expect(diskRows.at(-1)?.principal).toBe('admin:test');
    expect(diskRows.at(-1)?.client_type).toBe('mcp');
  });
});

describe('MCP integration: allow_apply=true flips the gate only', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-int2-'));
    handle = await startServer({ configPath: bootConfig(dir, true) });
    port = (handle.address as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('apply passes the gate (and fails later in the handler, not the gate)', async () => {
    const init = await rpc(port, INITIALIZE, { token: 'tok-admin' });
    const session = init.session as string;
    const apply = await callTool(port, session, 'shares.create', {
      mode: 'apply',
      plan_id: 'no-such-plan',
    });
    expect(JSON.stringify(apply.payload)).not.toContain('MCP_APPLY_DISABLED');
  });
});

interface AuditRow {
  kind?: string;
  principal?: string;
  client_type?: string;
}

function auditRows(dir: string): AuditRow[] {
  try {
    return readFileSync(join(dir, 'a.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRow);
  } catch {
    return [];
  }
}
