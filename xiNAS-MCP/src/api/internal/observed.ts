import type { NextFunction, Request, Response } from 'express';
import { transferDelayMs } from '../placement/receipts.js';
import type { Kind } from '../../agent/collectors/base.js';
import { observedSegment } from '../../agent/collectors/base.js';
import { canonicalize } from '../../lib/canonical-json.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import { gcSnapshotDesired } from '../tasks/snapshot-desired.js';

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
    v.status = {
      ...(v.status as Record<string, unknown>),
      observed_at: undefined,
    };
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
/** `(server_epoch, source_generation)` of a stored/incoming placement row. */
function placementStamp(value: unknown): { epoch: string | null; generation: number | null } {
  const status = (value as { status?: Record<string, unknown> } | null | undefined)?.status;
  const epoch = status?.server_epoch;
  const generation = status?.source_generation;
  return {
    epoch: typeof epoch === 'string' ? epoch : null,
    generation: typeof generation === 'number' && Number.isFinite(generation) ? generation : null,
  };
}

/**
 * S20 (F-01): ordering rule for the placement singleton. Within one agent
 * epoch the generation must strictly increase; a new epoch (agent restart)
 * is always accepted. A row without a stamp can never be compared, so it is
 * accepted (and the route refuses it for other reasons).
 */
export function placementOrder(incoming: unknown, stored: unknown): 'newer' | 'regressed' {
  if (stored === undefined || stored === null) return 'newer';
  const a = placementStamp(incoming);
  const b = placementStamp(stored);
  if (a.epoch === null || a.generation === null || b.epoch === null || b.generation === null)
    return 'newer';
  if (a.epoch !== b.epoch) return 'newer';
  return a.generation > b.generation ? 'newer' : 'regressed';
}

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
      let skippedRegressed = 0;
      const revisions: number[] = [];
      // S20 §5.2: (kind, id, revision, transfer delay) of every STORED upsert,
      // stamped on the api's receipt clock AFTER the transaction commits. An
      // unchanged or regressed placement push gets no receipt: a re-delivery
      // must never make old evidence read as fresh (F-01, F-02).
      const receipts: Array<[string, string, number, number | null]> = [];
      const wallNow = ctx.observed_receipts?.wall() ?? Date.now();

      // Derive the KV path segment through observedSegment(kind) (base.ts) so
      // writer and reader never disagree on singletons (NfsIdmap → nfs_idmap,
      // inventory/managed_files stay lowercase). H3 stays kind-agnostic; no
      // per-kind special-casing (the ExportRule→Share fold-in is a read-time
      // join in I6, not a write-time merge here).
      const engine = ctx.events?.engine;
      let touchedFeeds: ReadonlySet<import('../events/types.js').Feed> | undefined;
      ctx.state.kv.transaction((tx) => {
        // S17 §8.0: the transition engine runs INSIDE this transaction so an
        // event commits or rolls back with the observed state it describes.
        engine?.begin({ observedAt: body.observed_at, completeSnapshots, kv: tx });
        const kindsInBatch = new Set<Kind>([...completeSnapshots, ...deltas.map((d) => d.kind)]);
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
              canonicalize(stripObservedAt(current.value)) === canonicalize(stripObservedAt(value))
            ) {
              skippedUnchanged++;
              revisions.push(current.revision);
              continue;
            }
            // S20 (F-01): the placement singleton is ordered by
            // (server_epoch, source_generation). A push that is not newer
            // than the stored row within the same epoch — a delayed retry,
            // a reordered flush — is dropped, never stored, never receipted.
            if (delta.kind === 'PlacementObservations') {
              const order = placementOrder(value, current?.value);
              if (order === 'regressed') {
                skippedRegressed++;
                revisions.push(current?.revision ?? 0);
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    subsystem: 'observed',
                    event: 'placement_push_regressed',
                    id: delta.id,
                    incoming: placementStamp(value),
                    stored: placementStamp(current?.value),
                  }),
                );
                continue;
              }
            }
            const result = tx.put(key, value);
            // No expected_revision → put always commits (ok: true). Guard
            // anyway so a future CAS variant can't silently push undefined.
            if (result.ok) {
              revisions.push(result.value.revision);
              receipts.push([
                delta.kind,
                delta.id,
                result.value.revision,
                delta.kind === 'PlacementObservations'
                  ? transferDelayMs(
                      (value as { status?: { generated_at?: unknown } }).status?.generated_at,
                      wallNow,
                    )
                  : 0,
              ]);
            }
            accepted++;
            engine?.onChange({
              kind: delta.kind,
              id: delta.id,
              previous: (current?.value as Record<string, unknown> | undefined) ?? null,
              current: value,
              previousRevision: current?.revision ?? null,
            });
          } else if (delta.op === 'delete') {
            const existing = engine !== undefined ? tx.get(key) : null;
            tx.delete(key);
            accepted++;
            if (existing !== null) {
              engine?.onChange({
                kind: delta.kind,
                id: delta.id,
                previous: existing.value as Record<string, unknown>,
                current: null,
                previousRevision: existing.revision,
              });
            }
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
              engine?.onChange({
                kind,
                id: row.key.slice(prefix.length),
                previous: row.value as Record<string, unknown>,
                current: null,
                previousRevision: row.revision,
              });
            }
          }
          engine?.onSnapshot(
            kind,
            new Set(deltas.filter((d) => d.op === 'upsert' && d.kind === kind).map((d) => d.id)),
          );
        }
        engine?.markAccepted([...kindsInBatch]);
        touchedFeeds = engine?.commit().feeds;
      });
      // Post-commit wake-up (S17 §5.6): never inside the transaction.
      if (touchedFeeds !== undefined && touchedFeeds.size > 0) ctx.events?.notify?.(touchedFeeds);

      // 3. GC orphan snapshot-desired payloads — ONLY on a complete ConfigSnapshot
      //    re-emit. That is the only push yielding an authoritative observed set, and
      //    (the collector re-emits every row) it necessarily includes any snapshot
      //    created before the capture that wrote its payload — so a freshly-captured
      //    payload is never pruned in the window before its observation lands
      //    (ADR-0015, S12 T6).
      if (completeSnapshots.includes('ConfigSnapshot')) {
        gcSnapshotDesired(ctx.state.kv);
      }

      // 4. Notify the tracker that an observation push happened.
      ctx.tracker?.recordObservationPush(new Date());
      // S20: stamp the receipt clock for every row this push STORED.
      if (ctx.observed_receipts !== undefined) {
        for (const [kind, id, revision, delay] of receipts)
          ctx.observed_receipts.record(kind, id, revision, delay);
      }

      const stateRevision = revisions.length > 0 ? Math.max(...revisions) : 0;
      sendOk(
        req,
        res,
        {
          accepted,
          deleted_by_reconcile: deletedByReconcile,
          skipped_unchanged: skippedUnchanged,
          ...(skippedRegressed > 0 ? { skipped_regressed: skippedRegressed } : {}),
        },
        [stateRevision],
      );
    } catch (err) {
      next(err);
    }
  };
}
