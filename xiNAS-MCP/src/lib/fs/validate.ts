/**
 * Per-operation validation for the S5 filesystem adapter (ADR-0007
 * blocker codes). Pure: every fact is injected — the api providers feed
 * observed/desired state, executors re-check what they can live.
 *
 * parseFsCreateSpec / parsePatchIntent are TOLERANT of unknown keys
 * (the api's enrichment must re-parse for the apply re-check, the S4
 * pattern); topology/identity rejection on PATCH is the ROUTE's job
 * against the raw body (FS_IDENTITY_FIELDS).
 */

import type { BackingArraySpec } from './derive.js';
import { deriveStripe } from './derive.js';
import { type QuotaMode, unitNameForMountpoint } from './unit.js';

export interface Blocker {
  code: string;
  message: string;
}

const QUOTA_MODES: ReadonlySet<string> = new Set(['none', 'uquota', 'gquota', 'pquota']);

/** Identity fields — immutable after create (ADR-0007 matrix). */
export const FS_IDENTITY_FIELDS = [
  'mountpoint',
  'backing_device',
  'log_device',
  'label',
  'su_kb',
  'sw',
  'sector_size',
  'log_size',
  'fs_type',
  'mount_options',
  'owner_policy',
  'force',
] as const;

export interface FsCreateSpec {
  backing_device: string;
  mountpoint: string;
  fs_type?: 'xfs';
  label?: string | null;
  log_device?: string | null;
  log_size?: string | null;
  sector_size?: number | null;
  su_kb?: number | null;
  sw?: number | null;
  force?: boolean;
  mount_options?: string[];
  quota_mode?: QuotaMode;
  owner_policy?: { uid?: number; gid?: number; mode?: string };
}

/** Structurally narrow an unknown create payload (junk → TypeError). */
export function parseFsCreateSpec(input: unknown): FsCreateSpec {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('create spec must be an object');
  }
  const o = input as Record<string, unknown>;
  if (typeof o.backing_device !== 'string' || o.backing_device.length === 0) {
    throw new TypeError('spec.backing_device must be a non-empty string');
  }
  if (typeof o.mountpoint !== 'string' || o.mountpoint.length === 0) {
    throw new TypeError('spec.mountpoint must be a non-empty string');
  }
  if (o.quota_mode !== undefined && !QUOTA_MODES.has(o.quota_mode as string)) {
    throw new TypeError(`spec.quota_mode must be one of ${[...QUOTA_MODES].join(', ')}`);
  }
  if (
    o.mount_options !== undefined &&
    (!Array.isArray(o.mount_options) || o.mount_options.some((m) => typeof m !== 'string'))
  ) {
    throw new TypeError('spec.mount_options must be an array of strings');
  }
  return input as FsCreateSpec;
}

/** A known array volume the create may target. */
export interface FsCreateFacts {
  /** observed XiraidArray specs keyed by their volume_path. */
  arraysByVolume: Map<string, BackingArraySpec & { name: string }>;
  /** observed Filesystems (id = unit name). */
  filesystems: Array<{ id: string; mountpoint?: string; backing_device?: string }>;
}

export function validateFsCreate(spec: FsCreateSpec, facts: FsCreateFacts): Blocker[] {
  const blockers: Blocker[] = [];
  const push = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  // --- mountpoint ---
  if (!spec.mountpoint.startsWith('/')) {
    push('mountpoint_invalid', `mountpoint '${spec.mountpoint}' must be an absolute path`);
  } else {
    const unitName = unitNameForMountpoint(spec.mountpoint);
    const clash = facts.filesystems.find(
      (f) => f.id === unitName || f.mountpoint === spec.mountpoint,
    );
    if (clash) {
      push(
        'mountpoint_taken',
        `a managed filesystem already exists at ${spec.mountpoint} (${clash.id})`,
      );
    }
  }

  // --- backing / log devices must be observed array volumes ---
  const backing = facts.arraysByVolume.get(spec.backing_device);
  if (!backing) {
    push(
      'backing_array_not_found',
      `${spec.backing_device} is not an observed XiraidArray volume — the control path formats only array volumes`,
    );
  }
  const occupied = facts.filesystems.find((f) => f.backing_device === spec.backing_device);
  if (occupied) {
    push('backing_device_in_use', `${spec.backing_device} already backs ${occupied.id}`);
  }
  if (spec.log_device !== undefined && spec.log_device !== null) {
    if (!facts.arraysByVolume.has(spec.log_device)) {
      push('log_array_not_found', `${spec.log_device} is not an observed XiraidArray volume`);
    }
  }

  // --- stripe geometry ---
  const hasOverride =
    spec.su_kb !== undefined && spec.su_kb !== null && spec.sw !== undefined && spec.sw !== null;
  if (!hasOverride && backing && deriveStripe(backing) === undefined) {
    push(
      'stripe_underivable',
      `the geometry of ${spec.backing_device} (level/strip size) is not observable — pass su_kb + sw explicitly`,
    );
  }

  // --- the destruction gate's advisory (the engine enforces at apply) ---
  if (spec.force === true) {
    push(
      'dangerous_flag_required',
      'force:true overwrites any existing filesystem on the device; apply must carry dangerous: true',
    );
  }

  return blockers;
}

// ---- per-op facts + validations ----

export function validateFsMount(facts: { arrayState: string | undefined }): Blocker[] {
  if (facts.arrayState === 'failed') {
    return [
      {
        code: 'backing_array_unhealthy',
        message: 'the backing array is failed — repair it before mounting',
      },
    ];
  }
  return [];
}

export function validateFsUnmount(facts: {
  sessionsUnder: Array<{ id: string; export_path: string }>;
  exportsUnder: string[];
}): Blocker[] {
  const blockers: Blocker[] = [];
  if (facts.sessionsUnder.length > 0) {
    blockers.push({
      code: 'dependent_share_active',
      message: `${facts.sessionsUnder.length} active NFS session(s) under the mountpoint — disconnect clients first`,
    });
  }
  if (facts.exportsUnder.length > 0) {
    blockers.push({
      code: 'mountpoint_exported',
      message: `exported path(s) under the mountpoint (${facts.exportsUnder.join(', ')}) — remove the exports first`,
    });
  }
  return blockers;
}

export function validateFsGrow(facts: { mounted: boolean }): Blocker[] {
  return facts.mounted
    ? []
    : [{ code: 'fs_not_mounted', message: 'xfs_growfs requires the filesystem to be mounted' }];
}

export function validateFsUnmanage(facts: { mounted: boolean }): Blocker[] {
  return facts.mounted
    ? [{ code: 'fs_mounted', message: 'unmount the filesystem before removing it from management' }]
    : [];
}

// ---- PATCH intent narrowing (one intent per request, ADR-0007) ----

export type PatchIntent =
  | { kind: 'mount' }
  | { kind: 'unmount' }
  | { kind: 'grow' }
  | { kind: 'quota'; quota_mode: QuotaMode };

export function parsePatchIntent(spec: unknown): PatchIntent {
  if (typeof spec !== 'object' || spec === null) {
    throw new TypeError('PATCH spec must be an object');
  }
  const o = spec as Record<string, unknown>;
  const intents: PatchIntent[] = [];
  if ('mounted' in o) {
    if (typeof o.mounted !== 'boolean') throw new TypeError('mounted must be a boolean');
    intents.push({ kind: o.mounted ? 'mount' : 'unmount' });
  }
  if ('grow' in o) {
    if (o.grow !== true) throw new TypeError('grow must be exactly true');
    intents.push({ kind: 'grow' });
  }
  if ('quota_mode' in o) {
    if (!QUOTA_MODES.has(o.quota_mode as string)) {
      throw new TypeError(`quota_mode must be one of ${[...QUOTA_MODES].join(', ')}`);
    }
    intents.push({ kind: 'quota', quota_mode: o.quota_mode as QuotaMode });
  }
  if (intents.length !== 1) {
    throw new TypeError(
      'exactly one intent per PATCH: one of mounted (boolean), grow: true, or quota_mode',
    );
  }
  return intents[0] as PatchIntent;
}

/** True when `path` is at or under `root` (path-segment aware). */
export function isUnderPath(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix);
}
