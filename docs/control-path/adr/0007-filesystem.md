# ADR-0007: Filesystem object writability and the XFS operation contracts

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md), [ADR-0002](0002-agent-privilege-model.md), [ADR-0003](0003-state-store.md), [ADR-0004](0004-task-engine.md), [ADR-0006](0006-xiraid-array.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §14 (dangerous-flag gate); the **WS6 / M5** workstream in [phase0-sequencing.md](../phase0-sequencing.md) (exit: "Filesystems visible through API; active-share blockers on unmount; drift reported").

## Context

Filesystems are already **visible** through the control path: the S0/S1 collector reads `/etc/systemd/system/*.mount` units and publishes status-only observed rows (id = the mount-unit name). What WS6 adds is the **mutation surface** — the five reserved agent stubs `fs.create`, `fs.mount`, `fs.unmount`, `fs.grow`, `fs.set_quota_mode` plus DELETE-as-unmanage — on the S2 task engine, with the active-share blockers the milestone names, and an observe enrichment that makes the contract's `uuid`/`size_bytes`/`free_bytes` real.

The day-1 installer (`raid_fs` role) defines what an xiNAS filesystem IS: **stripe-aligned XFS with an external log device** —

```
mkfs.xfs -f -L <label> -d su=<su>k,sw=<sw> -l logdev=<log_device>,size=<log_size> -s size=<sector> <data_device>
```

— mounted via a **systemd `.mount` unit** (path-escaped name, `Requires=`/`After=` the device units, performance + quota flags in `Options=`, `WantedBy=local-fs.target`), with `su`/`sw` auto-derived from the backing array's geometry. Day-2 filesystems must be indistinguishable from day-1 ones, so this ADR locks day-1 parity as the contract.

Decisions taken during brainstorming (2026-06-10), which this ADR records:
- **Build scope:** one S5 plan covers all operations (create, mount, unmount, grow, set_quota_mode, delete-as-unmanage) + the status enrichment + blockers.
- **Create surface:** full day-1 parity — `label`, `log_device` (+`log_size`), `sector_size`, `su_kb`/`sw` overrides with auto-derivation from the backing array's observed geometry.
- **Destruction:** DELETE is **unmanage-only** (config removal, data untouched). The ONLY data-destroying path is `fs.create` with **`force: true`** onto a device carrying an existing filesystem — gated by the engine's `dangerous: true` (§14), the `xfs_force_mkfs` analog.

## Decision

### Identity

**`id == the systemd mount-unit name`** derived from the mountpoint by systemd path escaping (`/mnt/data` → `mnt-data.mount`) — exactly what the observe collector already uses, so created filesystems and observed rows share one identity with zero mapping. The control path implements systemd's escaping rules (slash→dash, leading slash stripped, non-alphanumerics → `\xNN`) in the shared lib and unit-tests them against `systemd-escape -p` semantics. One filesystem per mountpoint follows for free (unit names are unique).

### Observation normalization (prerequisite — S5 review P0)

The contract everything below depends on — observed Filesystem rows carrying `mountpoint`, `backing_device`, and a mounted flag under **`status`** — is today true **only for fixture rows**. On a real host the parser emits `mountpoint`/`backing_device` under a `spec` block that the convergence adapter then DROPS (it forwards `{kind, id, status}` only), so live observed rows carry nothing but `mount_unit_name`/`mount_unit_enabled`. This also means ADR-0006's array-delete dependency walk (which reads `status.backing_device`/`status.mountpoint`) is currently blind on real hosts — a latent S4 defect this ADR's prerequisite fixes.

**Decision:** the observed Filesystem object is **status-only** with these facts canonical under `status`: `mountpoint`, `backing_device`, `fs_type`, `mount_options`, **`mounted`** (the api-v1.yaml schema-required flag; the duplicate `currently_mounted` property is REMOVED from the contract), `mount_unit_name`, `mount_unit_enabled`, `mount_unit_state`, plus the §Observe-enrichment fields. S5's first code task reshapes the parser to status-only, fixes the convergence passthrough, makes the collector emit the full set, migrates the S4 delete provider + its fixtures from `currently_mounted` to `mounted`, and updates the schema/fixture — one normalization, all consumers together.

### Schema extension (spec — create-time fields added to api-v1.yaml)

`Filesystem.spec` (existing: `fs_type: xfs`, `backing_device`, `mountpoint`, `mount_options[]`, `quota_mode`, `owner_policy`) gains:

| Field | Type | Meaning |
|-------|------|---------|
| `label` | string? | `mkfs.xfs -L`; defaults to the escaped mountpoint leaf. |
| `log_device` | string? | External XFS log device (`-l logdev=`); MUST be an observed `XiraidArray` volume when set. Also appended to mount `Options=` as `logdev=…` and `Requires=`'d by the unit. |
| `log_size` | string? | Log size cap (e.g. `1G`); only with `log_device`. At mkfs time the executor clamps it to the log device's actual size (`blockdev --getsize64`) — the day-1 `_effective_log_size` formula, so small log arrays cannot re-trigger the failure the role already fixed. |
| `sector_size` | integer? | `-s size=`; default 4096. |
| `su_kb` | integer? | Stripe unit override; **auto-derived** from the backing array's observed `strip_size_kib` when omitted. |
| `sw` | integer? | Stripe width override; **auto-derived** as data-drive count (members − parity, parity by level: raid5→1, raid6→2, raid7→3, raid50/60/70 → per-group parity × groups, raid10 → members/2, raid0 → 0... see the lib table) when omitted. |
| `force` | boolean (default false) | Overwrite an existing filesystem on the device. `force: true` flips the plan to `risk_level: destructive` → the engine requires `dangerous: true` at apply. |

`spec.backing_device` (and `log_device`) MUST resolve to an observed `XiraidArray`'s `status.volume_path` — the control path does not format arbitrary devices, and this keeps the Array←Filesystem dependency graph (ADR-0006's delete walk) sound.

### Phase 0 writability matrix

| Field | Create | Live (PATCH) | Notes |
|-------|:------:|:------------:|-------|
| `mountpoint`, `backing_device`, `log_device`, `label`, `su_kb`, `sw`, `sector_size`, `log_size`, `fs_type` | ✅ | ❌ `UNSUPPORTED` (`fs_identity_immutable`) | Re-create to change. |
| `mounted` (PATCH intent) | n/a | ✅ | → `fs.mount` / `fs.unmount`. |
| `quota_mode` | ✅ | ✅ | → `fs.set_quota_mode` (remount — client-disruptive). |
| `grow: true` (PATCH intent) | n/a | ✅ | → `fs.grow` (online `xfs_growfs`). |
| `mount_options` | ✅ | ❌ in S5 (`UNSUPPORTED`) | General option editing is future work; quota flags move via `quota_mode`. |
| `owner_policy` | accepted, applied at first mount (chown/chmod) | ❌ in S5 | |
| `status.*` | server-managed | server-managed | |

**One operation per PATCH:** a PATCH spec carrying more than one intent key (`mounted`, `quota_mode`, `grow`) is `INVALID_ARGUMENT` — each maps to a distinct operation kind/executor and plan.

### Per-operation contracts

All on the S2 engine; freshness binds at the route as in S4 (`expected_revision = 0` for create; = current observed revision otherwise). Blocker re-checks at apply filter only the engine-owned `dangerous_flag_required`.

**Create** (`fs.create`, `POST /filesystems`).
- Plan blockers: `mountpoint_invalid` (not absolute / escaping fails), `mountpoint_taken` (an observed Filesystem with that unit name / mountpoint), `backing_array_not_found`, `backing_device_in_use` (another observed Filesystem on it), `log_array_not_found`, `stripe_underivable` (no override and the backing array's geometry is unknown), plus the advisory `dangerous_flag_required` when `force: true`.
- `risk_level`: `non_disruptive` (`force: false`) / **`destructive`** (`force: true`); `rollback_model: non_disruptive` / `unsupported` respectively.
- `affected_resources = [ Filesystem#<unit> (primary), XiraidArray#<backing>, XiraidArray#<log>? ]` — the arrays are leased so a concurrent array delete cannot race the format.
- Executor: `preflight` (devices exist; **blkid**: an existing filesystem on the data device fails the run unless the spec carries `force: true` — the gate's teeth at the host) → `mkfs` (the day-1 command) → `write_unit` (render the `.mount` + `daemon-reload`) → `mount` (`systemctl enable --now`; apply `owner_policy`) → `verify` (mountinfo shows it mounted). Rollback (live-state): stop/disable + remove a unit we wrote + `daemon-reload`; a completed mkfs is not reverted (with `force` the old data was knowingly destroyed; without, the device was empty) — the device is simply left formatted and unmanaged.

**Mount** (`fs.mount`, PATCH `{ mounted: true }`): blockers `backing_array_unhealthy` (observed array not optimal/rebuilding). Executor: `enable --now` + verify mounted. `non_disruptive`.

**Unmount** (`fs.unmount`, PATCH `{ mounted: false }`): blockers **`dependent_share_active`** (observed NfsSessions whose `export_path` is at/under the mountpoint) and **`mountpoint_exported`** (observed ExportRules at/under the mountpoint — an exported path holds the mount busy); blast radius (shares/exports/sessions) always in the diff. `risk_level: changing_access`. Executor: `systemctl stop` (+`disable`) → verify unmounted; an `EBUSY` failure rolls back by restarting the unit.

**Grow** (`fs.grow`, PATCH `{ grow: true }`): blocker `fs_not_mounted` (xfs_growfs needs the mountpoint). Executor: `xfs_growfs <mountpoint>` → verify `size_bytes` did not shrink. `non_disruptive`; rollback no-op (growth is one-way but data-safe).

**Set quota mode** (`fs.set_quota_mode`, PATCH `{ quota_mode }`): quota flags are MOUNT options, so this **rewrites the unit's `Options=`** (swap `uquota|gquota|pquota`/none) + `daemon-reload` + **restart** (umount+mount) → client-disruptive: `risk_level: changing_access` with the unmount blockers applied. Rollback: restore the captured previous unit content + restart.

**Delete = unmanage** (`fs.delete`, `DELETE /filesystems/{id}`): blocker `fs_mounted` (unmount first). Removes the unit file + `daemon-reload`; **data untouched** (`risk_level: changing_access`, no dangerous flag). Rollback: rewrite the captured unit + `daemon-reload`.

### Observe enrichment

The probe gains: `blkid` on the unit's `What=` device → `uuid` + `label` (+ fs presence), `statfs` on the mountpoint when mounted → `size_bytes`/`free_bytes`, and a `/proc/self/mountinfo` cross-reference → authoritative `currently_mounted` + `effective_mount_options`. This makes the contract's required `status.uuid/size_bytes/free_bytes` real and gives "drift reported" its observable substance (desired-vs-observed comparison machinery itself remains WS9).

### Host-command execution and the agent-unit compatibility delta

The executors run host commands (`mkfs.xfs`, `xfs_growfs`, `blkid`, `blockdev`, `systemctl`, unit-file writes) through one **`agent/fs/host.ts` adapter** with an injectable `runCommand` + injectable unit-dir/file I/O — the subprocess analog of ADR-0006's injectable gRPC transport. A file-backed **fake host** (fixture mode + e2e, like the fake xiRAID transport) simulates blkid results, device sizes, written units, mounted state, and an op log; deterministic hooks drive the failure paths.

**The sandbox does NOT suffice as-is** (S5 review P0). The live unit runs `ProtectSystem=strict` with `ReadWritePaths=/run/xinas /var/log/xinas` only, `NoNewPrivileges`, `CapabilityBoundingSet=CAP_CHOWN`, namespace and syscall restrictions. The audited compatibility delta:

| Need | Verdict under the current unit | Delta |
|------|-------------------------------|-------|
| Write/remove `.mount` units + `systemctl enable` symlinks under `/etc/systemd/system` | **blocked** (`ProtectSystem=strict`) | `ReadWritePaths=/etc/systemd/system` — **the one unit change**, shipped in its own commit with `Requires-Rebuild: xinas_agent`. |
| Mountpoint directory creation | not needed by the agent | systemd (PID1, unconfined) creates `Where=` directories itself when starting a `.mount`. |
| Raw block writes for `mkfs.xfs`/`blkid`/`blockdev` on `/dev/xi_*` | allowed | `strict` leaves `/dev` writable; `PrivateDevices` is NOT set; uid 0 owns the nodes (no extra capability needed). |
| `mount`/`umount` themselves | not performed by the agent | delegated to PID1 via `systemctl start/stop` over the already-allowed `AF_UNIX` dbus socket. |
| `xfs_growfs` (ioctl on the mounted fs) / `statfs` | allowed | new mounts propagate rw into the agent's namespace; `ioctl` is in the `@system-service` filter. |
| `owner_policy` chown/chmod on the fresh fs root | allowed | `CAP_CHOWN` is retained; root owns the fresh root inode. |
| Spawning `mkfs.xfs`/`xfs_growfs`/`blkid`/`blockdev` | allowed | the agent already execs `lsblk`/`udevadm` under the same filter. |

Because the dev/CI environment has no systemd, the delta is **proven by**: (a) the audit table above against the unit text, (b) unit/e2e coverage over the fake host, and (c) a written Ubuntu hardware smoke checklist (create→mount→grow→quota→unmount→unmanage on a lab node) attached to the plan — an explicitly tracked residual until run.

## Consequences

**Pros:** day-2 filesystems are byte-for-byte day-1 filesystems (same mkfs geometry, same unit shape); one destruction path, engine-gated; identity needs no mapping table; the Array↔Filesystem dependency graph closes from both sides (array delete already walks `status.backing_device`; fs create leases the arrays).

**Cons:** `mount_options` editing is deferred (quota only); `set_quota_mode` requires a client-visible remount; systemd escaping must be implemented faithfully (unit-tested against `systemd-escape` semantics); the unit-file is the single source of fs config — a hand-edited unit shows up as observed state but no drift alarm until WS9.

**Not decided here:** shrink (XFS cannot), fs check/repair (`xfs_repair`) flows, general mount-option editing, multi-device/dm layouts, non-XFS types.

## Rejected alternatives

- **Direct `mount(8)`/fstab instead of systemd units** — diverges from day-1, loses reboot persistence semantics and the device-dependency ordering the units encode.
- **DELETE with an optional wipe** — two destruction paths to gate; rejected for the single gated create-overwrite.
- **Plan-time blkid via an on-demand agent RPC** — same privilege-split issue as ADR-0006's import amendment; the `force` flag makes the operator's intent explicit at plan time instead, and the executor's blkid enforces it at the host.
- **Arbitrary `backing_device` paths** — breaks the dependency graph and invites formatting the wrong disk; Phase 0 formats only observed array volumes.

## Implementation notes (S5 plan)

The **observation normalization** (§above) is the first code task — parser/convergence/collector/schema/S4-consumer migration together. Then: shared `lib/fs/{schema,validate,unit}.ts` (escape + render + parse already partially exists in `lib/parse/systemd-unit.ts`); `lib/fs/derive.ts` (su/sw table); `agent/fs/host.ts` (+`blockdevSize` for the log clamp) + `fake-host.ts`; providers in `api/plan/providers/filesystem.ts`; routes `api/routes/filesystems.ts` (POST/PATCH/DELETE leave the stub loop); executors in `agent/task/filesystem-executor.ts`; probe enrichment in `agent/probe/filesystem.ts`; stub supersession for the five `fs.*` names (S2-T0 pattern); contract fixture `Filesystem.json`; the agent-unit delta commit (`Requires-Rebuild: xinas_agent`). Testing mirrors S4, and the e2e must PROVE both unmount blockers: the fixture NFS probe gains `nfs-sessions.json` **and** `nfs-exports.json` passthrough (it returns empty today, which would let the milestone's active-share blocker go untested) so `dependent_share_active` and `mountpoint_exported` both fire against seeded state.
