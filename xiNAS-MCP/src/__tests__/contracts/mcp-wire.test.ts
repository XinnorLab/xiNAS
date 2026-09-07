// @vitest-environment node
/**
 * S17 §15 wire contract: every MCP `2026-07-28` message the S17 surface
 * emits — discover, resources/list, resources/templates/list,
 * resources/read, the listen acknowledgment, a resource-updated
 * notification and the graceful listen result — validates against the
 * vendored released schema (`mcp/2026-07-28/schema.json`, draft 2020-12).
 * The fixed resource values (URIs, names, MIME) are pinned byte-exact.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Ajv publishes CJS-style `export =` types; bridge with a cast like contracts.test.ts.
import Ajv2020Import from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';

// biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop for ajv
const Ajv2020 = Ajv2020Import as any;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(resolve(here, 'mcp/2026-07-28/schema.json'), 'utf8'));
const CID = '00000000-0000-0000-0000-000000000920';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const AGENT_TOKEN = 'tok-agent';

interface Json {
  status: number;
  body: Record<string, unknown>;
}

function rpc(port: number, message: unknown): Promise<Json> {
  const payload = JSON.stringify(message);
  return new Promise((resolveP, reject) => {
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
          authorization: 'Bearer tok-admin',
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
    req.write(payload);
    req.end();
  });
}

/** Open a listen stream and collect every SSE data payload until it ends. */
function sseListen(
  port: number,
  message: unknown,
): Promise<{ ready: Promise<void>; done: Promise<unknown[]> }> {
  const payload = JSON.stringify(message);
  return new Promise((resolveP, reject) => {
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
          authorization: 'Bearer tok-admin',
        },
      },
      (res) => {
        const messages: unknown[] = [];
        let buffer = '';
        let readyResolve: () => void = () => {};
        const ready = new Promise<void>((r) => {
          readyResolve = r;
        });
        const done = new Promise<unknown[]>((r) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let idx = buffer.indexOf('\n\n');
            while (idx !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart());
              if (data.length > 0) messages.push(JSON.parse(data.join('\n')));
              if (messages.length === 1) readyResolve();
              idx = buffer.indexOf('\n\n');
            }
          });
          res.on('end', () => r(messages));
        });
        resolveP({ ready, done });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function pushFilesystem(port: number, mounted: boolean): Promise<number> {
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
          },
        },
      },
    ],
    complete_snapshots: ['Filesystem'],
  });
  return new Promise((resolveP, reject) => {
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
        res.on('end', () => resolveP(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('S17 wire messages validate against the released 2026-07-28 schema', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  // biome-ignore lint/suspicious/noExplicitAny: ajv instance
  let ajv: any;
  const validateAs = (def: string, value: unknown): string[] => {
    const validate =
      ajv.getSchema(`mcp#/$defs/${def}`) ?? ajv.compile({ $ref: `mcp#/$defs/${def}` });
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message ?? ''}`,
        );
  };
  let streamMessages: unknown[] = [];

  beforeAll(async () => {
    ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(SCHEMA, 'mcp');
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-wire-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: CID,
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: {
          'tok-admin': { principal: 'admin:test', role: 'admin' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        mcp: { subscriptions: { coalesce_ms: 20 } },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;

    // Drive one full subscription lifecycle now so the stream's messages
    // (ack, update, graceful result) are available to the assertions below.
    const listenRequest = {
      jsonrpc: '2.0',
      id: 'listen-wire',
      method: 'subscriptions/listen',
      params: { _meta: META, notifications: { resourceSubscriptions: ['xinas://events/storage'] } },
    };
    expect(validateAs('SubscriptionsListenRequest', listenRequest)).toEqual([]);
    const stream = await sseListen(port, listenRequest);
    await stream.ready;
    await pushFilesystem(port, true);
    await pushFilesystem(port, false);
    await new Promise((r) => setTimeout(r, 300));
    await handle.close();
    streamMessages = await stream.done;
    ({ handle, port } = await (async () => {
      const h = await startServer({ configPath });
      return { handle: h, port: (h.address as AddressInfo).port };
    })());
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpc(port, { jsonrpc: '2.0', id: `w-${method}`, method, params: { _meta: META, ...params } });

  it('server/discover → DiscoverResult with the resources capability', async () => {
    const r = await call('server/discover');
    expect(validateAs('DiscoverResult', r.body.result)).toEqual([]);
    expect(
      validateAs('ServerCapabilities', (r.body.result as { capabilities: unknown }).capabilities),
    ).toEqual([]);
  });

  it('resources/list → ListResourcesResult with the pinned values', async () => {
    const r = await call('resources/list');
    expect(validateAs('ListResourcesResult', r.body.result)).toEqual([]);
    const resources = (
      r.body.result as { resources: Array<{ uri: string; name: string; mimeType: string }> }
    ).resources;
    expect(resources.map((x) => [x.uri, x.name, x.mimeType])).toEqual([
      ['xinas://events/raid', 'RAID events', 'application/vnd.xinas.events+json'],
      ['xinas://events/raid/progress', 'RAID progress', 'application/vnd.xinas.events+json'],
      ['xinas://events/storage', 'Storage events', 'application/vnd.xinas.events+json'],
      ['xinas://events/nfs', 'NFS events', 'application/vnd.xinas.events+json'],
      ['xinas://events/nfs/sessions', 'NFS session events', 'application/vnd.xinas.events+json'],
      ['xinas://events/system', 'System events', 'application/vnd.xinas.events+json'],
      ['ui://xinas/raid-create', 'xiNAS RAID Create', 'text/html;profile=mcp-app'],
    ]);
    for (const res of resources) expect(validateAs('Resource', res)).toEqual([]);
  });

  it('resources/templates/list → ListResourceTemplatesResult', async () => {
    const r = await call('resources/templates/list');
    expect(validateAs('ListResourceTemplatesResult', r.body.result)).toEqual([]);
  });

  it('resources/read → ReadResourceResult (text contents)', async () => {
    const r = await call('resources/read', { uri: 'xinas://events/storage' });
    expect(validateAs('ReadResourceResult', r.body.result)).toEqual([]);
    const text = (r.body.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? '';
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('an invalid read → JSONRPCErrorResponse with -32602', async () => {
    const r = await call('resources/read', { uri: 'xinas://events/nope' });
    expect(validateAs('JSONRPCErrorResponse', r.body)).toEqual([]);
    expect((r.body.error as { code: number }).code).toBe(-32602);
  });

  it('the listen stream: acknowledgment, resource update, graceful result — in that order', () => {
    expect(streamMessages).toHaveLength(3);
    const [ack, updated, result] = streamMessages;
    expect(validateAs('SubscriptionsAcknowledgedNotification', ack)).toEqual([]);
    expect(validateAs('ResourceUpdatedNotification', updated)).toEqual([]);
    expect(validateAs('SubscriptionsListenResultResponse', result)).toEqual([]);
    for (const m of streamMessages) expect(validateAs('JSONRPCMessage', m)).toEqual([]);
    expect((updated as { params: { uri: string } }).params.uri).toBe('xinas://events/storage');
    expect((result as { id: string }).id).toBe('listen-wire');
  });
});
