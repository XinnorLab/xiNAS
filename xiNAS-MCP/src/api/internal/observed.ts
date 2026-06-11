import type { NextFunction, Request, Response } from 'express';
import type { Kind } from '../../agent/collectors/base.js';
import { observedSegment } from '../../agent/collectors/base.js';
import { canonicalize } from '../../lib/canonical-json.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';

/**
 * Strip the sweep-churning observed_at stamps (top-level for singleton
 * shapes like inventory, and status.observed_at for resource shapes)
 * before the unchanged-value compare. Shallow clones only — the compare
 * runs through canonicalize (JSON.stringify), which drops `undefined`.
 */
function stripObservedAt(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = { ...(value as Record<string, unknown>) };
  if ('observed_at' in v) v.observed_at = undefined;
  if (typeof v.status === 'object' && v.status !== null) {
    v.status = { ...(v.status as Record<string, unknown>), observed_at: undefined };
  }
  return v;
}

interface ObservationDeltaBody {
  kind: Kind;
  id: string;
  op: 'upsert' | 'delete';
  value?: Record<string, unknown>;
}

interface ObservedBody {
  observed_at: string;
  controller_id: string;
  deltas: ObservationDeltaBody[];
  complete_snapshots: Kind[];
}

/**
 * Validates an observed-delta id before it is embedded in a KV key.
 *
 * Rejects ids that could produce path-traversal-looking or malformed keys:
 *   - empty string or whitespace-only
 *   - any control character (charCode < 0x20 or === 0x7f)
 *   - a `.` or `..` path segment (split on `/`)
 *   - trailing `/`, or consecutive `//` (empty segment)
 *
 * Allows `/` and `:` within the id, INCLUDING one leading `/` — legitimate
 * ids are absolute paths (ExportRule ids ARE export paths like
 * `/mnt/share/proj`, per the NfsCollector's documented key design) and
 * NfsSession ids like `10.1.2.3:/srv/share01`. A leading slash yields a
 * `//` inside the KV key, which every consumer tolerates: writes construct
 * the key from the id, reads list by prefix (never reconstruct), and the
 * complete-snapshot reconcile compares keys built the same way. (S5 T12
 * fix: the old leading-`/` rejection bounced the WHOLE observation batch
 * the moment any export existed, contradicting this comment's own claim.)
 *
 * Full inbound-delta schema validation (kind + value shape) is wired in
 * Phase J (J3). Until then this id-shape check is the sole inbound key
 * guard running on every write, schema-validation is conditional on
 * ctx.observedSchemas being present (see loop below).
 */
export function isValidObservedId(id: string): boolean {
  if (id.trim().length === 0) return false;
  // one leading '/' is legitimate (absolute-path ids); strip it, then any
  // remaining leading '/' (i.e. '//...') or trailing '/' or interior '//'
  // is malformed.
  const body = id.startsWith('/') ? id.slice(1) : id;
  if (body.length === 0) return false;
  if (body.startsWith('/') || body.endsWith('/') || body.includes('//')) return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  for (const segment of body.split('/')) {
    if (segment === '..' || segment === '.') return false;
  }
  return true;
}

/**
 * POST /internal/v1/observed — the xinas-agent's exclusive write path
 * for observed state (spec §"Flow A"). Gated by requireInternalAgent
 * on the parent sub-router (H2).
 *
 * Validates the request's controller_id matches the api's. Then opens a
 * single KvTransaction that (1) applies every delta (upsert → tx.put,
 * delete → tx.delete) and (2) for each kind in complete_snapshots,
 * enumerates the current keys under that kind's prefix and deletes any
 * not present in the batch's upserts (reconcile). Applies and reconcile
 * deletes commit atomically. Finally notifies the heartbeat tracker that
 * an observation push happened (does NOT update heartbeat state).
 */
export function observedHandler(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as ObservedBody;

      // Validate controller_id match.
      if (body.controller_id !== ctx.config.controller_id) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `controller_id mismatch: request has '${body.controller_id}', ` +
            `api is configured with '${ctx.config.controller_id}'`,
        );
      }

      const deltas = body.deltas ?? [];
      const completeSnapshots: Kind[] = body.complete_snapshots ?? [];

      // Per-delta schema validation BEFORE the transaction (fail-closed),
      // but only when validators are wired into the context. Each upsert
      // delta's `value` is validated against its kind's JSON Schema (the
      // api-v1.yaml component schemas Phase G adds, compiled once at startup
      // and keyed by kind). On the first failure, reject the WHOLE batch —
      // nothing is written — with INVALID_ARGUMENT naming the failing delta's
      // index + the Ajv error, so a malformed agent push can never poison
      // observed state. Delete deltas carry no value and skip schema
      // validation (only their key shape matters). This is the safety net
      // that also catches a delta with an unknown/mis-cased kind (no schema →
      // reject). When ctx.observedSchemas is absent (the H3 unit context, and
      // until H6/J3 wire it), the loop is skipped entirely.
      if (ctx.observedSchemas) {
        for (let i = 0; i < deltas.length; i++) {
          const delta = deltas[i]!;
          if (delta.op !== 'upsert') continue;
          const validate = ctx.observedSchemas[delta.kind];
          if (!validate) {
            throw new ApiException('INVALID_ARGUMENT', `delta[${i}]: unknown kind '${delta.kind}'`);
          }
          if (!validate(delta.value)) {
            throw new ApiException(
              'INVALID_ARGUMENT',
              `delta[${i}] (kind=${delta.kind}, id=${delta.id}) failed schema: ` +
                `${ctx.ajv?.errorsText(validate.errors) ?? 'invalid'}`,
            );
          }
        }
      }

      // Id-shape check BEFORE the transaction — reject any delta whose id could
      // produce a path-traversal-looking or malformed KV key. This applies to
      // both upsert and delete deltas since both construct a key from the id.
      for (let i = 0; i < deltas.length; i++) {
        const delta = deltas[i]!;
        if (!isValidObservedId(delta.id)) {
          throw new ApiException('INVALID_ARGUMENT', `delta[${i}]: invalid id '${delta.id}'`);
        }
      }

      let accepted = 0;
      let deletedByReconcile = 0;
      let skippedUnchanged = 0;
      const revisions: number[] = [];

      // Derive the KV path segment through observedSegment(kind) (base.ts) so
      // writer and reader never disagree on singletons (NfsIdmap → nfs_idmap,
      // inventory/managed_files stay lowercase). H3 stays kind-agnostic; no
      // per-kind special-casing (the ExportRule→Share fold-in is a read-time
      // join in I6, not a write-time merge here).
      ctx.state.kv.transaction((tx) => {
        // 1. Apply all deltas — SKIPPING upserts whose value is unchanged
        //    apart from the observed_at stamp. PollDriver full-sweeps every
        //    collector on its interval and collectors re-stamp observed_at
        //    each sweep; without this dedupe every sweep bumped every
        //    observed revision, so revision-pinned freshness (the S4/S5
        //    route bindings, observed_freshness_ref) only held for one
        //    sweep window (~30 s) on live hosts — any human pause between
        //    plan and apply produced a spurious 412. With the dedupe,
        //    observed revisions move only when CONTENT changes, which is
        //    exactly what the freshness pins mean to detect. The stored
        //    observed_at consequently records when the current content was
        //    last WRITTEN, not the latest sweep; system-level liveness is
        //    the heartbeat tracker's job (recordObservationPush below fires
        //    on every push regardless).
        for (const delta of deltas) {
          const key = `/xinas/v1/observed/${observedSegment(delta.kind)}/${delta.id}`;
          if (delta.op === 'upsert') {
            const value = delta.value ?? {};
            const current = tx.get(key);
            if (
              current !== null &&
              canonicalize(stripObservedAt(current.value)) ===
                canonicalize(stripObservedAt(value))
            ) {
              skippedUnchanged++;
              revisions.push(current.revision);
              continue;
            }
            const result = tx.put(key, value);
            // No expected_revision → put always commits (ok: true). Guard
            // anyway so a future CAS variant can't silently push undefined.
            if (result.ok) revisions.push(result.value.revision);
            accepted++;
          } else if (delta.op === 'delete') {
            tx.delete(key);
            accepted++;
          }
        }

        // 2. Reconcile complete snapshots: delete keys under the prefix
        //    that were NOT in the batch.
        const upsertedKeys = new Set(
          deltas
            .filter((d) => d.op === 'upsert')
            .map((d) => `/xinas/v1/observed/${observedSegment(d.kind)}/${d.id}`),
        );

        for (const kind of completeSnapshots) {
          const prefix = `/xinas/v1/observed/${observedSegment(kind)}/`;
          const current = tx.list({ prefix });
          for (const row of current) {
            if (!upsertedKeys.has(row.key)) {
              tx.delete(row.key);
              deletedByReconcile++;
            }
          }
        }
      });

      // 3. Notify the tracker that an observation push happened.
      ctx.tracker?.recordObservationPush(new Date());

      const stateRevision = revisions.length > 0 ? Math.max(...revisions) : 0;
      sendOk(
        req,
        res,
        {
          accepted,
          deleted_by_reconcile: deletedByReconcile,
          skipped_unchanged: skippedUnchanged,
        },
        [stateRevision],
      );
    } catch (err) {
      next(err);
    }
  };
}
