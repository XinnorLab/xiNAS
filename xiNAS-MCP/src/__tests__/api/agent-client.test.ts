import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRpcError, createAgentRpcClient } from '../../api/agent-client.js';

/**
 * Boot a tiny JSON-RPC-over-NDJSON UDS server whose per-method behaviour is
 * supplied by `handler`. A `handler` returning `null` writes NO response (so
 * the client's call times out). Returns the socket path + a stop() that
 * force-destroys lingering server-side connections (a half-open UDS conn the
 * client destroyed keeps `server.close()` from resolving otherwise).
 */
async function startMockSocket(
  dir: string,
  name: string,
  handler: (method: string, params: unknown) => { result: unknown } | { error: unknown } | null,
): Promise<{ socketPath: string; stop(): Promise<void> }> {
  const socketPath = join(dir, name);
  const conns = new Set<Socket>();
  let server: Server | null = createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: { id?: number | string | null; method?: string; params?: unknown };
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          continue;
        }
        const id = req.id ?? null;
        const out = handler(req.method ?? '', req.params);
        if (out !== null) conn.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...out })}\n`);
      }
    });
    conn.on('error', () => conn.destroy());
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
  return {
    socketPath,
    async stop() {
      for (const c of conns) c.destroy();
      if (server) {
        const s = server;
        server = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

describe('createAgentRpcClient', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-agent-client-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the JSON-RPC result on success', async () => {
    const mock = await startMockSocket(dir, 'ok.sock', (method, params) => {
      expect(method).toBe('task.begin');
      expect(params).toMatchObject({ task_id: 't-1' });
      return { result: { accepted: true, agent_acceptance_id: 'acc-1' } };
    });
    const client = createAgentRpcClient(mock.socketPath);
    const res = await client.call('task.begin', { task_id: 't-1' }, 2000);
    expect(res).toEqual({ accepted: true, agent_acceptance_id: 'acc-1' });
    await mock.stop();
  });

  it('rejects with AgentRpcError carrying error data on a JSON-RPC error', async () => {
    const mock = await startMockSocket(dir, 'err.sock', () => ({
      error: { code: -32000, message: 'unsupported', data: { code: 'EXECUTOR_UNSUPPORTED' } },
    }));
    const client = createAgentRpcClient(mock.socketPath);
    let thrown: unknown;
    try {
      await client.call('task.begin', {}, 2000);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentRpcError);
    expect((thrown as AgentRpcError).rpcCode).toBe(-32000);
    expect((thrown as AgentRpcError).data).toMatchObject({ code: 'EXECUTOR_UNSUPPORTED' });
    await mock.stop();
  });

  it('rejects when the socket is absent (connect refused)', async () => {
    const client = createAgentRpcClient(join(dir, 'nonexistent.sock'));
    await expect(client.call('task.begin', {}, 2000)).rejects.toThrow(/ECONNREFUSED|ENOENT/);
  });

  it('rejects on timeout when the agent never answers', async () => {
    // A server that accepts the connection but never writes a response line.
    const mock = await startMockSocket(dir, 'silent.sock', () => null);
    const client = createAgentRpcClient(mock.socketPath);
    await expect(client.call('task.begin', {}, 100)).rejects.toThrow(/timed out/);
    await mock.stop();
  });
});
