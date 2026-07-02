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
  /**
   * Debounced steady-state flush window in ms (spec §217/§249, ~50–100ms).
   * Every enqueue that does NOT cross a ceiling arms a single timer; the queue
   * flushes ~debounceMs after the FIRST event in the window (leading-arm, not
   * reset-on-each — so a burst batches and a continuous stream can't starve).
   * Without this a single event on a quiet node sits in the queue forever.
   * Default: 75. Set to 0 to disable (used by boot/unit tests that flush
   * explicitly).
   */
  debounceMs?: number;
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
  /** Running serialized-byte estimate of #queue, for the maxBatchBytes cap. */
  #queueBytes = 0;
  /** Armed by enqueue in steady state; fires a debounced flush. */
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * While true (during the boot sweep), enqueue does NOT auto-flush at a
   * ceiling or arm a debounce timer. The boot sequence flushes each kind
   * explicitly with complete_snapshots:[kind]; suppressing the ceiling flush
   * means a kind that exceeds 256/1MB on boot is sent as ONE reconcile batch
   * rather than a partial complete_snapshots:[] flush (which the api would
   * reconcile-delete) followed by the remainder — i.e. no boot data loss.
   */
  #bootMode = false;

  /** Public so collectors can read and tests can inspect. */
  readonly pendingReconcile: Set<Kind> = new Set();

  constructor(opts: PublisherOptions) {
    this.#opts = {
      maxBatchSize: 256,
      maxBatchBytes: 1_048_576,
      retryBaseMs: 250,
      maxRetries: 5,
      debounceMs: 75,
      ...opts,
    };
  }

  enqueue(delta: ObservationDelta): void {
    this.#queue.push(delta);
    this.#queueBytes += Buffer.byteLength(JSON.stringify(delta));
    // During the boot sweep, defer entirely to the explicit per-kind
    // flushWithSnapshot — no ceiling flush, no debounce (see #bootMode).
    if (this.#bootMode) return;
    // Early flush at EITHER ceiling (spec: 256 entries or 1 MB). The
    // .catch keeps this fire-and-forget flush from ever surfacing an
    // unhandled rejection — #doFlush is written to resolve on every
    // error path (5xx/network → pendingReconcile), but this guards a
    // future change that could let it throw (e.g. a circular value).
    if (
      this.#queue.length >= this.#opts.maxBatchSize ||
      this.#queueBytes >= this.#opts.maxBatchBytes
    ) {
      this.#clearDebounce();
      void this.flush().catch(() => {});
      return;
    }
    // Below the ceiling: arm a debounced flush so a single steady-state event
    // doesn't sit in the queue forever on a quiet node.
    this.#armDebounce();
  }

  /** Toggle boot mode (see #bootMode). Turning it off does NOT auto-flush —
   *  the boot sequence has already flushed every kind explicitly. */
  setBootMode(on: boolean): void {
    this.#bootMode = on;
  }

  /** Clear the debounce timer (clean shutdown). Safe to call repeatedly. */
  dispose(): void {
    this.#clearDebounce();
  }

  #armDebounce(): void {
    if (this.#opts.debounceMs <= 0) return;
    if (this.#debounceTimer !== null) return; // leading-arm: don't reset
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.flush().catch(() => {});
    }, this.#opts.debounceMs);
    this.#debounceTimer.unref?.();
  }

  #clearDebounce(): void {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
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
    // We're flushing now — cancel any pending debounce so it doesn't fire a
    // redundant empty flush after the queue is drained below.
    this.#clearDebounce();
    if (this.#queue.length === 0 && completeSnapshots.length === 0) return;

    const batch = this.#queue.splice(0);
    this.#queueBytes = 0;
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

        // 4xx: don't retry — payload is structurally wrong. But DO log it: the
        // observed endpoint fail-closes the whole batch on one bad delta, so a
        // silent 4xx here means an ENTIRE kind vanished from observed state with
        // no trace (this masked a real schema-mismatch bug for the Disk,
        // Filesystem and XiraidArray kinds on real hardware). Never swallow it.
        if (result.status >= 400 && result.status < 500) {
          process.stderr.write(
            `${JSON.stringify({
              time: new Date().toISOString(),
              level: 'error',
              subsystem: 'publisher',
              event: 'observed_post_rejected',
              status: result.status,
              kinds: [...kindsInBatch],
              complete_snapshots: completeSnapshots,
              delta_count: batch.length,
            })}\n`,
          );
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
