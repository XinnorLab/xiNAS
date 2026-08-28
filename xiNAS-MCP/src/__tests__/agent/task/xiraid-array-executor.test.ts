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
import { readSparepoolName } from '../../../lib/parse/raid.js';
import { SPAREPOOL_DETACH } from '../../../lib/xiraid/translate.js';

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
      // The daemon reads a present-but-empty string as NOT SUPPLIED
      // (gRPC/validation/helper.py::check_number_of_entries_helper): a modify
      // carrying only empty values has no modifiable argument at all.
      if (Object.values(rest).every((v) => v === '' || v === undefined)) {
        throw new Error(
          `Required arguments are missing — raid_modify '${name}' carried no modifiable argument`,
        );
      }
      const arr = arrays.find((a) => a.name === name);
      if (!arr) throw new Error(`no RAID named '${name}'`);
      Object.assign(arr, rest);
      // POOL_REMOVE_CMD ('null') removes the linkage instead of being stored
      // as a pool name (spare_pool/command_handler.py::assign_sparepool); the
      // daemon then reports '-' for that array, not a missing key.
      if (rest.sparepool === SPAREPOOL_DETACH) arr.sparepool = '-';
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
  return new TaskRunner({
    bridge,
    now: () => new Date(1_700_000_000_000 + n++ * 1000).toISOString(),
  });
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

  it('preflight failure (name collision) → rollback must NOT destroy the array it found', async () => {
    const fake = makeFake();
    // An array the operator already owns, wearing the name this create wants.
    fake.arrays.push({ name: 'data', level: '1', devices: ['/dev/other'], state: ['online'] });
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/s'], active: true });
    const events = await run(fake);

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_succeeded', 'rollback']);
    expect(fake.destroyCalls).toEqual([]); // we never created it → we never destroy it
    expect(fake.arrays).toHaveLength(1);
    expect(fake.pools).toHaveLength(1); // nor its spare pool
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
  function seedArray(fake: ReturnType<typeof makeFake>, over: Record<string, unknown> = {}): void {
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

  it("detach: raid_modify('null') → pool_deactivate → pool_delete", async () => {
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
    // The daemon DELETES the config key on POOL_REMOVE_CMD rather than storing
    // an empty name, and then renders that array's sparepool as '-' (observed
    // on 4.4.0). The executor's verify stage reads it back through
    // readSparepoolName(), which maps '-' to ''.
    expect(fake.arrays[0]?.sparepool).toBe('-');
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

  // The daemon reports "no spare pool" as the string "-", not "". Observed on a
  // live node (xicli 4.4.0 / driver 4.4.0-43861) on every array of a fresh
  // install. Read as a NAME it is neither '' nor xnsp_<array>, so the
  // foreign-pool guard rejected attaching spares to any array that had none.
  it('the daemon "-" sentinel is no spare pool, not a foreign one', async () => {
    const fake = makeFake();
    seedArray(fake, { sparepool: '-' });
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: ['d5'],
      device_by_id: { d5: '/dev/nvme5n1' },
    });
    expect(shape(events)).not.toContainEqual(['stage_failed', 'preflight']);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays[0]?.sparepool).toBe('xnsp_data');
  });

  it('detaching back to "-" verifies as detached, not as a mismatch', async () => {
    const fake = makeFake();
    seedArray(fake, { sparepool: '-' });
    const events = await runModify(fake, {
      id: 'data',
      spare_disk_ids: [],
      device_by_id: {},
    });
    expect(terminal(events)?.status).toBe('success');
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
    // Read it the way production does: the daemon renders a detached array as
    // '-', which readSparepoolName folds to '' along with the absent case.
    expect(readSparepoolName(fake.arrays[0]?.sparepool)).toBe('');
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
    mounts: Array<{
      source: string;
      mountpoint: string;
      options?: string[];
      super_options?: string[];
    }>,
    spec: Record<string, unknown> = { id: 'data' },
    transport?: XiraidTransport,
  ): Promise<TaskProgressEvent[]> {
    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayDeleteExecutor({
      client: new XiraidClient(transport ?? fake.transport),
      readMounts: async () => mounts,
      // Fast bounded verify wait so the async-propagation tests don't sleep.
      pollIntervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
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

  /** Concatenated human-readable stage output across all events. */
  const outputText = (events: TaskProgressEvent[]): string =>
    events.map((e) => e.output_inline ?? '').join('\n');

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

  // An array used ONLY as an XFS external log device never appears as a mount
  // SOURCE — it shows up as `logdev=/dev/xi_<id>` in the fs-specific super
  // options of the data filesystem's mount. Destroying it under a mounted
  // filesystem corrupts that filesystem's journal, so the guard must catch it.
  it('mount guard: array used as an external XFS log device → preflight fails, no destroy', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const events = await runDelete(fake, [
      {
        source: '/dev/xi_bulk',
        mountpoint: '/srv/share01',
        options: ['rw', 'noatime'],
        super_options: ['rw', 'attr2', 'inode64', 'logdev=/dev/xi_data', 'noquota'],
      },
    ]);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.destroyCalls).toEqual([]);
    expect(fake.arrays).toHaveLength(1); // untouched
    const failure = events.find((e) => e.stage_name === 'preflight' && e.error_message);
    expect(failure?.error_message).toContain('/srv/share01');
    expect(failure?.error_message).toContain('logdev');
  });

  it('mount guard: external-device option in the VFS options field is caught too', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const events = await runDelete(fake, [
      { source: '/dev/xi_bulk', mountpoint: '/srv/share01', options: ['rw', 'rtdev=/dev/xi_data'] },
    ]);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(fake.destroyCalls).toEqual([]);
  });

  it('mount guard: a like-named external device on another array does not block', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const events = await runDelete(fake, [
      {
        source: '/dev/xi_bulk',
        mountpoint: '/srv/share01',
        super_options: ['rw', 'logdev=/dev/xi_datalog'],
      },
    ]);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.destroyCalls).toEqual(['data']);
  });

  it('array vanished before begin → preflight fails → clean failed (destroy never attempted)', async () => {
    const fake = makeFake(); // no array seeded — stale observed state / repeat delete
    const events = await runDelete(fake, []);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_succeeded', 'rollback']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.destroyCalls).toEqual([]); // nothing destructive was attempted
  });

  it('daemon unreachable at preflight → clean failed, never manual recovery', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    fake.setDown(true); // raid_show throws everywhere, incl. inside rollback
    const events = await runDelete(fake, []);
    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(shape(events)).toContainEqual(['rollback_succeeded', 'rollback']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(fake.destroyCalls).toEqual([]);
    expect(fake.arrays).toHaveLength(1); // untouched
  });

  it('destroy fails mid-way with the array gone → rollback throws → requires_manual_recovery', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const transport: XiraidTransport = {
      ...fake.transport,
      // partial destroy: the daemon removed the array but the call errored out.
      async raidDestroy(req) {
        fake.destroyCalls.push(req.name ?? '');
        const i = fake.arrays.findIndex((a) => a.name === req.name);
        if (i >= 0) fake.arrays.splice(i, 1);
        throw new Error('connection reset mid-destroy');
      },
    };
    const events = await runDelete(fake, [], { id: 'data' }, transport);
    expect(shape(events)).toContainEqual(['stage_failed', 'destroy']);
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

  // ── Post-destroy hardening (§7): once raid_destroy succeeds, pool cleanup and
  //    verify are best-effort and must NEVER escalate to requires_manual_recovery ──

  it('post-destroy: pool_show failure is best-effort → success with warning, array gone', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    // The deterministic real-world culprit: pool_show errors on this daemon.
    // It runs only AFTER raid_destroy, so preflight is unaffected.
    fake.transport.poolShow = async () => {
      throw new Error('pool show unsupported on this daemon');
    };
    const events = await runDelete(fake, []);
    // The array was destroyed (irreversible, intended) → success, NOT
    // requires_manual_recovery for a post-destroy bookkeeping hiccup.
    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays).toEqual([]); // array actually gone
    expect(shape(events)).toContainEqual(['stage_succeeded', 'destroy']);
    expect(outputText(events)).toMatch(/spare-pool cleanup failed/i);
  });

  it('post-destroy: spare-pool deactivate failure is best-effort → success with warning', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/s'], active: true });
    fake.transport.poolDeactivate = async () => {
      throw new Error('daemon hiccup');
    };
    const events = await runDelete(fake, []);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays).toEqual([]);
    expect(outputText(events)).toMatch(/spare-pool cleanup failed/i);
  });

  it('post-destroy: a transient raid_show error during verify does NOT escalate → success with warning', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    let destroyed = false;
    const transport: XiraidTransport = {
      ...fake.transport,
      async raidDestroy(req) {
        await fake.transport.raidDestroy(req);
        destroyed = true;
      },
      async raidShow() {
        if (destroyed) throw new Error('raid_show timed out');
        return fake.transport.raidShow();
      },
    };
    const events = await runDelete(fake, [], { id: 'data' }, transport);
    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays).toEqual([]); // really destroyed
    expect(outputText(events)).toMatch(/could not confirm .* gone/i);
  });

  it('post-destroy: verify tolerates async propagation — array clears within the wait → success', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    let shows = 0;
    const transport: XiraidTransport = {
      ...fake.transport,
      // async daemon: destroy is accepted but raid_show still lists the array briefly.
      async raidDestroy() {},
      async raidShow() {
        shows += 1;
        // preflight (1) + first verify poll (2) still show it; then it clears.
        return shows >= 3
          ? []
          : [{ name: 'data', level: '5', devices: ['/dev/a'], state: ['online'] }];
      },
    };
    const events = await runDelete(fake, [], { id: 'data' }, transport);
    expect(terminal(events)?.status).toBe('success');
    expect(shape(events)).toContainEqual(['stage_succeeded', 'verify']);
  });

  it('post-destroy: array still present after the wait → clean failed (retryable), NOT manual recovery', async () => {
    const fake = makeFake();
    seedDoomed(fake);
    const transport: XiraidTransport = {
      ...fake.transport,
      // pathological: the daemon acknowledges the destroy but never removes the array.
      async raidDestroy() {},
    };
    const events = await runDelete(fake, [], { id: 'data' }, transport);
    expect(shape(events)).toContainEqual(['stage_failed', 'verify']);
    expect(terminal(events)).toMatchObject({
      status: 'failed',
      error_code: 'FAILED_PARTIAL_ROLLED_BACK',
    });
    expect(terminal(events)?.status).not.toBe('requires_manual_recovery');
    expect(fake.arrays).toHaveLength(1); // still there — surfaced honestly, retryable
  });
});

// ---- Real xiRAID 4.3.x payload shapes (#243 follow-up) ----
//
// The fake transport emits raid_show/pool_show as JSON arrays. The real
// daemon emits objects keyed by name, with devices as [idx, path, states]
// tuples. lib/parse normalizes both; the executors must too, or every
// stage that consults live state misreads an existing array as absent.

describe('executors against the real daemon payload shapes', () => {
  /** Wrap a fake transport so raid_show/pool_show speak xiRAID 4.3.x. */
  function realShapes(fake: ReturnType<typeof makeFake>): XiraidTransport {
    return {
      ...fake.transport,
      async raidShow() {
        const list = (await fake.transport.raidShow()) as Array<Record<string, unknown>>;
        return Object.fromEntries(
          list.map((a) => {
            // the keyed value carries no `name` — the key IS the name
            const { name, devices, state, ...rest } = a;
            return [
              name,
              {
                ...rest,
                state,
                devices: (devices as string[]).map((d, i) => [i, d, ['online']]),
              },
            ];
          }),
        );
      },
      async poolShow() {
        const list = (await fake.transport.poolShow()) as Array<Record<string, unknown>>;
        return Object.fromEntries(
          list.map((p) => [
            p.name,
            { drives: p.drives, state: p.active === true ? 'active' : 'inactive' },
          ]),
        );
      },
    };
  }

  it('delete: dict-keyed raid_show → preflight sees the array, destroy + pool cleanup run', async () => {
    const fake = makeFake();
    fake.arrays.push({ name: 'data', level: '5', devices: ['/dev/a'], state: ['online'] });
    fake.pools.push({ name: 'xnsp_data', drives: ['/dev/s'], active: true });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayDeleteExecutor({
      client: new XiraidClient(realShapes(fake)),
      readMounts: async () => [],
      pollIntervalMs: 1,
      timeoutMs: 5,
      sleep: async () => {},
    });
    await makeRunner().run(
      { task_id: 't-del-real', operation_kind: 'xiraid.array.delete', spec: { id: 'data' } },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(terminal(events)?.status).toBe('success');
    expect(fake.destroyCalls).toEqual(['data']);
    expect(fake.arrays).toEqual([]);
    expect(fake.pools).toEqual([]); // spare pool cleaned, not silently skipped
  });

  it('create preflight: dict-keyed raid_show still catches a name collision', async () => {
    const fake = makeFake();
    fake.arrays.push({ name: 'data', level: '5', devices: ['/dev/x'], state: ['online'] });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayCreateExecutor({
      client: new XiraidClient(realShapes(fake)),
      pollIntervalMs: 1,
      timeoutMs: 20,
      sleep: async () => {},
    });
    await makeRunner().run(
      { task_id: 't-arr-real', operation_kind: 'xiraid.array.create', spec: SPEC },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(terminal(events)?.status).toBe('failed');
    expect(fake.ops).toEqual([]); // raid_create never reached
  });

  it('modify: dict-keyed raid_show → tuning-only edit verifies instead of "array vanished"', async () => {
    const fake = makeFake();
    fake.arrays.push({ name: 'data', level: '6', devices: ['/dev/a'], state: ['online'] });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayModifyExecutor({ client: new XiraidClient(realShapes(fake)) });
    await makeRunner().run(
      {
        task_id: 't-mod-real',
        operation_kind: 'xiraid.array.modify',
        spec: { id: 'data', tuning: { init_prio: 42 } },
      },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(terminal(events)?.status).toBe('success');
    expect(fake.arrays[0]?.init_prio).toBe(42);
  });

  it('modify preflight: dict-keyed raid_show still catches a foreign sparepool', async () => {
    const fake = makeFake();
    fake.arrays.push({
      name: 'data',
      level: '6',
      devices: ['/dev/a'],
      state: ['online'],
      sparepool: 'legacy0', // operator-managed, not xnsp_data
    });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayModifyExecutor({ client: new XiraidClient(realShapes(fake)) });
    await makeRunner().run(
      {
        task_id: 't-mod-foreign',
        operation_kind: 'xiraid.array.modify',
        spec: { id: 'data', spare_disk_ids: ['d5'], device_by_id: { d5: '/dev/nvme5n1' } },
      },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(fake.ops).toEqual([]); // the operator's pool is never re-pointed
    expect(fake.arrays[0]?.sparepool).toBe('legacy0');
  });

  it('modify rollback: dict-keyed raid_show → the attached sparepool is detached again', async () => {
    const fake = makeFake({ failTuningModify: true });
    fake.arrays.push({ name: 'data', level: '6', devices: ['/dev/a'], state: ['online'] });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayModifyExecutor({ client: new XiraidClient(realShapes(fake)) });
    await makeRunner().run(
      {
        task_id: 't-mod-roll',
        operation_kind: 'xiraid.array.modify',
        spec: {
          id: 'data',
          spare_disk_ids: ['d5'],
          device_by_id: { d5: '/dev/nvme5n1' },
          tuning: { init_prio: 9 },
        },
      },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(shape(events)).toContainEqual(['stage_failed', 'apply_tuning']);
    // the pool is gone AND the array no longer references it — no dangling sparepool
    expect(fake.pools).toEqual([]);
    // Read it the way production does: the daemon renders a detached array as
    // '-', which readSparepoolName folds to '' along with the absent case.
    expect(readSparepoolName(fake.arrays[0]?.sparepool)).toBe('');
  });

  it('create preflight: tuple device lists still catch an already-claimed member', async () => {
    const fake = makeFake();
    fake.arrays.push({
      name: 'other',
      level: '5',
      devices: ['/dev/nvme2n1'], // a member of SPEC
      state: ['online'],
    });

    const events: TaskProgressEvent[] = [];
    const executor = makeXiraidArrayCreateExecutor({
      client: new XiraidClient(realShapes(fake)),
      pollIntervalMs: 1,
      timeoutMs: 20,
      sleep: async () => {},
    });
    await makeRunner().run(
      { task_id: 't-arr-claim', operation_kind: 'xiraid.array.create', spec: SPEC },
      executor,
      async (e) => {
        events.push(e);
      },
    );

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(fake.ops).toEqual([]); // raid_create never reached
  });
});
