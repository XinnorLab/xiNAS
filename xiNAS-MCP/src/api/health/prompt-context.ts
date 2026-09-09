/**
 * The per-process context behind the `xinas_health_check` prompt (S19b;
 * spec §5.5, §8.2, §12.1): the resolved `mcp.health_prompt` block, the
 * effective template body (the shipped constant or the operator override)
 * and its sha256, the baseline profile catalog listed once at startup, and
 * the `PromptsOptions` the transport installs on both eras.
 *
 * Built by `app.ts` iff `mcp.health_prompt.enabled`; `undefined` means the
 * feature is off and nothing prompt-related is advertised.
 */

import { readFileSync } from 'node:fs';
import {
  type ApiConfig,
  type ResolvedHealthPromptConfig,
  resolveHealthPromptConfig,
} from '../config.js';
import type { AuditSink } from '../events/audit.js';
import { CATALOG } from '../mcp/catalog.js';
import type { PromptsOptions } from '../mcp/prompts.js';
import {
  HEALTH_PROMPT_TEMPLATE,
  HEALTH_PROMPT_VERSION,
  REPORT_SCHEMA_VERSION,
  createHealthPromptProvider,
  sha256Hex,
} from '../mcp/prompts/health-check.js';
import { type ProfileCatalog, loadProfileCatalog } from './profiles.js';
import { RunLedger } from './run-ledger.js';

/** The check catalog version (spec §10); the catalog file lands with `health.catalog`. */
export const AGENTIC_CATALOG_VERSION = '1';

/** The api's cached last agent probe (spec §6.2 `collectors.last_probe`). */
export interface LastProbe {
  collected_at: string;
  level: 'standard' | 'deep';
  collectors: Record<string, string>;
}

export interface HealthPromptContext {
  config: ResolvedHealthPromptConfig;
  prompts: PromptsOptions;
  profiles: ProfileCatalog;
  /** The effective prompt body: the shipped constant or the operator override. */
  body: string;
  templateSha256: string;
  versions: {
    prompt: string;
    policy: string;
    catalog: string;
    report_schema: string;
  };
  /** S19 §6.3: the in-memory run ledger `health.context` mints into. */
  ledger: RunLedger;
  /** Written by `GET /health` whenever the agent answered a standard/deep probe. */
  lastProbe: LastProbe | null;
}

export interface HealthPromptDeps {
  audit?: AuditSink;
  /** Injectable for tests; defaults to the sync loader over `baseline.profiles_dir`. */
  loadProfiles?: (dir: string) => ProfileCatalog;
  /** Injectable for tests; defaults to `readFileSync(path, 'utf8')`. */
  readTemplate?: (path: string) => string;
  /** Injectable clock for the ledger; defaults to `Date.now`. */
  now?: () => number;
}

/** `available.*` of spec §5.4: installed handlers only — the catalog entry exists. */
function installed(name: string): boolean {
  return CATALOG.some((e) => e.name === name);
}

export function buildHealthPromptContext(
  config: ApiConfig,
  deps: HealthPromptDeps = {},
): HealthPromptContext | undefined {
  const resolved = resolveHealthPromptConfig(config);
  if (!resolved.enabled) return undefined;

  let body = HEALTH_PROMPT_TEMPLATE;
  if (resolved.template_path !== null) {
    const read = deps.readTemplate ?? ((p: string) => readFileSync(p, 'utf8'));
    try {
      body = read(resolved.template_path);
    } catch (err) {
      throw new Error(
        `mcp.health_prompt.template_path: cannot read ${resolved.template_path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (body.trim().length === 0) {
      throw new Error(`mcp.health_prompt.template_path: ${resolved.template_path} is empty`);
    }
  }
  const templateSha256 = sha256Hex(body);
  const profiles = (deps.loadProfiles ?? loadProfileCatalog)(resolved.baseline.profiles_dir);
  const profileNames = profiles.profiles.map((p) => p.name);
  const versions = {
    prompt: HEALTH_PROMPT_VERSION,
    policy: resolved.policy_version,
    catalog: AGENTIC_CATALOG_VERSION,
    report_schema: REPORT_SCHEMA_VERSION,
  };
  const provider = createHealthPromptProvider({
    body,
    version: versions.prompt,
    policyVersion: versions.policy,
    catalogVersion: versions.catalog,
    reportSchemaVersion: versions.report_schema,
    probePolicyMax: resolved.probe_policy_max,
    limits: resolved.limits,
    profileNames: () => profileNames,
    available: {
      context: installed('health.context'),
      baseline: installed('health.baseline'),
      probe_run: installed('health.probe.run'),
      catalog: installed('health.catalog'),
      report_schema: installed('health.report_schema'),
      validate: installed('health.report.validate'),
    },
  });
  return {
    config: resolved,
    prompts: { providers: [provider], ...(deps.audit !== undefined ? { audit: deps.audit } : {}) },
    profiles,
    body,
    templateSha256,
    versions,
    ledger: new RunLedger({
      now: deps.now ?? (() => Date.now()),
      ttlMs: resolved.limits.run_ttl_seconds * 1000,
    }),
    lastProbe: null,
  };
}
