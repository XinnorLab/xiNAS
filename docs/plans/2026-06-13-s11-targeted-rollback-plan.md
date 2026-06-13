# S11 Targeted Snapshot Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `config.rollback` can restore an arbitrary *restorable* snapshot (not just `baseline`): snapshots capture a live NFS/network config-file payload, and a new file-level runner verb restores it as an **observed recovery** (desired KV untouched, drift surfaced). Contract: ADR-0013 + `docs/control-path/s11-targeted-rollback-spec.md`.

**Architecture:** Two parts. **Part 1 (capture):** `ConfigCollector.collect_system_files()` reads the live `CHECKSUM_TARGETS` bytes; `store` gains a `system/` payload; `engine.create_snapshot` stores it + computes `files_changed` (vs parent). **Part 2 (restore):** `runner.execute_restore_snapshot` computes the restore set as **current-vs-target** (re-checksum live vs the target's captured `Checksums`), writes the differing files, reconverges only affected domains, with a file-level auto-rollback; surfaced through the S9 `config.rollback` provider/executor/route/bridge/CLI + a TUI Restore action.

**Tech stack:** Python (`xinas_history`, pytest), TS (xiNAS-MCP, vitest), Textual TUI (xinas_menu, pytest), api-v1.yaml.

**Conventions (every task):** TDD; `.js` ESM suffixes; conditional spreads (exactOptionalPropertyTypes); per-task HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; per-task gate = named tests + (TS) `npx tsc --noEmit`; **no `Requires-Rebuild` trailer** (the capture change is `xinas_history` library code delivered by `git pull` + helper restart, not a role/unit change). Full gate at T9.

---

### T0 — Contracts

- [ ] `api-v1.yaml`: the `config.rollback` request `to` description widens from the `baseline` literal to `baseline` or a snapshot-id string (string; add an example `"20260601T120000Z-share-create"`). Add `ConfigSnapshot.restorable: { type: boolean }` (additive, optional). `ConfigSnapshot.files_changed` already exists — no schema change, now populated.
- [ ] ADR-0011 §Rollback: append a one-line pointer note "Targeted rollback implemented in S11 (ADR-0013)."
- [ ] Verify HERE: `npx @stoplight/spectral-cli lint docs/control-path/api-v1.yaml` (0 errors) + `oasdiff breaking` vs main is additive (0 errors).
- [ ] Commit `feat(control-path): S11 T0 — contracts (rollback to:<id>, ConfigSnapshot.restorable)`.

### T1 — Capture: system_files payload (python)

**Files:** modify `xinas_history/collector.py`, `xinas_history/store.py`; test `tests/test_system_files_payload.py` (new).

- [ ] `collector.py`: add `SYSTEM_FILE_PATHS: dict[str, str]` = the inverse of `CHECKSUM_TARGETS` (logical name → live path, e.g. `{'etc_exports': '/etc/exports', 'netplan': '/etc/netplan/99-xinas.yaml', …}` — same 8 keys). Add `ConfigCollector.collect_system_files() -> dict[str, bytes]`: for each `(name, path)` in `SYSTEM_FILE_PATHS`, `read_bytes()`; on `OSError` (absent) **skip** (omit, do not store empty). Mirrors `collect()`.
- [ ] `store.py`: add `SYSTEM_DIR = "system"`. `write_snapshot(..., system_files: dict[str, bytes] | None = None)` — after the `runtime_files` block, write `system/<name>` for each (same `_DIR_MODE` mkdir + `_write_bytes`). Add `read_system_file(snapshot_id, filename) -> bytes | None` (mirrors `read_runtime_file`, under `SYSTEM_DIR`) and `list_system_files(snapshot_id) -> list[str]` (the captured names; `[]` if no `system/` dir). Keep `system_files` defaulted so existing callers are unaffected.
- [ ] Failing tests: `collect_system_files` reads present files + omits absent (point it at a tmp dir via a `SYSTEM_FILE_PATHS` monkeypatch); store round-trip writes+reads `system/`; `list_system_files` returns `[]` for a snapshot written without the payload (pre-S11 shape).
- [ ] Run `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_system_files_payload.py -q` → pass.
- [ ] Commit `feat(xinas_history): S11 T1 — collect_system_files + store system/ payload`.

### T2 — Capture wiring: create_snapshot stores payload + files_changed (python)

**Files:** modify `xinas_history/engine.py`, `xinas_history/models.py`; test `tests/test_snapshot_files_changed.py` (new).

- [ ] `models.py`: `Manifest` already has `files_changed`? It does NOT — add `files_changed: list[str] = field(default_factory=list)` to the dataclass + `to_dict()` (include only when non-empty) + `from_dict()` (`list(data.get("files_changed", []))`). Add a `restorable` derivation helper is NOT needed on the manifest (the store reports it); keep the manifest lean.
- [ ] `engine.py` `create_snapshot` (and `create_baseline`): call `self._config_collector.collect_system_files()` and pass `system_files=` to `write_snapshot`. Compute `files_changed`: read the parent manifest's `checksums` (when `parent_id` is set), compare each `Checksums` field to the new `checksums`; `files_changed` = the logical names that differ (or are newly present/absent). For baseline / no-parent → `[]`. Set `manifest.files_changed` before `write_snapshot`.
- [ ] Failing tests: a snapshot with a parent whose `etc_exports` checksum differs → `files_changed == ['etc_exports']`; baseline → `[]`; the `system/` payload is present after create (assert `store.list_system_files(id)` non-empty). Use a fake collector/runtime-collector returning deterministic bytes + checksums.
- [ ] Run pytest → pass.
- [ ] Commit `feat(xinas_history): S11 T2 — create_snapshot stores system payload + files_changed`.

### T3 — Restore: execute_restore_snapshot + CLI (python)

**Files:** modify `xinas_history/runner.py`, `xinas_history/__main__.py`; test `tests/test_execute_restore_snapshot.py` (new), `tests/test_snapshot_restore_cli.py` (new).

- [ ] `runner.py`: add `async def execute_restore_snapshot(self, snapshot_id, source, reason, progress_cb=None) -> RunResult`. Sequence (mirror `execute_reset_to_baseline`'s transactional shape — lock → preflight → pre-change ephemeral → apply → validate → mark → release):
  1. `target = self._store.read_manifest(snapshot_id)`; `None` → `RunResult(success=False, error="snapshot_not_found")`.
  2. `captured = self._store.list_system_files(snapshot_id)`; empty → `RunResult(success=False, error="no_restorable_payload")`.
  3. classify via `self._classifier.classify_rollback(current, target)` (`current` = `self._engine.get_current_effective()`; tolerate `None`).
  4. **restore set (current-vs-target):** re-checksum the live `SYSTEM_FILE_PATHS` (reuse the runtime collector's `collect_checksums()` or a small `_sha256_file`), compare to `target.checksums`; `restore_set` = captured names whose live checksum ≠ the target's stored checksum. Empty → success no-op (`RunResult(success=True, snapshot_id=…, ...)`, message "already at target").
  5. acquire lock; create the **pre-change ephemeral** (captures `system/` via T2) and remember its id.
  6. **apply:** for `name in restore_set`: write `self._store.read_system_file(snapshot_id, name)` to `SYSTEM_FILE_PATHS[name]`; collect the affected domains via `_domain_of(name)` (`nfs`|`network`). Call `self._reconverge(domains)`.
  7. **validate** (injectable seam, default best-effort): services active / `netplan get` parses. Fail → `self._restore_rollback(pre_change_id, restore_set)` (write the ephemeral's `system/` bytes back + reconverge), mark `failed`/`partial`, return.
  8. mark applied; release lock; `RunResult(success=True, …)`.
- [ ] Add `_reconverge(self, domains: set[str])` and `_domain_of(name) -> str` + `_restore_rollback(...)` private helpers. Reconverge commands run through the existing command-runner seam (`_run_ansible_playbook` uses one — reuse the same injectable subprocess runner so tests fake them): nfs → `exportfs -ra` (+ `systemctl restart nfs-server`/`nfs-idmapd` per file); network → flush PBR 100–199 + flush mlx IPs + `netplan apply`. **Do NOT** call `_auto_rollback` (it re-runs Ansible).
- [ ] `__main__.py`: add the `snapshot restore <id>` subparser (`--reason`, `--source`, `--yes`, `--format`) + `_cmd_snapshot_restore` calling `runner.execute_restore_snapshot`; JSON `{"success": bool, "snapshot_id": str, "error": str|null}`. Register in the dispatch `if/elif` next to `reset-to-baseline`.
- [ ] Failing tests: restore writes the changed file + reconverges (fake runner records the commands); empty restore set → success no-op, no writes; `no_restorable_payload` / `snapshot_not_found` guards; validation-fail → file-level rollback restored the pre-change bytes (assert the rollback write happened, NOT an Ansible call); CLI emits the JSON shape.
- [ ] Run pytest both files → pass.
- [ ] Commit `feat(xinas_history): S11 T3 — execute_restore_snapshot (file-level) + snapshot restore CLI`.

### T4 — Bridge + projection (TS)

**Files:** modify `xiNAS-MCP/src/agent/task/xinas-history-bridge.ts`; test `xiNAS-MCP/src/__tests__/agent/task/xinas-history-bridge.test.ts`. Python `__main__.py` `snapshot list --format json` adds `restorable`.

- [ ] Python: `_cmd_snapshot_list` JSON entries gain `"restorable": bool` (= `store.list_system_files(id)` non-empty). Add a pytest assertion in `tests/test_snapshot_list_json.py` (or the existing list test) for the field.
- [ ] `xinas-history-bridge.ts`: add `restoreSnapshot(snapshotId: string, reason: string): Promise<{ success: boolean; snapshot_id?: string; error?: string }>` via `#runJson(['snapshot', 'restore', snapshotId, '--reason', reason, '--source', 'api', '--yes', '--format', 'json'], 'restore')` (mirror `resetToBaseline`). `HistoryManifest` gains optional `files_changed?: string[]` + `restorable?: boolean`; `ProjectedSnapshot` gains `files_changed: string[]` + `restorable: boolean`; `projectSnapshot()` maps them (default `[]` / `false`).
- [ ] Failing tests: `restoreSnapshot` argv + JSON parse + error mapping (fake subprocess); `projectSnapshot` carries `files_changed`/`restorable` (default `[]`/`false` when absent).
- [ ] Run `npx vitest run src/__tests__/agent/task/xinas-history-bridge.test.ts` + pytest list test → pass; `npx tsc --noEmit`.
- [ ] Commit `feat(control-path): S11 T4 — bridge restoreSnapshot + restorable/files_changed projection`.

### T5 — Provider targeted branch (api)

**Files:** modify `xiNAS-MCP/src/api/plan/providers/config-rollback.ts`; test `xiNAS-MCP/src/__tests__/api/config-rollback.test.ts`.

- [ ] Drop the `targeted_rollback_not_implemented` blocker. Branch on `spec.to`:
  - `'baseline'` → unchanged S9 path.
  - else (targeted id): find the observed row `rows.find(r => r.value.id === spec.to)`. Blockers: `snapshot_not_found` (no row); `no_restorable_payload` (`row.value.status?.restorable !== true`); always `dangerous_flag_required`. **No** `storage_only`/`no_effect` blocker. `risk_level: 'destructive'`, `rollback_model: 'changing_access'`. `affected_resources: [{kind:'ConfigSnapshot', id: spec.to}]` (no revision). `observed_freshness_ref: {kind:'ConfigSnapshot', id: spec.to, revision: row.revision}`. lease `[{kind:'ConfigHistory', id:'default'}]`. `enriched_spec: {to: spec.to, reason, target_id: spec.to}`. Put the domain blast radius (from `row.value.status?.files_changed`) into `warnings` + the `diff` text.
- [ ] Failing tests: targeted plan with a restorable observed row → no `targeted_rollback_not_implemented`, has `dangerous_flag_required`, affected = `[ConfigSnapshot/<id>]`, risk destructive; unknown id → `snapshot_not_found`; non-restorable row → `no_restorable_payload`; baseline path still works (regression).
- [ ] Run `npx vitest run src/__tests__/api/config-rollback.test.ts` → pass; `npx tsc --noEmit`.
- [ ] Commit `feat(api): S11 T5 — config-rollback provider targeted branch`.

### T6 — Executor dispatch + drift warning (agent)

**Files:** modify `xiNAS-MCP/src/agent/task/config-rollback-executor.ts`; test `xiNAS-MCP/src/__tests__/agent/task/config-rollback-executor.test.ts`.

- [ ] Narrow the enriched spec to `{ reason: string; to: string; target_id?: string; baseline_id?: string }`. In the `reset` stage: `to === 'baseline'` → `bridge.resetToBaseline(reason)` (unchanged); else → `bridge.restoreSnapshot(target_id ?? to, reason)`. `success !== true` throws with the `error`. On success, `ctx.emitOutput('recovery applied — desired state unchanged; re-apply or adopt to make durable, or the next apply will overwrite it')`. `rollback()` stays a no-op.
- [ ] Failing tests: `to:'baseline'` calls resetToBaseline; `to:'<id>'` calls restoreSnapshot with target_id; `success:false` throws the error; success emits the drift-warning output. Use a fake bridge recording calls.
- [ ] Run the executor test → pass; `npx tsc --noEmit`.
- [ ] Commit `feat(agent): S11 T6 — config-rollback executor targeted dispatch + drift warning`.

### T7 — Catalog (api)

**Files:** modify `xiNAS-MCP/src/api/mcp/catalog.ts`; test `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts`.

- [ ] `config_history.rollback` description → "Roll back to the BASELINE snapshot OR restore any restorable snapshot (observed recovery — re-apply to make durable; plan/apply, destructive — dangerous:true at apply). spec = {to: 'baseline' or a snapshot id, reason}." Gate flags unchanged (it stays a `planApply` entry → `requires_mcp_apply: true`).
- [ ] Failing test: the catalog entry description mentions restore; `requires_mcp_apply` is `true` (pin it explicitly).
- [ ] Run `npx vitest run src/__tests__/api/mcp-catalog.test.ts` → pass; `npx tsc --noEmit`.
- [ ] Commit `feat(api): S11 T7 — catalog rollback description (targeted restore)`.

### T8 — TUI Restore action

**Files:** modify `xinas_menu/screens/config_history.py` and/or `xinas_menu/screens/snapshot_detail.py`; test `tests/test_config_history_restore.py` (new, control-client stub pattern from `tests/test_control_client.py`).

- [ ] On the snapshot-detail screen, add a **Restore** action enabled only when the snapshot row's `restorable` is true (disabled with a reason otherwise). It opens a `ConfirmDialog` naming the risk class + `diff_summary` + the drift caveat ("recovery only — re-apply to make durable"), then runs `self.app.control.plan_apply_wait('POST', '/api/v1/config-history/rollback', {'to': ID, 'reason': REASON}, dangerous=True, on_progress=…, cancel_check=…)` via the S10 `TaskWaitDialog`. `TaskCancelled` → "restore cancelled" notice; `TaskFailed` → error dialog; success → "restore applied (recovery)" notice.
- [ ] Failing pytest: a restorable snapshot's Restore posts the targeted rollback body (`to`, `reason`, `mode:apply`, `dangerous:true`) against the stub; a non-restorable snapshot does not enable the action.
- [ ] Run `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_config_history_restore.py -q` → pass; ruff + pyright(venv) clean on touched files.
- [ ] Commit `feat(tui): S11 T8 — snapshot Restore action (targeted rollback)`.

### T9 — e2e + runbook + FULL gate

**Files:** create `xiNAS-MCP/src/__tests__/e2e/targeted-rollback.test.ts`; modify `docs/control-path/hardware-smoke-runbook.md`.

- [ ] e2e (real api+agent, fixture mode; python3 is the REAL `xinas_history` here so the runner runs — seed a tmp store root via `XINAS_HISTORY_STORE` or the config-history store path, OR drive through a fixture snapshot source + a fake reconverge). Scenarios: (1) capture a snapshot with a known exports payload → mutate `/etc/exports` in the sandbox → targeted restore → file reverted + the task warns about drift; (2) restore a snapshot whose live state already matches → success no-op; (3) non-restorable (pre-S11/no payload) → blocked at plan with `no_restorable_payload`; (4) unknown id → `snapshot_not_found`. (Network/netplan reconverge is unit-covered in T3; the e2e exercises the NFS path under the sandbox.)
- [ ] Runbook §5e: on-node checks — restore a snapshot from the TUI/`xinasctl` (config reverts, task warns, drift checks fire), restore-already-current no-op, non-restorable blocked, audit row via `/audit?task_id=`.
- [ ] FULL gate: `npm test` && `npm run build` && `npm run test:e2e` && `npm run test:contracts` && `npm run format:write` (then `format:check`) && markdownlint && spectral && oasdiff vs main && `pytest tests/` && `ruff check .` && `ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper` && pyright(venv) && ansible-lint && `gitleaks git --config .gitleaks.toml --log-opts="main..HEAD" .`.
- [ ] Commit `test(e2e): S11 T9 — targeted-rollback end-to-end + runbook §5e`.

---

**Self-review notes (spec coverage):** capture §3 → T1+T2; restore §4.1 → T3; bridge/projection §3.4/§4.2 → T4; provider §4.3 → T5; executor §4.4 → T6; contracts §4.5 → T0; catalog/TUI §5 → T7/T8; testing §6 → per-task + T9. Review locks: restore set = current-vs-target (T3 step 4); affected = single ConfigSnapshot ref + diff/warnings (T5); requires_mcp_apply stays true (T7); absent-file out of scope (T1 omit + not deleting — no code to add, enforced by writing only `restore_set` members); files_changed = display only (T2 computes it, T3 does NOT use it for the restore set). Type threads: `collect_system_files`/`SYSTEM_FILE_PATHS` (T1) → used by T3; `restorable`/`files_changed` projection (T4) → read by T5; `restoreSnapshot` (T4) → called by T6. `ruff format --check` is a BLOCKING CI job — run it in T9 (lesson from S10).
