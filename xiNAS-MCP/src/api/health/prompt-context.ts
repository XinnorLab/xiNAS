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
import type { BaselineCacheEntry, EngineSections } from './baseline.js';
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
  /** S19c §8.4: the last successful baseline result per profile name. */
  baselineCache: Map<string, BaselineCacheEntry>;
  /** S19c §8.5: the engine's `--sections` answer once a baseline call obtained it; null = static list. */
  engineSections: EngineSections | null;
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

export const TEMPLATE_MARKER = '## Prompt body';
export const TEMPLATE_MAX_BYTES = 64 * 1024;

/**
 * §12.1 `template_path`: the operator's file has the docs template's shape
 * (a markdown document whose `## Prompt body` section is the body), so an
 * operator copies `s19-mcp-health-prompt-template.md` and edits it. Read
 * once at startup; every defect aborts startup with the key named — a
 * silently ignored override would serve a prompt the operator did not
 * write.
 */
export function readTemplateOverride(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  const key = 'mcp.health_prompt.template_path';
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    throw new Error(
      `${key}: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Buffer.byteLength(text, 'utf8') > TEMPLATE_MAX_BYTES) {
    throw new Error(`${key}: ${path} exceeds ${TEMPLATE_MAX_BYTES} bytes`);
  }
  if (text.includes(String.fromCharCode(0))) throw new Error(`${key}: ${path} contains a NUL byte`);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === TEMPLATE_MARKER);
  if (at === -1) throw new Error(`${key}: ${path} has no "${TEMPLATE_MARKER}" marker line`);
  const body = lines
    .slice(at + 1)
    .join('\n')
    .trim();
  if (body.length === 0) throw new Error(`${key}: ${path} is empty after the marker`);
  return `${body}\n`;
}

export function buildHealthPromptContext(
  config: ApiConfig,
  deps: HealthPromptDeps = {},
): HealthPromptContext | undefined {
  const resolved = resolveHealthPromptConfig(config);
  if (!resolved.enabled) return undefined;

  let body = HEALTH_PROMPT_TEMPLATE;
  if (resolved.template_path !== null) {
    body = readTemplateOverride(resolved.template_path, deps.readTemplate);
  }
  const templateSha256 = sha256Hex(body);
  const profiles = (deps.loadProfiles ?? loadProfileCatalog)(resolved.baseline.profiles_dir);
  const profileNames = profiles.profiles.map((p) => p.name);
  const versions = {
    // §12.1: an operator override is the shipped version plus `+local`.
    prompt:
      resolved.template_path === null ? HEALTH_PROMPT_VERSION : `${HEALTH_PROMPT_VERSION}+local`,
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
    baselineCache: new Map(),
    engineSections: null,
  };
}
