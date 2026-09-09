/**
 * The api side of the baseline adapter (S19c; spec §8.1, §8.2, §8.4).
 *
 * `GET /health/baseline` resolves a profile name against the catalog the api
 * listed at startup, caps the engine timeout per profile, asks the agent's
 * `health.baseline` RPC to run it, and keeps the last SUCCESSFUL result per
 * profile in memory so a caller may ask for a result no older than
 * `max_age_s` instead of re-running the engine (DATA-05: `from_cache` and
 * the original `collected_at` state the freshness; nothing is implied).
 *
 * The first call also asks the engine which sections it can check
 * (`--sections`, through the same RPC) and keeps the answer for the
 * process lifetime: from then on `sections_without_checker` — here and in
 * `health.context` — comes from the engine, not from the static copy in
 * `profiles.ts` (spec §8.5, AC-06).
 *
 * The route never fails because the agent is down (SAFE-04): no client, an
 * RPC error or a missing profile file is a 200 whose `collection.status`
 * says so and whose `report` is null.
 */

import { ApiException } from '../errors.js';
import type { BaselineProfile } from './profiles.js';
import type { HealthPromptContext } from './prompt-context.js';

/** What the agent's `health.baseline` answers (structural copy — api/ never imports agent/). */
export interface AgentBaselineRun {
  status: 'success' | 'error' | 'timeout' | 'not_supported';
  collected_at: string;
  duration_ms: number;
  engine: { module: string; version: string | null } | null;
  report: Record<string, unknown> | null;
  stderr_tail?: string;
  error?: { code: string; message: string };
}

export interface AgentBaselineSections {
  status: 'success' | 'error' | 'timeout' | 'not_supported';
  sections: string[] | null;
  version: string | null;
}

export interface EngineSections {
  sections: string[];
  version: string | null;
}

export interface BaselineCollection {
  status: AgentBaselineRun['status'];
  collected_at: string;
  duration_ms: number;
  from_cache: boolean;
  age_s: number;
}

export interface BaselineResponse {
  profile: {
    name: string;
    path: string | null;
    sha256: string | null;
    timeout_seconds: number;
    sections_without_checker: string[];
  };
  collection: BaselineCollection;
  engine: { module: string; version: string | null } | null;
  report: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  stderr_tail: string;
  run_id: string | null;
}

export interface BaselineCacheEntry {
  result: BaselineResponse;
  /** The api's clock when the result arrived (the agent shares the host clock). */
  stored_at_ms: number;
}

/** The subset of the agent RPC client this module needs (tests inject a fake). */
export interface BaselineRpcClient {
  call(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

export const MAX_AGE_S_MAX = 3600;
export const SECTIONS_RPC_TIMEOUT_MS = 35_000;

/** `mcp.health_prompt.baseline.timeout_s` per shipped name; a custom profile gets the standard cap. */
export function capFor(hp: HealthPromptContext, name: string): number {
  const caps = hp.config.baseline.timeout_s;
  if (name === 'quick' || name === 'standard' || name === 'deep') return caps[name];
  return caps.standard;
}

/** `min(profile.timeout_seconds, cap)` — the profile's own number may be truncated (§8.1). */
export function effectiveTimeoutS(profile: BaselineProfile, cap: number): number {
  const own = profile.timeout_seconds;
  const t = own === null || !Number.isFinite(own) || own < 1 ? cap : Math.min(own, cap);
  return Math.max(1, Math.floor(t));
}

/** The live engine list wins over the static copy taken at startup. */
export function sectionsWithoutChecker(
  profile: BaselineProfile,
  engine: EngineSections | null,
): string[] {
  if (engine === null) return profile.sections_without_checker;
  return profile.sections_enabled.filter((s) => !engine.sections.includes(s));
}

export function parseMaxAgeS(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_AGE_S_MAX) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `max_age_s must be an integer between 0 and ${MAX_AGE_S_MAX}`,
      { max_age_s: raw },
    );
  }
  return n;
}

/** Ask the engine once which sections it can check; a failure leaves the static list in force. */
export async function ensureEngineSections(
  hp: HealthPromptContext,
  client: BaselineRpcClient,
): Promise<EngineSections | null> {
  if (hp.engineSections !== null) return hp.engineSections;
  try {
    const raw = (await client.call(
      'health.baseline',
      { sections: true },
      SECTIONS_RPC_TIMEOUT_MS,
    )) as Partial<AgentBaselineSections> | null;
    if (
      raw !== null &&
      typeof raw === 'object' &&
      raw.status === 'success' &&
      Array.isArray(raw.sections) &&
      raw.sections.every((s) => typeof s === 'string')
    ) {
      hp.engineSections = {
        sections: raw.sections,
        version: typeof raw.version === 'string' ? raw.version : null,
      };
    }
  } catch {
    /* the agent is down or old: the static list stays in force until a later call succeeds */
  }
  return hp.engineSections;
}

export interface RunBaselineDeps {
  hp: HealthPromptContext;
  client: BaselineRpcClient | undefined;
  profile: BaselineProfile;
  maxAgeS: number;
  now?: () => number;
}

function profileBlock(
  profile: BaselineProfile,
  timeoutS: number,
  engine: EngineSections | null,
): BaselineResponse['profile'] {
  return {
    name: profile.name,
    path: profile.path,
    sha256: profile.sha256,
    timeout_seconds: timeoutS,
    sections_without_checker: sectionsWithoutChecker(profile, engine),
  };
}

function failed(
  profile: BaselineResponse['profile'],
  nowIso: string,
  status: AgentBaselineRun['status'],
  error: { code: string; message: string },
): BaselineResponse {
  return {
    profile,
    collection: { status, collected_at: nowIso, duration_ms: 0, from_cache: false, age_s: 0 },
    engine: null,
    report: null,
    error,
    stderr_tail: '',
    run_id: null,
  };
}

/** Run (or serve from cache) one baseline profile; never throws for an agent-side failure. */
export async function runBaseline(deps: RunBaselineDeps): Promise<BaselineResponse> {
  const { hp, profile } = deps;
  const now = deps.now ?? (() => Date.now());
  const cap = capFor(hp, profile.name);
  const timeoutS = effectiveTimeoutS(profile, cap);

  const cached = hp.baselineCache.get(profile.name);
  if (deps.maxAgeS > 0 && cached !== undefined) {
    const ageS = Math.floor((now() - cached.stored_at_ms) / 1000);
    if (ageS <= deps.maxAgeS) {
      return {
        ...cached.result,
        profile: profileBlock(profile, timeoutS, hp.engineSections),
        collection: { ...cached.result.collection, from_cache: true, age_s: Math.max(0, ageS) },
        run_id: null,
      };
    }
  }

  const nowIso = new Date(now()).toISOString();
  if (deps.client === undefined) {
    return failed(profileBlock(profile, timeoutS, hp.engineSections), nowIso, 'error', {
      code: 'EXECUTOR_UNAVAILABLE',
      message: 'no agent RPC client configured',
    });
  }
  const engine = await ensureEngineSections(hp, deps.client);
  const block = profileBlock(profile, timeoutS, engine);
  if (profile.path === null) {
    return failed(block, nowIso, 'error', {
      code: 'PROFILE_NOT_FOUND',
      message: `${profile.name}.yml is not present in ${hp.profiles.dir}`,
    });
  }

  let raw: unknown;
  try {
    raw = await deps.client.call(
      'health.baseline',
      { profile_path: profile.path, timeout_s: timeoutS },
      timeoutS * 1000 + 5_000,
    );
  } catch (err) {
    return failed(block, nowIso, 'error', {
      code: 'EXECUTOR_UNAVAILABLE',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const run = raw as Partial<AgentBaselineRun> | null;
  if (
    run === null ||
    typeof run !== 'object' ||
    typeof run.status !== 'string' ||
    typeof run.collected_at !== 'string'
  ) {
    return failed(block, nowIso, 'error', {
      code: 'BAD_AGENT_RESULT',
      message: 'the agent answered health.baseline with an unexpected shape',
    });
  }
  const result: BaselineResponse = {
    profile: block,
    collection: {
      status: run.status,
      collected_at: run.collected_at,
      duration_ms: typeof run.duration_ms === 'number' ? run.duration_ms : 0,
      from_cache: false,
      age_s: 0,
    },
    engine: run.engine ?? null,
    report: run.status === 'success' && run.report !== undefined ? run.report : null,
    error: run.error ?? null,
    stderr_tail: typeof run.stderr_tail === 'string' ? run.stderr_tail : '',
    run_id: null,
  };
  if (result.collection.status === 'success' && result.report !== null) {
    hp.baselineCache.set(profile.name, { result, stored_at_ms: now() });
  }
  return result;
}
