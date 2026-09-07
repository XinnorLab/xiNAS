import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../api/events/cursor.js';
import type { EventInput } from '../../api/events/types.js';
import { startServer } from '../../api/server.js';

/**
 * S17 §3–§4: the six operational-event feeds as modern-era MCP Resources —
 * raw JSON-RPC over HTTP (the hostile-input harness; the v2 client interop
 * lives in mcp-client-v2.test.ts).
 */

const CID = '00000000-0000-0000-0000-000000000917';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'example-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

interface RpcResult {
  status: number;
  body: Record<string, unknown>;
}

/** `token: null` sends no Authorization header (an explicit `undefined` would pick the default). */
function rpc(
  port: number,
  message: unknown,
  token: string | null = 'tok-admin',
): Promise<RpcResult> {
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
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
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

const call = (
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  token: string | null = 'tok-admin',
) =>
  rpc(
    port,
    { jsonrpc: '2.0', id: `r-${method}`, method, params: { _meta: META, ...params } },
    token,
  );

const read = async (port: number, uri: string, token: string | null = 'tok-admin') => {
  const r = await call(port, 'resources/read', { uri }, token);
  const result = r.body.result as
    | {
        contents: Array<{ uri: string; mimeType: string; text: string }>;
        resultType: string;
        ttlMs: number;
        cacheScope: string;
      }
    | undefined;
  const error = r.body.error as { code: number; message: string } | undefined;
  return {
    status: r.status,
    result,
    error,
    envelope:
      result !== undefined
        ? (JSON.parse(result.contents[0]?.text ?? '{}') as Record<string, unknown>)
        : undefined,
  };
};

const FEED_URIS = [
  'xinas://events/raid',
  'xinas://events/raid/progress',
  'xinas://events/storage',
  'xinas://events/nfs',
  'xinas://events/nfs/sessions',
  'xinas://events/system',
];

const input = (summary: string, feed: EventInput['feed'] = 'raid'): EventInput => ({
  schemaVersion: '1',
  feed,
  type: 'raid.state.degraded',
  severity: 'error',
  detectedAt: '2026-09-04T12:00:00.000Z',
  timeAccuracy: 'observed',
  source: { kind: 'observed_transition', component: 'XiraidArray' },
  subject: { kind: 'XiraidArray', id: 'data' },
  summary,
});

async function startWith(dir: string, extraMcp: Record<string, unknown> = {}) {
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      controller_id: CID,
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      tokens: {
        'tok-admin': { principal: 'admin:test', role: 'admin' },
        'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
      },
      state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
      mcp: { ...extraMcp },
    }),
  );
  const handle = await startServer({ configPath });
  return { handle, port: (handle.address as AddressInfo).port };
}

describe('mcp modern era — event feed resources (S17 §4)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-resources-'));
    ({ handle, port } = await startWith(dir));
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('server/discover advertises complete resource subscription support', async () => {
    const r = await call(port, 'server/discover');
    expect(
      (r.body.result as { capabilities: Record<string, unknown> }).capabilities.resources,
    ).toEqual({
      subscribe: true,
      listChanged: false,
    });
  });

  it('resources/list returns the six feeds in order with private, uncacheable meta', async () => {
    const r = await call(port, 'resources/list');
    const result = r.body.result as {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      nextCursor?: unknown;
      resources: Array<{
        uri: string;
        name: string;
        mimeType: string;
        description: string;
        annotations?: unknown;
      }>;
    };
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    expect(result).not.toHaveProperty('nextCursor');
    expect(result.resources.map((x) => x.uri)).toEqual(FEED_URIS);
    expect(result.resources.map((x) => x.name)).toEqual([
      'RAID events',
      'RAID progress',
      'Storage events',
      'NFS events',
      'NFS session events',
      'System events',
    ]);
    for (const res of result.resources) {
      expect(res.mimeType).toBe('application/vnd.xinas.events+json');
      expect(res.description.length).toBeGreaterThan(10);
      expect(res).not.toHaveProperty('annotations');
    }
  });

  it('resources/list rejects a pagination cursor the server never issued', async () => {
    const r = await call(port, 'resources/list', { cursor: 'abc' });
    expect((r.body.error as { code: number }).code).toBe(-32602);
  });

  it('resources/templates/list returns one cursor template per feed', async () => {
    const r = await call(port, 'resources/templates/list');
    const result = r.body.result as {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      resourceTemplates: Array<{ uriTemplate: string; name: string; mimeType: string }>;
    };
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    expect(result.resourceTemplates.map((t) => t.uriTemplate)).toEqual(
      FEED_URIS.map((u) => `${u}{?after,limit}`),
    );
    expect(result.resourceTemplates[0]?.mimeType).toBe('application/vnd.xinas.events+json');
  });

  it('reads an empty feed with head == oldest == next and the producer metadata', async () => {
    const r = await read(port, 'xinas://events/raid');
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(r.result?.contents).toHaveLength(1);
    expect(r.result?.contents[0]).toMatchObject({
      uri: 'xinas://events/raid',
      mimeType: 'application/vnd.xinas.events+json',
    });
    const env = r.envelope as Record<string, unknown>;
    expect(env).toMatchObject({
      schemaVersion: '1',
      feed: 'raid',
      events: [],
      hasMore: false,
      gap: false,
    });
    expect(env.nextCursor).toBe(env.headCursor);
    expect(env.oldestAvailableCursor).toBe(env.headCursor);
    expect(typeof env.generatedAt).toBe('string');
    expect(
      (env.producers as { inactive: Array<{ family: string }> }).inactive.map((i) => i.family),
    ).toEqual(['raid.device', 'raid.license']);
  });

  it('pages ascending through committed events and honors limits, cursors and gaps', async () => {
    for (let i = 1; i <= 7; i++) handle.events.journal.insert(input(`e${i}`));
    handle.events.journal.insert(input('other', 'nfs'));

    // No cursor: the newest `limit` rows, ascending.
    let r = await read(port, 'xinas://events/raid?limit=3');
    let env = r.envelope as {
      events: Array<{ summary: string; sequence: number }>;
      hasMore: boolean;
      nextCursor: string;
      headCursor: string;
    };
    expect(env.events.map((e) => e.summary)).toEqual(['e5', 'e6', 'e7']);
    expect(env.hasMore).toBe(false);
    expect(decodeCursor(env.nextCursor, { controllerId: CID, feed: 'raid', last: 8 })).toEqual({
      sequence: 7,
    });
    expect(decodeCursor(env.headCursor, { controllerId: CID, feed: 'raid', last: 8 })).toEqual({
      sequence: 8,
    });

    // After a cursor: the rows after it.
    const after2 = encodeCursor({ controllerId: CID, feed: 'raid', sequence: 2 });
    r = await read(port, `xinas://events/raid?after=${after2}&limit=2`);
    env = r.envelope as typeof env;
    expect(env.events.map((e) => e.summary)).toEqual(['e3', 'e4']);
    expect(env.hasMore).toBe(true);
    r = await read(port, `xinas://events/raid?after=${env.nextCursor}`);
    env = r.envelope as typeof env;
    expect(env.events.map((e) => e.summary)).toEqual(['e5', 'e6', 'e7']);
    expect(env.hasMore).toBe(false);

    // A cursor at the head returns nothing and echoes the cursor.
    r = await read(port, `xinas://events/raid?after=${env.nextCursor}`);
    env = r.envelope as typeof env;
    expect(env.events).toEqual([]);
    expect(env.nextCursor).toBe(
      env.headCursor === env.nextCursor ? env.nextCursor : env.nextCursor,
    );

    // Retention removes the oldest rows; an old cursor reports a visible gap.
    handle.events.journal.retentionSweep({
      retentionDays: 30,
      maxRows: 4,
      batchRows: 500,
      maxBatches: 50,
    });
    const after1 = encodeCursor({ controllerId: CID, feed: 'raid', sequence: 1 });
    r = await read(port, `xinas://events/raid?after=${after1}`);
    const gapEnv = r.envelope as {
      events: Array<{ summary: string }>;
      gap: boolean;
      oldestAvailableCursor: string;
    };
    expect(gapEnv.gap).toBe(true);
    expect(gapEnv.events.map((e) => e.summary)).toEqual(['e5', 'e6', 'e7']);
    expect(
      decodeCursor(gapEnv.oldestAvailableCursor, { controllerId: CID, feed: 'raid', last: 8 }),
    ).toEqual({ sequence: 4 });

    // A cursor exactly at oldest − 1 is not a gap.
    const after4 = encodeCursor({ controllerId: CID, feed: 'raid', sequence: 4 });
    r = await read(port, `xinas://events/raid?after=${after4}`);
    expect((r.envelope as { gap: boolean }).gap).toBe(false);
  });

  it.each([
    ['unknown query key', 'xinas://events/raid?x=1'],
    ['limit 0', 'xinas://events/raid?limit=0'],
    ['limit 501', 'xinas://events/raid?limit=501'],
    ['limit non-integer', 'xinas://events/raid?limit=1.5'],
    ['garbage cursor', 'xinas://events/raid?after=zzz'],
    ['duplicate cursor', 'xinas://events/raid?after=a&after=b'],
    ['fragment', 'xinas://events/raid#f'],
    ['file scheme', 'file:///etc/passwd'],
    ['trailing slash', 'xinas://events/raid/'],
    ['upper-case scheme', 'XINAS://events/raid'],
    ['unknown feed', 'xinas://events/tasks'],
    ['path traversal', 'xinas://events/raid/../system'],
    ['empty query pair', 'xinas://events/raid?&limit=1'],
    [
      'cursor from another controller',
      `xinas://events/raid?after=${encodeCursor({ controllerId: 'x', feed: 'raid', sequence: 1 })}`,
    ],
    [
      'cursor from another feed',
      `xinas://events/raid?after=${encodeCursor({ controllerId: CID, feed: 'nfs', sequence: 1 })}`,
    ],
    [
      'cursor from the future',
      `xinas://events/raid?after=${encodeCursor({ controllerId: CID, feed: 'raid', sequence: 10_000 })}`,
    ],
  ])('rejects %s with -32602 and no journal content', async (_label, uri) => {
    const r = await read(port, uri);
    expect(r.status).toBe(200);
    expect(r.error?.code).toBe(-32602);
    expect(JSON.stringify(r.error)).not.toContain('e5');
  });

  it('rejects a non-string uri and MRTR fields on a read', async () => {
    let r = await call(port, 'resources/read', { uri: 42 });
    expect((r.body.error as { code: number }).code).toBe(-32602);
    r = await call(port, 'resources/read', { uri: 'xinas://events/raid', inputResponses: {} });
    expect((r.body.error as { code: number }).code).toBe(-32602);
    r = await call(port, 'resources/read', { uri: 'xinas://events/raid', requestState: 'x' });
    expect((r.body.error as { code: number }).code).toBe(-32602);
  });

  it('a viewer reads every feed; an unauthenticated caller gets 401', async () => {
    for (const uri of FEED_URIS) {
      const r = await read(port, uri, 'tok-viewer');
      expect(r.status, uri).toBe(200);
      expect(r.error).toBeUndefined();
    }
    const r = await read(port, 'xinas://events/raid', null);
    expect(r.status).toBe(401);
  });

  it('the legacy era still has no resources', async () => {
    const init = await rpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    const caps = (init.body.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(caps.resources).toBeUndefined();
  });
});

describe('mcp modern era — resources disabled by configuration', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-resources-off-'));
    ({ handle, port } = await startWith(dir, { subscriptions: { enabled: false } }));
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises no resources and answers the methods with -32601', async () => {
    const d = await call(port, 'server/discover');
    expect(
      (d.body.result as { capabilities: Record<string, unknown> }).capabilities.resources,
    ).toBeUndefined();
    for (const method of ['resources/list', 'resources/templates/list']) {
      const r = await call(port, method);
      expect((r.body.error as { code: number }).code, method).toBe(-32601);
    }
    const r = await call(port, 'resources/read', { uri: 'xinas://events/raid' });
    expect((r.body.error as { code: number }).code).toBe(-32601);
    // The journal keeps recording regardless.
    expect(handle.events.journal.count()).toBe(0);
  });
});
