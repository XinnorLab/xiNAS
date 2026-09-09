/**
 * Direct confirmable entries (S19a T2, spec §9.1; ADR-0018 §4) — the
 * first use of S15's `confirmation: 'required'` hook.
 *
 * A `direct` catalog entry has no plan document to bind, so the
 * confirmation binds `{ tool, arguments }` instead: the bindings reuse the
 * plan-shaped columns (`plan_id: direct:<arguments_hash>`, `plan_hash`
 * and `idempotency_key` = the arguments hash, `expected_revision: 0`) and
 * a synthesized, non-disruptive PlanDocument carries what the elicitation
 * message and the approval view render. The document is deterministic
 * for one (tool, args, principal, created_at); it is never persisted —
 * the service remembers it in memory for `view()` and a restart sweeps
 * the pending record anyway (S15 §6.3 `restart_sweep`).
 */

import { PLAN_DOCUMENT_SCHEMA, type PlanDocument, redactValue } from '../../plan/document.js';
import type { CatalogEntry } from '../catalog.js';
import type { McpIdentity } from '../dispatch.js';
import { argumentsHash } from './policy.js';
import type { BindingKey } from './store.js';

export const DIRECT_PLAN_ID_PREFIX = 'direct:';

export function isDirectConfirmable(entry: CatalogEntry): boolean {
  return entry.mutability === 'direct' && entry.confirmation === 'required';
}

export function isDirectRecordPlanId(planId: string): boolean {
  return planId.startsWith(DIRECT_PLAN_ID_PREFIX);
}

export function directBindings(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  identity: McpIdentity,
): BindingKey {
  const hash = argumentsHash(entry.name, args);
  return {
    principal: identity.principal,
    tool_name: entry.name,
    arguments_hash: hash,
    plan_id: `${DIRECT_PLAN_ID_PREFIX}${hash}`,
    idempotency_key: hash,
    expected_revision: 0,
  };
}

/** The resource a probe call names: a Filesystem for fs_io, a Share for nfs_loopback. */
function resourceRefOf(
  entry: CatalogEntry,
  args: Record<string, unknown>,
): PlanDocument['resource_ref'] {
  const id = typeof args.target === 'string' && args.target.length > 0 ? args.target : null;
  const kind =
    args.probe === 'nfs_loopback' ? 'Share' : args.probe === 'fs_io' ? 'Filesystem' : entry.name;
  return { kind, id };
}

export function directDocument(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  identity: McpIdentity,
  nowMs: number,
): PlanDocument {
  const bindings = directBindings(entry, args, identity);
  const resourceRef = resourceRefOf(entry, args);
  return {
    schema: PLAN_DOCUMENT_SCHEMA,
    plan_id: bindings.plan_id,
    operation_kind: entry.name,
    resource_ref: resourceRef,
    plan_hash: bindings.arguments_hash,
    state_revision_expected: 0,
    observed_revision_expected: null,
    observed_at: null,
    affected_resources:
      resourceRef.id !== null ? [{ kind: resourceRef.kind, id: resourceRef.id }] : [],
    // A probe writes and removes its own artifact; it changes no client-facing state.
    risk_level: 'non_disruptive',
    client_impact: 'No impact on NFS clients.',
    blockers: [],
    warnings: [],
    diff: redactValue(args),
    rollback_model: 'non_disruptive',
    created_at: new Date(nowMs).toISOString(),
    created_by: { principal: identity.principal, client_type: 'mcp' },
  };
}
