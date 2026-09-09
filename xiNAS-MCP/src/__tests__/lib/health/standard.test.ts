import { describe, expect, it } from 'vitest';
import type { Section } from '../../../lib/health/collection.js';
import { driftNfsConfCheck } from '../../../lib/health/drift.js';
import {
  agentCollectorsCheck,
  collectionFailureCheck,
  filesystemIoCheck,
  nfsLoopbackCheck,
  probeUnavailable,
  rdmaLiveCheck,
  xiraidLicenseCheck,
  xiraidServiceCheck,
} from '../../../lib/health/standard.js';

const at = '2023-11-14T22:13:20.000Z';
const ok = <T>(value: T): Section<T> => ({ status: 'success', observed_at: at, value });
const failed = (
  status: 'error' | 'timeout' | 'permission_denied',
  code: string,
): Section<never> => ({
  status,
  observed_at: at,
  error: { code, message: `${code} happened` },
});
const absent: Section<never> = {
  status: 'not_supported',
  observed_at: at,
  error: { code: 'TOOL_ABSENT', message: 'ENOENT' },
};

/** S19a T1 — spec §7.2: the collection status → check status mapping. */
describe('collection status → check status (spec §7.2)', () => {
  it('not_supported is the ONLY status that yields skipped, and it says the tool is missing', () => {
    const c = xiraidLicenseCheck(absent);
    expect(c.status).toBe('skipped');
    expect(c.symptom).toContain('not installed');
    expect(c.evidence.collection).toEqual({
      status: 'not_supported',
      observed_at: at,
      code: 'TOOL_ABSENT',
      message: 'ENOENT',
    });
  });

  it.each(['error', 'timeout', 'permission_denied'] as const)(
    '%s → degraded with the code in evidence, on every probe-backed builder',
    (status) => {
      const builders = [
        xiraidLicenseCheck,
        xiraidServiceCheck,
        rdmaLiveCheck,
        agentCollectorsCheck,
        filesystemIoCheck,
        nfsLoopbackCheck,
      ] as Array<(s: Section<never>) => ReturnType<typeof xiraidLicenseCheck>>;
      for (const build of builders) {
        const c = build(failed(status, 'X_CODE'));
        expect(c.status, build.name).toBe('degraded');
        expect(c.symptom, build.name).toContain('collection failed: X_CODE');
        expect(c.evidence.collection, build.name).toMatchObject({ status, code: 'X_CODE' });
      }
    },
  );

  it('collectionFailureCheck answers undefined on success so the builder runs its own logic', () => {
    expect(collectionFailureCheck({ id: 'x', category: 'agent' }, ok(1))).toBeUndefined();
  });

  it('success + empty keeps the old skipped symptom but now says the query succeeded', () => {
    const c = rdmaLiveCheck(ok([]));
    expect(c.status).toBe('skipped');
    expect(c.symptom).toBe('no RDMA links reported');
    expect(c.evidence.collection).toEqual({ status: 'success', observed_at: at });
    expect(agentCollectorsCheck(ok({})).status).toBe('skipped');
    expect(filesystemIoCheck(ok({ fs_io: [], nfs_loopback: null })).status).toBe('skipped');
    expect(nfsLoopbackCheck(ok({ fs_io: [], nfs_loopback: null })).status).toBe('skipped');
    expect(xiraidServiceCheck(ok({})).status).toBe('skipped');
  });

  it('success values flow into the existing logic and carry collection evidence', () => {
    expect(
      xiraidLicenseCheck(ok({ status: 'active', days_left: 100, features: [] })),
    ).toMatchObject({
      status: 'ok',
      evidence: { days_left: 100, collection: { status: 'success', observed_at: at } },
    });
    expect(
      xiraidLicenseCheck(ok({ status: 'expired', days_left: null, features: [] })).status,
    ).toBe('critical');
    expect(xiraidLicenseCheck(ok({ status: 'active', days_left: 3, features: [] })).status).toBe(
      'warning',
    );
    // success + null license: xiRAID ran xicli and printed no record — not "xicli missing"
    const noRecord = xiraidLicenseCheck(ok(null));
    expect(noRecord.status).toBe('skipped');
    expect(noRecord.evidence.collection).toMatchObject({ status: 'success' });
    expect(xiraidServiceCheck(ok({ XiraidArray: 'error: down' })).status).toBe('critical');
    expect(xiraidServiceCheck(ok({ XiraidArray: 'running' })).status).toBe('ok');
    expect(rdmaLiveCheck(ok([{ netdev: 'ibp0', state: 'DOWN' }])).status).toBe('degraded');
    expect(agentCollectorsCheck(ok({ a: 'running', b: 'error: x' })).status).toBe('degraded');
    expect(
      filesystemIoCheck(
        ok({ fs_io: [{ mountpoint: '/m', ok: false, error: 'EIO' }], nfs_loopback: null }),
      ).status,
    ).toBe('critical');
    expect(
      nfsLoopbackCheck(
        ok({ fs_io: [], nfs_loopback: { attempted: true, export: '/srv', ok: true } }),
      ).status,
    ).toBe('ok');
  });

  it('probeUnavailable degrades every probe-backed check with EXECUTOR_UNAVAILABLE collection evidence', () => {
    const checks = probeUnavailable('deep', 'connect refused');
    expect(checks.map((c) => c.id)).toEqual([
      'xiraid.license',
      'xiraid.service',
      'network.rdma-live',
      'agent.collectors',
      'drift.nfs-conf',
      'filesystem.io',
      'nfs.loopback',
    ]);
    for (const c of checks) {
      expect(c.status).toBe('degraded');
      expect(c.evidence.collection).toEqual({
        status: 'error',
        observed_at: null,
        code: 'EXECUTOR_UNAVAILABLE',
        message: 'connect refused',
      });
    }
  });

  it('drift.nfs-conf: a failed render section is degraded; undefined stays the quick-profile skip', () => {
    const failedRender = driftNfsConfCheck(
      { threads: 8 },
      failed('error', 'HELPER_UNREACHABLE'),
      {},
    );
    expect(failedRender.status).toBe('degraded');
    expect(failedRender.evidence.collection).toMatchObject({ code: 'HELPER_UNREACHABLE' });
    const quick = driftNfsConfCheck({ threads: 8 }, undefined, {});
    expect(quick.status).toBe('skipped');
    const matching = driftNfsConfCheck({ threads: 8 }, ok({ '/etc/nfs.conf': 'sha256:abc' }), {
      '/etc/nfs.conf': 'sha256:abc',
    });
    expect(matching.status).toBe('ok');
    expect(matching.evidence.collection).toMatchObject({ status: 'success' });
  });
});
