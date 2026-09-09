/**
 * The versioned agentic check catalog (S19 spec §10, CHECK-01..03).
 *
 * `agentic-catalog.json` is data: one row per check the prompt asks the
 * model to cover, with the producers it may consume (`inputs`), how each
 * producer's status maps to an outcome and a severity, its side effects
 * and cost, and — for honesty — rows that have no producer today
 * (`no_source: true`), so a client can render "Not checked" from the
 * catalog rather than from the model's memory.
 *
 * `validateAgenticCatalog` is what the unit test runs over the shipped
 * file against the real sources: every `mcp:health.check` input names a
 * check id the deterministic profiles produce, every `baseline` input a
 * section and check a shipped profile lists, every `read:` a catalog
 * tool, and every `expectations.<key>` a key the profiles define — the
 * catalog cites profile keys, never loose numbers (CHECK-02/03).
 *
 * `lib/` imports nothing from `api/` or `agent/`; the api serves the
 * object verbatim on `GET /health/catalog`.
 */

import { readFileSync } from 'node:fs';

export type CheckOutcome = 'pass' | 'warn' | 'fail' | 'unknown' | 'not_applicable';
export type CheckSeverity = 'warning' | 'degraded' | 'critical';
export type InputFreshness = 'per_call' | 'observed_at';
export type TopologyComponent = 'arrays' | 'filesystems' | 'shares' | 'interfaces';
export type Scope = 'node' | 'service_path';
export type ExpectedSource = 'local_override' | 'desired' | 'vendor';

export type AgenticCheckInput =
  | {
      source: 'mcp:health.check';
      check_id: string;
      profile?: 'quick' | 'standard' | 'deep';
      freshness: InputFreshness;
    }
  | { source: 'baseline'; section: string; check: string; freshness: InputFreshness }
  | { source: `read:${string}`; freshness: InputFreshness }
  | { source: `resource:${string}`; freshness: InputFreshness }
  | {
      source: 'probe:health.probe.run';
      probe: 'fs_io' | 'nfs_loopback';
      freshness: InputFreshness;
    };

export interface AgenticCheck {
  id: string;
  version: number;
  area: string;
  goal: string;
  applicability: { requires: TopologyComponent[] };
  mandatory_for: Scope[];
  expected_source: ExpectedSource[];
  /** HC-12 only: the effective probe policy the row needs. */
  requires_policy?: 'bounded_active';
  inputs: AgenticCheckInput[];
  procedure: string;
  criterion: string;
  outcome_map: Record<string, CheckOutcome>;
  severity_map: Record<string, CheckSeverity>;
  side_effects: 'none' | 'active_probe';
  cost: { timeout_s: number };
  next_check: string;
  no_source: boolean;
}

export interface AgenticCatalog {
  version: string;
  checks: AgenticCheck[];
}

/**
 * Every check id the deterministic profiles produce (quick ⊂ standard ⊂
 * deep; `lib/health/checks.ts`, `drift.ts`, `standard.ts`). Pinned here as
 * the validator's allow-list; the test cross-checks it against the checks.
 */
export const MCP_CHECK_IDS: readonly string[] = [
  // quick
  'agent.connectivity',
  'disk.health',
  'filesystem.mounts',
  'network.duplicate-netplan',
  'network.rdma-readiness',
  'nfs.exports',
  'nfs.server',
  'systemd.units',
  'tuning.sysctl',
  'xiraid.arrays',
  'drift.netplan',
  'drift.nfs-conf',
  'drift.nfs-exports',
  // standard
  'agent.collectors',
  'network.rdma-live',
  'xiraid.license',
  'xiraid.service',
  // deep
  'filesystem.io',
  'nfs.loopback',
];

const MCP_STATUSES = ['ok', 'warning', 'degraded', 'critical', 'skipped'] as const;
const BASELINE_STATUSES = ['PASS', 'WARN', 'FAIL', 'SKIP'] as const;
const PROBE_STATUSES = ['ok', 'failed', 'cleanup_failed'] as const;
const OUTCOMES: readonly string[] = ['pass', 'warn', 'fail', 'unknown', 'not_applicable'];
const SEVERITIES: readonly string[] = ['warning', 'degraded', 'critical'];
const COMPONENTS: readonly string[] = ['arrays', 'filesystems', 'shares', 'interfaces'];
const SCOPES: readonly string[] = ['node', 'service_path'];
const SOURCES: readonly string[] = ['local_override', 'desired', 'vendor'];
const ID_RE = /^HC-\d{2}\.[a-z0-9-]+$/;
const EXPECTATION_RE = /expectations\.([a-z0-9_]+)/g;

export interface ValidationRefs {
  mcpCheckIds: Set<string>;
  /** section → check names, unioned over the shipped profiles. */
  baseline: Record<string, string[]>;
  tools: Set<string>;
  expectationKeys: string[];
}

/** Every problem found, as "<check id>: <what>"; empty when the catalog is sound. */
export function validateAgenticCatalog(catalog: unknown, refs: ValidationRefs): string[] {
  const problems: string[] = [];
  const cat = catalog as Partial<AgenticCatalog> | null;
  if (cat === null || typeof cat !== 'object') return ['catalog: not an object'];
  if (typeof cat.version !== 'string' || cat.version.length === 0) {
    problems.push('catalog: version must be a non-empty string');
  }
  if (!Array.isArray(cat.checks) || cat.checks.length === 0) {
    return [...problems, 'catalog: checks must be a non-empty array'];
  }
  const seen = new Set<string>();
  const expectationKeys = new Set(refs.expectationKeys);
  for (const c of cat.checks) {
    const id = typeof c.id === 'string' ? c.id : '<no id>';
    const bad = (what: string) => problems.push(`${id}: ${what}`);
    if (!ID_RE.test(id)) bad('id must match HC-NN.slug');
    if (seen.has(id)) bad('duplicate id');
    seen.add(id);
    if (c.version !== 1) bad('version must be 1');
    if (typeof c.area !== 'string' || !id.startsWith(`${c.area}.`)) bad('area must prefix the id');
    for (const field of ['goal', 'procedure', 'criterion', 'next_check'] as const) {
      if (typeof c[field] !== 'string' || c[field].trim().length === 0) bad(`${field} is empty`);
    }
    const requires = c.applicability?.requires;
    if (!Array.isArray(requires) || requires.some((r) => !COMPONENTS.includes(r))) {
      bad('applicability.requires must list topology components');
    }
    if (!Array.isArray(c.mandatory_for) || c.mandatory_for.some((s) => !SCOPES.includes(s))) {
      bad('mandatory_for must list scopes');
    }
    if (
      !Array.isArray(c.expected_source) ||
      c.expected_source.length === 0 ||
      c.expected_source.some((s) => !SOURCES.includes(s)) ||
      c.expected_source.some(
        (s, i, arr) => i > 0 && SOURCES.indexOf(s) <= SOURCES.indexOf(arr[i - 1] as string),
      )
    ) {
      bad('expected_source must be a non-empty subsequence of local_override, desired, vendor');
    }
    if (c.side_effects !== 'none' && c.side_effects !== 'active_probe') bad('side_effects');
    const timeout = c.cost?.timeout_s;
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 900) {
      bad('cost.timeout_s must be an integer between 1 and 900');
    }
    if (typeof c.no_source !== 'boolean') bad('no_source must be a boolean');
    const inputs = Array.isArray(c.inputs) ? c.inputs : [];
    if (!Array.isArray(c.inputs)) bad('inputs must be an array');
    if (c.no_source === true && inputs.length > 0) bad('a no_source row must list no inputs');
    if (c.no_source === false && inputs.length === 0) bad('a sourced row must list an input');

    const families = new Set<'mcp' | 'baseline' | 'probe'>();
    for (const input of inputs) {
      if (input.freshness !== 'per_call' && input.freshness !== 'observed_at') {
        bad(`input ${JSON.stringify(input)}: freshness`);
      }
      if (input.source === 'mcp:health.check') {
        families.add('mcp');
        if (!refs.mcpCheckIds.has(input.check_id)) {
          bad(`mcp check id ${input.check_id} is not produced by any profile`);
        }
        if (input.profile !== undefined && !['quick', 'standard', 'deep'].includes(input.profile)) {
          bad(`mcp check ${input.check_id}: profile`);
        }
      } else if (input.source === 'baseline') {
        families.add('baseline');
        const checks = refs.baseline[input.section];
        if (checks === undefined)
          bad(`baseline section ${input.section} is not in any shipped profile`);
        else if (!checks.includes(input.check)) {
          bad(`baseline check ${input.section}.${input.check} is not in any shipped profile`);
        }
      } else if (input.source === 'probe:health.probe.run') {
        families.add('probe');
        if (input.probe !== 'fs_io' && input.probe !== 'nfs_loopback') bad('probe kind');
        if (!refs.tools.has('health.probe.run')) bad('health.probe.run is not in the tool catalog');
      } else if (typeof input.source === 'string' && input.source.startsWith('read:')) {
        const tool = input.source.slice('read:'.length);
        if (!refs.tools.has(tool)) bad(`read tool ${tool} is not in the tool catalog`);
      } else if (typeof input.source === 'string' && input.source.startsWith('resource:')) {
        if (!input.source.startsWith('resource:xinas://events/')) {
          bad(`resource ${input.source} is not an event feed`);
        }
      } else {
        bad(`input source ${JSON.stringify((input as { source?: unknown }).source)} is unknown`);
      }
    }
    if (c.side_effects === 'active_probe' && !families.has('probe')) {
      bad('an active_probe row must consume a probe');
    }
    if (c.side_effects === 'none' && families.has('probe'))
      bad('a probe input needs side_effects active_probe');
    if (families.has('probe') && c.requires_policy !== 'bounded_active') {
      bad('a probe row must set requires_policy bounded_active');
    }

    const outcome = c.outcome_map ?? {};
    const severity = c.severity_map ?? {};
    const expectKeys = (family: string, statuses: readonly string[]) => {
      for (const s of statuses) {
        const key = `${family}:${s}`;
        if (!(key in outcome)) bad(`outcome_map lacks ${key}`);
      }
    };
    if (families.has('mcp')) expectKeys('mcp', MCP_STATUSES);
    if (families.has('baseline')) expectKeys('baseline', BASELINE_STATUSES);
    if (families.has('probe')) expectKeys('probe', PROBE_STATUSES);
    for (const [key, value] of Object.entries(outcome)) {
      const family = key.split(':')[0] ?? '';
      if (!['mcp', 'baseline', 'probe'].includes(family) || !families.has(family as 'mcp')) {
        bad(`outcome_map key ${key} has no matching input`);
      }
      if (!OUTCOMES.includes(value)) bad(`outcome_map ${key}: ${String(value)}`);
      if ((value === 'warn' || value === 'fail') && !(key in severity)) {
        bad(`severity_map lacks ${key}`);
      }
    }
    for (const [key, value] of Object.entries(severity)) {
      if (!(key in outcome)) bad(`severity_map key ${key} is not in outcome_map`);
      if (!SEVERITIES.includes(value)) bad(`severity_map ${key}: ${String(value)}`);
    }

    for (const text of [c.criterion, c.procedure]) {
      if (typeof text !== 'string') continue;
      for (const m of text.matchAll(EXPECTATION_RE)) {
        const key = m[1] as string;
        if (!expectationKeys.has(key))
          bad(`expectations.${key} is not defined by any shipped profile`);
      }
    }
  }
  for (const c of cat.checks) {
    if (typeof c.next_check === 'string' && !seen.has(c.next_check)) {
      problems.push(`${c.id}: next_check ${c.next_check} is not a catalog row`);
    }
  }
  return problems;
}

/** The shipped catalog, read once at module load (copied to dist/ by `npm run build`). */
export const AGENTIC_CATALOG: AgenticCatalog = JSON.parse(
  readFileSync(new URL('./agentic-catalog.json', import.meta.url), 'utf8'),
) as AgenticCatalog;
