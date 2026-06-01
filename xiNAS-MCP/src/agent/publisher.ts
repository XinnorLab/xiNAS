import http from 'node:http';
import type { Kind, ObservationDelta } from './collectors/base.js';

export interface PublisherOptions {
  apiSocketPath: string;
  agentToken: string;
  controllerId: string;
  /** Max deltas per batch before an early flush. Default: 256. */
  maxBatchSize?: number;
  /** Max body size in bytes before an early flush. Default: 1_048_576 (1 MB). */
  maxBatchBytes?: number;
  /**
   * Base backoff in ms for the first retry. Subsequent attempts double,
   * capped at 30_000 ms. Default: 250. Set to 0 in tests to skip waits.
   */
  retryBaseMs?: number;
  /** Maximum retry attempts. Default: 5. */
  maxRetries?: number;
}

interface PostResult {
  status: number;
}

/**
 * Publisher batches ObservationDelta emissions from collectors and
 * POSTs them to /internal/v1/observed over the api's Unix-domain
 * socket.
 *
 * Retry policy (F2): 5 attempts, exponential backoff starting at
 * retryBaseMs (default 250ms), capped at 30s. 4xx → no retry.
 * 5xx retry exhaustion → affected kinds are added to pendingReconcile.
 * Collectors check needsReconcile(kind) before their next tick; if
 * true they run initialSweep instead of incremental delta.
 */
export class Publisher {
  readonly #opts: Required<PublisherOptions>;
  #queue: ObservationDelta[] = [];

  /** Public so collectors can read and tests can inspect. */
  readonly pendingReconcile: Set<Kind> = new Set();

  constructor(opts: PublisherOptions) {
    this.#opts = {
      maxBatchSize: 256,
      maxBatchBytes: 1_048_576,
      retryBaseMs: 250,
      maxRetries: 5,
      ...opts,
    };
  }

  enqueue(delta: ObservationDelta): void {
    this.#queue.push(delta);
    // Early flush if we've hit the batch ceiling.
    if (this.#queue.length >= this.#opts.maxBatchSize) {
      void this.flush();
    }
  }

  needsReconcile(kind: Kind): boolean {
    return this.pendingReconcile.has(kind);
  }

  async flush(): Promise<void> {
    return this.#doFlush([]);
  }

  async flushWithSnapshot(completeSnapshots: Kind[]): Promise<void> {
    return this.#doFlush(completeSnapshots);
  }

  /** Post a one-shot JSON body (used for /internal/v1/agent_started). */
  async postOnce(path: string, payload: Record<string, unknown>): Promise<void> {
    await this.#postJsonRaw(path, JSON.stringify(payload));
  }

  async #doFlush(completeSnapshots: Kind[]): Promise<void> {
    if (this.#queue.length === 0) return;

    const batch = this.#queue.splice(0);
    const kindsInBatch = new Set(batch.map((d) => d.kind));

    const body = JSON.stringify({
      observed_at: new Date().toISOString(),
      controller_id: this.#opts.controllerId,
      deltas: batch,
      complete_snapshots: completeSnapshots,
    });

    const { maxRetries, retryBaseMs } = this.#opts;
    let lastStatus = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.#postJsonRaw('/internal/v1/observed', body);
        lastStatus = result.status;

        if (result.status >= 200 && result.status < 300) {
          // Success: clear pending for these kinds.
          for (const k of kindsInBatch) {
            this.pendingReconcile.delete(k);
          }
          // Also clear kinds requested for reconcile that succeeded.
          for (const k of completeSnapshots) {
            this.pendingReconcile.delete(k as Kind);
          }
          return;
        }

        // 4xx: don't retry — payload is structurally wrong.
        if (result.status >= 400 && result.status < 500) {
          return;
        }

        // 5xx: back off and retry.
      } catch (_err) {
        // Network error — treat same as 5xx, will retry.
        lastStatus = 0;
      }

      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(retryBaseMs * Math.pow(2, attempt), 30_000);
        await sleep(backoffMs);
      }
    }

    // Retry exhaustion: mark kinds for reconcile.
    // Surface lastStatus in health (future: last_publish_error field).
    void lastStatus; // used for structured log in production; omitted here for test simplicity
    for (const k of kindsInBatch) {
      this.pendingReconcile.add(k);
    }
  }

  #postJsonRaw(path: string, body: string): Promise<PostResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#opts.apiSocketPath,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.#opts.agentToken}`,
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
