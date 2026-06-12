import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeXiraidTransport } from '../../../agent/xiraid/fake-transport.js';
import { XiraidClient } from '../../../agent/xiraid/client.js';
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

  it('modify rollback applies the inverse verb', async () => {
    seed({ pools: [{ name: 'p3', drives: ['/dev/a'], active: false }] });
    const modify = makePoolModifyExecutor({ client: client() });
    await modify.stages[0]?.run(ctxFor({ intent: 'activate', name: 'p3' }));
    expect(load().pools[0]?.active).toBe(true);
    await modify.rollback(ctxFor({ intent: 'activate', name: 'p3' }));
    expect(load().pools[0]?.active).toBe(false);
  });
});
