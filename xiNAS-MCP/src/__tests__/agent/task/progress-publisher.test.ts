import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgressPublisher } from '../../../agent/task/progress-publisher.js';
import type { TaskProgressEvent } from '../../../agent/task/types.js';

interface Received {
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

describe('createProgressPublisher', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let received: Received[];
  let respondStatus: number;
  let failuresRemaining: number;

  const event: TaskProgressEvent = {
    task_id: 't-1',
    sequence: 1,
    event_type: 'accepted',
    observed_at: '2026-06-05T12:00:00.000Z',
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-prog-test-'));
    socketPath = join(dir, 'api.sock');
    received = [];
    respondStatus = 200;
    failuresRemaining = 0;

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', () => {
          received.push({
            path: req.url ?? '',
            auth: req.headers.authorization,
            contentType: req.headers['content-type'],
            body: JSON.parse(body),
          });
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            res.writeHead(503);
            res.end();
            return;
          }
          res.writeHead(respondStatus);
          res.end(JSON.stringify({ accepted: true }));
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSTs the event to /internal/v1/task_progress with a Bearer token', async () => {
    const publish = createProgressPublisher({
      apiSocketPath: socketPath,
      agentToken: 'agent-tok-xyz',
    });

    await publish(event);

    expect(received).toHaveLength(1);
    const r = received[0] as Received;
    expect(r.path).toBe('/internal/v1/task_progress');
    expect(r.auth).toBe('Bearer agent-tok-xyz');
    expect(r.contentType).toBe('application/json');
    expect(r.body).toMatchObject({ task_id: 't-1', sequence: 1, event_type: 'accepted' });
  });

  it('retries on 5xx then succeeds', async () => {
    failuresRemaining = 2; // first two requests 503, third 200
    const publish = createProgressPublisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      retryBaseMs: 0,
      maxRetries: 5,
    });

    await publish(event);
    expect(received.length).toBe(3);
  });

  it('does not retry on a 4xx', async () => {
    respondStatus = 400;
    const publish = createProgressPublisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      retryBaseMs: 0,
    });

    await publish(event);
    expect(received.length).toBe(1);
  });
});
