// @vitest-environment node
/**
 * End-to-end (S17 SUBS-TEST-004): the operational event feeds against a
 * REAL xinas-api process + a REAL xinas-agent process over UNIX sockets,
 * the agent in fixture probe mode with the file-backed fake xiRAID
 * transport. Every transition is driven by editing the fixture files the
 * agent's collectors read; every assertion goes through the MCP surface a
 * client uses — `resources/read` for the feeds, `subscriptions/listen`
 * over SSE for wake-ups, and the stdio adapter for the last scenario.
 *
 * Sequence (one describe.sequential; the array `data` carries state
 * across scenarios):
 *   1. baseline: an array already initing at boot → observed_running, and
 *      neither started nor created;
 *   2. the acknowledgment precedes the first update on a listen stream;
 *   3. operation end + a new start are read after the cursor;
 *   4. raid/progress wakes only its own subscriber;
 *   5. completion;
 *   6. close, transition while away, re-listen, catch up by cursor;
 *   7. a broken xiRAID source → system.collector.failed and NO
 *      raid.array.removed; the source restored → system.collector.recovered;
 *   8. nfs-server.service failed/active → nfs.service.unavailable/recovered;
 *   9. an export rule added, changed, removed;
 *  10. capacity warning and its hysteresis clear;
 *  11. the stdio adapter multiplexes two subscriptions without crossing ids.
 *
 * Collector polls are shortened through the XINAS_AGENT_*_POLL_MS knobs
 * (500 ms) and the api coalesces at 50 ms, so each step settles in ~1 s.
 */

import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStateStore } from '../../state/index.js';
import { waitForAgentReady } from './_helpers.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const API_ENTRY = join(PROJECT_ROOT, 'dist/api-server.js');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');
const STDIO_ENTRY = join(PROJECT_ROOT, 'dist/mcp-stdio.js');

const CONTROLLER_ID = '00000000-0000-0000-0000-00000000517e';
const ADMIN_TOKEN = 'e2e-admin-tok';
const AGENT_TOKEN = 'e2e-agent-tok';
const HEARTBEAT_INTERVAL_MS = 300;
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
const SUB_ID = 'io.modelcontextprotocol/subscriptionId';
const feedUri = (feed: string): string => `xinas://events/${feed}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

// ── MCP over the api's UNIX socket ───────────────────────────────────────

type Json = Record<string, unknown>;
let rpcSeq = 0;

function mcpRequest(socketPath: string, method: string, params: Json = {}): Promise<Json> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: `e2e-${++rpcSeq}`,
    method,
    params: { _meta: META, ...params },
  });
  return new Promise((resolveP, reject) => {
    const req = http.request(
      {
        socketPath,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolveP(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface FeedEvent {
  type: string;
  sequence: number;
  subject: { kind: string; id: string };
  details?: Record<string, unknown>;
  reasonCode?: string;
}
interface Envelope {
  events: FeedEvent[];
  headCursor: string;
  nextCursor: string;
  gap: boolean;
}

async function readFeed(socketPath: string, feed: string, query = ''): Promise<Envelope> {
  const r = await mcpRequest(socketPath, 'resources/read', { uri: `${feedUri(feed)}${query}` });
  if (r.error !== undefined) throw new Error(`resources/read failed: ${JSON.stringify(r.error)}`);
  const contents = (r.result as { contents: Array<{ text: string }> }).contents;
  return JSON.parse(contents[0]?.text ?? '{}') as Envelope;
}

/** The feed's newest cursor — the point later reads resume from. */
const mark = async (socketPath: string, feed: string): Promise<string> =>
  (await readFeed(socketPath, feed, '?limit=1')).headCursor;

/** Poll a feed after `after` until an event of `type` shows up. */
async function waitForType(
  socketPath: string,
  feed: string,
  after: string,
  type: string,
  timeoutMs = 10_000,
): Promise<{ event: FeedEvent; all: FeedEvent[] }> {
  const deadline = Date.now() + timeoutMs;
  let all: FeedEvent[] = [];
  while (Date.now() < deadline) {
    all = (await readFeed(socketPath, feed, `?after=${after}&limit=200`)).events;
    const event = all.find((e) => e.type === type);
    if (event !== undefined) return { event, all };
    await sleep(100);
  }
  throw new Error(
    `${feed}: no '${type}' after the cursor within ${timeoutMs}ms; saw ${JSON.stringify(all.map((e) => e.type))}`,
  );
}

// ── subscriptions/listen over SSE ────────────────────────────────────────

interface Subscription {
  id: string;
  messages: Json[];
  ack: Promise<Json>;
  ended: Promise<void>;
  close(): void;
}

const updatesOf = (sub: Subscription): Json[] =>
  sub.messages.filter((m) => m.method === 'notifications/resources/updated');
const updateUri = (m: Json): string => (m.params as { uri: string }).uri;
const subIdOf = (m: Json): unknown =>
  ((m.params as { _meta?: Record<string, unknown> })._meta ?? {})[SUB_ID];

function listen(socketPath: string, id: string, uris: string[]): Promise<Subscription> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'subscriptions/listen',
    params: { _meta: META, notifications: { resourceSubscriptions: uris } },
  });
  return new Promise((resolveP, reject) => {
    const messages: Json[] = [];
    let ackResolve: (m: Json) => void = () => {};
    const ack = new Promise<Json>((r) => {
      ackResolve = r;
    });
    let endResolve: () => void = () => {};
    const ended = new Promise<void>((r) => {
      endResolve = r;
    });
    const req = http.request(
      {
        socketPath,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`listen ${id}: HTTP ${res.statusCode}`));
          return;
        }
        let buffer = '';
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
            if (data.length > 0) {
              const message = JSON.parse(data.join('\n')) as Json;
              messages.push(message);
              if (messages.length === 1) ackResolve(message);
            }
            idx = buffer.indexOf('\n\n');
          }
        });
        res.on('end', endResolve);
        res.on('close', endResolve);
        resolveP({ id, messages, ack, ended, close: () => req.destroy() });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // The client-side destroy() surfaces as a reset; that is the expected close.
      if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) {
        endResolve();
        return;
      }
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────

/** lsblk-shaped fixture: 1 system disk + 4 data disks. */
function disksFixture(): unknown {
  const data = Array.from({ length: 4 }, (_v, i) => ({
    name: `nvme${i + 1}n1`,
    size: 1_920_383_410_176,
    type: 'disk',
    model: 'E2E-NVME',
    serial: `S17${String(i + 1).padStart(4, '0')}`,
    tran: 'nvme',
    mountpoints: [null],
  }));
  return {
    blockdevices: [
      {
        name: 'nvme0n1',
        size: 512_110_190_592,
        type: 'disk',
        model: 'E2E-SYS',
        serial: 'S17SYS01',
        tran: 'nvme',
        mountpoints: [null],
        children: [
          { name: 'nvme0n1p1', size: 536_870_912, type: 'part', mountpoints: ['/boot/efi'] },
          { name: 'nvme0n1p2', size: 511_558_156_288, type: 'part', mountpoints: ['/'] },
        ],
      },
      ...data,
    ],
  };
}

const GIB = 1024 ** 3;

describe.sequential('e2e: S17 operational event feeds (fixture mode + fake xiRAID)', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let apiSockPath: string;
  let apiProc: ChildProcess | undefined;
  let agentProc: ChildProcess | undefined;
  const apiStderr: string[] = [];
  const agentStderr: string[] = [];

  const withAgentStderr = (err: unknown): Error =>
    new Error(
      `${err instanceof Error ? err.message : String(err)}\n--- agent stderr ---\n${agentStderr.join('')}`,
    );

  // Fixture writers — each one is what "the world changed" means to the agent.
  // `devices` uses the real daemon's `[index, path, [states]]` member tuple
  // (lib/parse/raid.ts `readMember`), not a bare path: a bare-string entry
  // parses with no per-member state, which makes every array member's
  // health `unknown` (memberHealth([]) === 'unknown') and no scenario here
  // is about a member, so every member is proven `online`.
  const memberDevices = (): Array<[number, string, string[]]> =>
    ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'].map((path, index) => [
      index,
      path,
      ['online'],
    ]);
  const writeArray = (state: string[], extra: Record<string, unknown> = {}): void =>
    writeFileSync(
      join(fixtureDir, 'xiraid-state.json'),
      JSON.stringify({
        arrays: [
          {
            name: 'data',
            level: '6',
            devices: memberDevices(),
            state,
            ...extra,
          },
        ],
        pools: [],
        import_candidates: [],
        tombstones: [],
      }),
    );
  const writeUnits = (nfsServer: { active_state: string; sub_state: string }): void =>
    writeFileSync(
      join(fixtureDir, 'systemd-units.json'),
      JSON.stringify({
        'nfs-server.service': { load_state: 'loaded', ...nfsServer },
        'nfs-idmapd.service': {
          load_state: 'loaded',
          active_state: 'active',
          sub_state: 'running',
        },
        'nfs-mountd.service': {
          load_state: 'loaded',
          active_state: 'active',
          sub_state: 'running',
        },
      }),
    );
  const writeExports = (rules: Array<{ host_pattern: string; options: string[] }>): void =>
    writeFileSync(
      join(fixtureDir, 'nfs-exports.json'),
      JSON.stringify(rules.map((r) => ({ export_path: '/srv/data', ...r }))),
    );
  const writeFilesystem = (freeGib: number): void =>
    writeFileSync(
      join(fixtureDir, 'filesystems.json'),
      JSON.stringify([
        {
          kind: 'Filesystem',
          id: 'srv-data.mount',
          status: {
            mountpoint: '/srv/data',
            backing_device: '/dev/xi_data',
            mounted: true,
            mount_unit_state: 'active',
            effective_mount_options: ['rw', 'noatime'],
            uuid: '3c1d4e5f-0000-4000-8000-00000000517e',
            size_bytes: 100 * GIB,
            free_bytes: freeGib * GIB,
          },
        },
      ]),
    );

  // Cursors that later scenarios resume from.
  const cursors: Record<string, string> = {};
  let raidSub: Subscription | undefined;
  let progressSub: Subscription | undefined;

  beforeAll(async () => {
    if (!existsSync(API_ENTRY) || !existsSync(AGENT_ENTRY) || !existsSync(STDIO_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-s17-'));
    apiSockPath = join(tmpDir, 'api.sock');
    const agentSockPath = join(tmpDir, 'agent.sock');
    const dbPath = join(tmpDir, 'xinas.db');
    const auditPath = join(tmpDir, 'audit.jsonl');
    const apiConfigPath = join(tmpDir, 'api-config.json');
    const agentConfigPath = join(tmpDir, 'agent-config.json');
    const controllerIdPath = join(tmpDir, 'controller-id');
    const agentTokenPath = join(tmpDir, 'agent-token');
    writeFileSync(controllerIdPath, `${CONTROLLER_ID}\n`);
    writeFileSync(agentTokenPath, `${AGENT_TOKEN}\n`);

    fixtureDir = join(tmpDir, 'fixtures');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'disks.json'), JSON.stringify(disksFixture()));
    writeArray(['online', 'initing'], { init_progress: 5 }); // already running at boot
    writeUnits({ active_state: 'active', sub_state: 'running' });
    writeExports([{ host_pattern: '10.0.0.0/24', options: ['rw'] }]);
    writeFilesystem(50);

    // Fake python3 for the xinas_history bridge (same shim as the other e2e suites).
    const shimBin = join(tmpDir, 'bin');
    mkdirSync(shimBin, { recursive: true });
    const python3Shim = join(shimBin, 'python3');
    writeFileSync(python3Shim, '#!/bin/sh\necho "{\\"id\\": \\"snap-$$\\"}"\nexit 0\n', {
      mode: 0o755,
    });
    chmodSync(python3Shim, 0o755);

    const seedStore = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: CONTROLLER_ID,
    });
    seedStore.kv.put('/xinas/v1/cluster', {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: 'e2e-cluster' },
      status: { mode: 'single_node', capabilities: {}, member_node_ids: [CONTROLLER_ID] },
    });
    seedStore.kv.put(`/xinas/v1/nodes/${CONTROLLER_ID}`, {
      kind: 'Node',
      id: CONTROLLER_ID,
      spec: { hostname: 'e2e-host' },
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });
    await seedStore.close();

    writeFileSync(
      apiConfigPath,
      JSON.stringify({
        controller_id: CONTROLLER_ID,
        listen: { kind: 'unix', socket: apiSockPath },
        tokens: {
          [ADMIN_TOKEN]: { principal: 'admin:e2e', role: 'admin' },
          [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
        },
        state: { databasePath: dbPath, auditJsonlPath: auditPath },
        agent: { socket: agentSockPath, heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS },
        mcp: {
          subscriptions: {
            coalesce_ms: 50,
            keepalive_ms: 1000,
            // Progress buckets are rate-limited to one per 30 s by default;
            // the floor the config accepts is 1 s, and scenario 4 waits it out.
            progress: { min_interval_s: 1 },
          },
        },
      }),
    );
    writeFileSync(
      agentConfigPath,
      JSON.stringify({
        api_socket: apiSockPath,
        agent_socket: agentSockPath,
        controller_id_path: controllerIdPath,
        agent_token_path: agentTokenPath,
        socket_group: 'nogroup',
      }),
    );

    apiProc = spawn(process.execPath, [API_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, XINAS_API_CONFIG: apiConfigPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    apiProc.stderr?.on('data', (c: Buffer) => apiStderr.push(c.toString()));
    const apiDeadline = Date.now() + 8000;
    for (;;) {
      try {
        await mcpRequest(apiSockPath, 'server/discover');
        break;
      } catch {
        if (Date.now() > apiDeadline) {
          throw new Error(`api never came up\n--- api stderr ---\n${apiStderr.join('')}`);
        }
        await sleep(100);
      }
    }
    // Before the agent boots every feed is empty: this is the cursor the
    // baseline assertions read from.
    for (const feed of ['raid', 'raid/progress', 'storage', 'nfs', 'system']) {
      cursors[`boot:${feed}`] = await mark(apiSockPath, feed);
    }

    agentProc = spawn(process.execPath, [AGENT_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH ?? ''}`,
        XINAS_AGENT_CONFIG_PATH: agentConfigPath,
        XINAS_AGENT_PROBE_MODE: `fixture:${fixtureDir}`,
        XINAS_AGENT_XIRAID_POLL_MS: '500',
        XINAS_AGENT_SYSTEMD_POLL_MS: '500',
        XINAS_AGENT_FILESYSTEM_POLL_MS: '500',
        XINAS_AGENT_NFS_POLL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentProc.stderr?.on('data', (c: Buffer) => agentStderr.push(c.toString()));
    try {
      await waitForAgentReady(apiSockPath, ADMIN_TOKEN);
    } catch (err) {
      throw withAgentStderr(err);
    }
  }, 200_000);

  afterAll(async () => {
    raidSub?.close();
    progressSub?.close();
    for (const p of [agentProc, apiProc]) {
      if (p && p.exitCode === null && p.signalCode === null) {
        await new Promise<void>((res) => {
          p.once('exit', () => res());
          p.kill('SIGTERM');
        });
      }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. baseline: an operation already running at boot is observed_running — never started, never created', async () => {
    let found: Awaited<ReturnType<typeof waitForType>>;
    try {
      found = await waitForType(
        apiSockPath,
        'raid',
        cursors['boot:raid'] ?? '',
        'raid.operation.observed_running',
      );
    } catch (err) {
      throw withAgentStderr(err);
    }
    expect(found.event.subject).toEqual({ kind: 'XiraidArray', id: 'data' });
    expect(found.event.details?.kind).toBe('initialization');
    const types = found.all.map((e) => e.type);
    expect(types).not.toContain('raid.operation.started');
    expect(types).not.toContain('raid.array.created');
    cursors.afterBaseline = await mark(apiSockPath, 'raid');
  }, 20_000);

  it('2. a listen stream acknowledges before it delivers; the first update follows the first committed event', async () => {
    raidSub = await listen(apiSockPath, 'sub-raid', [feedUri('raid')]);
    const ack = await raidSub.ack;
    expect(ack.method).toBe('notifications/subscriptions/acknowledged');
    expect(subIdOf(ack)).toBe('sub-raid');
    expect(updatesOf(raidSub)).toHaveLength(0);

    writeArray(['online']); // initialization finished
    await until(() => updatesOf(raidSub as Subscription).length >= 1, 'the raid update');
    expect(raidSub.messages[0]).toBe(ack);
    const update = updatesOf(raidSub)[0] as Json;
    expect(updateUri(update)).toBe(feedUri('raid'));
    expect(subIdOf(update)).toBe('sub-raid');
  }, 20_000);

  it('3. the completion and a fresh start are read after the cursor, in order', async () => {
    const completed = await waitForType(
      apiSockPath,
      'raid',
      cursors.afterBaseline ?? '',
      'raid.operation.completed',
    );
    expect(completed.event.details?.finalStates).toEqual(['online']);
    cursors.beforeRestart = await mark(apiSockPath, 'raid');

    writeArray(['online', 'initing'], { init_progress: 5 });
    const started = await waitForType(
      apiSockPath,
      'raid',
      cursors.beforeRestart,
      'raid.operation.started',
    );
    expect(started.event.details?.generation).toBe(2);
    expect(started.all.map((e) => e.type)).toEqual(['raid.operation.started']);
    cursors.afterRestart = await mark(apiSockPath, 'raid');
  }, 20_000);

  it('4. progress wakes the raid/progress subscriber and leaves the raid subscriber alone', async () => {
    progressSub = await listen(apiSockPath, 'sub-progress', [feedUri('raid/progress')]);
    await progressSub.ack;
    // The raid stream owes two updates so far (completion, restart); the
    // second can still be in flight when scenario 3 returns — a feed read
    // sees the journal row before the coalesced notification is written.
    await until(
      () => updatesOf(raidSub as Subscription).length >= 2,
      'the raid update for the restart',
    );
    const raidUpdatesBefore = updatesOf(raidSub as Subscription).length;
    const progressMark = await mark(apiSockPath, 'raid/progress');

    await sleep(1100); // the 1 s minimum interval since the start was recorded
    writeArray(['online', 'initing'], { init_progress: 35 }); // crosses the 30 % bucket
    await until(() => updatesOf(progressSub as Subscription).length >= 1, 'the progress update');
    const progress = await waitForType(
      apiSockPath,
      'raid/progress',
      progressMark,
      'raid.operation.progress',
    );
    expect(progress.event.details?.kind).toBe('initialization');
    await sleep(600); // a full poll cycle: nothing else must arrive on the raid stream
    expect(updatesOf(raidSub as Subscription)).toHaveLength(raidUpdatesBefore);
    expect(updatesOf(progressSub).every((u) => subIdOf(u) === 'sub-progress')).toBe(true);
  }, 20_000);

  it('5. the operation completes into an initialized array', async () => {
    writeArray(['online', 'initialized']);
    const completed = await waitForType(
      apiSockPath,
      'raid',
      cursors.afterRestart ?? '',
      'raid.operation.completed',
    );
    expect(completed.event.details?.generation).toBe(2);
    expect(completed.event.details?.finalStates).toEqual(['online', 'initialized']);
    cursors.afterCompletion = await mark(apiSockPath, 'raid');
  }, 20_000);

  it('6. a transition while nobody listens is recovered by cursor after re-listening', async () => {
    (raidSub as Subscription).close();
    await (raidSub as Subscription).ended;
    raidSub = undefined;

    writeArray(['degraded']);
    // Give the transition time to land while the subscription is closed.
    await waitForType(apiSockPath, 'raid', cursors.afterCompletion ?? '', 'raid.state.degraded');

    raidSub = await listen(apiSockPath, 'sub-raid-2', [feedUri('raid')]);
    await raidSub.ack;
    const missed = await readFeed(apiSockPath, 'raid', `?after=${cursors.afterCompletion}`);
    expect(missed.gap).toBe(false);
    expect(missed.events.map((e) => e.type)).toEqual(['raid.state.degraded']);
    cursors.afterDegraded = missed.nextCursor;
  }, 20_000);

  it('7. a broken xiRAID source reports a failed collector — the array is never reported removed — and recovers with the source', async () => {
    const systemMark = await mark(apiSockPath, 'system');
    writeFileSync(join(fixtureDir, 'xiraid-state.json'), 'this is not json {');

    const failed = await waitForType(
      apiSockPath,
      'system',
      systemMark,
      'system.collector.failed',
      15_000,
    );
    expect(
      failed.all.some(
        (e) => e.type === 'system.collector.failed' && e.subject.id === 'XiraidArray',
      ),
    ).toBe(true);
    const raidSince = await readFeed(apiSockPath, 'raid', `?after=${cursors.afterDegraded}`);
    expect(raidSince.events.map((e) => e.type)).not.toContain('raid.array.removed');

    const recoverMark = await mark(apiSockPath, 'system');
    writeArray(['degraded']);
    const recovered = await waitForType(
      apiSockPath,
      'system',
      recoverMark,
      'system.collector.recovered',
      15_000,
    );
    expect(
      recovered.all.some(
        (e) => e.type === 'system.collector.recovered' && e.subject.id === 'XiraidArray',
      ),
    ).toBe(true);
    // Still no removal, and no spurious re-creation either.
    const raidAfter = await readFeed(apiSockPath, 'raid', `?after=${cursors.afterDegraded}`);
    expect(raidAfter.events.map((e) => e.type)).toEqual([]);
  }, 40_000);

  it('8. nfs-server.service failing and returning is reported on the nfs feed', async () => {
    const nfsMark = await mark(apiSockPath, 'nfs');
    writeUnits({ active_state: 'failed', sub_state: 'failed' });
    const down = await waitForType(apiSockPath, 'nfs', nfsMark, 'nfs.service.unavailable');
    expect(down.event.subject).toEqual({ kind: 'SystemdUnit', id: 'nfs-server.service' });
    expect(down.event.reasonCode).toBe('unit_failed');

    const upMark = await mark(apiSockPath, 'nfs');
    writeUnits({ active_state: 'active', sub_state: 'running' });
    const up = await waitForType(apiSockPath, 'nfs', upMark, 'nfs.service.recovered');
    expect(up.event.subject.id).toBe('nfs-server.service');
  }, 20_000);

  it('9. an export rule added, changed and removed produces the three export events', async () => {
    const m1 = await mark(apiSockPath, 'nfs');
    writeExports([
      { host_pattern: '10.0.0.0/24', options: ['rw'] },
      { host_pattern: '10.0.1.0/24', options: ['ro'] },
    ]);
    const added = await waitForType(apiSockPath, 'nfs', m1, 'nfs.export.added');
    expect(added.event.details?.hostPattern).toBe('10.0.1.0/24');
    expect(added.event.details?.exportPath).toBe('/srv/data');

    const m2 = await mark(apiSockPath, 'nfs');
    writeExports([
      { host_pattern: '10.0.0.0/24', options: ['rw'] },
      { host_pattern: '10.0.1.0/24', options: ['rw', 'no_root_squash'] },
    ]);
    const changed = await waitForType(apiSockPath, 'nfs', m2, 'nfs.export.changed');
    expect(changed.event.details?.hostPattern).toBe('10.0.1.0/24');

    const m3 = await mark(apiSockPath, 'nfs');
    writeExports([{ host_pattern: '10.0.0.0/24', options: ['rw'] }]);
    const removed = await waitForType(apiSockPath, 'nfs', m3, 'nfs.export.removed');
    expect(removed.event.details?.hostPattern).toBe('10.0.1.0/24');
    expect(removed.all.map((e) => e.type)).toEqual(['nfs.export.removed']);
  }, 30_000);

  it('10. capacity crossing 80 % warns; clearing needs the hysteresis band below 75 %', async () => {
    const m1 = await mark(apiSockPath, 'storage');
    writeFilesystem(15); // 85 % used
    const warning = await waitForType(apiSockPath, 'storage', m1, 'filesystem.capacity.warning');
    expect(warning.event.subject).toEqual({ kind: 'Filesystem', id: 'srv-data.mount' });

    const m2 = await mark(apiSockPath, 'storage');
    writeFilesystem(22); // 78 % used: inside the band, nothing clears
    await sleep(1200);
    expect((await readFeed(apiSockPath, 'storage', `?after=${m2}`)).events).toEqual([]);

    writeFilesystem(30); // 70 % used: below the clear threshold
    const cleared = await waitForType(apiSockPath, 'storage', m2, 'filesystem.capacity.cleared');
    expect(cleared.all.map((e) => e.type)).toEqual(['filesystem.capacity.cleared']);
  }, 30_000);

  it('11. the stdio adapter multiplexes two subscriptions with distinct ids and no crossing', async () => {
    const child = spawn(process.execPath, [STDIO_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, XINAS_API_SOCKET: apiSockPath, XINAS_MCP_TOKEN: ADMIN_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: Json[] = [];
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line !== '') lines.push(JSON.parse(line) as Json);
        idx = buffer.indexOf('\n');
      }
    });
    const stderr: string[] = [];
    child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString()));
    const send = (message: Json): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };
    const acks = () => lines.filter((l) => l.method === 'notifications/subscriptions/acknowledged');
    const updates = () => lines.filter((l) => l.method === 'notifications/resources/updated');

    try {
      send({
        jsonrpc: '2.0',
        id: 'L1',
        method: 'subscriptions/listen',
        params: { _meta: META, notifications: { resourceSubscriptions: [feedUri('raid')] } },
      });
      send({
        jsonrpc: '2.0',
        id: 'L2',
        method: 'subscriptions/listen',
        params: { _meta: META, notifications: { resourceSubscriptions: [feedUri('nfs')] } },
      });
      await until(() => acks().length >= 2, `two acknowledgments (stderr: ${stderr.join('')})`);
      expect(acks().map(subIdOf).sort()).toEqual(['L1', 'L2']);

      // A plain request still answers on the serial chain while both streams are open.
      send({ jsonrpc: '2.0', id: 'ping', method: 'resources/list', params: { _meta: META } });
      await until(() => lines.some((l) => l.id === 'ping'), 'the resources/list reply');

      writeArray(['online']); // degraded → recovered: a raid-feed event
      await until(() => updates().length >= 1, 'the raid update on stdout');
      await sleep(600);
      for (const u of updates()) {
        expect(updateUri(u)).toBe(feedUri('raid'));
        expect(subIdOf(u)).toBe('L1');
      }
      const recovered = await waitForType(
        apiSockPath,
        'raid',
        cursors.afterDegraded ?? '',
        'raid.state.recovered',
      );
      expect(recovered.event.subject.id).toBe('data');
    } finally {
      child.stdin?.end();
      if (child.exitCode === null) {
        await new Promise<void>((res) => {
          child.once('exit', () => res());
          child.kill('SIGTERM');
        });
      }
    }
  }, 30_000);
});
