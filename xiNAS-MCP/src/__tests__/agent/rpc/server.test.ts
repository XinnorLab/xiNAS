import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDispatcher } from '../../../agent/rpc/dispatch.js';
import { createAgentRpcServer } from '../../../agent/rpc/server.js';

const dirs: string[] = [];

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xinas-server-test-'));
  dirs.push(dir);
  return join(dir, 'test.sock');
}

// Helper: connect to UDS, send one JSON-RPC request line, read one response line.
function roundtrip(socketPath: string, request: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });
    let buf = '';
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('roundtrip timeout')), 3000);
  });
}

describe('createAgentRpcServer', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('listens on a UDS path, accepts a client, dispatches a request and returns the response', async () => {
    const sockPath = tempSocketPath();
    const dispatcher = createDispatcher({
      'agent.health': () => ({
        status: 'starting',
        version: '0.0.0',
        uptime_seconds: 0,
        controller_id: 'test-id',
        in_flight_tasks: 0,
        collectors: {},
      }),
    });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0, // same gid for test (no chown needed)
    });
    servers.push(server);

    expect(existsSync(sockPath)).toBe(true);

    const response = await roundtrip(sockPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'agent.health',
      params: {},
    });
    expect((response as { result?: { status: string } }).result?.status).toBe('starting');
  });

  it('handles an unknown method with -32601 over the real socket', async () => {
    const sockPath = tempSocketPath();
    const dispatcher = createDispatcher({ 'agent.health': () => ({ ok: true }) });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,
    });
    servers.push(server);

    const response = await roundtrip(sockPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'no.such.method',
      params: {},
    });
    expect((response as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it('caps the per-connection read buffer and stays up for the next client', async () => {
    const sockPath = tempSocketPath();
    const dispatcher = createDispatcher({
      'agent.health': () => ({
        status: 'starting',
        version: '0.0.0',
        uptime_seconds: 0,
        controller_id: 'test-id',
        in_flight_tasks: 0,
        collectors: {},
      }),
    });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,
    });
    servers.push(server);

    // Send ~2 MB with NO newline; the server must cap the buffer (1 MB) and
    // close the connection rather than buffering unbounded.
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(sockPath, () => {
        client.write('x'.repeat(2 * 1024 * 1024));
      });
      client.on('close', () => resolve());
      client.on('error', () => resolve()); // ECONNRESET on destroy is fine
      setTimeout(() => reject(new Error('flood connection did not close')), 3000);
    });

    // The process/server must still be alive: a fresh connection gets a
    // normal agent.health response.
    const response = await roundtrip(sockPath, {
      jsonrpc: '2.0',
      id: 99,
      method: 'agent.health',
      params: {},
    });
    expect((response as { result?: { status: string } }).result?.status).toBe('starting');
  });

  it('handles multiple sequential requests on the same connection', async () => {
    const sockPath = tempSocketPath();
    let callCount = 0;
    const dispatcher = createDispatcher({
      'agent.health': () => {
        callCount++;
        return { count: callCount };
      },
    });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,
    });
    servers.push(server);

    // Send two requests on the same connection.
    const responses = await new Promise<object[]>((resolve, reject) => {
      const client = createConnection(sockPath, () => {
        client.write(
          JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'agent.health', params: {} }) + '\n',
        );
        client.write(
          JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'agent.health', params: {} }) + '\n',
        );
      });
      const results: object[] = [];
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          results.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          if (results.length === 2) {
            client.destroy();
            resolve(results);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('multi-request timeout')), 3000);
    });

    expect(responses).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});
