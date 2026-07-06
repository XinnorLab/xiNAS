# Design: VM-aware fallback when NVMe detection finds no data drives

**Date:** 2026-07-05
**Status:** Approved (brainstorming) — pending implementation plan
**Owning spec:** [docs/Installer/raid-spec.md](../Installer/raid-spec.md) (§1, §5, §9)
**Area:** Installer / storage provisioning (`nvme_namespace` role)

## Problem

An unattended, default-preset install on a KVM/virtio VM aborts mid-pipeline.
The failure is cryptic: the play dies in `raid_fs` complaining that
`xiraid_arrays` is undefined, several roles after the real cause.

## Root cause

1. The `default` preset ships **no** `nvme_namespace.yml`, so the role uses its
   built-in default `nvme_detect_mode: "nvme"` (NVMe controllers only).
2. On a virtio/SCSI VM there are **0 NVMe controllers** → `nvme_data_drives == []`.
3. With 0 data drives, [`nvme_namespace/tasks/main.yml`](../../collection/roles/nvme_namespace/tasks/main.yml)
   prints a debug notice and **silently skips** namespace rebuild and RAID-config
   generation (`when: nvme_data_drives | length > 0` guards on Phases 5–7). The
   facts `xiraid_arrays` / `xfs_filesystems` are never set.
4. The next role, [`raid_fs/tasks/main.yml`](../../collection/roles/raid_fs/tasks/main.yml)
   (§7.1 of the spec), fast-fails because those facts are undefined. **This is the
   observed mid-pipeline abort.**
5. `systemd-detect-virt` is already used to *suggest* the `xinnorVM` preset — but
   only in the interactive `startup_menu.sh` (`is_vm` / `suggest_vm_preset`).
   Neither `autoinstall.sh` nor any Ansible role is VM-aware, so the unattended
   path has no safety net.

## Decision

**Hybrid behavior**, chosen over fail-fast-only and auto-fallback-only:

- **VM + candidate disks present** → auto-fall back to whole-disk (`all`-mode)
  detection so the unattended install completes.
- **Bare metal + candidate disks present** → fail-fast with an actionable error
  (don't silently RAID over SATA disks the operator didn't mean to consume).
- **No candidate disks at all** → fail with a clear "no data drives" message.

Rationale: unattended VM installs "just work"; genuine bare-metal
misconfiguration fails loudly with a remedy instead of a cryptic downstream
abort. Auto-fallback is gated on virtualization precisely because on bare metal
it could grab unintended SATA/other disks.

## Where the fix lives

Single change site: [`collection/roles/nvme_namespace/tasks/main.yml`](../../collection/roles/nvme_namespace/tasks/main.yml).
It is the one choke point every install path (interactive-default,
explicit-default, unattended) flows through, and it is exactly where the
"0 drives → silent skip" happens today. `autoinstall.sh`, the presets, and the
menus are **not** touched.

## Control flow (new fallback block)

Runs after the existing `nvme`-mode block, gated on
`nvme_detect_mode == 'nvme'` **and** `nvme_data_drives | length == 0`:

```
NVMe detection finds 0 data drives
  └─ run detect_all_drives.yml    (re-probe ALL block devices; this both answers
     │                             "are there non-NVMe candidates?" AND populates
     │                             nvme_small_ns_devices / nvme_large_ns_devices)
     ├─ still 0 candidates ──────────────► FAIL: "no data drives found at all"
     └─ candidates exist
          ├─ systemd-detect-virt == none ─► FAIL-FAST: actionable bare-metal error
          └─ virt != none (VM) ───────────► auto-fallback:
                 force nvme_raid_log_level = 1   (RAID1 log, matches xinnorVM)
                 log a visible WARNING that VM disk-detection was auto-selected
                 → cleanup_storage.yml → generate_raid_config.yml
                 (whole-disk path; no namespace rebuild)
```

The existing Phases 5–7 already carry `when: nvme_data_drives | length > 0`
guards, so they self-skip on the empty run; the fallback block slots in cleanly
after them. Facts set by `detect_all_drives.yml` (`set_fact`) persist beyond the
block scope, so `cleanup_storage.yml` and `generate_raid_config.yml` see them.

### Virt detection

A `command: systemd-detect-virt` task (`changed_when: false`,
`failed_when: false`); any output other than `none`/empty is treated as a VM —
the same semantics as `is_vm()` in `startup_menu.sh`. (Ansible's gathered
`ansible_virtualization_role` is a zero-cost alternative but we match the
project's established tool for consistency.)

### Why `nvme_raid_log_level` must be forced to 1 in the fallback

The `default` preset's [raid_fs.yml](../../presets/default/raid_fs.yml) sets
`nvme_raid_log_level: 10`, which needs **4** log members. Without overriding it,
the fallback would re-fail at the RAID-minimums check in
`generate_raid_config.yml`. Forcing level `1` reproduces the proven `xinnorVM`
VM layout exactly (RAID1 log over the first 2 disks). The data level (`5`) is
already identical to `xinnorVM`, so only the log level is changed.

### Error messages (both fail branches name the remedy)

- **Bare metal, 0 NVMe but candidate disks present:**
  > Detected N non-NVMe disk(s) (sdX…) but 0 NVMe data drives, and this host is
  > not virtualized. If these are your intended data drives, re-run with the
  > `xinnorVM` preset or set `nvme_detect_mode: all`. If you expected NVMe drives,
  > verify the NVMe controllers are present and not held by the OS.

- **No disks at all:**
  > No data drives found (no NVMe namespaces and no non-OS block devices). Attach
  > data disks before deploying.

## Scope boundary

The fallback makes a VM with **≥ 5 non-OS disks** succeed on the default preset
(2 log + ≥3 data, per xinnorVM geometry). A VM with fewer disks still fails — but
now via the clear "insufficient devices" message in `generate_raid_config.yml`,
identical to how the `xinnorVM` preset fails today. **Out of scope:** a special
JBOD / single-disk / degraded layout for 2–4-disk VMs. (Confirmed with the
requester.)

## Non-goals / deliberately unchanged

- **No `autoinstall.sh`, preset, or menu changes.** The role fix covers every path.
- **No `Requires-Rebuild:` trailer.** `nvme_namespace` is fresh-install-only;
  re-running it on a live host rebuilds namespaces/arrays destructively, so the
  update flow must never auto-run it. Adding the trailer would train users to
  click past a dangerous Ansible re-run.
- No change to the interactive `suggest_vm_preset` nicety (now redundant for
  correctness but harmless).

## Touch points

| File | Change |
|---|---|
| [collection/roles/nvme_namespace/tasks/main.yml](../../collection/roles/nvme_namespace/tasks/main.yml) | New fallback block after the `nvme`-mode block |
| [docs/Installer/raid-spec.md](../Installer/raid-spec.md) | §1 new subsection (empty-NVMe fallback contract); §9 new failure-mode row |

## Test plan (to be detailed in the implementation plan)

- **VM, 0 NVMe, ≥5 virtio disks** → auto-fallback; `xiraid_arrays` +
  `xfs_filesystems` generated with RAID1 log; install proceeds.
- **VM, 0 NVMe, 3 virtio disks** → fails at RAID-minimums with the clear
  "insufficient devices" message (not the `raid_fs` undefined-fact abort).
- **Bare metal, 0 NVMe, SATA present** → fail-fast with the actionable message.
- **No non-OS disks at all** → "no data drives found" failure.
- **Bare metal with NVMe data drives** → unchanged (no fallback triggered).
- Molecule/CI harness TBD in the plan; unit-level assertion via a mocked
  `systemd-detect-virt` + `lsblk` fixture where feasible.
