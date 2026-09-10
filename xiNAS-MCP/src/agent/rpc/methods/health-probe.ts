/**
 * health.probe RPC (S7 T4/T5, ADR-0009; S19a T1, spec §7.1) — the
 * enumerated read-style diagnostic behind the standard/deep health
 * profiles.
 *
 * Every section is collected INDEPENDENTLY through `collect()` and
 * carries its own typed status (`success | error | timeout |
 * permission_denied | not_supported`) and `observed_at`: a failing fact
 * source degrades only its own section, and the api can tell "asked and
 * found none" from "could not ask". The RPC itself only rejects on
 * invalid params. The license section returns the PARSED struct only —
 * the raw `xicli license show` output is recoverable license material
 * and never leaves this process.
 *
 * Deep adds the active probes (T5): fs touch tests over the mounted
 * managed filesystems and the PID1-delegated NFS loopback mount.
 */

import type { Section } from '../../../lib/health/collection.js';
import type { ProbeCleanup, ProbeOutcome } from '../../../lib/health/probe-types.js';
import { type ParsedLicense, parseXicliLicense } from '../../../lib/parse/xicli-license.js';
import { ProbeCollectionError, collect } from '../../health/collect.js';

/** S19a: each row also says what happened to its artifact (cleanup verdict). */
export interface DeepProbeResults {
  fs_io: Array<{ mountpoint: string; ok: boolean; error?: string; cleanup?: ProbeCleanup }>;
  nfs_loopback: {
    attempted: boolean;
    export?: string;
    ok: boolean;
    error?: string;
    cleanup?: ProbeCleanup;
  } | null;
}

export interface RdmaLink {
  netdev?: string;
  ifname?: string;
  state?: string;
  physical_state?: string;
}

/** Schema 2 (S19a): one typed Section per source. */
export interface HealthProbeResultV2 {
  schema: 2;
  sections: {
    /** value null + success = xiRAID ran `xicli` and printed no license record. */
    license: Section<ParsedLicense | null>;
    /** value [] + success = the tool ran and reported no links. */
    rdma_links: Section<RdmaLink[]>;
    collectors: Section<Record<string, string>>;
    /** value null + success = no desired profile to render. */
    nfs_profile_render: Section<Record<string, string> | null>;
    /** level=deep only. */
    probes?: Section<DeepProbeResults>;
  };
}

export interface HealthProbeDeps {
  /**
   * Raw `xicli license show` text; null = ran and printed nothing. A
   * missing binary or a failure REJECTS (classified by `collect()`).
   * PARSED before return.
   */
  readLicenseText(): Promise<string | null>;
  /** Rejects on failure; '' = no links. */
  rdmaLinkShow(): Promise<string>;
  getCollectorHealth(): Record<string, string>;
  /** Helper dry render (T1c). Rejects with HELPER_UNREACHABLE when the helper cannot answer. */
  dryRenderNfsProfile(spec: Record<string, unknown>): Promise<Record<string, string> | null>;
  /** Deep probes (T5); absent until wired. */
  runDeepProbes?(firstExportPath: string | null): Promise<DeepProbeResults>;
  /** License clock (days_left). */
  now?(): number;
  /** Section `observed_at` clock; defaults to Date.now. */
  clock?(): number;
}

interface ProbeParams {
  level?: unknown;
  desired_nfs_profile?: unknown;
  first_export_path?: unknown;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `rdma link show -j` text → rows; '' is an empty list; anything that is not a JSON array is PARSE. */
export function parseRdmaLinks(raw: string): RdmaLink[] {
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProbeCollectionError('error', 'PARSE', `rdma link show: ${errMessage(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ProbeCollectionError('error', 'PARSE', 'rdma link show: payload is not a JSON array');
  }
  return parsed.filter((e): e is RdmaLink => typeof e === 'object' && e !== null);
}

export function makeHealthProbeHandler(deps: HealthProbeDeps) {
  return async (params: unknown): Promise<HealthProbeResultV2> => {
    const p = (params ?? {}) as ProbeParams;
    const level = p.level;
    if (level !== 'standard' && level !== 'deep') {
      throw new Error("health.probe: params.level must be 'standard' or 'deep'");
    }
    const clock = deps.clock ?? Date.now;
    const desired =
      typeof p.desired_nfs_profile === 'object' && p.desired_nfs_profile !== null
        ? (p.desired_nfs_profile as Record<string, unknown>)
        : null;

    const sections: HealthProbeResultV2['sections'] = {
      license: await collect(async () => {
        const text = await deps.readLicenseText();
        return text === null ? null : parseXicliLicense(text, deps.now ?? Date.now);
      }, clock),
      rdma_links: await collect(async () => parseRdmaLinks(await deps.rdmaLinkShow()), clock),
      collectors: await collect(() => deps.getCollectorHealth(), clock),
      nfs_profile_render: await collect(
        async () => (desired === null ? null : deps.dryRenderNfsProfile(desired)),
        clock,
      ),
    };

    if (level === 'deep' && deps.runDeepProbes !== undefined) {
      const run = deps.runDeepProbes;
      sections.probes = await collect(
        () => run(typeof p.first_export_path === 'string' ? p.first_export_path : null),
        clock,
      );
    }

    return { schema: 2, sections };
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

/**
 * Run a tool and return its stdout. REJECTS with the execFile error so
 * `collect()` can classify it: `code: 'ENOENT'` (binary absent) becomes
 * `not_supported`, `killed: true` (the 10 s bound) becomes `timeout`.
 */
function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    });
  });
}

export interface HealthProbeWiring {
  /** Defaults to the XINAS_AGENT_PROBE_MODE fixture directory. */
  fixtureDir?: string | null;
  getCollectorHealth(): Record<string, string>;
  helperSocket?: string;
  /**
   * S19a: the ONE probe host per agent process, shared with
   * `health.probe.run` so deep and on-demand probes share the in-process
   * loopback guard. Defaults to {@link makeProbeHost}.
   */
  probeHost?: ProbeHost;
}

/**
 * The process-wide ProbeHost: file-backed in fixture mode, real
 * otherwise. Production runs `fs_io` in a PID1 transient unit
 * (`fsIoMode: 'pid1'`), because the agent's own `ProtectSystem=strict`
 * namespace has every pre-existing filesystem read-only (validation B01,
 * spec §9.3 "Execution boundary").
 */
export function makeProbeHost(fixture?: string | null): ProbeHost {
  const fdir = fixture !== undefined ? fixture : fixtureDir();
  return fdir !== null ? createFakeProbeHost(fdir) : createRealProbeHost({ fsIoMode: 'pid1' });
}

/**
 * Build the probe deps: real subprocess/helper-backed in production;
 * file-backed in fixture mode (xicli-license.txt, net-host-state.json's
 * rdma_links via the fake NetHost, nfs-profile-render.json).
 */
export function makeHealthProbeDeps(wiring: HealthProbeWiring): HealthProbeDeps {
  const fdir = wiring.fixtureDir !== undefined ? wiring.fixtureDir : fixtureDir();
  const probeHost = wiring.probeHost ?? makeProbeHost(fdir);
  if (fdir !== null) {
    return {
      // A missing fixture file models "xicli is not installed".
      readLicenseText: () => {
        try {
          return Promise.resolve(readFileSync(join(fdir, 'xicli-license.txt'), 'utf8'));
        } catch {
          return Promise.reject(
            new ProbeCollectionError(
              'not_supported',
              'TOOL_ABSENT',
              'fixture: xicli-license.txt absent',
            ),
          );
        }
      },
      rdmaLinkShow: () => createFakeNetHost(fdir).rdmaLinkShow(),
      getCollectorHealth: wiring.getCollectorHealth,
      // A missing fixture file models "the helper is unreachable".
      dryRenderNfsProfile: () => {
        try {
          return Promise.resolve(
            JSON.parse(readFileSync(join(fdir, 'nfs-profile-render.json'), 'utf8')) as Record<
              string,
              string
            >,
          );
        } catch {
          return Promise.reject(
            new ProbeCollectionError(
              'error',
              'HELPER_UNREACHABLE',
              'fixture: nfs-profile-render.json absent',
            ),
          );
        }
      },
      runDeepProbes: makeDeepProbeRunner({
        probeHost,
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
      } catch (err) {
        throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', errMessage(err));
      }
    },
    runDeepProbes: makeDeepProbeRunner({
      probeHost,
      listMountedManaged: makeListMountedManaged(null),
    }),
  };
}

// ---- Deep probe runner (T5; S19a on the hardened host) ----

import { createFakeProbeHost } from '../../health/fake-probe-host.js';
import { type ProbeHost, createRealProbeHost } from '../../health/probe-host.js';
import { createFilesystemProbe } from '../../probe/filesystem.js';

/** Deep probes run with no S19 run id and the S7 20 s bound per probe. */
const DEEP_PROBE_OPTS = { runId: null, timeoutMs: 20_000 } as const;

const errorText = (o: ProbeOutcome): string | undefined =>
  o.error !== undefined ? `${o.error.code}: ${o.error.message}` : undefined;

/**
 * Run the deep probes: an fs_io probe per mounted managed filesystem and
 * one loopback mount of the first export (skipped when none exists).
 * Every row carries the probe's cleanup verdict (spec §9.3).
 */
export function makeDeepProbeRunner(opts: {
  probeHost: ProbeHost;
  listMountedManaged(): Promise<string[]>;
}): (firstExportPath: string | null) => Promise<DeepProbeResults> {
  return async (firstExportPath) => {
    let mountpoints: string[];
    try {
      mountpoints = await opts.listMountedManaged();
    } catch (err) {
      throw new ProbeCollectionError(
        'error',
        'INVENTORY_UNAVAILABLE',
        `managed filesystem inventory failed: ${errMessage(err)}`,
      );
    }

    const fsIo: DeepProbeResults['fs_io'] = [];
    for (const mountpoint of mountpoints) {
      const r = await opts.probeHost.fsIo(mountpoint, DEEP_PROBE_OPTS);
      const error = errorText(r);
      fsIo.push({
        mountpoint,
        ok: r.ok,
        ...(error !== undefined ? { error } : {}),
        cleanup: r.cleanup,
      });
    }

    let loopback: DeepProbeResults['nfs_loopback'] = null;
    if (firstExportPath !== null) {
      const r = await opts.probeHost.nfsLoopback(firstExportPath, DEEP_PROBE_OPTS);
      const error = errorText(r);
      loopback = {
        attempted: true,
        export: firstExportPath,
        ok: r.ok,
        ...(error !== undefined ? { error } : {}),
        cleanup: r.cleanup,
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
