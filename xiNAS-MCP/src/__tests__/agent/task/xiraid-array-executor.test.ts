import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../../../agent/task/runner.js';
import type { TaskProgressEvent } from '../../../agent/task/types.js';
import { makeXiraidArrayCreateExecutor } from '../../../agent/task/xiraid-array-executor.js';
import { XinasHistoryBridge } from '../../../agent/task/xinas-history-bridge.js';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';
import { makeUnimplementedTransport } from '../../../agent/xiraid/fake-transport.js';

/** In-memory fake xiRAID with injectable failure modes. */
function makeFake(opts: { failCreate?: 'clean' | 'partial'; downAfterCreate?: boolean } = {}) {
  const arrays: Array<{ name: string; level: string; devices: string[]; state: string[] }> = [];
  let down = false;
  const destroyCalls: string[] = [];
  const transport: XiraidTransport = {
    ...makeUnimplementedTransport(),
    async raidShow() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      return arrays.map((a) => ({ ...a }));
    },
    async raidCreate(req) {
      if (opts.failCreate === 'partial') {
        arrays.push({ name: req.name, level: req.level, devices: req.drives, state: ['online'] });
        if (opts.downAfterCreate) down = true;
        throw new Error('create failed after registering the array');
      }
      if (opts.failCreate === 'clean') throw new Error('create rejected');
      arrays.push({ name: req.name, level: req.level, devices: req.drives, state: ['online'] });
    },
    async raidDestroy(req) {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      destroyCalls.push(req.name ?? '');
      const i = arrays.findIndex((a) => a.name === req.name);
      if (i >= 0) arrays.splice(i, 1);
    },
  };
  return { arrays, destroyCalls, transport, setDown: (v: boolean) => (down = v) };
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

  it('spec without device_by_id → preflight fails before any change', async () => {
    const fake = makeFake();
    const { device_by_id: _omit, ...bare } = SPEC;
    const events = await run(fake, bare);

    expect(shape(events)).toContainEqual(['stage_failed', 'preflight']);
    expect(fake.arrays).toHaveLength(0);
    expect(fake.destroyCalls).toEqual([]);
  });
});
