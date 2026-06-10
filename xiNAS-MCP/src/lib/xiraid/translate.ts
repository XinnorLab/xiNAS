/**
 * Control-path XiraidArraySpec → xiRAID gRPC RaidCreateRequest
 * (ADR-0006 §Validation and translation).
 *
 * - `level` strips the `raid` prefix (`raid6` → `"6"`); `n+m` passes through.
 * - `member_disk_ids` resolve to device paths via the caller-supplied map
 *   (the api plan provider resolves it from observed Disk state and embeds
 *   it in the spec as `device_by_id`; the executor passes it back in here).
 * - `null`/absent tuning fields are OMITTED → xiRAID's own defaults apply.
 * - Booleans map to the proto's uint 0/1 fields where the gRPC interface
 *   says `number`; `single_run`/`force_metadata` stay boolean.
 * - NEVER emits `force` (ADR-0006 §Excluded parameters).
 *
 * Pure. No I/O.
 */

import type { RaidCreateRequest, RaidModifyRequest } from '../../grpc/raid.js';
import type { Tuning, XiraidArraySpec } from './schema.js';
import { derivedPoolName } from './validate.js';

export function toRaidCreateRequest(
  spec: XiraidArraySpec,
  deviceById: ReadonlyMap<string, string>,
): RaidCreateRequest {
  const drives = spec.member_disk_ids.map((id) => {
    const path = deviceById.get(id);
    if (path === undefined) {
      throw new Error(`toRaidCreateRequest: no device path resolved for disk id '${id}'`);
    }
    return path;
  });

  const t = spec.tuning ?? {};
  return {
    name: spec.name,
    level: spec.level === 'n+m' ? 'n+m' : spec.level.replace(/^raid/, ''),
    drives,
    // S4: spares ride the executor-provisioned xnsp_<name> pool (the
    // executor pool_creates + pool_activates it before raid_create).
    ...((spec.spare_disk_ids ?? []).length > 0 ? { sparepool: derivedPoolName(spec.name) } : {}),
    ...num('group_size', spec.group_size),
    ...num('synd_cnt', spec.synd_cnt),
    ...num('strip_size', spec.strip_size_kib),
    ...num('block_size', spec.block_size),
    ...(spec.force_metadata === true ? { force_metadata: true } : {}),
    ...num('init_prio', t.init_prio),
    ...num('recon_prio', t.recon_prio),
    ...num('restripe_prio', t.restripe_prio),
    ...bool01('resync_enabled', t.resync_enabled),
    ...bool01('sched_enabled', t.sched_enabled),
    ...bool01('merge_read_enabled', t.merge_read_enabled),
    ...bool01('merge_write_enabled', t.merge_write_enabled),
    ...num('merge_read_max', t.merge_read_max),
    ...num('merge_read_wait', t.merge_read_wait),
    ...num('merge_write_max', t.merge_write_max),
    ...num('merge_write_wait', t.merge_write_wait),
    ...num('memory_limit', t.memory_limit),
    ...num('request_limit', t.request_limit),
    ...num('memory_prealloc', t.memory_prealloc),
    ...bool01('adaptive_merge', t.adaptive_merge),
    ...(t.cpu_allowed !== undefined && t.cpu_allowed !== null
      ? { cpu_allowed: t.cpu_allowed }
      : {}),
    ...num('max_sectors_kb', t.max_sectors_kb),
    ...num('sdc_prio', t.sdc_prio),
    ...(t.single_run !== undefined && t.single_run !== null ? { single_run: t.single_run } : {}),
    ...bool01('discard', t.discard),
    ...bool01('drive_trim', t.drive_trim),
  };
}

/**
 * Build a raid_modify request: a sparepool change (attach = pool name,
 * detach = '') and/or a tuning batch. Same null-dropping + boolean→0/1
 * conventions as create; NEVER emits `force`.
 */
export function toRaidModifyRequest(
  name: string,
  change: { sparepool?: string; tuning?: Tuning },
): RaidModifyRequest {
  const t = change.tuning ?? {};
  return {
    name,
    ...(change.sparepool !== undefined ? { sparepool: change.sparepool } : {}),
    ...num('init_prio', t.init_prio),
    ...num('recon_prio', t.recon_prio),
    ...num('restripe_prio', t.restripe_prio),
    ...bool01('sched_enabled', t.sched_enabled),
    ...bool01('merge_read_enabled', t.merge_read_enabled),
    ...bool01('merge_write_enabled', t.merge_write_enabled),
    ...num('merge_read_max', t.merge_read_max),
    ...num('merge_read_wait', t.merge_read_wait),
    ...num('merge_write_max', t.merge_write_max),
    ...num('merge_write_wait', t.merge_write_wait),
    ...num('memory_limit', t.memory_limit),
    ...num('request_limit', t.request_limit),
    ...num('memory_prealloc', t.memory_prealloc),
    ...bool01('adaptive_merge', t.adaptive_merge),
    ...(t.cpu_allowed !== undefined && t.cpu_allowed !== null
      ? { cpu_allowed: t.cpu_allowed }
      : {}),
    ...num('max_sectors_kb', t.max_sectors_kb),
    ...num('sdc_prio', t.sdc_prio),
    ...(t.single_run !== undefined && t.single_run !== null ? { single_run: t.single_run } : {}),
    ...bool01('discard', t.discard),
    ...bool01('drive_trim', t.drive_trim),
    // resync_enabled is a CREATE-time knob (proto RaidCreate field 12);
    // RaidModify has no such field (force_resync is a different semantic),
    // so a modify-time resync_enabled is silently dropped here.
  };
}

function num<K extends string>(
  key: K,
  value: number | null | undefined,
): Partial<Record<K, number>> {
  return value !== undefined && value !== null ? ({ [key]: value } as Record<K, number>) : {};
}

function bool01<K extends string>(
  key: K,
  value: boolean | null | undefined,
): Partial<Record<K, number>> {
  return value !== undefined && value !== null
    ? ({ [key]: value ? 1 : 0 } as Record<K, number>)
    : {};
}
