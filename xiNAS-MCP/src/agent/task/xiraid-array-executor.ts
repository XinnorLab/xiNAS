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
import { toRaidCreateRequest } from '../../lib/xiraid/translate.js';
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
