// @vitest-environment node
/**
 * Unit tests for the shared e2e polling helper (_helpers.ts).
 *
 * These are FAST (no spawned processes) but live under src/__tests__/e2e/ so
 * they ship with the helper they cover; the e2e config is the only one that
 * includes this directory.
 *
 * They exist because `waitForObservation` was silently wrong for COLLECTION
 * routes: /api/v1/users and /api/v1/disks answer 200 with `result: []` before
 * the agent publishes its first observation, so a helper that treats "200" as
 * "the observation arrived" returns the empty list and the caller asserts
 * against nothing. Measured window on this repo: /users answers 200 from
 * t+9ms but only carries rows at t+842ms — 18ms AFTER the singleton
 * /nfs-idmap starts answering 200, which is what the preceding sequential
 * test waits for. That 18ms is the whole flake.
 */
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectionNotEmpty, waitForAgentReady, waitForObservation } from './_helpers.js';

const TOKEN = 'helper-test-tok';

/** A scripted api stand-in: each GET pops the next canned reply for that path. */
interface Reply {
  status: number;
  body: unknown;
}

let tmpDir: string;
let sockPath: string;
let server: http.Server;
let script: Reply[];
let servedRequests: number;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xinas-helper-'));
  sockPath = join(tmpDir, 'api.sock');
  script = [];
  servedRequests = 0;
  server = http.createServer((req, res) => {
    servedRequests++;
    // Hold the LAST scripted reply once the script runs dry, so a polling
    // helper keeps seeing a stable steady state rather than a 500.
    const reply = script.length > 1 ? script.shift() : script[0];
    if (reply === undefined) throw new Error('scripted server called with an empty script');
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpDir, { recursive: true, force: true });
});

const envelope = (result: unknown): unknown => ({
  request_id: 'r',
  warnings: [],
  errors: [],
  result,
});
const notFound = (): unknown => ({
  request_id: 'r',
  warnings: [],
  errors: [{ code: 'NOT_FOUND', message: 'not yet observed' }],
  result: null,
});

describe('waitForObservation', () => {
  it('keeps polling a collection that answers 200 with an empty result', async () => {
    // The exact production shape: the route is up and answers 200 immediately,
    // but carries no rows until the agent's reconcile batch commits.
    script = [
      { status: 200, body: envelope([]) },
      { status: 200, body: envelope([]) },
      { status: 200, body: envelope([{ spec: { name: 'e2e-alice' } }]) },
    ];

    const res = await waitForObservation(sockPath, TOKEN, '/api/v1/users', {
      ready: collectionNotEmpty,
      timeoutMs: 5_000,
    });

    const rows = res.body.result as Array<{ spec?: { name?: string } }>;
    expect(rows.map((u) => u.spec?.name)).toContain('e2e-alice');
    expect(servedRequests).toBe(3);
  });

  it('returns the first 200 for a singleton, after the NOT_FOUND retries', async () => {
    // Default readiness (no `ready`) must stay exactly as it was: singleton
    // routes 404 NOT_FOUND until observed, so any 200 is the observation.
    script = [
      { status: 404, body: notFound() },
      { status: 200, body: envelope({ status: { domain: 'e2e-test.local' } }) },
    ];

    const res = await waitForObservation(sockPath, TOKEN, '/api/v1/nfs-idmap', {
      timeoutMs: 5_000,
    });

    const status = (res.body.result as { status?: { domain?: string } }).status;
    expect(status?.domain).toBe('e2e-test.local');
    expect(servedRequests).toBe(2);
  });

  it('throws naming the path, timeout and last response when readiness never holds', async () => {
    script = [{ status: 200, body: envelope([]) }];

    await expect(
      waitForObservation(sockPath, TOKEN, '/api/v1/users', {
        ready: collectionNotEmpty,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(
      /Observation at \/api\/v1\/users never arrived within 600ms; last=.*"result":\[\]/,
    );
  });

  it('throws on a non-404 error status rather than polling until timeout', async () => {
    script = [
      {
        status: 500,
        body: { request_id: 'r', warnings: [], errors: [{ code: 'INTERNAL' }], result: null },
      },
    ];

    await expect(
      waitForObservation(sockPath, TOKEN, '/api/v1/users', { timeoutMs: 5_000 }),
    ).rejects.toThrow(/Unexpected response from \/api\/v1\/users/);
  });
});

describe('waitForAgentReady', () => {
  /**
   * The system route always answers 200 — from the moment the api is up, long
   * before the agent process exists. Readiness lives in the payload:
   * `node.status.agent` is the LIVE HeartbeatTracker snapshot, and its `state`
   * stays 'offline' until the api's first `agent.health` tick reaches the
   * agent's UDS socket.
   */
  const system = (agent: unknown, extraNodeStatus: Record<string, unknown> = {}): unknown =>
    envelope({
      cluster: { kind: 'Cluster', id: 'default' },
      node: {
        kind: 'Node',
        id: 'n1',
        status: { ...extraNodeStatus, ...(agent === undefined ? {} : { agent }) },
      },
    });

  it('keeps polling while the tracker reports the agent offline', async () => {
    script = [
      { status: 200, body: system({ state: 'offline' }) },
      { status: 200, body: system({ state: 'offline' }) },
      { status: 200, body: system({ state: 'healthy', version: '3.13.0' }) },
    ];

    await waitForAgentReady(sockPath, TOKEN, { timeoutMs: 5_000 });

    expect(servedRequests).toBe(3);
  });

  it('keeps polling while the agent sub-object is absent entirely', async () => {
    // No tracker snapshot at all: the api is up but has never ticked the agent,
    // so /system omits node.status.agent. Absent is NOT ready.
    script = [
      { status: 200, body: system(undefined) },
      { status: 200, body: system({ state: 'healthy' }) },
    ];

    await waitForAgentReady(sockPath, TOKEN, { timeoutMs: 5_000 });

    expect(servedRequests).toBe(2);
  });

  it('reads the live tracker snapshot, not the stale seeded agent_state field', async () => {
    // The e2e beforeAll seeds the Node row with status.agent_state='offline'
    // and nothing ever rewrites it. A helper that keyed off THAT field would
    // poll until timeout on a perfectly healthy agent.
    script = [{ status: 200, body: system({ state: 'healthy' }, { agent_state: 'offline' }) }];

    await waitForAgentReady(sockPath, TOKEN, { timeoutMs: 5_000 });

    expect(servedRequests).toBe(1);
  });

  it('accepts degraded — the executor is reachable, only the tick is late', async () => {
    script = [{ status: 200, body: system({ state: 'degraded' }) }];

    await waitForAgentReady(sockPath, TOKEN, { timeoutMs: 5_000 });

    expect(servedRequests).toBe(1);
  });

  it('throws naming the condition, the timeout and the caller diagnostics', async () => {
    script = [{ status: 200, body: system({ state: 'offline' }) }];

    await expect(
      waitForAgentReady(sockPath, TOKEN, {
        timeoutMs: 600,
        diagnostics: () => 'agent: fatal: EADDRINUSE',
      }),
    ).rejects.toThrow(
      /xinas-agent never became reachable within 600ms[\s\S]*"state":"offline"[\s\S]*agent: fatal: EADDRINUSE/,
    );
  });
});
