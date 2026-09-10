import { describe, expect, it } from 'vitest';
import { ProbeCollectionError } from '../../../agent/health/collect.js';
import { createRealNetHost } from '../../../agent/net/host.js';
import {
  type HealthProbeDeps,
  type HealthProbeResultV2,
  makeDeepProbeRunner,
  makeHealthProbeHandler,
} from '../../../agent/rpc/methods/health-probe.js';
import { filesystemIoCheck, rdmaLiveCheck } from '../../../lib/health/standard.js';
import { parseXicliLicense } from '../../../lib/parse/xicli-license.js';

const GOLDEN_VALID = [
  'License information:',
  'hwkey: ABCD-1234-SECRET-KEY-MATERIAL',
  'status: valid',
  'expiration date: 2026-09-09',
  'levels: 0 1 5 6 7 10 50 60 70',
].join('\n');

// 2026-06-11T00:00:00Z
const NOW = () => Date.parse('2026-06-11T00:00:00Z');

describe('parseXicliLicense', () => {
  it('valid license → active with days_left and features; NO raw fields', () => {
    const parsed = parseXicliLicense(GOLDEN_VALID, NOW);
    expect(parsed.status).toBe('active');
    expect(parsed.days_left).toBe(90);
    expect(parsed.features).toContain('5');
    // the recoverable material must not appear anywhere in the struct
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
    expect(JSON.stringify(parsed)).not.toContain('hwkey');
  });

  it('expired / invalid / empty', () => {
    expect(parseXicliLicense('status: expired\n', NOW).status).toBe('expired');
    expect(parseXicliLicense('status: valid\nexpiration date: 2026-06-01\n', NOW).status).toBe(
      'expired',
    );
    expect(parseXicliLicense('', NOW).status).toBe('absent');
    expect(parseXicliLicense('garbage text\n', NOW).status).toBe('absent');
  });
});

// The agent's clock for observed_at (distinct from NOW, the license clock).
const CLOCK = () => 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const AT = '2023-11-14T22:13:20.000Z';

function deps(over: Partial<HealthProbeDeps> = {}): HealthProbeDeps {
  return {
    readLicenseText: async () => GOLDEN_VALID,
    rdmaLinkShow: async () =>
      JSON.stringify([{ ifname: 'ibp65s0/1', state: 'ACTIVE', physical_state: 'LINK_UP' }]),
    getCollectorHealth: () => ({ disk: 'running', xiraid: 'running' }),
    dryRenderNfsProfile: async () => ({ '/etc/nfs/nfsd.conf': 'sha256:abc' }),
    now: NOW,
    clock: CLOCK,
    ...over,
  };
}

/** S19a T1 (spec §7.1): every section carries a typed collection status. */
describe('health.probe handler (schema 2)', () => {
  it('rejects bad levels; assembles every standard section as success with the clock time', async () => {
    const handler = makeHealthProbeHandler(deps());
    await expect(handler({ level: 'quick' })).rejects.toThrow(/level/);

    const result = (await handler({
      level: 'standard',
      desired_nfs_profile: { versions: {} },
    })) as HealthProbeResultV2;
    expect(result.schema).toBe(2);
    expect(result.sections.license.status).toBe('success');
    expect(result.sections.license.observed_at).toBe(AT);
    expect(result.sections.license.value?.status).toBe('active');
    expect(result.sections.rdma_links).toMatchObject({
      status: 'success',
      value: [{ ifname: 'ibp65s0/1', state: 'ACTIVE', physical_state: 'LINK_UP' }],
    });
    expect(result.sections.collectors).toMatchObject({
      status: 'success',
      value: { disk: 'running', xiraid: 'running' },
    });
    expect(result.sections.nfs_profile_render).toMatchObject({
      status: 'success',
      value: { '/etc/nfs/nfsd.conf': 'sha256:abc' },
    });
    expect(result.sections.probes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('each failing source degrades only its own section, with the reason kept', async () => {
    const handler = makeHealthProbeHandler(
      deps({
        readLicenseText: async () => {
          throw Object.assign(new Error('spawn xicli ENOENT'), { code: 'ENOENT' });
        },
        rdmaLinkShow: async () => {
          throw Object.assign(new Error('rdma: EACCES'), { code: 'EACCES' });
        },
        dryRenderNfsProfile: async () => {
          throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', 'refused');
        },
      }),
    );
    const result = (await handler({
      level: 'standard',
      desired_nfs_profile: { versions: {} },
    })) as HealthProbeResultV2;
    expect(result.sections.license).toEqual({
      status: 'not_supported',
      observed_at: AT,
      error: { code: 'TOOL_ABSENT', message: 'spawn xicli ENOENT' },
    });
    expect(result.sections.rdma_links).toMatchObject({
      status: 'permission_denied',
      error: { code: 'EACCES' },
    });
    expect(result.sections.nfs_profile_render).toMatchObject({
      status: 'error',
      error: { code: 'HELPER_UNREACHABLE', message: 'refused' },
    });
    expect(result.sections.collectors.status).toBe('success'); // unaffected section
  });

  it('a license text of null is success with value null (xicli ran, printed nothing)', async () => {
    const handler = makeHealthProbeHandler(deps({ readLicenseText: async () => null }));
    const result = (await handler({ level: 'standard' })) as HealthProbeResultV2;
    expect(result.sections.license).toEqual({ status: 'success', observed_at: AT, value: null });
  });

  it('rdma: empty output is success with []; non-object rows are dropped', async () => {
    const empty = makeHealthProbeHandler(deps({ rdmaLinkShow: async () => '' }));
    expect(
      ((await empty({ level: 'standard' })) as HealthProbeResultV2).sections.rdma_links,
    ).toEqual({ status: 'success', observed_at: AT, value: [] });
    const mixed = makeHealthProbeHandler(
      deps({ rdmaLinkShow: async () => JSON.stringify([{ netdev: 'a' }, 7, null]) }),
    );
    expect(
      ((await mixed({ level: 'standard' })) as HealthProbeResultV2).sections.rdma_links.value,
    ).toEqual([{ netdev: 'a' }]);
  });

  it('no desired profile → render section success with value null, helper not called', async () => {
    let called = false;
    const handler = makeHealthProbeHandler(
      deps({
        dryRenderNfsProfile: async () => {
          called = true;
          return {};
        },
      }),
    );
    const result = (await handler({ level: 'standard' })) as HealthProbeResultV2;
    expect(result.sections.nfs_profile_render).toEqual({
      status: 'success',
      observed_at: AT,
      value: null,
    });
    expect(called).toBe(false);
  });

  it('deep: the probes section is success when wired and error when the runner throws', async () => {
    const handler = makeHealthProbeHandler(
      deps({
        runDeepProbes: async (firstExport) => ({
          fs_io: [{ mountpoint: '/mnt/a', ok: true }],
          nfs_loopback: {
            attempted: true,
            ...(firstExport !== null ? { export: firstExport } : {}),
            ok: true,
          },
        }),
      }),
    );
    const result = (await handler({
      level: 'deep',
      first_export_path: '/mnt/a',
    })) as HealthProbeResultV2;
    expect(result.sections.probes).toMatchObject({
      status: 'success',
      value: {
        fs_io: [{ mountpoint: '/mnt/a', ok: true }],
        nfs_loopback: { attempted: true, export: '/mnt/a', ok: true },
      },
    });

    const failing = makeHealthProbeHandler(
      deps({
        runDeepProbes: async () => {
          throw new Error('probe blew up');
        },
      }),
    );
    const failed = (await failing({ level: 'deep' })) as HealthProbeResultV2;
    expect(failed.sections.probes).toEqual({
      status: 'error',
      observed_at: AT,
      error: { code: 'ERROR', message: 'probe blew up' },
    });
  });

  it('deep without a wired runner has no probes section', async () => {
    const result = (await makeHealthProbeHandler(deps())({ level: 'deep' })) as HealthProbeResultV2;
    expect(result.sections.probes).toBeUndefined();
  });
});

describe('F04: collection failures never become an empty success', () => {
  const base = {
    readLicenseText: async () => null,
    getCollectorHealth: () => ({}),
    dryRenderNfsProfile: async () => null,
  };

  it('F04: a non-array RDMA payload is a PARSE error, not an empty list', async () => {
    const run = makeHealthProbeHandler({
      ...base,
      rdmaLinkShow: async () => '{"unexpected":"shape"}',
    });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({ status: 'error', error: { code: 'PARSE' } });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('degraded');
  });

  it('F04b: a failed managed-filesystem inventory fails the probes section', async () => {
    const runner = makeDeepProbeRunner({
      probeHost: {} as never,
      listMountedManaged: async () => {
        throw new Error('inventory unavailable');
      },
    });
    await expect(runner(null)).rejects.toMatchObject({
      code: 'INVENTORY_UNAVAILABLE',
      status: 'error',
    });
    const run = makeHealthProbeHandler({
      ...base,
      rdmaLinkShow: async () => '[]',
      runDeepProbes: runner,
    });
    const result = await run({ level: 'deep' });
    expect(result.sections.probes).toMatchObject({
      status: 'error',
      error: { code: 'INVENTORY_UNAVAILABLE' },
    });
    expect(filesystemIoCheck(result.sections.probes!).status).toBe('degraded');
  });

  it('F04c: the production RDMA adapter surfaces a permission refusal', async () => {
    const net = createRealNetHost({
      runCommand: async () => ({ stdout: 'Operation not permitted', code: 1 }),
    });
    const run = makeHealthProbeHandler({ ...base, rdmaLinkShow: () => net.rdmaLinkShow() });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({
      status: 'permission_denied',
      error: { code: 'EPERM' },
    });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('degraded');
  });

  it('F04c: exit 127 (tool absent) is still not_supported and skipped', async () => {
    const net = createRealNetHost({ runCommand: async () => ({ stdout: '', code: 127 }) });
    const run = makeHealthProbeHandler({ ...base, rdmaLinkShow: () => net.rdmaLinkShow() });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({ status: 'not_supported' });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('skipped');
  });
});
