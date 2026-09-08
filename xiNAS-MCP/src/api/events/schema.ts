/**
 * The closed S17 event taxonomy (spec §6.4, §6.5, §6.2): every Phase 1 event
 * type, its severity, its `details` JSON schema and the producer families a
 * feed read reports as active or source-gated (decision D-16).
 *
 * A type that is not in EVENT_SEVERITY does not exist; a `details` object
 * that does not validate against its schema is a producer bug, refused with
 * a RangeError rather than written (no raw source object ever reaches the
 * journal — SUBS-EVENT-002/006).
 */

// Ajv 8.x publishes CJS-style `export =` types; under `module: Node16` the
// default import is a namespace, so bridge with a cast (the same pattern
// observed-schemas.ts and the contracts test use).
import AjvImport from 'ajv';
import type { Feed, Severity } from './types.js';

const Ajv = AjvImport as any;

/** Severity contexts the table may consult (spec §6.4). */
export interface SeverityContext {
  details?: Record<string, unknown>;
}
type SeverityRule = Severity | ((ctx: SeverityContext) => Severity);

const failedBy = (ctx: SeverityContext): Severity => {
  const finalStates = ctx.details?.finalStates;
  const words = Array.isArray(finalStates) ? finalStates.map(String) : [];
  return words.includes('offline') || words.includes('unrecovered') ? 'error' : 'warning';
};
const restoreBy = (ctx: SeverityContext): Severity => {
  switch (ctx.details?.result) {
    case 'healthy':
    case 'running':
      return 'info';
    case 'read_only':
    case 'unknown':
      return 'warning';
    case 'unrecovered':
      return 'critical';
    default:
      return 'error';
  }
};

/** Event type → severity, exactly the spec §6.4 table. */
export const EVENT_SEVERITY: Record<string, SeverityRule> = {
  // raid
  'raid.array.created': 'info',
  'raid.array.removed': 'info',
  'raid.operation.started': 'info',
  'raid.operation.observed_running': 'info',
  'raid.operation.completed': 'info',
  'raid.operation.failed': failedBy,
  'raid.state.degraded': 'error',
  'raid.state.read_only': 'error',
  'raid.state.offline': 'critical',
  'raid.state.unrecovered': 'critical',
  'raid.state.recovered': 'info',
  'raid.source.unknown_state': 'warning',
  'raid.member.offline': 'error',
  'raid.member.returned': 'info',
  'raid.spare.disconnected': 'warning',
  'raid.spare.returned': 'info',
  'raid.spare_pool.exhausted': 'warning',
  'raid.spare_pool.replenished': 'info',
  'raid.spare.replacement.completed': 'info',
  'raid.spare.replacement.failed': 'warning',
  'raid.device.error_count_increased': 'warning',
  'raid.device.fault_threshold_reached': 'error',
  'raid.device.critical_wear': 'error',
  'raid.license.expired': 'error',
  'raid.license.drive_limit_exceeded': 'error',
  'raid.restore.completed': restoreBy,
  'raid.restore.failed': 'error',
  // raid/progress
  'raid.operation.progress': 'info',
  // storage
  'filesystem.definition.added': 'info',
  'filesystem.definition.removed': 'info',
  'filesystem.mount.lost': 'error',
  'filesystem.mount.failed': 'error',
  'filesystem.mount.restored': 'info',
  'filesystem.read_only.entered': 'error',
  'filesystem.read_only.cleared': 'info',
  'filesystem.capacity.warning': 'warning',
  'filesystem.capacity.critical': 'critical',
  'filesystem.capacity.cleared': 'info',
  'storage.disk.health_degraded': 'error',
  'storage.disk.health_recovered': 'info',
  'storage.disk.wear_critical': 'error',
  'storage.disk.temperature_high': 'warning',
  'storage.disk.temperature_cleared': 'info',
  // nfs
  'nfs.service.unavailable': 'error',
  'nfs.service.recovered': 'info',
  'nfs.export.added': 'info',
  'nfs.export.changed': 'info',
  'nfs.export.removed': 'info',
  'nfs.export.backing_unavailable': 'error',
  'nfs.export.backing_recovered': 'info',
  'nfs.rdma.unavailable': 'error',
  'nfs.rdma.recovered': 'info',
  // nfs/sessions
  'nfs.session.connected': 'info',
  'nfs.session.disconnected': 'info',
  'nfs.session.protocol_changed': 'info',
  'nfs.session.lock_threshold_crossed': 'warning',
  'nfs.session.lock_threshold_cleared': 'info',
  // system
  'system.service.unavailable': 'error',
  'system.service.recovered': 'info',
  'system.agent.degraded': 'warning',
  'system.agent.offline': 'error',
  'system.agent.recovered': 'info',
  'system.collector.failed': 'warning',
  'system.collector.stale': 'warning',
  'system.collector.recovered': 'info',
  'system.network.link_down': 'warning',
  'system.network.link_up': 'info',
  'system.rdma.link_down': 'warning',
  'system.rdma.link_up': 'info',
  'system.reboot.detected': 'warning',
};

export function severityFor(type: string, ctx: SeverityContext): Severity {
  const rule = EVENT_SEVERITY[type];
  if (rule === undefined) throw new RangeError(`unknown event type '${type}'`);
  return typeof rule === 'function' ? rule(ctx) : rule;
}

/** Types whose producer needs a source xiNAS does not observe yet (D-16). */
export const SOURCE_GATED_TYPES: ReadonlySet<string> = new Set([
  'raid.spare.replacement.failed',
  'raid.device.error_count_increased',
  'raid.device.fault_threshold_reached',
  'raid.device.critical_wear',
  'raid.license.expired',
  'raid.license.drive_limit_exceeded',
  'storage.disk.health_degraded',
  'storage.disk.health_recovered',
  'storage.disk.wear_critical',
  'storage.disk.temperature_high',
  'storage.disk.temperature_cleared',
]);

export interface ProducerFamilies {
  active: string[];
  inactive: Array<{ family: string; reason: string }>;
}

/** What each feed read reports under `producers` (spec §4.4, V-58). */
export const PRODUCER_FAMILIES: Record<Feed, ProducerFamilies> = {
  raid: {
    active: [
      'raid.array',
      'raid.operation',
      'raid.state',
      'raid.member',
      'raid.spare',
      'raid.spare_pool',
      'raid.restore',
      'raid.source',
    ],
    inactive: [
      { family: 'raid.device', reason: 'no periodic error-count or wear source' },
      { family: 'raid.license', reason: 'no periodic license source' },
    ],
  },
  'raid/progress': { active: ['raid.operation.progress'], inactive: [] },
  storage: {
    active: [
      'filesystem.definition',
      'filesystem.mount',
      'filesystem.read_only',
      'filesystem.capacity',
    ],
    inactive: [
      {
        family: 'storage.disk',
        reason: 'no periodic disk-health source and no validated temperature threshold',
      },
    ],
  },
  nfs: {
    active: ['nfs.service', 'nfs.export', 'nfs.rdma'],
    inactive: [],
  },
  'nfs/sessions': { active: ['nfs.session'], inactive: [] },
  system: {
    active: [
      'system.service',
      'system.agent',
      'system.collector',
      'system.network',
      'system.rdma',
      'system.reboot',
    ],
    inactive: [],
  },
};

// ── details schemas ────────────────────────────────────────────────────

const STR = { type: 'string', maxLength: 1024 } as const;
const INT = { type: 'integer' } as const;
const NUM = { type: 'number' } as const;
const BOOL = { type: 'boolean' } as const;
const NULLABLE_STR = { type: ['string', 'null'], maxLength: 1024 } as const;
const STR_ARRAY = { type: 'array', maxItems: 64, items: STR } as const;
const ENUM = (...values: string[]) => ({ type: 'string', enum: values }) as const;

type Props = Record<string, unknown>;
/** A closed object schema; every producer may add `observedAt` (the collector sample time). */
const obj = (properties: Props): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties: { observedAt: STR, ...properties },
});

const ARRAY_OP = obj({
  array: STR,
  kind: ENUM('initialization', 'reconstruction'),
  finalStates: STR_ARRAY,
  generation: INT,
});
const ARRAY_STATE = obj({ array: STR, rawStates: STR_ARRAY });
const MEMBER = obj({ array: STR, device: STR, devicePath: STR, states: STR_ARRAY });
const SPARE = obj({ pool: STR, device: STR, array: STR });
const POOL = obj({ pool: STR, referencedBy: STR_ARRAY, drives: STR_ARRAY });
const DEVICE = obj({
  device: STR,
  devicePath: STR,
  previousCount: INT,
  currentCount: INT,
  count: INT,
  threshold: INT,
  wearPct: NUM,
});
const RESTORE = obj({
  array: STR,
  result: ENUM(
    'healthy',
    'read_only',
    'offline',
    'unrecovered',
    'degraded',
    'unhealthy',
    'running',
    'unknown',
    'not_restored',
  ),
  bootId: STR,
  rawStates: STR_ARRAY,
});
const FILESYSTEM = obj({
  filesystem: STR,
  mountpoint: STR,
  backingDevice: STR,
  mountUnitState: STR,
  mounted: BOOL,
});
const CAPACITY = obj({
  filesystem: STR,
  mountpoint: STR,
  usedPct: NUM,
  sizeBytes: NUM,
  freeBytes: NUM,
  level: ENUM('none', 'warning', 'critical'),
});
const DISK = obj({
  device: STR,
  devicePath: STR,
  model: STR,
  wearPct: NUM,
  temperatureC: NUM,
  thresholdC: NUM,
});
const UNIT = obj({ unit: STR, activeState: STR, subState: STR, loadState: STR });
const EXPORT = obj({ exportPath: STR, hostPattern: STR });
const BACKING = obj({ exportPath: STR, mountpoint: STR, filesystem: STR, reason: STR });
const RDMA = obj({ listening: BOOL, interfaces: STR_ARRAY, port: INT });
const SESSION = obj({
  clientAddr: STR,
  exportPath: STR,
  protoVersion: STR,
  lockedFiles: INT,
  threshold: INT,
  previousProtoVersion: STR,
});
const AGENT = obj({ lastSuccessfulHeartbeatAt: NULLABLE_STR, reason: STR });
const COLLECTOR = obj({
  collector: STR,
  reason: STR,
  lastAcceptedAt: NULLABLE_STR,
  pollIntervalMs: INT,
});
const LINK = obj({ interface: STR, linkState: STR, rdmaLinkState: STR, managed: BOOL });
const REBOOT = obj({ previousBootId: STR, bootId: STR });
const UNKNOWN_WORD = obj({ array: STR, word: STR });
const LICENSE = obj({ expiresAt: STR, used: INT, limit: INT });
const REPLACEMENT = obj({
  array: STR,
  replaced: STR,
  replacement: STR,
  pool: STR,
  device: STR,
  reason: ENUM('no_suitable_spare', 'replacement_failed', 'null_placeholder'),
});
const ARRAY_LIFECYCLE = obj({
  array: STR,
  level: STR,
  memberCount: INT,
  sparePool: STR,
  operationInProgress: ENUM('initialization', 'reconstruction'),
});
const PROGRESS = obj({
  array: STR,
  kind: ENUM('initialization', 'reconstruction'),
  reasonCode: STR,
});

const DETAILS_SCHEMAS: Record<string, Record<string, unknown>> = {
  'raid.array.created': ARRAY_LIFECYCLE,
  'raid.array.removed': ARRAY_LIFECYCLE,
  'raid.operation.started': ARRAY_OP,
  'raid.operation.observed_running': ARRAY_OP,
  'raid.operation.completed': ARRAY_OP,
  'raid.operation.failed': ARRAY_OP,
  'raid.state.degraded': ARRAY_STATE,
  'raid.state.read_only': ARRAY_STATE,
  'raid.state.offline': ARRAY_STATE,
  'raid.state.unrecovered': ARRAY_STATE,
  'raid.state.recovered': ARRAY_STATE,
  'raid.source.unknown_state': UNKNOWN_WORD,
  'raid.member.offline': MEMBER,
  'raid.member.returned': MEMBER,
  'raid.spare.disconnected': SPARE,
  'raid.spare.returned': SPARE,
  'raid.spare_pool.exhausted': POOL,
  'raid.spare_pool.replenished': POOL,
  'raid.spare.replacement.completed': REPLACEMENT,
  'raid.spare.replacement.failed': REPLACEMENT,
  'raid.device.error_count_increased': DEVICE,
  'raid.device.fault_threshold_reached': DEVICE,
  'raid.device.critical_wear': DEVICE,
  'raid.license.expired': LICENSE,
  'raid.license.drive_limit_exceeded': LICENSE,
  'raid.restore.completed': RESTORE,
  'raid.restore.failed': RESTORE,
  'raid.operation.progress': PROGRESS,
  'filesystem.definition.added': FILESYSTEM,
  'filesystem.definition.removed': FILESYSTEM,
  'filesystem.mount.lost': FILESYSTEM,
  'filesystem.mount.failed': FILESYSTEM,
  'filesystem.mount.restored': FILESYSTEM,
  'filesystem.read_only.entered': FILESYSTEM,
  'filesystem.read_only.cleared': FILESYSTEM,
  'filesystem.capacity.warning': CAPACITY,
  'filesystem.capacity.critical': CAPACITY,
  'filesystem.capacity.cleared': CAPACITY,
  'storage.disk.health_degraded': DISK,
  'storage.disk.health_recovered': DISK,
  'storage.disk.wear_critical': DISK,
  'storage.disk.temperature_high': DISK,
  'storage.disk.temperature_cleared': DISK,
  'nfs.service.unavailable': UNIT,
  'nfs.service.recovered': UNIT,
  'nfs.export.added': EXPORT,
  'nfs.export.changed': EXPORT,
  'nfs.export.removed': EXPORT,
  'nfs.export.backing_unavailable': BACKING,
  'nfs.export.backing_recovered': BACKING,
  'nfs.rdma.unavailable': RDMA,
  'nfs.rdma.recovered': RDMA,
  'nfs.session.connected': SESSION,
  'nfs.session.disconnected': SESSION,
  'nfs.session.protocol_changed': SESSION,
  'nfs.session.lock_threshold_crossed': SESSION,
  'nfs.session.lock_threshold_cleared': SESSION,
  'system.service.unavailable': UNIT,
  'system.service.recovered': UNIT,
  'system.agent.degraded': AGENT,
  'system.agent.offline': AGENT,
  'system.agent.recovered': AGENT,
  'system.collector.failed': COLLECTOR,
  'system.collector.stale': COLLECTOR,
  'system.collector.recovered': COLLECTOR,
  'system.network.link_down': LINK,
  'system.network.link_up': LINK,
  'system.rdma.link_down': LINK,
  'system.rdma.link_up': LINK,
  'system.reboot.detected': REBOOT,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<string, any>();
for (const [type, schema] of Object.entries(DETAILS_SCHEMAS)) {
  compiled.set(type, ajv.compile(schema));
}

/** Throws RangeError when `details` is not the closed shape for `type`. */
export function validateDetails(type: string, details: Record<string, unknown>): void {
  const validate = compiled.get(type);
  if (validate === undefined) throw new RangeError(`unknown event type '${type}'`);
  if (!validate(details)) {
    throw new RangeError(
      `event details for '${type}' are off-schema: ${ajv.errorsText(validate.errors)}`,
    );
  }
}

/** Every type the taxonomy defines, for exhaustiveness tests. */
export const EVENT_TYPES: readonly string[] = Object.keys(EVENT_SEVERITY);
