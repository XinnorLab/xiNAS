import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeXiraidTransport } from '../../../agent/xiraid/fake-transport.js';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';
import {
  makePoolCreateExecutor,
  makePoolDeleteExecutor,
  makePoolModifyExecutor,
} from '../../../agent/task/pool-executor.js';
import type { ExecutorContext } from '../../../agent/task/types.js';

const dir = mkdtempSync(join(tmpdir(), 'xinas-pool-exec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(state: Record<string, unknown>): void {
  writeFileSync(
    join(dir, 'xiraid-state.json'),
    JSON.stringify({ arrays: [], pools: [], import_candidates: [], tombstones: [], ...state }),
  );
}

function load(): { pools: Array<{ name: string; drives: string[]; active: boolean }> } {
  return JSON.parse(require('node:fs').readFileSync(join(dir, 'xiraid-state.json'), 'utf8'));
}

const ctxFor = (spec: unknown): ExecutorContext => ({
  spec,
  emitOutput: () => {},
  isCancelRequested: () => false,
  stash: {},
});

const client = () => new XiraidClient(createFakeXiraidTransport(dir));

describe('pool executors (S9 T9, fake transport)', () => {
  beforeEach(() => seed({}));

  it('create → modify intents → delete lifecycle against the fake host', async () => {
    const create = makePoolCreateExecutor({ client: client() });
    await create.stages[0]?.run(ctxFor({ intent: 'create', name: 'p1', drives: ['/dev/a'] }));
    expect(load().pools).toEqual([{ name: 'p1', drives: ['/dev/a'], active: false }]);

    const modify = makePoolModifyExecutor({ client: client() });
    await modify.stages[0]?.run(ctxFor({ intent: 'add_drives', name: 'p1', drives: ['/dev/b'] }));
    expect(load().pools[0]?.drives).toContain('/dev/b');
    await modify.stages[0]?.run(ctxFor({ intent: 'activate', name: 'p1' }));
    expect(load().pools[0]?.active).toBe(true);
    await modify.stages[0]?.run(ctxFor({ intent: 'deactivate', name: 'p1' }));
    await modify.stages[0]?.run(
      ctxFor({ intent: 'remove_drives', name: 'p1', drives: ['/dev/b'] }),
    );
    expect(load().pools[0]?.drives).toEqual(['/dev/a']);

    const del = makePoolDeleteExecutor({ client: client() });
    const ctx = ctxFor({ intent: 'delete', name: 'p1' });
    await del.stages[0]?.run(ctx); // live preflight
    await del.stages[1]?.run(ctx);
    expect(load().pools).toEqual([]);
  });

  it('delete preflight: live ACTIVE and live REFERENCE both fail before mutation', async () => {
    seed({ pools: [{ name: 'p2', drives: ['/dev/a'], active: true }] });
    const del = makePoolDeleteExecutor({ client: client() });
    await expect(del.stages[0]?.run(ctxFor({ intent: 'delete', name: 'p2' }))).rejects.toThrow(
      /ACTIVE/,
    );

    seed({
      pools: [{ name: 'p2', drives: ['/dev/a'], active: false }],
      arrays: [{ name: 'data1', level: 5, devices: ['/dev/c'], state: 'online', sparepool: 'p2' }],
    });
    await expect(del.stages[0]?.run(ctxFor({ intent: 'delete', name: 'p2' }))).rejects.toThrow(
      /spare pool of: data1/,
    );
    expect(load().pools).toHaveLength(1); // nothing mutated
  });

  it('delete preflight: the live REFERENCE guard survives a dict-keyed raid_show', async () => {
    // The real xiRAID 4.3.x daemon keys raid_show by array name. An array-only
    // reader skips the guard entirely and deletes a pool still in use.
    seed({ pools: [{ name: 'p2', drives: ['/dev/a'], active: false }] });
    const transport: XiraidTransport = {
      ...createFakeXiraidTransport(dir),
      async raidShow() {
        return {
          data1: {
            level: 5,
            devices: [[0, '/dev/c', ['online']]],
            state: 'online',
            sparepool: 'p2',
          },
        };
      },
    };
    const del = makePoolDeleteExecutor({ client: new XiraidClient(transport) });
    await expect(del.stages[0]?.run(ctxFor({ intent: 'delete', name: 'p2' }))).rejects.toThrow(
      /spare pool of: data1/,
    );
    expect(load().pools).toHaveLength(1); // nothing mutated
  });

  it('modify rollback reverses an activate the task performed', async () => {
    seed({ pools: [{ name: 'p3', drives: ['/dev/a'], active: false }] });
    const modify = makePoolModifyExecutor({ client: client() });
    // The runner hands the SAME ctx to the stage and to rollback (runner.ts:100).
    const ctx = ctxFor({ intent: 'activate', name: 'p3' });
    await modify.stages[0]?.run(ctx);
    expect(load().pools[0]?.active).toBe(true);
    await modify.rollback(ctx);
    expect(load().pools[0]?.active).toBe(false);
  });

  it('modify rollback leaves a pool that was ALREADY active alone', async () => {
    seed({ pools: [{ name: 'p3', drives: ['/dev/a'], active: true }] });
    const modify = makePoolModifyExecutor({ client: client() });
    const ctx = ctxFor({ intent: 'activate', name: 'p3' });
    await modify.stages[0]?.run(ctx);
    await modify.rollback(ctx);
    expect(load().pools[0]?.active).toBe(true); // not deactivated by the inverse verb
  });

  it('modify rollback never removes a drive the add did not add', async () => {
    // The live failure (xiRAID event log, 2026-07-10): `pool add` rejects the
    // whole request when ANY drive is already a member, and the old inverse-verb
    // rollback answered with `pool remove` over the ENTIRE spec — targeting the
    // pool's two pre-existing members. Only the daemon's all-or-nothing check on
    // the third, non-member drive kept the pool intact.
    seed({ pools: [{ name: 'p4', drives: ['/dev/a', '/dev/b'], active: false }] });
    const removed: string[][] = [];
    const transport: XiraidTransport = {
      ...createFakeXiraidTransport(dir),
      async poolAdd() {
        throw new Error(
          "13 INTERNAL: Drive '/dev/a' is already a part of the 'p4' spare pool. " +
            "Drive '/dev/b' is already a part of the 'p4' spare pool.",
        );
      },
      async poolRemove(req) {
        removed.push(req.drives);
      },
    };
    const modify = makePoolModifyExecutor({ client: new XiraidClient(transport) });
    const ctx = ctxFor({
      intent: 'add_drives',
      name: 'p4',
      drives: ['/dev/a', '/dev/b', '/dev/c'],
    });

    await expect(modify.stages[0]?.run(ctx)).rejects.toThrow(/already a part/);
    await modify.rollback(ctx);

    expect(removed).toEqual([]); // no pool remove at all — nothing was added
    expect(load().pools[0]?.drives).toEqual(['/dev/a', '/dev/b']);
  });

  it('modify rollback removes exactly the drives a partial add landed', async () => {
    seed({ pools: [{ name: 'p5', drives: ['/dev/a'], active: false }] });
    const fake = createFakeXiraidTransport(dir);
    const transport: XiraidTransport = {
      ...fake,
      async poolAdd(req) {
        // /dev/c lands, then the daemon fails the request.
        await fake.poolAdd({ name: req.name, drives: ['/dev/c'] });
        throw new Error('13 INTERNAL: pool add failed after partial apply');
      },
    };
    const modify = makePoolModifyExecutor({ client: new XiraidClient(transport) });
    const ctx = ctxFor({ intent: 'add_drives', name: 'p5', drives: ['/dev/c', '/dev/d'] });

    await expect(modify.stages[0]?.run(ctx)).rejects.toThrow(/partial apply/);
    await modify.rollback(ctx);

    expect(load().pools[0]?.drives).toEqual(['/dev/a']); // /dev/c undone, /dev/a untouched
  });

  it('modify rollback restores only the drives a remove actually took out', async () => {
    seed({ pools: [{ name: 'p6', drives: ['/dev/a', '/dev/b'], active: false }] });
    const fake = createFakeXiraidTransport(dir);
    const transport: XiraidTransport = {
      ...fake,
      async poolRemove(req) {
        await fake.poolRemove({ name: req.name, drives: ['/dev/b'] });
        throw new Error('13 INTERNAL: pool remove failed after partial apply');
      },
    };
    const modify = makePoolModifyExecutor({ client: new XiraidClient(transport) });
    // /dev/z was never a member — rollback must not add it to the pool.
    const ctx = ctxFor({ intent: 'remove_drives', name: 'p6', drives: ['/dev/b', '/dev/z'] });

    await expect(modify.stages[0]?.run(ctx)).rejects.toThrow(/partial apply/);
    await modify.rollback(ctx);

    expect(load().pools[0]?.drives).toEqual(['/dev/a', '/dev/b']);
  });

  it('modify: a pool absent from live pool_show fails before mutating', async () => {
    seed({ pools: [] });
    const modify = makePoolModifyExecutor({ client: client() });
    const ctx = ctxFor({ intent: 'add_drives', name: 'ghost', drives: ['/dev/a'] });
    await expect(modify.stages[0]?.run(ctx)).rejects.toThrow(/not found/);
    await modify.rollback(ctx); // no snapshot → no-op, no throw
  });
});
