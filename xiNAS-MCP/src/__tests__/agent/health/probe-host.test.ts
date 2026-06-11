import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeProbeHost } from '../../../agent/health/fake-probe-host.js';
import { createRealProbeHost } from '../../../agent/health/probe-host.js';
import { makeDeepProbeRunner } from '../../../agent/rpc/methods/health-probe.js';

const dir = mkdtempSync(join(tmpdir(), 'xinas-probe-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createRealProbeHost.touchProbe', () => {
  it('writes, reads back, deletes; failure is a result, not a throw', async () => {
    const host = createRealProbeHost();
    const ok = await host.touchProbe(dir);
    expect(ok).toEqual({ ok: true });
    // the probe file must be gone afterwards
    expect(() => readFileSync(join(dir, '.xinas-health-probe'))).toThrow();

    const bad = await host.touchProbe(join(dir, 'does/not/exist'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe('createFakeProbeHost', () => {
  it('honors fail lists, records ops, and always records loopback umount', async () => {
    writeFileSync(
      join(dir, 'probe-host-state.json'),
      JSON.stringify({ fail_touch: ['/mnt/bad'], fail_loopback: ['/srv/bad'] }),
    );
    const host = createFakeProbeHost(dir);
    expect((await host.touchProbe('/mnt/ok')).ok).toBe(true);
    expect((await host.touchProbe('/mnt/bad')).ok).toBe(false);
    expect((await host.loopbackMount('/srv/ok')).ok).toBe(true);
    expect((await host.loopbackMount('/srv/bad')).ok).toBe(false);
    const state = JSON.parse(readFileSync(join(dir, 'probe-host-state.json'), 'utf8'));
    expect(state.ops).toEqual([
      'touch:/mnt/ok',
      'touch:/mnt/bad',
      'loopback:/srv/ok',
      'loopback-umount:/srv/ok',
      'loopback:/srv/bad',
      'loopback-umount:/srv/bad',
    ]);
  });
});

describe('makeDeepProbeRunner', () => {
  it('touches every mounted fs; loopback only with an export; listing failure → empty', async () => {
    const host = createFakeProbeHost(dir);
    const runner = makeDeepProbeRunner({
      probeHost: host,
      listMountedManaged: async () => ['/mnt/ok', '/mnt/bad'],
    });
    const result = await runner('/srv/ok');
    expect(result.fs_io).toEqual([
      { mountpoint: '/mnt/ok', ok: true },
      { mountpoint: '/mnt/bad', ok: false, error: expect.stringContaining('fake touch') },
    ]);
    expect(result.nfs_loopback).toMatchObject({ attempted: true, export: '/srv/ok', ok: true });

    const noExports = await runner(null);
    expect(noExports.nfs_loopback).toBeNull();

    const broken = makeDeepProbeRunner({
      probeHost: host,
      listMountedManaged: async () => {
        throw new Error('mountinfo unreadable');
      },
    });
    expect((await broken(null)).fs_io).toEqual([]);
  });
});
