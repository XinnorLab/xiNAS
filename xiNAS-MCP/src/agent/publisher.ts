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
}

/**
 * Publisher batches ObservationDelta emissions from collectors and
 * POSTs them to /internal/v1/observed over the api's Unix-domain
 * socket. Each flush clears the queue.
 *
 * For retry and pendingReconcile, see F2.
 */
export class Publisher {
  readonly #opts: Required<PublisherOptions>;
  #queue: ObservationDelta[] = [];

  constructor(opts: PublisherOptions) {
    this.#opts = {
      maxBatchSize: 256,
      maxBatchBytes: 1_048_576,
      ...opts,
    };
  }

  /** Add a delta to the pending batch. */
  enqueue(delta: ObservationDelta): void {
    this.#queue.push(delta);
  }

  /**
   * POST the current batch to /internal/v1/observed with no
   * complete_snapshots. Clears the queue on success.
   */
  async flush(): Promise<void> {
    return this.#doFlush([]);
  }

  /**
   * POST the current batch marking the given kinds as complete
   * snapshots so the api can reconcile stale keys.
   */
  async flushWithSnapshot(completeSnapshots: Kind[]): Promise<void> {
    return this.#doFlush(completeSnapshots);
  }

  async #doFlush(completeSnapshots: Kind[]): Promise<void> {
    if (this.#queue.length === 0) return;

    const batch = this.#queue.splice(0);
    const body = JSON.stringify({
      observed_at: new Date().toISOString(),
      controller_id: this.#opts.controllerId,
      deltas: batch,
      complete_snapshots: completeSnapshots,
    });

    await this.#postJson('/internal/v1/observed', body);
  }

  #postJson(path: string, body: string): Promise<void> {
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
          // Drain the response body so the socket stays healthy.
          res.resume();
          res.on('end', () => {
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`POST ${path} returned HTTP ${res.statusCode ?? 'unknown'}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Post a one-shot JSON body to an arbitrary path (used for agent_started). */
  async postOnce(path: string, payload: Record<string, unknown>): Promise<void> {
    await this.#postJson(path, JSON.stringify(payload));
  }
}
