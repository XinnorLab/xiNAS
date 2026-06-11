/**
 * RAID-semantic create-spec validation (ADR-0006 §Preflight blockers).
 *
 * Pure: disk/array facts are passed in by the caller, so the SAME rules
 * run in the api plan provider (against observed Disk/XiraidArray state)
 * and in the agent executor's preflight re-check (against live facts).
 * No KV, no gRPC, no I/O here.
 */

import {
  BLOCK_SIZES,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  LEVELS,
  LEVEL_CONSTRAINTS,
  type Level,
  MAX_SECTORS_KB_MAX,
  MAX_SECTORS_KB_MIN,
  MEMORY_LIMIT_MAX,
  MEMORY_LIMIT_MIN,
  MEMORY_PREALLOC_MAX,
  MEMORY_PREALLOC_MIN,
  NAME_RE,
  PRIO_MAX,
  PRIO_MIN,
  STRIP_SIZES_KIB,
  SYND_CNT_MAX,
  SYND_CNT_MIN,
  type Tuning,
  type XiraidArraySpec,
} from './schema.js';

/** Plan blocker (api-v1.yaml Blocker subset; evidence added by the caller). */
export interface Blocker {
  code: string;
  message: string;
}

/** Disk facts the caller resolved (api: observed state; agent: live probe). */
export interface ResolvedDisk {
  id: string;
  device_path: string;
  safe_for_use: boolean;
  system_disk: boolean;
  mounted: boolean;
}

export interface CreateFacts {
  disks: ResolvedDisk[];
  existingArrayNames: string[];
  /** Disk ids already a member or spare of any existing array. */
  existingMemberDiskIds: Set<string>;
}

/**
 * Narrow an unknown payload to a structurally valid XiraidArraySpec.
 * Throws TypeError on junk (callers map it to INVALID_ARGUMENT);
 * RAID-semantic problems are NOT checked here — that is
 * {@link validateCreateSpec}'s job (they become plan blockers).
 */
export function parseCreateSpec(input: unknown): XiraidArraySpec {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('create spec must be an object');
  }
  const o = input as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new TypeError('spec.name must be a string');
  if (typeof o.level !== 'string' || !(LEVELS as readonly string[]).includes(o.level)) {
    throw new TypeError(`spec.level must be one of ${LEVELS.join(', ')}`);
  }
  if (!Array.isArray(o.member_disk_ids) || o.member_disk_ids.some((m) => typeof m !== 'string')) {
    throw new TypeError('spec.member_disk_ids must be an array of strings');
  }
  if (
    o.spare_disk_ids !== undefined &&
    (!Array.isArray(o.spare_disk_ids) || o.spare_disk_ids.some((m) => typeof m !== 'string'))
  ) {
    throw new TypeError('spec.spare_disk_ids must be an array of strings');
  }
  if (o.tuning !== undefined && (typeof o.tuning !== 'object' || o.tuning === null)) {
    throw new TypeError('spec.tuning must be an object');
  }
  return input as XiraidArraySpec;
}

/** Validate a structurally valid create spec against the facts. */
export function validateCreateSpec(spec: XiraidArraySpec, facts: CreateFacts): Blocker[] {
  const blockers: Blocker[] = [];
  const push = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  // --- name ---
  if (!NAME_RE.test(spec.name)) {
    push('name_invalid', `array name '${spec.name}' must match ${NAME_RE}`);
  } else if (facts.existingArrayNames.includes(spec.name)) {
    push('name_taken', `an array named '${spec.name}' already exists`);
  }

  // --- level topology ---
  const constraints = LEVEL_CONSTRAINTS[spec.level as Level];
  const memberCount = spec.member_disk_ids.length;
  if (memberCount < constraints.minDrives) {
    push(
      'min_drives',
      `level ${spec.level} needs at least ${constraints.minDrives} drives (got ${memberCount})`,
    );
  }
  if (constraints.needsGroupSize) {
    if (spec.group_size === undefined || spec.group_size === null) {
      push('group_size_required', `level ${spec.level} requires group_size`);
    } else if (spec.group_size < GROUP_SIZE_MIN || spec.group_size > GROUP_SIZE_MAX) {
      push(
        'group_size_range',
        `group_size must be ${GROUP_SIZE_MIN}-${GROUP_SIZE_MAX} (got ${spec.group_size})`,
      );
    } else if (memberCount % spec.group_size !== 0 || memberCount / spec.group_size < 2) {
      // compound levels need an even split into >= 2 groups
      push(
        'members_not_divisible_by_group',
        `${memberCount} members do not split evenly into >= 2 groups of ${spec.group_size}`,
      );
    }
  }
  if (constraints.needsSyndCnt) {
    if (spec.synd_cnt === undefined || spec.synd_cnt === null) {
      push('synd_cnt_required', `level ${spec.level} requires synd_cnt`);
    } else if (spec.synd_cnt < SYND_CNT_MIN || spec.synd_cnt > SYND_CNT_MAX) {
      push(
        'synd_cnt_range',
        `synd_cnt must be ${SYND_CNT_MIN}-${SYND_CNT_MAX} (got ${spec.synd_cnt})`,
      );
    }
  }

  // --- geometry ---
  if (
    spec.strip_size_kib !== undefined &&
    spec.strip_size_kib !== null &&
    !(STRIP_SIZES_KIB as readonly number[]).includes(spec.strip_size_kib)
  ) {
    push('strip_size_invalid', `strip_size_kib must be one of ${STRIP_SIZES_KIB.join(', ')}`);
  }
  if (
    spec.block_size !== undefined &&
    spec.block_size !== null &&
    !(BLOCK_SIZES as readonly number[]).includes(spec.block_size)
  ) {
    push('block_size_invalid', `block_size must be one of ${BLOCK_SIZES.join(', ')}`);
  }

  // --- tuning ranges (api_behavior_doc §3.4) ---
  checkTuning(spec.tuning ?? {}, push);

  // --- member disks (one blocker per offending disk) ---
  checkDisks(spec.member_disk_ids, facts.disks, facts.existingMemberDiskIds, push);

  // --- spares (S4: validated like members — ADR-0006 §Spare pools) ---
  const spares = spec.spare_disk_ids ?? [];
  if (spares.length > 0) {
    // a spare that is also a member of this very spec is double-booked
    const memberSet = new Set(spec.member_disk_ids);
    const claimed = new Set([...facts.existingMemberDiskIds, ...memberSet]);
    checkDisks(spares, facts.disks, claimed, push);
    checkDerivedPoolName(spec.name, push);
  }

  return blockers;
}

/** Live-modify writable subset (ADR-0006 matrix: spares + tuning). */
export interface XiraidArrayModifySpec {
  spare_disk_ids?: string[];
  tuning?: Tuning;
}

export interface ModifyFacts {
  /** The target array's name (derives the xnsp_ pool name). */
  arrayName: string;
  disks: ResolvedDisk[];
  /** Disk ids claimed as member/spare by ANY array (incl. this one). */
  existingMemberDiskIds: Set<string>;
  /** This array's OWN current spares — exempt from disk_in_use. */
  ownSpareDiskIds: Set<string>;
}

/**
 * Narrow an unknown payload to a structurally valid modify spec. TOLERANT:
 * unknown keys (the api's enrichment — `id`, `device_by_id`, `current_*`)
 * are ignored, NOT rejected — the route's apply re-check re-parses the
 * persisted enriched spec and must accept its own plan (S4 spec §8).
 * Topology-key rejection is the ROUTE's job against the raw PATCH body.
 */
export function parseModifySpec(input: unknown): XiraidArrayModifySpec {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('modify spec must be an object');
  }
  const o = input as Record<string, unknown>;
  if (
    o.spare_disk_ids !== undefined &&
    (!Array.isArray(o.spare_disk_ids) || o.spare_disk_ids.some((m) => typeof m !== 'string'))
  ) {
    throw new TypeError('spec.spare_disk_ids must be an array of strings');
  }
  if (o.tuning !== undefined && (typeof o.tuning !== 'object' || o.tuning === null)) {
    throw new TypeError('spec.tuning must be an object');
  }
  return {
    ...(o.spare_disk_ids !== undefined ? { spare_disk_ids: o.spare_disk_ids as string[] } : {}),
    ...(o.tuning !== undefined ? { tuning: o.tuning as Tuning } : {}),
  };
}

/** Validate a structurally valid modify spec against the facts. */
export function validateModifySpec(spec: XiraidArrayModifySpec, facts: ModifyFacts): Blocker[] {
  const blockers: Blocker[] = [];
  const push = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  checkTuning(spec.tuning ?? {}, push);

  if (spec.spare_disk_ids !== undefined && spec.spare_disk_ids.length > 0) {
    // this array's own current spares are not "in use" — re-listing keeps them
    const claimedByOthers = new Set(
      [...facts.existingMemberDiskIds].filter((id) => !facts.ownSpareDiskIds.has(id)),
    );
    checkDisks(spec.spare_disk_ids, facts.disks, claimedByOthers, push);
    checkDerivedPoolName(facts.arrayName, push);
  }

  return blockers;
}

// ---- shared rule helpers ----

type Push = (code: string, message: string) => void;

function checkTuning(t: Tuning, push: Push): void {
  const range = (
    field: string,
    value: number | null | undefined,
    min: number,
    max: number,
    zeroOk = false,
  ): void => {
    if (value === undefined || value === null) return;
    if (zeroOk && value === 0) return;
    if (value < min || value > max) {
      push('param_out_of_range', `tuning.${field} must be ${min}-${max}${zeroOk ? ' or 0' : ''}`);
    }
  };
  range('init_prio', t.init_prio, PRIO_MIN, PRIO_MAX);
  range('recon_prio', t.recon_prio, PRIO_MIN, PRIO_MAX);
  range('restripe_prio', t.restripe_prio, PRIO_MIN, PRIO_MAX);
  range('sdc_prio', t.sdc_prio, PRIO_MIN, PRIO_MAX);
  range('memory_limit', t.memory_limit, MEMORY_LIMIT_MIN, MEMORY_LIMIT_MAX, true);
  range('memory_prealloc', t.memory_prealloc, MEMORY_PREALLOC_MIN, MEMORY_PREALLOC_MAX, true);
  range('max_sectors_kb', t.max_sectors_kb, MAX_SECTORS_KB_MIN, MAX_SECTORS_KB_MAX, true);
  for (const field of [
    'merge_read_max',
    'merge_read_wait',
    'merge_write_max',
    'merge_write_wait',
    'request_limit',
  ] as const) {
    const value = t[field];
    if (value !== undefined && value !== null && value < 0) {
      push('param_out_of_range', `tuning.${field} must be >= 0`);
    }
  }
}

/** One blocker per offending disk (member or spare, create or modify). */
function checkDisks(
  ids: string[],
  disks: ResolvedDisk[],
  claimedIds: ReadonlySet<string>,
  push: Push,
): void {
  const byId = new Map(disks.map((d) => [d.id, d]));
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) {
      push('disk_not_found', `disk '${id}' is not present in observed state`);
      continue;
    }
    if (claimedIds.has(id)) {
      push('disk_in_use', `disk '${id}' is already a member/spare of another array`);
      continue;
    }
    if (d.system_disk) {
      push('disk_is_system', `disk '${id}' (${d.device_path}) holds the system partitions`);
      continue;
    }
    if (!d.safe_for_use) {
      push(
        'disk_not_safe',
        `disk '${id}' (${d.device_path}) is not safe for use (mounted or in use)`,
      );
    }
  }
}

/** The executor-owned pool is named xnsp_<array>; it must fit the namespace. */
export function derivedPoolName(arrayName: string): string {
  return `xnsp_${arrayName}`;
}

function checkDerivedPoolName(arrayName: string, push: Push): void {
  if (derivedPoolName(arrayName).length > 63) {
    push(
      'name_invalid',
      `array name '${arrayName}' is too long for a spare pool: 'xnsp_' + name must fit 63 chars`,
    );
  }
}
