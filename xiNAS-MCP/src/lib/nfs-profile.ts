/**
 * NfsProfile spec logic shared by the api (route merge + PlanProvider risk
 * classification) and the agent executor (helper restart flag) — S3 N7.3,
 * s3-nfs-executor-spec §3.4, ADR-0005.
 *
 * Layer-neutral pure module (like `lib/nfs-exports.ts` / `lib/canonical-json.ts`):
 * lives under `src/lib/*` and imports nothing from the api or state layers, so
 * BOTH sides import the SAME implementation — one derivation, two importers.
 * The restart decision is therefore DERIVED (never stored on the task spec):
 * the api derives it for the plan's risk/diff preview, the agent re-derives the
 * identical answer from the same `{ profile, prior_profile }` operation spec at
 * execute time.
 *
 * Three exports:
 *  - {@link DEFAULT_NFS_PROFILE_SPEC} — the ADR-0005 default profile spec, used
 *    as the merge base on the FIRST update (create-on-first-update: a fresh
 *    install has no desired NfsProfile row, §3.4).
 *  - {@link mergeProfilePatch} — shallow per-section merge of the MUTABLE
 *    sections (`threads`, `rdma`, `service_policy`) over the prior spec.
 *    ReadOnly sections (`versions`, `v3_locking`, `v4_recovery` — Phase 0 /
 *    S3 scope, §3.4) and unknown sections throw a plain Error the route maps
 *    to 400 INVALID_ARGUMENT.
 *  - {@link deriveProfileServiceAction} — which service-policy dimensions
 *    changed between two specs, and whether any changed dimension's policy
 *    demands a `restart` (`reload`/`none` → no restart, §3.4).
 */
import { canonicalize } from './canonical-json.js';

/** A (full) NfsProfile spec document — the ADR-0005 `spec` object. */
export type NfsProfileSpec = Record<string, unknown>;

/**
 * The ADR-0005 default NfsProfile spec. Every value is stated in ADR-0005:
 * the versions / threads.count(64) / rdma.port(20049) defaults come from the
 * "Phase 0 writability matrix"; the rdma.enabled(true), v3_locking,
 * v4_recovery, and service_policy defaults from the canonical-schema example
 * (`on_thread_count_change: reload`, the other three `restart`).
 */
export const DEFAULT_NFS_PROFILE_SPEC: NfsProfileSpec = {
  versions: {
    v3: { enabled: false },
    v4_0: { enabled: false },
    v4_1: { enabled: true },
    v4_2: { enabled: true },
  },
  rdma: { enabled: true, port: 20049 },
  threads: { count: 64 },
  v3_locking: {
    enabled: false,
    fixed_rpc_ports: {
      nfsd: 2049,
      mountd: 20048,
      lockd_udp: 32803,
      lockd_tcp: 32803,
      statd: 32765,
      statd_outgoing: 32766,
    },
  },
  v4_recovery: {
    backend: 'nfsdcltrack',
    recovery_root: '/var/lib/nfs/v4recovery',
    server_scope: '',
  },
  service_policy: {
    on_thread_count_change: 'reload',
    on_version_change: 'restart',
    on_rdma_change: 'restart',
    on_v3_settings_change: 'restart',
  },
};
// Deep-frozen: this constant is imported by BOTH the api (route/provider) and
// the agent (executor) — an accidental in-place mutation in one layer would
// silently corrupt the other's view. All consumers copy via spread.
deepFreeze(DEFAULT_NFS_PROFILE_SPEC);

function deepFreeze(obj: Record<string, unknown>): void {
  for (const v of Object.values(obj)) {
    if (typeof v === 'object' && v !== null) deepFreeze(v as Record<string, unknown>);
  }
  Object.freeze(obj);
}

/** The sections a Phase-0 PATCH may set (s3 §3.4). */
const MUTABLE_SECTIONS = new Set(['threads', 'rdma', 'service_policy']);
/**
 * Sections rejected on PATCH: `v3_locking`/`v4_recovery` are readOnly in
 * Phase 0 (api-v1.yaml / ADR-0005 HA scaffolding); `versions` is not in the
 * §3.4 mutable set for S3 either.
 */
const READONLY_SECTIONS = new Set(['versions', 'v3_locking', 'v4_recovery']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Shallow per-section merge of a PATCH over the prior FULL spec. Only the
 * mutable sections may appear in the patch; each is merged key-by-key over
 * the prior section (`{ ...prior.threads, ...patch.threads }`), every other
 * prior section is carried through untouched. Throws a plain Error (the
 * route maps it to 400 INVALID_ARGUMENT) on a readOnly section, an unknown
 * section, or a non-object section value. Pure: neither input is mutated.
 */
export function mergeProfilePatch(prior: NfsProfileSpec, patch: unknown): NfsProfileSpec {
  if (!isRecord(patch)) {
    throw new Error('NfsProfile PATCH spec must be an object');
  }
  const merged: NfsProfileSpec = { ...prior };
  for (const [section, value] of Object.entries(patch)) {
    if (READONLY_SECTIONS.has(section)) {
      throw new Error(
        `spec.${section} is read-only in Phase 0 — a PATCH may set only threads, rdma, service_policy`,
      );
    }
    if (!MUTABLE_SECTIONS.has(section)) {
      throw new Error(`unknown NfsProfile spec section '${section}'`);
    }
    if (!isRecord(value)) {
      throw new Error(`spec.${section} must be an object`);
    }
    const priorSection = prior[section];
    merged[section] = { ...(isRecord(priorSection) ? priorSection : {}), ...value };
  }
  return merged;
}

/** What {@link deriveProfileServiceAction} reports. */
export interface ProfileServiceAction {
  /** True iff any CHANGED dimension's service policy is 'restart'. */
  restart: boolean;
  /** The changed service-policy dimensions, in fixed order. */
  changed: string[];
}

/** Section of `spec`, or {} when absent/malformed (so projections never throw). */
function section(spec: NfsProfileSpec, name: string): Record<string, unknown> {
  const v = spec[name];
  return isRecord(v) ? v : {};
}

/**
 * The four ADR-0005 service-policy dimensions: a stable name (reported in
 * `changed[]`), the `service_policy` key that governs it, and a projection of
 * the spec slice whose change triggers it. `versions` always compares equal
 * in S3 (the merge rejects version patches) but is implemented anyway so the
 * derivation is complete when versions become mutable.
 */
const DIMENSIONS: ReadonlyArray<{
  name: string;
  policyKey: string;
  project: (spec: NfsProfileSpec) => unknown;
}> = [
  {
    name: 'thread_count',
    policyKey: 'on_thread_count_change',
    project: (spec) => section(spec, 'threads').count ?? null,
  },
  {
    name: 'versions',
    policyKey: 'on_version_change',
    project: (spec) => spec.versions ?? null,
  },
  {
    name: 'rdma',
    policyKey: 'on_rdma_change',
    project: (spec) => ({
      enabled: section(spec, 'rdma').enabled ?? null,
      port: section(spec, 'rdma').port ?? null,
    }),
  },
  {
    name: 'v3_settings',
    policyKey: 'on_v3_settings_change',
    project: (spec) => spec.v3_locking ?? null,
  },
];

/**
 * The NEXT spec's policy for a dimension, falling back to the ADR-0005
 * default when the spec carries none (a stored desired profile may predate
 * `service_policy`).
 */
function policyFor(next: NfsProfileSpec, policyKey: string): unknown {
  const declared = section(next, 'service_policy')[policyKey];
  if (declared !== undefined) return declared;
  return section(DEFAULT_NFS_PROFILE_SPEC, 'service_policy')[policyKey];
}

/**
 * Compare `prior` → `next` across the four service-policy dimensions and
 * decide the post-render service action (s3 §3.4): **restart iff any CHANGED
 * dimension's `next.service_policy.on_<dim>_change` is `'restart'`** —
 * `reload`/`none` (or nothing changed) → no restart. Comparison is canonical
 * (key-order-insensitive), so a re-serialized but identical spec never reads
 * as a change.
 */
export function deriveProfileServiceAction(
  prior: NfsProfileSpec,
  next: NfsProfileSpec,
): ProfileServiceAction {
  const changed: string[] = [];
  let restart = false;
  for (const dim of DIMENSIONS) {
    if (canonicalize(dim.project(prior)) === canonicalize(dim.project(next))) continue;
    changed.push(dim.name);
    if (policyFor(next, dim.policyKey) === 'restart') restart = true;
  }
  return { restart, changed };
}
