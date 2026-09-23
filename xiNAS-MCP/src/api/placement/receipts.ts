/**
 * S20 §5.2: the api's own receipt clock for observed rows.
 *
 * `evidence_age_ms` must count the transfer delay against freshness, never
 * for it (CON-10), so the age of a placement resource is measured from the
 * moment THIS api process stored the push — on its own monotonic clock —
 * plus the transfer delay the ingest measured (its wall clock at receipt
 * minus the row's `generated_at`; agent and api share the node's clock)
 * plus the agent-reported intra-cycle offset. The map is in-memory on
 * purpose: after an api restart there is no receipt for the row on disk,
 * and the route answers 503 SOURCE_NOT_READY until the agent pushes again.
 */

export interface Receipt {
  /** KV revision the receipt belongs to; a mismatch means a stale receipt. */
  revision: number;
  /** `performance.now()` at the moment the push was stored. */
  received_mono_ms: number;
  /** Wall clock (epoch ms) at the moment the push was stored (F-13 reconciliation). */
  received_at_ms: number;
  /**
   * How old the row already was when it arrived (receipt wall clock −
   * `generated_at`), clamped at 0. `null` when the row carried no parsable
   * `generated_at` — the route then refuses to serve it (SOURCE_NOT_READY).
   */
  transfer_delay_ms: number | null;
}

export class ObservedReceipts {
  readonly #map = new Map<string, Receipt>();
  readonly #now: () => number;
  readonly #wall: () => number;

  constructor(now: () => number = () => performance.now(), wall: () => number = () => Date.now()) {
    this.#now = now;
    this.#wall = wall;
  }

  /** Called by the observed ingest after the transaction committed. */
  record(kind: string, id: string, revision: number, transferDelayMs: number | null = 0): void {
    this.#map.set(`${kind}/${id}`, {
      revision,
      received_mono_ms: this.#now(),
      received_at_ms: this.#wall(),
      transfer_delay_ms: transferDelayMs,
    });
  }

  lookup(kind: string, id: string): Receipt | undefined {
    return this.#map.get(`${kind}/${id}`);
  }

  /** The same clock the receipts were stamped with. */
  now(): number {
    return this.#now();
  }

  /** The same wall clock the receipts were stamped with. */
  wall(): number {
    return this.#wall();
  }
}

/**
 * The transfer delay of a placement row: receipt wall clock minus the row's
 * `generated_at`. Agent and api run on the same node, so the clocks agree;
 * a negative value (clock step) clamps to 0, an unparsable stamp is null.
 */
export function transferDelayMs(generatedAt: unknown, wallNowMs: number): number | null {
  if (typeof generatedAt !== 'string') return null;
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round(wallNowMs - t));
}
