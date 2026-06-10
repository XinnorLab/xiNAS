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
