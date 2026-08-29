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
  MERGE_USEC_MAX,
  MERGE_USEC_MIN,
  NAME_RE,
  PRIO_MAX,
  PRIO_MIN,
  PRIO_MIN_MODIFY,
  REQUEST_LIMIT_MAX,
  REQUEST_LIMIT_MIN,
  RESERVED_NAMES,
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

/** One observed pool, as the array validators need it. */
export interface PoolFacts {
  drives: string[];
  /**
   * Carried for completeness, deliberately NOT a plan-time blocker: an
   * inactive pool is a legal attach target, and the executor activates it
   * at apply from a LIVE `pool_show` read under the held leases (design
   * §2.1). Blocking here on plan-time observation would be both wrong and
   * staler than the check that actually gates the operation.
   */
  active: boolean;
}

export interface CreateFacts {
  disks: ResolvedDisk[];
  existingArrayNames: string[];
  /** Disk ids already a MEMBER of an existing array. Pool drives are not
   *  here — they get their own blocker (see checkMembersNotPooled). */
  existingMemberDiskIds: Set<string>;
  /** Observed pools by name — an array may only reference one that exists. */
  poolsByName: Map<string, PoolFacts>;
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
  if (o.spare_disk_ids !== undefined) {
    throw new TypeError(
      'spec.spare_disk_ids is observed-only; create the pool via POST /api/v1/pools and send spec.spare_pool with its name',
    );
  }
  if (o.spare_pool !== undefined && o.spare_pool !== null && typeof o.spare_pool !== 'string') {
    throw new TypeError('spec.spare_pool must be a pool name string or null');
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
    push(
      'name_invalid',
      `array name '${spec.name}' must match ${NAME_RE} — xiRAID accepts at most 28 characters of Latin letters, digits and underscore (no hyphens)`,
    );
  } else if (RESERVED_NAMES.includes(spec.name)) {
    push('name_invalid', `array name '${spec.name}' is prohibited by xiRAID`);
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
  if (constraints.evenMembers && memberCount % 2 !== 0) {
    push(
      'members_not_even',
      `level ${spec.level} needs an even number of drives (got ${memberCount})`,
    );
  }
  if (constraints.needsGroupSize) {
    const groupSizeMin = constraints.groupSizeMin ?? GROUP_SIZE_MIN;
    if (spec.group_size === undefined || spec.group_size === null) {
      push('group_size_required', `level ${spec.level} requires group_size`);
    } else if (spec.group_size < groupSizeMin || spec.group_size > GROUP_SIZE_MAX) {
      push(
        'group_size_range',
        `group_size must be ${groupSizeMin}-${GROUP_SIZE_MAX} for ${spec.level} (got ${spec.group_size})`,
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
  checkMembersNotPooled(spec.member_disk_ids, facts.disks, facts.poolsByName, push);

  // --- spares (S8: reference an existing pool by name, not a derived one) ---
  checkSparePool(spec.spare_pool, facts.poolsByName, push);

  return blockers;
}

/** Live-modify writable subset (ADR-0006 matrix: spares + tuning). */
export interface XiraidArrayModifySpec {
  spare_pool?: string | null;
  tuning?: Tuning;
}

export interface ModifyFacts {
  /** Observed pools by name — an array may only reference one that exists. */
  poolsByName: Map<string, PoolFacts>;
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
  const hasSparePool = 'spare_pool' in o && o.spare_pool !== undefined;
  if (hasSparePool && o.spare_pool !== null && typeof o.spare_pool !== 'string') {
    throw new TypeError('spec.spare_pool must be a pool name string or null');
  }
  if (o.tuning !== undefined && (typeof o.tuning !== 'object' || o.tuning === null)) {
    throw new TypeError('spec.tuning must be an object');
  }
  return {
    ...(hasSparePool ? { spare_pool: o.spare_pool as string | null } : {}),
    ...(o.tuning !== undefined ? { tuning: o.tuning as Tuning } : {}),
  };
}

/** Validate a structurally valid modify spec against the facts. */
export function validateModifySpec(spec: XiraidArrayModifySpec, facts: ModifyFacts): Blocker[] {
  const blockers: Blocker[] = [];
  const push = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  checkTuning(spec.tuning ?? {}, push, 'modify');

  checkSparePool(spec.spare_pool, facts.poolsByName, push);

  return blockers;
}

// ---- shared rule helpers ----

type Push = (code: string, message: string) => void;

/**
 * Which xicli surface a tuning batch is bound for. The 4.4 command reference
 * documents different priority floors for `raid create` and `raid modify`
 * (schema.ts `PRIO_MIN` / `PRIO_MIN_MODIFY`), so the caller has to say.
 */
type TuningSurface = 'create' | 'modify';

/**
 * Range-check a tuning batch against the 4.4 command reference
 * (https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html).
 *
 * Every bound here is the vendor's. A MISSING bound is the expensive
 * direction: the plan reports no blocker, the operator confirms, and the
 * rejection arrives from `xicli` mid-apply — which is exactly what happened
 * while the four merge knobs were checked only for `>= 0` against a documented
 * range of 1-100000.
 */
function checkTuning(t: Tuning, push: Push, surface: TuningSurface = 'create'): void {
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
  // `raid modify` widens these two to 0-100; `raid create` keeps them at 1-100.
  const prioMin = surface === 'modify' ? PRIO_MIN_MODIFY : PRIO_MIN;
  range('init_prio', t.init_prio, prioMin, PRIO_MAX);
  range('restripe_prio', t.restripe_prio, prioMin, PRIO_MAX);
  // ...while these two are 1-100 on both surfaces.
  range('recon_prio', t.recon_prio, PRIO_MIN, PRIO_MAX);
  range('sdc_prio', t.sdc_prio, PRIO_MIN, PRIO_MAX);
  range('memory_limit', t.memory_limit, MEMORY_LIMIT_MIN, MEMORY_LIMIT_MAX, true);
  range('memory_prealloc', t.memory_prealloc, MEMORY_PREALLOC_MIN, MEMORY_PREALLOC_MAX, true);
  range('max_sectors_kb', t.max_sectors_kb, MAX_SECTORS_KB_MIN, MAX_SECTORS_KB_MAX, true);
  range('request_limit', t.request_limit, REQUEST_LIMIT_MIN, REQUEST_LIMIT_MAX);
  for (const field of [
    'merge_read_max',
    'merge_read_wait',
    'merge_write_max',
    'merge_write_wait',
  ] as const) {
    range(field, t[field], MERGE_USEC_MIN, MERGE_USEC_MAX);
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
      push('disk_in_use', `disk '${id}' is already a member of another array`);
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

/**
 * A drive held by a spare pool is NOT free, and after S8 nothing else
 * catches it at plan time: `existingMemberDiskIds` means array members
 * only, and `safe_for_use` is `!system_disk && !mounted`
 * (`lib/parse/disk.ts`), which stays true for a pool member. Without this
 * the conflict is first reported by the daemon MID-APPLY — precisely the
 * failure mode this change exists to remove. The pool surface keeps pool
 * drives out of the TUI's free-drive picker, but that is a picker, not a
 * preflight: REST, MCP and CLI clients get no such protection.
 *
 * Deliberately NOT `disk_in_use`: the remedy differs. `disk_in_use` means
 * "pick another drive"; this one can also be resolved by removing the
 * drive from the pool, so the message names the pool holding it.
 */
function checkMembersNotPooled(
  ids: string[],
  disks: ResolvedDisk[],
  poolsByName: Map<string, PoolFacts>,
  push: Push,
): void {
  if (poolsByName.size === 0) return;
  const poolByDrive = new Map<string, string>();
  for (const [name, pool] of poolsByName) {
    for (const drive of pool.drives) {
      if (!poolByDrive.has(drive)) poolByDrive.set(drive, name);
    }
  }
  const pathById = new Map(disks.map((d) => [d.id, d.device_path]));
  for (const id of ids) {
    const path = pathById.get(id);
    if (path === undefined) continue; // unknown disk — `disk_not_found` covers it
    const pool = poolByDrive.get(path);
    if (pool !== undefined) {
      push(
        'disk_in_spare_pool',
        `disk '${id}' (${path}) belongs to spare pool '${pool}' — remove it from the pool (TUI: Storage > Spare Pools) or choose another drive`,
      );
    }
  }
}

/**
 * An array's spare pool is now a REFERENCE, not something the plan builds
 * (S8 / ADR-0006 §Spare pools). Two failure modes matter here, distinctly:
 * a name that resolves to nothing (typo, or the pool was never created —
 * the daemon has no "create if missing" behavior for pools), and a name
 * that resolves to a pool with zero drives, which xiRAID's daemon accepts
 * as a `sparepool` argument but that can never actually serve a spare —
 * `spare_disk_ids` on the resulting array reads back empty either way, so
 * this catches it before the operator is left wondering why.
 */
function checkSparePool(
  name: string | null | undefined,
  poolsByName: Map<string, PoolFacts>,
  push: Push,
): void {
  if (name === undefined || name === null || name === '') return;
  const pool = poolsByName.get(name);
  if (pool === undefined) {
    push(
      'spare_pool_not_found',
      `spare pool '${name}' does not exist — create it via POST /api/v1/pools (TUI: Storage > Spare Pools) first`,
    );
  } else if (pool.drives.length === 0) {
    push('spare_pool_empty', `spare pool '${name}' has no drives`);
  }
}
