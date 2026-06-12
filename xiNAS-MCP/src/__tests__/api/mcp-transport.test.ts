import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';

/**
 * S8 T7: the /mcp transport over a REAL listening server (the loopback
 * needs a live address) + the dedicated MCP TCP listener.
 */
describe('mcp transport (S8 T7)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let mcpPort: number;

  function rpc(
    targetPort: number,
    message: unknown,
    opts: { session?: string; token?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown>; session?: string }> {
    const payload = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: targetPort,
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
      clientInfo: { name: 'test', version: '0' },
    },
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-transport-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-000000000777',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        mcp: { http: { host: '127.0.0.1', port: 0 } },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    mcpPort = (handle.mcpAddress as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('initialize (token) → tools/list → a read tool call end to end', async () => {
    const init = await rpc(port, INITIALIZE, { token: 'tok-admin' });
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    const session = init.session as string;

    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { session },
    );
    const tools = (list.body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('arrays.list');
    expect(tools.map((t) => t.name)).not.toContain('support.download'); // binary excluded

    const call = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'arrays.list', arguments: {} },
      },
      { session },
    );
    const result = call.body.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]?.text as string)).toHaveProperty('result');
  });

  it('TCP without a bearer → 401; unknown bearer → 401', async () => {
    expect((await rpc(port, INITIALIZE)).status).toBe(401);
    expect((await rpc(port, INITIALIZE, { token: 'nope' })).status).toBe(401);
  });

  it('the dedicated MCP listener serves the same app (REST + /mcp)', async () => {
    const init = await rpc(mcpPort, INITIALIZE, { token: 'tok-admin' });
    expect(init.status).toBe(200);

    // and plain REST works over it too
    const rest = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: mcpPort,
          path: '/api/v1/arrays',
          headers: { authorization: 'Bearer tok-admin' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
    });
    expect(rest).toBe(200);
  });
});
