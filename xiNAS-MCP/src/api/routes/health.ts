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

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Router } from 'express';
import { AGENTIC_CATALOG } from '../../lib/health/agentic-catalog.js';
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
import { PROVES, type ProbeKind } from '../../lib/health/probe-types.js';
import { AgentRpcError } from '../agent-client.js';
import type { ApiContext, RequestContext } from '../context.js';
import type { Warning } from '../envelope.js';
import { ApiException } from '../errors.js';
import { gatherHealthFacts } from '../handlers/health-facts.js';
import { getOrNull, sendOk } from '../handlers/reads.js';
import { buildHealthContext, runUnknownWarning } from '../health/context.js';
import { SERVER_INFO } from '../mcp/discover.js';
import { queueConfirmationEvent } from '../mcp/confirmation/audit.js';
import { argumentsHash } from '../mcp/confirmation/policy.js';
import type { ConfirmationRecord } from '../mcp/confirmation/types.js';

const PROBE_TOOL = 'health.probe.run';
const PROBE_DEFAULT_TIMEOUT_S = 20;
const PROBE_MAX_TIMEOUT_S = 60;

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
      // S19b §6.3: an optional run to record this report's digest under.
      const runId =
        typeof req.query.run_id === 'string' && req.query.run_id.length > 0
          ? req.query.run_id
          : null;
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
          // S19b §6.2: health.context reports the api's last agent probe.
          if (ctx.healthPrompt !== undefined) {
            ctx.healthPrompt.lastProbe = {
              collected_at: new Date().toISOString(),
              level,
              collectors:
                sections.collectors.status === 'success' && sections.collectors.value !== undefined
                  ? sections.collectors.value
                  : {},
            };
          }
          coverage = Object.values(sources).some((s) => s !== undefined && isCollectionFailure(s))
            ? 'partial'
            : 'complete';
        }
      }

      const completedAt = new Date().toISOString();
      const result = {
        profile,
        started_at: startedAt,
        completed_at: completedAt,
        overall: overallOf(checks),
        coverage_status: coverage,
        collection,
        checks,
        ...(runId !== null ? { run_id: runId } : {}),
      };
      const warnings: Warning[] = [];
      if (
        runId !== null &&
        (ctx.healthPrompt === undefined ||
          !ctx.healthPrompt.ledger.record(runId, 'health.check', { profile }, result, completedAt))
      ) {
        warnings.push(runUnknownWarning(runId));
      }
      sendOk(req, res, result, [], warnings);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /health/context (S19b, spec §6) — the validated run context. KV,
   * tracker and catalog only; never the agent. Mints a run into the
   * in-memory ledger, or re-reads one this principal started; an unknown,
   * expired or foreign run_id yields a new run plus a RUN_UNKNOWN warning
   * (SAFE-04: a run must not fail because the api restarted).
   */
  r.get('/health/context', (req, res, next) => {
    try {
      const hp = ctx.healthPrompt;
      if (hp === undefined) {
        throw new ApiException(
          'UNSUPPORTED',
          'the agentic health prompt is disabled on this node (mcp.health_prompt.enabled: false)',
          { reason: 'health_prompt_disabled' },
        );
      }
      const rc = req.context as RequestContext;
      const requested =
        typeof req.query.run_id === 'string' && req.query.run_id.length > 0
          ? req.query.run_id
          : null;
      const targets = parseTargetsQuery(req.query.targets);
      const warnings: Warning[] = [];
      let run = requested === null ? null : hp.ledger.get(requested);
      if (run !== null && run.principal !== rc.principal) run = null;
      if (run === null) {
        if (requested !== null) warnings.push(runUnknownWarning(requested));
        run = hp.ledger.mint({
          principal: rc.principal,
          role: rc.role,
          versions: {
            prompt: hp.versions.prompt,
            template_sha256: hp.templateSha256,
            policy: hp.versions.policy,
            catalog: hp.versions.catalog,
            report_schema: hp.versions.report_schema,
            server: SERVER_INFO.version,
          },
          limits: hp.config.limits,
        });
      }
      const body = buildHealthContext({
        state: ctx.state,
        ...(ctx.tracker !== undefined ? { tracker: ctx.tracker } : {}),
        healthPrompt: hp,
        controllerId: ctx.config.controller_id,
        allowApply: ctx.config.mcp?.allow_apply === true,
        identity: { principal: rc.principal, role: rc.role, client_type: rc.client_type },
        run,
        targets,
        hostname: hostname(),
      });
      sendOk(req, res, body, [], warnings);
    } catch (err) {
      next(err);
    }
  });

  /** GET /health/catalog (S19b, spec §10) — the check catalog, verbatim. */
  r.get('/health/catalog', (req, res, next) => {
    try {
      sendOk(req, res, AGENTIC_CATALOG);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /health/probe (S19a T2, spec §9.2) — ONE confirmed active probe.
   *
   * Rank (operator) is the catalog's; `mcp.allow_apply` is the dispatch
   * gate's. What this route enforces itself is the S15 analogue of the
   * apply transaction's §8.3 step for a forwarded MCP call: a pending
   * form confirmation bound to this principal, this tool and these exact
   * arguments, verified and CONSUMED before the probe runs — so a second
   * use, a stolen id or a different argument set never reaches the agent.
   * REST callers carry no confirmation and need none.
   */
  r.post('/health/probe', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const probe = body.probe;
      const target = body.target;
      if (probe !== 'fs_io' && probe !== 'nfs_loopback') {
        throw new ApiException('INVALID_ARGUMENT', "probe must be 'fs_io' or 'nfs_loopback'", {
          probe,
        });
      }
      if (typeof target !== 'string' || target.length === 0) {
        throw new ApiException('INVALID_ARGUMENT', 'target (a Filesystem or Share id) is required');
      }
      const runId = typeof body.run_id === 'string' && body.run_id.length > 0 ? body.run_id : null;
      const timeoutS = body.timeout_s === undefined ? PROBE_DEFAULT_TIMEOUT_S : body.timeout_s;
      if (
        typeof timeoutS !== 'number' ||
        !Number.isInteger(timeoutS) ||
        timeoutS < 1 ||
        timeoutS > PROBE_MAX_TIMEOUT_S
      ) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `timeout_s must be an integer between 1 and ${PROBE_MAX_TIMEOUT_S}`,
          { timeout_s: timeoutS },
        );
      }
      const rc = req.context as RequestContext;
      const kind: ProbeKind = probe;

      // Resolve the target to the path the agent probes.
      let path: string;
      if (kind === 'fs_io') {
        const fs = getOrNull<{ status?: { mountpoint?: string; mounted?: boolean } }>(
          ctx.state,
          `/xinas/v1/observed/Filesystem/${target}`,
        );
        if (fs === null) throw new ApiException('NOT_FOUND', `no filesystem ${target}`, { target });
        const status = fs.value.status;
        if (status?.mounted !== true || typeof status.mountpoint !== 'string') {
          throw new ApiException('PRECONDITION_FAILED', `filesystem ${target} is not mounted`, {
            reason: 'not_mounted',
            target,
          });
        }
        path = status.mountpoint;
      } else {
        const share = getOrNull<{ spec?: { path?: string } }>(
          ctx.state,
          `/xinas/v1/desired/Share/${target}`,
        );
        if (share === null || typeof share.value.spec?.path !== 'string') {
          throw new ApiException('NOT_FOUND', `no share ${target}`, { target });
        }
        path = share.value.spec.path;
      }

      // S19b §9.5: the per-run probe budget, counted BEFORE the confirmation
      // is consumed and before the agent is asked — an exhausted run must not
      // burn a confirmation. An unknown run is accepted with a warning.
      const warnings: Warning[] = [];
      const hp = ctx.healthPrompt;
      if (runId !== null) {
        const max = hp?.config.limits.probes_per_run ?? 0;
        const verdict = hp === undefined ? 'unknown' : hp.ledger.startProbe(runId, max);
        if (verdict === 'exhausted') {
          throw new ApiException(
            'PRECONDITION_FAILED',
            `this run has used its probe budget (probes_per_run: ${max})`,
            { reason: 'probe_budget_exhausted', run_id: runId, probes_per_run: max },
            'Finish the diagnosis with the probes already taken, or start a new run with health.context.',
          );
        }
        if (verdict === 'unknown') warnings.push(runUnknownWarning(runId));
      }

      // S15 §8.3 analogue for a direct entry: verify, then consume BEFORE running.
      let confirmation: ConfirmationRecord | undefined;
      if (rc.client_type === 'mcp') {
        const store = ctx.tasks?.confirmations;
        if (store === undefined || rc.mcp_confirmation_id === undefined) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'an MCP probe requires a verified confirmation',
            { reason: 'confirmation_required' },
            'Run health.probe.run through the MCP confirmation flow (input_required). REST and xinasctl need no confirmation.',
          );
        }
        const record = store.get(rc.mcp_confirmation_id);
        const now = Date.now();
        if (
          record === null ||
          record.principal !== rc.principal ||
          record.tool_name !== PROBE_TOOL ||
          record.arguments_hash !== argumentsHash(PROBE_TOOL, body)
        ) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'the confirmation does not belong to this principal, tool and arguments',
            { reason: 'confirmation_binding' },
          );
        }
        if (record.status !== 'pending' || record.mode !== 'form' || record.expires_at <= now) {
          throw new ApiException('PRECONDITION_FAILED', 'the confirmation is not pending', {
            reason: 'confirmation_not_approved',
            status:
              record.expires_at <= now && record.status === 'pending' ? 'expired' : record.status,
          });
        }
        const probeId = `probe:${randomUUID()}`;
        const consumed = store.consume({
          confirmation_id: record.confirmation_id,
          task_id: probeId,
          from: 'pending',
          principal: rc.principal,
          now,
        });
        if (!consumed) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'the confirmation was consumed by a concurrent probe',
            { reason: 'confirmation_not_approved', status: 'consumed' },
          );
        }
        confirmation = store.get(record.confirmation_id) ?? record;
        queueConfirmationEvent(ctx.state.audit, 'consumed', confirmation, { task_id: probeId });
        rc.operation_id = probeId;
      }

      const client = ctx.tasks?.agentClient;
      if (client === undefined) {
        throw new ApiException('UNSUPPORTED', 'no agent RPC client configured');
      }
      let outcome: Record<string, unknown>;
      try {
        outcome = (await client.call(
          PROBE_TOOL,
          { probe: kind, path, run_id: runId, timeout_ms: timeoutS * 1000 },
          timeoutS * 1000 + 5_000,
        )) as Record<string, unknown>;
      } catch (err) {
        const code =
          err instanceof AgentRpcError
            ? (err.data as { code?: unknown } | undefined)?.code
            : undefined;
        if (code === 'PROBE_IN_PROGRESS') {
          throw new ApiException(
            'CONFLICT',
            'a health probe is already in flight on this node',
            { reason: 'PROBE_IN_PROGRESS' },
            'Wait for the running probe to finish, then retry.',
          );
        }
        throw err;
      }
      const { probe: _probe, path: _path, ...rest } = outcome;
      const result = {
        probe: kind,
        target,
        path,
        run_id: runId,
        ...rest,
        proves: PROVES[kind],
        ...(confirmation !== undefined ? { confirmation_id: confirmation.confirmation_id } : {}),
      };
      if (runId !== null && hp !== undefined) {
        hp.ledger.record(
          runId,
          PROBE_TOOL,
          { probe: kind, target, timeout_s: timeoutS },
          result,
          typeof rest.completed_at === 'string' ? rest.completed_at : new Date().toISOString(),
        );
      }
      sendOk(req, res, result, [], warnings);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TARGETS_MAX = 32;

/** `?targets=a,b,c` — the prompt's `targets` argument, same grammar (spec §5.3). */
function parseTargetsQuery(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'string') {
    throw new ApiException('INVALID_ARGUMENT', 'targets must be one comma-separated string');
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length > TARGETS_MAX) {
    throw new ApiException('INVALID_ARGUMENT', `targets: at most ${TARGETS_MAX} ids`, {
      count: ids.length,
    });
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!TARGET_RE.test(id)) {
      throw new ApiException('INVALID_ARGUMENT', `targets: invalid resource id '${id}'`, { id });
    }
    seen.add(id);
  }
  return [...seen];
}
