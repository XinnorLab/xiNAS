# xiNAS — Filesystem & NFS Shares Management from the TUI

This document covers the two day-2 screens that sit between the operator and the data path: **`FilesystemScreen`** (mounts XFS on xiRAID block devices and toggles quotas) and **`NFSScreen`** (manages `/etc/exports` entries and the kernel server's view of them). It is the counterpart to [Storage/raid-management-spec.md](raid-management-spec.md) — same TUI app, same helper boundary, but a different state surface.

Like the RAID screen, both have migrated onto the control path: reads are `GET /api/v1/{filesystems,shares,arrays}` and **every write is a `plan_apply_wait`** against `xinas-api`. What is left of the old helper backbone is now a thin residue:

- **Control-path client** (`app.control`) — the actual service boundary for both screens.
- **`xfs_helpers`** (in-process subprocess wrappers) — reduced to read/pure helpers: `is_path_under` in both screens, plus `run_async_cmd` + `findmnt` in `NFSScreen`'s path picker. The `mkfs.xfs` / mount-unit / `systemctl` / quota-toggle helpers are **no longer called by either screen** (§2.1).
- **`xinas-nfs-helper`** (out-of-process Unix-socket daemon) — still the **only writer** of `/etc/exports` and `/etc/nfs.conf`, but now reached *through the agent*. The only direct client call left in these screens is `nfs.list_sessions()` (§4.8).
- **Audit + snapshot helpers** — every write path logs to `/var/log/xinas/audit.log` and records an advisory snapshot.

Sources:

- Screens: [xinas_menu/screens/filesystem.py](../../xinas_menu/screens/filesystem.py), [nfs.py](../../xinas_menu/screens/nfs.py), [storage.py](../../xinas_menu/screens/storage.py)
- Control-path client: [xinas_menu/api/control_client.py](../../xinas_menu/api/control_client.py) (`ControlClient.result` / `.get` / `.plan_apply_wait`, `quote_id`)
- Control-path contract: [docs/control-path/api-v1.yaml](../control-path/api-v1.yaml), [s8-clients-spec.md](../control-path/s8-clients-spec.md), [ADR-0007](../control-path/adr/0007-filesystem.md) (filesystem writability matrix)
- XFS helpers: [xinas_menu/utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)
- NFS helper client: [xinas_menu/api/nfs_client.py](../../xinas_menu/api/nfs_client.py)
- NFS helper daemon: [xiNAS-MCP/nfs-helper/nfs_helper.py](../../xiNAS-MCP/nfs-helper/nfs_helper.py), [nfs_exports.py](../../xiNAS-MCP/nfs-helper/nfs_exports.py), [nfs_conf.py](../../xiNAS-MCP/nfs-helper/nfs_conf.py), [nfs_quota.py](../../xiNAS-MCP/nfs-helper/nfs_quota.py), [nfs_sessions.py](../../xiNAS-MCP/nfs-helper/nfs_sessions.py)
- Cross-cutting helpers: [utils/audit.py](../../xinas_menu/utils/audit.py), [utils/snapshot_helper.py](../../xinas_menu/utils/snapshot_helper.py)
- Installer counterpart: [Installer/fs-exports-spec.md](../Installer/fs-exports-spec.md)

---

## 1. Where these screens live

```
Main Menu → Storage (StorageScreen) → 2 NFS Management   (NFSScreen)
                                    → 4 Filesystem       (FilesystemScreen)
```

Both screens are pushed onto the Textual stack from `StorageScreen.on_navigable_menu_selected()` (see [storage.py](../../xinas_menu/screens/storage.py)). Closing them with `0` / `Esc` returns to the Storage sub-menu.

Both are mounted on top of the same `app.control` (control-path client), `app.nfs` (helper socket client), `app.audit` (audit logger), `app.snapshots` (snapshot recorder) provided by the `XiNASApp` shell. `app.grpc` is also on the shell but **neither screen uses it**.

---

## 2. Boundaries these screens cross

The screens never write to `/etc/exports`, `/etc/nfs.conf`, `/etc/systemd/system/*.mount`, `/proc/fs/nfsd/*` or `/sys/class/block/*` directly. Every mutation is a `plan_apply_wait` against `xinas-api`, which dispatches to the agent's executors; the executors are what run `mkfs.xfs`, write mount units, call `systemctl`, and talk to the NFS helper socket. What is left in-process is described below.

### 2.1 `xfs_helpers` — in-process async subprocess

[utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py). Every public function returns either `(ok: bool, stdout: str, stderr: str)` for raw subprocess calls or `(ok: bool, err: str)` for higher-level operations — the same `(ok, …, error)` convention the NFS client uses.

**What these two screens still call — read and pure helpers only:**

| Helper | Underlying command | Used by |
|---|---|---|
| `is_path_under(path, mountpoint)` | pure-Python containment test | `FilesystemScreen` (Delete FS share scan), `NFSScreen` |
| `run_async_cmd(*args, timeout=…)` | `asyncio.create_subprocess_exec` | `NFSScreen` only, for the one `findmnt -t xfs -n -o TARGET,SOURCE` that populates the Add-Share path picker |

**What they no longer call.** These helpers still exist in the module — the installer-parity logic they encode has moved to the agent's fs-executor, and calling them from the TUI would bypass the plan/apply, audit, and task-rollback path:

| Helper | Now done by |
|---|---|
| `mkfs_xfs`, `get_device_size_bytes`, `check_existing_filesystem` | fs-executor preflight + mkfs stages (`POST /api/v1/filesystems`) |
| `create_mount_unit`, `mount_filesystem` | fs-executor unit + mount stages |
| `unmount_filesystem` | `PATCH /api/v1/filesystems/{id}` `{"mounted": false}` + `DELETE` to unmanage |
| `calculate_parity_disks`, `calculate_stripe_width`, `build_mount_options` | api-side derivation from the array (`su_kb` / `sw` omitted from the spec — §3.3) |
| `update_mount_unit_quota` | `PATCH /api/v1/filesystems/{id}` `{"quota_mode": …}` → `fs.set_quota_mode` (§3.5) |
| `find_mounts_using_raid` | still used, but by the **RAID** screen only ([raid-management-spec §2.4](raid-management-spec.md#24-xfs_helpers--async-subprocess-helpers)) |

`_quota_flags(options)` in `filesystem.py` replaced the module's `get_quota_status` for parsing the observed option list.

The executor's mount/unmount work operates on systemd `.mount` units, not on `mount(2)` directly. This matches what `raid_fs` lays down at install time — see [Installer/fs-exports-spec.md §1.8](../Installer/fs-exports-spec.md#18-mountpoint-and-systemd-mount-unit). It is the reason the FS lifecycle survives reboots without anything in `/etc/fstab`.

### 2.2 `xinas-nfs-helper` — Unix-socket daemon

[xiNAS-MCP/nfs-helper/nfs_helper.py](../../xiNAS-MCP/nfs-helper/nfs_helper.py). A single-threaded-accept, per-connection-thread daemon listening on `/run/xinas-nfs-helper.sock` (mode `0660`). One JSON request, one JSON response, then connection closes.

Installed by the `xinas_mcp` Ansible role; runs `After=network.target nfs-kernel-server.service` with `Requires=nfs-kernel-server.service` and `ProtectHome=true` (full hardening is intentionally relaxed — see the comment in the unit). The `RuntimeDirectory=xinas-nfs-helper` directive makes systemd create `/run/xinas-nfs-helper/` for the socket on every start.

Op handlers exposed (every one returns `{"ok": …, "result": …, "request_id": …}` or an error envelope with one of `INVALID_ARGUMENT`, `NOT_FOUND`, `UNSUPPORTED`, `INTERNAL`):

| `op` | Module | Behavior |
|---|---|---|
| `list_exports` | `nfs_exports.list_exports()` | Parse `/etc/exports` under fcntl lock; return `[{path, clients: [{host, options}]}, …]` |
| `add_export` | `nfs_exports.add_export()` + `_exportfs_reload()` | Path validation (`os.path.isabs`, `os.path.isdir`), optional `create_path` single-level `mkdir`, idempotent insert under lock, `exportfs -r` |
| `remove_export` | `nfs_exports.remove_export()` + `_exportfs_reload()` | Remove by `path` under lock, `exportfs -r` |
| `update_export` | `nfs_exports.update_export()` + `_exportfs_reload()` | Merge-patch the entry, `exportfs -r` |
| `list_sessions` | `nfs_sessions.list_sessions()` | Read `/proc/fs/nfsd/clients/*/info` (fallback `auth.unix.ip`) |
| `get_sessions` | `nfs_sessions.get_sessions_for_path()` | Filter sessions by export path |
| `set_quota` | `nfs_quota.set_user_quota()` / `set_project_quota()` | `xfs_quota -x` wrappers; updates `/etc/projects` + `/etc/projid` for project quotas |
| `reload` | `_exportfs_reload()` | `exportfs -r` only |
| `fix_nfs_conf` | `nfs_conf.set_nfs_conf()` + optional `restart_nfs_server()` | In-place update of `(section, key)` pairs under lock, with optional `systemctl restart nfs-server` |

Locking is per-file:

- `/run/xinas-exports.lock` — held with `fcntl.LOCK_EX` for every `/etc/exports` read/write.
- `/run/xinas-nfs-conf.lock` — held with `fcntl.LOCK_EX` for every `/etc/nfs.conf` mutation.

Writes are atomic: `nfs_exports.py` writes via direct `open(…, 'w')` (after the lock makes that safe), and `nfs_conf.py` uses `mkstemp + shutil.copymode + os.replace` so concurrent readers never see a half-written config.

The daemon also runs a **startup health check** — it warns if `/usr/sbin/exportfs` is missing and runs `exportfs -s` on first start, logging whether the NFS server appears functional. This is what surfaces "NFS not installed" early instead of letting it fail at the first `add_export`.

### 2.3 Client side — `NFSHelperClient`

[xinas_menu/api/nfs_client.py](../../xinas_menu/api/nfs_client.py). Synchronous Unix-socket client. Newline-delimited JSON, one round-trip per call, `10.0 s` timeout.

The TUI calls it from `loop.run_in_executor(None, …)` since the socket I/O is blocking. The screens never `await self.app.nfs.…` directly — every helper call is wrapped in an executor coroutine so the Textual event loop stays responsive.

**Scope note.** These two screens now reach this client exactly once, in Active Sessions (§4.8); the Users screen also calls `set_quota`. Every share and filesystem *mutation* reaches the same daemon through the agent instead. The client is documented in full because the agent's nfs-executor speaks the identical protocol ([agent/task/nfs-helper-client.ts](../../xiNAS-MCP/src/agent/task/nfs-helper-client.ts)), so these error strings are still what a failing share write ends up carrying.

Error mapping in the client:

| Helper-side failure | What `NFSHelperClient._request` returns |
|---|---|
| `FileNotFoundError` (socket absent) | `(False, None, "NFS helper socket not found: /run/xinas-nfs-helper.sock")` |
| `ConnectionRefusedError` | `(False, None, "NFS helper is not running (connection refused)")` |
| `socket.timeout` (no response in 10 s) | `(False, None, "NFS helper timed out")` |
| Bad JSON response | `(False, None, "bad JSON from NFS helper: …")` |
| `{"ok": false, "error": "…"}` | `(False, None, "<error string>")` |

These short-circuits used to let the RAID-delete and FS-delete teardowns refuse work cleanly when the helper was down. Those paths no longer call the client at all — a teardown's share step is `DELETE /api/v1/shares/{id}`, and a helper that is down now surfaces as that step's task failure, which stops the sequence (§3.4).

---

## 3. FilesystemScreen

[xinas_menu/screens/filesystem.py](../../xinas_menu/screens/filesystem.py).

### 3.1 Menu

| Key | Action | Handler |
|---|---|---|
| 1 | Show Filesystems | `_show_filesystems()` — `GET /api/v1/filesystems` |
| 2 | Create Filesystem | `_create_filesystem_wizard()` |
| 3 | Delete Filesystem | `_delete_filesystem()` |
| 4 | Manage Quotas | `_manage_quotas()` |
| 0 | Back | pop screen |

**This screen does not call the xiRAID gRPC client at all.** Reads are control-path `GET`s and every write is a `plan_apply_wait`. RAID arrays are inputs, enumerated by `GET /api/v1/arrays` at the start of the Create wizard (it used to be `raid_show(extended=True)`).

### 3.2 Show Filesystems

`_show_filesystems()` rides the S8 control-path read `GET /api/v1/filesystems`; the screen parses the rows and prints `target`, `source`, and `options` per row. Read-only.

**Degraded-backend honesty.** The screen fetches the full envelope (`control.get`, not `control.result`) and inspects its `warnings`. When the envelope carries `DEGRADED_BACKEND_UNAVAILABLE` — the `Filesystem` collector is errored (control-path contract: [s8-clients-spec §5.1](../control-path/s8-clients-spec.md)) — it renders a distinct banner above any rows, and when the list is empty it **replaces** the `No XFS filesystems found.` empty-state with that message, so an unobservable backend never reads as "genuinely none".

### 3.3 Create Filesystem wizard

The wizard mirrors what the installer's `raid_fs` role does (see [Installer/raid-spec.md §7](../Installer/raid-spec.md#7-raid_fs--license-arrays-filesystem-mount)) but runs against the *current* RAID state.

**Pre-check.** Two control-path reads, no `findmnt` and no gRPC:

1. `GET /api/v1/arrays` enumerates arrays (`_arrays_from_api`). A `ControlPathError` here aborts on an OK-only `Failed to query RAID arrays.` dialog.
2. `_unused_arrays(arr_rows)` runs `GET /api/v1/filesystems` → `_volumes_in_use()`, collecting every volume path already consumed by a managed filesystem, as a **data device** (`status.backing_device`) *or* as a **log device** (a `logdev=` entry in its effective mount options). Arrays whose `volume_path` is in that set are filtered out. A `ControlPathError` **aborts** on an OK-only `Create Filesystem — Aborted` dialog.

   That read used to degrade to an empty set, and the failure it enabled ran through the executor rather than stopping at the screen: the wizard offered arrays that already carried a filesystem, the create failed in the agent's `blkid` preflight, and this screen offers a **force retry** as that failure's remedy (§3.3, *force*) — a retry that overwrites the existing filesystem. The preflight held, but a read that never answered was walking the operator toward a destructive dialog.

If fewer than 2 free arrays remain, the wizard aborts with "Filesystem creation requires at least 2 RAID arrays (one for data, one for log)."

**Step 1 — pick the data array.** Arrays are sorted with the data-classified ones first (`_classify_role()` maps levels `5 / 6 / 50 / 60` → `data`, anything else → `log`). The label (`_array_label`) shows `name  (RAID-N, M drives, KKB strip)  [role]` so the operator can spot the right candidate without remembering levels.

**Step 2 — pick the log array.** Same picker over the remaining arrays, with log-classified ones first. If only one array is left, the wizard skips the picker and just confirms the auto-pick.

**Step 3 — filesystem label.** `InputDialog`, default `nfsdata`.

**Step 4 — mountpoint.** `InputDialog`, default `/mnt/data`. Must start with `/` — otherwise the wizard aborts with an error notification.

**Geometry is derived server-side.** The screen does **not** compute stripe geometry any more — there is no `calculate_stripe_width` call and no `build_mount_options` call in `filesystem.py`. It sends a structured spec and lets the fs-executor derive what it can from the array:

| Spec field | Value the wizard sends |
|---|---|
| `backing_device` | the data array's `volume_path` |
| `log_device` | the log array's `volume_path` |
| `mountpoint`, `label` | steps 4 and 3 |
| `fs_type` | `"xfs"` |
| `log_size` | `"1G"` (clamped to the log device at mkfs) |
| `sector_size` | `4096` |
| `mount_options` | `_DEFAULT_MOUNT_OPTIONS` — `noatime, nodiratime, logbsize=256k, largeio, inode64, swalloc, allocsize=131072k` |
| `quota_mode` | `"uquota"` |

`su_kb` and `sw` are **omitted**, so the api auto-derives them (`sw` = data drives = members − parity; see the `Filesystem.spec` schema in [api-v1.yaml](../control-path/api-v1.yaml)). `logdev=` and `uquota` are **not** in `mount_options` either: they ride the structured `log_device` / `quota_mode` fields, which is what the fs.create contract expects. The effective result still matches the [Installer/fs-exports-spec.md §1.7](../Installer/fs-exports-spec.md#17-mount-options-decoded) install-time set, so a TUI-created FS is indistinguishable from an Ansible-created one — but it is reconstructed from structured fields, not passed through as one literal string.

The confirmation summary and the success banner render a flat option string for the operator —

```
defaults,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k,logdev=<log_device>,uquota
```

— and show `su (strip unit)` from the data array's `strip_size` (fallback `128`) with `sw` printed literally as `derived from array geometry`. **Both are display-only**: neither the string nor `su_kb` is part of the submitted spec.

**Step 5 — confirmation.** Summary shows everything: arrays + roles, mountpoint, the geometry above, and that option string. On confirm the screen submits **one control-path plan→apply** — `POST /api/v1/filesystems` with the spec in the table, via `control.plan_apply_wait`, with a `TaskWaitDialog` showing task-state progress and offering cancel (S10). The executor runs preflight → mkfs → unit → mount as task stages.

**Failure handling.** Three distinct exits:

1. **Cancelled** (`TaskCancelled`, caught before `TaskFailed` — it is a subclass): the view reports "cancelled — partial work rolled back"; no retry is offered.
2. **Destruction gate** (`TaskFailed` whose `error_message` is the fs-executor preflight gate — the device `already carries a … filesystem`, [xiNAS-MCP/src/agent/task/fs-executor.ts](../../xiNAS-MCP/src/agent/task/fs-executor.ts)): the screen offers the **force-recreate consent** — a Yes/No dialog quoting the task's failure detail and warning that retrying with `force: true` DESTROYS the existing data on the device. On Yes it re-submits the same spec with `force: true` and `dangerous=True`. This is the *only* failure that offers the retry.
3. **Any other failure** (`TaskFailed` with any other detail — live mountpoint, existing unit, mkfs/mount error — or `PlanBlocked` / `ApiError` / `TransportError`): an OK-only error dialog shows `Filesystem creation failed:` plus the exception text, which includes the failing stage's message (see [s8-clients-spec §S8c](../control-path/s8-clients-spec.md), "Task-failure detail"). No force retry is offered — retrying with force cannot fix, say, an occupied mountpoint, and offering it there trains operators to click through a destructive consent.

Rollback of a failed create is the task's own (the executor rolls back its completed stages per s2-task-envelope-spec); the screen performs no cleanup of its own.

**Side effects.** On full success:

- `audit.log("fs.create", "label=<L> data=<D> log=<L> mount=<M>", "OK")`
- `snapshots.record("fs_create", diff_summary=...)`
- A green success banner replaces the wizard content; a toast confirms.

### 3.4 Delete Filesystem

Same shape as the RAID-delete teardown in [Storage/raid-management-spec.md §6](raid-management-spec.md#6-delete-array--ordered-stop-on-failure-teardown): an ordered, **stop-on-failure sequence of control-path API operations**, each one a `plan_apply_wait`, with **no cross-step rollback**. The authoritative contract for both is [s8-clients-spec §6](../control-path/s8-clients-spec.md#6-tui-composite-teardown-t13). The only structural difference from the RAID flow is that this one has no array to destroy at the end, and no cancellable `TaskWaitDialog` — every step here is short.

**Discovery.** `_list_filesystems()` (`GET /api/v1/filesystems`, adapted by `_fs_rows_from_api`) enumerates the *managed* filesystems — mount units the control path knows about, not whatever `findmnt` currently reports. The operator picks one from a `SelectDialog` whose labels are `<mountpoint or id>  (<backing_device>)`. A `ControlPathError` aborts on an OK-only `Could not load filesystems.` dialog; an empty list aborts on `No XFS filesystems found.`

> This picker calls the banner-less `_list_filesystems()`, not `_list_filesystems_with_status()`. Under a degraded backend (`DEGRADED_BACKEND_UNAVAILABLE`) the list arrives empty and the operator is told `No XFS filesystems found.` — the one place in this screen where a degraded read is not distinguished from a genuinely empty one. Show Filesystems (§3.2) does render the banner.

**Dependency check — fail-closed.** `_shares_on_mountpoint(mountpoint, fs_label)` runs `GET /api/v1/shares`; every share whose `spec.path` is under the chosen `mountpoint` (`is_path_under`, not a bare `startswith` — `/mnt/data2` is not under `/mnt/data`) is recorded in `affected_shares` as `{id, path}`. This catches both the root export and any sub-directory exports rooted at the same mount. The check is skipped for a filesystem with no mountpoint, which returns an empty list: nothing can be rooted under a mountpoint that does not exist.

A `ControlPathError` **aborts the deletion** — `Delete Filesystem — Aborted`, carrying the underlying error and stating that the filesystem was not deleted and nothing was changed — and the flow returns before the first confirmation. It previously degraded to an empty list, which is not the same as an empty answer, and the rest of the flow reads that list as fact twice over: the second `FINAL CONFIRMATION` renders only when it is non-empty, and step 1 iterates it to remove the shares. A control path that was down therefore downgraded the teardown to a single confirmation, skipped the share removal entirely, and unmounted and unmanaged the filesystem under live NFS exports. There is no server-side backstop for this one — the filesystem plan provider carries no share blocker — so this read is the only gate.

**Confirmation.**

1. First dialog: lists affected shares, ends with the warning that the FS will be unmounted and its unit removed. Note the exact wording: *"Data on disk is NOT erased."* — unmanaging removes the mount unit and does not touch the underlying XFS contents, so re-creating a mount unit on the same `/dev/xi_<name>` would re-attach the existing filesystem.
2. If `affected_shares` is non-empty, a second `FINAL CONFIRMATION` dialog restates the count.

**Teardown order.** Strictly, each step rendered into the teardown progress view with its task's stage transitions:

```
Step 1: for each affected share   DELETE /api/v1/shares/{id}
Step 2: the filesystem            PATCH  /api/v1/filesystems/{id} {"mounted": false}   (only if mounted)
Step 3: the filesystem            DELETE /api/v1/filesystems/{id}                      (unmanage)
```

Shares go first: unmounting under a live export would orphan it. Step 2 is skipped outright for a filesystem the API already reports as not mounted. Ids are percent-encoded with `quote_id()` like every other id (s8-clients-spec §6).

**Partial teardown — no cross-step rollback.** The sequence stops at the first failing step, and everything already completed stays completed. Step 1 is a plain `for` loop over `plan_apply_wait` calls; a `ControlPathError` from any step calls `_teardown_failed(...)` and returns. There is no bookkeeping of removed shares to undo, and the screen never re-creates a share or re-mounts a filesystem — those paths do not exist in `filesystem.py`. Rollback belongs to the task engine, one apply at a time: each step's apply either lands or rolls itself back where its executor supports that, and the TUI does not stack a second, weaker rollback layer on top of steps that already succeeded.

*What the operator is told.* `_teardown_failed` appends two lines to the progress view —

```
  FAILED: <error>
  Teardown stopped — remaining steps were not run.
```

— and raises an OK-only dialog titled **`Delete Filesystem — Stopped`** naming the step that failed, the error, and, verbatim: *"Teardown stopped at this step. No cross-step rollback; the failed task rolled itself back where supported."* The progress view above it still shows every step that did complete, in order.

*Manual recovery.* Recovery is an ordinary forward operation, not an undo:

| Stopped at | State | Recovery |
|---|---|---|
| Step 1, share *k* | shares 1..*k-1* deleted; the filesystem still mounted and managed | Re-create the missing shares from the NFS screen (§4.5), or clear the blocker and re-run Delete Filesystem. |
| Step 2 (unmount) | all shares deleted; filesystem still mounted and managed | Usually a busy mount. Clear the blocker and re-run Delete Filesystem, or re-create the shares to restore the prior state. |
| Step 3 (unmanage) | all shares deleted; filesystem unmounted but its unit still managed | The data is intact and the unit still exists, so re-running Delete Filesystem finishes the job once the blocker is cleared. To go the other way, `PATCH {"mounted": true}` re-mounts it — but **no TUI screen offers a remount**, so that path is `xinasctl` / MCP only. |

The audit trail records each completed step, so the boundary between "done" and "not run" is reconstructable after the fact.

**Side effects per step.** Each line is written only after its own step succeeded:

| Step | Audit action | Snapshot |
|---|---|---|
| 1 — `DELETE /api/v1/shares/{id}` | `nfs.remove` with detail `share=<P> (FS teardown)` | — |
| 2 — `PATCH /api/v1/filesystems/{id}` `{"mounted": false}` | `fs.unmount` with detail `mountpoint=<M> (FS teardown)` | — |
| 3 — `DELETE /api/v1/filesystems/{id}` | `fs.delete` with detail `mountpoint=<M> device=<D>` (written on full success, after step 3) | `fs_delete` with diff summary |

The `fs_delete` snapshot's `diff_summary` names the mountpoint and device and appends the removed-share count when non-zero. It is recorded **only** after step 3, so a teardown that stops early records **no** snapshot. On full success the view shows a green summary (mountpoint, device, share count) and a toast confirms.

### 3.5 Manage Quotas

Decides on the filesystem's **quota mode**, not on user-level limits. Setting per-user / per-project byte limits is a separate code path (the helper's `set_quota` op via `xfs_quota -x`) and is **not** currently exposed in this screen.

The screen no longer edits the mount unit itself. It reads the mode out of the observed mount options and writes it with a **one-intent `PATCH`**; the remount is the executor's job.

1. `_list_filesystems()` (`GET /api/v1/filesystems`) enumerates the managed filesystems. For each, `_quota_flags(options)` parses the effective mount-options list into `{user, project, group}` booleans (`uquota`/`usrquota`, `pquota`/`prjquota`, `gquota`/`grpquota`).
2. The view shows a status header per filesystem: `<mp> [quotas: user, project]` (green per enabled mode, yellow `none` if neither).
3. The operator picks one. The action menu is built from current state and always offers **two** entries — the user toggle and the project toggle:

   | Current state | Offered |
   |---|---|
   | user off | `Enable User Quotas (uquota)` → `quota_mode: uquota` |
   | user on | `Disable User Quotas` → `quota_mode: none` |
   | project off | `Enable Project Quotas (pquota)` → `quota_mode: pquota` |
   | project on | `Disable Project Quotas` → `quota_mode: none` |

   **There is no "Enable Both" option any more.** `Filesystem.spec.quota_mode` is a single enum (`none | uquota | gquota | pquota`), so a filesystem holds exactly one mode: enabling one *replaces* the other. The action description says so out loud — `enable user quotas (replaces project quotas)` when project quotas are currently on, and the mirror image for the other direction. A "disable" action of either kind sets `none`, which clears whatever mode was set.

4. Confirmation names the filesystem and the action description, and warns: *"XFS requires a full unmount/mount cycle to change quota settings. Active NFS clients may be briefly disconnected."*
5. `PATCH /api/v1/filesystems/{id}` with `{"quota_mode": <mode>}` via `plan_apply_wait` — one intent key, which is what the endpoint requires (mixing `quota_mode` with `mounted` or `grow` is `INVALID_ARGUMENT`). The api routes it to `fs.set_quota_mode`, a **client-visible remount**; the unit-file rewrite and the `systemctl` stop/start cycle happen executor-side, not in the TUI. XFS rejects quota changes via `mount -o remount`, which is why the cycle is full rather than in-place.

On failure: an OK-only `Failed to update quotas:` dialog plus a red line in the view; nothing is retried.

On success: `audit.log("fs.quota", "<mp>: <description>", "OK")` + `snapshots.record("fs_modify", diff_summary="Changed quotas on <mp>: <description>")`, and the view confirms the filesystem was remounted.

Group quotas (`gquota` / `grpquota`) are *parsed* by `_quota_flags` and *accepted* by the API enum, but never *offered* by this menu — XFS+NFS appliance deployments are expected to use user or project quotas exclusively.

---

## 4. NFSScreen

[xinas_menu/screens/nfs.py](../../xinas_menu/screens/nfs.py).

### 4.1 Menu

| Key | Action | Backend |
|---|---|---|
| 1 | Show NFS Exports | `GET /api/v1/shares` → `_rows_from_api()` → `_format_exports()` |
| 2 | Add Share | 7-step wizard → `POST /api/v1/shares` |
| 3 | Edit Share | 7-step wizard → `PATCH /api/v1/shares/{id}` |
| 4 | Remove Share | `DELETE /api/v1/shares/{id}` |
| 5 | Active Sessions | `nfs.list_sessions()` — the one direct helper-socket call left |
| 6 | Configure idmapd Domain | direct rewrite of `/etc/idmapd.conf` (§4.9) |
| 0 | Back | pop screen |

**Every share write is a `plan_apply_wait`**, not a helper-socket call. The screen still never edits `/etc/exports` — but the writer is now `api → agent → nfs-helper`, two hops further away, and the screen gets plan blockers, task stages, and the api's audit trail for free. Two actions stay outside that path: Active Sessions (a pure read the control path does not model, §4.8) and the idmapd domain (§4.9).

Share ids are percent-encoded with `quote_id()` on every path — a Share id mirrors `encExportId(path)` and **contains internal slashes** (`/mnt/data` → `mnt/data`), so an un-encoded id 404s. See [s8-clients-spec §6](../control-path/s8-clients-spec.md#6-tui-composite-teardown-t13).

**Shared share read.** Every write action first calls `NFSScreen._get_exports()` (`GET /api/v1/shares` → `_rows_from_api`, keeping only rows with both a `path` and an `id`). It **propagates** `ControlPathError` rather than degrading to `[]`, so each caller can tell "the api is unreachable" apart from "this host has no shares" — Edit and Remove show an OK-only `Could not load shares.` dialog for the former and `No shares configured.` for the latter. Add does not call it at all: `fsid` is server-allocated, so the wizard has nothing to read the list for (§4.5).

**Shared failure rendering.** All three write actions funnel a `ControlPathError` through `NFSScreen._show_control_error(exc)`, which splits one case out of the generic path: a **lease conflict** (the resource is locked by another in-flight task) gets a calm OK-only *Resource Busy* dialog via `lease_conflict_message(exc)`, because the lock is short-lived and the periodic sweep bounds it — retrying is the right advice. Everything else keeps the plain OK-only `Failed: <error>` dialog. `_show_control_error` is deliberately **not** a `@work` worker: callers `await` it inline, and Textual 8.x `Worker` objects are not awaitable.

### 4.2 Show — structured render with diagnostics

`_load_exports()` runs `GET /api/v1/shares`, adapts the docs with `_rows_from_api()`, and feeds the result to `_format_exports()`. A `ControlPathError` short-circuits before the renderer: the view shows a `Control API: <error>` line and nothing else.

**`_rows_from_api()` is the only place the API shape is known.** API shares are `{id, spec: {path, clients: [{pattern, options}], fsid, sync?, security_mode?}, status}`; the renderer and the Edit wizard both speak the legacy `{path, clients: [{host, options}]}` shape. The adapter renames `pattern` → `host` and **folds the share-level `sync` and `security_mode` back into each client's option list** — mirroring the server's own exports compile — so `_parse_current_export` and the display keep working unchanged. `sync`/`async` is only appended when the client options don't already carry one, and `sec=` only when `security_mode` is set and isn't `sys`. Rows without a `path` are dropped.

The renderer is intentionally rich:

- **Storage line** — `df -h <path>` to show `used / total (pct)`, with a
  **5-second timeout**; on timeout or error the line reads `N/A`. An export
  whose backing filesystem is hung (dead NFS server, lost FC path) must not be
  able to stall the render.
- **Path-missing flag** — `os.path.isdir(path)` — flips the status badge to `[!] PATH MISSING` (red) if the export targets a directory that doesn't exist on disk.
- **Security label** — translates `sec=krb5` / `krb5i` / `krb5p` → `"Kerberos"` / `"Kerberos+integrity"` / `"Kerberos+encryption"`, defaults to `"Standard (UID/GID)"`.
- **Per-client explanation** — translates `*` → `"Everyone (all hosts)"`, `10.10.0.0/24` → `"Network: 10.10.0.0/24"`, and flags `no_root_squash` as `"full admin"` next to `rw` / `ro`.
- **Empty state** — an empty share list renders `(no NFS shares configured)`. The renderer does **not** read `/etc/exports`. It used to: when the row list came back empty it parsed the file directly and displayed its contents as the share list. That made sense while the helper socket was the read path and an empty result meant "the socket failed", but under the control path an empty result means *the api observed no shares* — and the collector already observes `/etc/exports` itself, so anything genuinely exported would have come back as a row. All the fallback could still do was present unmanaged file contents as though they were the managed share list, in exactly the case where the operator most needs to see that the control path has nothing.
- **Connected hosts** — last block. Reads `/proc/fs/nfsd/clients/*/info` for active v4 connections; if that's empty, falls back to `ss -tn state established ( dport = :2049 )` for v3 / TCP connections. IPs are de-duplicated.

**The renderer runs in a worker thread.** `_format_exports` shells out to `df`
once per share and reads `/proc/fs/nfsd/clients/*/info`, so `_load_exports`
invokes it via `asyncio.to_thread`. `@work` on an `async def` runs the worker
*on the event loop*, not in a thread — offloading the control-path call alone
is not enough, and rendering inline is what froze the whole TUI when a single
export's filesystem hung.

**Degraded-backend honesty.** Like Show Filesystems (§3.2) and the RAID overview, `_load_exports` fetches the **full envelope** (`control.get`, not `control.result`) and inspects its `warnings`. When the envelope carries `DEGRADED_BACKEND_UNAVAILABLE` — the `Share` collector is errored (control-path contract: [s8-clients-spec §5.1](../control-path/s8-clients-spec.md)) — `_format_exports` renders that message as a banner above any rows, and when the list is empty the banner **replaces** the `(no NFS shares configured)` empty state. An unobservable backend must never read as "genuinely no shares". The shared extractor is [api/degraded.py](../../xinas_menu/api/degraded.py) `degraded_banner(envelope)`, the same one the other two screens use.

This is the closest the TUI comes to a dashboard — it's the screen most operators see most often.

### 4.3 Wizard navigation model

Both share wizards (Add, Edit) — and, by the same pattern, the RAID Create-Array wizard covered in [Storage/raid-management-spec.md §4](raid-management-spec.md#4-create-array-wizard) — run on a generic **Back-navigable driver**: [xinas_menu/widgets/wizard.py](../../xinas_menu/widgets/wizard.py).

- **`WizardStep`** — a dataclass of `key` (the answers-dict key the step's result is stored under), an async `run(answers, allow_back, step_no)` callable, and an optional `applies(answers)` predicate (default: always applicable). A step whose `applies()` returns `False` is skipped in both directions and its stale key (if any) is pruned from `answers` when skipped.
- **`BACK` / `CANCEL`** — two distinct sentinel objects (not `None`, not any real string/bool). A step's `run()` returns one of these instead of a value to signal "go to the previous applicable step" or "abort the whole wizard."
- **`run_wizard(steps, initial=None)`** — the driver loop. It owns the current index and the accumulated `answers` dict (seeded from `initial`, used by Edit to pre-load the selected share's current values). For each applicable step it computes `allow_back` (`True` once any earlier step is applicable — `False` on the wizard's first step) and `step_no` (the 1-based position **counting only applicable steps**, so a skipped step doesn't leave a gap in the numbering). It calls `step.run(answers, allow_back, step_no)`; on `CANCEL` the whole call returns `None`; on `BACK` it rewinds to the previous applicable index; otherwise it stores `answers[step.key] = result` and advances. Returns the final `answers` dict once every step has been passed, or `None` if any step cancelled.
- **Answers are retained across Back.** Since `answers` is one dict shared by the whole run, backing up and coming forward again shows the step's previously-entered value pre-filled rather than blank — see the dialog pre-fill params below.

**Dialog support.** The four dialogs used by these wizards — `SelectDialog`, `InputDialog`, `ConfirmDialog` ([xinas_menu/widgets/](../../xinas_menu/widgets/)), and `DrivePickerScreen` (RAID only, see the RAID spec) — all accept a keyword-only `allow_back: bool = False`. When `True`, the dialog renders a **Back** button and dismisses with the `BACK` sentinel when it's pressed. `Esc` always still dismisses as **Cancel** (`None`), never Back — that binding is unconditional in every dialog. `SelectDialog` and `ConfirmDialog` additionally bind the `left` arrow key to Back (a no-op if `allow_back` is `False`); `InputDialog` exposes Back only via the button (arrow-left would collide with in-field cursor movement); `DrivePickerScreen` binds `b` to Back in addition to its button, since arrow keys and most single letters are already claimed by the picker's own navigation/filter/sort bindings.

Pre-fill on re-entry is dialog-specific: `SelectDialog.selected` pre-highlights an option, `InputDialog.default` pre-fills the text field, and `DrivePickerScreen.preselected` pre-checks a drive set — each wizard step reads its current value out of `answers` and passes it back in on every entry, so what the operator sees after backing up matches what they last chose.

### 4.4 The shared 5-step access-control steps (`_access_steps`)

Add and Edit both call `NFSScreen._access_steps(prefix, total)`, which builds and returns the five shared `WizardStep`s (it no longer runs the steps itself — the caller concatenates them into its own step list and hands the whole thing to `run_wizard`). `prefix` (`"Add Share"` or `"Edit Share"`) and `total` (currently always `7`) feed a shared `title(step_no)` closure so every dialog in the wizard reads `<prefix> — Step <step_no>/<total>`, with `step_no` computed by the driver.

| Step | Key | Field | Choices |
|---|---|---|---|
| 1 | `host` | `host` | `Everyone` (→ `*`), `Specific network` (→ free-form CIDR), `Single host` (→ free-form IP) |
| 2 | `access` | `access` | `rw` or `ro` |
| 3 | `root_squash` | `root_squash` | `no_root_squash` ("full admin", recommended) or `root_squash` ("limited", more secure) |
| 4 | `sync_mode` | `sync_mode` | `sync` (safer) or `async` (faster) |
| 5 | `sec` | `sec` | `sys`, `krb5`, `krb5i`, `krb5p` |

Every step reads its **working value** out of the running `answers` dict (`answers.get("host", "*")`, etc.) to compute the `SelectDialog.selected` pre-fill — so re-entering a step after Back shows what was picked last, not the original default. Separately, when `answers` carries an `_orig` snapshot — which only Edit seeds (see §4.6) — each prompt appends a `(Current: …)` hint describing the share's value *before this edit run started*, so the operator can see both "what I'm about to pick" (pre-selected) and "what it was originally" (the hint) at once.

The host step (step 1) is a nested sub-flow: the top-level `SelectDialog` offers the three radio choices; picking "Specific network" or "Single host" pushes a follow-up `InputDialog` (always `allow_back=True`) for the CIDR/IP. Backing out of that sub-input returns to the host `SelectDialog` (an internal `continue`, not a `BACK` to the driver); an **empty** value at that sub-input re-prompts the same way, with a `"Host/network must not be empty."` notification — it no longer aborts the wizard as older behavior did.

Each step returns `CANCEL` if its dialog is dismissed with `None`, `BACK` if the dialog returns the `BACK` sentinel, or the resolved field value.

### 4.5 Add Share (7 steps)

**Step 1 — pick an export path.**

The wizard scans `findmnt -t xfs -n -o TARGET,SOURCE` and keeps only mounts whose
SOURCE is a xiRAID volume (`/dev/xi_*`) — an NFS export is allowed **only** from a
filesystem on a xiRAID array. If no such mount exists, the wizard aborts **before
it starts** with an OK-only dialog directing the operator to *Storage →
Filesystems → Create Filesystem* (the former free-form `/mnt/data/` fallback is
gone). A `findmnt` **read failure** (the command errored, as opposed to
succeeding with no xiRAID mounts) surfaces a distinct *"Couldn't read the mount
table"* dialog instead, so a transient fault is not misreported as a missing
filesystem. Otherwise the xiRAID mount roots are offered in a `SelectDialog`, prepended
with `Custom path…` so an operator can export a subdirectory (e.g.
`/mnt/data/share1`). A directly picked mount root is valid as-is; a custom path is
accepted only when it is at-or-under one of the xiRAID mount roots (segment-aware
`is_path_under`, [xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)), otherwise
the step re-prompts with an error. Either choice must be an absolute path (rejects
anything that doesn't start with `/`). This is the wizard's first step, so its
dialogs never render a Back button (`allow_back` is `False` here); every step after
it does.

**Steps 2–6.** `self._access_steps("Add Share", total=7)` — see §4.4. A Back button is available on all five.

**Step 7 — confirmation.** `allow_back=True`, so the operator can back up from the summary to revise any earlier answer before committing.

**Submission.** Before submitting, the screen `os.makedirs(path, exist_ok=True)` to be sure the export directory exists; an `OSError` there aborts on an OK-only `Cannot create directory:` dialog. (The helper *could* do this — `add_export` accepts `create_path=true` — but handling it client-side keeps the user-visible error to a single dialog.)

Then one `plan_apply_wait` — `POST /api/v1/shares` with the `NfsShare.spec`:

```json
{
  "path": "/mnt/data/share1",
  "clients": [
    { "pattern": "10.10.0.0/24", "options": ["rw", "no_root_squash", "no_subtree_check"] }
  ],
  "sync": "sync"
}
```

Three things to note, because the wizard's five answers do **not** map one-to-one onto that shape:

- **`sync_mode` and `sec` are share-level fields, not client options.** `sync` always carries the wizard's answer; `security_mode` is added **only when `sec != "sys"`**. `_rows_from_api` folds both back into the client option list on read (§4.2), which is why the display and the Edit wizard still see them there.
- **`no_subtree_check` is force-added** to every client's options even though the wizard doesn't ask — it's required for any export on an NFS appliance.
- **`fsid` is allocated server-side.** The wizard omits `spec.fsid` entirely; `POST /api/v1/shares` assigns the next integer above the highest in use, and concurrent creates that resolve the same number are serialised by the plan's absence pin on the fsid marker — the loser gets `PRECONDITION_FAILED` and re-plans. A caller that wants a specific number may still send one, and an `FSID_IN_USE` blocker says so if it is taken. See [docs/control-path/s3-nfs-executor-spec.md](../control-path/s3-nfs-executor-spec.md) §4.

On success: `audit.log("nfs.add_export", path, "OK")` + `snapshots.record("share_create", diff_summary=…)` + Show is refreshed. On `ControlPathError`, `_show_control_error` renders it (§4.1).

### 4.6 Edit Share — preserve unknown options

**Step 1 — select export.** `SelectDialog` over current paths, `selected=answers.get("path")` (so re-entering after Back re-highlights whichever share was already chosen). The step's `run()` only **reseeds** the working answers when the operator picks a **different** path than the one already recorded (`if choice != answers.get("path")`): it looks up the export, calls `_parse_current_export(export)`, stores the snapshot under `answers["_orig"]`, the export's id under `answers["share_id"]`, and copies the five wizard fields (`host`, `access`, `root_squash`, `sync_mode`, `sec`) from that snapshot into `answers`. If the operator backs into this step and re-confirms the **same** path, none of that reseeding happens — any in-flight edits made on the later access steps during this run are left untouched rather than being clobbered back to the share's on-disk values. If the looked-up share has no id, the step shows a "Share not found." dialog and returns `CANCEL`.

**Parse current values.** `_parse_current_export(export)` extracts the five wizard-managed fields and **everything else** (`extra_opts`). Unknown options are anything not in `_WIZARD_MANAGED_OPTS = {"rw", "ro", "root_squash", "no_root_squash", "sync", "async"}` and not a `sec=…` line.

**Steps 2–6.** `self._access_steps("Edit Share", total=7)` — the same shared steps Add uses (§4.4). Because `answers["_orig"]` was seeded in step 1, every prompt shows the `(Current: …)` hint alongside the pre-selected working value.

**Step 7 — confirmation.** `allow_back=True`. The summary renders the export the way `/etc/exports` spells it — a flat option list including `sync_mode` and `sec=`, plus the preserved `extra_opts` (read from `answers["_orig"]["extra_opts"]`):

```python
extra = answers["_orig"]["extra_opts"]
options = [access, sync_mode, root_squash]
if sec != "sys":
    options.append(f"sec={sec}")
options.extend(extra)          # display only — see Submission below
```

So if the original export had `insecure,no_wdelay,fsid=0` (the appliance baseline from [Installer/fs-exports-spec.md §2.3](../Installer/fs-exports-spec.md#23-decoding-the-default-options)), those three options survive a wizard run unchanged. Note: `no_subtree_check` is *not* in `_WIZARD_MANAGED_OPTS`, so it counts as an extra and is preserved through edits — but unlike Add, Edit doesn't force-add it.

**Submission.** That flat list is **display only**. The submitted patch splits it back apart the way the API models a share — `sync` and `security_mode` are share-level fields, and only `access`, `root_squash` and the extras stay as client options:

```python
patch = {
    "clients": [{"pattern": host, "options": [access, root_squash, *extra]}],
    "sync": sync_mode,
    "security_mode": sec,
}
```

Unlike Add, Edit sends `security_mode` **unconditionally**, including the value `"sys"` — so an edit is what clears a `sec=krb5` off an existing share. That asymmetry is deliberate: an omitted field on a PATCH means "leave alone", which would make `sec` a one-way door.

One `plan_apply_wait` — `PATCH /api/v1/shares/{quote_id(share_id)}` with that patch. The `share_id` comes from step 1's lookup, not from the path: an id carries internal slashes and must be encoded (§4.1). The PATCH is a merge-patch — fields not named are left as they are, so `path` and `fsid` survive an edit untouched.

On success: `audit.log("nfs.update_export", path, "OK")` + `snapshots.record("share_modify", diff_summary=…)` + Show is refreshed. On `ControlPathError`, `_show_control_error` (§4.1).

### 4.7 Remove Share

Simple two-prompt flow:

1. `SelectDialog` over current export paths. The chosen path is looked back up to recover its **id**; a share with no id aborts on an OK-only `Share not found.` dialog.
2. `ConfirmDialog("Remove export {path}?")` — single confirmation, no FINAL prompt (an export has no downstream FS state to worry about, unlike a RAID array or a mount).

Then one `plan_apply_wait` — `DELETE /api/v1/shares/{quote_id(share_id)}` with an **empty body**: the delete plan's spec is built server-side from the desired share (`{id, path}`). The risk class is `changing_access`, not `destroying_data`, so **no `dangerous` flag is passed** — the single confirmation is the whole gate, and the api does not demand more.

On success: `audit.log("nfs.remove_export", path, "OK")` + `snapshots.record("share_delete", …)` + Show refreshed. On `ControlPathError`, `_show_control_error` (§4.1).

The export's directory on disk is **not** removed. Anything the share was rooted at stays put.

### 4.8 Active Sessions

**The one place either screen still calls the helper socket directly.** Session state is a live read of the kernel server, not desired configuration, so the control path does not model it — the screen goes straight to the daemon via `loop.run_in_executor(None, self.app.nfs.list_sessions)`.

`nfs.list_sessions()` reads `/proc/fs/nfsd/clients/*/info` on the server side, returning a list of `{client_ip, nfs_version, export_path, active_locks}` dicts. A failure renders the client's error envelope (§2.3) straight into the view. The screen prints `client → export_path` per row. The fallback path (when `/proc/fs/nfsd/clients` is empty — older kernels or v3-only servers) parses `/proc/net/rpc/auth.unix.ip`.

Per-export filtering is available via `nfs.get_sessions(path)`, but the screen always asks for the global list. Use the MCP tool surface for per-path queries.

### 4.9 Configure idmapd Domain

The only NFS-screen write that goes through **neither** the control path nor the helper socket. NFSv4 ID mapping (`/etc/idmapd.conf`) is a one-time / rare-edit configuration; rather than modelling it as a control-path resource or adding a `set_idmapd_domain` op to the helper, the screen edits the file directly in an executor:

1. Validate input — `domain` must contain at least one `.`.
2. Inline executor reads `/etc/idmapd.conf`, replaces the `^Domain\s*=\s*…` line with the new value, writes the file back. No locking, no atomic write — this is an admin-only screen.
3. `audit.log("nfs.idmapd_domain", domain, "OK")` + `snapshots.record("nfs_modify", …)`.

The screen does **not** restart `nfs-idmapd` — the daemon picks up the change on its next reload, and stale mappings flush quickly. If immediate effect is required, the operator can run `systemctl restart nfs-idmapd` separately.

---

## 5. End-to-end traces

### 5.1 Operator creates a new XFS filesystem from the TUI

```
FilesystemScreen._create_filesystem_wizard()
  ├─ GET /api/v1/arrays                        — list arrays
  ├─ GET /api/v1/filesystems                   — _volumes_in_use(): drop
  │                                              arrays already used as a
  │                                              data or logdev device
  ├─ SelectDialog (data array)                 — TUI only
  ├─ SelectDialog (log array)                  — TUI only
  ├─ InputDialog (label)                       — TUI only
  ├─ InputDialog (mountpoint)                  — TUI only
  ├─ ConfirmDialog (summary)                   — TUI only; su_kb and the
  │                                              flat option string are
  │                                              display-only (su_kb/sw are
  │                                              omitted from the spec and
  │                                              derived server-side)
  ├─ control.plan_apply_wait(POST /api/v1/filesystems)   — ONE plan→apply
  │    ├─ mode=plan  → plan_id, blockers checked
  │    ├─ mode=apply → task_id
  │    └─ poll GET /tasks/{id} → preflight → mkfs → unit → mount stages
  │         └─ on failed terminal: TaskFailed carries the failing
  │            stage's error_message (force retry ONLY on the
  │            existing-filesystem destruction gate)
  ├─ audit.log("fs.create", …)                  — /var/log/xinas/audit.log
  └─ snapshots.record("fs_create", …)           — xinas_history snapshot
```

### 5.2 Operator adds an NFS share from the TUI

```
NFSScreen._add_share_wizard()
  ├─ findmnt -t xfs -n -o TARGET                — list candidate paths
  ├─ run_wizard([path_step] + _access_steps(...) + [confirm_step])
  │    ├─ path (mount SelectDialog or custom InputDialog; Back-enabled from step 2 on)
  │    ├─ host (Everyone/Network/Single)
  │    ├─ access (rw/ro)
  │    ├─ root_squash (no_root_squash/root_squash)
  │    ├─ sync_mode (sync/async)
  │    └─ sec (sys/krb5/krb5i/krb5p)
  ├─ ConfirmDialog (summary)
  ├─ os.makedirs(path, exist_ok=True)           — client-side, one clear error
  ├─ control.plan_apply_wait(POST /api/v1/shares)
  │    ├─ spec: {path, clients:[{pattern, options}], sync,
  │    │         security_mode?}   — sync/sec are share-level, not options
  │    ├─ mode=plan  → plan_id, blockers checked
  │    ├─ mode=apply → task_id
  │    └─ agent nfs-executor → Unix socket → xinas-nfs-helper
  │         ├─ validate (abs path, isdir or create_path)
  │         ├─ fcntl LOCK_EX on /run/xinas-exports.lock
  │         ├─ parse /etc/exports
  │         ├─ remove duplicate by path
  │         ├─ append new entry
  │         ├─ write /etc/exports (managed banner restored)
  │         ├─ unlock
  │         └─ subprocess: exportfs -r
  ├─ audit.log("nfs.add_export", path, "OK")
  ├─ snapshots.record("share_create", ...)
  └─ _load_exports()                            — re-render with df / isdir / ss
```

### 5.3 Operator changes user quotas on `/mnt/data`

```
FilesystemScreen._manage_quotas()
  ├─ GET /api/v1/filesystems                    — enumerate managed FSs
  ├─ _quota_flags(options)                      — parse current flags
  ├─ SelectDialog (filesystem)
  ├─ SelectDialog (action)                       — user toggle + project toggle,
  │                                                labelled from current state
  ├─ ConfirmDialog (warns about unmount/mount cycle)
  ├─ control.plan_apply_wait(PATCH /api/v1/filesystems/mnt-data.mount,
  │                          {"quota_mode": "uquota"})   — ONE intent key
  │    ├─ mode=plan  → plan_id, blockers checked
  │    ├─ mode=apply → task_id
  │    └─ fs.set_quota_mode executor-side: rewrite Options=,
  │         daemon-reload, stop + start the unit (XFS rejects a
  │         quota change via `mount -o remount`)
  ├─ audit.log("fs.quota", "<mp>: enable user quotas", "OK")
  └─ snapshots.record("fs_modify", ...)
```

---

## 6. Audit + snapshot taxonomy across both screens

Every write operation in both screens emits two side-channel records — see [Storage/raid-management-spec.md §2.5](raid-management-spec.md#25-cross-cutting-helpers-audit--snapshots) for the helper internals.

| User action | Audit action | Snapshot operation | diff_summary |
|---|---|---|---|
| Create FS | `fs.create` | `fs_create` | `Created XFS filesystem '<L>' on <D>, mounted at <M>` |
| Delete FS | `fs.delete` (+ `nfs.remove` per affected share, + `fs.unmount` when it was mounted) | `fs_delete` | `Deleted filesystem at <M> (device <D>) [, removed N share(s)]` |
| Toggle quota | `fs.quota` | `fs_modify` | `Changed quotas on <M>: <action description>` (e.g. `enable user quotas (replaces project quotas)`) |
| Add share | `nfs.add_export` | `share_create` | `Added NFS share <P>` |
| Edit share | `nfs.update_export` | `share_modify` | `Updated NFS share <P>` |
| Remove share | `nfs.remove_export` | `share_delete` | `Removed NFS share <P>` |
| Set idmapd domain | `nfs.idmapd_domain` | `nfs_modify` | `Set idmapd domain to <D>` |
| Share auto-removed during FS teardown | `nfs.remove` with `(FS teardown)` suffix | (none — rolled into `fs_delete`) | — |
| FS unmounted during FS teardown | `fs.unmount` with `(FS teardown)` suffix | (none — rolled into `fs_delete`) | — |

Each teardown line is written only after its own step succeeded, and the `fs_delete` snapshot only after the final step. A teardown that stops partway (§3.4) therefore leaves audit lines for the steps that ran and **no** snapshot at all.

Snapshots are best-effort. If `xinas_history` is not installed or `record()` raises, the UI flow is unaffected — the audit line is still written and the user-visible success/failure is determined entirely by the helper response.

Audit entries use the format:

```
YYYY-MM-DD HH:MM:SS | <user> | <action> | OK | <detail>
```

`<user>` is the OS user the TUI is running as (typically `root` when launched from `xinas-menu`). All entries are append-only to `/var/log/xinas/audit.log`.

---

## 7. Failure modes the screens handle explicitly

| Failure | Where | Handling |
|---|---|---|
| `GET /api/v1/shares` unreachable | `_load_exports` / `_get_exports` | `_get_exports` **propagates** the `ControlPathError`; no caller degrades a failed read to "no shares". Show prints `Control API: <error>`; Add does not read the list at all; Edit and Remove abort on an OK-only `Could not load shares.` dialog, distinct from the `No shares configured.` empty case. |
| `Share` collector degraded behind a healthy api | `GET /api/v1/shares` envelope | `DEGRADED_BACKEND_UNAVAILABLE` warning → Show renders the banner, and an empty list shows the banner instead of `(no NFS shares configured)` (§4.2). |
| Share write fails (plan blocked, task failed, api down) | `_show_control_error` | OK-only `Failed: <error>` dialog carrying the plan/task message; the flow aborts with no partial state (the apply is one task). |
| Share write hits a lease conflict | `_show_control_error` → `lease_conflict_message` | OK-only *Resource Busy* dialog instead of the raw error — the resource is locked by another in-flight task and the lock is short-lived, so retrying is the advice (§4.1). |
| Helper socket missing / refused / timed out | `nfs.list_sessions()` (§4.8), and agent-side for every share write | `NFSHelperClient` returns `(False, None, "…not found"/"…not running"/"NFS helper timed out")`. Active Sessions prints it; a share write fails agent-side and surfaces as a task failure. |
| `exportfs -r` fails with non-`Failed to stat` error | helper `_exportfs_reload()` | Raises `RuntimeError`; the helper returns `{"ok": false, "code": "INTERNAL"}`; the agent turns that into a task failure and the TUI surfaces the message. |
| `nfs-kernel-server` not installed | helper startup health check | `xinas-nfs-helper` logs a warning at boot; first export op fails with `exportfs not found`. |
| Non-absolute `path` to `add_export` | `nfs_helper.handle_add_export` | `INVALID_ARGUMENT` — `"entry.path must be absolute"`. The wizard rejects a non-`/` path before submitting, so this is a defence in depth. |
| Export target directory missing | `nfs_helper.handle_add_export` | `NOT_FOUND` unless `create_path=true`. TUI's Add wizard pre-creates the directory client-side. |
| Explicit `fsid` already held by another share | create plan blocker | `FSID_IN_USE` on the returned plan, naming the share that holds it; reaches the operator through `_show_control_error` like any blocker. |
| Two concurrent creates resolve the same `fsid` | fsid marker absence pin (api-side) | The second apply fails `PRECONDITION_FAILED`; re-planning allocates the next number. Nothing is required of the TUI. |
| Quota toggle while NFS clients connected | XFS requires unmount cycle | `_manage_quotas` warns up front; clients are briefly disconnected during the stop/start. |
| Quota toggle fails (unit missing, remount refused, plan blocked) | `PATCH {"quota_mode": …}` | `ControlPathError` → OK-only `Failed to update quotas:` dialog carrying the task/plan message, plus a red line in the view. No retry. |
| fs.create task fails (live mountpoint, existing unit, mkfs error, log array too small) | control-path task terminal | `TaskFailed.error_message` carries the failing stage's message; an OK-only dialog shows it. **No force retry** unless the failure is the existing-filesystem destruction gate. |
| fs.create fails on the destruction gate (device already carries a filesystem) | fs-executor preflight (`blkid` gate) | Yes/No force-recreate consent quoting the task detail; on Yes the spec is re-submitted with `force: true` + `dangerous=True`. |
| Mount stage fails during fs.create (e.g. xiRAID device not present) | fs-executor mount stage | Reaches the wizard as a `TaskFailed` like any other stage failure — OK-only dialog, no force retry. Cleanup is the task's own stage rollback; the screen writes no unit and removes none. |
| `GET /api/v1/filesystems` fails during the Create pre-check | `_volumes_in_use()` input | Degrades to an empty in-use set (the arrays list is *not* filtered), so an already-consumed array can be offered; the executor's preflight is what rejects it. Contrast the arrays read, which aborts the wizard. |
| `GET /api/v1/filesystems` unreachable | Show / Delete / Quotas | `ControlPathError`. Show and Quotas render `Could not load filesystems: …` into the view; Delete aborts on an OK-only dialog. (`filesystem.py` no longer runs `findmnt` at all — the whole screen reads the control path.) |
| Any FS-teardown step fails (busy mount, blocked plan, share delete refused) | `_teardown_failed` | The sequence **stops**. Completed steps stay completed — there is no cross-step rollback. The progress view shows what ran; an OK-only `Delete Filesystem — Stopped` dialog names the failing step and the error (§3.4). |
| Filesystem backend degraded during Delete Filesystem | `_list_filesystems()` (banner-less) | The list arrives empty and the operator sees `No XFS filesystems found.` — the degraded banner is dropped on this path, unlike Show Filesystems (§3.2). |
| idmapd file unreadable | `_configure_idmapd` | Returns `(False, str(exc))`; the dialog shows the OS error. |

---

## 8. What these screens do **not** do

- They do not run `xicli`, `mkfs.xfs`, `systemctl`, or `xfs_quota` directly. `FilesystemScreen` reaches storage only through the control-path API — it holds no gRPC client and no longer writes mount units itself. `xfs_quota` (per-user byte limits, as opposed to the filesystem's quota *mode*) remains an NFS-helper op, wired into the Users screen and the MCP tool surface but not into these two.
- They do not change `/etc/nfs.conf`. That is reachable through `nfs.fix_nfs_conf()` (the helper op) and is invoked by the Health screen's auto-fix and by MCP tools, **not** by the FS or NFS screens.
- They do not enforce per-export quotas. `uquota` / `pquota` are mount-level switches; assigning per-user / per-project byte limits is a separate operation (helper's `set_quota` op) that the TUI exposes only indirectly via the (not yet implemented) Users / Groups screens.
- They do not configure firewall rules for NFS ports. `2049/tcp` and `20049/rdma` are assumed open on the storage network — see [Installer/network-spec.md §9](../Installer/network-spec.md#9-what-the-installer-does-not-do).
- They do not edit `/etc/exports` directly, and they do not preserve hand-edits. The helper writes the file in full on every `add` / `remove` / `update` and re-injects the `# Managed by xinas-nfs-helper — do not edit manually` banner — anything in the file outside the structured format is dropped.
- They do not delete the on-disk content of a share or FS. Removing a share leaves the directory tree intact; deleting a filesystem removes the mount but leaves the XFS on `/dev/xi_<name>` so a re-mount picks up the existing data. The only place data is destroyed is the executor's `mkfs.xfs` during `fs.create`, and overwriting an existing filesystem there is gated twice: the executor refuses unless the spec carries `force: true`, and the TUI only re-submits with `force` after the operator accepts the destruction consent (§3.3).
- They do not export the same path twice. `add_export` removes any existing entry with the same `path` before appending the new one — there is exactly one rule per path at any time.

## 9. Dialog conventions — informational vs consent

Both screens follow the TUI-wide `ConfirmDialog` rule (canonical statement in [raid-management-spec.md §12](raid-management-spec.md#12-dialog-conventions--informational-vs-consent)):

- **Informational / error / notice → `ok_only=True`** (single OK button). The failure pop-ups (`"Failed: …"`, "No shares configured.", "Share not found.", "Cannot create directory:", "Filesystem creation failed:", "Could not load filesystems.", "No XFS filesystems found."), the idmapd "domain updated." success notice, and the delete-teardown "stopped" notice all discard their return value and use OK-only.
- **Yes/No is reserved for genuine consent** — the Add / Edit / Remove Share confirmations, the Create-Filesystem summary, the force-recreate retry, the log-array "Proceed?" step, the Delete-Filesystem warning plus the FINAL CONFIRMATION double gate, and the quota-change confirmation, each of which captures and branches on the returned boolean.
- **Long dialog text wraps, never truncates.** `#dialog-body` is width-constrained to the dialog container, so long error lines wrap (task ids + stage messages easily exceed the 80-cell dialog). Truncation hid the tail of exactly the text the operator needed (`FAILED_PARTIAL_ROL…`).
