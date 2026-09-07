/**
 * Subscription lifecycle audit (S17 §11, SUBS-AUD-001): at most one row per
 * lifecycle condition, queued through the AuditAppender like the S15
 * confirmation events. Payloads carry principal, transport, feed names,
 * the server-minted correlation id, reasons and counts — never a bearer, a
 * cursor string, a client address or an event payload. Individual
 * notifications and feed reads write no row.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../../lib/canonical-json.js';
import type { AuditEntryInput } from '../../state/types.js';

/** The structural subset of AuditAppender this module needs (tests inject a fake). */
export interface AuditSink {
  queue(input: AuditEntryInput): unknown;
}

export type SubscriptionAuditEvent = 'opened' | 'closed' | 'denied' | 'overflow';

const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

export function queueSubscriptionEvent(
  audit: AuditSink | undefined,
  event: SubscriptionAuditEvent,
  fields: {
    principal: string;
    correlationId: string;
    payload: Record<string, unknown>;
  },
): void {
  if (audit === undefined) return;
  const payload = { ...fields.payload, subscription_correlation_id: fields.correlationId };
  audit.queue({
    kind: `mcp.subscription.${event}`,
    principal: fields.principal,
    client_type: 'mcp',
    request_id: fields.correlationId,
    parameters_hash: sha(canonicalize(payload)),
    result_hash: sha(event),
    operation_id: fields.correlationId,
    payload,
  });
}

/** One row per read that returned `gap: true` (spec §11). */
export function queueCursorGap(
  audit: AuditSink | undefined,
  fields: {
    principal: string;
    correlationId: string;
    feed: string;
    requestedSequence: number;
    oldestSequence: number | null;
  },
): void {
  if (audit === undefined) return;
  const payload = {
    feed: fields.feed,
    requested_sequence: fields.requestedSequence,
    oldest_sequence: fields.oldestSequence,
  };
  audit.queue({
    kind: 'mcp.event_cursor.gap_observed',
    principal: fields.principal,
    client_type: 'mcp',
    request_id: fields.correlationId,
    parameters_hash: sha(canonicalize(payload)),
    result_hash: sha('gap_observed'),
    payload,
  });
}
