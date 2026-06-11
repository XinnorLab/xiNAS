/**
 * GET /health?profile=quick|standard|deep (S7 T6, ADR-0009).
 *
 * quick: the pure KV catalog (lib/health/checks + the two KV drift
 * checks) — instant, no agent round-trip. standard/deep add the
 * `health.probe` RPC (5 s / 20 s timeout): parsed license, fresh rdma,
 * collector health, the helper dry-render checksums (drift.nfs-conf's
 * oracle), and — deep — the active fs/loopback probes. The agent being
 * unreachable degrades ONLY the probe-backed checks
 * (EXECUTOR_UNAVAILABLE evidence); KV checks still answer.
 *
 * The S6 network checks (duplicate-netplan, rdma-readiness) moved into
 * the lib/health quick catalog — same ids, same logic, now fed by the
 * shared facts gatherer.
 */

import { Router } from 'express';
import { QUICK_CHECKS } from '../../lib/health/checks.js';
import {
  driftNetplanCheck,
  driftNfsConfCheck,
  driftNfsExportsCheck,
} from '../../lib/health/drift.js';
import { type HealthCheckResult, overallOf } from '../../lib/health/engine.js';
import {
  type ProbeDeepResults,
  type ProbeLicense,
  type ProbeRdmaLink,
  agentCollectorsCheck,
  filesystemIoCheck,
  nfsLoopbackCheck,
  probeUnavailable,
  rdmaLiveCheck,
  xiraidLicenseCheck,
  xiraidServiceCheck,
} from '../../lib/health/standard.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { gatherHealthFacts } from '../handlers/health-facts.js';
import { sendOk } from '../handlers/reads.js';

const ALLOWED_PROFILES = new Set(['quick', 'standard', 'deep']);
const PROBE_TIMEOUT_MS = { standard: 5_000, deep: 20_000 } as const;

interface ProbeResult {
  license: ProbeLicense | null;
  rdma_links: ProbeRdmaLink[];
  collectors: Record<string, string>;
  nfs_profile_render: Record<string, string> | null;
  probes?: ProbeDeepResults;
}

export function healthRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/health', async (req, res, next) => {
    try {
      const profile = (req.query.profile as string | undefined) ?? 'quick';
      if (!ALLOWED_PROFILES.has(profile)) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `unknown health profile '${profile}'; must be one of: quick, standard, deep`,
          { profile },
        );
      }
      const startedAt = new Date().toISOString();
      const gathered = gatherHealthFacts(ctx);

      const checks: HealthCheckResult[] = QUICK_CHECKS.map((check) => check(gathered.facts));
      checks.push(driftNfsExportsCheck(gathered.desiredEntries, gathered.observedRules));
      checks.push(driftNetplanCheck(gathered.desiredNetRows, gathered.xinasFileHash));

      if (profile === 'quick') {
        // drift.nfs-conf needs the probe's dry render — explicitly skipped.
        checks.push(driftNfsConfCheck(gathered.desiredProfileSpec, undefined, {}));
      } else {
        const level = profile as 'standard' | 'deep';
        let probe: ProbeResult | null = null;
        let reason = 'no agent RPC client configured';
        if (ctx.tasks?.agentClient !== undefined) {
          try {
            probe = (await ctx.tasks.agentClient.call(
              'health.probe',
              {
                level,
                desired_nfs_profile: gathered.desiredProfileSpec,
                first_export_path: gathered.firstExportPath,
              },
              PROBE_TIMEOUT_MS[level],
            )) as ProbeResult;
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err);
          }
        }

        if (probe === null) {
          checks.push(...probeUnavailable(level, reason));
        } else {
          checks.push(xiraidLicenseCheck(probe.license));
          checks.push(xiraidServiceCheck(probe.collectors));
          checks.push(rdmaLiveCheck(probe.rdma_links));
          checks.push(agentCollectorsCheck(probe.collectors));
          checks.push(
            driftNfsConfCheck(
              gathered.desiredProfileSpec,
              probe.nfs_profile_render,
              gathered.facts.effectiveFiles,
            ),
          );
          if (level === 'deep') {
            const probes = probe.probes ?? { fs_io: [], nfs_loopback: null };
            checks.push(filesystemIoCheck(probes.fs_io));
            checks.push(nfsLoopbackCheck(probes.nfs_loopback));
          }
        }
      }

      sendOk(req, res, {
        profile,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        overall: overallOf(checks),
        checks,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
