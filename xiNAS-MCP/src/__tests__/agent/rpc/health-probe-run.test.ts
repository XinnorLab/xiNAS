import { describe, expect, it } from 'vitest';
import type { ProbeHost } from '../../../agent/health/probe-host.js';
import { createDispatcher } from '../../../agent/rpc/dispatch.js';
import { makeHealthProbeRunHandler } from '../../../agent/rpc/methods/health-probe-run.js';
import { makeDeepProbeRunner } from '../../../agent/rpc/methods/health-probe.js';
import type { ProbeOutcome } from '../../../lib/health/probe-types.js';

const outcome = (ok: boolean, over: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
  ok,
  started_at: 's',
  completed_at: 'c',
  artifact: null,
  cleanup: { status: 'clean' },
  ...over,
});
const gatedHost = (gate: Promise<void>): ProbeHost => ({
  fsIo: async () => {
    await gate;
    return outcome(true);
  },
  nfsLoopback: async () => outcome(true),
  busy: () => null,
});

/** S19a T2 — spec §9.2/§9.5: one probe at a time per node, validated params. */
describe('health.probe.run handler', () => {
  it('validates params: probe kind, absolute path, timeout bounds', async () => {
    const h = makeHealthProbeRunHandler({ probeHost: gatedHost(Promise.resolve()) });
    await expect(h({ probe: 'scrub', path: '/mnt/a' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(h({ probe: 'fs_io', path: 'relative' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(h({ probe: 'fs_io', path: '/mnt/a', timeout_ms: 999_999 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(h({ probe: 'fs_io', path: '/mnt/a', timeout_ms: 10 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('runs one probe and echoes probe/path; a second concurrent call is PROBE_IN_PROGRESS', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeHealthProbeRunHandler({ probeHost: gatedHost(gate) });
    const first = h({
      probe: 'fs_io',
      path: '/mnt/a',
      run_id: '11111111-1111-4111-8111-111111111111',
    });
    await expect(h({ probe: 'nfs_loopback', path: '/srv/x' })).rejects.toMatchObject({
      code: 'PROBE_IN_PROGRESS',
      details: { probe: 'fs_io', path: '/mnt/a' },
    });
    release();
    expect(await first).toMatchObject({ probe: 'fs_io', path: '/mnt/a', ok: true });
    // the guard is released afterwards
    expect(await h({ probe: 'nfs_loopback', path: '/srv/x' })).toMatchObject({
      probe: 'nfs_loopback',
      ok: true,
    });
  });

  it('passes run_id and timeout through to the host (defaults: null, 20 s)', async () => {
    const seen: Array<{ runId: string | null; timeoutMs: number }> = [];
    const host: ProbeHost = {
      fsIo: async (_m, o) => {
        seen.push(o);
        return outcome(true);
      },
      nfsLoopback: async (_e, o) => {
        seen.push(o);
        return outcome(true);
      },
      busy: () => null,
    };
    const h = makeHealthProbeRunHandler({ probeHost: host });
    await h({ probe: 'fs_io', path: '/mnt/a' });
    await h({
      probe: 'nfs_loopback',
      path: '/srv/x',
      run_id: '99999999-9999-4999-8999-999999999999',
      timeout_ms: 5_000,
    });
    expect(seen).toEqual([
      { runId: null, timeoutMs: 20_000 },
      { runId: '99999999-9999-4999-8999-999999999999', timeoutMs: 5_000 },
    ]);
  });

  it('F06: run_id must be a health.context UUID', async () => {
    const handler = makeHealthProbeRunHandler({ probeHost: gatedHost(Promise.resolve()) });
    await expect(
      handler({ probe: 'nfs_loopback', path: '/export', run_id: '../outside', timeout_ms: 1000 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      handler({ probe: 'fs_io', path: '/mnt/x', run_id: 'smoke-1', timeout_ms: 1000 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('F08: a probe held by the host (deep path) refuses a direct probe with PROBE_IN_PROGRESS', async () => {
    const host: ProbeHost = {
      ...gatedHost(Promise.resolve()),
      busy: () => ({ probe: 'fs_io', path: '/mnt/data' }),
    };
    const handler = makeHealthProbeRunHandler({ probeHost: host });
    await expect(
      handler({ probe: 'nfs_loopback', path: '/export', timeout_ms: 1000 }),
    ).rejects.toMatchObject({
      code: 'PROBE_IN_PROGRESS',
      details: { probe: 'fs_io', path: '/mnt/data' },
    });
  });

  it('F08: a host that refuses between busy() and the call is still an RPC error', async () => {
    // The gate closed after busy() answered null — the verb's own refusal
    // outcome must not be returned as a successful probe result. review
    // fix 4: `details` always carries the REQUESTED probe/path plus the
    // outcome's own message, whether or not busy() still holds a record.
    const host: ProbeHost = {
      ...gatedHost(Promise.resolve()),
      fsIo: async () =>
        outcome(false, {
          error: {
            code: 'PROBE_IN_PROGRESS',
            message: 'a nfs_loopback probe is in flight on /export',
            stage: 'lock',
          },
          cleanup: { status: 'not_needed' },
        }),
    };
    const handler = makeHealthProbeRunHandler({ probeHost: host });
    await expect(handler({ probe: 'fs_io', path: '/mnt/data' })).rejects.toMatchObject({
      code: 'PROBE_IN_PROGRESS',
      details: {
        probe: 'fs_io',
        path: '/mnt/data',
        message: 'a nfs_loopback probe is in flight on /export',
      },
    });
  });

  it('review fix 4: when busy() still holds a record at that point, it nests under details.in_flight', async () => {
    let heldAfter: { probe: 'fs_io' | 'nfs_loopback'; path: string } | null = null;
    const host: ProbeHost = {
      fsIo: async () => {
        heldAfter = { probe: 'nfs_loopback', path: '/export' };
        return outcome(false, {
          error: {
            code: 'PROBE_IN_PROGRESS',
            message: 'a nfs_loopback probe is in flight on /export',
            stage: 'lock',
          },
          cleanup: { status: 'not_needed' },
        });
      },
      nfsLoopback: async () => outcome(true),
      busy: () => heldAfter,
    };
    const handler = makeHealthProbeRunHandler({ probeHost: host });
    await expect(handler({ probe: 'fs_io', path: '/mnt/data' })).rejects.toMatchObject({
      code: 'PROBE_IN_PROGRESS',
      details: {
        probe: 'fs_io',
        path: '/mnt/data',
        message: 'a nfs_loopback probe is in flight on /export',
        in_flight: { probe: 'nfs_loopback', path: '/export' },
      },
    });
  });

  it('over the dispatcher: PROBE_IN_PROGRESS travels as -32000 data.code', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatch = createDispatcher({
      'health.probe.run': makeHealthProbeRunHandler({ probeHost: gatedHost(gate) }),
    });
    const call = (id: number, params: unknown) =>
      dispatch(JSON.stringify({ jsonrpc: '2.0', id, method: 'health.probe.run', params }));
    const first = call(1, { probe: 'fs_io', path: '/mnt/a' });
    const second = JSON.parse(await call(2, { probe: 'fs_io', path: '/mnt/b' }));
    expect(second.error).toEqual({
      code: -32000,
      message: 'a health probe is already in flight on this node',
      data: { code: 'PROBE_IN_PROGRESS', probe: 'fs_io', path: '/mnt/a' },
    });
    release();
    expect(JSON.parse(await first).result).toMatchObject({ ok: true });
    const bad = JSON.parse(await call(3, { probe: 'nope', path: '/mnt/a' }));
    expect(bad.error.code).toBe(-32602);
  });
});

describe('makeDeepProbeRunner over the new host', () => {
  it('probes every mounted fs with runId null; loopback only with an export; listing failure rejects (F04b)', async () => {
    const seen: string[] = [];
    const host: ProbeHost = {
      fsIo: async (m, o) => {
        seen.push(`${m}:${o.runId}`);
        return m === '/mnt/bad'
          ? outcome(false, { error: { code: 'EIO', message: 'fake', stage: 'write' } })
          : outcome(true);
      },
      nfsLoopback: async (e, o) => {
        seen.push(`loop:${e}:${o.runId}`);
        return outcome(true, { cleanup: { status: 'failed', detail: 'systemd-umount: busy' } });
      },
      busy: () => null,
    };
    const runner = makeDeepProbeRunner({
      probeHost: host,
      listMountedManaged: async () => ['/mnt/ok', '/mnt/bad'],
    });
    const r = await runner('/srv/ok');
    expect(r.fs_io).toEqual([
      { mountpoint: '/mnt/ok', ok: true, cleanup: { status: 'clean' } },
      { mountpoint: '/mnt/bad', ok: false, error: 'EIO: fake', cleanup: { status: 'clean' } },
    ]);
    expect(r.nfs_loopback).toEqual({
      attempted: true,
      export: '/srv/ok',
      ok: true,
      cleanup: { status: 'failed', detail: 'systemd-umount: busy' },
    });
    expect(seen).toEqual(['/mnt/ok:null', '/mnt/bad:null', 'loop:/srv/ok:null']);

    expect((await runner(null)).nfs_loopback).toBeNull();
    const broken = makeDeepProbeRunner({
      probeHost: host,
      listMountedManaged: async () => {
        throw new Error('mountinfo unreadable');
      },
    });
    await expect(broken(null)).rejects.toMatchObject({
      code: 'INVENTORY_UNAVAILABLE',
      status: 'error',
    });
  });
});
