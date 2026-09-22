/**
 * S20 §5.2: the api's own receipt clock for observed rows.
 *
 * `evidence_age_ms` must count the transfer delay against freshness, never
 * for it (CON-10), so the age of a placement resource is measured from the
 * moment THIS api process stored the push — on its own monotonic clock —
 * plus the agent-reported intra-cycle offset. The map is in-memory on
 * purpose: after an api restart there is no receipt for the row on disk,
 * and the route answers 503 SOURCE_NOT_READY until the agent pushes again.
 */

export interface Receipt {
  /** KV revision the receipt belongs to; a mismatch means a stale receipt. */
  revision: number;
  /** `performance.now()` at the moment the push was stored. */
  received_mono_ms: number;
}

export class ObservedReceipts {
  readonly #map = new Map<string, Receipt>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** Called by the observed ingest after the transaction committed. */
  record(kind: string, id: string, revision: number): void {
    this.#map.set(`${kind}/${id}`, { revision, received_mono_ms: this.#now() });
  }

  lookup(kind: string, id: string): Receipt | undefined {
    return this.#map.get(`${kind}/${id}`);
  }

  /** The same clock the receipts were stamped with. */
  now(): number {
    return this.#now();
  }
}
