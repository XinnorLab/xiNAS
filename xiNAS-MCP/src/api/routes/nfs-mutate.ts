import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { DEFAULT_NFS_PROFILE_SPEC, mergeProfilePatch } from '../../lib/nfs-profile.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import type { Task } from '../tasks/types.js';
import { applyMode, planMode, requireTasks } from './apply-helpers.js';

/**
 * S3 N5.2 + N7.3 — the REAL NFS mutating routes (s3-nfs-executor-spec §7,
 * §3.1–3.5), replacing the API-19 `executorUnavailable` stubs for exactly
 * these five verbs:
 *
 *   POST   /shares             → share.create       (server-assigned id, fsid unique)
 *   PATCH  /shares/{id}        → share.update       (route merges the PATCH → FULL spec)
 *   DELETE /shares/{id}        → share.delete       (spec = { id, path })
 *   PATCH  /nfs-profiles/{id}  → nfs-profile.update (spec = { profile, prior_profile })
 *   PATCH  /nfs-idmap          → nfs-idmap.set      (spec = { domain })
 *
 * Each follows the shared two-mode flow (apply-helpers.ts): `mode=plan` runs
 * the N4 PlanProvider and renders the Plan envelope; `mode=apply` resolves the
 * kind-checked plan, validates the expected_revision echo, runs the atomic N0
 * apply transaction (desired_mutations + leases + task), and dispatches
 * task.begin to the agent executor.
 */

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** Desired NfsProfile singleton key — id 'default' per ADR-0005 Phase 0. */
const DESIRED_NFS_PROFILE_KEY = '/xinas/v1/desired/NfsProfile/default';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function badMode(mode: unknown): ApiException {
  return new ApiException(
    'INVALID_ARGUMENT',
    `unknown mode '${String(mode)}'; expected 'plan' or 'apply'`,
    undefined,
    "Send { mode: 'plan', spec } or { mode: 'apply', plan_id, expected_revision, idempotency_key }.",
  );
}

/** The plan's spec must target the URL's share id (apply-side binding check). */
function planTargetsShare(id: string): (planTask: Task) => boolean {
  return (planTask) => isRecord(planTask.spec) && planTask.spec.id === id;
}

/**
 * fsid as an integer, or undefined when non-numeric — malformed fsids are NOT
 * rejected here; the provider's validateShareSpec owns that 400 (same
 * number-or-integer-string tolerance as its check).
 */
function fsidNumber(fsid: unknown): number | undefined {
  const n =
    typeof fsid === 'number'
      ? fsid
      : typeof fsid === 'string' && fsid.trim().length > 0
        ? Number(fsid)
        : Number.NaN;
  return Number.isInteger(n) ? n : undefined;
}

/**
 * fsid uniqueness (spec §7): every desired Share must carry a distinct fsid.
 * Scans `/xinas/v1/desired/Share/` and rejects CONFLICT(fsid_in_use) when any
 * share other than `excludeId` (the one being created/updated) already uses
 * `fsid`. Numeric comparison so `42` and `'42'` collide.
 *
 * PLAN-TIME check only: two concurrently-planned creates with the same fsid
 * both pass, and their applies could land duplicate fsids (the create
 * absence-pin guards the share ID, not the fsid). Accepted for S3 — the api
 * is the single synchronous writer, the window needs deliberately interleaved
 * plan/apply pairs, and the failure mode is a duplicate-fsid exports entry,
 * not data loss.
 */
function rejectDuplicateFsid(ctx: ApiContext, fsid: unknown, excludeId: string): void {
  const wanted = fsidNumber(fsid);
  if (wanted === undefined) return; // malformed fsid → the provider's 400 owns it
  const rows = ctx.state.kv.list<Record<string, unknown>>({ prefix: DESIRED_SHARE_PREFIX });
  const clash = rows.find((row) => {
    if (row.key.slice(DESIRED_SHARE_PREFIX.length) === excludeId) return false;
    const spec = isRecord(row.value) ? row.value.spec : undefined;
    return isRecord(spec) && fsidNumber(spec.fsid) === wanted;
  });
  if (!clash) return;
  const holder = clash.key.slice(DESIRED_SHARE_PREFIX.length);
  throw new ApiException(
    'CONFLICT',
    `fsid ${wanted} is already used by share ${holder}`,
    { reason: 'fsid_in_use', share_id: holder },
    'Choose an fsid no other share uses, or update that share instead.',
  );
}

/** The desired Share row, or NOT_FOUND. */
function requireDesiredShare(
  ctx: ApiContext,
  id: string,
): { value: Record<string, unknown>; spec: Record<string, unknown> } {
  const row = ctx.state.kv.get<Record<string, unknown>>(`${DESIRED_SHARE_PREFIX}${id}`);
  if (!row) {
    throw new ApiException('NOT_FOUND', `share ${id} not found`);
  }
  const value = isRecord(row.value) ? row.value : {};
  const spec = isRecord(value.spec) ? value.spec : {};
  return { value, spec };
}

export function nfsMutateRouter(ctx: ApiContext): Router {
  const r = Router();

  // ── POST /shares — share.create (§3.1) ─────────────────────────────────────
  r.post('/shares', async (req, res) => {
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.mode === 'plan') {
      const raw: Record<string, unknown> = isRecord(body.spec) ? body.spec : {};
      // Server-assigned id (spec §7): absent → fresh UUID. A present id —
      // valid or not — is forwarded as-is for the provider to validate. The
      // assigned id rides in the raw spec persisted on the plan, so apply and
      // the executor reuse it.
      const id = raw.id === undefined ? randomUUID() : raw.id;
      const spec: Record<string, unknown> = { ...raw, id };
      rejectDuplicateFsid(ctx, spec.fsid, typeof id === 'string' ? id : '');
      // Echo the (possibly assigned) id in the envelope so the client knows it.
      await planMode(req, res, tasks, 'share.create', spec, { id });
      return;
    }
    if (body.mode === 'apply') {
      await applyMode(req, res, tasks, body, { operationKind: 'share.create' });
      return;
    }
    throw badMode(body.mode);
  });

  // ── PATCH /shares/:id — share.update (§3.2) ─────────────────────────────────
  r.patch('/shares/:id', async (req, res) => {
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = req.params.id;

    if (body.mode === 'plan') {
      const { spec: existingSpec } = requireDesiredShare(ctx, id);
      const patch: Record<string, unknown> = isRecord(body.spec) ? body.spec : {};
      // Shallow top-level merge of the PATCH over the existing spec (arrays —
      // e.g. clients — are replaced wholesale). The URL id is authoritative;
      // any body spec.id is dropped. The provider receives the FULL merged
      // Share spec (the providers never merge — §3.2).
      const patchFields = Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'id'));
      const mergedSpec = { ...existingSpec, ...patchFields };
      if (
        patchFields.fsid !== undefined &&
        fsidNumber(patchFields.fsid) !== fsidNumber(existingSpec.fsid)
      ) {
        rejectDuplicateFsid(ctx, patchFields.fsid, id);
      }
      await planMode(req, res, tasks, 'share.update', { id, ...mergedSpec });
      return;
    }
    if (body.mode === 'apply') {
      await applyMode(req, res, tasks, body, {
        operationKind: 'share.update',
        planTaskMatches: planTargetsShare(id),
      });
      return;
    }
    throw badMode(body.mode);
  });

  // ── DELETE /shares/:id — share.delete (§3.3) ────────────────────────────────
  r.delete('/shares/:id', async (req, res) => {
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = req.params.id;

    if (body.mode === 'plan') {
      const { spec } = requireDesiredShare(ctx, id);
      // The operation spec is { id, path } (§3.3) — the executor removes the
      // export by path; the on-disk directory is kept.
      await planMode(req, res, tasks, 'share.delete', { id, path: spec.path });
      return;
    }
    if (body.mode === 'apply') {
      await applyMode(req, res, tasks, body, {
        operationKind: 'share.delete',
        planTaskMatches: planTargetsShare(id),
      });
      return;
    }
    throw badMode(body.mode);
  });

  // ── PATCH /nfs-profiles/:id — nfs-profile.update (§3.4) ────────────────────
  // Phase-0 singleton: only id 'default' exists. PUT (full replace) stays on
  // the executorUnavailable stub — only the PATCH path is built in S3.
  r.patch('/nfs-profiles/:id', async (req, res) => {
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = req.params.id;
    if (id !== 'default') {
      throw new ApiException('NOT_FOUND', `nfs profile ${id} not found`);
    }

    if (body.mode === 'plan') {
      // The merge base is the current desired spec, or the ADR-0005 defaults
      // when no desired row exists yet (create-on-first-update, §3.4 — a
      // fresh install has no desired profile row; the provider pins
      // revision 0 and the apply's desired mutation creates it).
      const row = ctx.state.kv.get<Record<string, unknown>>(DESIRED_NFS_PROFILE_KEY);
      const value = row && isRecord(row.value) ? row.value : undefined;
      const prior =
        value && isRecord(value.spec)
          ? (value.spec as Record<string, unknown>)
          : DEFAULT_NFS_PROFILE_SPEC;
      const patch: Record<string, unknown> = isRecord(body.spec) ? body.spec : {};
      // Per-section merge of the MUTABLE sections (threads/rdma/
      // service_policy); a readOnly (versions/v3_locking/v4_recovery) or
      // unknown section throws → 400 INVALID_ARGUMENT.
      let profile: Record<string, unknown>;
      try {
        profile = mergeProfilePatch(prior, patch);
      } catch (err) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          err instanceof Error ? err.message : 'invalid NfsProfile PATCH spec',
          undefined,
          'A Phase-0 PATCH may set only the threads, rdma, and service_policy sections.',
        );
      }
      // The operation spec carries BOTH sides; the restart decision is
      // derived (api for risk, agent for the helper flag), never stored.
      await planMode(req, res, tasks, 'nfs-profile.update', { profile, prior_profile: prior });
      return;
    }
    if (body.mode === 'apply') {
      await applyMode(req, res, tasks, body, { operationKind: 'nfs-profile.update' });
      return;
    }
    throw badMode(body.mode);
  });

  // ── PATCH /nfs-idmap — nfs-idmap.set (§3.5) ─────────────────────────────────
  r.patch('/nfs-idmap', async (req, res) => {
    const tasks = requireTasks(ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.mode === 'plan') {
      // §7: the plan body carries { domain } top-level; the generic
      // PlanRequest nesting (spec: { domain }) is accepted too. When both are
      // present, the top-level value WINS (it is the documented §7 shape).
      const domain =
        body.domain !== undefined
          ? body.domain
          : isRecord(body.spec)
            ? body.spec.domain
            : undefined;
      await planMode(req, res, tasks, 'nfs-idmap.set', { domain });
      return;
    }
    if (body.mode === 'apply') {
      await applyMode(req, res, tasks, body, { operationKind: 'nfs-idmap.set' });
      return;
    }
    throw badMode(body.mode);
  });

  return r;
}
