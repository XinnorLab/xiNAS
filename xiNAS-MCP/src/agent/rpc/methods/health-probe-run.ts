/**
 * health.probe.run RPC (S19a T2, spec §9.2/§9.5, ADR-0018 §4) — ONE
 * active health probe on request: `fs_io` on a mountpoint or
 * `nfs_loopback` on an export path, through the hardened ProbeHost.
 *
 * The api resolves ids to paths and enforces rank, `mcp.allow_apply` and
 * the S15 confirmation; this handler validates the shape, enforces
 * `active_probes_per_node = 1` (a second call while one is in flight is
 * `PROBE_IN_PROGRESS`, carried as `-32000` `data.code` by the
 * dispatcher) and returns the probe's outcome. A failed probe is a
 * result, not an RPC error.
 */

import type { ProbeKind, ProbeOutcome } from '../../../lib/health/probe-types.js';
import type { ProbeHost } from '../../health/probe-host.js';

export interface HealthProbeRunDeps {
  probeHost: ProbeHost;
  /** Default 20 s. */
  defaultTimeoutMs?: number;
  /** Default 60 s (spec §9.2 `timeout_s` ≤ 60). */
  maxTimeoutMs?: number;
}

export type HealthProbeRunResult = ProbeOutcome & { probe: ProbeKind; path: string };

const invalid = (msg: string): Error =>
  Object.assign(new Error(`health.probe.run: ${msg}`), { code: 'INVALID_PARAMS' });

export function makeHealthProbeRunHandler(deps: HealthProbeRunDeps) {
  const defaultTimeout = deps.defaultTimeoutMs ?? 20_000;
  const maxTimeout = deps.maxTimeoutMs ?? 60_000;
  let inFlight: { probe: ProbeKind; path: string } | null = null;

  return async (params: unknown): Promise<HealthProbeRunResult> => {
    const p = (params ?? {}) as {
      probe?: unknown;
      path?: unknown;
      run_id?: unknown;
      timeout_ms?: unknown;
    };
    if (p.probe !== 'fs_io' && p.probe !== 'nfs_loopback') {
      throw invalid("params.probe must be 'fs_io' or 'nfs_loopback'");
    }
    if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.includes('\0')) {
      throw invalid('params.path must be an absolute path');
    }
    const runId = typeof p.run_id === 'string' && p.run_id.length > 0 ? p.run_id : null;
    const timeoutMs = p.timeout_ms === undefined ? defaultTimeout : p.timeout_ms;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > maxTimeout
    ) {
      throw invalid(`params.timeout_ms must be an integer between 1000 and ${maxTimeout}`);
    }
    if (inFlight !== null) {
      throw Object.assign(new Error('a health probe is already in flight on this node'), {
        code: 'PROBE_IN_PROGRESS',
        details: { ...inFlight },
      });
    }
    inFlight = { probe: p.probe, path: p.path };
    try {
      const outcome =
        p.probe === 'fs_io'
          ? await deps.probeHost.fsIo(p.path, { runId, timeoutMs })
          : await deps.probeHost.nfsLoopback(p.path, { runId, timeoutMs });
      return { probe: p.probe, path: p.path, ...outcome };
    } finally {
      inFlight = null;
    }
  };
}
