/**
 * GET /health?profile=quick|standard|deep (S7 T6, ADR-0009; S19a T1,
 * spec §7.3).
 *
 * quick: the pure KV catalog (lib/health/checks + the two KV drift
 * checks) — instant, no agent round-trip. standard/deep add the
 * `health.probe` RPC (5 s / 20 s timeout): parsed license, fresh rdma,
 * collector health, the helper dry-render checksums (drift.nfs-conf's
 * oracle), and — deep — the active fs/loopback probes. The agent being
 * unreachable degrades ONLY the probe-backed checks
 * (EXECUTOR_UNAVAILABLE evidence); KV checks still answer.
 *
 * S19a: the probe answers schema 2 — one typed Section per source — and
 * the report says how each source was collected: `collection.sources`
 * lists every section's status, `collection.agent` says whether the
 * agent answered at all, and `coverage_status` is `partial` whenever a
 * section failed to collect (error / timeout / permission_denied) or the
 * agent was unavailable. `overall` keeps its S7 meaning (REPORT-01): a
 * collection failure now reaches it as a `degraded` check instead of
 * vanishing as `skipped`. A schema-1 answer (an agent that was not
 * rebuilt with the api) is mapped to `error/LEGACY_AGENT` on every
 * section so the mismatch is visible, not silent.
 *
 * The S6 network checks (duplicate-netplan, rdma-readiness) moved into
 * the lib/health quick catalog — same ids, same logic, now fed by the
 * shared facts gatherer.
 */

import { Router } from 'express';
import { QUICK_CHECKS } from '../../lib/health/checks.js';
import {
  type CollectionStatus,
  type Section,
  isCollectionFailure,
} from '../../lib/health/collection.js';
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

/** The agent's schema-2 `health.probe` result (structural copy — api/ never imports agent/). */
interface ProbeV2 {
  schema: 2;
  sections: {
    license: Section<ProbeLicense | null>;
    rdma_links: Section<ProbeRdmaLink[]>;
    collectors: Section<Record<string, string>>;
    nfs_profile_render: Section<Record<string, string> | null>;
    probes?: Section<ProbeDeepResults>;
  };
}
const SECTION_NAMES = [
  'license',
  'rdma_links',
  'collectors',
  'nfs_profile_render',
  'probes',
] as const;

type AgentCollection = 'answered' | 'unavailable' | 'not_needed';
interface ReportCollection {
  agent: AgentCollection;
  sources: Partial<Record<(typeof SECTION_NAMES)[number], CollectionStatus>>;
}

/**
 * Accept a schema-2 result as-is; map anything else (a schema-1 agent) to
 * `error/LEGACY_AGENT` on every section the level expects.
 */
function normalizeProbe(raw: unknown, level: 'standard' | 'deep'): ProbeV2 {
  const r = raw as Partial<ProbeV2> | null;
  if (
    r !== null &&
    typeof r === 'object' &&
    r.schema === 2 &&
    r.sections !== null &&
    typeof r.sections === 'object'
  ) {
    return r as ProbeV2;
  }
  const legacy = (): Section<never> => ({
    status: 'error',
    observed_at: new Date().toISOString(),
    error: {
      code: 'LEGACY_AGENT',
      message: 'the agent answered health.probe with the schema 1 shape; rebuild and restart it',
    },
  });
  return {
    schema: 2,
    sections: {
      license: legacy(),
      rdma_links: legacy(),
      collectors: legacy(),
      nfs_profile_render: legacy(),
      ...(level === 'deep' ? { probes: legacy() } : {}),
    },
  };
}

/** A deep answer that carries no probes section (the agent did not wire them). */
const probesMissing = (): Section<ProbeDeepResults> => ({
  status: 'error',
  observed_at: new Date().toISOString(),
  error: {
    code: 'PROBES_MISSING',
    message: 'the agent returned no probes section for level=deep',
  },
});

/** KV-derived checks: collected from the state store, no per-fact time in S19a (spec §7.2 note). */
const withKv = (c: HealthCheckResult): HealthCheckResult =>
  c.evidence.collection === undefined
    ? {
        ...c,
        evidence: {
          ...c.evidence,
          collection: { status: 'success', source: 'kv', observed_at: null },
        },
      }
    : c;

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

      const checks: HealthCheckResult[] = QUICK_CHECKS.map((check) =>
        withKv(check(gathered.facts)),
      );
      checks.push(withKv(driftNfsExportsCheck(gathered.desiredEntries, gathered.observedRules)));
      checks.push(withKv(driftNetplanCheck(gathered.desiredNetRows, gathered.xinasFileHash)));

      let collection: ReportCollection = { agent: 'not_needed', sources: {} };
      let coverage: 'complete' | 'partial' = 'complete';

      if (profile === 'quick') {
        // drift.nfs-conf needs the probe's dry render — explicitly skipped.
        checks.push(withKv(driftNfsConfCheck(gathered.desiredProfileSpec, undefined, {})));
      } else {
        const level = profile as 'standard' | 'deep';
        let raw: unknown = null;
        let answered = false;
        let reason = 'no agent RPC client configured';
        if (ctx.tasks?.agentClient !== undefined) {
          try {
            raw = await ctx.tasks.agentClient.call(
              'health.probe',
              {
                level,
                desired_nfs_profile: gathered.desiredProfileSpec,
                first_export_path: gathered.firstExportPath,
              },
              PROBE_TIMEOUT_MS[level],
            );
            answered = true;
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err);
          }
        }

        if (!answered) {
          checks.push(...probeUnavailable(level, reason));
          collection = { agent: 'unavailable', sources: {} };
          coverage = 'partial';
        } else {
          const probe = normalizeProbe(raw, level);
          const sections = probe.sections;
          checks.push(xiraidLicenseCheck(sections.license));
          checks.push(xiraidServiceCheck(sections.collectors));
          checks.push(rdmaLiveCheck(sections.rdma_links));
          checks.push(agentCollectorsCheck(sections.collectors));
          checks.push(
            driftNfsConfCheck(
              gathered.desiredProfileSpec,
              sections.nfs_profile_render,
              gathered.facts.effectiveFiles,
            ),
          );
          if (level === 'deep') {
            const probes = sections.probes ?? probesMissing();
            sections.probes = probes;
            checks.push(filesystemIoCheck(probes));
            checks.push(nfsLoopbackCheck(probes));
          }
          const sources: ReportCollection['sources'] = {};
          for (const name of SECTION_NAMES) {
            const section = sections[name];
            if (section !== undefined) sources[name] = section.status;
          }
          collection = { agent: 'answered', sources };
          coverage = Object.values(sources).some((s) => s !== undefined && isCollectionFailure(s))
            ? 'partial'
            : 'complete';
        }
      }

      sendOk(req, res, {
        profile,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        overall: overallOf(checks),
        coverage_status: coverage,
        collection,
        checks,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
