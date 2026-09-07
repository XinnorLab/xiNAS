// @vitest-environment node
/**
 * S17 SUBS-CLIENT-001: interoperability with the released MCP v2 client
 * (`@modelcontextprotocol/client` 2.0.0, protocol `2026-07-28`) over
 * Streamable HTTP — discovery, the six resources, the cursor templates,
 * `listen()` acknowledged first, a committed event waking the right
 * subscription, reading after the cursor, cancellation, reconnect with
 * catch-up, and the silent drop of unknown/unauthorized URIs. The stdio
 * multiplexing item is covered by `mcp-stdio-listen.test.ts` and the e2e
 * suite (the v2 stdio transport spawns a binary, which is an e2e concern).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../api/server.js';

const CID = '00000000-0000-0000-0000-000000000921';
const AGENT_TOKEN = 'tok-agent';
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';
const FEED_URIS = [
  'xinas://events/raid',
  'xinas://events/raid/progress',
  'xinas://events/storage',
  'xinas://events/nfs',
  'xinas://events/nfs/sessions',
  'xinas://events/system',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

function pushFilesystem(port: number, mounted: boolean, id = 'srv-data.mount'): Promise<number> {
  const body = JSON.stringify({
    observed_at: new Date().toISOString(),
    controller_id: CID,
    deltas: [
      {
        kind: 'Filesystem',
        id,
        op: 'upsert',
        value: {
          kind: 'Filesystem',
          id,
          status: {
            mountpoint: `/srv/${id.replace('.mount', '')}`,
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

interface Envelope {
  events: Array<{ type: string; sequence: number }>;
  headCursor: string;
  nextCursor: string;
  gap: boolean;
}

describe('@modelcontextprotocol/client 2.0.0 ↔ xinas-api S17 feeds', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let client: Client;
  const updates: Array<{ uri: string; subscriptionId: unknown }> = [];

  const makeClient = async (token = 'tok-admin'): Promise<Client> => {
    const c = new Client(
      { name: 'xinas-interop', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await c.connect(transport);
    return c;
  };

  const readEnvelope = async (c: Client, uri: string): Promise<Envelope> => {
    const r = await c.readResource({ uri });
    const first = r.contents[0] as { text?: string } | undefined;
    return JSON.parse(first?.text ?? '{}') as Envelope;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-mcp-v2-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        controller_id: CID,
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
        tokens: {
          'tok-admin': { principal: 'admin:test', role: 'admin' },
          'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: join(dir, 'x.db'), auditJsonlPath: join(dir, 'a.jsonl') },
        mcp: { subscriptions: { coalesce_ms: 20, keepalive_ms: 1000 } },
      }),
    );
    handle = await startServer({ configPath });
    port = (handle.address as AddressInfo).port;
    client = await makeClient();
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      updates.push({
        uri: n.params.uri,
        subscriptionId: (n.params._meta as Record<string, unknown> | undefined)?.[SUB_ID],
      });
    });
  });
  afterAll(async () => {
    await client.close().catch(() => {});
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('modern discovery advertises Resources with subscriptions', () => {
    expect(client.getServerCapabilities()?.resources).toEqual({
      subscribe: true,
      listChanged: false,
    });
  });

  it('lists and reads all six resources, and lists the cursor templates', async () => {
    const list = await client.listResources();
    // The six S17 feeds, then the S18 MCP Apps view (never subscribable).
    expect(list.resources.map((r) => r.uri)).toEqual([...FEED_URIS, 'ui://xinas/raid-create']);
    for (const uri of FEED_URIS) {
      const env = await readEnvelope(client, uri);
      expect(env.events, uri).toEqual([]);
      expect(typeof env.headCursor, uri).toBe('string');
    }
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(
      FEED_URIS.map((u) => `${u}{?after,limit}`),
    );
  });

  it('listen() resolves on the acknowledgment with the honored filter; a committed event wakes exactly that subscription; the client reads it after its cursor', async () => {
    const before = await readEnvelope(client, 'xinas://events/storage?limit=1');
    const storage = await client.listen({ resourceSubscriptions: ['xinas://events/storage'] });
    const raid = await client.listen({ resourceSubscriptions: ['xinas://events/raid'] });
    expect(storage.honoredFilter).toEqual({ resourceSubscriptions: ['xinas://events/storage'] });
    expect(raid.honoredFilter).toEqual({ resourceSubscriptions: ['xinas://events/raid'] });
    expect(handle.events.registry?.activeCount()).toBe(2);

    expect(await pushFilesystem(port, true)).toBe(200); // baseline
    expect(await pushFilesystem(port, false)).toBe(200); // mount.lost → storage
    await until(() => updates.length >= 1, 'the storage update');
    await sleep(150);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.uri).toBe('xinas://events/storage');
    const storageSubId = updates[0]?.subscriptionId;
    expect(typeof storageSubId === 'string' || typeof storageSubId === 'number').toBe(true);

    const after = await readEnvelope(client, `xinas://events/storage?after=${before.headCursor}`);
    expect(after.events.map((e) => e.type)).toEqual(['filesystem.mount.lost']);
    expect(after.gap).toBe(false);

    // The raid subscription carries a different id and never woke.
    await pushFilesystem(port, true); // mount.restored → storage again
    await until(() => updates.length >= 2, 'the second storage update');
    expect(updates.every((u) => u.uri === 'xinas://events/storage')).toBe(true);
    expect(updates.every((u) => u.subscriptionId === storageSubId)).toBe(true);

    // Cancellation closes the listener on the server and settles `closed`.
    await storage.close();
    expect(await storage.closed).toBe('local');
    await until(() => handle.events.registry?.activeCount() === 1, 'one listener left');
    await raid.close();
    await until(() => handle.events.registry?.activeCount() === 0, 'no listeners left');
  });

  it('an event committed while disconnected is recovered by cursor after reconnecting', async () => {
    const mark = await readEnvelope(client, 'xinas://events/storage?limit=1');
    expect(await pushFilesystem(port, false)).toBe(200); // mount.lost while nobody listens
    const sub = await client.listen({ resourceSubscriptions: ['xinas://events/storage'] });
    const missed = await readEnvelope(client, `xinas://events/storage?after=${mark.headCursor}`);
    expect(missed.events.map((e) => e.type)).toEqual(['filesystem.mount.lost']);
    await sub.close();
  });

  it('unknown and unauthorized URIs are dropped from the honored filter without disclosure', async () => {
    const mixed = await client.listen({
      resourceSubscriptions: ['ui://nope', 'xinas://events/raid?limit=1', 'xinas://events/system'],
    });
    expect(mixed.honoredFilter).toEqual({ resourceSubscriptions: ['xinas://events/system'] });
    await mixed.close();

    const none = await client.listen({
      resourceSubscriptions: ['ui://nope'],
      promptsListChanged: true,
    });
    expect(none.honoredFilter).toEqual({});
    expect(await none.closed).toBe('graceful');
  });

  it('a viewer connects, lists and reads every feed', async () => {
    const viewer = await makeClient('tok-viewer');
    try {
      expect((await viewer.listResources()).resources).toHaveLength(7); // six feeds + the S18 view
      for (const uri of FEED_URIS) expect((await readEnvelope(viewer, uri)).gap).toBe(false);
      const sub = await viewer.listen({ resourceSubscriptions: ['xinas://events/nfs'] });
      expect(sub.honoredFilter).toEqual({ resourceSubscriptions: ['xinas://events/nfs'] });
      await sub.close();
    } finally {
      await viewer.close();
    }
  });
});
