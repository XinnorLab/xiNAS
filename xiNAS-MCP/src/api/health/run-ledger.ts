/**
 * The in-memory run ledger (S19 spec §6.3, D-10; §9.5 `probes_per_run`).
 *
 * `health.context` mints a run: a uuid bound to the principal, the versions
 * the prompt was served with and the limits in force. `health.check`,
 * `health.baseline` (S19c) and `health.probe.run` append the sha256 of
 * their canonical result under a known `run_id`, so `health.report.validate`
 * (S19c) can prove a raw report in the model's output is the one xiNAS
 * produced (AC-19). `startProbe` is the one counter xiNAS enforces itself.
 *
 * Per api process and bounded: entries expire at `expires_at`, are swept
 * lazily on every mint, and past `maxEntries` the oldest live run is
 * evicted. Nothing here is durable — an api restart forgets every run, and
 * the routes accept an unknown id with a `RUN_UNKNOWN` warning rather than
 * failing the run (SAFE-04).
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../../lib/canonical-json.js';
import type { HealthPromptLimits } from '../config.js';

export interface RunVersions {
  prompt: string;
  template_sha256: string;
  policy: string;
  catalog: string;
  report_schema: string;
  server: string;
}

export interface RunReport {
  tool: string;
  args_digest: string;
  report_digest: string;
  collected_at: string;
}

export interface RunEntry {
  run_id: string;
  /** epoch ms */
  issued_at: number;
  /** epoch ms */
  expires_at: number;
  principal: string;
  role: string;
  versions: RunVersions;
  limits: HealthPromptLimits;
  probes_started: number;
  reports: RunReport[];
}

export interface RunLedgerDeps {
  now: () => number;
  ttlMs: number;
  /** Default 256. */
  maxEntries?: number;
}

export const RUN_LEDGER_MAX_ENTRIES = 256;

/** `sha256:<hex>` over the canonical JSON (recursive key sort) of `value`. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export class RunLedger {
  readonly #entries = new Map<string, RunEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(deps: RunLedgerDeps) {
    this.#now = deps.now;
    this.#ttlMs = deps.ttlMs;
    this.#maxEntries = deps.maxEntries ?? RUN_LEDGER_MAX_ENTRIES;
  }

  get size(): number {
    return this.#entries.size;
  }

  mint(input: {
    principal: string;
    role: string;
    versions: RunVersions;
    limits: HealthPromptLimits;
  }): RunEntry {
    this.sweep();
    while (this.#entries.size >= this.#maxEntries) {
      // Map iteration is insertion order and mint is the only insert, so the
      // first key is the oldest live run.
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const now = this.#now();
    const entry: RunEntry = {
      run_id: randomUUID(),
      issued_at: now,
      expires_at: now + this.#ttlMs,
      principal: input.principal,
      role: input.role,
      versions: { ...input.versions },
      limits: { ...input.limits },
      probes_started: 0,
      reports: [],
    };
    this.#entries.set(entry.run_id, entry);
    return entry;
  }

  /** null when unknown or expired (an expired entry is dropped on the spot). */
  get(runId: string): RunEntry | null {
    const entry = this.#entries.get(runId);
    if (entry === undefined) return null;
    if (entry.expires_at <= this.#now()) {
      this.#entries.delete(runId);
      return null;
    }
    return entry;
  }

  /** Append a report digest; false when the run is unknown or expired. */
  record(
    runId: string,
    tool: string,
    args: unknown,
    result: unknown,
    collectedAt: string,
  ): boolean {
    const entry = this.get(runId);
    if (entry === null) return false;
    entry.reports.push({
      tool,
      args_digest: digestOf(args),
      report_digest: digestOf(result),
      collected_at: collectedAt,
    });
    return true;
  }

  /** Count one probe against `max`; the counter moves only on 'ok'. */
  startProbe(runId: string, max: number): 'ok' | 'exhausted' | 'unknown' {
    const entry = this.get(runId);
    if (entry === null) return 'unknown';
    if (entry.probes_started >= max) return 'exhausted';
    entry.probes_started += 1;
    return 'ok';
  }

  /** Drop every expired run; returns how many were dropped. */
  sweep(): number {
    const now = this.#now();
    let dropped = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.expires_at <= now) {
        this.#entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }
}
