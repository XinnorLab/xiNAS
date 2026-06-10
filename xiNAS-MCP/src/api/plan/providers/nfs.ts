/**
 * The five NFS PlanProviders (S3 N4.1 + N7.3, s3-nfs-executor-spec §3.1–3.5)
 * — the first REAL producers of the N0 plan-binding contract:
 *
 * - `affected_resources` — the DESIRED resource (`Share/{id}`), revision-pinned
 *   when the desired row exists (update/delete); empty for the observed-only
 *   `nfs-idmap.set`.
 * - `observed_freshness_ref` — the OBSERVED resource the plan was computed
 *   against: `ExportRule/enc(path)` (N0b encoding, lib/nfs-export-id) for the
 *   share verbs, `nfs_idmap/snapshot` (snake_case per ADR-0003) for idmap.
 *   Revision 0 when the observed row is absent — the apply txn treats
 *   absent-at-apply as no-drift; a row appearing later reads ≥ 1 and so
 *   mismatches → `CONFLICT(plan_stale)`.
 * - `desired_mutations` — the desired-KV writes the apply txn performs
 *   atomically with the lease + task insert (§5.3). The Share doc matches the
 *   GET-route / seedShare shape exactly: `{ kind:'Share', id, spec }` with the
 *   operation spec's `id` hoisted OUT of `spec` (the read-time join consumes
 *   `share.spec.path` — api/routes/nfs.ts).
 * - `lease_resources` — only `nfs-idmap.set` overrides the lease set, locking
 *   the synthetic `NfsIdmap/snapshot` so concurrent sets serialize (§3.5).
 *
 * The `spec` each provider receives is the SAME raw operation spec stored on
 * the task and forwarded verbatim to the agent executor (T9b): the FULL Share
 * spec for create, the FULL MERGED Share spec for update (the route merges the
 * PATCH before planning — no merge here), `{ id, path }` for delete, and
 * `{ domain }` for idmap. The `diff` previews the compiled export entry via the
 * shared `lib/nfs-exports.ts` — the agent executor recompiles from the same raw
 * spec through the same module (one compile, two importers).
 *
 * Already-exported on create is a **blocker** (`EXPORT_PATH_IN_USE`), not a
 * throw — the plan still renders and the executor preflight re-checks at run
 * time. Active sessions on update/delete are a **warning**
 * (`ACTIVE_NFS_SESSIONS`), per the spec's "warning, not blocker" decision.
 */
import { decExportId, encExportId } from '../../../lib/nfs-export-id.js';
import { compileShareToExportEntry, shareSpecToCompileInput } from '../../../lib/nfs-exports.js';
import { deriveProfileServiceAction, type NfsProfileSpec } from '../../../lib/nfs-profile.js';
import { ApiException } from '../../errors.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** Desired NfsProfile singleton — id 'default' per ADR-0005 Phase 0. */
const DESIRED_NFS_PROFILE_KEY = '/xinas/v1/desired/NfsProfile/default';
const OBSERVED_EXPORT_RULE_PREFIX = '/xinas/v1/observed/ExportRule/';
const OBSERVED_NFS_SESSION_PREFIX = '/xinas/v1/observed/NfsSession/';
/** Observed idmap singleton — snake_case segment per ADR-0003. */
const OBSERVED_IDMAP_KEY = '/xinas/v1/observed/nfs_idmap/snapshot';

/** The raw Share spec the route forwards (full for create, full+merged for update). */
interface RawShareSpec {
  id: string;
  path: string;
  clients: Array<{ pattern: string; options: string[] }>;
  fsid: number | string;
  sync?: 'sync' | 'async';
  security_mode?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function invalid(op: string, msg: string): ApiException {
  return new ApiException('INVALID_ARGUMENT', `${op}: ${msg}`);
}

/**
 * Validate `id` (non-empty string) + `path` (absolute AND canonical) — shared
 * by all share verbs. Canonical means `path === decExportId(encExportId(path))`
 * (no trailing `/`, no `//`, no `.`/`..` segments): the desired doc, the
 * session-warning filter, and the executor compile all use the RAW path while
 * the observed ExportRule id uses the canonicalized encoding — accepting a
 * non-canonical path would silently mismatch them.
 */
function validateIdAndPath(op: string, spec: unknown): { id: string; path: string } {
  if (!isRecord(spec)) throw invalid(op, 'spec must be an object');
  const { id, path } = spec as { id?: unknown; path?: unknown };
  if (typeof id !== 'string' || id.length === 0) {
    throw invalid(op, 'spec.id must be a non-empty string');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw invalid(op, 'spec.path must be an absolute path (starting with /)');
  }
  let canonical: string;
  try {
    canonical = decExportId(encExportId(path));
  } catch (err) {
    throw invalid(op, err instanceof Error ? err.message : `unencodable export path: ${path}`);
  }
  if (path !== canonical) {
    throw invalid(
      op,
      `spec.path must be canonical (no trailing '/', '//', or '.' segments) — use ${canonical}`,
    );
  }
  return { id, path };
}

/**
 * Validate a full Share spec (create/update): id, absolute path, non-empty
 * `clients[]` of `{ pattern, options[] }` with non-empty string options, and a
 * present `fsid` (integer per OpenAPI; a numeric string is tolerated).
 */
function validateShareSpec(op: string, spec: unknown): RawShareSpec {
  validateIdAndPath(op, spec);
  const rec = spec as Record<string, unknown>;

  const clients = rec.clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    throw invalid(op, 'spec.clients must be a non-empty array');
  }
  for (const c of clients) {
    if (!isRecord(c) || typeof c.pattern !== 'string' || c.pattern.length === 0) {
      throw invalid(op, 'each spec.clients[] must have a non-empty pattern');
    }
    const options = c.options;
    if (!Array.isArray(options) || options.length === 0) {
      throw invalid(op, `client ${c.pattern}: options must be a non-empty array`);
    }
    if (options.some((o) => typeof o !== 'string' || o.length === 0)) {
      throw invalid(op, `client ${c.pattern}: every option must be a non-empty string`);
    }
  }

  const fsid = rec.fsid;
  // OpenAPI declares fsid as an integer; an integer-valued string is tolerated
  // (Number.isInteger rejects 42.5, NaN, and ±Infinity in either form).
  const fsidNum =
    typeof fsid === 'number'
      ? fsid
      : typeof fsid === 'string' && fsid.trim().length > 0
        ? Number(fsid)
        : Number.NaN;
  if (!Number.isInteger(fsidNum)) {
    throw invalid(op, 'spec.fsid must be an integer (or integer string)');
  }

  const sync = rec.sync;
  if (sync !== undefined && sync !== 'sync' && sync !== 'async') {
    throw invalid(op, "spec.sync must be 'sync' or 'async'");
  }
  const sec = rec.security_mode;
  if (sec !== undefined && !['sys', 'krb5', 'krb5i', 'krb5p'].includes(sec as string)) {
    throw invalid(op, 'spec.security_mode must be one of sys|krb5|krb5i|krb5p');
  }

  return rec as unknown as RawShareSpec;
}

/** `encExportId` with the throw mapped to INVALID_ARGUMENT (unencodable path). */
function encodeExportIdOrThrow(op: string, path: string): string {
  try {
    return encExportId(path);
  } catch (err) {
    throw invalid(op, err instanceof Error ? err.message : `unencodable export path: ${path}`);
  }
}

/**
 * Build the desired Share KV document from the raw operation spec: hoist `id`
 * to the top level, everything else becomes `spec` — exactly the shape the GET
 * routes render (`{ kind:'Share', id, spec:{ path, clients, fsid, ... } }`).
 */
function toDesiredShareDoc(raw: Record<string, unknown>): Record<string, unknown> {
  const { id, ...spec } = raw;
  return { kind: 'Share', id, spec };
}

/**
 * Observed freshness pin for `ExportRule/enc(path)`. Revision 0 when the
 * observed row is absent (absent-at-apply = no-drift; appearing later ⇒ stale).
 */
function exportRuleFreshnessRef(
  ctx: PlanContext,
  exportId: string,
): { kind: string; id: string; revision: number } {
  const observed = ctx.kv.get(`${OBSERVED_EXPORT_RULE_PREFIX}${exportId}`);
  return { kind: 'ExportRule', id: exportId, revision: observed?.revision ?? 0 };
}

/**
 * `ACTIVE_NFS_SESSIONS` warning when any observed NfsSession sits on `path`.
 * Prefix-scan via `ctx.kv.list({ prefix })` — the kv-level equivalent of the
 * routes' `listByPrefix` helper (which is literally `state.kv.list({ prefix })`).
 * The store's default list cap is 1000 rows — far above plan-time session
 * counts, and truncation could only suppress a warning, never block an apply.
 */
function activeSessionsWarning(
  ctx: PlanContext,
  path: string,
): { code: string; message: string } | null {
  const sessions = ctx.kv
    .list<Record<string, unknown>>({ prefix: OBSERVED_NFS_SESSION_PREFIX })
    .filter((row) => {
      const spec = isRecord(row.value) ? row.value.spec : undefined;
      return isRecord(spec) && spec.export_path === path;
    });
  if (sessions.length === 0) return null;
  return {
    code: 'ACTIVE_NFS_SESSIONS',
    message: `${sessions.length} active NFS session(s) observed on ${path}; clients may be disrupted`,
  };
}

/** §3.1 — create a brand-new export. Already-exported is a BLOCKER, not a throw. */
const shareCreateProvider: PlanProvider = {
  operation_kind: 'share.create',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const share = validateShareSpec('share.create', spec);
    const exportId = encodeExportIdOrThrow('share.create', share.path);

    const freshness = exportRuleFreshnessRef(ctx, exportId);
    const blockers: PlanResult['blockers'] = [];
    if (freshness.revision > 0) {
      blockers.push({
        code: 'EXPORT_PATH_IN_USE',
        message: `${share.path} is already exported; cannot create a second share on it`,
      });
    }

    return {
      // ABSENCE pin: revision 0 asserts the desired row does NOT exist yet.
      // The apply txn's desired-revision check reads an absent row as 0, so a
      // Share/{id} that appeared between plan and apply (duplicate id) reads
      // >= 1 and fails PRECONDITION_FAILED instead of silently overwriting.
      affected_resources: [{ kind: 'Share', id: share.id, revision: 0 }],
      blockers,
      warnings: [],
      diff: {
        action: 'create',
        export_entry: compileShareToExportEntry(shareSpecToCompileInput(share)),
      },
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      observed_freshness_ref: freshness,
      desired_mutations: [
        {
          key: `${DESIRED_SHARE_PREFIX}${share.id}`,
          value: toDesiredShareDoc(spec as Record<string, unknown>),
        },
      ],
    };
  },
};

/** §3.2 — update an existing export. The spec arrives PRE-MERGED by the route. */
const shareUpdateProvider: PlanProvider = {
  operation_kind: 'share.update',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const share = validateShareSpec('share.update', spec);
    const exportId = encodeExportIdOrThrow('share.update', share.path);

    const desired = ctx.kv.get(`${DESIRED_SHARE_PREFIX}${share.id}`);
    if (!desired) {
      throw new ApiException('NOT_FOUND', `share ${share.id} not found`);
    }

    const warning = activeSessionsWarning(ctx, share.path);

    return {
      affected_resources: [{ kind: 'Share', id: share.id, revision: desired.revision }],
      blockers: [],
      warnings: warning ? [warning] : [],
      diff: {
        action: 'update',
        export_entry: compileShareToExportEntry(shareSpecToCompileInput(share)),
      },
      risk_level: 'changing_access',
      rollback_model: 'reversible',
      state_revision_expected: desired.revision,
      observed_freshness_ref: exportRuleFreshnessRef(ctx, exportId),
      desired_mutations: [
        {
          key: `${DESIRED_SHARE_PREFIX}${share.id}`,
          value: toDesiredShareDoc(spec as Record<string, unknown>),
        },
      ],
    };
  },
};

/** §3.3 — delete an existing export. Spec is `{ id, path }`; directory is kept. */
const shareDeleteProvider: PlanProvider = {
  operation_kind: 'share.delete',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const { id, path } = validateIdAndPath('share.delete', spec);
    const exportId = encodeExportIdOrThrow('share.delete', path);

    const desired = ctx.kv.get(`${DESIRED_SHARE_PREFIX}${id}`);
    if (!desired) {
      throw new ApiException('NOT_FOUND', `share ${id} not found`);
    }

    const warning = activeSessionsWarning(ctx, path);

    return {
      affected_resources: [{ kind: 'Share', id, revision: desired.revision }],
      blockers: [],
      warnings: warning ? [warning] : [],
      diff: { action: 'delete', export_path: path },
      risk_level: 'changing_access',
      rollback_model: 'reversible',
      state_revision_expected: desired.revision,
      observed_freshness_ref: exportRuleFreshnessRef(ctx, exportId),
      desired_mutations: [{ key: `${DESIRED_SHARE_PREFIX}${id}`, delete: true }],
    };
  },
};

/**
 * §3.5 — set the idmapd domain. Observed-only: no desired row, no public
 * affected resource. Leases the synthetic `NfsIdmap/snapshot`; the plan's
 * revision (`state_revision_expected`) is the OBSERVED snapshot revision —
 * the general rule for observed-only operations (0 on a fresh install).
 */
const nfsIdmapSetProvider: PlanProvider = {
  operation_kind: 'nfs-idmap.set',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const domain = isRecord(spec) ? spec.domain : undefined;
    if (typeof domain !== 'string' || domain.length === 0 || !domain.includes('.')) {
      throw invalid('nfs-idmap.set', "spec.domain must be a non-empty string containing a '.'");
    }

    const observed = ctx.kv.get(OBSERVED_IDMAP_KEY);
    const revision = observed?.revision ?? 0;
    // Guarded like the session scan: a malformed observed value (non-record /
    // missing status) reads as "no prior domain", never a TypeError.
    const value = observed && isRecord(observed.value) ? observed.value : undefined;
    const status = value && isRecord(value.status) ? value.status : undefined;
    const priorDomain = typeof status?.domain === 'string' ? status.domain : null;

    return {
      affected_resources: [],
      blockers: [],
      warnings: [],
      diff: { action: 'set_domain', domain, prior_domain: priorDomain },
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      state_revision_expected: revision,
      observed_freshness_ref: { kind: 'nfs_idmap', id: 'snapshot', revision },
      lease_resources: [{ kind: 'NfsIdmap', id: 'snapshot' }],
      desired_mutations: [],
    };
  },
};

/** OpenAPI bounds for NfsProfile spec.threads.count (api-v1.yaml). */
const PROFILE_THREADS_MIN = 8;
const PROFILE_THREADS_MAX = 1024;

/** A non-array record, or INVALID_ARGUMENT naming the field. */
function requireRecordField(op: string, name: string, v: unknown): Record<string, unknown> {
  if (!isRecord(v) || Array.isArray(v)) {
    throw invalid(op, `${name} must be an object`);
  }
  return v;
}

/**
 * Light shape check of the `nfs-profile.update` operation spec
 * (`{ profile, prior_profile }`): `profile` must carry a `threads.count`
 * integer in [8, 1024] plus `rdma` / `service_policy` records;
 * `prior_profile` must be a record (the route built it from the current
 * desired spec or the ADR-0005 defaults). The route's mergeProfilePatch
 * already rejected readOnly/unknown sections; the helper re-validates the
 * full spec at render time.
 */
function validateProfileOperationSpec(
  op: string,
  spec: unknown,
): { profile: NfsProfileSpec; prior_profile: NfsProfileSpec } {
  if (!isRecord(spec)) throw invalid(op, 'spec must be an object');
  const profile = requireRecordField(op, 'spec.profile', spec.profile);
  const priorProfile = requireRecordField(op, 'spec.prior_profile', spec.prior_profile);

  const threads = requireRecordField(op, 'spec.profile.threads', profile.threads);
  const count = threads.count;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < PROFILE_THREADS_MIN ||
    count > PROFILE_THREADS_MAX
  ) {
    throw invalid(
      op,
      `spec.profile.threads.count must be an integer in [${PROFILE_THREADS_MIN}, ${PROFILE_THREADS_MAX}]`,
    );
  }
  requireRecordField(op, 'spec.profile.rdma', profile.rdma);
  requireRecordField(op, 'spec.profile.service_policy', profile.service_policy);

  return { profile, prior_profile: priorProfile };
}

/**
 * §3.4 — update the singleton NfsProfile. The spec arrives as
 * `{ profile, prior_profile }`, both built by the route (profile = the PATCH
 * merged over the current desired spec or the ADR-0005 defaults). The
 * freshness pin is the DESIRED `NfsProfile/default` revision — there is no
 * observed pin (the N7.2 observed NfsProfile row is a read-time status fold,
 * §3.4 explicitly pins desired); an ABSENT desired row pins revision 0
 * (create-on-first-update) and the desired mutation creates it. Risk is
 * derived through the shared lib: `changing_access` iff a changed dimension's
 * service policy demands a restart, else `non_disruptive`.
 */
const nfsProfileUpdateProvider: PlanProvider = {
  operation_kind: 'nfs-profile.update',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const { profile, prior_profile } = validateProfileOperationSpec('nfs-profile.update', spec);

    const desired = ctx.kv.get(DESIRED_NFS_PROFILE_KEY);
    const { restart, changed } = deriveProfileServiceAction(prior_profile, profile);

    return {
      // Present row → its revision; absent → ABSENCE pin (revision 0): the
      // apply txn reads an absent desired row as 0, so a profile row created
      // between plan and apply reads >= 1 and fails PRECONDITION_FAILED.
      affected_resources: [{ kind: 'NfsProfile', id: 'default', revision: desired?.revision ?? 0 }],
      blockers: [],
      warnings: [],
      diff: { action: 'update', changed, restart, profile },
      risk_level: restart ? 'changing_access' : 'non_disruptive',
      rollback_model: 'reversible',
      ...(desired ? { state_revision_expected: desired.revision } : {}),
      desired_mutations: [
        {
          key: DESIRED_NFS_PROFILE_KEY,
          value: { kind: 'NfsProfile', id: 'default', spec: profile },
        },
      ],
    };
  },
};

/** The five NFS plan providers, for registration on the PlanEngine. */
export function buildNfsPlanProviders(): PlanProvider[] {
  return [
    shareCreateProvider,
    shareUpdateProvider,
    shareDeleteProvider,
    nfsProfileUpdateProvider,
    nfsIdmapSetProvider,
  ];
}
