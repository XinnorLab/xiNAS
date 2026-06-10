/**
 * xiraid.array.create executor (S3 T9, ADR-0006 §Per-operation contracts).
 *
 * Stages: preflight → create → wait_online → verify. The runner wraps them
 * with snapshot_before/after and drives rollback on a stage failure.
 *
 * STATELESS across runs: rollback decides from a live raid_show — the array
 * name present → destroy it, absent → nothing to undo. That makes rollback
 * correct for a preflight failure (nothing created), a create that failed
 * cleanly, a create that failed after partially registering the array, and
 * a re-run after an agent crash.
 *
 * The spec arriving in task.begin is the api-enriched spec (T7): the
 * create-shaped fields plus `device_by_id` (Disk id → device path) resolved
 * at plan time, so this executor needs no KV access (ExecutorContext is
 * deliberately spec-only).
 */

import { derivedPoolName, parseCreateSpec } from '../../lib/xiraid/validate.js';
import { toRaidCreateRequest, toRaidModifyRequest } from '../../lib/xiraid/translate.js';
import type { XiraidClient } from '../xiraid/client.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

export interface XiraidArrayCreateExecutorOptions {
  client: XiraidClient;
  /** wait_online poll cadence; injectable for tests. */
  pollIntervalMs?: number;
  /** wait_online bound — initializing arrays count as created well before
   *  a full init completes, so this only guards a daemon that never
   *  surfaces the array. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ShownArray {
  name: string;
  devices: string[];
  states: string[];
}

/** Minimal tolerant read of the raid_show payload (name/devices/state). */
function readShow(payload: unknown): ShownArray[] {
  if (!Array.isArray(payload)) return [];
  const out: ShownArray[] = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string') continue;
    const devices = Array.isArray(o.devices)
      ? o.devices.filter((d): d is string => typeof d === 'string')
      : [];
    const states =
      typeof o.state === 'string'
        ? [o.state.toLowerCase()]
        : Array.isArray(o.state)
          ? o.state.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase())
          : [];
    out.push({ name: o.name, devices, states });
  }
  return out;
}

/** States that mean "the array is up" for wait_online purposes. */
const ONLINE_STATES = new Set(['online', 'initialized', 'initializing', 'reconstructing']);

function narrowSpec(ctx: ExecutorContext): {
  spec: ReturnType<typeof parseCreateSpec>;
  deviceById: Map<string, string>;
} {
  const spec = parseCreateSpec(ctx.spec);
  const raw = (ctx.spec as Record<string, unknown>).device_by_id;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('xiraid.array.create: spec is missing the plan-resolved device_by_id map');
  }
  const deviceById = new Map<string, string>();
  for (const [id, path] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof path === 'string') deviceById.set(id, path);
  }
  return { spec, deviceById };
}

function checkCancelled(ctx: ExecutorContext, stage: string): void {
  if (ctx.isCancelRequested()) {
    throw new Error(`xiraid.array.create: cancelled before ${stage}`);
  }
}

export function makeXiraidArrayCreateExecutor(opts: XiraidArrayCreateExecutorOptions): Executor {
  const client = opts.client;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const { spec, deviceById } = narrowSpec(ctx);
      const shown = readShow(await client.raidShow());

      if (shown.some((a) => a.name === spec.name)) {
        throw new Error(`preflight: an array named '${spec.name}' already exists on the daemon`);
      }
      const claimed = new Set(shown.flatMap((a) => a.devices));
      for (const id of spec.member_disk_ids) {
        const path = deviceById.get(id);
        if (path === undefined) {
          throw new Error(`preflight: no resolved device path for member disk '${id}'`);
        }
        if (claimed.has(path)) {
          throw new Error(`preflight: device ${path} (disk '${id}') is already an array member`);
        }
      }
      ctx.emitOutput(
        `preflight ok: name '${spec.name}' free, ${spec.member_disk_ids.length} member devices unclaimed`,
      );
    },
  };

  const create: ExecutorStage = {
    name: 'create',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'create');
      const { spec, deviceById } = narrowSpec(ctx);

      // S4 T4: spares ride an executor-provisioned pool — created AND
      // activated before raid_create (an unactivated pool never
      // auto-replaces; analyst doc §3.8).
      const spares = spec.spare_disk_ids ?? [];
      if (spares.length > 0) {
        const poolName = derivedPoolName(spec.name);
        const spareDrives = spares.map((id) => {
          const path = deviceById.get(id);
          if (path === undefined) {
            throw new Error(`create: no resolved device path for spare disk '${id}'`);
          }
          return path;
        });
        ctx.emitOutput(`pool_create ${poolName} drives=${spareDrives.join(',')}`);
        await client.poolCreate({ name: poolName, drives: spareDrives });
        await client.poolActivate({ name: poolName });
        ctx.emitOutput(`pool ${poolName} active`);
      }

      const req = toRaidCreateRequest(spec, deviceById);
      ctx.emitOutput(`raid_create ${req.name} level=${req.level} drives=${req.drives.join(',')}`);
      await client.raidCreate(req);
      ctx.emitOutput(`raid_create ${req.name}: accepted`);
    },
  };

  const waitOnline: ExecutorStage = {
    name: 'wait_online',
    async run(ctx: ExecutorContext): Promise<void> {
      const { spec } = narrowSpec(ctx);
      let waited = 0;
      for (;;) {
        checkCancelled(ctx, 'wait_online poll');
        const found = readShow(await client.raidShow()).find((a) => a.name === spec.name);
        if (found && found.states.some((s) => ONLINE_STATES.has(s))) {
          ctx.emitOutput(`array '${spec.name}' is up (state: ${found.states.join(',')})`);
          return;
        }
        if (waited >= timeoutMs) {
          throw new Error(
            `wait_online: array '${spec.name}' did not come up within ${timeoutMs}ms`,
          );
        }
        await sleep(pollIntervalMs);
        waited += pollIntervalMs;
      }
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const { spec } = narrowSpec(ctx);
      const found = readShow(await client.raidShow()).find((a) => a.name === spec.name);
      if (!found) {
        throw new Error(`verify: array '${spec.name}' is not visible in raid_show`);
      }
      ctx.emitOutput(`verify ok: /dev/xi_${spec.name} (${found.devices.length} members)`);
    },
  };

  return {
    operation_kind: 'xiraid.array.create',
    stages: [preflight, create, waitOnline, verify],

    async rollback(ctx: ExecutorContext): Promise<void> {
      // Rollback needs only the name. A spec that never parsed cannot have
      // created anything — treat it as nothing-to-undo rather than failing
      // the rollback into requires_manual_recovery.
      let name: string;
      try {
        name = parseCreateSpec(ctx.spec).name;
      } catch {
        ctx.emitOutput('rollback: spec unparsable — nothing was created, nothing to undo');
        return;
      }
      // Live-state decision (crash-safe, no per-run flag): destroy only what
      // raid_show says exists. A show/destroy failure here propagates → the
      // runner emits rollback_failed → requires_manual_recovery.
      const exists = readShow(await client.raidShow()).some((a) => a.name === name);
      if (exists) {
        ctx.emitOutput(`rollback: destroying partially created array '${name}'`);
        await client.raidDestroy({ name, force: true });
        ctx.emitOutput(`rollback: '${name}' destroyed`);
      } else {
        ctx.emitOutput(`rollback: array '${name}' was never created — nothing to undo`);
      }

      // S4 T4: clean a pool this run may have provisioned (pool_create
      // happens BEFORE raid_create, so a clean create failure can leave the
      // pool behind). Live poolShow decides — same crash-safe principle.
      const poolName = derivedPoolName(name);
      const pools = (await client.poolShow()) as unknown;
      const pool = Array.isArray(pools)
        ? (pools as Array<Record<string, unknown>>).find((p) => p.name === poolName)
        : undefined;
      if (pool) {
        if (pool.active === true) {
          await client.poolDeactivate({ name: poolName });
        }
        await client.poolDelete({ name: poolName });
        ctx.emitOutput(`rollback: spare pool '${poolName}' removed`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// xiraid.array.modify executor (S4 T6, ADR-0006 §Modify / §Spare pools)
// ---------------------------------------------------------------------------

interface ModifyExecSpec {
  id: string;
  spare_disk_ids?: string[];
  tuning?: Record<string, unknown>;
  device_by_id: Map<string, string>;
}

/** Pool/array pre-state captured LIVE at preflight; keyed by ctx.spec object
 *  identity (the runner hands the same spec object to every stage and to
 *  rollback within one run), so the singleton executor carries no cross-task
 *  state. After an agent crash the map is empty — but the runner only calls
 *  rollback in-process, so that path cannot observe a missing entry. */
interface ModifyPreState {
  arraySparepool: string;
  poolExisted: boolean;
  poolDrives: string[];
  poolActive: boolean;
}

function narrowModifySpec(ctx: ExecutorContext): ModifyExecSpec {
  const o = ctx.spec as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.id !== 'string') {
    throw new Error('xiraid.array.modify: spec is missing the target array id');
  }
  const deviceById = new Map<string, string>();
  if (typeof o.device_by_id === 'object' && o.device_by_id !== null) {
    for (const [id, path] of Object.entries(o.device_by_id as Record<string, unknown>)) {
      if (typeof path === 'string') deviceById.set(id, path);
    }
  }
  return {
    id: o.id,
    ...(Array.isArray(o.spare_disk_ids)
      ? { spare_disk_ids: o.spare_disk_ids.filter((s): s is string => typeof s === 'string') }
      : {}),
    ...(typeof o.tuning === 'object' && o.tuning !== null
      ? { tuning: o.tuning as Record<string, unknown> }
      : {}),
    device_by_id: deviceById,
  };
}

function readPoolEntry(
  pools: unknown,
  name: string,
): { drives: string[]; active: boolean } | undefined {
  if (!Array.isArray(pools)) return undefined;
  for (const entry of pools) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (o.name !== name) continue;
    return {
      drives: Array.isArray(o.drives)
        ? o.drives.filter((d): d is string => typeof d === 'string')
        : [],
      active: o.active === true,
    };
  }
  return undefined;
}

export function makeXiraidArrayModifyExecutor(opts: { client: XiraidClient }): Executor {
  const client = opts.client;
  const preStates = new WeakMap<object, ModifyPreState>();

  /** Target spare DEVICE paths from the spec (throws on unresolved ids). */
  function targetDrives(spec: ModifyExecSpec): string[] {
    return (spec.spare_disk_ids ?? []).map((id) => {
      const path = spec.device_by_id.get(id);
      if (path === undefined) {
        throw new Error(`modify: no resolved device path for spare disk '${id}'`);
      }
      return path;
    });
  }

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const spec = narrowModifySpec(ctx);
      const poolName = derivedPoolName(spec.id);

      const shown = readShow(await client.raidShow());
      const arr = shown.find((a) => a.name === spec.id);
      if (!arr) throw new Error(`preflight: array '${spec.id}' does not exist on the daemon`);

      // The live sparepool name comes from the raw payload (readShow strips it).
      const raw = (await client.raidShow()) as Array<Record<string, unknown>>;
      const rawEntry = Array.isArray(raw) ? raw.find((a) => a?.name === spec.id) : undefined;
      const liveSparepool =
        typeof rawEntry?.sparepool === 'string' ? (rawEntry.sparepool as string) : '';

      // Foreign-pool guard: the control path only manages xnsp_<array>.
      if (spec.spare_disk_ids !== undefined && liveSparepool !== '' && liveSparepool !== poolName) {
        throw new Error(
          `preflight: sparepool '${liveSparepool}' is not managed by the control path (expected '' or '${poolName}')`,
        );
      }

      const pool = readPoolEntry(await client.poolShow(), poolName);
      preStates.set(ctx.spec as object, {
        arraySparepool: liveSparepool,
        poolExisted: pool !== undefined,
        poolDrives: pool?.drives ?? [],
        poolActive: pool?.active ?? false,
      });
      ctx.emitOutput(
        `preflight ok: '${spec.id}' sparepool='${liveSparepool}' pool ${pool ? 'exists' : 'absent'}`,
      );
    },
  };

  const applySpares: ExecutorStage = {
    name: 'apply_spares',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'apply_spares');
      const spec = narrowModifySpec(ctx);
      if (spec.spare_disk_ids === undefined) {
        ctx.emitOutput('skipped (no spare_disk_ids change)');
        return;
      }
      const poolName = derivedPoolName(spec.id);
      const pre = preStates.get(ctx.spec as object);
      const target = targetDrives(spec);

      if (target.length > 0) {
        if (!pre?.poolExisted) {
          ctx.emitOutput(`pool_create ${poolName} drives=${target.join(',')}`);
          await client.poolCreate({ name: poolName, drives: target });
          await client.poolActivate({ name: poolName });
        } else {
          const current = new Set(pre.poolDrives);
          const wanted = new Set(target);
          const toAdd = target.filter((d) => !current.has(d));
          const toRemove = pre.poolDrives.filter((d) => !wanted.has(d));
          if (toAdd.length > 0) await client.poolAdd({ name: poolName, drives: toAdd });
          if (toRemove.length > 0) await client.poolRemove({ name: poolName, drives: toRemove });
          if (!pre.poolActive) await client.poolActivate({ name: poolName });
        }
        if (pre?.arraySparepool !== poolName) {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: poolName }));
        }
        ctx.emitOutput(`spares applied: ${target.join(',')} via ${poolName}`);
      } else {
        // detach: raid_modify('') → deactivate → delete
        if (pre?.arraySparepool === poolName) {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: '' }));
        }
        if (pre?.poolExisted) {
          if (pre.poolActive) await client.poolDeactivate({ name: poolName });
          await client.poolDelete({ name: poolName });
        }
        ctx.emitOutput('spares detached');
      }
    },
  };

  const applyTuning: ExecutorStage = {
    name: 'apply_tuning',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'apply_tuning');
      const spec = narrowModifySpec(ctx);
      if (spec.tuning === undefined) {
        ctx.emitOutput('skipped (no tuning change)');
        return;
      }
      // LAST stage by construction: tuning is not restorable (observed state
      // carries no tuning), so nothing may run after it that could fail and
      // demand its rollback. The single raid_modify is atomic daemon-side.
      await client.raidModify(toRaidModifyRequest(spec.id, { tuning: spec.tuning }));
      ctx.emitOutput(`tuning applied: ${Object.keys(spec.tuning).join(',')}`);
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = narrowModifySpec(ctx);
      const raw = (await client.raidShow()) as Array<Record<string, unknown>>;
      const entry = Array.isArray(raw) ? raw.find((a) => a?.name === spec.id) : undefined;
      if (!entry) throw new Error(`verify: array '${spec.id}' vanished`);
      if (spec.spare_disk_ids !== undefined) {
        const expected = spec.spare_disk_ids.length > 0 ? derivedPoolName(spec.id) : '';
        const live = typeof entry.sparepool === 'string' ? entry.sparepool : '';
        if (live !== expected) {
          throw new Error(`verify: sparepool is '${live}', expected '${expected}'`);
        }
      }
      ctx.emitOutput('verify ok');
    },
  };

  return {
    operation_kind: 'xiraid.array.modify',
    stages: [preflight, applySpares, applyTuning, verify],

    /** Inverse POOL ops only, from the preflight-captured pre-state vs live
     *  state. Tuning needs no rollback by construction (last stage, atomic).
     *  No pre-state captured (preflight threw first) → nothing changed. */
    async rollback(ctx: ExecutorContext): Promise<void> {
      const pre = preStates.get(ctx.spec as object);
      if (!pre) {
        ctx.emitOutput('rollback: no pre-state captured — nothing was changed');
        return;
      }
      const spec = narrowModifySpec(ctx);
      const poolName = derivedPoolName(spec.id);

      const raw = (await client.raidShow()) as Array<Record<string, unknown>>;
      const entry = Array.isArray(raw) ? raw.find((a) => a?.name === spec.id) : undefined;
      const liveSparepool = typeof entry?.sparepool === 'string' ? entry.sparepool : '';
      const livePool = readPoolEntry(await client.poolShow(), poolName);

      // 1. Restore the array's sparepool linkage.
      if (liveSparepool !== pre.arraySparepool) {
        await client.raidModify(
          toRaidModifyRequest(spec.id, { sparepool: pre.arraySparepool }),
        );
      }

      // 2. Restore the pool itself.
      if (!pre.poolExisted) {
        if (livePool) {
          if (livePool.active) await client.poolDeactivate({ name: poolName });
          await client.poolDelete({ name: poolName });
        }
      } else if (livePool) {
        const wanted = new Set(pre.poolDrives);
        const current = new Set(livePool.drives);
        const toAdd = pre.poolDrives.filter((d) => !current.has(d));
        const toRemove = livePool.drives.filter((d) => !wanted.has(d));
        if (toAdd.length > 0) await client.poolAdd({ name: poolName, drives: toAdd });
        if (toRemove.length > 0) await client.poolRemove({ name: poolName, drives: toRemove });
        if (livePool.active !== pre.poolActive) {
          await (pre.poolActive
            ? client.poolActivate({ name: poolName })
            : client.poolDeactivate({ name: poolName }));
        }
      } else {
        await client.poolCreate({ name: poolName, drives: pre.poolDrives });
        if (pre.poolActive) await client.poolActivate({ name: poolName });
      }
      ctx.emitOutput('rollback: pool state restored to the preflight capture');
    },
  };
}

// ---------------------------------------------------------------------------
// xiraid.array.import executor (S4 T8, ADR-0006 §Import as amended)
// ---------------------------------------------------------------------------

function narrowImportSpec(ctx: ExecutorContext): { uuid: string; new_name: string } {
  const o = ctx.spec as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.uuid !== 'string' || o.uuid.length === 0) {
    throw new Error('xiraid.array.import: spec is missing the foreign array uuid');
  }
  const newName = typeof o.new_name === 'string' && o.new_name.length > 0 ? o.new_name : o.uuid;
  return { uuid: o.uuid, new_name: newName };
}

/** Tolerant read of the raid_import_show candidate list. */
function readImportCandidates(
  payload: unknown,
): Array<{ uuid: string; recoverable: boolean }> {
  if (!Array.isArray(payload)) return [];
  const out: Array<{ uuid: string; recoverable: boolean }> = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.uuid !== 'string') continue;
    // Tolerate either `recoverable` or an inverse `offline`-style flag being
    // absent: missing recoverability info reads as recoverable.
    out.push({ uuid: o.uuid, recoverable: o.recoverable !== false });
  }
  return out;
}

export function makeXiraidArrayImportExecutor(opts: { client: XiraidClient }): Executor {
  const client = opts.client;

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const { uuid, new_name } = narrowImportSpec(ctx);

      // The S4 §6 amendment: THIS is where the uuid gets validated (the api
      // cannot reach the daemon at plan time).
      const candidates = readImportCandidates(await client.raidImportShow());
      const candidate = candidates.find((c) => c.uuid === uuid);
      if (!candidate) {
        throw new Error(`preflight: no importable array with uuid '${uuid}' on this node`);
      }
      if (!candidate.recoverable) {
        throw new Error(`preflight: array uuid '${uuid}' is not recoverable`);
      }
      if (readShow(await client.raidShow()).some((a) => a.name === new_name)) {
        throw new Error(`preflight: an array named '${new_name}' already exists on the daemon`);
      }
      ctx.emitOutput(`preflight ok: uuid '${uuid}' importable as '${new_name}'`);
    },
  };

  const adopt: ExecutorStage = {
    name: 'adopt',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'adopt');
      const { uuid, new_name } = narrowImportSpec(ctx);
      await client.raidImportApply({ uuid, new_name });
      ctx.emitOutput(`raid_import_apply: '${uuid}' adopted as '${new_name}'`);
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const { new_name } = narrowImportSpec(ctx);
      if (!readShow(await client.raidShow()).some((a) => a.name === new_name)) {
        throw new Error(`verify: adopted array '${new_name}' is not visible in raid_show`);
      }
      ctx.emitOutput(`verify ok: '${new_name}' adopted`);
    },
  };

  return {
    operation_kind: 'xiraid.array.import',
    stages: [preflight, adopt, verify],

    /** Un-adopt = CONFIG-ONLY removal (data untouched, ADR-0006); live-state
     *  decided like the create rollback. An unparsable spec adopted nothing. */
    async rollback(ctx: ExecutorContext): Promise<void> {
      let name: string;
      try {
        name = narrowImportSpec(ctx).new_name;
      } catch {
        ctx.emitOutput('rollback: spec unparsable — nothing was adopted, nothing to undo');
        return;
      }
      const exists = readShow(await client.raidShow()).some((a) => a.name === name);
      if (!exists) {
        ctx.emitOutput(`rollback: '${name}' was never adopted — nothing to undo`);
        return;
      }
      ctx.emitOutput(`rollback: un-adopting '${name}' (config-only, data untouched)`);
      await client.raidDestroy({ name, config_only: true });
    },
  };
}
