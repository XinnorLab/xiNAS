import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObservationDelta } from '../../agent/collectors/base.js';
import { Publisher } from '../../agent/publisher.js';

describe('Publisher — core enqueue + flush', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let receivedBodies: unknown[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-pub-test-'));
    socketPath = join(dir, 'api.sock');
    receivedBodies = [];

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', () => {
          receivedBodies.push(JSON.parse(body));
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

  it('enqueues deltas and flush POSTs them to /internal/v1/observed', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const delta: ObservationDelta = {
      kind: 'Disk',
      id: 'nvme0n1',
      op: 'upsert',
      value: { name: 'nvme0n1' },
    };

    pub.enqueue(delta);
    await pub.flush();

    expect(receivedBodies).toHaveLength(1);
    const body = receivedBodies[0] as {
      observed_at: string;
      controller_id: string;
      deltas: ObservationDelta[];
      complete_snapshots: string[];
    };
    expect(body.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(body.deltas).toHaveLength(1);
    expect(body.deltas[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'upsert' });
    expect(body.complete_snapshots).toEqual([]);
    expect(typeof body.observed_at).toBe('string');
  });

  it('flush with no enqueued deltas sends nothing', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });
    await pub.flush();
    expect(receivedBodies).toHaveLength(0);
  });

  it('passes complete_snapshots when flushWithSnapshot is called', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const delta: ObservationDelta = {
      kind: 'Disk',
      id: 'nvme0n1',
      op: 'upsert',
      value: { name: 'nvme0n1' },
    };

    pub.enqueue(delta);
    await pub.flushWithSnapshot(['Disk']);

    const body = receivedBodies[0] as { complete_snapshots: string[] };
    expect(body.complete_snapshots).toEqual(['Disk']);
  });

  it('early-flushes when the batch byte ceiling is crossed (not just the count)', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      maxBatchSize: 10_000, // high, so the entry-count ceiling never fires
      maxBatchBytes: 300, // low, so the byte ceiling fires first
    });

    // Each delta serializes to well over 100 bytes; a few cross 300 and
    // trigger the fire-and-forget early flush inside enqueue().
    for (let i = 0; i < 4; i++) {
      pub.enqueue({
        kind: 'Disk',
        id: `nvme${i}n1`,
        op: 'upsert',
        value: { padding: 'x'.repeat(80) },
      });
    }

    // Let the fire-and-forget early flush land on the UDS server.
    await new Promise((r) => setTimeout(r, 100));
    expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
    expect((receivedBodies[0] as { deltas: unknown[] }).deltas.length).toBeGreaterThan(0);
  });
});
