# xiNAS S11 — Targeted snapshot rollback (design spec)

**Status:** design (2026-06-13). Implements ADR-0013. Closes the
`targeted_rollback_not_implemented` blocker S9 (ADR-0011) left in
`config.rollback`. Companion plan (written next, after spec approval):
`docs/plans/2026-06-13-s11-targeted-rollback-plan.md`.

**Goal.** Let `config.rollback` restore an *arbitrary* restorable snapshot,
not just `baseline` — by capturing the live NFS/network config-file bytes
into snapshots and restoring them file-level, as an **observed recovery**
(desired KV untouched; drift surfaced). Storage topology stays out of scope.

This spec assumes ADR-0013's verified facts: control-path snapshots carry
empty `extra_vars` (playbook re-apply can't reproduce them), snapshots don't
capture live bytes today (the collector checksums them), and NFS/network
writers are desired-anchored.

---

## 1. Scope

### In scope
- **Capture:** a restorable `system_files` payload (live bytes of the
  managed NFS/network config files) + `files_changed`/domain metadata in
  every new snapshot.
- **Restore:** a file-level `execute_restore_snapshot` runner verb with a
  file-level auto-rollback, reconverging only the changed domains.
- **API:** extend the S9 `config.rollback` provider/executor/route, bridge,
  and CLI for targeted `to: <snapshot-id>`.
- **Clients:** catalog description, TUI Restore action.

### Out of scope (deferred / excluded)
- **Storage topology** (RAID/FS/pools) — not captured, owned by
  TUI/MCP/installer. A restore whose target captured no managed NFS/network
  files, or whose restore set is already current, is a runner-reported no-op
  (not a plan-time block).
- **Absent-file restore** — `collect_system_files` omits absent files, so this
  slice restores captured *existing* files only; it does not remove a file
  that was absent at capture but exists now (tombstone-based absence restore is
  a deferred follow-on — ADR-0013 §Consequences).
- **Durable desired-KV adoption** — restore is observed recovery; making the
  restored state the new desired intent (reverse-parsing exports/netplan into
  desired rows) is a named follow-on.
- **Restoring pre-S11 snapshots** — they have no `system/` payload
  (`no_restorable_payload`).

---

## 2. Component map

```
 xinas_history (python, root)                 xinas-api (TS)            client
 ┌──────────────────────────────┐             ┌────────────────────┐
 │ collector.py                 │             │ providers/         │   TUI
 │  + collect_system_files()    │             │  config-rollback   │  Restore
 │ store.py                     │             │   (targeted)       │  action
 │  + system/ payload           │             │ executor dispatch  │
 │  + read_system_file()        │ ─restore──▶ │  baseline|<id>     │
 │ engine.create_snapshot       │   RPC via   │ bridge.restore-    │
 │  + files_changed/domains     │  config.    │  Snapshot()        │
 │ runner.execute_restore_      │  rollback   │ api-v1 to:<id>     │
 │  snapshot + file rollback    │             └────────────────────┘
 │ __main__ snapshot restore    │
 └──────────────────────────────┘
```

---

## 3. Part 1 — capture (make snapshots restorable)

### 3.1 `collector.collect_system_files() -> dict[str, bytes]`
Reads the **live bytes** of the existing `CHECKSUM_TARGETS` paths
(`/etc/exports`, `/etc/nfs.conf`, `/etc/idmapd.conf`,
`/etc/netplan/99-xinas.yaml`, `/etc/nfs/nfsd.conf`,
`/etc/default/nfs-kernel-server`, `/etc/modprobe.d/lockd.conf`,
`/etc/default/nfs-common`). Absent files are **omitted** (not stored as
empty) — so this slice restores *captured existing files only*; it does NOT
remove a file that was absent at capture but exists at restore time (absence
restore via tombstones is a deferred follow-on; ADR-0013 §Consequences).
Keyed by the same logical names as `Checksums` so restore can map a stored
blob back to its live path via a single `SYSTEM_FILE_PATHS` table (the
inverse of `CHECKSUM_TARGETS`).

### 3.2 Store: `system/` payload
`store.write_snapshot(..., system_files: dict[str, bytes])` writes them under
`<snapshot>/system/<name>`; `store.read_system_file(id, name) -> bytes | None`
reads one back; a `system/` listing helper returns the captured names. This
is a THIRD payload, distinct from `config_files` (repo defaults, top-level)
and `runtime_files` (`runtime/`).

### 3.3 `engine.create_snapshot` + manifest metadata
`create_snapshot` (and `create_baseline`) call `collect_system_files()` and
pass it to `write_snapshot`. The manifest gains `files_changed: list[str]` —
managed-file names whose checksum differs from the **parent** snapshot (empty
for the first/baseline). This populates the public
`ConfigSnapshot.files_changed` and is **history/display + blast-radius hint
only** — it is NOT the restore set. The authoritative restore set is computed
at execute time as current-vs-target (§4.1). The captured `Checksums`
(already per snapshot) are what the runner compares against.

### 3.4 Projection (TS bridge)
`ProjectedSnapshot` + `projectSnapshot()` gain `files_changed: string[]` (from
the manifest, default `[]`). The `ConfigSnapshot` collector already emits the
projected row; `files_changed` rides along into the observed KV row, so the
api provider reads it without an RPC.

**Restorability flag:** a snapshot is restorable iff it has a non-empty
`system/` payload. `xinas_history snapshot list --format json` gains a
`restorable: bool` per entry (the store reports whether `system/` is
non-empty); the bridge's `snapshotList` parses it and `projectSnapshot()`
carries `restorable: boolean` into the observed row. Pre-S11 snapshots →
`false`.

---

## 4. Part 2 — restore

### 4.1 `runner.execute_restore_snapshot(snapshot_id, source, reason, progress_cb)`
Transactional, mirroring `execute_reset_to_baseline`'s 8-step shape but with
a file-level apply + rollback:

1. Resolve `target = store.read_manifest(snapshot_id)`; absent → fail
   `snapshot_not_found`. No `system/` payload → fail `no_restorable_payload`.
2. Classify via `classify_rollback(current, target)` where `current` = the
   latest applied snapshot.
3. Acquire the global config lock.
4. Preflight (target readable; live paths resolvable).
5. **Pre-change ephemeral snapshot** — already captures `system/` (Part 1),
   so it is itself restorable.
6. **Compute the restore set (current-vs-target):** re-checksum the **current
   live** managed files and compare to the target's captured `Checksums`; the
   restore set = the captured files whose live checksum differs. NOT
   `files_changed` (target-vs-parent), which would miss files changed *after*
   the target. An empty restore set → successful no-op (already at target).
7. **Apply (file-level):** for each file in the restore set, write
   `read_system_file(target, name)` to its live path. Then reconverge **only
   the affected domains** (derived from the restore set):
   - nfs files changed → `exportfs -ra`; restart `nfs-server` if a server
     file changed, `nfs-idmapd` if idmapd changed.
   - `netplan` changed → flush PBR tables 100–199 + flush IPs from mlx
     interfaces, strip IB stanzas from non-xinas netplan files, `netplan
     apply` (the `net_controllers` apply sequence).
8. **Validate:** services active; `netplan get` parses; (deep) link present.
9. Validation fail → **file-level auto-rollback**: write the pre-change
   ephemeral's `system/` bytes back for the same restore set + reconverge the
   same domains; mark the restore `failed`/`partial`. This is a
   restore-specific function — NOT `_auto_rollback` (which re-runs Ansible).
10. Mark applied; release the lock. Return `RunResult` (success +
    `snapshot_id` of the applied marker, or failure + message).

**Reconverge selection** lives in one helper keyed by domain so apply and
rollback share it. **Connectivity:** the runner is local; netplan apply uses
flush-then-apply; step 8 recovers a bad link.

### 4.2 CLI + bridge
- `__main__`: `snapshot restore <id> --reason <r> --source <s> --format json`
  → `_cmd_snapshot_restore` → `runner.execute_restore_snapshot`; JSON
  `{"success": bool, "snapshot_id": str, "error": str?}`.
- `XinasHistoryBridge.restoreSnapshot(snapshotId, reason)` — shells the verb,
  parses the JSON (mirrors `resetToBaseline`'s argv/parse/error mapping).

### 4.3 Provider (`api/plan/providers/config-rollback.ts`)
Drop `targeted_rollback_not_implemented`. Branch on `spec.to`:
- `'baseline'` → unchanged S9 behavior.
- `<snapshot-id>` → resolve the observed `ConfigSnapshot` row. Blockers:
  - `snapshot_not_found` — no observed row for the id.
  - `no_restorable_payload` — `restorable === false`.
  - `dangerous_flag_required` — always (S4 advisory pattern).
  - **No** `storage_only`/`no_effect` plan blocker: the provider is KV-only
    and can't re-checksum live files, so an empty restore set is the runner's
    call at execute (a successful no-op), not a plan-time block.
  - `risk_level: 'destructive'`, `rollback_model: 'changing_access'`.
  - **affected** (must carry `{kind, id}` — schema + TS type require `id`):
    exactly `[{kind:'ConfigSnapshot', id: target}]`. The domain blast radius
    (which NFS/network services the restore may touch, from the target's
    `files_changed` hint) goes in the plan `diff` + `warnings` — there is no
    aggregate id for `Share`/`NetworkInterface`, so no bare-kind refs.
  - `observed_freshness_ref {ConfigSnapshot, id, revision}`; lease
    `[{kind:'ConfigHistory', id:'default'}]`; `enriched_spec {to, reason,
    target_id}`.

### 4.4 Executor (`agent/task/config-rollback-executor.ts`)
One `restore` stage: `spec.to === 'baseline'` → `bridge.resetToBaseline` (S9)
vs id → `bridge.restoreSnapshot(spec.target_id, spec.reason)`. `success !==
true` throws; `rollback()` no-op. On success, emit the **drift warning** as
task output ("recovery applied; re-apply or adopt to make durable").

### 4.5 Contracts (api-v1.yaml)
- Rollback request `to`: `baseline | <string snapshot id>` (description +
  example). oasdiff-additive.
- `ConfigSnapshot.files_changed` already exists — now actually populated
  (no schema change); add an optional `restorable: boolean` (additive).

---

## 5. Clients

- **Catalog** (`mcp/catalog.ts`): `config_history.rollback` description →
  "reset to baseline OR restore any restorable snapshot (observed recovery —
  re-apply to make durable)". It is a `planApply` entry, so
  `requires_mcp_apply` stays **true** (unchanged) — a destructive restore via
  MCP needs `allow_apply`; `min_role` unchanged.
- **TUI** (`screens/config_history.py` / `snapshot_detail.py`): a **Restore**
  action on a restorable snapshot → confirm dialog (risk class, diff summary,
  the drift caveat) → `plan_apply_wait('POST', '/api/v1/config-history/
  rollback', {to: <id>, reason}, dangerous=True, cancel_check=…)` via the S10
  `TaskWaitDialog`. Non-restorable snapshots show the action disabled with the
  reason.

---

## 6. Testing strategy

- **python (pytest):** `collect_system_files` (reads live, omits absent);
  store `system/` round-trip; `create_snapshot` writes the payload +
  `files_changed` vs parent; `execute_restore_snapshot` happy path (writes
  changed files + reconverges) with a fake command-runner; **file-level
  auto-rollback** on validation failure (pre-change bytes restored);
  `no_restorable_payload` / `snapshot_not_found` guards; CLI `snapshot
  restore` JSON shape.
- **TS (vitest):** bridge `restoreSnapshot` argv/JSON/error; projection
  carries `files_changed`/`restorable`; provider blocker matrix (found /
  no-payload / dangerous), single ConfigSnapshot affected ref + diff/warnings blast radius,
  risk; executor dispatch baseline-vs-targeted plus drift-warning output.
- **e2e:** capture a snapshot → mutate `/etc/exports` (and, in a second
  scenario, the netplan fixture) → targeted restore → the file reverts, the
  reconverge ran, the task warns about drift; non-restorable blocked at plan;
  an already-current restore is a successful no-op.
- **TUI (pytest):** Restore action posts the targeted rollback; non-restorable
  disabled.
- **Full gate** at the final task (all suites + build + e2e + contracts +
  biome + markdownlint + spectral + oasdiff + pytest + ruff + pyright +
  ansible-lint + gitleaks).

---

## 7. Decomposition (T0–T9)

| T | Scope |
|---|-------|
| **T0** | Contracts: api-v1 `to` widening + `ConfigSnapshot.restorable`; ADR-0011 §Rollback amend pointer; spectral + oasdiff verified. |
| **T1** | Capture: `collect_system_files` + `SYSTEM_FILE_PATHS` table + store `system/` payload + `read_system_file` (python, pytest). |
| **T2** | `create_snapshot`/`create_baseline` store the payload + compute `files_changed` vs parent; manifest round-trip (python). |
| **T3** | `execute_restore_snapshot` + file-level reconverge helper + file-level auto-rollback + CLI `snapshot restore` (python). |
| **T4** | Bridge `restoreSnapshot`; projection `files_changed`/`restorable`; `snapshotList` JSON carries `restorable` (TS + the python list-JSON field). |
| **T5** | Provider targeted branch (blockers + affected + risk); drop the S9 blocker; provider tests. |
| **T6** | Executor dispatch + drift-warning output; executor tests. |
| **T7** | Catalog description flip + pins. |
| **T8** | TUI Restore action + confirm + TaskWaitDialog wiring; pytest. |
| **T9** | e2e (exports + netplan scenarios; non-restorable blocked; already-current no-op) + runbook §5e + FULL gate. |

---

## 8. Open risks

- **`Requires-Rebuild`:** the capture change (`collector.py`,
  `create_snapshot`) ships in the `xinas_history` package, delivered by the
  plain `git pull` + helper restart on update — **no** Ansible re-run needed
  (it's python library code, not a role/unit change). No trailer.
- **Reconverge breadth:** S11 reconverges NFS + network only. A snapshot whose
  `files_changed` includes a file with no reconverge rule (none today) would
  write-without-reconverge — guarded by the `SYSTEM_FILE_PATHS`→domain map
  being total over the captured set.
- **First-restore-after-upgrade:** the *current* state at first restore may
  predate Part 1 (no `system/`), but `current` is only used for
  classification + the pre-change ephemeral (which is captured fresh now), so
  restore still works; only the *target* must be restorable.
