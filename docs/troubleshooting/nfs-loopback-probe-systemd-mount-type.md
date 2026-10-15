# `nfs_loopback` probe always fails: `systemd-mount` without `--type=nfs`

**Found:** 2026-10-15, hardware smoke run on xinas-box (runbook §5a).
**Affects:** every release from v3.1.1 (the first with the S7 deep
probes) through v3.13.3, and `release/3.14` and `release/3.15` before
this fix. Checked with `git tag --contains f8bd8071` (the S7 deep-probe
commit) and the argv at `v3.13.0:xiNAS-MCP/src/agent/health/probe-host.ts`.
**Fixed by:** `fix/nfs-loopback-mount-type` (S19 spec §9.3
`nfs_loopback` step 2).

## Symptom

- `POST /api/v1/health/probe {probe: nfs_loopback, target: <share id>}`
  answers `200` with `ok: false`, `error.stage: "mount"` and
  `cleanup.status: "clean"`.
- `GET /api/v1/health?profile=deep` reports `nfs.loopback: critical`, so
  the whole report is `critical` on a healthy node.
- The error text in both:

  ```text
  systemd-mount --collect localhost:/mnt/data /run/xinas/health-probe/<run>-<random>/mnt
  failed: Failed to make path localhost:/mnt/data absolute: No such file or directory
  ```

## Cause

The agent's probe host ran `systemd-mount --collect localhost:<export>
<mnt>` with no file-system type. Without a type, `systemd-mount` handles
the source as a local path and tries to resolve it, which fails for
`host:/path` before any mount is attempted.

The unit test pinned exactly that argument list against a stubbed
`systemd-mount`, and CI has no systemd, so nothing exercised the real
command until a node ran it.

## Evidence

On xinas-box, 2026-10-15 (Ubuntu 24.04.1, kernel 6.8.0-124, systemd
255.4-1ubuntu8.18):

| Command | Result |
|---------|--------|
| `systemd-mount --collect localhost:/mnt/data <mnt>` (what the probe ran) | exit 1, `Failed to make path localhost:/mnt/data absolute` |
| `systemd-mount --collect --type=nfs localhost:/mnt/data <mnt>` (the fixed argv) | exit 0, `localhost:/mnt/data nfs rw,…,vers=3`, `readdir` lists the export |
| `systemd-umount <mnt>` (the probe's cleanup) | exit 0; `st_dev` of `<mnt>` equals its parent's; no mount, transient unit or directory left |
| `systemd-mount --collect --type=nfs --options=ro …`, then `systemd-mount --umount <mnt>` (first check) | exit 0 / exit 0, `ro,…,vers=3` |

The systemd 255 manual
(<https://www.freedesktop.org/software/systemd/man/255/systemd-mount.html>)
does not state the rule; the table above is the source.

## Fix

Pass `--type=nfs`: `systemd-mount --collect --type=nfs localhost:<export>
<mnt>`. The probe's cleanup, lock and timeout handling are unchanged —
they behaved correctly throughout: the failed probe left nothing mounted
and no directory behind.

## Hosts that already run an affected release

Nothing to repair. The probe never mounted anything, and the deep
profile's `nfs.loopback: critical` is a false result, not a sign of an
NFS fault. A host picks up the fix with the release that carries it
(`Requires-Rebuild: xinas_node_build`).
