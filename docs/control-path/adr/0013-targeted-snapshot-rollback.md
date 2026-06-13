# ADR-0013: Targeted snapshot rollback (file-level, observed recovery)

- **Status:** accepted
- **Date:** 2026-06-13
- **Stream:** S11
- **Supersedes / amends:** completes the `targeted_rollback_not_implemented`
  arm S9 (ADR-0011) deliberately left blocked; amends ADR-0011 §Rollback.

## Context

S9 shipped config-history rollback as **baseline-only**, with the provider
returning a `targeted_rollback_not_implemented` blocker for any `to` other
than `baseline`. Closing that gap means restoring an *arbitrary* snapshot.
Three facts, each **verified against the code**, shaped the decision:

1. **Playbook re-apply cannot reproduce a targeted control-path snapshot.**
   `execute_reset_to_baseline` re-runs the snapshot's `playbook` with its
   `extra_vars`. But `engine.create_snapshot` defaults `extra_vars` to `{}`
   and the `snapshot create` CLI never passes any — only the installer
   shell scripts produce `extra_vars`, and they feed `ansible-playbook`
   directly, never the snapshot store. So every control-path snapshot
   carries `extra_vars = {}` + the default `site.yml`. Re-running that
   converges to the *current preset's defaults*, identical regardless of
   which snapshot is "targeted" — the differentiating state (the actual
   `/etc/exports` / `netplan` content) is file content `site.yml` does not
   parameterize. Baseline reset "works" only because baseline ≡ install
   defaults.

2. **Snapshots do not capture the live file bytes today.** `ConfigCollector`
   stores repo-side defaults/templates (`collection/roles/*/defaults`, the
   netplan template) as `config_files`, and only **checksums** the live
   `/etc/exports`, `99-xinas.yaml`, etc. There is nothing restorable in a
   snapshot yet.

3. **NFS/network writers are desired-state anchored.** Network plans render
   from desired KV rows; drift detection states out-of-band netplan edits
   are overwritten by the next network apply. Restoring files out-of-band
   therefore diverges from desired intent.

The scope boundary is also fixed by prior decisions: the control-path has
**no RAID executor** — storage topology (RAID/FS/pools) is owned by
TUI/MCP/installer and is not captured for restore.

## Decision

S11 is **two parts**: first make snapshots *restorable*, then restore them.

### 1. Mechanism — file-level restore (not playbook re-apply)

Restore writes the target snapshot's captured **live config-file bytes**
back to disk and reconverges the affected services. Playbook re-apply is
rejected (fact 1); desired-row replay is deferred (Alternatives).

### 2. Capture — a restorable "system_files" payload (Part 1)

`ConfigCollector` gains `collect_system_files()` that reads the **live
bytes** of the existing `CHECKSUM_TARGETS` (`/etc/exports`, `/etc/nfs.conf`,
`/etc/idmapd.conf`, `/etc/netplan/99-xinas.yaml`, and the ADR-0005 effective
NFS files), skipping any that are absent. `engine.create_snapshot` stores
them as a NEW payload (`store.write_snapshot(..., system_files=…)` →
`system/` subdir; `store.read_system_file(id, name)`), **distinct** from the
repo-defaults `config_files` and the `runtime_files`.

The manifest also gains `files_changed: list[str]` — computed at snapshot
time by diffing the target's checksums against its **parent's** — which
populates the public `ConfigSnapshot.files_changed` (currently always empty).
This is **history/display metadata only**; it is NOT the restore set (see the
restore-set rule in §3). The captured `Checksums` (already stored per
snapshot) are what restore compares against.

Pre-S11 snapshots have no `system/` payload → **not restorable**; the
provider blocks them honestly (`no_restorable_payload`).

### 3. Restore — `execute_restore_snapshot(snapshot_id, …)` (Part 2)

A new runner verb, transactional like reset-to-baseline (lock → preflight →
**pre-change ephemeral snapshot** → apply → validate → mark → auto-rollback
→ release), but the apply + rollback are **file-level**:

- **Restore set = current-vs-target (NOT `files_changed`).** At execute time
  the runner re-checksums the **current live** managed files and compares them
  to the **target's captured `Checksums`**; the restore set is the files that
  differ. This is the only correct basis — `files_changed` (target-vs-parent)
  would miss files that changed *after* the target was created, so restoring
  an older snapshot would skip real current drift.
- **Apply:** for each file in the restore set, write the target's captured
  `system/` bytes to the live path, then reconverge **only the affected
  domains**: NFS → `exportfs -ra` and/or restart `nfs-server`/`nfs-idmapd` per
  which files changed; network → the documented apply sequence (flush PBR
  tables 100–199 + flush IPs from mlx interfaces, clean IB stanzas from
  non-xinas files, `netplan apply`). **Captured-existing-files only:** restore
  writes the content of files the target *captured*; it does NOT delete a file
  that exists now but was absent in the target (the absent case — restoring a
  file's *absence* via tombstones — is a deferred follow-on; see Consequences).
  A restore set that comes out empty (already at target) is a successful
  no-op.
- **File-level auto-rollback (NEW):** the existing `_auto_rollback` re-runs
  Ansible from the pre-change manifest (fact 1's dead end). A restore failure
  instead restores the **pre-change ephemeral's `system/` bytes** and
  reconverges the same domains. Implemented as a restore-specific rollback
  function (the pre-change ephemeral now carries the live payload too, since
  capture in §2 applies to every snapshot the runner creates).
- Risk via the existing `classify_rollback(current, target)`.

**Connectivity hazard:** the runner executes *locally* on the node (an agent
subprocess), so restoring a netplan that drops the IB/data link does not kill
the runner — validation re-checks link/service state and the file-level
auto-rollback restores the pre-change bytes if recovery fails.

### 4. Desired-state contract — observed recovery + surface drift

Restore is an **emergency recovery**: it changes observed system files but
**does NOT touch desired KV**. Consequences, made explicit:

- The existing drift checks (`drift.nfs-exports`, `drift.netplan`) fire after
  a restore that diverges from desired — the divergence is visible, not
  silent.
- The restore task result carries a warning: *recovery applied; re-apply or
  adopt to make it durable, or the next apply will overwrite it.*
- **Durable desired-KV adoption is deferred** to a named follow-on (it is a
  large reverse-mapping: exports→Share/ExportGroup rows, netplan→Network
  rows — essentially a re-import path).

### 5. API surface — route through `config.rollback` (extend S9)

- **Request:** `to` widens from the `baseline` literal to
  `baseline | <snapshot-id>` (api-v1.yaml).
- **Provider** (`config-rollback.ts`): drop `targeted_rollback_not_implemented`.
  For a targeted `to`: resolve the target from observed `ConfigSnapshot`
  rows; blockers = `snapshot_not_found`, `no_restorable_payload` (pre-S11 or
  ephemeral), plus the always-on `dangerous_flag_required`. There is **no**
  `storage_only`/`no_effect` plan blocker — the provider is KV-only and cannot
  re-checksum live files, so whether the restore set is empty is the runner's
  call at execute (an empty set is a successful no-op, §3). `risk_level:
  'destructive'`; `rollback_model: 'changing_access'` (within the allowed
  enum). **Affected resources** must each carry a valid `{kind, id}` (the
  schema + TS type require `id`), so they are exactly
  `[{kind:'ConfigSnapshot', id: target}]`; the lease is
  `[{kind:'ConfigHistory', id:'default'}]`. The **domain blast radius** (which
  NFS/network services the restore may touch, derived from the target's
  captured `files_changed`) is expressed in the plan's `diff` + `warnings`,
  NOT as bare-kind `affected_resources` (there is no aggregate id for
  `Share`/`NetworkInterface`). `observed_freshness_ref` on the target;
  `enriched_spec: {to, reason, target_id}`.
- **Executor** (`config-rollback-executor.ts`): the single stage dispatches
  `to === 'baseline'` → `bridge.resetToBaseline` (unchanged) vs a snapshot id
  → `bridge.restoreSnapshot`. `success !== true` throws; `rollback()` stays a
  no-op (the runner auto-rolls-back).

### 6. Clients

- **CLI/bridge:** `xinas_history snapshot restore <id> --reason … --format
  json`; `XinasHistoryBridge.restoreSnapshot(id, reason)`.
- **Catalog:** `config_history.rollback` description updated ("baseline OR any
  restorable snapshot"). It is a `planApply` entry, so `requires_mcp_apply`
  stays **true** (unchanged) — a destructive restore via MCP needs
  `allow_apply`; it is NOT an emergency-stop exception like `tasks.cancel`.
- **TUI:** the snapshot-detail screen gains a **Restore** action → a confirm
  dialog naming the risk class + diff summary + the drift warning, then
  `plan_apply_wait` with `to: <id>` + `dangerous`, using the S10
  `TaskWaitDialog` (cancellable).

## Alternatives considered

- **Playbook re-apply per snapshot** — rejected: verified it cannot reproduce
  a control-path snapshot (empty extra_vars; file content not parameterized).
- **Durable desired-KV adoption now** — deferred: reverse-parsing restored
  exports/netplan into desired rows roughly doubles the slice; this stream
  ships the recovery, the follow-on makes it durable.
- **Capture + replay desired rows (instead of file bytes)** — rejected for
  this slice: a different, also-large capture model; the file payload matches
  what snapshots already checksum and what drift already compares.
- **Reuse `_auto_rollback` for restore failures** — rejected: it re-runs
  Ansible (same dead end); restore needs file-level rollback.

## Consequences

- New snapshots grow by the live config-file payload (small — a handful of
  text files); pre-S11 snapshots are read-only history (not restorable).
- A targeted restore that diverges from desired leaves visible drift until an
  operator re-applies or the deferred adopt path lands — by design, surfaced.
- Storage topology remains out of scope; a restore whose target captured no
  managed NFS/network files (or whose set is already current) is a no-op the
  runner reports, not a plan-time block.
- **Absent-file restore is not supported in this slice.** `collect_system_files`
  omits files that are absent at capture, and restore writes only captured
  bytes — so restoring a snapshot in which a managed file was *absent* will NOT
  remove that file if it exists now. The checksum model already distinguishes
  absence (`""`), so a tombstone-based absence restore is a clean follow-on;
  for now "arbitrary snapshot restore" means "the captured existing files."
- The `config.rollback` route, the `ConfigHistory/default` lease, the
  destructive dangerous-gate, and the local-runner connectivity argument all
  carry over from S9 unchanged.
