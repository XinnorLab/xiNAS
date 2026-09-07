import { createHash } from 'node:crypto';
import { canonicalize } from '../../lib/canonical-json.js';
import type { ResourceRef } from '../tasks/types.js';

/**
 * The persisted public plan (S15 §5). Built once by PlanEngine.plan(), stored
 * on the plan_only row (migration 006), and the ONLY source every Plan
 * envelope is rendered from — so what the client saw and what a later
 * confirmation shows are the same bytes.
 */
export const PLAN_DOCUMENT_SCHEMA = 1 as const;

export interface PlanDocument {
  schema: typeof PLAN_DOCUMENT_SCHEMA;
  plan_id: string;
  operation_kind: string;
  /** Primary resource: affected_resources[0] (the S2 contract), id null for create kinds without one. */
  resource_ref: { kind: string; id: string | null };
  plan_hash: string;
  state_revision_expected: number;
  observed_revision_expected: number | null;
  observed_at: string | null;
  affected_resources: ResourceRef[];
  risk_level: string;
  client_impact: string;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  diff: unknown;
  rollback_model: string;
  created_at: string;
  created_by: { principal: string; client_type: string };
}

/** The api-v1.yaml `Plan` envelope: the document minus its bookkeeping. */
export type PublicPlan = Omit<
  PlanDocument,
  'schema' | 'operation_kind' | 'resource_ref' | 'created_at' | 'created_by'
>;

export interface BuildPlanDocumentInput {
  plan_id: string;
  operation_kind: string;
  plan_hash: string;
  state_revision_expected: number;
  observed_revision_expected?: number | undefined;
  observed_at?: string | undefined;
  affected_resources: ResourceRef[];
  risk_level: string;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  diff: unknown;
  rollback_model: string;
  created_at_ms: number;
  principal: string;
  client_type: string;
}

/**
 * Human-readable resource labels for `client_impact`. Anything not listed is
 * named by its raw kind — a new resource kind reads slightly stiffly rather
 * than silently disappearing from the sentence.
 */
const RESOURCE_LABELS: Record<string, string> = {
  Share: 'NFS share',
  ExportRule: 'NFS export rule',
  Filesystem: 'filesystem',
  NetworkInterface: 'network interface',
  Array: 'array',
  Pool: 'pool',
};

/** Diff keys that narrate the operation rather than name a changed field. */
const NARRATIVE_DIFF_KEYS = new Set(['action', 'summary']);

/** Where a provider may put the export/mount path in its diff. */
const PATH_KEYS = ['path', 'export_path', 'export', 'mountpoint'];

const MAX_LISTED_RESOURCES = 5;
const MAX_LISTED_FIELDS = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The export/mount path the diff names, top level first, then one level down. */
function exportPathOf(diff: unknown): string | undefined {
  if (!isPlainObject(diff)) return undefined;
  for (const key of PATH_KEYS) {
    const v = diff[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const value of Object.values(diff)) {
    if (!isPlainObject(value)) continue;
    for (const key of PATH_KEYS) {
      const v = value[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

function cap(items: string[], limit: number, noun: string): string {
  if (items.length <= limit) return items.join(', ');
  const extra = items.length - limit;
  return `${items.slice(0, limit).join(', ')} (+${extra} more${noun === '' ? '' : ` ${noun}`})`;
}

/**
 * Plain-language client impact for the Plan envelope (S15 §10.1).
 *
 * For a `changing_access` plan this is DERIVED from the plan itself — the
 * affected resources by kind and id, the export path when the diff names
 * one, and the top-level diff fields that changed — because the form
 * message and the approval page render this string verbatim and an operator
 * deciding on a `changing_access` apply needs to know WHAT access moved.
 * Two canned sentences said nothing (final review I3).
 *
 * Every other risk level keeps its neutral sentence: `destructive` and
 * `unsupported_rollback` get their own dedicated `consequences` line on the
 * approval page (§10.2), and `non_disruptive` has nothing to report.
 *
 * The `diff` handed in here is the REDACTED one (secret-looking VALUES are
 * already digests) — key names are never redacted, so a field called
 * `token` is still listed as changed while its value never appears.
 */
export function clientImpact(input: {
  risk_level: string;
  affected_resources: ResourceRef[];
  diff: unknown;
}): string {
  if (input.risk_level === 'non_disruptive') return 'No impact on NFS clients.';
  if (input.risk_level !== 'changing_access') return 'May affect NFS clients; review the diff.';

  const resources = input.affected_resources.map(
    (r) => `${RESOURCE_LABELS[r.kind] ?? r.kind} ${r.id}`,
  );
  const subject =
    resources.length === 0 ? 'the node configuration' : cap(resources, MAX_LISTED_RESOURCES, '');

  const path = exportPathOf(input.diff);
  const where = path === undefined ? '' : ` (export ${path})`;

  const changed = isPlainObject(input.diff)
    ? Object.keys(input.diff).filter(
        (k) => !NARRATIVE_DIFF_KEYS.has(k) && !(PATH_KEYS.includes(k) && path !== undefined),
      )
    : [];
  const fields =
    changed.length === 0 ? '' : `; changed: ${cap(changed, MAX_LISTED_FIELDS, 'fields')}`;

  return `Affects ${subject}${where}${fields}. Review the diff for the new access rules.`;
}

const SECRET_KEY = /^(password|passwd|secret|token|api_key|private_key|authorization)$/i;

/** Replace secret-looking keys at any depth by a digest marker (S15 §5.2). */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k)
        ? { redacted: 'sha256', digest: sha256(canonicalize(v)) }
        : redactValue(v);
    }
    return out;
  }
  return value;
}

export function buildPlanDocument(input: BuildPlanDocumentInput): PlanDocument {
  const primary = input.affected_resources[0];
  // Redact once and derive `client_impact` from the SAME bytes that get
  // persisted, so the sentence can never mention something the stored diff
  // does not show.
  const diff = redactValue(input.diff);
  return {
    schema: PLAN_DOCUMENT_SCHEMA,
    plan_id: input.plan_id,
    operation_kind: input.operation_kind,
    resource_ref: { kind: primary?.kind ?? input.operation_kind, id: primary?.id ?? null },
    plan_hash: input.plan_hash,
    state_revision_expected: input.state_revision_expected,
    observed_revision_expected: input.observed_revision_expected ?? null,
    observed_at: input.observed_at ?? null,
    affected_resources: input.affected_resources,
    risk_level: input.risk_level,
    client_impact: clientImpact({
      risk_level: input.risk_level,
      affected_resources: input.affected_resources,
      diff,
    }),
    blockers: input.blockers,
    warnings: redactValue(input.warnings) as Array<{ code: string; message: string }>,
    diff,
    rollback_model: input.rollback_model,
    created_at: new Date(input.created_at_ms).toISOString(),
    created_by: { principal: input.principal, client_type: input.client_type },
  };
}

export function planDocumentHash(doc: PlanDocument): string {
  return sha256(canonicalize(doc));
}

export function publicPlan(doc: PlanDocument): PublicPlan {
  const {
    schema: _s,
    operation_kind: _k,
    resource_ref: _r,
    created_at: _c,
    created_by: _b,
    ...rest
  } = doc;
  return rest;
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
