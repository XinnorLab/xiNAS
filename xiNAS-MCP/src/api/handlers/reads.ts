import type { Request, Response } from 'express';
import type { OpenedStateStore, RevisionedValue } from '../../state/index.js';
import { buildEnvelope } from '../envelope.js';

/**
 * Helper that wraps a value (or list) in the standard envelope and
 * sends it. Computes state_revision as the max revision in the
 * payload, or 0 if none.
 */
export function sendOk<T>(req: Request, res: Response, result: T, revisions: number[] = []): void {
  const ctx = req.context!;
  const state_revision = revisions.length === 0 ? 0 : Math.max(...revisions);
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision,
      result,
    }),
  );
}

/** Read all KV entries under a prefix, return as a typed array. */
export function listByPrefix<T>(state: OpenedStateStore, prefix: string): RevisionedValue<T>[] {
  return state.kv.list<T>({ prefix });
}

/** Read a single KV entry; returns null when absent. */
export function getOrNull<T>(state: OpenedStateStore, key: string): RevisionedValue<T> | null {
  return state.kv.get<T>(key);
}

/** Unwrap an array of RevisionedValue to just the values. */
export function unwrapValues<T>(rows: RevisionedValue<T>[]): T[] {
  return rows.map((r) => r.value);
}
