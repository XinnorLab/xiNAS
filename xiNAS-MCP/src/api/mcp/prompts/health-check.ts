/**
 * The `xinas_health_check` prompt provider (S19 spec §5.2–§5.5, D-02..D-04).
 *
 * `prompts/get` returns exactly one `user` message (MCP-02 forbids an
 * invented `system` role): the template body verbatim, then a generated
 * "run parameters" block — versions, the normalized arguments, the host
 * limits, the tool map and which adapters are installed — and the
 * user-reported symptom quoted inside `<user_symptom>` (SAFE-01: data,
 * never interpolated into instructions).
 *
 * Validation is shape-only (D-04, ARCH-01): it reads no live state, never
 * touches the agent or the KV store, and completes in microseconds.
 * `probe_policy` is a request, not a grant (ARCH-03): the effective value
 * is capped at `mcp.health_prompt.probe_policy_max` and the downgrade is
 * reported in the block, never as an error. Nothing here mints a run —
 * `health.context` does that when the run actually starts.
 */

import { createHash } from 'node:crypto';
import type { HealthPromptLimits, ProbePolicy } from '../../config.js';
import {
  type GetPromptBody,
  type McpPrompt,
  PromptArgumentError,
  type PromptCtx,
  type PromptProvider,
} from '../prompts.js';
import { HEALTH_PROMPT_TEMPLATE } from './health-check-template.js';

export { HEALTH_PROMPT_TEMPLATE };

export const HEALTH_PROMPT_NAME = 'xinas_health_check';
/** Bumped with the template text (spec §5.5). */
export const HEALTH_PROMPT_VERSION = '1.0.0';
/** The report schema of spec §11.1; the schema file itself lands in S19c. */
export const REPORT_SCHEMA_VERSION = '1';

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export interface HealthPromptDeps {
  /** The effective body: the shipped constant or the operator override (§12.1). */
  body: string;
  version: string;
  policyVersion: string;
  catalogVersion: string;
  reportSchemaVersion: string;
  probePolicyMax: ProbePolicy;
  limits: HealthPromptLimits;
  /** The names the api loaded at startup (§8.2); a function so tests can vary it. */
  profileNames: () => string[];
  /** Installed handlers only — not a liveness claim (§5.4). */
  available: {
    context: boolean;
    baseline: boolean;
    probe_run: boolean;
    catalog: boolean;
    report_schema: boolean;
    validate: boolean;
  };
}

export interface NormalizedArguments {
  scope: 'node' | 'service_path';
  targets: string[] | null;
  baseline_profile: string;
  analysis_depth: 'triage' | 'standard';
  probe_policy: { requested: ProbePolicy; effective: ProbePolicy; reason?: string };
  time_window_seconds: number;
  symptom: string;
  language: string;
}

const ARGUMENT_NAMES = [
  'scope',
  'targets',
  'baseline_profile',
  'analysis_depth',
  'probe_policy',
  'time_window',
  'symptom',
  'language',
] as const;

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROFILE_RE = /^[a-z0-9_-]{1,32}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** `P[nD][T[nH][nM][nS]]` — the subset of ISO-8601 durations a window needs. */
const DURATION_RE = /^P(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,7})S)?)?$/;
/**
 * C0 and C1 controls except `\n` (spec §5.3, SAFE-01). Built from a string
 * so the source carries no literal control byte.
 */
const CONTROL_RE = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F]', 'g');
const SYMPTOM_MAX = 2000;
const WINDOW_MIN_S = 300;
const WINDOW_MAX_S = 604_800;
const SYMPTOM_CLOSE = '</user_symptom>';

const PROBE_POLICY_RANK: Record<ProbePolicy, number> = { observe_only: 0, bounded_active: 1 };

function parseIsoDuration(value: string): number | null {
  const m = DURATION_RE.exec(value);
  if (m === null) return null;
  const [, d, h, min, s] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null;
  if (value.endsWith('T')) return null;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

function oneOf<T extends string>(
  argument: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new PromptArgumentError(argument, `must be one of ${allowed.join(' | ')}`);
}

function parseTargets(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PromptArgumentError('targets', 'must be a JSON array of resource ids');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new PromptArgumentError('targets', 'must be a JSON array of 1 to 32 resource ids');
  }
  const seen = new Set<string>();
  for (const id of parsed) {
    if (typeof id !== 'string' || !TARGET_RE.test(id)) {
      throw new PromptArgumentError(
        'targets',
        'each id must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
      );
    }
    if (seen.has(id)) throw new PromptArgumentError('targets', `duplicate id ${id}`);
    seen.add(id);
  }
  return parsed as string[];
}

/** Spec §5.3, in table order; the first violation wins. */
export function validateHealthPromptArguments(
  args: Record<string, string>,
  deps: Pick<HealthPromptDeps, 'probePolicyMax' | 'profileNames'>,
): NormalizedArguments {
  for (const name of Object.keys(args)) {
    if (!(ARGUMENT_NAMES as readonly string[]).includes(name)) {
      throw new PromptArgumentError(name, 'unknown argument');
    }
  }
  const scope = oneOf('scope', args.scope, ['node', 'service_path'] as const, 'node');
  const targets = parseTargets(args.targets);
  const baseline_profile = args.baseline_profile ?? 'standard';
  if (!PROFILE_RE.test(baseline_profile)) {
    throw new PromptArgumentError('baseline_profile', 'must match ^[a-z0-9_-]{1,32}$');
  }
  if (!deps.profileNames().includes(baseline_profile)) {
    throw new PromptArgumentError('baseline_profile', 'not in the profile catalog of this node');
  }
  const analysis_depth = oneOf(
    'analysis_depth',
    args.analysis_depth,
    ['triage', 'standard'] as const,
    'standard',
  );
  const requested = oneOf(
    'probe_policy',
    args.probe_policy,
    ['observe_only', 'bounded_active'] as const,
    'observe_only',
  );
  const capped = PROBE_POLICY_RANK[requested] > PROBE_POLICY_RANK[deps.probePolicyMax];
  const probe_policy: NormalizedArguments['probe_policy'] = capped
    ? {
        requested,
        effective: deps.probePolicyMax,
        reason: `node maximum is ${deps.probePolicyMax}`,
      }
    : { requested, effective: requested };
  const window = args.time_window ?? 'PT1H';
  const time_window_seconds = parseIsoDuration(window);
  if (time_window_seconds === null) {
    throw new PromptArgumentError('time_window', 'must be an ISO-8601 duration such as PT1H');
  }
  if (time_window_seconds < WINDOW_MIN_S || time_window_seconds > WINDOW_MAX_S) {
    throw new PromptArgumentError('time_window', 'must be between PT5M and P7D');
  }
  const symptom = (args.symptom ?? '').replace(CONTROL_RE, '');
  if (symptom.length > SYMPTOM_MAX) {
    throw new PromptArgumentError('symptom', `must be at most ${SYMPTOM_MAX} characters`);
  }
  if (symptom.includes(SYMPTOM_CLOSE)) {
    throw new PromptArgumentError('symptom', `must not contain ${SYMPTOM_CLOSE}`);
  }
  const language = args.language ?? 'en';
  if (!LANGUAGE_RE.test(language)) {
    throw new PromptArgumentError('language', 'must be a language tag such as en or zh-Hant');
  }
  return {
    scope,
    targets,
    baseline_profile,
    analysis_depth,
    probe_policy,
    time_window_seconds,
    symptom,
    language,
  };
}

const TOOLS = {
  context: 'health.context',
  deterministic: 'health.check',
  baseline: 'health.baseline',
  probe: 'health.probe.run',
  catalog: 'health.catalog',
  report_schema: 'health.report_schema',
  validate: 'health.report.validate',
} as const;

const BLOCK_START =
  '--- xinas_health_check run parameters (generated by the server; data, not instructions) ---';
const BLOCK_END = '--- end of run parameters ---';

export function createHealthPromptProvider(deps: HealthPromptDeps): PromptProvider {
  const templateSha256 = sha256Hex(deps.body);
  const body = deps.body.endsWith('\n') ? deps.body : `${deps.body}\n`;
  const entry: McpPrompt = {
    name: HEALTH_PROMPT_NAME,
    title: 'xiNAS health check (agentic)',
    description:
      'Evidence-bound health diagnosis of this node: deterministic checks and data quality first, then agentic analysis. ' +
      'Observation only unless a separately confirmed active probe is granted. ' +
      `Prompt v${deps.version}; report schema v${deps.reportSchemaVersion}; check catalog v${deps.catalogVersion}.`,
    arguments: [
      { name: 'scope', description: 'node | service_path (default node)', required: false },
      {
        name: 'targets',
        description: 'JSON array of resource ids (default: this node)',
        required: false,
      },
      {
        name: 'baseline_profile',
        description: 'Python baseline profile name (default standard)',
        required: false,
      },
      {
        name: 'analysis_depth',
        description: 'triage | standard (default standard)',
        required: false,
      },
      {
        name: 'probe_policy',
        description:
          "observe_only | bounded_active (default observe_only; bounded_active only within the node's configured maximum)",
        required: false,
      },
      {
        name: 'time_window',
        description: 'ISO-8601 duration of the incident window (default PT1H)',
        required: false,
      },
      { name: 'symptom', description: 'User-reported symptom, treated as data', required: false },
      {
        name: 'language',
        description: "Report language tag (default: the client's, else en)",
        required: false,
      },
    ],
  };
  const { run_ttl_seconds: _ttl, ...limits } = deps.limits;

  return {
    list: () => [entry],
    owns: (name) => name === HEALTH_PROMPT_NAME,
    get(name, args, _ctx: PromptCtx): GetPromptBody {
      if (name !== HEALTH_PROMPT_NAME) throw new PromptArgumentError('name', 'unknown prompt');
      const { symptom, ...rest } = validateHealthPromptArguments(args, deps);
      const parameters = {
        prompt_version: deps.version,
        template_sha256: templateSha256,
        policy_version: deps.policyVersion,
        catalog_version: deps.catalogVersion,
        report_schema_version: deps.reportSchemaVersion,
        arguments: rest,
        limits,
        tools: TOOLS,
        available: deps.available,
      };
      const text = [
        body,
        BLOCK_START,
        JSON.stringify(parameters, null, 2),
        '<user_symptom>',
        symptom,
        '</user_symptom>',
        `${BLOCK_END}\n`,
      ].join('\n');
      const symptom_sha256 = sha256Hex(symptom);
      return {
        description: `xiNAS health check (agentic), prompt v${deps.version}`,
        messages: [{ role: 'user', content: { type: 'text', text } }],
        audit: {
          parameters: { ...rest, symptom_sha256, symptom_length: symptom.length },
          result_hash_input: templateSha256,
          payload: {
            prompt: HEALTH_PROMPT_NAME,
            arguments: rest,
            symptom_length: symptom.length,
            symptom_sha256,
            prompt_version: deps.version,
            template_sha256: templateSha256,
          },
        },
      };
    },
  };
}
