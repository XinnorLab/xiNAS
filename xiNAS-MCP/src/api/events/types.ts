/**
 * S17 operational-event feeds — shared types
 * (docs/control-path/s17-mcp-subscriptions-spec.md §4.1, §6).
 *
 * Everything on the wire (feed ids, the envelope, the closed vocabularies)
 * is defined here once so the journal, the producers, the MCP resource
 * handlers and the REST projection cannot disagree about a name.
 */

/** The six Phase 1 feeds, in the order `resources/list` returns them. */
export const FEEDS = ['raid', 'raid/progress', 'storage', 'nfs', 'nfs/sessions', 'system'] as const;
export type Feed = (typeof FEEDS)[number];

export const FEED_URI_PREFIX = 'xinas://events/';
export const FEED_MIME = 'application/vnd.xinas.events+json';

export const feedUri = (feed: Feed): string => `${FEED_URI_PREFIX}${feed}`;
export const isFeed = (v: unknown): v is Feed =>
  typeof v === 'string' && (FEEDS as readonly string[]).includes(v);

export type Severity = 'info' | 'warning' | 'error' | 'critical';
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

export type TimeAccuracy = 'source' | 'observed' | 'task';
export type SourceKind =
  | 'observed_transition'
  | 'observed_snapshot'
  | 'heartbeat'
  | 'inventory'
  | 'task';
export type SubjectKind =
  | 'XiraidArray'
  | 'Disk'
  | 'Pool'
  | 'Filesystem'
  | 'ExportRule'
  | 'NfsSession'
  | 'SystemdUnit'
  | 'Agent'
  | 'Collector'
  | 'NetworkInterface'
  | 'Node';

/** Phase 1 operation kinds (spec §6.5); Phase 2 appends `restripe`, `sdc_scan`. */
export type OperationKind = 'initialization' | 'reconstruction';

/** The closed `reasonCode` vocabulary (spec §6.5). */
export const REASON_CODES = [
  'baseline',
  'state_none',
  'reconcile_absent',
  'unit_failed',
  'unit_inactive',
  'unmounted',
  'ro_option',
  'hysteresis',
  'task',
  'reboot',
  'connect_refused',
  'heartbeat_timeout',
  'collector_error',
  'no_valid_update',
  'helper_absent',
  'not_configured',
  'unknown_word',
  'regression',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ResourceRef {
  kind: string;
  id: string;
}

/** One journal row as the client reads it (spec §6.1). */
export interface EventEnvelope {
  schemaVersion: '1';
  eventId: string;
  sequence: number;
  controllerId: string;
  feed: Feed;
  type: string;
  severity: Severity;
  detectedAt: string;
  timeAccuracy: TimeAccuracy;
  source: { kind: SourceKind; component: string };
  subject: { kind: SubjectKind; id: string };
  summary: string;
  // Optional groups — only these keys may appear (spec §6.1).
  occurredAt?: string;
  previous?: Record<string, unknown>;
  current?: Record<string, unknown>;
  operation?: { kind: OperationKind; generation: number; progressPct?: number; bucket?: number };
  threshold?: { metric: string; value: number; unit: string; enter: number; clear: number };
  reasonCode?: ReasonCode;
  relatedResources?: ResourceRef[];
  cause?: { taskId?: string; operationId?: string };
  details?: Record<string, unknown>;
}

/** What a producer hands the journal; the journal fills the rest. */
export type EventInput = Omit<EventEnvelope, 'eventId' | 'sequence' | 'controllerId'>;
