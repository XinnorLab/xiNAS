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
 *
 * The ProbeHost itself is the admission point (validation F08): a probe
 * the legacy deep path (`health.check profile=deep`) is running refuses
 * this one too, so the handler asks `busy()` before the verb — and turns
 * the host's own refusal into the same RPC error — while keeping its own
 * in-flight flag as a second, fast guard.
 */

import { RUN_ID_RE, type ProbeKind, type ProbeOutcome } from '../../../lib/health/probe-types.js';
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

/** `-32000` `data.code: PROBE_IN_PROGRESS` over the dispatcher; `409` at the api. */
const inProgress = (details: Record<string, unknown>): Error =>
  Object.assign(new Error('a health probe is already in flight on this node'), {
    code: 'PROBE_IN_PROGRESS',
    details,
  });

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
    if (runId !== null && !RUN_ID_RE.test(runId)) {
      throw invalid('params.run_id must be the UUID health.context minted');
    }
    const timeoutMs = p.timeout_ms === undefined ? defaultTimeout : p.timeout_ms;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > maxTimeout
    ) {
      throw invalid(`params.timeout_ms must be an integer between 1000 and ${maxTimeout}`);
    }
    if (inFlight !== null) throw inProgress({ ...inFlight });
    // The host is the real admission point (F08): a probe the deep path
    // started is invisible to this handler's own guard.
    const held = deps.probeHost.busy();
    if (held !== null) throw inProgress({ ...held });
    inFlight = { probe: p.probe, path: p.path };
    try {
      const outcome =
        p.probe === 'fs_io'
          ? await deps.probeHost.fsIo(p.path, { runId, timeoutMs })
          : await deps.probeHost.nfsLoopback(p.path, { runId, timeoutMs });
      // The host refused between busy() and the call: that is the RPC
      // error the api maps to 409, not a probe result.
      if (outcome.error?.code === 'PROBE_IN_PROGRESS') {
        const nowHeld = deps.probeHost.busy();
        throw inProgress(nowHeld !== null ? { ...nowHeld } : { message: outcome.error.message });
      }
      return { probe: p.probe, path: p.path, ...outcome };
    } finally {
      inFlight = null;
    }
  };
}
