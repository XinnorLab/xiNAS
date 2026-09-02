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

import type { MountGuardEntry } from '../../lib/parse/mountinfo.js';
import { parsePoolShow } from '../../lib/parse/pool.js';
import {
  type RaidShowEntry,
  parseRaidShowEntries,
  readSparepoolName,
} from '../../lib/parse/raid.js';
import { isXiraidVolumePath, xiraidVolumeArrayName } from '../../lib/xiraid/schema.js';
import { parseCreateSpec } from '../../lib/xiraid/validate.js';
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

type ShownArray = RaidShowEntry;

/**
 * Tolerant read of the raid_show payload (name/devices/state).
 *
 * Delegates to the shared normalizer: the real xiRAID 4.3.x daemon keys
 * raid_show by array name and lists devices as [idx, path, states] tuples,
 * while the fake transport emits a flat array. An array-only reader here made
 * every live array look absent — preflight refused to delete or modify a real
 * array, and create skipped its collision guards (#243 fixed only the
 * collector's copy).
 */
function readShow(payload: unknown): ShownArray[] {
  return parseRaidShowEntries(payload);
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

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Deactivate a pool THIS run armed, as the first act of a rollback.
 *
 * Split out because both array rollbacks need the identical shape: the pool
 * the operator named must not be left armed by a run that failed, and that
 * undo has to happen even when the rest of the rollback bails out early
 * (an unparsable spec, a create that never started, a modify with no
 * pre-state) — so it runs above every early return.
 *
 * The first attempt is deliberately NON-FATAL. It is not established
 * anywhere — neither the xiRAID 4.4 command reference nor
 * `xiNAS-MCP/xiraid-analysis/api_behavior_doc.md` — whether the daemon
 * accepts `pool deactivate` while an array still references the pool, and
 * the fake transport permits it unconditionally, so no test can settle it
 * either. Letting a rejection propagate from here would abandon the array
 * work the rollback still owes (the create rollback's `raid_destroy`, the
 * modify rollback's linkage restore) and end the task in
 * `requires_manual_recovery` with this run's array still on the daemon.
 * The caller retries via {@link retryPoolDeactivate} once that work is done,
 * and THAT failure is never swallowed.
 *
 * @returns the pool name still needing a retry, or undefined when nothing is
 *          pending (no activation this run, or the first attempt succeeded).
 */
async function deactivateActivatedPool(
  client: XiraidClient,
  ctx: ExecutorContext,
): Promise<string | undefined> {
  const activated = ctx.stash.pool_activated;
  if (typeof activated !== 'string') return undefined;
  try {
    await client.poolDeactivate({ name: activated });
    ctx.emitOutput(`rollback: spare pool '${activated}' deactivated`);
    return undefined;
  } catch (err) {
    ctx.emitOutput(
      `rollback: WARNING could not deactivate spare pool '${activated}' yet (${errMsg(err)}) — continuing, will retry`,
    );
    return activated;
  }
}

/** Second and final `pool_deactivate` attempt; a failure here PROPAGATES
 *  (→ `rollback_failed` → `requires_manual_recovery`), because the pool is
 *  then genuinely left armed and only an operator can settle it. */
async function retryPoolDeactivate(
  client: XiraidClient,
  ctx: ExecutorContext,
  pending: string | undefined,
): Promise<void> {
  if (pending === undefined) return;
  await client.poolDeactivate({ name: pending });
  ctx.emitOutput(`rollback: spare pool '${pending}' deactivated (retry)`);
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
        // The live half of the §4.1 rule. The plan-time blocker reads observed
        // state, which can be stale or predate the array; this refuses under
        // the held leases, one call before raid_create would overwrite the
        // volume. Structural, so it holds for an array raid_show does not list.
        if (isXiraidVolumePath(path)) {
          const owner = xiraidVolumeArrayName(path);
          throw new Error(
            `preflight: device ${path} (disk '${id}') is the volume of ` +
              (shown.some((a) => a.name === owner) ? `array '${owner}'` : 'a xiRAID array') +
              ', not a physical drive',
          );
        }
      }
      // The pool is the operator's — this only confirms it exists and can
      // actually serve as a spare source (design doc §2, §4.1). No member-disk
      // checks apply to it: it is a reference, not a set of disks to provision.
      if (spec.spare_pool) {
        const pool = readPoolEntry(await client.poolShow(), spec.spare_pool);
        if (!pool) {
          throw new Error(
            `preflight: spare pool '${spec.spare_pool}' does not exist on the daemon`,
          );
        }
        if (pool.drives.length === 0) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' has no drives`);
        }
        ctx.stash.pool_was_active = pool.active;
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

      // Marked BEFORE the first mutation: rollback destroys by live state, so
      // it may only touch '<name>' once THIS run started building it. Without
      // the marker a preflight name collision rolls back by destroying the
      // operator's pre-existing array of the same name.
      ctx.stash.create_attempted = true;

      // The pool is the operator's. We only arm it: an unactivated pool never
      // auto-replaces (analyst doc §3.8). Nothing here creates or fills one.
      if (spec.spare_pool && ctx.stash.pool_was_active === false) {
        await client.poolActivate({ name: spec.spare_pool });
        ctx.stash.pool_activated = spec.spare_pool;
        ctx.emitOutput(`pool_activate ${spec.spare_pool}`);
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
      // Undo the ONE pool change this path can make, FIRST — above BOTH the
      // early returns in undoArray() below. `create` can activate the pool and
      // then have raid_create reject, so an activation stranded by either
      // early return leaves the operator's pool armed when they never asked
      // for it (S4 spec §5 "Create-with-spares un-deferral"). This reads only
      // ctx.stash, never the spec, so it needs neither a parsed spec nor
      // create_attempted. The pool itself is never deleted here — it is the
      // operator's, not ours to destroy (S4 spec §7, design doc §2.1).
      const pending = await deactivateActivatedPool(client, ctx);

      // The array half of the rollback still runs even when the deactivation
      // above was rejected — see deactivateActivatedPool()'s note on why that
      // first attempt is non-fatal. A raid_show/raid_destroy failure here does
      // propagate (→ rollback_failed → requires_manual_recovery); the pending
      // deactivation is then reported in the warning already emitted.
      const undoArray = async (): Promise<void> => {
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
        // The create stage never started → this run built nothing, and
        // anything wearing `name` on the daemon predates us (a preflight name
        // collision is exactly that). Destroying it would be data loss, not a
        // rollback.
        if (ctx.stash.create_attempted !== true) {
          ctx.emitOutput(`rollback: create never ran — '${name}' is not ours to undo`);
          return;
        }

        // Live-state decision (crash-safe within the run): destroy only what
        // raid_show says exists.
        const exists = readShow(await client.raidShow()).some((a) => a.name === name);
        if (exists) {
          ctx.emitOutput(`rollback: destroying partially created array '${name}'`);
          await client.raidDestroy({ name, force: true });
          ctx.emitOutput(`rollback: '${name}' destroyed`);
        } else {
          ctx.emitOutput(`rollback: array '${name}' was never created — nothing to undo`);
        }
      };

      await undoArray();
      await retryPoolDeactivate(client, ctx, pending);
    },
  };
}

// ---------------------------------------------------------------------------
// xiraid.array.modify executor (S4 T6, ADR-0006 §Modify / §Spare pools)
// ---------------------------------------------------------------------------

interface ModifyExecSpec {
  id: string;
  spare_pool?: string | null;
  tuning?: Record<string, unknown>;
}

/** Pool/array pre-state captured LIVE at preflight; keyed by ctx.spec object
 *  identity (the runner hands the same spec object to every stage and to
 *  rollback within one run), so the singleton executor carries no cross-task
 *  state. After an agent crash the map is empty — but the runner only calls
 *  rollback in-process, so that path cannot observe a missing entry. */
interface ModifyPreState {
  /** The array's sparepool name before this run ('' when it had none). */
  arraySparepool: string;
  /** The TARGET pool's active flag, or null when no pool is being attached. */
  targetPoolActive: boolean | null;
}

function narrowModifySpec(ctx: ExecutorContext): ModifyExecSpec {
  const o = ctx.spec as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.id !== 'string') {
    throw new Error('xiraid.array.modify: spec is missing the target array id');
  }
  return {
    id: o.id,
    // 'spare_pool' in o distinguishes "absent" (skip the field entirely,
    // apply_spares no-ops) from an explicit null (detach) or a name
    // (attach/re-point) — an `undefined` VALUE under an existing key reads
    // as absent too, matching this narrowing's tolerance for the
    // enrichment keys the parsers already ignore.
    ...('spare_pool' in o && o.spare_pool !== undefined
      ? { spare_pool: o.spare_pool as string | null }
      : {}),
    ...(typeof o.tuning === 'object' && o.tuning !== null
      ? { tuning: o.tuning as Record<string, unknown> }
      : {}),
  };
}

/** Tolerant read of one pool_show entry — dict- and array-shaped payloads. */
function readPoolEntry(
  pools: unknown,
  name: string,
): { drives: string[]; active: boolean } | undefined {
  return parsePoolShow(pools).find((p) => p.name === name);
}

/**
 * Live sparepool NAME for one array; `undefined` when the array is absent.
 *
 * Goes through readShow for the same reason every other consumer does: on the
 * real daemon raid_show is an object keyed by array name, so an `Array.isArray`
 * read finds no entry and reports a live array as vanished (s3 spec §Payload
 * shapes — one reader, no local copies). An array with no sparepool reads ''.
 */
function readSparepool(payload: unknown, name: string): string | undefined {
  const entry = readShow(payload).find((a) => a.name === name);
  if (!entry) return undefined;
  return readSparepoolName(entry.raw.sparepool);
}

export function makeXiraidArrayModifyExecutor(opts: { client: XiraidClient }): Executor {
  const client = opts.client;
  const preStates = new WeakMap<object, ModifyPreState>();

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const spec = narrowModifySpec(ctx);

      const shown = readShow(await client.raidShow());
      const arr = shown.find((a) => a.name === spec.id);
      if (!arr) throw new Error(`preflight: array '${spec.id}' does not exist on the daemon`);

      const liveSparepool = readSparepoolName(arr.raw.sparepool);

      // The foreign-pool guard is gone: the control path no longer owns a
      // derived pool name, so there is nothing left for a sparepool to be
      // "foreign" to. Any pool the operator names is a valid attach target,
      // subject only to the existence/non-empty check below.
      //
      // '' is treated the same as absent here on purpose: a spec.spare_pool
      // of '' means "no pool", never "a pool literally named ''", so it skips
      // straight to the detach branch in apply_spares — there is nothing to
      // look up. See the apply_spares row in
      // docs/control-path/s4-xiraid-array-mutations-spec.md §5.
      let targetPoolActive: boolean | null = null;
      if (typeof spec.spare_pool === 'string' && spec.spare_pool !== '') {
        const pool = readPoolEntry(await client.poolShow(), spec.spare_pool);
        if (!pool) {
          throw new Error(
            `preflight: spare pool '${spec.spare_pool}' does not exist on the daemon`,
          );
        }
        if (pool.drives.length === 0) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' has no drives`);
        }
        targetPoolActive = pool.active;
      }
      preStates.set(ctx.spec as object, { arraySparepool: liveSparepool, targetPoolActive });
      ctx.emitOutput(
        `preflight ok: '${spec.id}' sparepool='${liveSparepool}' target='${spec.spare_pool ?? '(unchanged)'}'`,
      );
    },
  };

  const applySpares: ExecutorStage = {
    name: 'apply_spares',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'apply_spares');
      const spec = narrowModifySpec(ctx);
      if (spec.spare_pool === undefined) {
        ctx.emitOutput('skipped (no spare_pool change)');
        return;
      }
      const pre = preStates.get(ctx.spec as object);
      const target = spec.spare_pool;

      // '' is a third value distinct from both `undefined` (no change) and a
      // real name, and it is deliberately folded into the detach branch below
      // rather than attempted as a pool named ''. parseModifySpec already
      // treats '' as a no-op blocker-wise; here it must behave exactly like
      // `null`. See the apply_spares row in
      // docs/control-path/s4-xiraid-array-mutations-spec.md §5.
      if (typeof target === 'string' && target !== '') {
        if (pre?.targetPoolActive === false) {
          await client.poolActivate({ name: target });
          ctx.stash.pool_activated = target;
          ctx.emitOutput(`pool_activate ${target}`);
        }
        if (pre?.arraySparepool !== target) {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: target }));
        }
        ctx.emitOutput(`spare pool '${target}' attached`);
      } else {
        if (pre?.arraySparepool !== '') {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: '' }));
        }
        ctx.emitOutput('spare pool detached (the pool itself is left in place)');
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
      const live = readSparepool(await client.raidShow(), spec.id);
      if (live === undefined) throw new Error(`verify: array '${spec.id}' vanished`);
      if (spec.spare_pool !== undefined) {
        // '' reads the same as null here — both expect a detached array,
        // matching apply_spares' fold of '' into the detach branch
        // (docs/control-path/s4-xiraid-array-mutations-spec.md §5).
        const expected = spec.spare_pool ?? '';
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

    /** Inverse of apply_spares only: restore the array's sparepool linkage,
     *  and deactivate the target pool if (and only if) THIS run activated
     *  it. No pool_create/pool_add/pool_remove/pool_delete ever runs here —
     *  the pool is never the executor's to build or destroy, mirroring
     *  apply_spares itself (design doc §4.2). Tuning needs no rollback by
     *  construction (last stage, atomic). No pre-state captured (preflight
     *  threw first) → nothing changed. */
    async rollback(ctx: ExecutorContext): Promise<void> {
      // Deactivate FIRST, above the no-pre-state guard, for the same reason
      // the create rollback does it above its own early returns: the guard
      // reads a WeakMap that a future stage reordering could leave unset while
      // an activation had already happened, and a "currently unreachable"
      // ordering bug is exactly the shape that gets reintroduced. The linkage
      // restore below is real work that a rejected pool_deactivate must not
      // abandon, so this uses the same non-fatal-then-retry sequence.
      const pending = await deactivateActivatedPool(client, ctx);

      const pre = preStates.get(ctx.spec as object);
      if (pre) {
        const spec = narrowModifySpec(ctx);
        const liveSparepool = readSparepool(await client.raidShow(), spec.id) ?? '';
        if (liveSparepool !== pre.arraySparepool) {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: pre.arraySparepool }));
        }
        ctx.emitOutput('rollback: sparepool linkage restored to the preflight capture');
      } else {
        ctx.emitOutput('rollback: no pre-state captured — nothing was changed');
      }

      await retryPoolDeactivate(client, ctx, pending);
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
function readImportCandidates(payload: unknown): Array<{ uuid: string; recoverable: boolean }> {
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

// ---------------------------------------------------------------------------
// xiraid.array.delete executor (S4 T10, ADR-0006 §Delete / S4 spec §7)
// ---------------------------------------------------------------------------

export interface XiraidArrayDeleteExecutorOptions {
  client: XiraidClient;
  /**
   * Host-level mount reader (the route-recheck→destroy TOCTOU guard): the
   * real wiring reads /proc/self/mountinfo through lib/parse/mountinfo.
   * FAIL-CLOSED: if mounts cannot be read, preflight throws and nothing is
   * destroyed.
   */
  readMounts: () => Promise<MountGuardEntry[]>;
  /** verify wait-gone poll cadence; injectable for tests. */
  pollIntervalMs?: number;
  /** verify wait-gone bound — a synchronous raid_destroy clears immediately;
   *  this only tolerates async propagation before declaring the array stuck. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Mount options that name a SEPARATE block device the filesystem depends on.
 * XFS prints both in its super options (`xfs_fs_show_options`), so a mount
 * whose `source` is another volume can still be destroyed out from under by
 * deleting the array named here.
 */
const EXTERNAL_DEVICE_OPTIONS = ['logdev', 'rtdev'];

/**
 * First mount that references *volume* through an external-device option.
 * Both option lists are searched: the fs-specific options live in
 * `super_options`, but a reader that flattens the two must not slip past.
 */
function findExternalDeviceUse(
  mounts: MountGuardEntry[],
  volume: string,
): { mountpoint: string; option: string } | undefined {
  for (const mount of mounts) {
    for (const opt of [...(mount.options ?? []), ...(mount.super_options ?? [])]) {
      const eq = opt.indexOf('=');
      if (eq === -1) continue;
      const key = opt.slice(0, eq);
      if (!EXTERNAL_DEVICE_OPTIONS.includes(key)) continue;
      if (opt.slice(eq + 1) === volume) return { mountpoint: mount.mountpoint, option: key };
    }
  }
  return undefined;
}

function narrowDeleteSpec(ctx: ExecutorContext): { id: string } {
  const o = ctx.spec as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || o.id.length === 0) {
    throw new Error('xiraid.array.delete: spec is missing the target array id');
  }
  return { id: o.id };
}

export function makeXiraidArrayDeleteExecutor(opts: XiraidArrayDeleteExecutorOptions): Executor {
  const client = opts.client;
  const readMounts = opts.readMounts;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const { id } = narrowDeleteSpec(ctx);

      if (!readShow(await client.raidShow()).some((a) => a.name === id)) {
        throw new Error(`preflight: array '${id}' does not exist on the daemon`);
      }

      // Host-level guard: a mount that appeared AFTER the api's re-check
      // fails the delete here, before any destruction. Active NFS sessions
      // require their filesystem to be mounted, so this subsumes the
      // session race for data safety (S4 spec §7).
      const volume = `/dev/xi_${id}`;
      const mounts = await readMounts();
      const busy = mounts.find((m) => m.source === volume);
      if (busy) {
        throw new Error(
          `preflight: ${volume} is mounted at ${busy.mountpoint} — unmount it before deleting`,
        );
      }
      // Same data loss, different shape: a filesystem can depend on the
      // volume WITHOUT mounting it — XFS carries its journal (logdev=) or
      // realtime section (rtdev=) on a separate device. Destroying that
      // device under the mounted filesystem corrupts it, so an external
      // reference blocks the delete exactly like a direct mount.
      const external = findExternalDeviceUse(mounts, volume);
      if (external) {
        throw new Error(
          `preflight: ${volume} is in use as the ${external.option} device of the ` +
            `filesystem mounted at ${external.mountpoint} — unmount it before deleting`,
        );
      }
      ctx.emitOutput(`preflight ok: '${id}' exists and ${volume} is not in use by any mount`);
    },
  };

  const destroy: ExecutorStage = {
    name: 'destroy',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'destroy');
      const { id } = narrowDeleteSpec(ctx);
      ctx.emitOutput(`raid_destroy ${id} (force)`);
      // Marked BEFORE the call: rollback may only escalate to
      // requires_manual_recovery once destruction was actually attempted (§7).
      ctx.stash.destroy_attempted = true;
      await client.raidDestroy({ name: id, force: true });

      // Delete does not touch the array's spare pool at all (S4 spec §7):
      // the pool the array referenced, if any, is not this executor's to
      // deactivate or delete — it belongs to the pool surface, outlives the
      // array, stays active, and remains available to attach to another
      // array or to be managed from Spare Pools. There is no cleanup step
      // here.
      ctx.emitOutput(`'${id}' destroyed`);
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const { id } = narrowDeleteSpec(ctx);
      // raid_destroy already returned success — this only CONFIRMS the array
      // cleared. Poll for it to disappear (absorbing async propagation on
      // daemons where raid_destroy is not instantaneous). A transient raid_show
      // error is tolerated (the destroy was acknowledged; the observe path
      // resurfaces the true state). Only an array STILL present after the wait
      // is a genuine "destroy did not take" → throw → rollback sees it present
      // → clean `failed` (retryable), never requires_manual_recovery.
      let waited = 0;
      for (;;) {
        let stillPresent: boolean;
        try {
          stillPresent = readShow(await client.raidShow()).some((a) => a.name === id);
        } catch (err) {
          ctx.emitOutput(
            `warning: could not confirm '${id}' gone (raid_show unavailable): ${errMsg(err)}`,
          );
          return;
        }
        if (!stillPresent) {
          ctx.emitOutput('verify ok: array gone');
          return;
        }
        if (waited >= timeoutMs) {
          throw new Error(`verify: array '${id}' still present ${timeoutMs}ms after destroy`);
        }
        await sleep(pollIntervalMs);
        waited += pollIntervalMs;
      }
    },
  };

  return {
    operation_kind: 'xiraid.array.delete',
    stages: [preflight, destroy, verify],

    /**
     * Gated on attempted destruction, then live-state decided (S4 spec §7):
     * no `destroy_attempted` stash marker → the failure was pre-destroy
     * (preflight guard, vanished array, unreachable daemon) → no-op without
     * querying the daemon, terminal `failed` (clean, retryable). Marker set
     * and the array still exists → the destroy did not take → no-op, clean
     * `failed`. Marker set and the array is gone or its state is unknowable
     * → THROW → rollback_failed → requires_manual_recovery — "no rollback
     * for a destructive op" applies to attempted destruction, not to a
     * preflight that touched nothing.
     */
    async rollback(ctx: ExecutorContext): Promise<void> {
      let id: string;
      try {
        id = narrowDeleteSpec(ctx).id;
      } catch {
        ctx.emitOutput('rollback: spec unparsable — nothing was destroyed');
        return;
      }
      if (ctx.stash.destroy_attempted !== true) {
        ctx.emitOutput(`rollback: destroy of '${id}' was never attempted — nothing to undo`);
        return;
      }
      const exists = readShow(await client.raidShow()).some((a) => a.name === id);
      if (exists) {
        ctx.emitOutput(`rollback: array '${id}' is intact — nothing was destroyed`);
        return;
      }
      throw new Error(
        `destructive operation: rollback unsupported — array '${id}' is gone or partially destroyed`,
      );
    },
  };
}
