import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Collector,
  CollectorRegistry,
  type Kind,
  type ObservationDelta,
} from '../../agent/collectors/base.js';
import { PollDriver } from '../../agent/poll.js';
import { Publisher } from '../../agent/publisher.js';

/**
 * A fake collector whose initialSweep returns a fixed set of deltas and whose
 * pollIntervalMs is tunable so the driver can be exercised in <100ms.
 */
function fakeCollector(
  kind: Kind,
  deltas: ObservationDelta[],
  pollIntervalMs?: number,
): Collector<Kind> {
  return {
    kind,
    async initialSweep() {
      return deltas;
    },
    async start() {
      /* no-op */
    },
    async stop() {
      /* no-op */
    },
    health() {
      return { state: 'running' };
    },
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

describe('PollDriver — steady-state re-sweep + reconcile (review F2/F3/F4)', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let observedPosts: Array<{ deltas: unknown[]; complete_snapshots: string[] }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-poll-test-'));
    socketPath = join(dir, 'api.sock');
    observedPosts = [];
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += String(c);
        });
        req.on('end', () => {
          if (req.url === '/internal/v1/observed') {
            observedPosts.push(JSON.parse(body));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: 1, deleted_by_reconcile: 0, state_revision: 1 }));
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  function makePublisher(): Publisher {
    return new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      debounceMs: 0, // the driver flushes explicitly; isolate from the debounce path
    });
  }

  it('re-sweeps a pollIntervalMs collector and POSTs a reconcile batch on its interval', async () => {
    const pub = makePublisher();
    const registry = new CollectorRegistry();
    registry.register(
      fakeCollector('NfsSession', [{ kind: 'NfsSession', id: 's1', op: 'upsert', value: {} }], 20),
    );
    const driver = new PollDriver({ registry, publisher: pub, backstopMs: 10_000 });
    driver.start();
    await new Promise((r) => setTimeout(r, 80));
    driver.stop();
    pub.dispose();

    expect(observedPosts.length).toBeGreaterThanOrEqual(1);
    // Each tick is a full snapshot → complete_snapshots names the kind.
    expect(observedPosts[0]?.complete_snapshots).toContain('NfsSession');
  });

  it('uses the backstop interval for a collector with no pollIntervalMs', async () => {
    const pub = makePublisher();
    const registry = new CollectorRegistry();
    // No pollIntervalMs → driven by the (overridden) backstop.
    registry.register(fakeCollector('Disk', [{ kind: 'Disk', id: 'd1', op: 'upsert', value: {} }]));
    const driver = new PollDriver({ registry, publisher: pub, backstopMs: 20 });
    driver.start();
    await new Promise((r) => setTimeout(r, 80));
    driver.stop();
    pub.dispose();

    expect(observedPosts.length).toBeGreaterThanOrEqual(1);
    expect(observedPosts[0]?.complete_snapshots).toContain('Disk');
  });

  it('consumes pendingReconcile: a kind marked after a dropped batch clears on the next tick', async () => {
    const pub = makePublisher();
    // Simulate a prior retry-exhaustion having marked NfsSession for reconcile.
    pub.pendingReconcile.add('NfsSession');
    expect(pub.needsReconcile('NfsSession')).toBe(true);

    const registry = new CollectorRegistry();
    registry.register(
      fakeCollector('NfsSession', [{ kind: 'NfsSession', id: 's1', op: 'upsert', value: {} }], 20),
    );
    const driver = new PollDriver({ registry, publisher: pub, backstopMs: 10_000 });
    driver.start();
    await new Promise((r) => setTimeout(r, 80));
    driver.stop();
    pub.dispose();

    // The full re-sweep + flushWithSnapshot reconciled the kind → cleared.
    expect(pub.needsReconcile('NfsSession')).toBe(false);
  });

  it('stop() halts further sweeps', async () => {
    const pub = makePublisher();
    const registry = new CollectorRegistry();
    registry.register(
      fakeCollector('NfsSession', [{ kind: 'NfsSession', id: 's1', op: 'upsert', value: {} }], 20),
    );
    const driver = new PollDriver({ registry, publisher: pub, backstopMs: 10_000 });
    driver.start();
    await new Promise((r) => setTimeout(r, 60));
    driver.stop();
    const countAfterStop = observedPosts.length;
    expect(countAfterStop).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 80));
    pub.dispose();
    // No new posts after stop().
    expect(observedPosts.length).toBe(countAfterStop);
  });
});
