/**
 * health.probe RPC (S7 T4/T5, ADR-0009) — the enumerated read-style
 * diagnostic behind the standard/deep health profiles.
 *
 * Sections are INDEPENDENTLY try/caught: a failing fact source nulls its
 * own section (the consuming api-side check degrades with evidence);
 * the RPC itself only rejects on invalid params. The license section
 * returns the PARSED struct only — the raw `xicli license show` output
 * is recoverable license material and never leaves this process.
 *
 * Deep adds the active probes (T5): fs touch tests over the mounted
 * managed filesystems and the PID1-delegated NFS loopback mount.
 */

import { type ParsedLicense, parseXicliLicense } from '../../../lib/parse/xicli-license.js';

export interface DeepProbeResults {
  fs_io: Array<{ mountpoint: string; ok: boolean; error?: string }>;
  nfs_loopback: { attempted: boolean; export?: string; ok: boolean; error?: string } | null;
}

export interface HealthProbeResult {
  license: ParsedLicense | null;
  rdma_links: Array<{ netdev?: string; ifname?: string; state?: string; physical_state?: string }>;
  collectors: Record<string, string>;
  nfs_profile_render: Record<string, string> | null;
  probes?: DeepProbeResults;
}

export interface HealthProbeDeps {
  /** Raw `xicli license show` text; null = xicli unavailable. PARSED before return. */
  readLicenseText(): Promise<string | null>;
  /** `rdma link show -j` JSON text ('' = tool absent). */
  rdmaLinkShow(): Promise<string>;
  getCollectorHealth(): Record<string, string>;
  /** Helper dry render (T1c); null = helper unreachable/failed. */
  dryRenderNfsProfile(spec: Record<string, unknown>): Promise<Record<string, string> | null>;
  /** Deep probes (T5); absent until wired. */
  runDeepProbes?(firstExportPath: string | null): Promise<DeepProbeResults>;
  now?(): number;
}

interface ProbeParams {
  level?: unknown;
  desired_nfs_profile?: unknown;
  first_export_path?: unknown;
}

export function makeHealthProbeHandler(deps: HealthProbeDeps) {
  return async (params: unknown): Promise<HealthProbeResult> => {
    const p = (params ?? {}) as ProbeParams;
    const level = p.level;
    if (level !== 'standard' && level !== 'deep') {
      throw new Error("health.probe: params.level must be 'standard' or 'deep'");
    }

    let license: ParsedLicense | null = null;
    try {
      const text = await deps.readLicenseText();
      license = text === null ? null : parseXicliLicense(text, deps.now ?? Date.now);
    } catch {
      license = null;
    }

    let rdmaLinks: HealthProbeResult['rdma_links'] = [];
    try {
      const raw = await deps.rdmaLinkShow();
      const parsed = raw.trim().length > 0 ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(parsed)) {
        rdmaLinks = parsed.filter(
          (e): e is HealthProbeResult['rdma_links'][number] => typeof e === 'object' && e !== null,
        );
      }
    } catch {
      rdmaLinks = [];
    }

    let collectors: Record<string, string> = {};
    try {
      collectors = deps.getCollectorHealth();
    } catch {
      collectors = {};
    }

    let nfsProfileRender: Record<string, string> | null = null;
    if (typeof p.desired_nfs_profile === 'object' && p.desired_nfs_profile !== null) {
      try {
        nfsProfileRender = await deps.dryRenderNfsProfile(
          p.desired_nfs_profile as Record<string, unknown>,
        );
      } catch {
        nfsProfileRender = null;
      }
    }

    const result: HealthProbeResult = {
      license,
      rdma_links: rdmaLinks,
      collectors,
      nfs_profile_render: nfsProfileRender,
    };

    if (level === 'deep' && deps.runDeepProbes !== undefined) {
      try {
        result.probes = await deps.runDeepProbes(
          typeof p.first_export_path === 'string' ? p.first_export_path : null,
        );
      } catch (err) {
        result.probes = {
          fs_io: [],
          nfs_loopback: {
            attempted: true,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    return result;
  };
}

// ---- Production / fixture deps wiring (consumed by agent-server) ----

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeNetHost } from '../../net/fake-host.js';
import { createRealNetHost } from '../../net/host.js';
import { fixtureDir } from '../../probe/fixture.js';
import { createNfsHelperClientFromProbe } from '../../task/nfs-helper-client.js';

function execText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => {
      resolve(err !== null ? null : stdout);
    });
  });
}

export interface HealthProbeWiring {
  /** Defaults to the XINAS_AGENT_PROBE_MODE fixture directory. */
  fixtureDir?: string | null;
  getCollectorHealth(): Record<string, string>;
  helperSocket?: string;
}

/**
 * Build the probe deps: real subprocess/helper-backed in production;
 * file-backed in fixture mode (xicli-license.txt, net-host-state.json's
 * rdma_links via the fake NetHost, nfs-profile-render.json).
 */
export function makeHealthProbeDeps(wiring: HealthProbeWiring): HealthProbeDeps {
  const fdir = wiring.fixtureDir !== undefined ? wiring.fixtureDir : fixtureDir();
  if (fdir !== null) {
    return {
      readLicenseText: () => {
        try {
          return Promise.resolve(readFileSync(join(fdir, 'xicli-license.txt'), 'utf8'));
        } catch {
          return Promise.resolve(null);
        }
      },
      rdmaLinkShow: () => createFakeNetHost(fdir).rdmaLinkShow(),
      getCollectorHealth: wiring.getCollectorHealth,
      dryRenderNfsProfile: () => {
        try {
          return Promise.resolve(
            JSON.parse(readFileSync(join(fdir, 'nfs-profile-render.json'), 'utf8')) as Record<
              string,
              string
            >,
          );
        } catch {
          return Promise.resolve(null);
        }
      },
      runDeepProbes: makeDeepProbeRunner({
        probeHost: createFakeProbeHost(fdir),
        listMountedManaged: makeListMountedManaged(fdir),
      }),
    };
  }

  const netHost = createRealNetHost();
  const helper = createNfsHelperClientFromProbe(
    wiring.helperSocket !== undefined ? { helperSocket: wiring.helperSocket } : {},
  );
  return {
    readLicenseText: () => execText('xicli', ['license', 'show']),
    rdmaLinkShow: () => netHost.rdmaLinkShow(),
    getCollectorHealth: wiring.getCollectorHealth,
    dryRenderNfsProfile: async (spec) => {
      try {
        return await helper.renderNfsProfileDry(spec);
      } catch {
        return null;
      }
    },
    runDeepProbes: makeDeepProbeRunner({
      probeHost: createRealProbeHost(),
      listMountedManaged: makeListMountedManaged(null),
    }),
  };
}

// ---- Deep probe runner (T5) ----

import { createFakeProbeHost } from '../../health/fake-probe-host.js';
import { type ProbeHost, createRealProbeHost } from '../../health/probe-host.js';
import { createFilesystemProbe } from '../../probe/filesystem.js';

/**
 * Run the deep probes: a touch test per mounted managed filesystem and
 * one loopback mount of the first export (skipped when none exists).
 */
export function makeDeepProbeRunner(opts: {
  probeHost: ProbeHost;
  listMountedManaged(): Promise<string[]>;
}): (firstExportPath: string | null) => Promise<DeepProbeResults> {
  return async (firstExportPath) => {
    let mountpoints: string[] = [];
    try {
      mountpoints = await opts.listMountedManaged();
    } catch {
      mountpoints = [];
    }

    const fsIo: DeepProbeResults['fs_io'] = [];
    for (const mountpoint of mountpoints) {
      const r = await opts.probeHost.touchProbe(mountpoint);
      fsIo.push({ mountpoint, ok: r.ok, ...(r.error !== undefined ? { error: r.error } : {}) });
    }

    let loopback: DeepProbeResults['nfs_loopback'] = null;
    if (firstExportPath !== null) {
      const r = await opts.probeHost.loopbackMount(firstExportPath);
      loopback = {
        attempted: true,
        export: firstExportPath,
        ok: r.ok,
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
    }

    return { fs_io: fsIo, nfs_loopback: loopback };
  };
}

interface FixtureFsRow {
  status?: { mounted?: boolean; mountpoint?: string };
}

/** Mounted managed mountpoints — fixture: filesystems.json; prod: the fs probe. */
function makeListMountedManaged(fdir: string | null): () => Promise<string[]> {
  if (fdir !== null) {
    return () => {
      try {
        const rows = JSON.parse(
          readFileSync(join(fdir, 'filesystems.json'), 'utf8'),
        ) as FixtureFsRow[];
        return Promise.resolve(
          rows
            .filter((r) => r.status?.mounted === true && typeof r.status?.mountpoint === 'string')
            .map((r) => r.status?.mountpoint as string),
        );
      } catch {
        return Promise.resolve([]);
      }
    };
  }
  const probe = createFilesystemProbe();
  return async () => {
    const rows = await probe.snapshot();
    return rows
      .filter((r) => r.status.mounted === true && typeof r.status.mountpoint === 'string')
      .map((r) => r.status.mountpoint as string);
  };
}
