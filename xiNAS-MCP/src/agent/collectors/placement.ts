/**
 * S20 PlacementObservations collector — the 5 s placement cycle
 * (docs/control-path/s20-placement-observations-spec.md §4).
 *
 * Poll-only: the PollDriver runs initialSweep() every `pollIntervalMs`
 * (5 s) and flushes the single row
 * `/xinas/v1/observed/PlacementObservations/default` with complete-snapshot
 * semantics. One cycle makes exactly one call per source — raidShow, the
 * lean filesystem sweep (unit files + the mount table), the kernel-effective
 * export table, the nfs-server unit state, the nfsd versions and threads
 * files — bounded by one deadline (2 s); a late source is published as
 * ERROR/COLLECTION_TIMEOUT and the snapshot as PARTIAL. The graph itself is
 * computed by the pure lib/placement-graph.
 *
 * What the row carries that the route does not expose verbatim: per-record
 * monotonic stamps and the cycle's `published_mono_ms`, from which the api
 * derives `evidence_age_ms` against its own receipt clock (spec §5.2), and
 * `generated_at`, from which the api measures the transfer delay.
 */

import { encExportId } from '../../lib/nfs-export-id.js';
import { parseNfsdThreads, parseNfsdVersions } from '../../lib/parse/nfsd.js';
import { normalizeLevel, parseRaidShowEntries, progressPct } from '../../lib/parse/raid.js';
import {
  type ArrayInput,
  type ExportInput,
  type FilesystemSweep,
  type GraphInputs,
  type NfsServiceInput,
  type PlacementGraph,
  type Source,
  buildPlacementGraph,
} from '../../lib/placement-graph.js';
import { log } from '../log.js';
import type { PlacementFilesystemSweep } from '../probe/filesystem.js';
import type { XiraidVersion } from '../probe/xiraid-version.js';
import type { Collector, ObservationDelta } from './base.js';

/** Spec §6 — what the prototype evaluates (DEC-08, API-21). */
export const PLACEMENT_CAPABILITIES = [
  'raid.array_states',
  'raid.member_states',
  'topology.data_log_realtime',
  'identity',
  'filesystem.mounted_rw',
  'export.effective_access',
  'nfs.service',
  'source.freshness',
] as const;

export interface CoverageRow {
  check: string;
  required: boolean;
  status: 'EVALUATED' | 'NOT_IMPLEMENTED';
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * The coverage rows for one cycle. `export.effective_access` names where
 * the rules came from: `etab` is the kernel-effective table (exportfs(8));
 * anything else is a labelled weaker source the connector may refuse.
 */
export function placementCoverage(exportSource: string): CoverageRow[] {
  return [
    ...PLACEMENT_CAPABILITIES.map(
      (check): CoverageRow =>
        check === 'export.effective_access'
          ? { check, required: true, status: 'EVALUATED', details: { source: exportSource } }
          : { check, required: true, status: 'EVALUATED' },
    ),
    {
      check: 'filesystem.integrity',
      required: false,
      status: 'NOT_IMPLEMENTED',
      reason: 'OUT_OF_MVP',
    },
    { check: 'network.path', required: false, status: 'NOT_IMPLEMENTED', reason: 'OUT_OF_MVP' },
    {
      check: 'network.performance',
      required: false,
      status: 'NOT_IMPLEMENTED',
      reason: 'OUT_OF_MVP',
    },
  ];
}

export const PLACEMENT_SCHEMA_VERSION = '1.0';
export const PLACEMENT_DEFAULT_PERIOD_MS = 5_000;
export const PLACEMENT_DEFAULT_DEADLINE_MS = 2_000;
/** The kernel-effective export table exportfs(8) maintains. */
export const ETAB_PATH = '/var/lib/nfs/etab';

export interface PlacementExportRule {
  export_path: string;
  host_pattern: string;
  options: string[];
  /** `etab` for the kernel-effective table; other values are labelled sources. */
  source: string;
}

/** Everything the cycle reads, injected so tests drive it with fixtures. */
export interface PlacementSources {
  raidShow(): Promise<unknown>;
  filesystems(): Promise<PlacementFilesystemSweep>;
  /** The effective export table (etab), one entry per (path, client). */
  listExports(): Promise<PlacementExportRule[]>;
  /** `systemctl show nfs-server.service` (ActiveState/SubState). */
  nfsServiceState(): Promise<{ active_state: string; sub_state: string }>;
  /** Raw text of /proc/fs/nfsd/versions. */
  nfsdVersions(): Promise<string>;
  /** Raw text of /proc/fs/nfsd/threads. */
  nfsdThreads(): Promise<string>;
  /** `fs.realpath` of an export path (one lstat chain, no subprocess). */
  realpath(path: string): Promise<string>;
  /** Cached package version (probe/xiraid-version). */
  xiraidVersion(): Promise<XiraidVersion | null>;
  /** Device path → control-path Disk id, from the slow disk sweep's cache. */
  diskIdByPath(): ReadonlyMap<string, string>;
  /** Filesystem row id → XFS UUID, from the slow filesystem sweep's cache. */
  filesystemUuid(id: string): string | undefined;
}

export interface PlacementCollectorOptions {
  controllerId: string;
  sources: PlacementSources;
  /** Default 5 s; `XINAS_AGENT_PLACEMENT_POLL_MS` (tests only). */
  pollIntervalMs?: number;
  /** Default 2 s. */
  deadlineMs?: number;
  now?: () => string;
  /** Monotonic clock (ms). */
  mono?: () => number;
  /** Process identity for server_epoch; defaults to the real process. */
  pid?: number;
  bootAt?: string;
}

type SourceStatus = 'ok' | 'failed' | 'timeout';

interface SourceSummary {
  status: SourceStatus;
  observed_at?: string;
  mono_ms?: number;
}

/** The KV row's `status` (spec §4.6). */
export interface PlacementRowStatus {
  schema_version: typeof PLACEMENT_SCHEMA_VERSION;
  controller_id: string;
  server_epoch: string;
  source_generation: number;
  generated_at: string;
  snapshot_status: PlacementGraph['snapshot_status'];
  collection_period_ms: number;
  capabilities: string[];
  coverage: CoverageRow[];
  shares: PlacementGraph['shares'];
  resources: PlacementGraph['resources'];
  sources: Record<
    'arrays' | 'filesystems' | 'exports' | 'nfs_service' | 'nfsd_versions' | 'nfsd_threads',
    SourceSummary
  >;
  /** Agent monotonic stamp when the row was built (ages are offsets from it). */
  published_mono_ms: number;
  collector: { cycle_ms: number; deadline_hit: boolean; skipped_ticks: number };
  observed_at: string;
}

export class PlacementObservationCollector implements Collector<'PlacementObservations'> {
  readonly kind = 'PlacementObservations' as const;
  readonly pollIntervalMs: number;

  readonly #controllerId: string;
  readonly #sources: PlacementSources;
  readonly #deadlineMs: number;
  readonly #now: () => string;
  readonly #mono: () => number;
  readonly #serverEpoch: string;
  #generation = 0;
  #inFlight = false;
  #skippedTicks = 0;
  #lastSkipLogMono = Number.NEGATIVE_INFINITY;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };

  constructor(opts: PlacementCollectorOptions) {
    this.#controllerId = opts.controllerId;
    this.#sources = opts.sources;
    this.pollIntervalMs = opts.pollIntervalMs ?? PLACEMENT_DEFAULT_PERIOD_MS;
    this.#deadlineMs = opts.deadlineMs ?? PLACEMENT_DEFAULT_DEADLINE_MS;
    this.#now = opts.now ?? ((): string => new Date().toISOString());
    this.#mono = opts.mono ?? ((): number => performance.now());
    // Spec §4.3: minted once per agent process; a restart changes it.
    this.#serverEpoch = `${opts.controllerId}:${opts.bootAt ?? this.#now()}:${opts.pid ?? process.pid}`;
  }

  get serverEpoch(): string {
    return this.#serverEpoch;
  }

  get skippedTicks(): number {
    return this.#skippedTicks;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    // Re-entrancy guard (spec §4.1): a tick that fires while the previous
    // cycle is still running is skipped — never stacked, never re-published
    // (a re-push would reset the api's receipt clock and make old evidence
    // read as fresh). Throwing keeps the PollDriver from flushing an empty
    // snapshot, which would delete the row.
    if (this.#inFlight) {
      this.#skippedTicks++;
      const m = this.#mono();
      if (m - this.#lastSkipLogMono >= 60_000) {
        this.#lastSkipLogMono = m;
        log('warn', 'placement', 'cycle_skipped_overlap', { skipped_ticks: this.#skippedTicks });
      }
      throw new Error('placement cycle still running; tick skipped');
    }
    this.#inFlight = true;
    try {
      const status = await this.#cycle();
      return [
        {
          kind: 'PlacementObservations',
          id: 'default',
          op: 'upsert',
          value: { kind: 'PlacementObservations', id: 'default', status },
        },
      ];
    } finally {
      this.#inFlight = false;
    }
  }

  /** One bounded cycle; never throws (every source failure is published). */
  async #cycle(): Promise<PlacementRowStatus> {
    const startMono = this.#mono();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#deadlineMs);
    timer.unref?.();
    let deadlineHit = false;

    const guard = <T>(name: string, run: () => Promise<T>): Promise<Source<T>> =>
      new Promise<Source<T>>((resolve) => {
        const onAbort = (): void => {
          deadlineHit = true;
          resolve({ ok: false, reason: 'COLLECTION_TIMEOUT' });
        };
        if (abort.signal.aborted) {
          onAbort();
          return;
        }
        abort.signal.addEventListener('abort', onAbort, { once: true });
        let p: Promise<T>;
        try {
          p = run();
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(
          (value) => {
            abort.signal.removeEventListener('abort', onAbort);
            if (!abort.signal.aborted)
              resolve({ ok: true, value, observed_at: this.#now(), mono_ms: this.#mono() });
          },
          (err: unknown) => {
            abort.signal.removeEventListener('abort', onAbort);
            log('warn', 'placement', 'source_failed', {
              source: name,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!abort.signal.aborted) resolve({ ok: false, reason: 'COLLECTION_FAILED' });
          },
        );
      });

    const diskIds = this.#sources.diskIdByPath();
    const [arrays, filesystems, exportsAndPaths, nfsService, nfsdVersions, nfsdThreads, version] =
      await Promise.all([
        guard('raid_show', async (): Promise<ArrayInput[]> => {
          const payload = await this.#sources.raidShow();
          return parseRaidShowEntries(payload).map((e) => ({
            name: e.name,
            raid_level: normalizeLevel(e.raw.level),
            // xiRAID Classic exposes every array as /dev/xi_<name> (parse/raid).
            volume_path: `/dev/xi_${e.name}`,
            raw_states: e.states,
            state_valid: e.state_valid,
            progress: {
              init_pct: progressPct(e.raw.init_progress),
              recon_pct: progressPct(e.raw.recon_progress),
              restripe_pct: progressPct(e.raw.restripe_progress),
              sdc_pct: progressPct(e.raw.sdc_progress),
            },
            members: e.members.map((m) => {
              const diskId = m.device === null ? undefined : diskIds.get(m.device);
              return {
                index: m.index,
                device_path: m.device,
                ...(diskId !== undefined ? { disk_id: diskId } : {}),
                raw_states: m.states,
                state_valid: m.state_valid,
              };
            }),
          }));
        }),
        guard('filesystems', async (): Promise<FilesystemSweep> => {
          const sweep = await this.#sources.filesystems();
          return {
            filesystems: sweep.filesystems.map((r) => {
              const uuid = this.#sources.filesystemUuid(r.id);
              return uuid !== undefined ? { ...r, uuid } : { ...r };
            }),
            mounts: sweep.mounts,
            mountinfo_readable: sweep.mountinfo_readable,
          };
        }),
        guard(
          'exports',
          async (): Promise<{
            exports: ExportInput[];
            canonical: Record<string, string | null>;
          }> => {
            const rules = await this.#sources.listExports();
            const byPath = new Map<string, ExportInput>();
            for (const r of rules) {
              const e = byPath.get(r.export_path) ?? {
                export_path: r.export_path,
                rules: [],
                source: r.source,
              };
              e.rules.push({ host_pattern: r.host_pattern, options: r.options });
              byPath.set(r.export_path, e);
            }
            const canonical: Record<string, string | null> = {};
            for (const path of byPath.keys()) {
              try {
                canonical[path] = await this.#sources.realpath(path);
              } catch {
                canonical[path] = null;
              }
            }
            return { exports: [...byPath.values()], canonical };
          },
        ),
        guard('nfs_service', async (): Promise<NfsServiceInput> => {
          const s = await this.#sources.nfsServiceState();
          return { active_state: s.active_state, sub_state: s.sub_state };
        }),
        guard(
          'nfsd_versions',
          async (): Promise<string[]> => parseNfsdVersions(await this.#sources.nfsdVersions()),
        ),
        guard(
          'nfsd_threads',
          async (): Promise<number | null> => parseNfsdThreads(await this.#sources.nfsdThreads()),
        ),
        // Cached after the first success; inside the deadline like everything
        // else (API-12). A null is published as XIRAID_VERSION_UNAVAILABLE.
        guard('xiraid_version', () => this.#sources.xiraidVersion()),
      ]);
    clearTimeout(timer);

    const exports: Source<ExportInput[]> = exportsAndPaths.ok
      ? { ...exportsAndPaths, value: exportsAndPaths.value.exports }
      : exportsAndPaths;
    const inputs: GraphInputs = {
      arrays,
      filesystems,
      exports,
      nfs_service: nfsService,
      nfsd_versions: nfsdVersions,
      nfsd_threads: nfsdThreads,
      xiraid_version: version.ok ? version.value : null,
      ...(exportsAndPaths.ok ? { canonical_paths: exportsAndPaths.value.canonical } : {}),
    };
    const graph = buildPlacementGraph(inputs, encExportId);
    const generatedAt = this.#now();
    const publishedMono = this.#mono();
    this.#generation++;

    this.#health =
      graph.snapshot_status === 'FAILED'
        ? { state: 'error', reason: 'PLACEMENT_SOURCES_UNAVAILABLE' }
        : { state: 'running' };

    const summary = <T>(s: Source<T>): SourceSummary =>
      s.ok
        ? { status: 'ok', observed_at: s.observed_at, mono_ms: s.mono_ms }
        : { status: s.reason === 'COLLECTION_TIMEOUT' ? 'timeout' : 'failed' };

    const exportSource = exports.ok ? (exports.value[0]?.source ?? 'etab') : 'etab';
    return {
      schema_version: PLACEMENT_SCHEMA_VERSION,
      controller_id: this.#controllerId,
      server_epoch: this.#serverEpoch,
      source_generation: this.#generation,
      generated_at: generatedAt,
      snapshot_status: graph.snapshot_status,
      collection_period_ms: this.pollIntervalMs,
      capabilities: [...PLACEMENT_CAPABILITIES],
      coverage: placementCoverage(exportSource),
      shares: graph.shares,
      resources: graph.resources,
      sources: {
        arrays: summary(arrays),
        filesystems: summary(filesystems),
        exports: summary(exports),
        nfs_service: summary(nfsService),
        nfsd_versions: summary(nfsdVersions),
        nfsd_threads: summary(nfsdThreads),
      },
      published_mono_ms: publishedMono,
      collector: {
        cycle_ms: Math.round(publishedMono - startMono),
        deadline_hit: deadlineHit,
        skipped_ticks: this.#skippedTicks,
      },
      observed_at: generatedAt,
    };
  }

  // Poll-only: nothing to subscribe or tear down.
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this.#health;
  }
}
