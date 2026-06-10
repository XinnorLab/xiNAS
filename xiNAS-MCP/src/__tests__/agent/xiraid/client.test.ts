import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';
import { createFakeXiraidTransport } from '../../../agent/xiraid/fake-transport.js';

function okTransport(): XiraidTransport {
  return {
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
});
