# S19c — Baseline adapter, report schema and validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the Python baseline engine as the read-only `health.baseline` adapter, ship the report schema and the deterministic `health.report.validate` verdict over the run ledger, and make the engine report sections it cannot check — slice c of S19 (spec §1 "S19c").

**Architecture:** One new enumerated agent RPC, `health.baseline`, runs `python3 -m xinas_menu.health <profile> <log_dir> --json --no-save` as a capped, sandboxed subprocess through a `BaselineHost` (realpath allow-list, sanitized env, process-group SIGKILL, output caps, one run at a time shared by concurrent callers) and also answers the engine's `--sections` list. The api's `GET /health/baseline` resolves the profile from the startup catalog, caps the timeout, caches the last successful result per profile with its `collected_at`, records the digest in the run ledger and never fails when the agent is down. `lib/health/agentic-report.schema.json` (JSON Schema 2020-12) is served by `GET /health/report-schema` and used by a pure validator (`lib/health/report-validate.ts`: Ajv shape check, reference check, the §11.3 verdict from the catalog's mandatory rows); `POST /health/report/validate` adds ledger integrity (`verified` / `mismatch` / `unverifiable`). The Python engine gains `SUPPORTED_SECTIONS`, `--sections` and a SKIP `checker` row for enabled sections without a checker (AC-06, G-03).

**Tech Stack:** TypeScript (Node ≥ 20), `ajv` + `ajv-formats` (moved to runtime dependencies together with `js-yaml`), `node:child_process.spawn`, vitest, supertest; Python 3 (`xinas_menu.health.engine`), pytest.

**Spec:** `docs/control-path/s19-mcp-health-prompt-spec.md` §8, §11, §12.2, §13, §14, §15, §16, §17; ADR-0018 §3 (D-09, D-12, D-13); ADR-0002 (enumerated agent methods).

## Global Constraints

- Every commit touching `xiNAS-MCP/src/` carries `Requires-Rebuild: xinas_node_build`; the Python change is code-only (no trailer); Conventional Commits; English only; `--merge` on the PR.
- `lib/` imports nothing from `agent/` or `api/`; `api/` never imports `agent/*`.
- The agent never runs an arbitrary file: `profile_path` must realpath-resolve inside `health_baseline.profiles_dir` (spec §8.3).
- The engine runs with `--no-save` only; the adapter mutates nothing (F-05, SAFE-03).
- `health.baseline` answers when the agent is down, with the collection status saying so (SAFE-04); a truncated run is `timeout`, never a partial report presented as complete.
- The verdict is computed by the validator, never trusted from the report (REPORT-03, D-12); a raw report edited by the model is `mismatch` (AC-19).
- Additive `api-v1.yaml` only.
- Verification gate before "done": TypeScript trio, `npm test`, `npm run test:contracts`, `npm run build && npm run test:e2e`, `pytest --cov=xinas_history --cov-fail-under=20`, `ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper`, `ruff format --check .`, `pyright` (venv), yamllint, spectral, markdownlint.

---

## File structure

| Path | Responsibility |
|---|---|
| `xiNAS-MCP/package.json` | `ajv`, `ajv-formats`, `js-yaml` become runtime dependencies (the api imports them) |
| `xiNAS-MCP/src/agent/config.ts` | `health_baseline` block with the §12.2 defaults; absolute-path validation |
| `xinas_menu/health/engine.py` | `SUPPORTED_SECTIONS`, `--sections`, the SKIP `checker` row |
| `tests/test_health_engine_sections.py` (new) | pins both Python changes |
| `xiNAS-MCP/src/agent/health/baseline-host.ts` (new) | `BaselineHost`: allow-list, sandboxed spawn, caps, timeout kill, shared in-flight run, `--sections` |
| `xiNAS-MCP/src/agent/rpc/methods/health-baseline.ts` (new) | the `health.baseline` RPC handler (param validation, result shape) |
| `xiNAS-MCP/src/agent-server.ts` | registers `health.baseline` |
| `xiNAS-MCP/src/api/health/baseline.ts` (new) | profile resolution, timeout cap, cache, `sections_without_checker` from the live list |
| `xiNAS-MCP/src/api/health/prompt-context.ts` | `baselineCache`, `engineSections` on the context |
| `xiNAS-MCP/src/api/routes/health.ts` | `GET /health/baseline`, `GET /health/report-schema`, `POST /health/report/validate` |
| `xiNAS-MCP/src/api/mcp/catalog.ts` | the three entries (§13) |
| `xiNAS-MCP/src/lib/health/agentic-report.schema.json` (new) + `report-validate.ts` (new) | the report contract and the pure validator |
| `xiNAS-MCP/src/api/health/report-integrity.ts` (new) | ledger integrity for `raw_reports` |
| `docs/control-path/api-v1.yaml`, spec, agent spec RPC table, S8 §3, ADR-0010/0018, CHANGELOG, TODO, runbook, CLAUDE.md | contracts and status |

Commands run from `xiNAS-MCP/` unless a path says otherwise.

---

### Task 1: Runtime dependencies and the agent `health_baseline` config block

**Files:**
- Modify: `xiNAS-MCP/package.json` (+ lock), `xiNAS-MCP/src/agent/config.ts`
- Test: `xiNAS-MCP/src/__tests__/agent/config-health-baseline.test.ts` (new)

**Interfaces (produces):**

```ts
export interface HealthBaselineConfig { python: string; module_root: string; log_dir: string; profiles_dir: string }
export const HEALTH_BASELINE_DEFAULTS: HealthBaselineConfig; // /opt/xiNAS/venv/bin/python3, /opt/xiNAS, /var/log/xinas/healthcheck, /opt/xiNAS/healthcheck_profiles
export interface AgentConfig { …; health_baseline: HealthBaselineConfig }
export function resolveHealthBaselineConfig(raw: unknown): HealthBaselineConfig; // throws naming the key on a non-absolute path or unknown key
```

- [ ] **Step 1: Write the failing test** — defaults when the file has no block; per-key override; `relative/python` → throws `/health_baseline.python/`; unknown key → throws naming it.
- [ ] **Step 2: RED**, **Step 3: Implement** (`loadAgentConfig` calls `resolveHealthBaselineConfig(file.health_baseline)`; `inline` configs default too), **Step 4: GREEN** + `npm run typecheck`.
- [ ] **Step 5:** `npm install --save --prefer-offline ajv ajv-formats js-yaml` (moves them out of devDependencies; the lock's `dev` flags follow); `npm ls ajv js-yaml` shows them under dependencies.
- [ ] **Step 6: Commit** — `feat(agent): health_baseline config block; ajv and js-yaml become runtime dependencies (S19c T1)` with the trailer.

---

### Task 2: Python engine — `SUPPORTED_SECTIONS`, `--sections`, the SKIP checker row

**Files:**
- Modify: `xinas_menu/health/engine.py`
- Test: `tests/test_health_engine_sections.py` (new)

**Interfaces (produces):**

```python
SUPPORTED_SECTIONS: tuple[str, ...]   # the section_map keys, module level
# python3 -m xinas_menu.health --sections  → stdout JSON {"sections": [...], "version": XINAS_MENU_VERSION}, exit 0, no profile needed
# an enabled YAML section absent from section_map → CheckResult(section, "checker", "SKIP", "not supported by this engine", "N/A", evidence="section has no checker")
```

- [ ] **Step 1: Write the failing tests** — `--sections` (monkeypatch `sys.argv`, capture stdout, `json.loads`, equals `list(SUPPORTED_SECTIONS)`, contains `nvme_health`, not `kerberos`); a temp profile with `kerberos: { enabled: true, checks: [krb5_conf] }` and every checker monkeypatched to return `[]` → the JSON report's `checks` contains exactly one row `{ section: 'kerberos', name: 'checker', status: 'SKIP', actual: 'not supported by this engine' }` and `summary.skip == 1`; a disabled unknown section produces no row.
- [ ] **Step 2: RED** (`pytest tests/test_health_engine_sections.py`), **Step 3: Implement** (module-level `SUPPORTED_SECTIONS`; `main()` handles `--sections` before the usage check; after the checker loop, iterate `sections` for enabled names not in `section_map`), **Step 4: GREEN** + `ruff check xinas_menu` + `ruff format --check .` + `pyright --pythonpath .venv/bin/python xinas_menu`.
- [ ] **Step 5: Commit** — `feat(health): engine reports enabled sections without a checker; --sections lists the supported ones (S19c T2)` (no trailer: Python only).

---

### Task 3: The agent `health.baseline` RPC

**Files:**
- Create: `xiNAS-MCP/src/agent/health/baseline-host.ts`, `xiNAS-MCP/src/agent/rpc/methods/health-baseline.ts`
- Modify: `xiNAS-MCP/src/agent-server.ts`, `xiNAS-MCP/src/agent/rpc/dispatch.ts` (no change expected: `INVALID_PARAMS` already maps to -32602)
- Test: `xiNAS-MCP/src/__tests__/agent/health/baseline-host.test.ts`, `xiNAS-MCP/src/__tests__/agent/rpc/health-baseline.test.ts` (new)

**Interfaces (produces):**

```ts
// baseline-host.ts
export interface BaselineRunResult {
  status: 'success' | 'error' | 'timeout' | 'not_supported';
  collected_at: string; duration_ms: number;
  engine: { module: 'xinas_menu.health.engine'; version: string | null };
  report: Record<string, unknown> | null;
  stderr_tail: string;
  error?: { code: 'TIMEOUT' | `EXIT_${number}` | 'PARSE' | 'ENOENT' | 'OUTSIDE_PROFILES_DIR' | 'KILLED'; message: string };
}
export interface BaselineSections { status: 'success' | 'error' | 'not_supported'; sections: string[] | null; version: string | null; error?: {…} }
export interface BaselineHost {
  run(profilePath: string, timeoutMs: number): Promise<BaselineRunResult>;   // realpath allow-list; concurrent callers share the in-flight run
  sections(timeoutMs: number): Promise<BaselineSections>;                  // --sections, cached after the first success
}
export function makeBaselineHost(config: HealthBaselineConfig, deps?: { spawn?: typeof spawn; now?: () => number }): BaselineHost;
// health-baseline.ts — params { profile_path: string, timeout_s: 1..900 } | { sections: true }
export function makeHealthBaselineHandler(deps: { host: BaselineHost }): (params: unknown) => Promise<BaselineRunResult | BaselineSections>;
```

Sandbox (spec §8.3): `spawn(python, ['-m', 'xinas_menu.health', profilePath, log_dir, '--json', '--no-save'], { cwd: module_root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONPATH: module_root }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })`; stdout capped at 4 MiB and stderr at 64 KiB (excess dropped, `stderr_tail` = last 4 KiB); at `timeoutMs` `process.kill(-pid, 'SIGKILL')` → `timeout`/`TIMEOUT`; spawn `ENOENT` → `not_supported`/`ENOENT`; exit ≠ 0 → `error`/`EXIT_<n>` (stderr containing `No module named` → `not_supported`); stdout not JSON → `error`/`PARSE`; success → the parsed object. Version: from the cached `--sections` answer when known, else null.

- [ ] **Step 1: Write the failing tests** with a real stub interpreter (a `#!/bin/sh` script in a tmp dir; `python` config points at it): prints canned JSON → success + report; prints the sanitized env (`env | sort`) → only `PATH`, `LANG`, `PYTHONPATH`, `PWD`-class keys present, no `HOME`/`XINAS_*`; `sleep 5` with 300 ms timeout → `timeout` within 1 s and the process is gone; exit 3 → `EXIT_3`; non-JSON → `PARSE`; a huge stdout (> 4 MiB) → `PARSE` with the cap noted; a missing interpreter path → `not_supported`/`ENOENT`; a profile path outside `profiles_dir` (and a symlink inside pointing outside) → rejected before spawn (`OUTSIDE_PROFILES_DIR`); two concurrent `run()` calls spawn once and get the same result; `sections()` parses `{"sections":[…],"version":"…"}` and is cached. Handler tests: param validation (`INVALID_PARAMS`), `sections: true` path.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(agent): health.baseline RPC runs the Python engine as a capped read-only subprocess (S19c T3)` with the trailer.

---

### Task 4: `GET /health/baseline` with cache, ledger and the live section list

**Files:**
- Create: `xiNAS-MCP/src/api/health/baseline.ts`
- Modify: `prompt-context.ts` (`baselineCache: Map<string, BaselineCacheEntry>`, `engineSections: { sections: string[]; version: string | null } | null`), `routes/health.ts`, `catalog.ts` (`health.baseline` read entry, input `{ profile?, max_age_s?, run_id? }`), `profiles.ts` (`sectionsWithoutChecker(profile, known)` helper), `context.ts` (`baselines.sections_source: 'engine' | 'static'`)
- Test: `xiNAS-MCP/src/__tests__/api/routes-health-baseline.test.ts` (new), `routes-health-context.test.ts` (sections_source)

Behavior (spec §8.4): unknown profile → `INVALID_ARGUMENT` naming the known names; `max_age_s` 0..3600; timeout = `min(profile.timeout_seconds ?? cap, cap)` with `cap = config.baseline.timeout_s[name] ?? timeout_s.standard`; cache hit (`max_age_s > 0`, entry younger) → `from_cache: true`, original `collected_at`, `age_s`; before the run, the first call fetches `health.baseline { sections: true }` once and stores `engineSections` (failure → stays `null`, static list); agent client absent or RPC error → 200 with `collection.status: 'error'`, `error.code: 'EXECUTOR_UNAVAILABLE'`, `report: null`; `run_id` known → `ledger.record(runId, 'health.baseline', { profile, max_age_s }, result, collected_at)`; unknown → `RUN_UNKNOWN` warning. Response body per §8.4 plus `run_id`. `health.context.baselines` recomputes `sections_without_checker` from `engineSections` when known and says `sections_source`.

- [ ] **Step 1: Write the failing tests** (mock agent `respondToRpc('health.baseline', …)` answering `sections` and runs; cache; timeout cap; unavailable; ledger; unknown profile 400; `max_age_s` 5000 → 400).
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(api): health.baseline route with per-profile cache, run ledger and the engine's section list (S19c T4)` with the trailer.

---

### Task 5: Report schema and the pure validator

**Files:**
- Create: `xiNAS-MCP/src/lib/health/agentic-report.schema.json`, `xiNAS-MCP/src/lib/health/report-validate.ts`
- Test: `xiNAS-MCP/src/__tests__/lib/health/report-validate.test.ts` (new)

**Interfaces (produces):**

```ts
export const REPORT_SCHEMA: Record<string, unknown>;          // the JSON file, read at module load (copied to dist by copy-assets)
export interface SchemaError { path: string; message: string }
export interface ReferenceError { path: string; ref: string; message: string }
export interface Computed { health_status: 'ok'|'warning'|'degraded'|'critical'|'unknown'; coverage_status: 'complete'|'partial'|'none' }
export interface ShapeVerdict { schema_errors: SchemaError[]; reference_errors: ReferenceError[]; computed: Computed | null; status_errors: string[]; mandatory_ids: string[] }
export function validateReportShape(report: unknown, catalog: AgenticCatalog): ShapeVerdict;
export function computeVerdict(checks: ReportCheck[], mandatoryIds: Set<string>, declaredAbsent: string[], scopeKind: Scope): Computed; // §11.3 steps 1–3
```

Rules: schema via Ajv 2020 + formats (`strict: false`); references: every `findings[].evidence_refs[]` and `checks[].evidence_refs[]` must be an `evidence_manifest[].id`, every `findings[].check_ids[]` a `checks[].id`, every `checks[].id` a catalog row, `not_checked[].check_id` a catalog row; mandatory rows = catalog rows whose `mandatory_for` includes `scope.kind`; a report `checks[].mandatory` flag that disagrees with the catalog → status error; `not_applicable` without a `reason` citing a `declared_absent` component (`scope.declared_absent[]`, or the words `declared absent` / `out of scope`) → rewritten to `unknown` before the verdict; `run_status` failed/cancelled with `health_status: ok` → status error; `health_status` / `coverage_status` must equal computed.

- [ ] **Step 1: Write the failing tests** — a minimal valid report fixture builder; schema error paths; each verdict row (`critical` fail → critical; plain fail → degraded; warn → warning; complete + all pass → ok; missing mandatory → partial + unknown; no mandatory → none); the not_applicable rewrite; reference errors; status mismatch; run_status conflict.
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(health): agentic report schema v1 and the deterministic report validator (S19c T5)` with the trailer.

---

### Task 6: `GET /health/report-schema`, `POST /health/report/validate` with ledger integrity

**Files:**
- Create: `xiNAS-MCP/src/api/health/report-integrity.ts`
- Modify: `routes/health.ts`, `catalog.ts` (`health.report_schema` read; `health.report.validate` direct POST, viewer, `requires_mcp_apply: false`, input `additionalProperties: true`)
- Test: `xiNAS-MCP/src/__tests__/api/routes-health-report.test.ts` (new), `mcp-catalog.test.ts` / `mcp-dispatch.test.ts` (the direct entry passes the gate without allow_apply)

Integrity (spec §11.4): for each `raw_reports[i]` with `run_id` = the report's `run.run_id`: find the ledger entry; a report from a ledger-writing tool (`health.check`, `health.baseline`, `health.probe.run`) must match a ledger row by `tool` and `args_digest` and `digest === row.report_digest` and `digestOf(report) === digest` → else `mismatch` with `{ raw_report_index, expected_digest, actual_digest }`; other tools are skipped; run unknown/expired → `unverifiable`; every checked row ok → `verified`. Response §11.2 plus `report_sha256`; `valid` iff no schema/reference/status errors and integrity ≠ mismatch. Body limit: the api's 1 MB JSON limit applies (documented).

- [ ] **Step 1: Write the failing tests** — schema served with `report_schema_version: "1"`; mint a run, take `GET /health?run_id=`, embed it as a raw report → `verified`; edit a check status inside the raw report → `mismatch` (AC-19); unknown run → `unverifiable` and still valid; malformed body → 200 with `valid: false` and schema errors; a viewer over the mock MCP client path (`X-Xinas-Forwarded-*`) is allowed (rank viewer, no apply gate).
- [ ] **Step 2: RED**, **Step 3: Implement**, **Step 4: GREEN**, **Step 5: Commit** — `feat(api): health.report_schema and health.report.validate with run-ledger integrity (S19c T6)` with the trailer.

---

### Task 7: End to end

**Files:**
- Modify: `xiNAS-MCP/src/__tests__/e2e/health-support.test.ts` (agent config gains `health_baseline` pointing `python` at a stub `sh` script in the tmp dir; new cases 4c/4d)

- [ ] **Step 1:** case 4c — `GET /health/baseline?profile=quick` returns the stub's canned report with `collection.status: success`, `profile.sections_without_checker` from the stub's `--sections`; a second call with `max_age_s=600` is `from_cache: true`; case 4d — `GET /health/report-schema` 200; `POST /health/report/validate` with a report built from `GET /health?run_id=` → `verified`; then with `health_baseline.python` pointed at a missing path (second agent config? keep one: the stub script itself exits with `ENOENT`-like behavior is not possible — instead assert the api-side `EXECUTOR_UNAVAILABLE` under SIGSTOP in case 5). Extend case 5: `GET /health/context` while the agent is stopped → `collectors.heartbeat: offline`, 200 (AC-18).
- [ ] **Step 2:** `npm run build && npm run test:e2e` green. **Step 3: Commit** — `test(e2e): health.baseline through a stub engine; context and validator round trips (S19c T7)`.

---

### Task 8: Contracts and docs

- Modify: `docs/control-path/api-v1.yaml` (`/health/baseline`, `/health/report-schema`, `/health/report/validate`; schemas `HealthBaselineResult`, `AgenticReportValidation`; `HealthContext.baselines.sections_source`), `s19-mcp-health-prompt-spec.md` (Status: S19c implemented; deviations: §8.3 `--sections` through the same RPC and its JSON object, `OUTSIDE_PROFILES_DIR`/`KILLED` codes; §8.4 `sections_source`, lazy engine list; §11.2 `report_sha256`, body limit; §11.5 the http audit row carries `report_sha256`; §12.2 validation), `xinas-agent-s0s1-spec.md` (RPC table row), `s8-clients-spec.md` §3, `adr/0010` preamble, `adr/0018` status, `CHANGELOG.md`, `docs/TODO.md` (remove the static-section-list entry; keep the field-sources entry), `hardware-smoke-runbook.md`, `CLAUDE.md` (S19c live; S19d design only), `collection/roles/xinas_agent/templates/xinas-agent-config.json.j2` unchanged (defaults in code) — note in the spec.
- [ ] **Step 1: Edit**, **Step 2: full gates** (TypeScript, Python, yaml, spectral, markdown), **Step 3: Commit** (`docs(control-path): S19c implemented — baseline adapter, report schema and validator`), **Step 4: Push + PR** into `release/3.14`.

---

## Self-review

- **Spec coverage:** §8.1–8.5 (T2–T4), §11.1–11.5 (T5–T6), §12.2 (T1), §13 the three rows (T4, T6), §14 (T8), §15 rows `health-baseline (agent)`, `report-validate`, e2e, Python (T3, T5, T7, T2), §16 AC-01/02/06/18/19 (T5, T6, T2, T7), §17 nothing new.
- **Type consistency:** `HealthBaselineConfig` (T1) is what `makeBaselineHost` (T3) takes; `BaselineRunResult` (T3) is what the api route (T4) reshapes; `AgenticCatalog` (S19b) feeds `validateReportShape` (T5); `RunLedger.record`/`digestOf` (S19b) are what `report-integrity.ts` (T6) compares.
- **Placeholders:** none.
