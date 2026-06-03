import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBootSequence } from '../../agent/boot.js';
import {
  type Collector,
  CollectorRegistry,
  type Kind,
  type ObservationDelta,
} from '../../agent/collectors/base.js';
import { Publisher } from '../../agent/publisher.js';

/** A minimal stub collector for testing boot sequence. */
function makeStubCollector(kind: Kind, deltas: ObservationDelta[]): Collector<Kind> {
  return {
    kind,
    async initialSweep() {
      return deltas;
    },
    async start(_emit) {
      /* no-op */
    },
    async stop() {
      /* no-op */
    },
    health() {
      return { state: 'running' };
    },
  };
}

describe('Boot sequence — initial sweep + agent_started', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let requestLog: Array<{ path: string; body: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-boot-test-'));
    socketPath = join(dir, 'api.sock');
    requestLog = [];

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += String(c);
        });
        req.on('end', () => {
          requestLog.push({ path: req.url ?? '/', body: JSON.parse(body || 'null') });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.url === '/internal/v1/observed') {
            res.end(JSON.stringify({ accepted: 1, deleted_by_reconcile: 0, state_revision: 1 }));
          } else {
            res.end('{}');
          }
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('boot: initial sweep per collector → POST /observed with complete_snapshots, then POST /agent_started', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const registry = new CollectorRegistry();
    const diskDelta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    registry.register(makeStubCollector('Disk', [diskDelta]));
    registry.register(makeStubCollector('User', []));

    await runBootSequence({
      publisher: pub,
      registry,
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    // Should have at least one /observed POST (for Disk, which had deltas)
    // and one /agent_started POST.
    const observedPosts = requestLog.filter((r) => r.path === '/internal/v1/observed');
    const startedPosts = requestLog.filter((r) => r.path === '/internal/v1/agent_started');

    expect(observedPosts.length).toBeGreaterThanOrEqual(1);
    expect(startedPosts).toHaveLength(1);

    // The Disk sweep batch must carry complete_snapshots: ['Disk'].
    const diskPost = observedPosts.find((r) => {
      const b = r.body as { complete_snapshots?: string[] };
      return b.complete_snapshots?.includes('Disk');
    });
    expect(diskPost).toBeDefined();

    // /agent_started must carry controller_id.
    const startedBody = startedPosts[0]?.body as { controller_id?: string };
    expect(startedBody.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
  });

  it('agent_started is posted AFTER all initial sweep batches', async () => {
    const callOrder: string[] = [];

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    // Monkey-patch to track call order
    const origFlushWithSnapshot = pub.flushWithSnapshot.bind(pub);
    pub.flushWithSnapshot = async (kinds) => {
      callOrder.push(`flush:${kinds.join(',')}`);
      return origFlushWithSnapshot(kinds);
    };
    const origPostOnce = pub.postOnce.bind(pub);
    pub.postOnce = async (path, body) => {
      callOrder.push(`postOnce:${path}`);
      return origPostOnce(path, body);
    };

    const registry = new CollectorRegistry();
    registry.register(
      makeStubCollector('Disk', [{ kind: 'Disk', id: 'x', op: 'upsert', value: {} }]),
    );

    await runBootSequence({
      publisher: pub,
      registry,
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const agentStartedIdx = callOrder.findIndex((c) => c.includes('/internal/v1/agent_started'));
    const lastFlushIdx = callOrder.filter((c) => c.startsWith('flush:')).length - 1;
    // agent_started must come after the last flush
    expect(agentStartedIdx).toBeGreaterThan(lastFlushIdx);
  });

  it('an empty collector still POSTs a reconcile batch (complete_snapshots, empty deltas)', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const registry = new CollectorRegistry();
    registry.register(makeStubCollector('User', []));

    await runBootSequence({
      publisher: pub,
      registry,
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const observedPosts = requestLog.filter((r) => r.path === '/internal/v1/observed');
    const userReconcile = observedPosts.find((r) => {
      const b = r.body as { complete_snapshots?: string[]; deltas?: unknown[] };
      return b.complete_snapshots?.includes('User');
    });
    expect(userReconcile).toBeDefined();
    const body = userReconcile?.body as { complete_snapshots: string[]; deltas: unknown[] };
    expect(body.complete_snapshots).toEqual(['User']);
    expect(body.deltas).toEqual([]);
  });
});
