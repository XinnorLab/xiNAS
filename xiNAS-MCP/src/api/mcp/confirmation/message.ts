import { canonicalize } from '../../../lib/canonical-json.js';
import type { PlanDocument } from '../../plan/document.js';
import type { ConfirmationRecord } from './types.js';

const DIFF_CAP = 600;

/** Canonical JSON of the diff, capped (S15 §10.1). */
export function summarizeDiff(diff: unknown, cap = DIFF_CAP): string {
  const s = canonicalize(diff ?? null);
  if (s.length <= cap) return s;
  const extra = s.length - cap;
  const unit = extra === 1 ? 'character' : 'characters';
  return `${s.slice(0, cap)}… (${extra} more ${unit}; see the plan)`;
}

function resources(doc: PlanDocument): string {
  if (doc.affected_resources.length === 0) return '(none listed)';
  return doc.affected_resources.map((r) => `${r.kind} ${r.id}`).join('; ');
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export interface MessageInput {
  record: ConfirmationRecord;
  document: PlanDocument;
  hostname: string;
  now: number;
}

/**
 * The form-elicitation message (S15 §10.1). Built from the stored document
 * and the record only — never from anything the client sent. Plain text,
 * no URLs (form-mode fields must not carry clickable links).
 */
export function renderConfirmationMessage(input: MessageInput): string {
  const { record, document: doc } = input;
  const expiresIso = new Date(record.expires_at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const warnings =
    doc.warnings.length === 0
      ? 'Warnings: none'
      : `Warnings: ${doc.warnings.map((w, i) => `(${i + 1}) ${w.code} — ${w.message}`).join(' ')}`;
  const target =
    doc.resource_ref.id === null
      ? doc.resource_ref.kind
      : `${doc.resource_ref.kind} "${doc.resource_ref.id}"`;
  return [
    `xiNAS node ${input.hostname} (controller ${record.node_id})`,
    `Operation: ${record.tool_name} (${doc.operation_kind}) on ${target}`,
    `Risk: ${doc.risk_level} · Rollback: ${doc.rollback_model}`,
    `Client impact: ${doc.client_impact}`,
    `Affected: ${resources(doc)}`,
    warnings,
    `Diff (concise): ${summarizeDiff(doc.diff)}`,
    `Plan ${doc.plan_id} · hash ${doc.plan_hash.slice(0, 12)} · expires ${expiresIso} (in ${countdown(record.expires_at - input.now)})`,
    'Choose APPLY to confirm. Any other action leaves xiNAS unchanged.',
  ].join('\n');
}

export interface SummaryInput {
  record: ConfirmationRecord;
  document: PlanDocument;
  hostname: string;
  now: number;
}

/** The approval-page text (S15 §10.2). */
export function renderSummary(input: SummaryInput): {
  message: string;
  consequences: string;
  rollback_limitation: string;
} {
  const { record, document: doc, hostname, now } = input;
  const message = renderConfirmationMessage({
    record,
    document: doc,
    hostname,
    now,
  });
  let consequences = 'This operation changes the node configuration.';
  if (doc.risk_level === 'destructive') {
    consequences =
      doc.affected_resources.length === 0
        ? 'This operation destroys data on the affected resources. Data may be permanently lost.'
        : `This operation destroys data on ${doc.affected_resources.map((r) => `${r.kind} ${r.id}`).join(', ')}. Data on them may be permanently lost.`;
  } else if (doc.risk_level === 'unsupported_rollback') {
    // A5 (S15 §10.2): `unsupported_rollback` is a risk level of its own —
    // it is what sends an otherwise-ordinary plan to url mode. Evaluated
    // before `changing_access` so a plan that is both never hides the fact
    // an operator most needs: there is no automatic way back.
    consequences =
      'This operation cannot be rolled back automatically: if it fails or must be undone, manual recovery is required.';
  } else if (doc.risk_level === 'changing_access') {
    consequences = `This operation changes client access: ${doc.client_impact}`;
  }
  let rollback_limitation: string;
  // A5: the risk level wins over the model. A document may carry
  // `risk_level: 'unsupported_rollback'` with a rollback_model that still
  // reads as recoverable ('changing_access', 'non_disruptive'); promising an
  // automatic rollback there would be false.
  if (doc.risk_level === 'unsupported_rollback' || doc.rollback_model === 'unsupported') {
    return {
      message,
      consequences,
      rollback_limitation: 'xiNAS cannot roll this operation back automatically.',
    };
  }
  switch (doc.rollback_model) {
    case 'destructive':
      rollback_limitation =
        'Rollback is itself destructive: undoing this operation cannot restore data.';
      break;
    case 'changing_access':
      rollback_limitation =
        'Rollback restores the previous access rules; clients may see a brief interruption.';
      break;
    default:
      rollback_limitation = 'Rollback is non-disruptive.';
  }
  return { message, consequences, rollback_limitation };
}
