import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../../../agent/task/runner.js';
import type { TaskProgressEvent } from '../../../agent/task/types.js';
import {
  makeXiraidArrayCreateExecutor,
  makeXiraidArrayDeleteExecutor,
  makeXiraidArrayImportExecutor,
  makeXiraidArrayModifyExecutor,
} from '../../../agent/task/xiraid-array-executor.js';
import { XinasHistoryBridge } from '../../../agent/task/xinas-history-bridge.js';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';
import { makeUnimplementedTransport } from '../../../agent/xiraid/fake-transport.js';

/** In-memory fake xiRAID with injectable failure modes (+ pool state + op log, S4). */
function makeFake(
  opts: {
    failCreate?: 'clean' | 'partial';
    downAfterCreate?: boolean;
    /** Reject any raidModify that carries tuning keys (targets apply_tuning). */
    failTuningModify?: boolean;
    /** Reject raidDestroy BEFORE removing the array (delete-failure path). */
    failDestroy?: boolean;
  } = {},
) {
  const arrays: Array<{
    name: string;
    level: string;
    devices: string[];
    state: string[];
    sparepool?: string;
    [key: string]: unknown;
  }> = [];
  const pools: Array<{ name: string; drives: string[]; active: boolean }> = [];
  let down = false;
  const destroyCalls: string[] = [];
  const ops: string[] = [];
  const transport: XiraidTransport = {
    ...makeUnimplementedTransport(),
    async raidShow() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      return arrays.map((a) => ({ ...a }));
    },
    async raidCreate(req) {
      ops.push(`raidCreate:${req.name}`);
      if (opts.failCreate === 'partial') {
        arrays.push({ name: req.name, level: req.level, devices: req.drives, state: ['online'] });
        if (opts.downAfterCreate) down = true;
        throw new Error('create failed after registering the array');
      }
      if (opts.failCreate === 'clean') throw new Error('create rejected');
      arrays.push({
        name: req.name,
        level: req.level,
        devices: req.drives,
        state: ['online'],
        ...(req.sparepool !== undefined ? { sparepool: req.sparepool } : {}),
      });
    },
    async raidDestroy(req) {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      destroyCalls.push(req.name ?? '');
      ops.push(`raidDestroy:${req.name}`);
      if (opts.failDestroy) throw new Error('destroy rejected');
      const i = arrays.findIndex((a) => a.name === req.name);
      if (i >= 0) arrays.splice(i, 1);
    },
    async raidModify(req) {
      const { name, ...rest } = req;
      const tuningKeys = Object.keys(rest).filter((k) => k !== 'sparepool');
      ops.push(`raidModify:${name}:${Object.keys(rest).sort().join(',')}`);
      if (opts.failTuningModify && tuningKeys.length > 0) {
        throw new Error('forced tuning-modify failure');
      }
      const arr = arrays.find((a) => a.name === name);
      if (!arr) throw new Error(`no RAID named '${name}'`);
      Object.assign(arr, rest);
    },
    async poolCreate(req) {
      ops.push(`poolCreate:${req.name}`);
      if (pools.some((p) => p.name === req.name)) throw new Error(`pool ${req.name} exists`);
      pools.push({ name: req.name, drives: [...req.drives], active: false });
    },
    async poolActivate(req) {
      ops.push(`poolActivate:${req.name}`);
      const p = pools.find((x) => x.name === req.name);
      if (!p) throw new Error(`no pool ${req.name}`);
      p.active = true;
    },
    async poolDeactivate(req) {
      ops.push(`poolDeactivate:${req.name}`);
      const p = pools.find((x) => x.name === req.name);
      if (!p) throw new Error(`no pool ${req.name}`);
      p.active = false;
    },
    async poolDelete(req) {
      ops.push(`poolDelete:${req.name}`);
      const i = pools.findIndex((x) => x.name === req.name);
      if (i < 0) throw new Error(`no pool ${req.name}`);
      if (pools[i]?.active) throw new Error(`pool ${req.name} is active`);
      pools.splice(i, 1);
    },
    async poolAdd(req) {
      ops.push(`poolAdd:${req.name}:${req.drives.join(',')}`);
      const p = pools.find((x) => x.name === req.name);
      if (!p) throw new Error(`no pool ${req.name}`);
      p.drives = [...new Set([...p.drives, ...req.drives])];
    },
    async poolRemove(req) {
      ops.push(`poolRemove:${req.name}:${req.drives.join(',')}`);
      const p = pools.find((x) => x.name === req.name);
      if (!p) throw new Error(`no pool ${req.name}`);
      p.drives = p.drives.filter((d) => !req.drives.includes(d));
    },
    async poolShow() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      return pools.map((p) => ({ ...p }));
    },
  };
  return { arrays, pools, destroyCalls, ops, transport, setDown: (v: boolean) => (down = v) };
}

function makeRunner(): TaskRunner {
  const bridge = new XinasHistoryBridge({
    runSubprocess: async () => ({ stdout: JSON.stringify({ id: 'snap-x' }), code: 0 }),
  });
  let n = 0;
  return new TaskRunner({ bridge, now: () => new Date(1_700_000_000_000 + n++ * 1000).toISOString() });
}

const SPEC = {
  name: 'data',
  level: 'raid6',
  member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
  device_by_id: {
    d1: '/dev/nvme1n1',
    d2: '/dev/nvme2n1',
    d3: '/dev/nvme3n1',
    d4: '/dev/nvme4n1',
  },
};

async function run(
  fake: ReturnType<typeof makeFake>,
  spec: Record<string, unknown> = SPEC,
): Promise<TaskProgressEvent[]> {
  const events: TaskProgressEvent[] = [];
  const publish = vi.fn(async (e: TaskProgressEvent) => {
    events.push(e);
  });
  const executor = makeXiraidArrayCreateExecutor({
    client: new XiraidClient(fake.transport),
    pollIntervalMs: 1,
    timeoutMs: 20,
    sleep: async () => {},
  });
  await makeRunner().run(
    { task_id: 't-arr', operation_kind: 'xiraid.array.create', spec },
    executor,
    publish,
  );
  return events;
}

const shape = (events: TaskProgressEvent[]) => events.map((e) => [e.event_type, e.stage_name]);
const terminal = (events: TaskProgressEvent[]) => events[events.length - 1];

describe('xiraid.array.create executor', () => {
  it('success: preflight/create/wait_online/verify → terminal success; array exists', async () => {
    const fake = makeFake();
    const events = await run(fake);

    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['stage_started', 'preflight'],
      ['stage_succeeded', 'preflight'],
      ['stage_started', 'create'],
      ['stage_succeeded', 'create'],
      ['stage_started', 'wait_online'],
      ['stage_succeeded', 'wait_online'],
      ['stage_started', 'verify'],
      ['stage_succeeded', 'verify'],
      ['stage_succeeded', 'snapshot_after'],
      ['terminal', undefined],
    ]);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays).toHaveLength(1);
    expect(fake.arrays[0]).toMatchObject({
      name: 'data',
      level: '6',
      devices: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
    });
  });

  it('preflight failure (device already claimed) → rollback is a no-op, no destroy', async () => {
    const fake = makeFake();
    fake.arrays.push({
      name: 'other',
      level: '1',
      devices: ['/dev/nvme1n1', '/dev/nvme9n1'],
      state: ['online'],
    });
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_succeeded', 'rollback']);
    expect(terminal(events)).toMatchObject({
      event_type: 'terminal',
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.destroyCalls).toEqual([]); // nothing was created → nothing destroyed
    expect(fake.arrays).toHaveLength(1); // the pre-existing array is untouched
  });

  it('clean create failure → rollback finds no array, no destroy, terminal failed', async () => {
    const fake = makeFake({ failCreate: 'clean' });
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['stage_failed', 'create']);
    expect(fake.destroyCalls).toEqual([]);
    expect(terminal(events)?.status).toBe('failed');
  });

  it('partial create failure → rollback destroys the half-created array', async () => {
    const fake = makeFake({ failCreate: 'partial' });
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['stage_failed', 'create']);
    expect(fake.destroyCalls).toEqual(['data']);
    expect(fake.arrays).toHaveLength(0);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
  });

  it('daemon down during rollback → rollback_failed → requires_manual_recovery', async () => {
    const fake = makeFake({ failCreate: 'partial', downAfterCreate: true });
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['rollback_failed', 'rollback']);
    expect(terminal(events)).toMatchObject({
      status: 'requires_manual_recovery',
      error_code: 'FAILED_MANUAL_RECOVERY_REQUIRED',
    });
  });

  it('wait_online timeout (array never surfaces online) → rollback destroys', async () => {
    const fake = makeFake();
    // After create, force the state to something non-online forever.
    const origCreate = fake.transport.raidCreate.bind(fake.transport);
    fake.transport.raidCreate = async (req) => {
      await origCreate(req);
      const a = fake.arrays.find((x) => x.name === req.name);
      if (a) a.state = ['stuck'];
    };
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['stage_failed', 'wait_online']);
    expect(fake.destroyCalls).toEqual(['data']);
    expect(terminal(events)?.status).toBe('failed');
  });

  it('create-with-spares: pool created+activated BEFORE raid_create; rollback cleans the pool (S4 T4)', async () => {
    // success path — use the file-backed fake (records pools + order via state)
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createFakeXiraidTransport } = await import('../../../agent/xiraid/fake-transport.js');

    const dir = mkdtempSync(join(tmpdir(), 'xinas-exec-spares-'));
    try {
      const t = createFakeXiraidTransport(dir);
      const spec = {
        ...SPEC,
        spare_disk_ids: ['d5'],
        device_by_id: { ...SPEC.device_by_id, d5: '/dev/nvme5n1' },
      };
      const events: TaskProgressEvent[] = [];
      const executor = makeXiraidArrayCreateExecutor({
        client: new XiraidClient(t),
        pollIntervalMs: 1,
        timeoutMs: 20,
        sleep: async () => {},
      });
      await makeRunner().run(
        { task_id: 't-sp', operation_kind: 'xiraid.array.create', spec },
        executor,
        async (e) => {
          events.push(e);
        },
      );
      expect(terminal(events)?.status).toBe('success');
      const pools = (await t.poolShow()) as Array<Record<string, unknown>>;
      expect(pools).toEqual([{ name: 'xnsp_data', drives: ['/dev/nvme5n1'], active: true }]);
      const [arr] = (await t.raidShow()) as Array<Record<string, unknown>>;
      // raid_create carried the sparepool → the pool existed (and was active) first
      expect(arr?.sparepool).toBe('xnsp_data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create-with-spares rollback: raid_create rejects AFTER the pool exists → pool cleaned up', async () => {
    // In-memory fake: pool ops succeed, raidCreate rejects cleanly. (A
    // '-fail' name would trip the file-backed fake's POOL hook first — the
    // same trap the S4 review caught for the modify rollback test.)
    const fake = makeFake({ failCreate: 'clean' });
    const events = await run(fake, {
      ...SPEC,
      spare_disk_ids: ['d5'],
      device_by_id: { ...SPEC.device_by_id, d5: '/dev/nvme5n1' },
    });
    expect(shape(events)).toContainEqual(['stage_failed', 'create']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.pools).toEqual([]); // xnsp_data deactivated + deleted by rollback
    expect(fake.destroyCalls).toEqual([]); // array never existed
  });

  it('spec without device_by_id → preflight fails before any change', async () => {
    const fake = makeFake();
    const { device_by_id: _omit, ...bare } = SPEC;
    const events = await run(fake, bare);

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(fake.arrays).toHaveLength(0);
    expect(fake.destroyCalls).toEqual([]);
  });
});

// ---- S4 T6: xiraid.array.modify executor ----

describe('xiraid.array.modify executor', () => {
  function seedArray(
    fake: ReturnType<typeof makeFake>,
    over: Record<string, unknown> = {},
  ): void {
    fake.arrays.push({
      name: 'data',
      level: '6',
      devices: ['/dev/nvme1n1', '/dev/nvme2n1'],
      state: ['online'],
      ...over,
    });
  }

  async function runModify(
    fake: ReturnType<typeof makeFake>,
    spec: Record<string, unknown>,
  ): Promise<TaskProgressEvent[]> {
    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayModifyExecutor({ client: new XiraidClient(fake.transport) });
    await makeRunner().run(
      { task_id: 't-mod', operation_kind: 'xiraid.array.modify', spec },
      executor,
      async (e) => {
        events.push(e);
      },
    );
    return events;
  }

  it('attach: pool_create → pool_activate → raid_modify{sparepool}; tuning stage skips', async () => {
    const fake = makeFake();
    seedArray(fake);
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: ['d5'],
      device_by_id: { d5: '/dev/nvme5n1' },
    });
    expect(terminal(events)?.status).toBe('success');
    expect(fake.ops).toEqual([
      'poolCreate:xnsp_data',
      'poolActivate:xnsp_data',
      'raidModify:data:sparepool',
    ]);
    expect(fake.pools).toEqual([{ name: 'xnsp_data', drives: ['/dev/nvme5n1'], active: true }]);
    expect(fake.arrays[0]?.sparepool).toBe('xnsp_data');
  });

  it('membership change: pool_add/pool_remove deltas only, no re-create or activation churn', async () => {
    const fake = makeFake();
    seedArray(fake, { sparepool: 'xnsp_data' });
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/nvme5n1'], active: true });
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: ['d6'],
      device_by_id: { d6: '/dev/nvme6n1' },
    });
    expect(terminal(events)?.status).toBe('success');
    expect(fake.ops).toEqual([
      'poolAdd:xnsp_data:/dev/nvme6n1',
      'poolRemove:xnsp_data:/dev/nvme5n1',
    ]);
    expect(fake.pools[0]?.drives).toEqual(['/dev/nvme6n1']);
  });

  it('detach: raid_modify("") → pool_deactivate → pool_delete', async () => {
    const fake = makeFake();
    seedArray(fake, { sparepool: 'xnsp_data' });
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/nvme5n1'], active: true });
    const events = await runModify(fake, { id: 'data', spare_disk_ids: [] });
    expect(terminal(events)?.status).toBe('success');
    expect(fake.ops).toEqual([
      'raidModify:data:sparepool',
      'poolDeactivate:xnsp_data',
      'poolDelete:xnsp_data',
    ]);
    expect(fake.pools).toEqual([]);
    expect(fake.arrays[0]?.sparepool).toBe('');
  });

  it('tuning-only: single raid_modify, no pool calls; spares stage skips', async () => {
    const fake = makeFake();
    seedArray(fake);
    const events = await runModify(fake, { id: 'data', tuning: { init_prio: 42 } });
    expect(terminal(events)?.status).toBe('success');
    expect(fake.ops).toEqual(['raidModify:data:init_prio']);
    expect(fake.arrays[0]?.init_prio).toBe(42);
  });

  it('foreign sparepool → preflight fails, no pool calls', async () => {
    const fake = makeFake();
    seedArray(fake, { sparepool: 'legacy0' });
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: ['d5'],
      device_by_id: { d5: '/dev/nvme5n1' },
    });
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(terminal(events)?.status).toBe('failed');
    expect(fake.ops).toEqual([]);
  });

  it('tuning fails after a successful attach → rollback inverts the pool ops', async () => {
    const fake = makeFake({ failTuningModify: true });
    seedArray(fake);
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: ['d5'],
      device_by_id: { d5: '/dev/nvme5n1' },
      tuning: { init_prio: 9 },
    });
    expect(shape(events)).toContainEqual(['stage_failed', 'apply_tuning']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    // pool gone again, sparepool detached — back to the pre-state
    expect(fake.pools).toEqual([]);
    expect(fake.arrays[0]?.sparepool ?? '').toBe('');
  });
});

// ---- S4 T8: xiraid.array.import executor ----

describe('xiraid.array.import executor', () => {
  async function withFakeDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xinas-exec-import-'));
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function runImport(
    transport: XiraidTransport,
    spec: Record<string, unknown>,
  ): Promise<TaskProgressEvent[]> {
    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayImportExecutor({ client: new XiraidClient(transport) });
    await makeRunner().run(
      { task_id: 't-imp', operation_kind: 'xiraid.array.import', spec },
      executor,
      async (e) => {
        events.push(e);
      },
    );
    return events;
  }

  it('adopt happy path: preflight/adopt/verify → success; candidate consumed', async () => {
    await withFakeDir(async (dir) => {
      const { createFakeXiraidTransport } = await import('../../../agent/xiraid/fake-transport.js');
      const t = createFakeXiraidTransport(dir);
      t.seedImportCandidates([
        { uuid: 'u-1', name: 'foreign', level: '5', devices: ['/dev/x'], recoverable: true },
      ]);
      const events = await runImport(t, { uuid: 'u-1', new_name: 'adopted' });
      expect(terminal(events)?.status).toBe('success');
      const arrays = (await t.raidShow()) as Array<Record<string, unknown>>;
      expect(arrays[0]).toMatchObject({ name: 'adopted', state: ['online'] });
      expect(await t.raidImportShow()).toEqual([]);
    });
  });

  it('unknown uuid → preflight fails, rollback no-op, terminal failed', async () => {
    await withFakeDir(async (dir) => {
      const { createFakeXiraidTransport } = await import('../../../agent/xiraid/fake-transport.js');
      const t = createFakeXiraidTransport(dir);
      const events = await runImport(t, { uuid: 'ghost' });
      expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
      expect(terminal(events)).toMatchObject({
        status: 'failed',
        error_code: 'FAILED_PARTIAL_ROLLED_BACK',
      });
      expect(await t.raidShow()).toEqual([]);
      expect(t.tombstones()).toEqual([]); // nothing destroyed
    });
  });

  it('direct rollback after adopt: config-only un-adopt (no data wipe)', async () => {
    await withFakeDir(async (dir) => {
      const { createFakeXiraidTransport } = await import('../../../agent/xiraid/fake-transport.js');
      const t = createFakeXiraidTransport(dir);
      t.seedImportCandidates([
        { uuid: 'u-2', name: 'foreign', level: '5', devices: ['/dev/x'], recoverable: true },
      ]);
      await t.raidImportApply({ uuid: 'u-2', new_name: 'oops' });
      const executor = makeXiraidArrayImportExecutor({ client: new XiraidClient(t) });
      const outputs: string[] = [];
      await executor.rollback({
        spec: { uuid: 'u-2', new_name: 'oops' },
        stash: {},
        emitOutput: (l) => outputs.push(l),
        isCancelRequested: () => false,
      });
      expect(await t.raidShow()).toEqual([]);
      expect(t.tombstones()).toContainEqual({ name: 'oops', data_wiped: false });
    });
  });

  it('non-recoverable candidate → preflight fails', async () => {
    await withFakeDir(async (dir) => {
      const { createFakeXiraidTransport } = await import('../../../agent/xiraid/fake-transport.js');
      const t = createFakeXiraidTransport(dir);
      t.seedImportCandidates([
        { uuid: 'u-3', name: 'broken', level: '5', devices: ['/dev/x'], recoverable: false },
      ]);
      const events = await runImport(t, { uuid: 'u-3' });
      expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
      expect(terminal(events)?.status).toBe('failed');
    });
  });
});

// ---- S4 T10: xiraid.array.delete executor ----

describe('xiraid.array.delete executor', () => {
  async function runDelete(
    fake: ReturnType<typeof makeFake>,
    mounts: Array<{ source: string; mountpoint: string }>,
    spec: Record<string, unknown> = { id: 'data' },
  ): Promise<TaskProgressEvent[]> {
    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayDeleteExecutor({
      client: new XiraidClient(fake.transport),
      readMounts: async () => mounts,
    });
    await makeRunner().run(
      { task_id: 't-del', operation_kind: 'xiraid.array.delete', spec },
      executor,
      async (e) => {
        events.push(e);
      },
    );
    return events;
  }

  function seedDoomed(fake: ReturnType<typeof makeFake>): void {
    fake.arrays.push({ name: 'data', level: '5', devices: ['/dev/a'], state: ['online'] });
  }

  it('happy: destroy + spare-pool cleanup → success', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/s'], active: true });
    const events = await runDelete(fake, []);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.destroyCalls).toEqual(['data']);
    expect(fake.arrays).toEqual([]);
    expect(fake.pools).toEqual([]);
  });

  it('mount guard: volume mounted → preflight fails → clean failed (no destroy, no manual recovery)', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const events = await runDelete(fake, [{ source: '/dev/xi_data', mountpoint: '/mnt/d' }]);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_succeeded', 'rollback']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.destroyCalls).toEqual([]);
    expect(fake.arrays).toHaveLength(1); // untouched
  });

  it('array vanished before begin → rollback throws → requires_manual_recovery', async () => {
    const fake = makeFake(); // no array seeded
    const events = await runDelete(fake, []);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_failed', 'rollback']);
    expect(terminal(events)).toMatchObject({
      status: 'requires_manual_recovery',
      error_code: 'FAILED_MANUAL_RECOVERY_REQUIRED',
    });
  });

  it('destroy rejected with the array intact → clean failed via no-op rollback', async () => {
    const fake = makeFake({ failDestroy: true });
    seedDoomed(fake);
    const events = await runDelete(fake, []);
    expect(shape(events)).toContainEqual(['stage_failed', 'destroy']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.arrays).toHaveLength(1);
  });

  it('pool cleanup fails AFTER the destroy → rollback throws → manual recovery', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    // an active pool whose deactivate explodes: simulate by replacing poolDeactivate
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/s'], active: true });
    fake.transport.poolDeactivate = async () => {
      throw new Error('daemon hiccup');
    };
    const events = await runDelete(fake, []);
    expect(shape(events)).toContainEqual(['stage_failed', 'destroy']);
    expect(shape(events)).toContainEqual(['rollback_failed', 'rollback']);
    expect(terminal(events)?.status).toBe('requires_manual_recovery');
    expect(fake.arrays).toEqual([]); // the array IS gone — manual recovery is honest
  });
});
