import { describe, expect, it } from 'vitest';
import {
  type HealthProbeDeps,
  type HealthProbeResult,
  makeHealthProbeHandler,
} from '../../../agent/rpc/methods/health-probe.js';
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
    expect(
      parseXicliLicense('status: valid\nexpiration date: 2026-06-01\n', NOW).status,
    ).toBe('expired');
    expect(parseXicliLicense('', NOW).status).toBe('absent');
    expect(parseXicliLicense('garbage text\n', NOW).status).toBe('absent');
  });
});

function deps(over: Partial<HealthProbeDeps> = {}): HealthProbeDeps {
  return {
    readLicenseText: async () => GOLDEN_VALID,
    rdmaLinkShow: async () =>
      JSON.stringify([{ ifname: 'ibp65s0/1', state: 'ACTIVE', physical_state: 'LINK_UP' }]),
    getCollectorHealth: () => ({ disk: 'running', xiraid: 'running' }),
    dryRenderNfsProfile: async () => ({ '/etc/nfs/nfsd.conf': 'sha256:abc' }),
    now: NOW,
    ...over,
  };
}

describe('health.probe handler', () => {
  it('rejects bad levels; assembles all standard sections', async () => {
    const handler = makeHealthProbeHandler(deps());
    await expect(handler({ level: 'quick' })).rejects.toThrow(/level/);

    const result = (await handler({
      level: 'standard',
      desired_nfs_profile: { versions: {} },
    })) as HealthProbeResult;
    expect(result.license?.status).toBe('active');
    expect(result.rdma_links).toHaveLength(1);
    expect(result.collectors.xiraid).toBe('running');
    expect(result.nfs_profile_render).toEqual({ '/etc/nfs/nfsd.conf': 'sha256:abc' });
    expect(result.probes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('per-section degradation: each failing source nulls only itself', async () => {
    const handler = makeHealthProbeHandler(
      deps({
        readLicenseText: async () => null,
        rdmaLinkShow: async () => {
          throw new Error('rdma tool missing');
        },
        dryRenderNfsProfile: async () => {
          throw new Error('helper down');
        },
      }),
    );
    const result = (await handler({
      level: 'standard',
      desired_nfs_profile: { versions: {} },
    })) as HealthProbeResult;
    expect(result.license).toBeNull();
    expect(result.rdma_links).toEqual([]);
    expect(result.nfs_profile_render).toBeNull();
    expect(result.collectors.disk).toBe('running'); // unaffected section
  });

  it('no desired profile → render section null without calling the helper', async () => {
    let called = false;
    const handler = makeHealthProbeHandler(
      deps({
        dryRenderNfsProfile: async () => {
          called = true;
          return {};
        },
      }),
    );
    const result = (await handler({ level: 'standard' })) as HealthProbeResult;
    expect(result.nfs_profile_render).toBeNull();
    expect(called).toBe(false);
  });

  it('deep runs the probes when wired; a throwing prober degrades into the result', async () => {
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
    })) as HealthProbeResult;
    expect(result.probes?.fs_io[0]?.ok).toBe(true);
    expect(result.probes?.nfs_loopback?.export).toBe('/mnt/a');

    const failing = makeHealthProbeHandler(
      deps({
        runDeepProbes: async () => {
          throw new Error('probe blew up');
        },
      }),
    );
    const failed = (await failing({ level: 'deep' })) as HealthProbeResult;
    expect(failed.probes?.nfs_loopback?.ok).toBe(false);
    expect(failed.probes?.nfs_loopback?.error).toContain('probe blew up');
  });
});
