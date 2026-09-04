import { canonicalize } from '../../../lib/canonical-json.js';
import type { PlanDocument } from '../../plan/document.js';
import type { ConfirmationRecord } from './types.js';

const DIFF_CAP = 600;

/** Canonical JSON of the diff, capped (S15 §10.1). */
export function summarizeDiff(diff: unknown, cap = DIFF_CAP): string {
  const s = canonicalize(diff ?? null);
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}… (${s.length - cap} more characters; see the plan)`;
}

function resources(doc: PlanDocument): string {
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
}

/** The approval-page text (S15 §10.2). */
export function renderSummary(input: SummaryInput): {
  message: string;
  consequences: string;
  rollback_limitation: string;
} {
  const { record, document: doc } = input;
  const message = renderConfirmationMessage({
    record,
    document: doc,
    hostname: record.node_id,
    now: record.created_at,
  });
  let consequences = 'This operation changes the node configuration.';
  if (doc.risk_level === 'destructive') {
    consequences = `This operation destroys data on ${doc.affected_resources.map((r) => `${r.kind} ${r.id}`).join(', ')}. Data on them may be permanently lost.`;
  } else if (doc.risk_level === 'changing_access') {
    consequences = `This operation changes client access: ${doc.client_impact}`;
  }
  let rollback_limitation: string;
  switch (doc.rollback_model) {
    case 'unsupported':
      rollback_limitation = 'xiNAS cannot roll this operation back automatically.';
      break;
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
