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
 * Rollbacks undo the DELTA this task caused, never the whole spec.
 * `pool add` fails as a unit when any drive is already a member, so an
 * inverse `poolRemove(spec.drives)` would strip drives the task never
 * added — observed live: a failed 3-drive add rolled back into a
 * `pool remove` of the pool's two pre-existing members (only the
 * daemon's all-or-nothing validation of the third, non-member drive
 * saved the pool). Each intent therefore snapshots membership/state
 * before mutating and reverses only what actually changed; an
 * unreadable snapshot means rollback does nothing, which is the safe
 * failure. Create→delete and delete (preflight-guarded, not reversible)
 * are unchanged.
 */

import { parsePoolShow } from '../../lib/parse/pool.js';
import { parseRaidShowEntries } from '../../lib/parse/raid.js';
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
  return {
    intent: s.intent,
    name: s.name,
    ...(s.drives !== undefined ? { drives: s.drives } : {}),
  };
}

function requireDrives(spec: PoolSpec): string[] {
  if (!Array.isArray(spec.drives) || spec.drives.length === 0) {
    throw new Error(`pool executor: intent '${spec.intent}' needs drives`);
  }
  return spec.drives;
}

/** Live membership + active flag of one pool, or null when it is absent. */
async function readPool(
  client: XiraidClient,
  name: string,
): Promise<{ drives: Set<string>; active: boolean } | null> {
  const pool = parsePoolShow(await client.poolShow()).find((p) => p.name === name);
  return pool === undefined ? null : { drives: new Set(pool.drives), active: pool.active };
}

/** The pre-stage snapshot the modify rollback diffs against. */
interface PoolSnapshot {
  drives: string[];
  active: boolean;
}

const SNAPSHOT_KEY = 'pool_before';

function takenSnapshot(ctx: ExecutorContext): PoolSnapshot | null {
  const snap = ctx.stash[SNAPSHOT_KEY];
  return typeof snap === 'object' && snap !== null ? (snap as PoolSnapshot) : null;
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
  const INTENTS = ['add_drives', 'remove_drives', 'activate', 'deactivate'];
  const stages: ExecutorStage[] = [
    {
      name: 'modify',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx, INTENTS);
        // Snapshot BEFORE mutating; a throw here fails the stage with the
        // pool untouched, and rollback then finds no snapshot and no-ops.
        const before = await readPool(opts.client, spec.name);
        if (before === null) {
          throw new Error(`pool '${spec.name}' not found (live pool_show)`);
        }
        ctx.stash[SNAPSHOT_KEY] = {
          drives: [...before.drives],
          active: before.active,
        } satisfies PoolSnapshot;

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
      const spec = narrowSpec(ctx, INTENTS);
      const before = takenSnapshot(ctx);
      if (before === null) return; // never mutated, or snapshot unreadable

      try {
        const after = await readPool(opts.client, spec.name);
        if (after === null) return; // pool vanished — nothing to reverse
        const wasMember = new Set(before.drives);

        switch (spec.intent) {
          case 'add_drives': {
            // Only the drives this task actually added, never a pre-existing member.
            const added = requireDrives(spec).filter(
              (d) => after.drives.has(d) && !wasMember.has(d),
            );
            if (added.length > 0) {
              ctx.emitOutput(`rollback: pool remove ${added.join(' ')}`);
              await opts.client.poolRemove({ name: spec.name, drives: added });
            }
            return;
          }
          case 'remove_drives': {
            const removed = requireDrives(spec).filter(
              (d) => wasMember.has(d) && !after.drives.has(d),
            );
            if (removed.length > 0) {
              ctx.emitOutput(`rollback: pool add ${removed.join(' ')}`);
              await opts.client.poolAdd({ name: spec.name, drives: removed });
            }
            return;
          }
          case 'activate': {
            if (after.active && !before.active)
              await opts.client.poolDeactivate({ name: spec.name });
            return;
          }
          default: {
            if (!after.active && before.active) await opts.client.poolActivate({ name: spec.name });
          }
        }
      } catch {
        /* best-effort: an unreadable pool means we do not guess a reversal */
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
        // parseRaidShowEntries, not a local Array.isArray check: the real
        // daemon keys raid_show by array name, and an array-only reader would
        // silently skip this guard and delete a pool an array still uses.
        const refs = parseRaidShowEntries(await opts.client.raidShow())
          .filter((a) => a.raw.sparepool === spec.name)
          .map((a) => a.name);
        if (refs.length > 0) {
          throw new Error(
            `pool '${spec.name}' is the spare pool of: ${refs.join(', ')} (live raid_show)`,
          );
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
