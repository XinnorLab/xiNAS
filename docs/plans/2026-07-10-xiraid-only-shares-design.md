# Restrict NFS shares to xiRAID-backed filesystems — design

**Date:** 2026-07-10
**Status:** Approved (brainstorming), pending implementation plan
**Owning specs:** [docs/Storage/fs-shares-management-spec.md](../Storage/fs-shares-management-spec.md) §4.5,
[docs/control-path/s3-nfs-executor-spec.md](../control-path/s3-nfs-executor-spec.md) §3.1

## Problem

The Add Share wizard lets an operator create an NFS export on **any** absolute
path, even when there is no filesystem on top of a xiRAID array. In the empty
case (no XFS mounts at all) the wizard silently drops to a free-form input
defaulting to `/mnt/data/` and validates only that the path starts with `/`
([xinas_menu/screens/nfs.py](../../xinas_menu/screens/nfs.py) `_add_share_wizard`,
lines 397–456). The result is a share exported from the OS root filesystem (or a
non-existent directory that the wizard then `mkdir`s), which is never the intended
data path. The control-path `share.create` executor does not guard against this
either — its only preflight blocker is `EXPORT_PATH_IN_USE`.

## Goal

NFS shares may be created **only** from a filesystem that sits on top of a xiRAID
array, at the mount root or any subfolder beneath it. Enforce this on both
surfaces the operator can reach: the TUI Add Share wizard **and** the control-path
`share.create` verb (so MCP callers are equally constrained).

## The invariant

> An export path is valid **iff** it is at-or-under the mountpoint of an XFS
> filesystem whose backing block device is a xiRAID volume (`/dev/xi_*`).

xiRAID Classic always exposes an array as `/dev/xi_<name>`; this convention is
already relied on across the codebase
([xfs_helpers.py:341](../../xinas_menu/utils/xfs_helpers.py) `find_mounts_using_raid`,
[raid.py:298](../../xinas_menu/screens/raid.py) `volume_path`,
[filesystem.ts:6](../../xiNAS-MCP/src/agent/collectors/filesystem.ts) `backing_device`).
Detection is a **prefix match** on the backing device path (`startswith("/dev/xi_")`):
xiNAS owns that namespace, so a cross-check against the live RAID array list buys
no additional safety and is deliberately omitted.

"At-or-under" means the mount root itself (`/mnt/data`) or any subfolder
(`/mnt/data/share1`) is accepted; a sibling or unrelated path (`/srv/foo`) is not.

## Surface 1 — TUI Add Share wizard

File: [xinas_menu/screens/nfs.py](../../xinas_menu/screens/nfs.py) `_add_share_wizard`.

1. **Candidate gathering.** Replace `findmnt -t xfs -n -o TARGET` with
   `findmnt -t xfs -n -o TARGET,SOURCE` and keep only rows whose SOURCE starts
   with `/dev/xi_`. This yields the list of xiRAID-backed mount roots.
2. **Empty case.** If there are no xiRAID-backed mounts, abort **before** starting
   the wizard with an OK-only dialog:
   *"No xiRAID-backed filesystem found. NFS shares can only be exported from a
   filesystem on a xiRAID array. Create one first: Storage → Filesystems → Create
   Filesystem."* The free-form `/mnt/data/` fallback is removed entirely.
3. **Non-empty case.** `SelectDialog` over the xiRAID mount roots plus the existing
   `Custom path…` option.
   - A directly picked mount root is valid as-is.
   - A `Custom path…` entry is validated with a containment check against the
     xiRAID mount list: accept when the entered path is at-or-under **some**
     xiRAID mount root, otherwise re-prompt with an error notification
     (*"Export path must be inside a xiRAID filesystem (…)."*). The existing
     "must start with `/`" check is retained.

The rest of the wizard (host, access, squash, sync, sec, confirm, `mkdir -p`, the
`POST /api/v1/shares` submit) is unchanged.

## Surface 2 — control-path `share.create`

Enforced with a **single live executor preflight** (no plan-side blocker). The
executor check gates `apply` for every caller — including MCP — and is
authoritative because it reads live mount state. A plan-side blocker was
considered (to mirror `EXPORT_PATH_IN_USE` and preview the rejection in `plan`
mode) but **rejected**: it would read *observed* `Filesystem` state, so a
momentarily degraded or not-yet-observed collector could falsely block a
legitimate create. The live preflight has no such failure mode.

### Executor preflight
File: [xiNAS-MCP/src/agent/task/nfs-executor.ts](../../xiNAS-MCP/src/agent/task/nfs-executor.ts)
`buildShareCreate`.

Add a check at the head of the preflight stage using the existing `readMounts()`
seam (already wired for the delete guard,
[wiring.ts:215](../../xiNAS-MCP/src/agent/task/wiring.ts)). Select the **longest**
mountpoint that contains the export path; if none contains it, or the containing
mount's `source` does not start with `/dev/xi_`, throw `EXPORT_PATH_NOT_ON_XIRAID`.
Selecting the longest match correctly ignores the root `/` mount when a nested
xiRAID mount (e.g. `/mnt/data`) is the real backing. **Fail-closed**: if the mount
reader throws (unreadable `/proc`), the preflight fails and the share is not
created — no destruction risk, consistent with the delete guard's philosophy.

Wiring: extend `NfsExecutorDeps` with the `readMounts` reader and thread the same
`opts.readMounts ?? (fixture | readProcMounts)` default the delete executor uses,
so fixture-mode e2e reads `mounts.json`.

### Scope
Only `share.create` is gated. `share.update` / `share.delete` and the TUI Edit
Share flow operate on an already-exported (already-valid) path and are not
re-checked. Filesystem deletion already warns about affected shares
(fs-shares-management-spec §5).

## Small consolidation

Factor the "path at-or-under root" check into a shared helper
`is_path_under(path, root)` in [xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)
and use it from `nfs.py`; `raid.py` currently has a private `_is_under` with
identical semantics and switches to the shared helper. Same-area cleanup, no
behavior change.

## Rebuild marker

The TypeScript control-path change ships in `dist/` and requires a rebuild on the
host:

```
Requires-Rebuild: xinas_node_build
```

(The TUI-only Python changes do not require an Ansible re-run.)

## Testing

- **TUI (pytest):** the xiRAID-mount filter keeps only `/dev/xi_*` sources; the
  empty case aborts with the guidance dialog and never opens the free-form input;
  a custom path inside a xiRAID mount is accepted; one outside is rejected.
- **Server executor (vitest):** preflight rejects an off-xiRAID path (no
  containing mount and non-xiRAID containing mount); accepts an on-xiRAID path
  (mount root and subfolder); longest-match wins over `/`; fails closed when
  `readMounts` throws. Update the existing happy-path `share.create` tests to
  inject a `/dev/xi_*` mount and add a `mounts.json` to the e2e fixture covering
  the exported path.

## Error taxonomy

| Condition | Surface | Signal |
|-----------|---------|--------|
| No xiRAID-backed mount exists | TUI | OK-only guidance dialog, wizard never starts |
| Custom path outside any xiRAID mount | TUI | Error notification, re-prompt |
| Path off xiRAID (apply, live) | Control-path | preflight throws `EXPORT_PATH_NOT_ON_XIRAID` |
| Mount reader unreadable | Control-path | preflight throws (fail-closed) |
