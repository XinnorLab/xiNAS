import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';
import {
  createFakeXiraidTransport,
  makeUnimplementedTransport,
} from '../../../agent/xiraid/fake-transport.js';

function okTransport(): XiraidTransport {
  return {
    ...makeUnimplementedTransport(),
    raidShow: async () => [],
    raidCreate: async () => {},
    raidDestroy: async () => {},
  };
}

function downTransport(): XiraidTransport {
  const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6066'), {
    code: 'ECONNREFUSED',
  });
  return {
    ...makeUnimplementedTransport(),
    raidShow: async () => {
      throw err;
    },
    raidCreate: async () => {
      throw err;
    },
    raidDestroy: async () => {
      throw err;
    },
  };
}

describe('XiraidClient availability', () => {
  it('starts unknown; successful call → available', async () => {
    const client = new XiraidClient(okTransport());
    expect(client.availability()).toBe('unknown');
    await client.raidShow();
    expect(client.availability()).toBe('available');
  });

  it('failing call → unavailable + lastError, error rethrown', async () => {
    const client = new XiraidClient(downTransport());
    await expect(client.raidShow()).rejects.toThrow(/ECONNREFUSED/);
    expect(client.availability()).toBe('unavailable');
    expect(client.lastError()).toMatch(/ECONNREFUSED/);
  });

  it('recovers to available after a later success', async () => {
    let fail = true;
    const flaky: XiraidTransport = {
      ...makeUnimplementedTransport(),
      raidShow: async () => {
        if (fail) throw new Error('down');
        return [];
      },
      raidCreate: async () => {},
      raidDestroy: async () => {},
    };
    const client = new XiraidClient(flaky);
    await expect(client.raidShow()).rejects.toThrow();
    expect(client.availability()).toBe('unavailable');
    fail = false;
    await client.raidShow();
    expect(client.availability()).toBe('available');
  });
});

describe('createFakeXiraidTransport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-fake-xiraid-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('create → show → destroy round-trip persists to the state file', async () => {
    const t = createFakeXiraidTransport(dir);
    expect(await t.raidShow()).toEqual([]);
    await t.raidCreate({ name: 'data', level: '6', drives: ['/dev/a', '/dev/b'], strip_size: 64 });
    const arrays = (await t.raidShow()) as Array<Record<string, unknown>>;
    expect(arrays).toHaveLength(1);
    expect(arrays[0]).toMatchObject({
      name: 'data',
      level: '6',
      devices: ['/dev/a', '/dev/b'],
      state: ['online'],
    });
    // a second transport over the same dir sees the same state (file-backed)
    const t2 = createFakeXiraidTransport(dir);
    expect(await t2.raidShow()).toHaveLength(1);
    await t2.raidDestroy({ name: 'data' });
    expect(await t.raidShow()).toEqual([]);
  });

  it('duplicate name rejects; names ending in -fail reject (failure-path hook)', async () => {
    const t = createFakeXiraidTransport(dir);
    await t.raidCreate({ name: 'dup', level: '0', drives: ['/dev/a', '/dev/b'] });
    await expect(
      t.raidCreate({ name: 'dup', level: '0', drives: ['/dev/c', '/dev/d'] }),
    ).rejects.toThrow(/exists/);
    await expect(
      t.raidCreate({ name: 'roll-fail', level: '0', drives: ['/dev/c', '/dev/d'] }),
    ).rejects.toThrow(/fail/);
    expect(await t.raidShow()).toHaveLength(1);
  });

  // ---- S4 T2: pools / modify / import / config_only ----

  it('pool lifecycle: create/activate/add/remove/deactivate/delete; active pools cannot be deleted', async () => {
    const t = createFakeXiraidTransport(dir);
    await t.poolCreate({ name: 'xnsp_data', drives: ['/dev/s1'] });
    await expect(t.poolCreate({ name: 'xnsp_data', drives: ['/dev/s2'] })).rejects.toThrow(
      /exists/,
    );
    await t.poolActivate({ name: 'xnsp_data' });
    await t.poolAdd({ name: 'xnsp_data', drives: ['/dev/s2'] });
    await t.poolRemove({ name: 'xnsp_data', drives: ['/dev/s1'] });
    const pools = (await t.poolShow()) as Array<Record<string, unknown>>;
    expect(pools).toEqual([{ name: 'xnsp_data', drives: ['/dev/s2'], active: true }]);
    // deleting an ACTIVE pool rejects — forces the deactivate-first order
    await expect(t.poolDelete({ name: 'xnsp_data' })).rejects.toThrow(/active/);
    await t.poolDeactivate({ name: 'xnsp_data' });
    await t.poolDelete({ name: 'xnsp_data' });
    expect(await t.poolShow()).toEqual([]);
    await expect(t.poolAdd({ name: 'ghost', drives: ['/dev/x'] })).rejects.toThrow(/no pool/);
  });

  it('raidModify updates sparepool + echoes tuning onto the array entry', async () => {
    const t = createFakeXiraidTransport(dir);
    await t.raidCreate({ name: 'data', level: '5', drives: ['/dev/a', '/dev/b', '/dev/c'] });
    await t.raidModify({ name: 'data', sparepool: 'xnsp_data' });
    await t.raidModify({ name: 'data', init_prio: 42 });
    const [arr] = (await t.raidShow()) as Array<Record<string, unknown>>;
    expect(arr?.sparepool).toBe('xnsp_data');
    expect(arr?.init_prio).toBe(42);
    await expect(t.raidModify({ name: 'ghost', init_prio: 1 })).rejects.toThrow(/no RAID/);
  });

  it('import: show returns seeded candidates; apply adopts under new_name; unknown uuid rejects', async () => {
    const t = createFakeXiraidTransport(dir);
    t.seedImportCandidates?.([
      { uuid: 'u-1', name: 'foreign', level: '5', devices: ['/dev/x', '/dev/y'], recoverable: true },
    ]);
    expect(((await t.raidImportShow()) as unknown[]).length).toBe(1);
    await t.raidImportApply({ uuid: 'u-1', new_name: 'adopted' });
    const arrays = (await t.raidShow()) as Array<Record<string, unknown>>;
    expect(arrays[0]).toMatchObject({ name: 'adopted', state: ['online'] });
    expect(await t.raidImportShow()).toEqual([]); // candidate consumed
    await expect(t.raidImportApply({ uuid: 'nope' })).rejects.toThrow(/uuid/);
  });

  it('destroy tombstones: plain destroy wipes, config_only does not', async () => {
    const t = createFakeXiraidTransport(dir);
    await t.raidCreate({ name: 'a1', level: '0', drives: ['/dev/a', '/dev/b'] });
    await t.raidCreate({ name: 'a2', level: '0', drives: ['/dev/c', '/dev/d'] });
    await t.raidDestroy({ name: 'a1', force: true });
    await t.raidDestroy({ name: 'a2', config_only: true });
    const tombstones = t.tombstones?.() ?? [];
    expect(tombstones).toContainEqual({ name: 'a1', data_wiped: true });
    expect(tombstones).toContainEqual({ name: 'a2', data_wiped: false });
  });

  it('-fail-tuning rejects only a tuning-carrying raidModify', async () => {
    const t = createFakeXiraidTransport(dir);
    await t.raidCreate({ name: 'arr-fail-tuning', level: '0', drives: ['/dev/a', '/dev/b'] });
    // sparepool-only modify on the -fail-tuning name SUCCEEDS…
    await t.raidModify({ name: 'arr-fail-tuning', sparepool: 'xnsp_arr-fail-tuning' });
    // …a tuning-carrying modify REJECTS…
    await expect(t.raidModify({ name: 'arr-fail-tuning', init_prio: 5 })).rejects.toThrow(
      /tuning/,
    );
    // …and pool ops on the derived pool name are NOT tripped by -fail-tuning.
    await t.poolCreate({ name: 'xnsp_arr-fail-tuning', drives: ['/dev/s'] });
  });
});
