/**
 * Active health probes — the shared shapes (S19 §9, D-08; ADR-0018 §4).
 *
 * Both sides read this: the agent's probe host produces a
 * {@link ProbeOutcome}, the api's `POST /health/probe` route and the deep
 * health profile consume it. lib/ imports from neither side.
 */

export type ProbeKind = 'fs_io' | 'nfs_loopback';

export type ProbeStage =
  | 'open'
  | 'dir'
  | 'create'
  | 'write'
  | 'fsync'
  | 'read'
  | 'unlink'
  | 'lock'
  | 'mount'
  | 'readdir'
  | 'umount';

export interface ProbeRunOptions {
  /** The S19 run id the artifact name carries; null → `none`. */
  runId: string | null;
  /** Bound for the whole probe; enforced on the agent, step by step. */
  timeoutMs: number;
}

export interface ProbeCleanup {
  /** `failed` is a finding, never swallowed (PROBE-03). */
  status: 'clean' | 'failed' | 'not_needed';
  detail?: string;
}

export interface ProbeOutcome {
  ok: boolean;
  started_at: string;
  completed_at: string;
  /** What the probe created — the exact file or mountpoint, per run. */
  artifact: { kind: 'file' | 'mountpoint'; path: string } | null;
  error?: { code: string; message: string; stage: ProbeStage };
  cleanup: ProbeCleanup;
}

/** PROBE-04: what a passing probe proves — and what it does not. Fixed text per kind. */
export const PROVES: Record<ProbeKind, string> = {
  fs_io:
    'a 4 KiB write, fsync, read-back and unlink succeeded on this mountpoint from the node itself; ' +
    'not client connectivity, not RDMA, not durability beyond fsync',
  nfs_loopback:
    'the export was NFS-mounted from the node itself, listed and unmounted; ' +
    'not real-client connectivity, not RDMA transport',
};

export const PROBE_PAYLOAD_BYTES = 4096;
/** The root-owned directory under a mountpoint that holds fs_io probe files. */
export const PROBE_DIR_NAME = '.xinas-health';
