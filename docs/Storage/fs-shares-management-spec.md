# xiNAS — Filesystem & NFS Shares Management from the TUI

This document covers the two day-2 screens that sit between the operator and the data path: **`FilesystemScreen`** (mounts XFS on xiRAID block devices and toggles quotas) and **`NFSScreen`** (manages `/etc/exports` entries and the kernel server's view of them). It is the counterpart to [Storage/raid-management-spec.md](raid-management-spec.md) — same TUI app, same helper boundary, but a different state surface.

The two screens share a common helper backbone with the RAID screen:

- **`xfs_helpers`** (in-process subprocess wrappers) — `mkfs.xfs`, `findmnt`, `systemctl`, mount-unit templating, quota toggle.
- **`xinas-nfs-helper`** (out-of-process Unix-socket daemon) — the **only writer** of `/etc/exports` and `/etc/nfs.conf`.
- **Audit + snapshot helpers** — every write path logs to `/var/log/xinas/audit.log` and records an advisory snapshot.

Sources:

- Screens: [xinas_menu/screens/filesystem.py](../../xinas_menu/screens/filesystem.py), [nfs.py](../../xinas_menu/screens/nfs.py), [storage.py](../../xinas_menu/screens/storage.py)
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

Both are mounted on top of the same `app.grpc` (RAID gRPC client), `app.nfs` (helper socket client), `app.audit` (audit logger), `app.snapshots` (snapshot recorder) provided by the `XiNASApp` shell.

---

## 2. The two helper boundaries

The screens never write to `/etc/exports`, `/etc/nfs.conf`, `/proc/fs/nfsd/*` or `/sys/class/block/*` directly. They cross one of two well-defined boundaries:

### 2.1 `xfs_helpers` — in-process async subprocess

[utils/xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py). Every public function returns either `(ok: bool, stdout: str, stderr: str)` for raw subprocess calls or `(ok: bool, err: str)` for higher-level operations — exactly the same `(ok, …, error)` convention the gRPC and NFS clients use.

What the FS screen calls:

| Helper | Underlying command | Used by |
|---|---|---|
| `run_async_cmd(*args, timeout=…)` | `asyncio.create_subprocess_exec` | every helper below, plus `findmnt` calls in screens |
| `mkfs_xfs(label, data, log, su, sw, sector, log_size)` | `mkfs.xfs -f -L … -d su=…k,sw=… -l logdev=…,size=… -s size=…k <data>` | Create FS |
| `get_device_size_bytes(device)` | `blockdev --getsize64 <device>` | log-size clamp inside `mkfs_xfs` |
| `check_existing_filesystem(device)` | `blkid -s TYPE` + `blkid -s LABEL` | Create FS (sanity warn) |
| `create_mount_unit(mp, data, log, opts)` | writes `/etc/systemd/system/<mp>.mount` atomically via `mkstemp + os.replace` | Create FS |
| `mount_filesystem(mp)` | `systemctl daemon-reload` + `systemctl enable --now <unit>` | Create FS, RAID-delete rollback |
| `unmount_filesystem(mp)` | `systemctl stop` + `disable` + `rm` of the unit file | Delete FS, RAID-delete |
| `find_mounts_using_raid(name)` | `findmnt /dev/xi_<name>` + `findmnt -t xfs -n -o TARGET,OPTIONS` for `logdev=` matches | Create FS (gate), RAID-delete |
| `find_mount_for_device(dev)` | `findmnt -n -o TARGET <dev>` | misc lookups |
| `calculate_parity_disks(level)` / `calculate_stripe_width(count, level)` | pure-Python lookup | Create FS geometry |
| `build_mount_options(log)` | string concat | Create FS |
| `get_quota_status(options)` | parse comma-separated opt list | Quotas screen |
| `update_mount_unit_quota(mp, enable_user, enable_project)` | rewrite the `Options=` line, then `systemctl daemon-reload` + `stop` + `start` | Quotas screen |

The mount/unmount helpers operate on systemd `.mount` units, not on `mount(2)` directly. This matches what `raid_fs` lays down at install time — see [Installer/fs-exports-spec.md §1.8](../Installer/fs-exports-spec.md#18-mountpoint-and-systemd-mount-unit). It is the reason the FS lifecycle survives reboots without anything in `/etc/fstab`.

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

Error mapping in the client:

| Helper-side failure | What `NFSHelperClient._request` returns |
|---|---|
| `FileNotFoundError` (socket absent) | `(False, None, "NFS helper socket not found: /run/xinas-nfs-helper.sock")` |
| `ConnectionRefusedError` | `(False, None, "NFS helper is not running (connection refused)")` |
| `socket.timeout` (no response in 10 s) | `(False, None, "NFS helper timed out")` |
| Bad JSON response | `(False, None, "bad JSON from NFS helper: …")` |
| `{"ok": false, "error": "…"}` | `(False, None, "<error string>")` |

The RAID-delete and FS-delete teardown paths use these short-circuits to refuse work cleanly when the helper is down, rather than partially tearing things apart and failing later.

---

## 3. FilesystemScreen

[xinas_menu/screens/filesystem.py](../../xinas_menu/screens/filesystem.py).

### 3.1 Menu

| Key | Action | Handler |
|---|---|---|
| 1 | Show Filesystems | `_show_filesystems()` — `findmnt -t xfs -J` |
| 2 | Create Filesystem | `_create_filesystem_wizard()` |
| 3 | Delete Filesystem | `_delete_filesystem()` |
| 4 | Manage Quotas | `_manage_quotas()` |
| 0 | Back | pop screen |

Nothing in this screen calls the xiRAID gRPC for writes — RAID arrays are inputs. The only gRPC call is `raid_show(extended=True)` at the start of the Create wizard, to enumerate available arrays.

### 3.2 Show Filesystems

`findmnt -t xfs -J` returns JSON; the screen parses `filesystems[]` and prints `target`, `source`, and `options` per row. No subprocess elsewhere, no socket call. Read-only.

### 3.3 Create Filesystem wizard

The wizard mirrors what the installer's `raid_fs` role does (see [Installer/raid-spec.md §7](../Installer/raid-spec.md#7-raid_fs--license-arrays-filesystem-mount)) but runs against the *current* RAID state.

**Pre-check.** `grpc.raid_show(extended=True)` enumerates arrays. For each array, `find_mounts_using_raid(name)` is called — any array already in use as a data **or** log device is moved into an `in_use` bucket. If fewer than 2 free arrays remain, the wizard aborts with "Filesystem creation requires at least 2 RAID arrays (one for data, one for log)."

**Step 1 — pick the data array.** Arrays are sorted with the data-classified ones first (`_classify_role()` maps levels `5 / 6 / 50 / 60` → `data`, anything else → `log`). The label shows `name (RAID-N, M drives, Kk strip) [role]` so the operator can spot the right candidate without remembering levels.

**Step 2 — pick the log array.** Same picker over the remaining arrays, with log-classified ones first. If only one array is left, the wizard skips the picker and just confirms the auto-pick.

**Step 3 — filesystem label.** `InputDialog`, default `nfsdata`.

**Step 4 — mountpoint.** `InputDialog`, default `/mnt/data`. Must start with `/` — otherwise the wizard aborts with an error notification.

**Geometry derivation.** Same formula as the installer:

```
data_device = /dev/xi_<data_name>
log_device  = /dev/xi_<log_name>
su_kb       = data_array.strip_size                              (fallback 128)
sw          = calculate_stripe_width(devices_in_data, level)
              ├─ RAID-10: device_count // 2
              ├─ RAID-5:  device_count - 1
              └─ RAID-6:  device_count - 2
sector size = 4k                                                  (hardcoded)
log size    = 1G                                                  (clamped to log device size at mkfs)
mount opts  = build_mount_options(log_device)                     (matches Ansible)
```

`build_mount_options` produces:

```
logdev=<log_device>,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k,uquota
```

— byte-identical to the [Installer/fs-exports-spec.md §1.7](../Installer/fs-exports-spec.md#17-mount-options-decoded) install-time set, so a TUI-created FS is indistinguishable from an Ansible-created one.

**Step 5 — confirmation.** Summary shows everything: arrays + roles, mountpoint, derived geometry, full mount option string. On confirm the wizard runs four ordered steps:

1. **Existing-filesystem warn.** `check_existing_filesystem(data_device)` returns `(type, label)` from `blkid`. If `type` is set, an extra `⚠ Existing Filesystem` confirmation appears stating that mkfs will destroy existing data.
2. **`mkfs.xfs`.** `mkfs_xfs(...)` runs the full command with the clamp on `log_size` against `blockdev --getsize64 <log_device>`.
3. **Mount-unit creation.** `create_mount_unit(mp, data, log, opts)` writes `/etc/systemd/system/<mp_unit>.mount` atomically. The unit body is built by `generate_mount_unit()` — `Requires=` and `After=` the `dev-xi_*.device` units, `Before=umount.target`, `Conflicts=umount.target`, `WantedBy=local-fs.target`. Same boilerplate the Ansible template emits, just generated in Python.
4. **`mount_filesystem`.** `systemctl daemon-reload` + `systemctl enable --now <unit>`.

If any step fails the wizard stops and displays the error; the partial state (e.g. a fresh XFS that couldn't be mounted) is left as-is and the operator has to clean up manually. There is **no rollback** in the create path — by design, since reformatting a successfully created FS to "undo" would lose data, and removing a fresh mount unit before its first mount succeeds isn't useful enough to justify the complexity.

**Side effects.** On full success:

- `audit.log("fs.create", "label=<L> data=<D> log=<L> mount=<M>", "OK")`
- `snapshots.record("fs_create", diff_summary=...)`
- A green success banner replaces the wizard content; a toast confirms.

### 3.4 Delete Filesystem

Mirrors the RAID-delete teardown pattern in [Storage/raid-management-spec.md §6](raid-management-spec.md#6-delete-array--ordered-teardown-with-rollback), but only two steps instead of three.

**Discovery.** `findmnt -t xfs -J` enumerates all current XFS mounts; the operator picks one from the list (labels show `target (source)`).

**Dependency check.** `nfs.list_exports()` is called (via the executor); every export whose `path.startswith(mountpoint)` is recorded in `affected_shares`. This catches both the root export and any sub-directory exports rooted at the same mount.

**Confirmation.**

1. First dialog: lists affected shares, ends with the warning that the FS will be unmounted and its unit removed. Note the exact wording: *"Data on disk is NOT erased."* — `unmount_filesystem` does not touch the underlying XFS contents, so re-creating a mount unit on the same `/dev/xi_<name>` would re-attach the existing filesystem.
2. If `affected_shares` is non-empty, a second `FINAL CONFIRMATION` dialog restates the count.

**Teardown order.** Strictly:

1. **Remove shares first.** For each `share` in `affected_shares`: `nfs.remove_export(path)` (synchronous via executor). On failure, every previously removed share is re-added via `nfs.add_export(saved_dict)` + `nfs.reload()`, and the dialog reports "Rolled back N share(s)."
2. **Reload exports** (single `nfs.reload()` call after the loop, not per-iteration — `remove_export` already triggers `exportfs -r`, this is belt-and-braces).
3. **Unmount.** `unmount_filesystem(mountpoint)`. On failure: re-add the removed shares and reload before raising.

**Side effects on full success.**

- Per share removed: `audit.log("nfs.remove", "share=<P> (FS teardown)", "OK")`
- After unmount: `audit.log("fs.delete", "mountpoint=<M> device=<D>", "OK")`
- `snapshots.record("fs_delete", diff_summary="...")` with a count of shares removed
- The view shows a green summary; a toast confirms.

### 3.5 Manage Quotas

Decides on **mount options**, not on user-level limits. Setting per-user / per-project byte limits is a separate code path (the helper's `set_quota` op via `xfs_quota -x`) and is **not** currently exposed in any TUI screen — it's available only to MCP callers.

What this menu does:

1. `findmnt -t xfs -J` enumerates XFS mounts. For each, `get_quota_status(options)` parses the option list and returns `{user, project, group}` booleans.
2. The view shows a status header per mount: `<mp> [quotas: user, project]` (green for enabled, yellow `none` if neither).
3. The operator picks a mount. The action menu is constructed dynamically based on current state: only `Enable User Quotas` shows when user quota is off; only `Disable User Quotas` shows when it's on; etc. If both are off, a third option `Enable Both (user + project)` appears.
4. Confirmation includes a warning: *"XFS requires a full unmount/mount cycle to change quota settings. Active NFS clients may be briefly disconnected."*
5. `update_mount_unit_quota(mp, enable_user, enable_project)` does the real work:
   - Read `/etc/systemd/system/<mp_unit>.mount`.
   - Parse the existing `Options=` line.
   - Strip `noquota` if any quota is being enabled (it conflicts with all).
   - Remove `uquota`/`usrquota` if `enable_user` is set, and `pquota`/`prjquota` if `enable_project` is set.
   - Append the new flags if `True`, omit them if `False`, leave them alone if `None`.
   - Rewrite the unit atomically (`mkstemp + os.replace`).
   - `systemctl daemon-reload` + `stop <unit>` + `start <unit>` — the **full cycle**, not `mount -o remount`, because XFS rejects quota changes via remount.

On success: `audit.log("fs.quota", ..., "OK")` + `snapshots.record("fs_modify", diff_summary=...)`.

Group quotas (`gquota` / `grpquota`) are *parsed* by `get_quota_status` but never *toggled* by the UI — XFS+NFS appliance deployments are expected to use user + project quotas exclusively.

---

## 4. NFSScreen

[xinas_menu/screens/nfs.py](../../xinas_menu/screens/nfs.py).

### 4.1 Menu

| Key | Action | Backend |
|---|---|---|
| 1 | Show NFS Exports | `nfs.list_exports()` + `_format_exports()` |
| 2 | Add Share | 7-step wizard → `nfs.add_export()` |
| 3 | Edit Share | 7-step wizard → `nfs.update_export()` |
| 4 | Remove Share | `nfs.remove_export()` |
| 5 | Active Sessions | `nfs.list_sessions()` |
| 6 | Configure idmapd Domain | direct rewrite of `/etc/idmapd.conf` |
| 0 | Back | pop screen |

Every write goes through the helper socket, including the `idmapd` step (which is a plain-Python in-screen rewrite — see §4.7). The screen never edits `/etc/exports` itself.

### 4.2 Show — structured render with diagnostics

`_load_exports()` runs `nfs.list_exports()` and feeds the result to `_format_exports()`. The renderer is intentionally rich:

- **Storage line** — `df -h <path>` to show `used / total (pct)`.
- **Path-missing flag** — `os.path.isdir(path)` — flips the status badge to `[!] PATH MISSING` (red) if the export targets a directory that doesn't exist on disk.
- **Security label** — translates `sec=krb5` / `krb5i` / `krb5p` → `"Kerberos"` / `"Kerberos+integrity"` / `"Kerberos+encryption"`, defaults to `"Standard (UID/GID)"`.
- **Per-client explanation** — translates `*` → `"Everyone (all hosts)"`, `10.10.0.0/24` → `"Network: 10.10.0.0/24"`, and flags `no_root_squash` as `"full admin"` next to `rw` / `ro`.
- **Fallback** — if the helper socket fails (returns `False`), the renderer parses `/etc/exports` directly. The UI shows the same shape, just with the option strings unparsed.
- **Connected hosts** — last block. Reads `/proc/fs/nfsd/clients/*/info` for active v4 connections; if that's empty, falls back to `ss -tn state established ( dport = :2049 )` for v3 / TCP connections. IPs are de-duplicated.

This is the closest the TUI comes to a dashboard — it's the screen most operators see most often.

### 4.3 The shared 5-step access-control wizard (`_access_wizard`)

Add and Edit both call into `_access_wizard()` with `step_offset` and `total_steps` parameters so the title chrome reads `Step N/7` consistently. The wizard collects five fields:

| Step | Field | Choices |
|---|---|---|
| 1 | `host` | `Everyone` (→ `*`), `Specific network` (→ free-form CIDR), `Single host` (→ free-form IP) |
| 2 | `access` | `rw` or `ro` |
| 3 | `root_squash` | `no_root_squash` ("full admin", recommended) or `root_squash` ("limited", more secure) |
| 4 | `sync_mode` | `sync` (safer) or `async` (faster) |
| 5 | `sec` | `sys`, `krb5`, `krb5i`, `krb5p` |

When called from Edit (`current=` set), every prompt is annotated with `(Current: …)` so the operator can see what they're about to change before they change it.

The wizard returns the dict `{host, access, root_squash, sync_mode, sec}` or `None` on cancel. Each step also accepts cancel — bailing on step 3 doesn't mutate state.

### 4.4 Add Share (7 steps)

**Step 1 — pick an export path.**

The wizard scans `findmnt -t xfs -n -o TARGET` to list existing XFS mounts. The list is prepended with a `Custom path…` option so an operator can export a subdirectory under an existing mount (e.g. `/mnt/data/share1`). Either choice ends up as an absolute path; the wizard rejects anything that doesn't start with `/`.

**Steps 2–6.** `_access_wizard("Add Share", step_offset=2, total_steps=7)`.

**Step 7 — confirmation.** The options list is built deterministically:

```
options = [access, sync_mode, "no_subtree_check", root_squash]
if sec != "sys":
    options.append(f"sec={sec}")
```

`no_subtree_check` is force-added even though the wizard doesn't ask about it — it's required for any export on an NFS appliance.

**Submission.** Before sending the helper request, the screen `os.makedirs(path, exist_ok=True)` to be sure the export directory exists. (The helper *could* do this — `add_export` accepts `create_path=true` — but the screen handles it client-side so the user-visible error is a single dialog rather than two round-trips.)

The helper request payload uses the structured form:

```json
{
  "op": "add_export",
  "request_id": "<uuid>",
  "entry": {
    "path": "/mnt/data/share1",
    "clients": [
      { "host": "10.10.0.0/24", "options": ["rw","sync","no_subtree_check","no_root_squash"] }
    ]
  }
}
```

This is the canonical internal representation. The helper serialises it to the single-line `/etc/exports` format via `nfs_exports._serialize_exports()`, which also injects the `# Managed by xinas-nfs-helper — do not edit manually` banner at the top of the file.

On success: `audit.log("nfs.add_export", path, "OK")` + `snapshots.record("share_create", diff_summary=…)` + Show is refreshed.

### 4.5 Edit Share — preserve unknown options

**Step 1.** `nfs.list_exports()` → `SelectDialog` over current paths.

**Parse current values.** `_parse_current_export(export)` extracts the five wizard-managed fields and **everything else** (`extra_opts`). Unknown options are anything not in `_WIZARD_MANAGED_OPTS = {"rw", "ro", "root_squash", "no_root_squash", "sync", "async"}` and not a `sec=…` line.

**Steps 2–6.** `_access_wizard(..., current=current)` — every step shows the current value.

**Step 7 — confirmation.** The new options list rebuilds the wizard-managed knobs **plus** appends the preserved `extra_opts`:

```python
options = [access, sync_mode, root_squash]
if sec != "sys":
    options.append(f"sec={sec}")
options.extend(current["extra_opts"])
```

So if the original export had `insecure,no_wdelay,fsid=0` (the appliance baseline from [Installer/fs-exports-spec.md §2.3](../Installer/fs-exports-spec.md#23-decoding-the-default-options)), those three options survive a wizard run unchanged. Note: `no_subtree_check` is *not* in `_WIZARD_MANAGED_OPTS`, so it counts as an extra and is preserved through edits — but unlike Add, Edit doesn't force-add it.

**Submission.** `update_export(path, patch)` with `patch = {"clients": [{"host", "options"}]}`. The helper's `update_export` is a merge-patch: it overwrites the `clients` list but leaves any other fields on the entry untouched (currently there are none, but the protocol is forward-compatible).

On success: `audit.log("nfs.update_export", path, "OK")` + `snapshots.record("share_modify", diff_summary=…)` + Show is refreshed.

### 4.6 Remove Share

Simple two-prompt flow:

1. `SelectDialog` over current export paths.
2. `ConfirmDialog("Remove export {path}?")` — single confirmation, no FINAL prompt (an export has no downstream FS state to worry about, unlike a RAID array or a mount).

Then `nfs.remove_export(path)`. On success: `audit.log("nfs.remove_export", path, "OK")` + `snapshots.record("share_delete", …)` + Show refreshed.

The export's directory on disk is **not** removed. Anything the share was rooted at stays put.

### 4.7 Active Sessions

`nfs.list_sessions()` reads `/proc/fs/nfsd/clients/*/info` on the server side, returning a list of `{client_ip, nfs_version, export_path, active_locks}` dicts. The screen prints `client → export_path` per row. The fallback path (when `/proc/fs/nfsd/clients` is empty — older kernels or v3-only servers) parses `/proc/net/rpc/auth.unix.ip`.

Per-export filtering is available via `nfs.get_sessions(path)`, but the screen always asks for the global list. Use the MCP tool surface for per-path queries.

### 4.8 Configure idmapd Domain

The only NFS-screen action that **does not** go through the helper socket. NFSv4 ID mapping (`/etc/idmapd.conf`) is a one-time / rare-edit configuration; rather than adding a `set_idmapd_domain` op to the helper, the screen edits the file directly in an executor:

1. Validate input — `domain` must contain at least one `.`.
2. Inline executor reads `/etc/idmapd.conf`, replaces the `^Domain\s*=\s*…` line with the new value, writes the file back. No locking, no atomic write — this is an admin-only screen.
3. `audit.log("nfs.idmapd_domain", domain, "OK")` + `snapshots.record("nfs_modify", …)`.

The screen does **not** restart `nfs-idmapd` — the daemon picks up the change on its next reload, and stale mappings flush quickly. If immediate effect is required, the operator can run `systemctl restart nfs-idmapd` separately.

---

## 5. End-to-end traces

### 5.1 Operator creates a new XFS filesystem from the TUI

```
FilesystemScreen._create_filesystem_wizard()
  ├─ grpc.raid_show(extended=True)             — list arrays
  ├─ for each array:
  │    └─ find_mounts_using_raid(name)         — findmnt scan (data + logdev)
  ├─ SelectDialog (data array)                 — TUI only
  ├─ SelectDialog (log array)                  — TUI only
  ├─ InputDialog (label)                       — TUI only
  ├─ InputDialog (mountpoint)                  — TUI only
  ├─ build_mount_options + calculate_stripe_width  — pure Python
  ├─ ConfirmDialog (summary)                   — TUI only
  ├─ check_existing_filesystem(/dev/xi_<name>)
  │    └─ blkid -s TYPE / LABEL
  ├─ mkfs_xfs(...)
  │    ├─ blockdev --getsize64 /dev/xi_<log>    — clamp log size
  │    └─ mkfs.xfs -f -L … -d su=Nk,sw=M -l logdev=…,size=… -s size=4k <data>
  ├─ create_mount_unit(...)
  │    ├─ mkdir -p <mountpoint>
  │    └─ write /etc/systemd/system/<unit>.mount  (mkstemp + os.replace)
  ├─ mount_filesystem(...)
  │    ├─ systemctl daemon-reload
  │    └─ systemctl enable --now <unit>
  ├─ audit.log("fs.create", …)                  — /var/log/xinas/audit.log
  └─ snapshots.record("fs_create", …)           — xinas_history snapshot
```

### 5.2 Operator adds an NFS share from the TUI

```
NFSScreen._add_share_wizard()
  ├─ findmnt -t xfs -n -o TARGET                — list candidate paths
  ├─ SelectDialog (path) or InputDialog (custom)
  ├─ _access_wizard(...)                        — 5 nested dialogs
  │    ├─ host (Everyone/Network/Single)
  │    ├─ access (rw/ro)
  │    ├─ root_squash (no_root_squash/root_squash)
  │    ├─ sync_mode (sync/async)
  │    └─ sec (sys/krb5/krb5i/krb5p)
  ├─ ConfirmDialog (summary)
  ├─ os.makedirs(path, exist_ok=True)
  ├─ nfs.add_export({"path":..., "clients": [...]})
  │    └─ Unix socket → xinas-nfs-helper
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
  ├─ findmnt -t xfs -J                          — enumerate mounts
  ├─ get_quota_status(options)                  — parse current flags
  ├─ SelectDialog (mountpoint)
  ├─ SelectDialog (action)                       — dynamic based on current state
  ├─ ConfirmDialog (warns about unmount/mount cycle)
  ├─ update_mount_unit_quota(mp, enable_user=True, enable_project=None)
  │    ├─ read /etc/systemd/system/mnt-data.mount
  │    ├─ regex update Options=
  │    ├─ atomic write (mkstemp + os.replace)
  │    ├─ systemctl daemon-reload
  │    ├─ systemctl stop mnt-data.mount         — XFS requires full cycle
  │    └─ systemctl start mnt-data.mount
  ├─ audit.log("fs.quota", "<mp>: enable user quotas", "OK")
  └─ snapshots.record("fs_modify", ...)
```

---

## 6. Audit + snapshot taxonomy across both screens

Every write operation in both screens emits two side-channel records — see [Storage/raid-management-spec.md §2.5](raid-management-spec.md#25-cross-cutting-helpers-audit--snapshots) for the helper internals.

| User action | Audit action | Snapshot operation | diff_summary |
|---|---|---|---|
| Create FS | `fs.create` | `fs_create` | `Created XFS filesystem '<L>' on <D>, mounted at <M>` |
| Delete FS | `fs.delete` (+ `nfs.remove` per affected share) | `fs_delete` | `Deleted filesystem at <M> (device <D>) [, removed N share(s)]` |
| Toggle quota | `fs.quota` | `fs_modify` | `Changed quotas on <M>: enable user quotas, …` |
| Add share | `nfs.add_export` | `share_create` | `Added NFS share <P>` |
| Edit share | `nfs.update_export` | `share_modify` | `Updated NFS share <P>` |
| Remove share | `nfs.remove_export` | `share_delete` | `Removed NFS share <P>` |
| Set idmapd domain | `nfs.idmapd_domain` | `nfs_modify` | `Set idmapd domain to <D>` |
| Share auto-removed during FS teardown | `nfs.remove` with `(FS teardown)` suffix | (none — rolled into `fs_delete`) | — |

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
| Helper socket missing / refused | every helper call | `NFSHelperClient` returns `(False, None, "…not found"/"…not running")`. The Show screen falls back to parsing `/etc/exports` directly; write screens surface the error and refuse to proceed. |
| Helper times out | `socket.timeout` after 10 s | Same `(False, None, …)` envelope; the dialog shows "NFS helper timed out". Write flows stop without partial state. |
| `exportfs -r` fails with non-`Failed to stat` error | helper `_exportfs_reload()` | Raises `RuntimeError`; the helper returns `{"ok": false, "code": "INTERNAL"}`; the TUI surfaces the message. |
| `nfs-kernel-server` not installed | helper startup health check | `xinas-nfs-helper` logs a warning at boot; first export op fails with `exportfs not found`. |
| Non-absolute `path` to `add_export` | `nfs_helper.handle_add_export` | `INVALID_ARGUMENT` — `"entry.path must be absolute"`. |
| Export target directory missing | `nfs_helper.handle_add_export` | `NOT_FOUND` unless `create_path=true`. TUI's Add wizard pre-creates the directory client-side. |
| Quota toggle while NFS clients connected | XFS requires unmount cycle | `_manage_quotas` warns up front; clients are briefly disconnected during the stop/start. |
| Mount-unit not found during quota toggle | `update_mount_unit_quota` | Returns `(False, "Mount unit not found: …")`; the dialog reports the missing path. |
| `mkfs.xfs` fails (e.g. log array too small) | `mkfs_xfs` returns `(False, …)` | Wizard aborts; no mount unit is created; operator must investigate (typically: log array undersized — see [Installer/raid-spec.md §6.1](../Installer/raid-spec.md#61-capacity-checks)). |
| Mount unit fails to start (e.g. xiRAID device not present) | `mount_filesystem` returns `(False, …)` | Wizard aborts after the mount unit was written; the unit stays on disk so the next `systemctl start` can succeed without re-running mkfs. |
| `findmnt` JSON parse error | Show / Delete / Quotas | Caught; the screen shows `(parse error: …)` but stays interactive. |
| RAID delete cascades into shares but `add_export` rollback fails | FS-delete rollback | The dialog reports "Rolled back N share(s)"; the failure is noted but rollback does not itself roll back. Audit log captures every step. |
| idmapd file unreadable | `_configure_idmapd` | Returns `(False, str(exc))`; the dialog shows the OS error. |

---

## 8. What these screens do **not** do

- They do not run `xicli` or `xfs_quota` directly. The first goes through the gRPC daemon; the second goes through the NFS helper (it's listed as one of the helper's ops but is not currently wired into any TUI screen — only the MCP tool surface uses it).
- They do not change `/etc/nfs.conf`. That is reachable through `nfs.fix_nfs_conf()` (the helper op) and is invoked by the Health screen's auto-fix and by MCP tools, **not** by the FS or NFS screens.
- They do not enforce per-export quotas. `uquota` / `pquota` are mount-level switches; assigning per-user / per-project byte limits is a separate operation (helper's `set_quota` op) that the TUI exposes only indirectly via the (not yet implemented) Users / Groups screens.
- They do not configure firewall rules for NFS ports. `2049/tcp` and `20049/rdma` are assumed open on the storage network — see [Installer/network-spec.md §9](../Installer/network-spec.md#9-what-the-installer-does-not-do).
- They do not edit `/etc/exports` directly, and they do not preserve hand-edits. The helper writes the file in full on every `add` / `remove` / `update` and re-injects the `# Managed by xinas-nfs-helper — do not edit manually` banner — anything in the file outside the structured format is dropped.
- They do not delete the on-disk content of a share or FS. Removing a share leaves the directory tree intact; deleting a filesystem removes the mount but leaves the XFS on `/dev/xi_<name>` so a re-mount picks up the existing data. The only place data is destroyed is `mkfs.xfs -f` in the Create wizard, and it's gated by an explicit confirmation when a filesystem is already present.
- They do not export the same path twice. `add_export` removes any existing entry with the same `path` before appending the new one — there is exactly one rule per path at any time.
