/**
 * fs.create executor (S5 T8, ADR-0007 §Create).
 *
 * Stages: preflight → mkfs → install_unit → mount → verify.
 *
 *  - preflight re-checks LIVE what only the agent can see: blkid on the
 *    backing device (an existing filesystem without force:true aborts —
 *    the single destruction gate's executor half; the engine's dangerous
 *    flag is the api half), and that the unit name is free on disk.
 *  - mkfs applies the day-1 _effective_log_size clamp HERE, where the
 *    log device's true size is readable: size = min(requested,
 *    blockdev --getsize64) (review P1).
 *  - mount enables --now (PID1 creates the mountpoint dir per .mount
 *    semantics) and applies owner_policy once.
 *
 * STATELESS rollback from live state (the S3/S4 pattern): mounted →
 * stop; unit file present → disable + remove + daemon-reload. The mkfs
 * itself is NOT undone — on a non-force create the device had no
 * filesystem before, so the documented residual is an unmanaged (but
 * formatted) device; rollback emits that note.
 *
 * The spec arriving in task.begin is the api-enriched spec (T7):
 * create fields + unit_name + unit_text + resolved mkfs inputs, so the
 * executor needs no KV access.
 */

import { buildMkfsArgs } from '../../lib/fs/mkfs.js';
import { parseFsCreateSpec } from '../../lib/fs/validate.js';
import type { FsHost } from '../fs/host.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

export interface FsCreateExecutorOptions {
  host: FsHost;
}

interface EnrichedCreate {
  spec: ReturnType<typeof parseFsCreateSpec>;
  unitName: string;
  unitText: string;
  resolved: {
    device: string;
    label: string;
    su_kb: number;
    sw: number;
    sector_size: number;
    log_device?: string;
    log_size_bytes?: number;
  };
}

function narrowSpec(ctx: ExecutorContext): EnrichedCreate {
  const spec = parseFsCreateSpec(ctx.spec);
  const raw = ctx.spec as Record<string, unknown>;
  if (typeof raw.unit_name !== 'string' || typeof raw.unit_text !== 'string') {
    throw new Error('fs.create: spec is missing the plan-resolved unit_name/unit_text');
  }
  const resolved = raw.resolved as EnrichedCreate['resolved'] | undefined;
  if (
    typeof resolved !== 'object' ||
    resolved === null ||
    typeof resolved.device !== 'string' ||
    typeof resolved.su_kb !== 'number' ||
    typeof resolved.sw !== 'number'
  ) {
    throw new Error(
      'fs.create: spec is missing the plan-resolved mkfs inputs (stripe geometry was underivable?)',
    );
  }
  return { spec, unitName: raw.unit_name, unitText: raw.unit_text, resolved };
}

function checkCancelled(ctx: ExecutorContext, stage: string): void {
  if (ctx.isCancelRequested()) {
    throw new Error(`fs.create: cancelled before ${stage}`);
  }
}

export function makeFsCreateExecutor(opts: FsCreateExecutorOptions): Executor {
  const host = opts.host;

  const preflight: ExecutorStage = {
    name: 'preflight',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'preflight');
      const { spec, unitName, resolved } = narrowSpec(ctx);

      // The destruction gate's executor half: a live filesystem on the
      // device aborts unless the (dangerous-gated) force was set.
      const existing = await host.blkid(resolved.device);
      if (existing !== null && spec.force !== true) {
        throw new Error(
          `preflight: ${resolved.device} already carries a ${existing.fstype ?? 'unknown'} filesystem` +
            `${existing.label !== undefined ? ` (label '${existing.label}')` : ''} — re-plan with force: true to overwrite`,
        );
      }
      if ((await host.readUnit(unitName)) !== null) {
        throw new Error(`preflight: unit ${unitName} already exists on disk`);
      }
      const mounts = await host.readMounts();
      const taken = mounts.find((m) => m.mountpoint === spec.mountpoint);
      if (taken) {
        throw new Error(
          `preflight: ${spec.mountpoint} is already a live mountpoint (${taken.source})`,
        );
      }
      ctx.emitOutput(
        `preflight ok: ${resolved.device} ${existing === null ? 'has no filesystem' : 'will be overwritten (force)'}, unit ${unitName} free`,
      );
    },
  };

  const mkfs: ExecutorStage = {
    name: 'mkfs',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'mkfs');
      const { resolved } = narrowSpec(ctx);

      // Day-1 _effective_log_size: never ask mkfs for a log larger than
      // the log device (clamped here, where blockdev is readable).
      let logSizeBytes = resolved.log_size_bytes;
      if (resolved.log_device !== undefined && logSizeBytes !== undefined) {
        const deviceBytes = await host.blockdevSize(resolved.log_device);
        if (deviceBytes < logSizeBytes) {
          ctx.emitOutput(
            `log size clamped: requested ${logSizeBytes} > ${resolved.log_device} size ${deviceBytes}`,
          );
          logSizeBytes = deviceBytes;
        }
      }

      const argv = buildMkfsArgs({
        ...resolved,
        ...(logSizeBytes !== undefined ? { log_size_bytes: logSizeBytes } : {}),
      });
      ctx.emitOutput(`mkfs.xfs ${argv.join(' ')}`);
      await host.mkfsXfs(argv);
    },
  };

  const installUnit: ExecutorStage = {
    name: 'install_unit',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'install_unit');
      const { unitName, unitText } = narrowSpec(ctx);
      await host.writeUnit(unitName, unitText);
      await host.daemonReload();
      ctx.emitOutput(`installed ${unitName}`);
    },
  };

  const mount: ExecutorStage = {
    name: 'mount',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'mount');
      const { spec, unitName } = narrowSpec(ctx);
      await host.enableNow(unitName);
      if (spec.owner_policy !== undefined) {
        await host.applyOwnerPolicy(spec.mountpoint, spec.owner_policy);
        ctx.emitOutput(`owner policy applied to ${spec.mountpoint}`);
      }
      ctx.emitOutput(`mounted ${spec.mountpoint} (enabled ${unitName})`);
    },
  };

  const verify: ExecutorStage = {
    name: 'verify',
    async run(ctx: ExecutorContext): Promise<void> {
      const { spec, resolved } = narrowSpec(ctx);
      const mounts = await host.readMounts();
      if (!mounts.some((m) => m.mountpoint === spec.mountpoint)) {
        throw new Error(`verify: ${spec.mountpoint} is not mounted after enableNow`);
      }
      const info = await host.blkid(resolved.device);
      if (info?.fstype !== 'xfs') {
        throw new Error(
          `verify: ${resolved.device} does not show an xfs filesystem (blkid: ${JSON.stringify(info)})`,
        );
      }
      ctx.emitOutput(`verified: xfs on ${resolved.device}, mounted at ${spec.mountpoint}`);
    },
  };

  return {
    operation_kind: 'fs.create',
    stages: [preflight, mkfs, installUnit, mount, verify],

    async rollback(ctx: ExecutorContext): Promise<void> {
      const { spec, unitName } = narrowSpec(ctx);

      // Live-state decisions (correct after a crash or any partial stage).
      const mounts = await host.readMounts();
      if (mounts.some((m) => m.mountpoint === spec.mountpoint)) {
        await host.stop(unitName);
        ctx.emitOutput(`rollback: stopped ${unitName}`);
      }
      if ((await host.readUnit(unitName)) !== null) {
        try {
          await host.disable(unitName);
        } catch {
          /* disabled or never enabled — fine */
        }
        await host.removeUnit(unitName);
        await host.daemonReload();
        ctx.emitOutput(`rollback: removed ${unitName}`);
      }
      // mkfs is not undone: the device returns to "unmanaged"; on a
      // non-force create it carried no filesystem before, so the only
      // residual is a formatted-but-unmanaged device.
      ctx.emitOutput('rollback: device left unmanaged (mkfs is not undone)');
    },
  };
}

// ---- fs.mount / fs.unmount (S5 T10, ADR-0007 §Mount/§Unmount) ----

interface IdSpec {
  id: string;
  mountpoint: string;
}

function narrowIdSpec(ctx: ExecutorContext, op: string): IdSpec {
  const raw = ctx.spec as Record<string, unknown> | null;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof raw.id !== 'string' ||
    typeof raw.mountpoint !== 'string'
  ) {
    throw new Error(`${op}: spec is missing the plan-resolved id/mountpoint`);
  }
  return { id: raw.id, mountpoint: raw.mountpoint };
}

/**
 * fs.mount: preflight (unit exists on disk) → mount (enable --now) →
 * verify (mountpoint live). Rollback: live-state — if the mountpoint is
 * live, stop the unit (the unit file predates this task and is kept).
 */
export function makeFsMountExecutor(opts: { host: FsHost }): Executor {
  const host = opts.host;
  return {
    operation_kind: 'fs.mount',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id } = narrowIdSpec(ctx, 'fs.mount');
          if ((await host.readUnit(id)) === null) {
            throw new Error(`preflight: unit ${id} does not exist on disk`);
          }
          ctx.emitOutput(`preflight ok: ${id} present`);
        },
      },
      {
        name: 'mount',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, mountpoint } = narrowIdSpec(ctx, 'fs.mount');
          const mounts = await host.readMounts();
          if (mounts.some((m) => m.mountpoint === mountpoint)) {
            ctx.emitOutput(`${mountpoint} already mounted — enable only (idempotent)`);
          }
          await host.enableNow(id);
          ctx.emitOutput(`enabled --now ${id}`);
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const { mountpoint } = narrowIdSpec(ctx, 'fs.mount');
          const mounts = await host.readMounts();
          if (!mounts.some((m) => m.mountpoint === mountpoint)) {
            throw new Error(`verify: ${mountpoint} is not mounted after enableNow`);
          }
          ctx.emitOutput(`verified: ${mountpoint} mounted`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const { id, mountpoint } = narrowIdSpec(ctx, 'fs.mount');
      const mounts = await host.readMounts();
      if (mounts.some((m) => m.mountpoint === mountpoint)) {
        await host.stop(id);
        ctx.emitOutput(`rollback: stopped ${id}`);
      }
      // The unit file predates this task — never removed here.
    },
  };
}

/**
 * fs.unmount: preflight (unit exists) → unmount (stop, then disable) →
 * verify (mountpoint gone). Rollback: live-state — the mountpoint NOT
 * live → enable --now to restore the pre-task state (covers both an
 * EBUSY stop, where nothing changed, and a crash between stop and
 * disable).
 */
export function makeFsUnmountExecutor(opts: { host: FsHost }): Executor {
  const host = opts.host;
  return {
    operation_kind: 'fs.unmount',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id } = narrowIdSpec(ctx, 'fs.unmount');
          if ((await host.readUnit(id)) === null) {
            throw new Error(`preflight: unit ${id} does not exist on disk`);
          }
          ctx.emitOutput(`preflight ok: ${id} present`);
        },
      },
      {
        name: 'unmount',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, mountpoint } = narrowIdSpec(ctx, 'fs.unmount');
          const mounts = await host.readMounts();
          if (mounts.some((m) => m.mountpoint === mountpoint)) {
            await host.stop(id); // EBUSY (open files) throws here → rollback
          } else {
            ctx.emitOutput(`${mountpoint} already unmounted — disable only (idempotent)`);
          }
          await host.disable(id);
          ctx.emitOutput(`stopped + disabled ${id}`);
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const { mountpoint } = narrowIdSpec(ctx, 'fs.unmount');
          const mounts = await host.readMounts();
          if (mounts.some((m) => m.mountpoint === mountpoint)) {
            throw new Error(`verify: ${mountpoint} is still mounted after stop`);
          }
          ctx.emitOutput(`verified: ${mountpoint} unmounted`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const { id, mountpoint } = narrowIdSpec(ctx, 'fs.unmount');
      const mounts = await host.readMounts();
      if (!mounts.some((m) => m.mountpoint === mountpoint)) {
        if ((await host.readUnit(id)) !== null) {
          await host.enableNow(id);
          ctx.emitOutput(`rollback: re-enabled ${id} (remounted ${mountpoint})`);
        }
      } else {
        // EBUSY stop: nothing actually changed; re-enable is a no-op-safe
        // restore of enablement in case disable raced the failure.
        await host.enableNow(id);
        ctx.emitOutput(`rollback: ${mountpoint} still mounted — enablement restored`);
      }
    },
  };
}

// ---- fs.grow / fs.set_quota_mode / fs.unmanage (S5 T11) ----

/**
 * fs.grow: preflight (mountpoint live) → grow (xfs_growfs) → verify
 * (statfs size did not shrink). Nothing is undoable — growfs either
 * applied (irreversible, rollback_model 'unsupported' at plan time) or
 * changed nothing; rollback only records that.
 */
export function makeFsGrowExecutor(opts: { host: FsHost }): Executor {
  const host = opts.host;
  const sizeBefore = new WeakMap<object, number>();
  return {
    operation_kind: 'fs.grow',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { mountpoint } = narrowIdSpec(ctx, 'fs.grow');
          const mounts = await host.readMounts();
          if (!mounts.some((m) => m.mountpoint === mountpoint)) {
            throw new Error(`preflight: ${mountpoint} is not mounted (xfs_growfs needs it live)`);
          }
          const before = await host.statfs(mountpoint);
          sizeBefore.set(ctx.spec as object, before.size_bytes);
          ctx.emitOutput(`preflight ok: ${mountpoint} mounted, ${before.size_bytes} bytes`);
        },
      },
      {
        name: 'grow',
        async run(ctx: ExecutorContext): Promise<void> {
          const { mountpoint } = narrowIdSpec(ctx, 'fs.grow');
          await host.growfs(mountpoint);
          ctx.emitOutput(`xfs_growfs ${mountpoint}`);
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const { mountpoint } = narrowIdSpec(ctx, 'fs.grow');
          const after = await host.statfs(mountpoint);
          const before = sizeBefore.get(ctx.spec as object);
          if (before !== undefined && after.size_bytes < before) {
            throw new Error(`verify: size shrank (${before} → ${after.size_bytes})`);
          }
          ctx.emitOutput(`verified: ${after.size_bytes} bytes`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      ctx.emitOutput('rollback: xfs_growfs is irreversible — nothing undone');
    },
  };
}

const QUOTA_OPTION_FLAGS = new Set([
  'uquota',
  'gquota',
  'pquota',
  'usrquota',
  'grpquota',
  'prjquota',
  'noquota',
]);

/** Rewrite the unit text's Options= quota flag (none removes it). */
export function rewriteQuotaFlag(text: string, mode: string): string {
  return text.replace(/^Options=(.*)$/m, (_match, opts: string) => {
    const kept = opts.split(',').filter((o) => !QUOTA_OPTION_FLAGS.has(o.trim()));
    if (mode !== 'none') kept.push(mode);
    return `Options=${kept.join(',')}`;
  });
}

interface QuotaSpec extends IdSpec {
  quota_mode: string;
}

function narrowQuotaSpec(ctx: ExecutorContext): QuotaSpec {
  const base = narrowIdSpec(ctx, 'fs.set_quota_mode');
  const mode = (ctx.spec as Record<string, unknown>).quota_mode;
  if (typeof mode !== 'string') {
    throw new Error('fs.set_quota_mode: spec is missing quota_mode');
  }
  return { ...base, quota_mode: mode };
}

/**
 * fs.set_quota_mode: preflight captures the CURRENT unit text (per-run
 * WeakMap, the S4 pre-state pattern) → apply rewrites the Options=
 * quota flag + daemon-reload, remounting (stop + enable --now) when the
 * filesystem is live so the flag takes effect → verify re-reads the
 * unit. Rollback restores the captured text + daemon-reload and
 * remounts if the filesystem was mounted pre-task.
 */
export function makeFsSetQuotaModeExecutor(opts: { host: FsHost }): Executor {
  const host = opts.host;
  const preState = new WeakMap<object, { text: string; wasMounted: boolean }>();
  return {
    operation_kind: 'fs.set_quota_mode',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, mountpoint } = narrowQuotaSpec(ctx);
          const text = await host.readUnit(id);
          if (text === null) {
            throw new Error(`preflight: unit ${id} does not exist on disk`);
          }
          const mounts = await host.readMounts();
          preState.set(ctx.spec as object, {
            text,
            wasMounted: mounts.some((m) => m.mountpoint === mountpoint),
          });
          ctx.emitOutput(`preflight ok: captured ${id}`);
        },
      },
      {
        name: 'apply',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, quota_mode } = narrowQuotaSpec(ctx);
          const pre = preState.get(ctx.spec as object);
          if (!pre) throw new Error('fs.set_quota_mode: preflight pre-state missing');
          await host.writeUnit(id, rewriteQuotaFlag(pre.text, quota_mode));
          await host.daemonReload();
          if (pre.wasMounted) {
            await host.stop(id);
            await host.enableNow(id);
            ctx.emitOutput(`remounted ${id} with ${quota_mode}`);
          } else {
            ctx.emitOutput(`rewrote ${id} Options= (${quota_mode}); not mounted — no remount`);
          }
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, mountpoint, quota_mode } = narrowQuotaSpec(ctx);
          const text = await host.readUnit(id);
          const optionsLine = /^Options=(.*)$/m.exec(text ?? '')?.[1] ?? '';
          const options = optionsLine.split(',');
          if (quota_mode !== 'none' && !options.includes(quota_mode)) {
            throw new Error(`verify: ${id} Options= does not carry ${quota_mode}`);
          }
          if (quota_mode === 'none' && options.some((o) => QUOTA_OPTION_FLAGS.has(o.trim()))) {
            throw new Error(`verify: ${id} Options= still carries a quota flag`);
          }
          const pre = preState.get(ctx.spec as object);
          if (pre?.wasMounted === true) {
            const mounts = await host.readMounts();
            if (!mounts.some((m) => m.mountpoint === mountpoint)) {
              throw new Error(`verify: ${mountpoint} did not come back after the remount`);
            }
          }
          ctx.emitOutput(`verified: ${id} quota flag → ${quota_mode}`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const { id, mountpoint } = narrowQuotaSpec(ctx);
      const pre = preState.get(ctx.spec as object);
      if (!pre) {
        ctx.emitOutput('rollback: no pre-state captured (preflight failed) — nothing changed');
        return;
      }
      await host.writeUnit(id, pre.text);
      await host.daemonReload();
      if (pre.wasMounted) {
        const mounts = await host.readMounts();
        if (!mounts.some((m) => m.mountpoint === mountpoint)) {
          await host.enableNow(id);
        }
      }
      ctx.emitOutput(`rollback: restored ${id} unit text${pre.wasMounted ? ' + remounted' : ''}`);
    },
  };
}

/**
 * fs.unmanage (DELETE): remove the .mount unit WITHOUT touching data.
 * Preflight refuses if the mountpoint is live (the provider's fs_mounted
 * blocker re-checked at the privilege boundary — unmount first) and
 * captures the unit text. Rollback re-installs the captured unit file
 * (enablement is NOT restored — restoring it would mount; the unit
 * returns disabled, noted in the output).
 */
export function makeFsUnmanageExecutor(opts: { host: FsHost }): Executor {
  const host = opts.host;
  const preText = new WeakMap<object, string>();
  return {
    operation_kind: 'fs.unmanage',
    stages: [
      {
        name: 'preflight',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id, mountpoint } = narrowIdSpec(ctx, 'fs.unmanage');
          const text = await host.readUnit(id);
          if (text === null) {
            throw new Error(`preflight: unit ${id} does not exist on disk`);
          }
          const mounts = await host.readMounts();
          if (mounts.some((m) => m.mountpoint === mountpoint)) {
            throw new Error(`preflight: ${mountpoint} is still mounted — unmount first`);
          }
          preText.set(ctx.spec as object, text);
          ctx.emitOutput(`preflight ok: ${id} present, ${mountpoint} not mounted`);
        },
      },
      {
        name: 'remove',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id } = narrowIdSpec(ctx, 'fs.unmanage');
          try {
            await host.disable(id);
          } catch {
            /* already disabled — fine */
          }
          await host.removeUnit(id);
          await host.daemonReload();
          ctx.emitOutput(`removed ${id} (data untouched)`);
        },
      },
      {
        name: 'verify',
        async run(ctx: ExecutorContext): Promise<void> {
          const { id } = narrowIdSpec(ctx, 'fs.unmanage');
          if ((await host.readUnit(id)) !== null) {
            throw new Error(`verify: ${id} still present after removal`);
          }
          ctx.emitOutput(`verified: ${id} gone`);
        },
      },
    ],
    async rollback(ctx: ExecutorContext): Promise<void> {
      const { id } = narrowIdSpec(ctx, 'fs.unmanage');
      const text = preText.get(ctx.spec as object);
      if (text === undefined) {
        ctx.emitOutput('rollback: no pre-state captured (preflight failed) — nothing changed');
        return;
      }
      if ((await host.readUnit(id)) === null) {
        await host.writeUnit(id, text);
        await host.daemonReload();
      }
      ctx.emitOutput(`rollback: re-installed ${id} (left disabled — re-enable to remount)`);
    },
  };
}
