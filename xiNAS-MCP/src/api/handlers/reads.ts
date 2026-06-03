import type { Request, Response } from 'express';
import type { OpenedStateStore, RevisionedValue } from '../../state/index.js';
import { buildEnvelope } from '../envelope.js';
import type { Warning } from '../envelope.js';
import { mergeWarnings } from './merge-warnings.js';

/**
 * Helper that wraps a value (or list) in the standard envelope and
 * sends it. Computes state_revision as the max revision in the
 * payload, or 0 if none.
 */
export function sendOk<T>(
  req: Request,
  res: Response,
  result: T,
  revisions: number[] = [],
  warnings: Warning[] = [],
): void {
  const ctx = req.context!;
  const state_revision = revisions.length === 0 ? 0 : Math.max(...revisions);
  const allWarnings = mergeWarnings(warnings, ctx.system_warnings ?? []);
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision,
      warnings: allWarnings,
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

/** Unwrap an array of RevisionedValue to just the values (raw — no metadata).
 *  Use for non-resource records (events, audit) that have no Metadata schema. */
export function unwrapValues<T>(rows: RevisionedValue<T>[]): T[] {
  return rows.map((r) => r.value);
}

/**
 * Synthesize the api-v1.yaml `metadata` object from a RevisionedValue's row
 * tracking and embed it into the value. The KV layer tracks revision +
 * created_at/modified_at + owner/source/validation_status PER ROW, not inside
 * the stored value — so a public resource read that returns the raw value omits
 * the schema-required `metadata`. Every resource schema ($ref Metadata, required)
 * needs this projection at read time. Non-object values are returned unchanged.
 */
export function embedMetadata<T>(row: RevisionedValue<T>): T {
  const value = row.value;
  if (value === null || typeof value !== 'object') return value;
  return {
    ...(value as Record<string, unknown>),
    metadata: {
      revision: row.revision,
      created_at: new Date(row.created_at).toISOString(),
      modified_at: new Date(row.modified_at).toISOString(),
      owner: row.owner,
      source: row.source,
      validation_status: row.validation_status,
    },
  } as T;
}

/** Like unwrapValues, but embeds the synthesized metadata into each resource. */
export function unwrapResources<T>(rows: RevisionedValue<T>[]): T[] {
  return rows.map(embedMetadata);
}
