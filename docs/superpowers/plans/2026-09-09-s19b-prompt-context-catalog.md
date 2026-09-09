# S19b — Prompt provider, run context and check catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the `xinas_health_check` prompt on both protocol eras, mint and record diagnostic runs through `health.context`, and ship the versioned check catalog — slice b of S19 (spec §1 "S19b").

**Architecture:** One `PromptProvider` seam (`api/mcp/prompts.ts`) mirrors the S17 resource-provider seam: the modern dispatcher gains `prompts/list` / `prompts/get` cases, the legacy SDK server gains the two handlers, and discovery advertises `prompts: { listChanged: false }` iff a provider is installed. The single provider (`api/mcp/prompts/health-check.ts`) validates arguments by shape only and returns one `user` message: the template body pinned to the docs file plus a generated parameters block. A new `mcp.health_prompt` config block (`config.ts`) carries the template override, policy cap, limits and profile directory. `health.context` (`api/health/context.ts` + `GET /health/context`) reads KV only, mints a `run_id` into an in-memory `RunLedger`, and reports permissions, topology, freshness, the baseline profile catalog (`api/health/profiles.ts`, `js-yaml`) and the tool list; `health.check` and `health.probe.run` record their report digests under a known `run_id`, and the probe route enforces `probes_per_run` from the ledger. The check catalog is data (`lib/health/agentic-catalog.json`) served by `GET /health/catalog`.

**Tech Stack:** TypeScript (Node ≥ 20), `js-yaml` (already a dependency), vitest, supertest, ajv (contract tests), `@modelcontextprotocol/sdk` 1.30 legacy schemas.

**Spec:** `docs/control-path/s19-mcp-health-prompt-spec.md` §4, §5, §6, §9.5, §10, §12, §13, §14, §15; ADR-0018 §1, §2, §7, §8.

## Global Constraints

- Every commit touching `xiNAS-MCP/src/` carries `Requires-Rebuild: xinas_node_build`; Conventional Commits; English only; `--merge` on the PR.
- `lib/` imports nothing from `agent/` or `api/`; `api/` never imports `agent/probe/*`.
- `prompts/get` reads no live state and mints nothing (spec §5.3 D-04, ARCH-01): validation is shape-only; resource existence is `health.context`'s job.
- `prompts` capability present as `{ listChanged: false }` iff the provider is installed, on both eras (spec §4).
- `prompts/get` returns exactly one `user` text message; never a `system` role (spec §5.4, MCP-02).
- An unknown prompt name, unknown argument or malformed value is JSON-RPC `-32602` with `data: { argument, reason }` (spec §5.3, MCP-03).
- `health.context` MUST NOT call the agent (spec §6.1).
- Nothing the model writes becomes observed state; the ledger is in memory with a TTL (spec §6.3, D-10).
- Additive `api-v1.yaml` only.
- Verification gate before "done": TypeScript trio, `npm test`, `npm run test:contracts`, `npm run build && npm run test:e2e`, yamllint, spectral, markdownlint, `ruff format --check .`.

---

## File structure

| Path | Responsibility |
|---|---|
| `xiNAS-MCP/src/api/config.ts` | `McpHealthPromptConfig`, `ResolvedHealthPromptConfig`, `HEALTH_PROMPT_DEFAULTS`, `resolveHealthPromptConfig()` |
| `xiNAS-MCP/src/api/health/profiles.ts` (new) | baseline profile catalog: list `*.yml`, sha256, `timeout_seconds`, sections, `sections_without_checker` (against `KNOWN_ENGINE_SECTIONS` until S19c) |
| `xiNAS-MCP/src/api/mcp/prompts.ts` (new) | `PromptProvider` seam, `listPrompts()`, `getPrompt()`, modern result shapes, `-32602` errors |
| `xiNAS-MCP/src/api/mcp/prompts/health-check.ts` (new) | the `xinas_health_check` provider: template constant, version/sha256, argument table, parameters block |
| `xiNAS-MCP/src/api/mcp/modern.ts`, `dispatch.ts`, `discover.ts`, `transport.ts`, `app.ts`, `context.ts` | wiring on both eras, capability flag, instructions pointer, `ctx.healthPrompt` |
| `xiNAS-MCP/src/api/health/run-ledger.ts` (new) | `RunLedger`: mint, get, record digest, probe counter, TTL sweep |
| `xiNAS-MCP/src/api/health/context.ts` (new) | `buildHealthContext()` over KV + ledger + profiles + catalog |
| `xiNAS-MCP/src/api/routes/health.ts` | `GET /health/context`, `GET /health/catalog`; ledger digests on `/health` and `/health/probe`; `probes_per_run` |
| `xiNAS-MCP/src/lib/health/agentic-catalog.json` (new) + `agentic-catalog.ts` | the HC-01..HC-12 rows and their loader/validator |
| `xiNAS-MCP/src/api/mcp/catalog.ts` | `health.context`, `health.catalog` read entries |
| `docs/control-path/api-v1.yaml`, spec, S14 §4, ADR-0010 preamble, S8 §3, CHANGELOG, TODO, runbook, CLAUDE.md | contracts and status |

Commands run from `xiNAS-MCP/` unless a path says otherwise.

---

### Task 1: `mcp.health_prompt` configuration

**Files:**
- Modify: `xiNAS-MCP/src/api/config.ts`
- Test: `xiNAS-MCP/src/__tests__/api/config-health-prompt.test.ts` (new)

**Interfaces (produces):**

```ts
export interface McpHealthPromptConfig {
  enabled?: boolean;
  template_path?: string;
  policy_version?: string;
  probe_policy_max?: 'observe_only' | 'bounded_active';
  limits?: Partial<HealthPromptLimits>;
  baseline?: { profiles_dir?: string; timeout_s?: Partial<Record<'quick' | 'standard' | 'deep', number>>; max_age_s_default?: number };
}
export interface HealthPromptLimits { analysis_seconds: number; tool_calls: number; roles: number; active_probes_per_node: 1; probes_per_run: number; retries: number; run_ttl_seconds: number }
export interface ResolvedHealthPromptConfig {
  enabled: boolean; template_path: string | null; policy_version: string;
  probe_policy_max: 'observe_only' | 'bounded_active'; limits: HealthPromptLimits;
  baseline: { profiles_dir: string; timeout_s: { quick: number; standard: number; deep: number }; max_age_s_default: number };
}
export const HEALTH_PROMPT_DEFAULTS: ResolvedHealthPromptConfig;   // spec §12.1 values
export function resolveHealthPromptConfig(config: ApiConfig): ResolvedHealthPromptConfig; // throws Error naming the key on a bad value
```

`ApiConfig.mcp` gains `health_prompt?: McpHealthPromptConfig`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { type ApiConfig, HEALTH_PROMPT_DEFAULTS, resolveHealthPromptConfig } from '../../api/config.js';

const base = (mcp: Record<string, unknown>): ApiConfig =>
  ({ controller_id: 'c', listen: { kind: 'tcp', host: '127.0.0.1', port: 0 }, tokens: {},
     state: { databasePath: ':memory:', auditJsonlPath: '/dev/null' }, mcp }) as unknown as ApiConfig;

describe('resolveHealthPromptConfig (spec §12.1)', () => {
  it('defaults: enabled, observe_only, the §12.1 limits and the /opt/xiNAS profiles dir', () => {
    expect(resolveHealthPromptConfig(base({}))).toEqual(HEALTH_PROMPT_DEFAULTS);
    expect(HEALTH_PROMPT_DEFAULTS).toMatchObject({
      enabled: true, template_path: null, policy_version: '1', probe_policy_max: 'observe_only',
      limits: { analysis_seconds: 180, tool_calls: 40, roles: 3, active_probes_per_node: 1, probes_per_run: 4, retries: 2, run_ttl_seconds: 900 },
      baseline: { profiles_dir: '/opt/xiNAS/healthcheck_profiles', timeout_s: { quick: 60, standard: 180, deep: 300 }, max_age_s_default: 0 },
    });
  });
  it('overrides merge per key', () => {
    const r = resolveHealthPromptConfig(base({ health_prompt: { enabled: false, probe_policy_max: 'bounded_active',
      limits: { probes_per_run: 0, run_ttl_seconds: 300 }, baseline: { timeout_s: { deep: 120 } } } }));
    expect(r.enabled).toBe(false);
    expect(r.probe_policy_max).toBe('bounded_active');
    expect(r.limits).toMatchObject({ probes_per_run: 0, run_ttl_seconds: 300, tool_calls: 40 });
    expect(r.baseline.timeout_s).toEqual({ quick: 60, standard: 180, deep: 120 });
  });
  it.each([
    [{ limits: { analysis_seconds: 10 } }, 'analysis_seconds'],
    [{ limits: { active_probes_per_node: 2 } }, 'active_probes_per_node'],
    [{ limits: { probes_per_run: 17 } }, 'probes_per_run'],
    [{ limits: { run_ttl_seconds: 100 } }, 'run_ttl_seconds'],
    [{ probe_policy_max: 'anything' }, 'probe_policy_max'],
    [{ policy_version: 'has space' }, 'policy_version'],
    [{ baseline: { profiles_dir: 'relative/dir' } }, 'profiles_dir'],
    [{ baseline: { timeout_s: { quick: 5 } } }, 'timeout_s.quick'],
  ])('rejects %j naming %s', (over, key) => {
    expect(() => resolveHealthPromptConfig(base({ health_prompt: over }))).toThrow(new RegExp(key));
  });
});
```

- [ ] **Step 2: RED** — `npx vitest run src/__tests__/api/config-health-prompt.test.ts` fails: no export.
- [ ] **Step 3: Implement** in `config.ts` next to the subscriptions block: the interfaces, `HEALTH_PROMPT_DEFAULTS`, and `resolveHealthPromptConfig` with a small `range(key, value, min, max)` helper that throws an Error whose message names the key and the bounds ("mcp.health_prompt.KEY: must be an integer between MIN and MAX"); `probe_policy_max` must be one of the two enum values; `policy_version` must match `/^[A-Za-z0-9.+-]{1,32}$/`; `profiles_dir` must be an absolute path; `template_path` when set must be an absolute path. Ranges: analysis_seconds 30–3600, tool_calls 5–500, roles 1–8, active_probes_per_node exactly 1, probes_per_run 0–16, retries 0–5, run_ttl_seconds 300–7200, timeout_s.* 10–900, max_age_s_default 0–3600.
- [ ] **Step 4: GREEN** — the file passes; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(api): mcp.health_prompt configuration block (S19b T1)` with the trailer and co-author lines.

---

### Task 2: Baseline profile catalog

**Files:**
- Create: `xiNAS-MCP/src/api/health/profiles.ts`
- Test: `xiNAS-MCP/src/__tests__/api/health-profiles.test.ts` (new)

**Interfaces (produces):**

```ts
export interface BaselineProfile {
  name: string; path: string | null; sha256: string | null; timeout_seconds: number | null;
  sections_enabled: string[]; sections_without_checker: string[];
}
export interface ProfileCatalog { profiles: BaselineProfile[]; dir: string; dir_present: boolean }
/** The Python engine's section_map keys — replaced by `python3 -m xinas_menu.health --sections` in S19c. */
export const KNOWN_ENGINE_SECTIONS: readonly string[];
export function loadProfileCatalog(dir: string): ProfileCatalog;      // sync, at startup
export const SHIPPED_PROFILE_NAMES = ['quick', 'standard', 'deep'] as const;
```

Behavior: every `*.yml` whose basename matches `^[a-z0-9_-]{1,32}$` is parsed with `js-yaml` `load` (a parse failure is skipped with a warning to console and the name kept with `sha256: null`); `sections_enabled` = keys of `sections` whose `enabled === true`; `sections_without_checker` = those not in `KNOWN_ENGINE_SECTIONS` (`kerberos` today). A missing dir yields the three shipped names with `path: null` and `dir_present: false`, so the prompt's default argument keeps validating (spec §5.3 needs a catalog to validate against; an absent dir must not make `prompts/get` unusable).

- [ ] **Step 1: Write the failing test** — over `../healthcheck_profiles` (the repo dir, `resolve(here, '../../../../healthcheck_profiles')`): three profiles, `deep.sections_without_checker` equals `['kerberos']`, `standard.sections_enabled` contains `storage` and not `nvme_health`, `timeout_seconds` numbers, sha256 64 hex; over a tmp dir with `weird name.yml` (skipped), `custom.yml` (parsed), a broken YAML file (kept, `sha256: null`); over a missing dir → the three shipped names, `dir_present: false`.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(api): baseline profile catalog for the health prompt (S19b T2)`.

---

### Task 3: The prompt provider

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/prompts.ts`, `xiNAS-MCP/src/api/mcp/prompts/health-check.ts`
- Test: `xiNAS-MCP/src/__tests__/api/mcp-prompts.test.ts` (new)

**Interfaces (produces):**

```ts
// prompts.ts
export interface McpPromptArgument { name: string; description: string; required: boolean }
export interface McpPrompt { name: string; title: string; description: string; arguments: McpPromptArgument[] }
export interface PromptMessage { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }
export interface GetPromptBody { description: string; messages: PromptMessage[] }
export interface PromptCtx { identity: McpIdentity; correlationId: string }
export interface PromptProvider {
  list(ctx: PromptCtx): McpPrompt[];
  owns(name: string): boolean;
  get(name: string, args: Record<string, string>, ctx: PromptCtx): GetPromptBody;
}
export interface PromptsOptions { providers: PromptProvider[]; audit?: AuditSink }
export function listPrompts(opts: PromptsOptions, params: unknown, ctx: PromptCtx): { resultType: 'complete'; prompts: McpPrompt[]; ttlMs: 0; cacheScope: 'private' };
export function getPrompt(opts: PromptsOptions, params: unknown, ctx: PromptCtx): { resultType: 'complete' } & GetPromptBody;
export class PromptArgumentError extends McpProtocolError  // code -32602, data { argument, reason }
```

```ts
// prompts/health-check.ts
export const HEALTH_PROMPT_NAME = 'xinas_health_check';
export const HEALTH_PROMPT_VERSION = '1.0.0';
export const HEALTH_PROMPT_TEMPLATE: string;              // the docs "Prompt body" verbatim
export const REPORT_SCHEMA_VERSION = '1';
export function sha256Hex(text: string): string;
export interface HealthPromptDeps {
  body: string; version: string; policyVersion: string; catalogVersion: string; reportSchemaVersion: string;
  probePolicyMax: 'observe_only' | 'bounded_active'; limits: HealthPromptLimits;
  profileNames: () => string[];
  available: { context: boolean; baseline: boolean; probe_run: boolean; catalog: boolean; report_schema: boolean; validate: boolean };
}
export interface NormalizedArguments {
  scope: 'node' | 'service_path'; targets: string[] | null; baseline_profile: string;
  analysis_depth: 'triage' | 'standard';
  probe_policy: { requested: 'observe_only' | 'bounded_active'; effective: 'observe_only' | 'bounded_active'; reason?: string };
  time_window_seconds: number; symptom: string; language: string;
}
export function validateHealthPromptArguments(args: Record<string, string>, deps: Pick<HealthPromptDeps, 'probePolicyMax' | 'profileNames'>): NormalizedArguments;
export function createHealthPromptProvider(deps: HealthPromptDeps): PromptProvider;
```

- [ ] **Step 1: Write the failing tests** (the §5.3 table row by row; the parameters block is valid JSON between the two `---` marker lines; the symptom appears only inside `<user_symptom>…</user_symptom>` and C0 controls are stripped; `probe_policy: bounded_active` with max `observe_only` → effective `observe_only` with a reason; unknown argument → `PromptArgumentError` with `data.argument`; `listPrompts` with `cursor: 'x'` → -32602; `getPrompt` unknown name → -32602; the constant equals the docs body — `readFileSync(resolve(here, '../../../../docs/control-path/s19-mcp-health-prompt-template.md'))`, slice after the first `## Prompt body` line, trim, compare; one `user` message; `description` carries the version).
- [ ] **Step 2: RED**, **Step 3: Implement** (the validation table exactly as spec §5.3: `targets` = JSON array of 1–32 unique strings `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`; `time_window` ISO-8601 duration parsed by a small `parseIsoDuration()` supporting `P[nD]T[nH][nM][nS]`, bounded 300 s–604 800 s; `symptom` ≤ 2000 chars after stripping `/[ ---]/g`; `language` `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`), **Step 4: GREEN**, **Step 5: Commit** — `feat(mcp): xinas_health_check prompt provider (S19b T3)`.

---

### Task 4: Both eras, discovery, instructions, audit

**Files:**
- Modify: `modern.ts` (cases), `dispatch.ts` (`DispatcherOptions.prompts`, legacy handlers + capability), `discover.ts` (`DiscoverOptions.prompts`, capability, one INSTRUCTIONS sentence), `transport.ts` (install `ctx.healthPrompt.prompts` on both eras), `context.ts` (`healthPrompt?: HealthPromptContext`), `app.ts` (build it from config + profile catalog when `enabled`)
- Test: `mcp-discover.test.ts` (prompts row present/absent), `mcp-dispatch.test.ts` (modern `prompts/list`/`get` through `handleModernRequest`; -32601 without a provider), `mcp-integration.test.ts` (legacy `prompts/list` + `prompts/get` over the wire, `initialize` capabilities carry `prompts`), `contracts/mcp-schema.test.ts` (`ListPromptsResult` and `GetPromptResult` validate against the vendored schema), e2e stdio (if `src/__tests__/e2e/mcp-stdio*.test.ts` exists, one `prompts/get` round trip)

`HealthPromptContext = { config: ResolvedHealthPromptConfig; prompts: PromptsOptions; profiles: ProfileCatalog; templateSha256: string; ledger: RunLedger }` (the ledger arrives in Task 5; add the field there).

Audit: `prompts/get` queues `{ kind: 'mcp.prompts.get', principal, client_type: 'mcp', request_id: correlationId, parameters_hash: sha(canonical args minus symptom + symptom_sha256 + symptom_length), result_hash: sha(template_sha256), operation_id: correlationId, payload: { prompt, arguments: <normalized minus symptom>, symptom_length, symptom_sha256, prompt_version, template_sha256 } }` (spec §5.7).

INSTRUCTIONS gains: `'For a health diagnosis select the xinas_health_check prompt: it runs the rule-based checks and data-quality reads first, then the agentic analysis; active probes need a separate, confirmed permission and are never implied by a prompt argument.'`

- [ ] **Step 1: Write the failing tests**, **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN** (`npm run test:contracts` too), **Step 5: Commit** — `feat(mcp): serve prompts/list and prompts/get on both eras; advertise prompts iff installed (S19b T4)`.

---

### Task 5: Run ledger and `health.context`

**Files:**
- Create: `xiNAS-MCP/src/api/health/run-ledger.ts`, `xiNAS-MCP/src/api/health/context.ts`
- Modify: `routes/health.ts` (`GET /health/context`; `run_id` recording on `/health` and `/health/probe`; `probes_per_run`), `catalog.ts` (`health.context` read entry with `{ run_id?, targets? }`), `app.ts` (ledger + sweep on the S15 sweeper cadence or a `setInterval` unref'd)
- Test: `run-ledger.test.ts`, `routes-health-context.test.ts` (new), `routes-health-probe.test.ts` (budget), `routes-health.test.ts` (digest recorded)

**Interfaces (produces):**

```ts
export interface RunEntry { run_id: string; issued_at: number; expires_at: number; principal: string; role: string;
  versions: RunVersions; limits: HealthPromptLimits; probes_started: number;
  reports: Array<{ tool: string; args_digest: string; report_digest: string; collected_at: string }> }
export class RunLedger {
  constructor(deps: { now: () => number; ttlMs: number; maxEntries?: number /* 256 */ });
  mint(input: { principal; role; versions; limits }): RunEntry;
  get(runId: string): RunEntry | null;                       // null when unknown or expired
  record(runId, tool, args: unknown, result: unknown, collectedAt: string): boolean;  // false when unknown
  startProbe(runId: string, max: number): 'ok' | 'exhausted' | 'unknown';
  sweep(): number;
}
export function digestOf(value: unknown): string;   // sha256 over canonicalize(value)
```

`GET /health/context?run_id=&targets=a,b` → the §6.2 body: `run` (minted or re-read; `permitted.deterministic` lists `quick`, `standard`, and `deep` iff `rankOf(role) ≥ operator` and (`client_type === 'rest'` or `mcp.allow_apply`); `permitted.baseline: false` (S19c); `permitted.probe_run`: `denied` unless operator+; MCP without `allow_apply` → `denied`; MCP with → `confirmable`; REST → `allowed`; `apply: false`), `node` (hostname via `os.hostname()`, `controller_id`, `xinas_version: SERVER_INFO.version`, kernel/xiraid from the observed `inventory` row if present else null), `topology` (arrays with `member_disk_ids`, filesystems with `array_id` matched by `backing_device === array.status.volume_path`, shares with `filesystem_id` by longest mountpoint prefix, interfaces; every row with `revision` and `observed_at`), `declared_absent` (nfs: no desired Share AND `SystemdUnit/nfs-server.service` observed with `load_state: 'not-found'`; raid: collector `XiraidArray` running per the cached last probe AND zero rows — otherwise unknown, so absent only when proven), `collectors` (`tracker.currentState()`, plus the api's last standard probe if the health route cached one — add a small `lastProbe` cache on `ctx.healthPrompt` written by the `/health` route), `freshness` per observed kind, `baselines` from the profile catalog, `catalog: { version, tool: 'health.catalog' }`, `tools` from `CATALOG` filtered by `rankOf(role) ≥ min_role` with `escalation` echoed, `targets: { resolved, unknown }` against every observed/desired kind.

Ledger use: `/health` and `/health/probe` accept `run_id` (query / body); when the ledger knows it they `record(...)` the response `result` digest and add `run_id` to the response; unknown → `warnings: [RUN_UNKNOWN]` via the envelope's warnings list (`sendOk` supports warnings? read `handlers/reads.ts` — if not, add the warning inside the result as `run: { id, known: false }`; pick what the envelope supports). `/health/probe`: `startProbe(runId, limits.probes_per_run)` → `exhausted` → `PRECONDITION_FAILED` `probe_budget_exhausted`, before the confirmation consume.

- [ ] **Step 1: Write the failing tests** (ledger: mint/TTL/record/startProbe/sweep/max entries; context: viewer vs operator `permitted`, declared_absent proven only, topology links, freshness, baselines, targets resolution, re-read by run_id, expired run → new id; probe budget on the fifth call).
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(api): health.context with the in-memory run ledger; probes_per_run enforced (S19b T5)`.

---

### Task 6: Check catalog data and `GET /health/catalog`

**Files:**
- Create: `xiNAS-MCP/src/lib/health/agentic-catalog.json`, `xiNAS-MCP/src/lib/health/agentic-catalog.ts` (loader + `validateAgenticCatalog()`)
- Modify: `catalog.ts` (`health.catalog` read entry), `routes/health.ts` (`GET /health/catalog`)
- Test: `lib/health/agentic-catalog.test.ts` (every `mcp:*` input names a real check id from `QUICK_CHECKS`/standard/deep ids; every `baseline` input names a section+check present in a shipped profile; every row has `outcome_map`/`severity_map` covering its sources; `no_source` rows have empty `inputs`; HC-11 is `mandatory_for: ['service_path']` and `no_source`), `routes-health-context.test.ts` (`GET /health/catalog` returns the file with `version`)

Rows: exactly the §10.2 table, `version: "1"`. Keep `procedure`/`criterion` text short and cite the profile keys (`expectations.net_mtu`, …) rather than numbers.

- [ ] **Steps 1–5** as above; commit — `feat(health): versioned agentic check catalog served by GET /health/catalog (S19b T6)`.

---

### Task 7: Contracts and docs

**Files:**
- Modify: `docs/control-path/api-v1.yaml` (`/health/context`, `/health/catalog`, schemas `HealthContext`, `AgenticCheckCatalog`; `/health` and `/health/probe` gain the optional `run_id` and the `RUN_UNKNOWN` note), `docs/control-path/s19-mcp-health-prompt-spec.md` (Status: S19b implemented; deviations inline: §5.2 `ttlMs`, §6.2 `sections_without_checker` from `KNOWN_ENGINE_SECTIONS` until S19c, §6.2 `node.kernel`/`xiraid_version` sources, `declared_absent` rules as implemented), `s14-mcp-modern-era-spec.md` §4 (the `prompts` row: present iff installed), `adr/0010-clients-mcp-cli-tui.md` (preamble: prompts deferral lifted by S19b), `s8-clients-spec.md` §3 (context/catalog live), `CHANGELOG.md`, `docs/TODO.md` (remove the `probes_per_run` entry; add "Health — `sections_without_checker` uses a static section list until S19c"), `hardware-smoke-runbook.md` (prompts/get on a real client; `health.context`), `CLAUDE.md` (S19b live)
- [ ] **Step 1: Edit**, **Step 2: full gates**, **Step 3: Commit** (`docs(control-path): S19b implemented — prompt, context, catalog contracts and status`), **Step 4: Push + PR** into `release/3.14`.

---

## Self-review

- **Spec coverage:** §4.1–4.4 (Task 4), §5.1–5.7 (Tasks 3–4), §6.1–6.3 (Task 5), §9.5 `probes_per_run` (Task 5), §10 (Task 6), §12.1 (Task 1), §13 ranks for the two new reads (Tasks 5–6), §14 (Task 7), §15 rows for S19b (Tasks 1–6), §16 AC-12/AC-16/AC-17 (Task 4), AC-04 (Task 5 `declared_absent`).
- **Type consistency:** `HealthPromptLimits` (Task 1) is what the provider (Task 3) and the ledger (Task 5) carry; `ProfileCatalog` (Task 2) feeds both the validator (Task 3) and `health.context` (Task 5); `PromptsOptions` (Task 3) is what Task 4 installs; `RunLedger` (Task 5) is what Task 7's spec deviation notes describe.
- **Placeholders:** none.
