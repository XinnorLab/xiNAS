// @vitest-environment node
/**
 * S17 §5.5 (D-19): the stdio adapter demultiplexes `subscriptions/listen`
 * SSE streams onto stdout, one JSON-RPC message per line, without blocking
 * the serial request/response chain, and turns an inbound
 * `notifications/cancelled` for a live listen into the HTTP close that
 * cancels it. Driven in-process (`createBridge`) against a real api on a
 * UNIX socket.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../api/server.js';
import { type Bridge, createBridge } from '../mcp-stdio.js';

const CID = '00000000-0000-0000-0000-000000000919';
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';

interface Line {
  id?: unknown;
  method?: string;
  params?: { _meta?: Record<string, unknown>; uri?: string };
  result?: unknown;
  error?: { code: number; message: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

describe('xinas-mcp-stdio — subscriptions/listen demultiplexing (S17 §5.5)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let socketPath: string;
  let lines: Line[];
  let bridge: Bridge;

  beforeAll(async () => {
    // Short path: macOS caps UNIX socket paths at 104 bytes.
    dir = mkdtempSync('/tmp/xinas-stdio-');
    socketPath = join(dir, 'api.sock');
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: CID,
        listen: { kind: 'unix', socket: socketPath },
        tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        mcp: { subscriptions: { coalesce_ms: 20, keepalive_ms: 1000 } },
      }),
    );
    handle = await startServer({ configPath });
    lines = [];
    bridge = createBridge({
      socketPath,
      token: 'tok-admin',
      out: (line) => lines.push(JSON.parse(line) as Line),
    });
  });

  afterAll(async () => {
    await bridge.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listen = (id: string | number, uris: string[]) =>
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: { _meta: META, notifications: { resourceSubscriptions: uris } },
      }),
    );
  const subId = (l: Line): unknown => l.params?._meta?.[SUB_ID];

  it('acknowledges two concurrent subscriptions with their own ids and does not block an ordinary request', async () => {
    listen('listen:1', ['xinas://events/raid']);
    listen('listen:2', ['xinas://events/nfs']);
    bridge.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: META } }),
    );
    await until(() => lines.length >= 3, 3000, 'two acks + tools/list');
    const acks = lines.filter((l) => l.method === 'notifications/subscriptions/acknowledged');
    expect(acks.map(subId).sort()).toEqual(['listen:1', 'listen:2']);
    const tools = lines.find((l) => l.id === 3);
    expect(tools?.result).toBeDefined();
    expect(handle.events.registry?.activeCount()).toBe(2);
  });

  it('routes a committed event to the subscription that asked for its feed, one line per message', async () => {
    const before = lines.length;
    handle.events.registry?.notify(['raid']);
    await until(() => lines.length > before, 3000, 'raid update');
    await sleep(100);
    const fresh = lines.slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { _meta: { [SUB_ID]: 'listen:1' }, uri: 'xinas://events/raid' },
    });
  });

  it('an inbound notifications/cancelled for a live listen closes it and is not forwarded', async () => {
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'listen:1', reason: 'done' },
      }),
    );
    await until(() => handle.events.registry?.activeCount() === 1, 3000, 'listener removal');
    const before = lines.length;
    handle.events.registry?.notify(['raid']);
    handle.events.registry?.notify(['nfs']);
    await until(() => lines.length > before, 3000, 'nfs update');
    await sleep(150);
    const fresh = lines.slice(before);
    expect(fresh).toHaveLength(1);
    expect(subId(fresh[0] as Line)).toBe('listen:2');
    expect((fresh[0] as Line).params?.uri).toBe('xinas://events/nfs');
  });

  it('writes a pre-acknowledgment rejection as one ordinary response line', async () => {
    const before = lines.length;
    listen('listen:bad', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    await until(() => lines.length > before, 3000, 'rejection');
    const l = lines[before] as Line;
    expect(l.id).toBe('listen:bad');
    expect(l.error?.code).toBe(-32602);
  });

  it('close() ends every live listen without leaving the api a listener', async () => {
    await bridge.close();
    await until(() => handle.events.registry?.activeCount() === 0, 3000, 'no listeners');
  });
});
