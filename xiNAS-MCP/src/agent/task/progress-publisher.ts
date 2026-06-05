/**
 * Task progress publisher (S2 T6, s2-task-envelope-spec §6).
 *
 * POSTs a single {@link TaskProgressEvent} to the api's
 * `/internal/v1/task_progress` over the Unix-domain socket with a Bearer
 * agent-token. Mirrors the observation {@link Publisher}'s retry/backoff, but
 * sends one event per call (no batching) — progress is low-volume and the api
 * dedupes by the event's monotonic `sequence`, so at-least-once delivery is
 * safe.
 *
 * Retry policy: `maxRetries` attempts, exponential backoff from `retryBaseMs`
 * (capped at 30s). 4xx → no retry (structurally wrong). 5xx/network →
 * retry; on exhaustion the publish resolves (the api reconciler is the durable
 * backstop) — it never throws, so a runner emit can't be derailed by transient
 * api unavailability.
 */
import http from 'node:http';
import type { TaskProgressEvent } from './types.js';

export interface ProgressPublisherOptions {
  apiSocketPath: string;
  agentToken: string;
  /** Base backoff ms for the first retry; doubles each attempt, capped 30s. Default: 250. */
  retryBaseMs?: number;
  /** Maximum attempts. Default: 5. */
  maxRetries?: number;
}

interface PostResult {
  status: number;
}

const PATH = '/internal/v1/task_progress';

/**
 * Build a `publish(event)` function that POSTs the event to the api. Returns a
 * Promise that resolves on success, on a 4xx, or after retry exhaustion (it
 * does not reject for transport failures).
 */
export function createProgressPublisher(
  opts: ProgressPublisherOptions,
): (event: TaskProgressEvent) => Promise<void> {
  const apiSocketPath = opts.apiSocketPath;
  const agentToken = opts.agentToken;
  const retryBaseMs = opts.retryBaseMs ?? 250;
  const maxRetries = opts.maxRetries ?? 5;

  return async function publish(event: TaskProgressEvent): Promise<void> {
    const body = JSON.stringify(event);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await postJson(apiSocketPath, agentToken, body);
        if (result.status >= 200 && result.status < 300) return;
        // 4xx: structurally wrong — don't retry.
        if (result.status >= 400 && result.status < 500) return;
        // 5xx: fall through to backoff + retry.
      } catch {
        // Network/transport error — treat like a 5xx and retry.
      }

      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(retryBaseMs * 2 ** attempt, 30_000);
        await sleep(backoffMs);
      }
    }
    // Retry exhaustion: resolve quietly — the api reconciler recovers state.
  };
}

function postJson(socketPath: string, agentToken: string, body: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${agentToken}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
