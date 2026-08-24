import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODERN_PROTOCOL_VERSIONS } from '../../api/mcp/discover.js';
import { startServer } from '../../api/server.js';

/**
 * S14: the MCP **modern protocol era** (`server/discover`, per-request
 * `_meta`, no session) served alongside the untouched legacy era.
 *
 * The clients here are hand-rolled JSON-RPC rather than SDK clients on
 * purpose: no published `@modelcontextprotocol/sdk` (≤ 1.30.0) implements
 * the modern era, so the SDK cannot speak this wire format at all. These
 * requests are byte-for-byte what an SDK client in `auto`/pinned mode will
 * send once it can — see `docs/control-path/s14-mcp-modern-era-spec.md` §8
 * and the matching `docs/TODO.md` entry.
 */
describe('mcp modern era — server/discover (S14)', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let mcpPort: number;

  interface RpcResult {
    status: number;
    body: Record<string, unknown>;
    session?: string;
  }

  function rpc(
    targetPort: number,
    message: unknown,
    opts: { session?: string; token?: string } = {},
  ): Promise<RpcResult> {
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

  /** The standard modern `_meta` envelope every modern request carries. */
  const META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'example-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  const DISCOVER = {
    jsonrpc: '2.0',
    id: 'discover-1',
    method: 'server/discover',
    params: { _meta: META },
  };

  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  };

  interface DiscoverResult {
    resultType: string;
    supportedVersions: string[];
    capabilities: Record<string, unknown>;
    instructions: string;
    ttlMs: number;
    cacheScope: string;
    _meta: Record<string, unknown>;
    extensions?: unknown;
  }

  const resultOf = (r: RpcResult): DiscoverResult => r.body.result as DiscoverResult;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-discover-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: '00000000-0000-0000-0000-000000000778',
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: {
          'tok-admin': { principal: 'admin:test', role: 'admin' },
          'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
        },
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

  // AC1 + AC2
  it('answers server/discover before any initialize, without opening a session', async () => {
    const res = await rpc(port, DISCOVER, { token: 'tok-admin' });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.id).toBe('discover-1');
    expect(res.body.jsonrpc).toBe('2.0');
    // No stateful session was created and none was advertised.
    expect(res.session).toBeUndefined();
  });

  // AC2 (continued): a stale/foreign session id must not change the answer,
  // and discovery must not have registered one.
  it('ignores an Mcp-Session-Id on a modern request instead of routing legacy', async () => {
    const res = await rpc(port, DISCOVER, { token: 'tok-admin', session: 'not-a-real-session' });
    expect(res.status).toBe(200);
    expect(resultOf(res).resultType).toBe('complete');
    expect(res.session).toBeUndefined();
  });

  // AC3 + AC4: shape per the official 2026-07-28 schema.
  it('returns a schema-valid DiscoverResult with every required field', async () => {
    const result = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));

    // DiscoverResult.required = [cacheScope, capabilities, resultType,
    // supportedVersions, ttlMs]; xiNAS additionally always sends
    // instructions + serverInfo (s14 §2, deliberate stricter local rule).
    expect(result.resultType).toBe('complete');
    expect(Array.isArray(result.supportedVersions)).toBe(true);
    expect(typeof result.capabilities).toBe('object');
    expect(Number.isInteger(result.ttlMs)).toBe(true);
    expect(result.ttlMs).toBeGreaterThanOrEqual(0);
    expect(['public', 'private']).toContain(result.cacheScope);
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions.length).toBeGreaterThan(0);

    const serverInfo = result._meta['io.modelcontextprotocol/serverInfo'] as {
      name?: unknown;
      version?: unknown;
    };
    expect(typeof serverInfo.name).toBe('string');
    expect(typeof serverInfo.version).toBe('string');
  });

  // AC5
  it('advertises 2026-07-28 and no legacy version', async () => {
    const { supportedVersions } = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));
    expect(supportedVersions).toContain('2026-07-28');
    expect(supportedVersions.length).toBeGreaterThan(0);
    expect(supportedVersions).toEqual([...MODERN_PROTOCOL_VERSIONS]);
    // Legacy versions are negotiated through initialize only (req §2.4).
    for (const legacy of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      expect(supportedVersions).not.toContain(legacy);
    }
  });

  // AC6 + AC7
  it('puts extensions under capabilities and advertises only implemented capabilities', async () => {
    const result = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));

    // Never a top-level result.extensions (req §2.4).
    expect(result.extensions).toBeUndefined();
    if ('extensions' in result.capabilities) {
      expect(typeof result.capabilities.extensions).toBe('object');
    }

    // tools are served; resources/prompts are not implemented (ADR-0010)
    // and must therefore not be advertised.
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeUndefined();
    expect(result.capabilities.prompts).toBeUndefined();

    // The claim is checked, not asserted: a tools capability must mean
    // tools/list actually answers.
    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 'm-list', method: 'tools/list', params: { _meta: META } },
      { token: 'tok-admin' },
    );
    const tools = (list.body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThan(0);
  });

  // AC8
  it('is repeatable: two consecutive calls are deeply equal and change no state', async () => {
    const a = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));
    const b = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));
    expect(a.resultType).toBe('complete'); // guards against two equal undefineds
    expect(b).toEqual(a);

    // A legacy initialize still works afterwards — discovery left no
    // negotiation state behind that could poison the other era (req §2.5.5).
    const init = await rpc(port, INITIALIZE, { token: 'tok-admin' });
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
  });

  // AC9: discovery is optional — a modern operational request works directly.
  it('serves tools/list and tools/call statelessly, with no discovery and no session', async () => {
    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 'm1', method: 'tools/list', params: { _meta: META } },
      { token: 'tok-admin' },
    );
    expect(list.status).toBe(200);
    expect(list.session).toBeUndefined();
    const tools = (list.body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('arrays.list');
    expect(tools.map((t) => t.name)).not.toContain('support.download'); // binary excluded

    const call = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 'm2',
        method: 'tools/call',
        params: { _meta: META, name: 'arrays.list', arguments: {} },
      },
      { token: 'tok-admin' },
    );
    expect(call.status).toBe(200);
    expect(call.session).toBeUndefined();
    const result = call.body.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]?.text as string)).toHaveProperty('result');
  });

  // AC13 + req §2.5.3
  it('never returns a modern version from initialize', async () => {
    const init = await rpc(port, INITIALIZE, { token: 'tok-admin' });
    const negotiated = (init.body.result as { protocolVersion: string }).protocolVersion;
    expect(MODERN_PROTOCOL_VERSIONS).not.toContain(negotiated);
    expect(negotiated).toBe('2025-11-25');
  });

  // AC14
  it('marks the response private because it is produced in an authorization context', async () => {
    const admin = resultOf(await rpc(port, DISCOVER, { token: 'tok-admin' }));
    const viewer = resultOf(await rpc(port, DISCOVER, { token: 'tok-viewer' }));
    expect(admin.cacheScope).toBe('private');
    expect(viewer.cacheScope).toBe('private');
  });

  // AC15: the single most damaging failure mode — an auth error that reads
  // as "this server has no modern support" and silently downgrades clients.
  it('rejects an unauthenticated discover with 401 and never with -32601', async () => {
    for (const opts of [{}, { token: 'nope' }]) {
      const res = await rpc(port, DISCOVER, opts);
      expect(res.status).toBe(401);
      const error = res.body.error as { code: number } | undefined;
      expect(error).toBeDefined();
      expect(error?.code).not.toBe(-32601); // NOT "Method not found" (req §2.5.7-8)
    }
  });

  it('rejects an unauthenticated stateless tools/call with 401, not -32601', async () => {
    const res = await rpc(port, {
      jsonrpc: '2.0',
      id: 'm3',
      method: 'tools/call',
      params: { _meta: META, name: 'arrays.list', arguments: {} },
    });
    expect(res.status).toBe(401);
    expect((res.body.error as { code: number }).code).not.toBe(-32601);
  });

  it('answers a modern notification with an empty 202, never a response object', async () => {
    const res = await rpc(
      port,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: META } },
      { token: 'tok-admin' },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(res.session).toBeUndefined();
  });

  it('answers -32601 for an unknown modern method', async () => {
    const res = await rpc(
      port,
      { jsonrpc: '2.0', id: 'm4', method: 'nope/nope', params: { _meta: META } },
      { token: 'tok-admin' },
    );
    expect((res.body.error as { code: number }).code).toBe(-32601);
  });

  it('serves server/discover on the dedicated MCP listener too', async () => {
    const res = await rpc(mcpPort, DISCOVER, { token: 'tok-admin' });
    expect(res.status).toBe(200);
    expect(resultOf(res).supportedVersions).toContain('2026-07-28');
    expect(res.session).toBeUndefined();
  });
});
