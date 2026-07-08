# xiNAS MCP Agent — Management-Surface Test Cases

**System under test:** the MCP transport inside `xinas-api.service` (the `/mcp` endpoint,
and the `xinas-mcp-stdio` adapter) on a live xiNAS node. Catalog-generated tools; see
[docs/control-path/adr/0010-clients-mcp-cli-tui.md](../../control-path/adr/0010-clients-mcp-cli-tui.md)
and [docs/control-path/s8-clients-spec.md](../../control-path/s8-clients-spec.md) for the
live contract, and [docs/MCP/spec-tools.md](../../MCP/spec-tools.md) /
[docs/MCP/spec-middleware.md](../../MCP/spec-middleware.md) for the tool table and
middleware.
**Executor:** an AI agent driving xiNAS through its MCP tools.
**Scope:** the whole agent management surface — 9 namespaces (`system`, `network`,
`health`, `disk`, `raid`, `share`, `auth`, `job`, `config`) plus the cross-cutting
middleware (RBAC, plan/apply gating, idempotency, audit, dangerous-flag).

> Storage-reset (finding C1) behavioral validation lives in its own file —
> [2026-07-07-storage-reset-safety-scenarios.md](2026-07-07-storage-reset-safety-scenarios.md)
> (S1–S11, shell/ansible oriented). This file covers what the **agent** can do through
> MCP.

## Status legend

| Status | Meaning |
|---|---|
| 🟡 **Need to be validated** | Written, not yet executed against a live node. **All cases below start here.** |
| 🟢 Validated | Ran on a live node; actual == expected. Record date/host/evidence. |
| 🔴 Failed | Ran; actual ≠ expected. File a bug and link it. |

## Conventions (apply to every case)

- **Roles** form a hierarchy `viewer (0) < operator (1) < admin (2)`. Token mapping:
  **no token on stdio → `admin`** (local access); **unknown token → `viewer`** (least
  privilege). Each case notes the **minimum role** the tool requires.
- **plan vs apply.** Mutating tools default to `mode: "plan"` (dry-run preview, no state
  change). `mode: "apply"` executes — but **`config.mcp.allow_apply` defaults `false`**,
  so an `apply` call returns the structured error **`MCP_APPLY_DISABLED`** (naming the
  config key and the REST/CLI alternative) until an operator flips it on.
- **dangerous flag.** Destructive tools (`raid.delete`, `disk.secure_erase`) require
  `dangerous: true` in addition to `apply`.
- **Audit.** Every tool call — reads, mutations, and denials — appends one JSON line to
  `/var/log/xinas/mcp-audit.jsonl` (actor, role, tool, params, result).
- **Idempotency.** A repeated call carrying the same `idempotency_key` returns the cached
  result and produces exactly one side effect.
- **Error codes** used below: `PERMISSION_DENIED`, `MCP_APPLY_DISABLED`,
  `PRECONDITION_FAILED`, `CONFLICT`, `NOT_FOUND`, `INVALID_ARGUMENT`, `UNSUPPORTED`.
- Each case: **Tool / Role / Mode → Precondition → Agent steps → Expected → Pass/fail.**

---

## A. Cross-cutting middleware (TC-XC)

### TC-XC-01 — RBAC denies a mutating tool below role — 🟡 Need to be validated
**Tool:** `raid.create` · **Role:** caller = `viewer`.
**Precondition:** agent authenticated with a viewer token.
**Steps:** call `raid.create` (any params, `mode: "plan"`).
**Expected:** `PERMISSION_DENIED`; no gRPC call made; audit line records the denied
attempt with `role: viewer`.
**Pass/fail:** denial + zero side effects + audit entry.

### TC-XC-02 — apply is gated by `mcp.allow_apply` (default off) — 🟡 Need to be validated
**Tool:** any mutating tool (e.g. `share.create`) · **Role:** operator+ · **Mode:** apply.
**Precondition:** `mcp.allow_apply` is `false` (default).
**Steps:** call the tool with `mode: "apply"`.
**Expected:** `MCP_APPLY_DISABLED` naming `mcp.allow_apply` and pointing to the REST/CLI
path; **no state change**. A subsequent `mode: "plan"` still returns a preview.
**Pass/fail:** structured error, state unchanged.

### TC-XC-03 — plan mode previews without mutating — 🟡 Need to be validated
**Tool:** `share.create` · **Role:** operator · **Mode:** plan.
**Steps:** call with valid params, `mode: "plan"`.
**Expected:** a plan/preview object (what would change); `/etc/exports` **unchanged**;
`exportfs` shows no new export.
**Pass/fail:** preview returned, no side effect.

### TC-XC-04 — apply runs plan→apply→task when enabled — 🟡 Need to be validated
**Tool:** `share.create` · **Role:** operator · **Mode:** apply.
**Precondition:** `mcp.allow_apply: true`.
**Steps:** apply a valid create.
**Expected:** plan→apply→task completes; export present (`exportfs -v`); a job is
recorded (`job.list`); audit line shows the applied change.
**Pass/fail:** effect applied + job + audit.

### TC-XC-05 — idempotency key collapses a retried call — 🟡 Need to be validated
**Tool:** `auth.create_user` (apply, allow_apply on) · **Role:** admin.
**Steps:** call twice with the **same** `idempotency_key`.
**Expected:** second call returns the cached result; exactly **one** user created (`getent
passwd` shows one).
**Pass/fail:** single side effect on repeat.

### TC-XC-06 — audit trail captures every call — 🟡 Need to be validated
**Steps:** perform one read (`raid.list`), one denied call (TC-XC-01), one plan.
**Expected:** three new lines in `/var/log/xinas/mcp-audit.jsonl`, each with actor, role,
tool, params, and result/outcome.
**Pass/fail:** one audit line per call, fields present.

### TC-XC-07 — token→role mapping — 🟡 Need to be validated
**Steps:** (a) call a viewer tool over stdio with **no token**; (b) call with an
**unknown** token.
**Expected:** (a) resolves to `admin` (local); (b) resolves to `viewer` (least
privilege) — an admin tool then returns `PERMISSION_DENIED`.
**Pass/fail:** both mappings hold.

### TC-XC-08 — destructive tool requires the dangerous flag — 🟡 Need to be validated
**Tool:** `raid.delete` / `disk.secure_erase` · **Role:** admin · **Mode:** apply,
allow_apply on.
**Steps:** call `apply` **without** `dangerous: true`.
**Expected:** refused (guarded) — the destructive action does not run; with
`dangerous: true` (and preconditions met) it proceeds.
**Pass/fail:** no destruction without `dangerous`.

---

## B. `system` namespace (TC-SYS) — all viewer, read-only

### TC-SYS-01 — `system.get_status` — 🟡 Need to be validated
Returns `systemInfo` + `serviceState` (xiraid/nfs/api services) and license/settings.
**Pass/fail:** well-formed status, services enumerated.

### TC-SYS-02 — `system.get_inventory` — 🟡 Need to be validated
Returns `systemInfo`, `diskInfo`, `networkInfo`. **Pass/fail:** all three sections present
and consistent with `lsblk`/`ip addr`.

### TC-SYS-03 — `system.get_performance` — 🟡 Need to be validated
Returns metrics via the Prometheus client. **Pass/fail:** non-empty metric series.

### TC-SYS-04 — `system.get_logs` — 🟡 Need to be validated
Returns a `journalctl` slice for the requested unit/window. **Pass/fail:** log lines match
the requested filter.

### TC-SYS-05 — `system.list_controllers` / `get_controller_capabilities` — 🟡 Need to be validated
Enumerates xiRAID controllers and reports capabilities (settings, license).
**Pass/fail:** controller list + capability flags returned.

---

## C. `network` namespace (TC-NET)

### TC-NET-01 — `network.list` (viewer) — 🟡 Need to be validated
Returns interfaces, IPs, and PBR tables. **Pass/fail:** matches `ip addr` / `ip rule`.

### TC-NET-02 — `network.configure` plan (admin) — 🟡 Need to be validated
Plan a netplan change. **Expected:** preview only; `/etc/netplan/99-xinas.yaml` unchanged;
no PBR flush. **Pass/fail:** no side effect.

### TC-NET-03 — `network.configure` apply (admin, allow_apply) — 🟡 Need to be validated
**Expected:** writes `99-xinas.yaml`, flushes PBR tables 100–199 and mlx IPs, re-applies
(per [spec-network-management](../../Network/spec-network-management.md)); old IPs/rules
gone. **Pass/fail:** new config live, no phantom IPs/rules.

### TC-NET-04 — `network.configure` as operator → denied — 🟡 Need to be validated
**Expected:** `PERMISSION_DENIED` (admin-only). **Pass/fail:** denial.

---

## D. `health` namespace (TC-HLT)

### TC-HLT-01 — `health.run_check` (viewer) — 🟡 Need to be validated
Returns a JSON health report (raidShow, poolShow, driveFaultyCount, licenseShow +
Python engine). **Pass/fail:** report includes RAID/pool/drive/license sections with
pass/warn/fail verdicts.

### TC-HLT-02 — `health.get_alerts` (viewer) — 🟡 Need to be validated
Returns active alerts. **Pass/fail:** alert list (possibly empty) with severities.

### TC-HLT-03 — `health.fix_nfs_conf` (admin) — 🟡 Need to be validated
**Expected:** writes `/etc/nfs.conf` and restarts `nfs-server` (apply-gated). Re-running is
idempotent (no-op if already correct). **Pass/fail:** conf corrected, service healthy.

---

## E. `disk` namespace (TC-DSK)

### TC-DSK-01 — `disk.list` (viewer) — 🟡 Need to be validated
Returns drives + roles (system vs data vs array member). **Pass/fail:** matches physical
topology; OS drive flagged protected.

### TC-DSK-02 — `disk.get_smart` edge cases (viewer) — 🟡 Need to be validated
NVMe → SMART data; **SATA → `UNSUPPORTED`**; missing device → **`NOT_FOUND`**.
**Pass/fail:** all three outcomes.

### TC-DSK-03 — `disk.run_selftest` (operator) — 🟡 Need to be validated
Starts a self-test; result observable. **Pass/fail:** test launched, status readable.

### TC-DSK-04 — `disk.set_led` (operator) — 🟡 Need to be validated
Locate LED on/off via `driveLocate`. **Pass/fail:** LED state toggles.

### TC-DSK-05 — `disk.secure_erase` (admin, dangerous, apply-gated) — 🟡 Need to be validated
**Expected:** `plan` previews; `apply` without `dangerous` refused; `apply` + `dangerous`
+ allow_apply runs `driveClean`. **Must not** target a protected/system disk.
**Pass/fail:** erase only with full gating; OS disk never eligible.

---

## F. `raid` namespace (TC-RAID)

### TC-RAID-01 — `raid.list` (viewer) — 🟡 Need to be validated
Returns arrays with state/level/members. **Pass/fail:** matches `xicli raid show`.

### TC-RAID-02 — `raid.create` plan preconditions (admin) — 🟡 Need to be validated
**Expected:** `memory_limit < 1024` → `PRECONDITION_FAILED`; duplicate array name →
`CONFLICT`. **Pass/fail:** both guarded in plan, no partial create.

### TC-RAID-03 — `raid.create` apply (admin, allow_apply) — 🟡 Need to be validated
**Expected:** array created via `raidCreate`, tracked as a job, `/dev/xi_<name>` appears.
**Pass/fail:** array online + job recorded.

### TC-RAID-04 — `raid.delete` guarded (admin, dangerous) — 🟡 Need to be validated
**Expected:** filesystem mounted → `PRECONDITION_FAILED`; active NFS export →
`PRECONDITION_FAILED`; requires `dangerous: true`. **Pass/fail:** no delete while in use.

### TC-RAID-05 — `raid.lifecycle_control` (operator/admin) — 🟡 Need to be validated
Init / recon start / stop via `raidInit`/`ReconStart`/`Stop`. **Pass/fail:** lifecycle
transitions observable in `raid.list`.

### TC-RAID-06 — `raid.modify_performance` / `unload` / `restore` (admin) — 🟡 Need to be validated
Plan/apply performance change; unload/restore an array. **Pass/fail:** modify reflected;
unload+restore round-trips without data loss.

---

## G. `share` namespace (TC-SHR)

### TC-SHR-01 — `share.list` (viewer) — 🟡 Need to be validated
Lists exports (`listExports`). **Pass/fail:** matches `exportfs -v`.

### TC-SHR-02 — `share.create` plan preconditions (operator) — 🟡 Need to be validated
**Expected:** path missing & `create_path: false` → `PRECONDITION_FAILED`;
`create_path: true` with missing **parent** → `PRECONDITION_FAILED`. **Pass/fail:** both.

### TC-SHR-03 — `share.create` apply (operator, allow_apply) — 🟡 Need to be validated
**Expected:** `addExport` + `reload`; export live. **Pass/fail:** client can mount.

### TC-SHR-04 — `share.update_policy` apply — 🟡 Need to be validated
Changes rw/ro, squash, clients. **Pass/fail:** `updateExport` + reload; policy in effect.

### TC-SHR-05 — `share.set_quota` (operator) — 🟡 Need to be validated
Sets a project/dir quota. **Pass/fail:** `repquota` reflects it.

### TC-SHR-06 — `share.delete` guarded (operator) — 🟡 Need to be validated
**Expected:** active sessions & `dangerous: false` → `PRECONDITION_FAILED`; with
`dangerous: true` → `removeExport` + reload after session check. **Pass/fail:** no delete
under active sessions without override.

### TC-SHR-07 — `share.get_active_sessions` (operator) — 🟡 Need to be validated
Lists connected clients (`getSessions`). **Pass/fail:** matches server session state.

---

## H. `auth` namespace (TC-AUTH)

### TC-AUTH-01 — read tools (viewer) — 🟡 Need to be validated
`auth.list_users` (getent passwd), `auth.list_quotas` (repquota -a),
`auth.get_supported_modes`. **Pass/fail:** consistent with the system.

### TC-AUTH-02 — `auth.create_user` matrix (admin) — 🟡 Need to be validated
**Expected:** invalid username → `INVALID_ARGUMENT`; existing user → `CONFLICT`; home
parent missing → `PRECONDITION_FAILED`; valid apply → `useradd` + `chpasswd`.
**Pass/fail:** all four outcomes.

### TC-AUTH-03 — `auth.delete_user` guards (admin) — 🟡 Need to be validated
**Expected:** not found → `NOT_FOUND`; **system user (UID < 1000) → `PRECONDITION_FAILED`**;
valid apply → `userdel` after session check. **Pass/fail:** system accounts protected.

### TC-AUTH-04 — `auth.change_password` (admin) — 🟡 Need to be validated
**Expected:** mismatch → `INVALID_ARGUMENT`; system user → `PRECONDITION_FAILED`; valid →
`chpasswd`. **Pass/fail:** all three.

### TC-AUTH-05 — `auth.set_user_lock` (admin) — 🟡 Need to be validated
Lock/unlock via `usermod -L/-U`; state via `passwd -S`. **Pass/fail:** lock reflected;
system user guarded.

### TC-AUTH-06 — group membership (admin) — 🟡 Need to be validated
`auth.add_to_group`: user/group missing → `NOT_FOUND`; already a member → `CONFLICT`.
`auth.remove_from_group`: not a member → `PRECONDITION_FAILED`. **Pass/fail:** all guards.

### TC-AUTH-07 — `auth.set_quota` / `auth.change_shell` — 🟡 Need to be validated
set_quota (operator): user/share missing → `NOT_FOUND`. change_shell (admin): shell binary
missing → `PRECONDITION_FAILED`. **Pass/fail:** both.

---

## I. `job` namespace (TC-JOB)

### TC-JOB-01 — `job.list` / `job.get` (viewer) — 🟡 Need to be validated
An `apply` that ran async (e.g. `raid.create`) appears with status/progress.
**Pass/fail:** job discoverable and terminal state reached.

### TC-JOB-02 — `job.cancel` (operator) — 🟡 Need to be validated
Cancels a running job. **Pass/fail:** job transitions to cancelled; underlying op stopped
or safely no-op.

---

## J. `config` namespace (TC-CFG) — config-history subprocess

### TC-CFG-01 — read tools (viewer) — 🟡 Need to be validated
`config.list_snapshots`, `config.show_snapshot`, `config.diff_snapshots`.
**Pass/fail:** snapshots enumerated; diff between two ids is coherent.

### TC-CFG-02 — `config.check_drift` (operator) — 🟡 Need to be validated
Detects checksum drift of `/etc/exports`, `/etc/nfs.conf`, netplan vs the last applied
snapshot. **Pass/fail:** an out-of-band edit is reported as drift; a clean box reports none.

### TC-CFG-03 — `config.get_status` (viewer) — 🟡 Need to be validated
Returns store status (baseline + snapshot count). **Pass/fail:** well-formed status JSON.

### TC-CFG-04 — `config.rollback` (admin, plan/apply) — 🟡 Need to be validated
**Expected:** plan classifies risk (`destroying_data` > `changing_access` >
`non_disruptive`); apply performs the S11 file-level restore and reconverges only affected
NFS/network domains. **Storage topology (RAID/FS) is out of config-history scope** — a
rollback must never reformat the array. **Pass/fail:** files restored, storage untouched,
risk surfaced before apply.

---

## Coverage map

| Concern | Cases |
|---|---|
| RBAC (role hierarchy, token mapping, denials) | TC-XC-01, TC-XC-07, TC-NET-04 |
| Apply gating (`mcp.allow_apply`) + plan/apply | TC-XC-02, TC-XC-03, TC-XC-04 |
| Dangerous-flag on destructive tools | TC-XC-08, TC-DSK-05, TC-RAID-04, TC-SHR-06 |
| Idempotency | TC-XC-05 |
| Audit trail | TC-XC-06 |
| Read/observability surface | all TC-SYS, TC-NET-01, TC-HLT-01/02, TC-DSK-01/02, TC-RAID-01, TC-SHR-01/07, TC-AUTH-01, TC-JOB-01, TC-CFG-01/03 |
| Precondition guards (error matrix) | TC-RAID-02/04, TC-SHR-02/06, TC-AUTH-02/03/04/06/07, TC-DSK-02 |
| Config-history / rollback safety (no reformat) | TC-CFG-02, TC-CFG-04 |
| Storage-reset (C1) — see companion file | S1–S11 |

## Sign-off

| Host / profile | Date | Runner | Result | Notes |
|---|---|---|---|---|
| _(pending)_ | | | 🟡 not yet run | All cases still **Need to be validated** |
