import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';

/**
 * S17 §5: `subscriptions/listen` over Streamable HTTP — the response is an
 * SSE stream that stays open; the acknowledgment is its first message;
 * `notifications/resources/updated` follows a committed event on an
 * accepted feed; keep-alives are SSE comments; closing the response cancels.
 * Raw HTTP on purpose (the hostile-input harness).
 */

const CID = '00000000-0000-0000-0000-000000000918';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'example-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';
const AGENT_TOKEN = 'tok-agent';

interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** JSON-RPC messages parsed from `data:` lines, in order. */
  messages: unknown[];
  /** SSE comment lines seen. */
  comments: string[];
  ended: boolean;
  /** Resolve when at least `n` messages have arrived (or reject on timeout). */
  waitFor(n: number, timeoutMs?: number): Promise<void>;
  waitForEnd(timeoutMs?: number): Promise<void>;
  waitForComment(timeoutMs?: number): Promise<void>;
  close(): void;
}

function post(
  port: number,
  message: unknown,
  opts: { token?: string | null; accept?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; stream: Stream }> {
  const payload = JSON.stringify(message);
  const token = opts.token === undefined ? 'tok-admin' : opts.token;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: opts.accept ?? 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const messages: unknown[] = [];
        const comments: string[] = [];
        // A waiter returns true once satisfied; unmet waiters stay queued.
        const waiters: Array<() => boolean> = [];
        let buffer = '';
        let body = '';
        let ended = false;
        const stream: Stream = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          messages,
          comments,
          get ended() {
            return ended;
          },
          waitFor: (n, timeoutMs = 3000) =>
            new Promise<void>((ok, bad) => {
              const t = setTimeout(
                () => bad(new Error(`timeout waiting for ${n} messages; have ${messages.length}`)),
                timeoutMs,
              );
              const check = () => {
                if (messages.length >= n) {
                  clearTimeout(t);
                  ok();
                  return true;
                }
                return false;
              };
              if (!check()) waiters.push(check);
            }),
          waitForEnd: (timeoutMs = 3000) =>
            new Promise<void>((ok, bad) => {
              const t = setTimeout(() => bad(new Error('timeout waiting for end')), timeoutMs);
              const check = () => {
                if (ended) {
                  clearTimeout(t);
                  ok();
                  return true;
                }
                return false;
              };
              if (!check()) waiters.push(check);
            }),
          waitForComment: (timeoutMs = 3000) =>
            new Promise<void>((ok, bad) => {
              const t = setTimeout(
                () => bad(new Error('timeout waiting for a comment')),
                timeoutMs,
              );
              const check = () => {
                if (comments.length > 0) {
                  clearTimeout(t);
                  ok();
                  return true;
                }
                return false;
              };
              if (!check()) waiters.push(check);
            }),
          close: () => req.destroy(),
        };
        const wake = () => {
          const pending = waiters.splice(0);
          for (const w of pending) if (!w()) waiters.push(w);
        };
        const isSse = (res.headers['content-type'] ?? '').startsWith('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!isSse) {
            body += chunk;
            return;
          }
          buffer += chunk;
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) comments.push(line);
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length > 0) messages.push(JSON.parse(dataLines.join('\n')));
            idx = buffer.indexOf('\n\n');
          }
          wake();
        });
        res.on('end', () => {
          ended = true;
          wake();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, stream });
        });
        res.on('close', () => {
          ended = true;
          wake();
        });
        if (isSse) resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '', stream });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // A reset after our own close() is expected; anything else fails the test.
      if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) {
        reject(new Error(`connection reset before a response: ${err.message}`));
        return;
      }
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

const listen = (
  port: number,
  id: string | number,
  notifications: unknown,
  opts: { token?: string | null; accept?: string } = {},
) =>
  post(
    port,
    { jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: META, notifications } },
    opts,
  );

/** Push one observed Filesystem row through the agent path. */
function pushFilesystem(
  port: number,
  mounted: boolean,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const body = JSON.stringify({
    observed_at: new Date().toISOString(),
    controller_id: CID,
    deltas: [
      {
        kind: 'Filesystem',
        id: 'srv-data.mount',
        op: 'upsert',
        value: {
          kind: 'Filesystem',
          id: 'srv-data.mount',
          status: {
            mountpoint: '/srv/data',
            backing_device: '/dev/xi_data',
            mounted,
            mount_unit_state: mounted ? 'active' : 'inactive',
            effective_mount_options: ['rw'],
            uuid: 'u',
            size_bytes: 100,
            free_bytes: 50,
            observed_at: new Date().toISOString(),
            ...extra,
          },
        },
      },
    ],
    complete_snapshots: ['Filesystem'],
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/internal/v1/observed',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${AGENT_TOKEN}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function startWith(dir: string, subscriptions: Record<string, unknown> = {}) {
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      controller_id: CID,
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      tokens: {
        'tok-admin': { principal: 'admin:test', role: 'admin' },
        'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
        'tok-op': { principal: 'operator:test', role: 'operator' },
        [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
      },
      state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
      mcp: {
        subscriptions: {
          keepalive_ms: 1000,
          coalesce_ms: 50,
          max_listeners_per_principal: 4,
          ...subscriptions,
        },
      },
    }),
  );
  const handle = await startServer({ configPath });
  return { handle, port: (handle.address as AddressInfo).port };
}

describe('mcp modern era — subscriptions/listen over Streamable HTTP (S17 §5)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  const open: Stream[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-listen-'));
    ({ handle, port } = await startWith(dir));
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await new Promise((r) => setTimeout(r, 50));
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with an SSE stream whose first message is the acknowledgment of the accepted feeds', async () => {
    const { status, headers, stream } = await listen(port, 'listen:1', {
      resourceSubscriptions: [
        'xinas://events/raid',
        'xinas://events/raid',
        'xinas://events/nfs/sessions',
        'ui://nope',
        'xinas://events/raid?limit=1',
        'xinas://events/system/',
      ],
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
    });
    open.push(stream);
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/^text\/event-stream/);
    expect(headers['x-accel-buffering']).toBe('no');
    expect(headers['cache-control']).toContain('no-cache');
    expect(headers['x-correlation-id']).toBeDefined();
    await stream.waitFor(1);
    expect(stream.messages[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { [SUB_ID]: 'listen:1' },
        notifications: {
          resourceSubscriptions: ['xinas://events/raid', 'xinas://events/nfs/sessions'],
        },
      },
    });
  });

  it('keeps a numeric request id as a number', async () => {
    const { stream } = await listen(
      port,
      9,
      { resourceSubscriptions: ['xinas://events/storage'] },
      { token: 'tok-viewer' },
    );
    open.push(stream);
    await stream.waitFor(1);
    expect(
      (stream.messages[0] as { params: { _meta: Record<string, unknown> } }).params._meta[SUB_ID],
    ).toBe(9);
  });

  it('wakes only the subscribers of the feed a committed event landed on', async () => {
    const storage = await listen(
      port,
      'listen:s',
      { resourceSubscriptions: ['xinas://events/storage'] },
      { token: 'tok-viewer' },
    );
    const raid = await listen(port, 'listen:r', { resourceSubscriptions: ['xinas://events/raid'] });
    open.push(storage.stream, raid.stream);
    await storage.stream.waitFor(1);
    await raid.stream.waitFor(1);
    expect(await pushFilesystem(port, true)).toBe(200); // baseline: no event
    expect(await pushFilesystem(port, false)).toBe(200); // mount.lost → storage feed
    await storage.stream.waitFor(2);
    expect(storage.stream.messages[1]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { _meta: { [SUB_ID]: 'listen:s' }, uri: 'xinas://events/storage' },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(raid.stream.messages).toHaveLength(1);
    expect(handle.events.journal.listAfter('storage', 0, 10).map((e) => e.type)).toEqual([
      'filesystem.mount.lost',
    ]);
  });

  it.each([
    [
      'an unknown xiNAS field',
      { resourceSubscriptions: ['xinas://events/raid'], eventTypes: ['x'] },
    ],
    ['a non-object notifications', 'raid'],
    ['a non-array resourceSubscriptions', { resourceSubscriptions: 'xinas://events/raid' }],
    ['a non-string entry', { resourceSubscriptions: [1] }],
    ['a non-boolean flag', { toolsListChanged: 'yes' }],
    ['too many distinct URIs', { resourceSubscriptions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
  ])('rejects %s with a JSON -32602 before any stream exists', async (_label, notifications) => {
    const r = await listen(port, 'bad', notifications);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const body = JSON.parse(r.body) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });

  it('rejects a missing notifications object and an unknown params key', async () => {
    let r = await post(port, {
      jsonrpc: '2.0',
      id: 'x',
      method: 'subscriptions/listen',
      params: { _meta: META },
    });
    expect((JSON.parse(r.body) as { error: { code: number } }).error.code).toBe(-32602);
    r = await post(port, {
      jsonrpc: '2.0',
      id: 'x',
      method: 'subscriptions/listen',
      params: { _meta: META, notifications: {}, extra: 1 },
    });
    expect((JSON.parse(r.body) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('requires text/event-stream in Accept and a valid bearer', async () => {
    const r = await listen(
      port,
      'x',
      { resourceSubscriptions: ['xinas://events/raid'] },
      { accept: 'application/json' },
    );
    expect(r.status).toBe(406);
    expect((JSON.parse(r.body) as { error: { code: number } }).error.code).toBe(-32600);
    const u = await listen(
      port,
      'x',
      { resourceSubscriptions: ['xinas://events/raid'] },
      { token: null },
    );
    expect(u.status).toBe(401);
  });

  it('acknowledges an empty accepted set and ends the subscription gracefully at once', async () => {
    const { stream } = await listen(port, 'listen:e', {
      resourceSubscriptions: ['ui://nope', 'xinas://events/raid?after=x'],
      promptsListChanged: true,
    });
    await stream.waitForEnd();
    expect(stream.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { _meta: { [SUB_ID]: 'listen:e' }, notifications: {} },
      },
      {
        jsonrpc: '2.0',
        id: 'listen:e',
        result: { resultType: 'complete', _meta: { [SUB_ID]: 'listen:e' } },
      },
    ]);
  });

  it('emits SSE comment keep-alives while idle', async () => {
    const { stream } = await listen(
      port,
      'listen:k',
      { resourceSubscriptions: ['xinas://events/system'] },
      { token: 'tok-viewer' },
    );
    open.push(stream);
    await stream.waitForComment(2500);
    expect(stream.comments[0]).toMatch(/^: ?keep-alive/);
    expect(stream.messages).toHaveLength(1);
  });

  it('a closed response removes only that listener; the journal is untouched', async () => {
    const before = handle.events.registry?.activeCount() ?? 0;
    const rows = handle.events.journal.count();
    const { stream } = await listen(
      port,
      'listen:c',
      { resourceSubscriptions: ['xinas://events/nfs'] },
      { token: 'tok-viewer' },
    );
    await stream.waitFor(1);
    expect(handle.events.registry?.activeCount()).toBe(before + 1);
    stream.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(handle.events.registry?.activeCount()).toBe(before);
    expect(handle.events.journal.count()).toBe(rows);
  });

  it('refuses a listener beyond the per-principal limit with -32000 and no partial stream', async () => {
    for (let i = 0; i < 4; i++) {
      const { stream } = await listen(
        port,
        `op-${i}`,
        { resourceSubscriptions: ['xinas://events/raid'] },
        { token: 'tok-op' },
      );
      open.push(stream);
      await stream.waitFor(1);
    }
    const r = await listen(
      port,
      'listen:over',
      { resourceSubscriptions: ['xinas://events/raid'] },
      { token: 'tok-op' },
    );
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const body = JSON.parse(r.body) as { error: { code: number; data: { limit: string } } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.data.limit).toBe('principal');
  });
});

describe('mcp modern era — subscriptions/listen graceful shutdown', () => {
  it('sends the subscriptions/listen result to open streams, then ends them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-listen-shutdown-'));
    const { handle, port } = await startWith(dir);
    const { stream } = await listen(port, 'listen:g', {
      resourceSubscriptions: ['xinas://events/raid'],
    });
    await stream.waitFor(1);
    await handle.close();
    await stream.waitForEnd();
    expect(stream.messages.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'listen:g',
      result: { resultType: 'complete', _meta: { [SUB_ID]: 'listen:g' } },
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
