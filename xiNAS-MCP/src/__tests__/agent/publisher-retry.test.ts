import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../agent/collectors/base.js';
import { Publisher } from '../../agent/publisher.js';

describe('Publisher — retry + pendingReconcile', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let responseQueue: Array<{ status: number; body: string }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-pub-retry-'));
    socketPath = join(dir, 'api.sock');
    responseQueue = [];
    // Use fake timers to control backoff without actually waiting.
    // shouldAdvanceTime keeps real I/O (HTTP) ticking while fake-timer
    // calls (setTimeout inside sleep()) are still under test control.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += String(c);
        });
        req.on('end', () => {
          const r = responseQueue.shift() ?? { status: 200, body: '{"accepted":1}' };
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(r.body);
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries on 5xx up to 5 times then populates pendingReconcile', async () => {
    // Queue 5 server-side 503 responses, then a success.
    // With exhaustion policy: 5 attempts max, so after attempt 5 fails → pendingReconcile.
    for (let i = 0; i < 5; i++) {
      responseQueue.push({ status: 503, body: '{"errors":[{"code":"INTERNAL"}]}' });
    }

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      // In tests we shorten backoff to 0ms so vi.runAllTimersAsync works.
      retryBaseMs: 0,
    });

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);

    // We need to run timers as the retry loop awaits backoff sleeps.
    const flushPromise = pub.flushWithSnapshot(['Disk']);
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(pub.pendingReconcile.has('Disk')).toBe(true);
  });

  it('does not retry on 4xx', async () => {
    responseQueue.push({ status: 400, body: '{"errors":[{"code":"INVALID_ARGUMENT"}]}' });

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      retryBaseMs: 0,
    });

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);
    await pub.flush();

    // 4xx: no pendingReconcile — the payload is structurally wrong; retrying won't help.
    expect(pub.pendingReconcile.size).toBe(0);
    // Only one HTTP hit (no retries).
    expect(responseQueue).toHaveLength(0); // the one queued response was consumed
  });

  it('clears pendingReconcile for a kind on successful flush', async () => {
    // Pre-seed pendingReconcile as if a previous flush exhausted retries.
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      retryBaseMs: 0,
    });
    pub.pendingReconcile.add('Disk');

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);
    // Success response (nothing in responseQueue → default 200)
    await pub.flushWithSnapshot(['Disk']);

    expect(pub.pendingReconcile.has('Disk')).toBe(false);
  });

  it('needsReconcile(kind) returns true when kind is in pendingReconcile', () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });
    expect(pub.needsReconcile('Disk')).toBe(false);
    pub.pendingReconcile.add('Disk');
    expect(pub.needsReconcile('Disk')).toBe(true);
  });
});
