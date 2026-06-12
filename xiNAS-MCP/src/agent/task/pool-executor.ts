/**
 * Pool executors (S9 T9, ADR-0011): create / modify / delete over the
 * existing xiRAID client verbs.
 *
 * The DELETE executor's preflight re-checks LIVE `pool_show` (active)
 * and `raid_show` (sparepool references) before mutating — the
 * provider's observed-state blockers are best-effort UX; this is the
 * TOCTOU guarantee (an array created since the last sweep still
 * blocks here).
 *
 * Rollbacks are inverse-verb best-effort: create→delete,
 * add→remove / remove→add, activate→deactivate (and vice versa);
 * delete is preflight-guarded and not reversible after the fact.
 */

import { parsePoolShow } from '../../lib/parse/pool.js';
import type { XiraidClient } from '../xiraid/client.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

interface PoolSpec {
  intent: string;
  name: string;
  drives?: string[];
}

function narrowSpec(ctx: ExecutorContext, expected: string[]): PoolSpec {
  const s = ctx.spec as Partial<PoolSpec>;
  if (typeof s.name !== 'string' || typeof s.intent !== 'string') {
    throw new Error('pool executor: enriched spec missing name/intent');
  }
  if (!expected.includes(s.intent)) {
    throw new Error(`pool executor: unexpected intent '${s.intent}'`);
  }
  return { intent: s.intent, name: s.name, ...(s.drives !== undefined ? { drives: s.drives } : {}) };
}

function requireDrives(spec: PoolSpec): string[] {
  if (!Array.isArray(spec.drives) || spec.drives.length === 0) {
    throw new Error(`pool executor: intent '${spec.intent}' needs drives`);
  }
  return spec.drives;
}

export function makePoolCreateExecutor(opts: { client: XiraidClient }): Executor {
  const stages: ExecutorStage[] = [
    {
      name: 'create',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx, ['create']);
        const drives = requireDrives(spec);
        ctx.emitOutput(`pool create ${spec.name} (${drives.length} drive(s))`);
        await opts.client.poolCreate({ name: spec.name, drives });
      },
    },
  ];
  return {
    operation_kind: 'pool.create',
    stages,
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = narrowSpec(ctx, ['create']);
      try {
        await opts.client.poolDelete({ name: spec.name });
      } catch {
        /* best-effort: nothing to undo when create never landed */
      }
    },
  };
}

export function makePoolModifyExecutor(opts: { client: XiraidClient }): Executor {
  const stages: ExecutorStage[] = [
    {
      name: 'modify',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx, ['add_drives', 'remove_drives', 'activate', 'deactivate']);
        ctx.emitOutput(`pool ${spec.intent} ${spec.name}`);
        switch (spec.intent) {
          case 'add_drives':
            await opts.client.poolAdd({ name: spec.name, drives: requireDrives(spec) });
            return;
          case 'remove_drives':
            await opts.client.poolRemove({ name: spec.name, drives: requireDrives(spec) });
            return;
          case 'activate':
            await opts.client.poolActivate({ name: spec.name });
            return;
          default:
            await opts.client.poolDeactivate({ name: spec.name });
        }
      },
    },
  ];
  return {
    operation_kind: 'pool.modify',
    stages,
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = narrowSpec(ctx, ['add_drives', 'remove_drives', 'activate', 'deactivate']);
      try {
        switch (spec.intent) {
          case 'add_drives':
            await opts.client.poolRemove({ name: spec.name, drives: requireDrives(spec) });
            return;
          case 'remove_drives':
            await opts.client.poolAdd({ name: spec.name, drives: requireDrives(spec) });
            return;
          case 'activate':
            await opts.client.poolDeactivate({ name: spec.name });
            return;
          default:
            await opts.client.poolActivate({ name: spec.name });
        }
      } catch {
        /* best-effort inverse */
      }
    },
  };
}

export function makePoolDeleteExecutor(opts: { client: XiraidClient }): Executor {
  const stages: ExecutorStage[] = [
    {
      name: 'preflight',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx, ['delete']);
        // LIVE re-check (review P1): observed blockers may lag.
        const pools = parsePoolShow(await opts.client.poolShow());
        const pool = pools.find((p) => p.name === spec.name);
        if (pool === undefined) {
          throw new Error(`pool '${spec.name}' not found (live pool_show)`);
        }
        if (pool.active) {
          throw new Error(`pool '${spec.name}' is ACTIVE (live pool_show) — deactivate first`);
        }
        const raidPayload = await opts.client.raidShow();
        if (Array.isArray(raidPayload)) {
          const refs = raidPayload
            .filter(
              (a): a is { name: string; sparepool?: string } =>
                typeof a === 'object' &&
                a !== null &&
                (a as { sparepool?: unknown }).sparepool === spec.name,
            )
            .map((a) => a.name);
          if (refs.length > 0) {
            throw new Error(
              `pool '${spec.name}' is the spare pool of: ${refs.join(', ')} (live raid_show)`,
            );
          }
        }
        ctx.emitOutput('live preflight clean (inactive, unreferenced)');
      },
    },
    {
      name: 'delete',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx, ['delete']);
        ctx.emitOutput(`pool delete ${spec.name}`);
        await opts.client.poolDelete({ name: spec.name });
      },
    },
  ];
  return {
    operation_kind: 'pool.delete',
    stages,
    async rollback(): Promise<void> {
      /* preflight-guarded; a completed delete is not reversible here */
    },
  };
}
