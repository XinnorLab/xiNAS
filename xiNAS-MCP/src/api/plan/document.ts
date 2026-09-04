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

/** Plain-language NFS-client impact for the Plan envelope (moved from apply-helpers). */
export function clientImpact(riskLevel: string): string {
  return riskLevel === 'non_disruptive'
    ? 'No impact on NFS clients.'
    : 'May affect NFS clients; review the diff.';
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
    client_impact: clientImpact(input.risk_level),
    blockers: input.blockers,
    warnings: redactValue(input.warnings) as Array<{ code: string; message: string }>,
    diff: redactValue(input.diff),
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
