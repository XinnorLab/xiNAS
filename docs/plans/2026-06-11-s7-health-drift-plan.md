# S7 Health/Drift/Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real `quick`/`standard`/`deep` health profiles over the full ADR-0009 catalog, three desired-vs-observed drift checks surfaced in health AND `GET /config-history/drift`, and a redacted support bundle through the task envelope (WS9 + WS10 exit).

**Architecture:** api-side check engine (pure functions over KV facts) + one new enumerated agent RPC `health.probe {level, desired_nfs_profile?}` for standard facts and deep PID1-delegated probes; the bundle is an internal plan→apply→admit composite with two-sided contents (api stages DB-owned data; the agent collects host data, redacts, tars). No sandbox deltas.

**Tech Stack:** TypeScript (xiNAS-MCP, vitest), python (nfs-helper + pytest), the landed S2 engine/worker pool, fixture probe mode + file-backed fakes.

**Conventions (every task):** work in `xiNAS-MCP/` unless noted; TDD (failing test → run → implement → green); `.js` ESM suffixes; conditional spreads under `exactOptionalPropertyTypes`; stage exact paths; per-task HEREDOC commit ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; gate per task = named vitest files + `npx tsc --noEmit`; full gate at T8 (`npm test`, build, `test:e2e`, `test:contracts`, lint, `format:check`, markdownlint on touched docs, pytest for T1c).

---

### T0 — Contracts

**Files:** `docs/control-path/xinas-agent-s0s1-spec.md` (RPC table), `xiNAS-MCP/src/agent/collectors/base.ts` (Kind), `xiNAS-MCP/src/api/observed-schemas.ts` (OBSERVED_KINDS), `docs/control-path/api-v1.yaml` (GET /health description note).

- [ ] s0s1 RPC table: add `health.probe` as Real ("S7, ADR-0009 — read-style diagnostic; level standard|deep; carries the desired NfsProfile spec for the dry-render drift oracle").
- [ ] `Kind` union + `OBSERVED_KINDS` gain `'Tuning'` (internal singleton, NetworkConfig precedent).
- [ ] api-v1 `GET /health` description: profiles nest; standard/deep require the agent (probe-backed checks degrade with EXECUTOR_UNAVAILABLE when it is down).
- [ ] Gate (contracts + unit unchanged) + commit `feat(control-path): S7 T0 — contracts (health.probe enumeration, Tuning kind, profile semantics)`.

### T1 — Tuning probe + collector

**Files:** Create `xiNAS-MCP/src/agent/probe/tuning.ts`; modify `src/agent/collectors/` (new `tuning.ts` collector), `src/agent/convergence.ts`, `src/agent/probe/fixture.ts`; tests under `src/__tests__/agent/probe/tuning.test.ts` + collector test.

- [ ] Probe: parse `/etc/sysctl.d/*.conf` (k=v lines, last-wins across files sorted) for EXPECTED; read `/proc/sys/<key path>` for ACTUAL (injectable readdir/readFile). Output `{entries: [{key, expected, actual}]}`; no drop-ins → `{entries: []}`.
- [ ] Collector: singleton `Tuning/default` upsert on sweeps, compare-and-skip on content (the NetworkConfig pattern). Fixture passthrough `tuning.json`.
- [ ] Gate + commit `feat(agent): S7 T1 — Tuning observed singleton (drop-in expected vs /proc/sys actual)`.

### T1b — systemd observation promotion

**Files:** Modify `xiNAS-MCP/src/agent/probe/systemd.ts` (subprocess impl + allow-list additions), `src/agent/convergence.ts` (real wiring), `src/agent/probe/fixture.ts` (`systemd-units.json`); tests.

- [ ] `createSystemctlProbe({execFile?})`: per allow-listed unit run `systemctl show -p ActiveState,SubState,UnitFileState <unit>`; parse k=v; absent unit (`ActiveState=inactive` + `UnitFileState=` empty or non-zero exit) → row with `active_state: 'unknown'`-style facts, never a throw. Allow-list += `xinas-api.service`, `xinas-agent.service`.
- [ ] Convergence: replace the rejecting probe with the subprocess one (fixture mode reads `systemd-units.json` rows verbatim); the existing collector consumes it unchanged (its local probe interface: `allowList`, `getUnitState`, `subscribeAllowListed` no-op).
- [ ] Gate + commit `feat(agent): S7 T1b — real systemd unit observation via systemctl-show subprocess (dbus deferred)`.

### T1c — helper dry_run (python)

**Files:** `xiNAS-MCP/nfs-helper/nfs_profile.py`, `xiNAS-MCP/nfs-helper/nfs_helper.py` (op param), python tests beside the existing helper tests.

- [ ] `render_nfs_profile(..., dry_run=False)`: when true — render all four files IN MEMORY, return `{checksums, dry_run: true}`, write NOTHING, run NO systemctl. Tests: tmp tree byte-identical before/after; the recorded command runner saw zero calls; checksums equal a wet render's.
- [ ] Gate (`pytest` for the helper) + commit `feat(nfs-helper): S7 T1c — dry_run render (the drift oracle must not write)`.

### T2 — check engine + quick catalog

**Files:** Create `xiNAS-MCP/src/lib/health/engine.ts`, `src/lib/health/checks.ts`; test `src/__tests__/lib/health/checks.test.ts`.

- [ ] Engine types per spec §3 + `overallOf` (critical>degraded>warning>ok; skipped ignored; empty → ok).
- [ ] The 13 quick checks as pure functions over `HealthFacts` (shape per spec §3; built later in T6). Per-check tests: ok case + each trigger + skipped case (table-driven).
- [ ] Gate + commit `feat(lib): S7 T2 — health check engine + the quick catalog (13 checks)`.

### T3 — drift lib + checks

**Files:** Create `xiNAS-MCP/src/lib/health/drift.ts`; extend checks + tests.

- [ ] `compareExports(desiredShares, observedRules)` → `{missing, extra, changed}` (canonicalized options: sorted, host patterns normalized); drives `drift.nfs-exports`.
- [ ] `netplanDrift(desiredRows, xinasFileHash)` → reuse `renderNetplan` + sha256; drives `drift.netplan` (no desired rows → skipped; absent hash → skipped).
- [ ] `drift.nfs-conf` check shell: consumes `nfs_profile_render` from probe results vs observed `effective_files` (per-path compare); `skipped (requires standard)` in quick.
- [ ] Gate + commit `feat(lib): S7 T3 — drift comparisons (semantic exports, netplan hash, nfs-conf shell)`.

### T4 — health.probe RPC (standard)

**Files:** Create `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` (+ license parse in `src/lib/parse/xicli-license.ts`); modify agent dispatcher registration, `src/agent/task/nfs-helper-client.ts` (dry-render call); tests.

- [ ] `parseXicliLicense(text)` → `{status, days_left, features}` (goldens: active/expired/absent shapes); PARSED ONLY ever leaves the agent.
- [ ] Handler: assemble `{license, rdma_links, collectors, nfs_profile_render}` per spec §4, each section try/caught; `desired_nfs_profile` null → render section null. Registered as enumerated method; level validated.
- [ ] Gate + commit `feat(agent): S7 T4 — health.probe RPC (parsed license, fresh rdma, collectors, dry-render checksums)`.

### T5 — ProbeHost + deep probes

**Files:** Create `xiNAS-MCP/src/agent/health/probe-host.ts` + `fake-probe-host.ts`; extend the RPC handler; tests.

- [ ] `ProbeHost`: `touchProbe(mountpoint)` (write/read/delete `.xinas-health-probe`), `loopbackMount(exportPath)` (`systemd-mount localhost:<path> /run/xinas/health-probe/mnt` → list → `systemd-umount`, `finally`-unmounted). Fake: file-backed, `-fail` stem hooks.
- [ ] `level=deep` runs probes over mounted managed filesystems (from the fs collector's snapshot via the existing probe) + the first observed export (carried in params? — exports come from the api in `params.first_export_path` to keep the agent KV-free; null → loopback skipped).
- [ ] Gate + commit `feat(agent): S7 T5 — deep probes (fs touch, PID1 loopback mount) behind ProbeHost`.

### T6 — GET /health + /config-history/drift integration

**Files:** Modify `xiNAS-MCP/src/api/routes/health.ts`, `src/api/routes/config-history.ts`; add `src/api/handlers/health-facts.ts` (KV facts gatherer); the api→agent probe call via the existing `AgentRpcClient`; route tests.

- [ ] Facts gatherer (one KV pass) + quick path; standard/deep call `health.probe` (timeout 5s/20s; carries desired profile spec + first export path); agent down → probe-backed checks degraded `EXECUTOR_UNAVAILABLE`, KV checks intact.
- [ ] `GET /config-history/drift` → same engine's drift checks: `{drift: [{artifact, status, evidence, recommended_action}]}` + `nfs-conf` `not_evaluated` entry.
- [ ] Gate + commit `feat(api): S7 T6 — health profiles live + drift in the config-history API`.

### T7 — support bundle

**Files:** Create `xiNAS-MCP/src/api/plan/providers/support.ts`, `src/agent/support/bundle-host.ts` + `fake-bundle-host.ts`, `src/agent/task/support-executor.ts`; modify `src/api/routes/support.ts`, `src/api/tasks/build.ts`, `src/agent/task/wiring.ts`, `src/api/app.ts` (stub exclusions POST `/support-bundle`); tests incl. the redaction suite.

- [ ] Provider: blockers none; `risk non_disruptive`; `affected_resources: []`; `lease_resources [{SupportBundle,default}]`; enriched spec `{task staging path, journal units, retention: 3}`.
- [ ] Route POST: stage `bundles/<plan task_id>.api.json`... staging needs the APPLY task id — stage AFTER apply (task id known), BEFORE dispatch: plan → apply (queued) → write staging file → admitAndDispatch. GET: stream `/var/log/xinas/bundles/<task_id>.tar.gz` (404 until success).
- [ ] Executor stages per spec §6 (BundleHost verbs: `journalTail(unit, lines)`, `readConfig(path)`, `xicliJson(args)`, `snapshotIndex()`, `writeWorkFile`, `tar`, `chgrpBundle`, `prune`); redaction inline (`scrubSecrets(text)` in `src/lib/health/redact.ts`: Bearer/Authorization + seeded patterns); verify stage greps the archive list + content for leak patterns.
- [ ] Redaction test: seed fake journals/configs with tokens + a raw license blob → archive contains none.
- [ ] Gate + commit `feat(control-path): S7 T7 — support bundle (two-sided, redacted, lease-serialized)`.

### T8 — e2e + full gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/health-support.test.ts` (clone the S6 harness boot; fixtures: net-host-state, fs-host-state, xiraid-state, systemd-units.json, tuning.json, nfs fixtures, desired seeds via internal/api).

- [ ] Scenarios per spec §7 (baseline ok + empty drift; drift trio incl. /config-history/drift; standard license warning via a fake xicli seam — fixture file `xicli-license.txt`; deep fake probes incl. one `-fail`; agent-down degradation via SIGSTOP; bundle 202→success→stream + redaction + serialize + retention).
- [ ] Full verification gate; append the loopback-probe + xiRAID-unit-names items to `docs/control-path/hardware-smoke-runbook.md` (§5a).
- [ ] Commit `test(e2e): S7 T8 — health/drift/support end-to-end + runbook additions`.
