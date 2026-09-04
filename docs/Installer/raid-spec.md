# xiNAS Installer — NVMe Namespace & RAID Creation Specification

This document covers the storage-provisioning path: how the installer discovers data drives, optionally rebuilds NVMe namespaces, wipes prior storage configurations, generates the RAID layout, creates xiRAID arrays, and lays down the XFS filesystem that NFS will export.

Two roles do all the work, in this order:

```
nvme_namespace → raid_fs
```

`nvme_namespace` produces two Ansible facts — `xiraid_arrays` and `xfs_filesystems` — and `raid_fs` consumes them. Everything below assumes you start from a clean install with `xiraid_classic` already installed and the license at `/tmp/license`.

Sources this spec is derived from:

- [collection/roles/nvme_namespace/tasks/main.yml](../../collection/roles/nvme_namespace/tasks/main.yml) — phase orchestrator
- [tasks/detect_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_drives.yml), [detect_all_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_all_drives.yml) — system-vs-data drive split
- [tasks/cleanup_storage.yml](../../collection/roles/nvme_namespace/tasks/cleanup_storage.yml) — LVM/MD/ZFS removal
- [tasks/collect_topology.yml](../../collection/roles/nvme_namespace/tasks/collect_topology.yml), [rebuild_namespaces.yml](../../collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml), [detect_existing_namespaces.yml](../../collection/roles/nvme_namespace/tasks/detect_existing_namespaces.yml)
- [tasks/generate_raid_config.yml](../../collection/roles/nvme_namespace/tasks/generate_raid_config.yml) — produces `xiraid_arrays` + `xfs_filesystems`
- [collection/roles/raid_fs/tasks/main.yml](../../collection/roles/raid_fs/tasks/main.yml), [create_array.yml](../../collection/roles/raid_fs/tasks/create_array.yml), [create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml), [templates/mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2)
- Preset overrides: [presets/default/raid_fs.yml](../../presets/default/raid_fs.yml), [presets/xinnorVM/nvme_namespace.yml](../../presets/xinnorVM/nvme_namespace.yml), [presets/xinnorVM/raid_fs.yml](../../presets/xinnorVM/raid_fs.yml)

---

## 1. Detection mode picks the path

The role has two strategies, selected by `nvme_detect_mode`:

| Mode | Used by preset | Detection source | Namespace handling |
|---|---|---|---|
| `nvme` *(default)* | `presets/default/` | `/dev/nvme[0-9]+` (controllers only) | Delete all NSes per drive → create a small NS (500 MB, NSID 1) + a large NS (rest, NSID 2); block devices resolved by controller serial + NSID, never by the `nvmeXnY` name (§4.5) |
| `all` | `presets/xinnorVM/` | `lsblk -dnpo NAME,TYPE` (every `disk`) | None — whole drives used as-is |

If `nvme_auto_namespace: false`, the role prints a notice and does nothing — operators must define `xiraid_arrays` / `xfs_filesystems` themselves in the preset.

### 1.1 Empty-NVMe fallback (VM safety net)

`nvme` mode assumes real NVMe controllers exist. On a virtio/SCSI VM there are
none, so `nvme_data_drives` comes back empty. Rather than silently skip RAID
generation (which made `raid_fs` abort several roles later with an undefined
`xiraid_arrays`), the role runs a fallback whenever **`nvme_detect_mode == 'nvme'`
and zero data drives were found**:

1. Re-probe every block device via `detect_all_drives.yml` (§5).
2. **No non-OS disks at all** → fail: *"No data drives found … Attach data disks."*
3. **`systemd-detect-virt` reports a VM** (output not `none`/empty) → auto-continue
   in whole-disk mode: force `nvme_raid_log_level: 1` (RAID1 log, matching the
   `xinnorVM` geometry), run cleanup (§3) and `generate_raid_config.yml` (§6). A
   warning is logged that VM detection was auto-selected and that **all** non-OS
   disks will be consumed.
4. **Bare metal with non-NVMe disks present** → fail-fast: *"Detected N non-NVMe
   disk(s) … not virtualized. Re-run with the `xinnorVM` preset or set
   `nvme_detect_mode: all` …"* — the role will not silently RAID over SATA disks
   the operator didn't mean to consume.

Effective minimum for the VM auto-path is **6 non-OS disks** (2 log + 4 data for
RAID5 — see §6.1); fewer disks fail with the clear "insufficient devices" message
from §6, identical to how the `xinnorVM` preset fails today. The fallback changes
only the `default`-preset path; `autoinstall.sh`, the presets, and the menus are
untouched.

> This minimum was **5** (2 log + 3 data) until the RAID-5 minimum was corrected
> from the textbook `3` to the engine-enforced `4` (§6.1). A VM with exactly 5
> non-OS disks used to pass preflight and then fail mid-install at
> `xicli raid create` — it now fails earlier, at the `generate_raid_config.yml`
> preflight, before any namespace or array work has run.

---

## 2. System-drive detection (both modes)

Before touching anything, the role figures out which drives are off-limits.

Source: [resolve_system_disks.yml](../../collection/roles/nvme_namespace/tasks/resolve_system_disks.yml) → [files/resolve_system_disks.sh](../../collection/roles/nvme_namespace/files/resolve_system_disks.sh) — shared by [detect_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_drives.yml) (`nvme` mode) and [detect_all_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_all_drives.yml) (`all` mode / VM fallback). The resolver logic lives in a standalone script so it can be unit-tested against stubbed `findmnt`/`lsblk`/`zpool` ([tests/test_nvme_resolve_system_disks.py](../../tests/test_nvme_resolve_system_disks.py)).

It builds `nvme_system_drives` by **resolving each OS mount down to the physical disk(s) it is built on**, walking through any device-mapper / LVM / MD / ZFS layer. For each of:

1. **Root** — `findmnt -no SOURCE /`
2. **Boot** — `findmnt -no SOURCE /boot` (only if separate from root)
3. **EFI System Partition(s)** — `/boot/efi`, plus a GUID scan via `lsblk -nrpo NAME,PARTTYPE` matching the standard ESP GUID `c12a7328-f81f-11d2-ba4b-00a0c93ec93b`. **All** matching ESPs are resolved, not just the mounted one, so mirrored-ESP layouts protect every backing disk.

Resolution per source:

- A `/dev/…` source is fed to `lsblk --inverse -npo NAME,TYPE <src>`; every row whose `TYPE == disk` is a physical system disk. A guided-LVM, dm-crypt, or MD-root install exposes `/` as `/dev/mapper/…` or `/dev/mdX`, **not** as `/dev/nvmeXnY`; the inverse device tree traces those opaque names back to the real disk(s) — including every member of an MD/LVM mirror or stripe. A btrfs subvolume suffix (`/dev/sda2[/@]`) is stripped first.
- A **ZFS** root (`findmnt` returns `pool/dataset`, not a `/dev` path) is resolved via `zpool status -LP <pool>`: every `/dev/…` vdev member is run back through `lsblk --inverse`, so all pool disks are protected — not just whichever one happens to carry the ESP.
- An **nfs / network** source (`host:/export`), or a ZFS pool that `zpool` cannot resolve, contributes nothing.

> **Why not just strip the partition suffix?** The previous implementation ran `sed 's/p?[0-9]+$//'` on the raw `findmnt` output. On a direct-partition root (`/dev/nvme0n1p2 → /dev/nvme0n1`) that worked, but on an LVM root it produced `/dev/mapper/ubuntu--vg-ubuntu--lv` — a string that *passes* the `^/dev/` filter (so `nvme_system_drives` was non-empty and the abort guard below never fired) but resolves to no physical NVMe controller. The OS disk was then classified as a data drive and wiped by the §3 cleanup pass. Resolving through `lsblk --inverse` (and `zpool status` for ZFS) closes that fail-open hole.

In `nvme` mode, anything matching `/dev/nvmeXnY` in `nvme_system_drives` is collapsed to the controller path `/dev/nvmeX` and pushed into `nvme_system_controllers`. That set is then **excluded** from `nvme_data_drives`. In `all` mode the physical system disks are excluded directly. An OS on a non-NVMe disk (SATA `/dev/sda`, virtio `/dev/vda`) is a legitimate configuration: `nvme_system_controllers` is empty and every NVMe drive is available as data — that empty set is **not** treated as a failure.

Hard safety stop: the resolver also publishes `nvme_system_root_resolved` — true **only** when the *root filesystem* mapped to at least one physical disk. If `nvme_abort_if_no_system_drive=true` (default) and either no system disk resolved **or** the root did not resolve, the play fails with a CRITICAL message **before any cleanup runs**. The `root_resolved` signal is what makes ZFS / iSCSI / diskless roots fail closed even when a `/boot/efi` ESP already populated `nvme_system_drives` — protecting the ESP disk while silently leaving other root-pool members exposed is exactly the trap this avoids. Override to `false` only for roots you have manually confirmed are safe.

Defense in depth: after the split, each detection path runs an `assert` that `nvme_data_drives` shares no member with the protected set (`nvme_system_controllers` in `nvme` mode, `nvme_system_drives` in `all` mode). By construction this always holds; the assert exists to halt the play immediately if a future edit to the reject logic ever regresses.

Result: `nvme_system_drives` (protected list) and `nvme_data_drives` (everything else).

---

## 3. Pre-namespace cleanup — LVM / MD RAID / ZFS

Source: [cleanup_storage.yml](../../collection/roles/nvme_namespace/tasks/cleanup_storage.yml). Runs only if `nvme_cleanup_existing_storage=true` (the default) and at least one data drive was found.

### 3.1 Discovery

Three independent scans, each restricted to `nvme_data_drives`:

- **LVM** — `pvs --noheadings -o pv_name,vg_name`; each PV tested for membership. Produces `nvme_found_lvm_pvs` and the unique `nvme_found_lvm_vgs`.
- **MD RAID** — for every `/dev/md*` block device, `mdadm --detail` is parsed and each component tested for membership. Matching arrays land in `nvme_found_md_arrays`.
- **ZFS** — only if `which zpool` succeeds. For each pool, `zpool status -LP` resolves the vdevs to real full paths (`-L` follows symlinks, `-P` prints full paths) and the `/dev/*` entries are each tested for membership; any pool with a vdev on a data drive is added to `nvme_found_zpools`. This is device-type agnostic — `nvme*`, `sd*`, `vd*` (the xinnorVM device type), and by-id vdevs all resolve to their real `/dev` node, where the earlier name-prefix grep (`nvme|sd`) was blind to everything else.

**Boundary-safe membership.** Every one of those tests — and the later
`mdadm --zero-superblock` / `pvremove` / partition-table-wipe sweeps — routes through the
`is_data_member` helper in [files/disk_match.sh](../../collection/roles/nvme_namespace/files/disk_match.sh)
rather than a string prefix. The old `[[ "$pv" == "${drive}"* ]]` / `${drive}*`
glob matching was unsafe: a data controller `/dev/nvme1` is a string prefix of
`/dev/nvme10`, so an OS partition `/dev/nvme10n1p3` on a *protected* controller
was dragged into cleanup and its VG/array/pool destroyed. `is_data_member`
matches only on device-name boundaries (`/dev/nvme1` → `/dev/nvme1n…`, never
`/dev/nvme10…`) **and** vetoes anything that also resolves onto a
`nvme_system_drives` / `nvme_system_controllers` member first. The
`zero-superblock`, `pvremove`, and partition-table-wipe sweeps enumerate real
block devices via `lsblk` and filter them through the same helper instead of
globbing `${drive}*`. Unit tests: [tests/test_nvme_disk_match.py](../../tests/test_nvme_disk_match.py).

`nvme_cleanup_required` is the OR of the three.

### 3.2 Confirmation gate

If anything was found:

- A banner is printed listing the VGs/MD arrays/pools that will be destroyed. This always-shown findings banner also carries the wipe-scope disclosure (partition tables/signatures wiped on ALL data drives, listing `nvme_data_drives`), so unattended runs with `nvme_skip_cleanup_confirmation=true` — which never see the confirmation prompt — still log it.
- Unless `nvme_skip_cleanup_confirmation=true` (default `false` — operators must type `YES` interactively), an `ansible.builtin.pause` task waits for confirmation. The confirmation banner enumerates the found VG/MD/ZFS counts **and** discloses that partition tables/signatures will be wiped on ALL data drives, listing `nvme_data_drives`. Anything other than `YES` aborts with `Cleanup cancelled by user.`

For unattended deployments set `nvme_skip_cleanup_confirmation: true` in the preset or inventory — that is the dangerous knob the comments call out.

### 3.3 Destruction order

The order is chosen so dependent objects are gone before their backing store is wiped:

1. **ZFS** — `zpool destroy -f <pool>` for every found pool.
2. **MD RAID** — `mdadm --stop <md>` for each array, then `mdadm --zero-superblock` on every partition and whole-disk block device of every data drive (enumerated via `lsblk`, filtered through `is_data_member`).
3. **LVM** — `vgchange -an <vg>`, `vgremove -f <vg>`, then `pvremove -f` on every partition and whole-disk block device of every data drive (enumerated via `lsblk`, filtered through `is_data_member`).
4. **Partition tables** — `wipefs -a` plus `dd` on the first MB and the last MB of every whole-disk **block device** that resolves to a data drive (so both MBR and the GPT backup header at end-of-disk are gone), followed by `partprobe` on the same device so the kernel re-reads the table. Like the MD/LVM sweeps, the targets come from `lsblk` filtered through `is_data_member`, **not** from the raw `nvme_data_drives` entries: in the default NVMe mode those entries are controller char devices (`/dev/nvme0`), on which `wipefs`/`dd`/`partprobe` silently no-op — a controller entry therefore resolves to its namespace block devices (`/dev/nvme0n1`, …), while a whole-disk entry (`/dev/vdb`) matches itself. Failures are isolated per device: the end-of-disk size is computed defensively (empty/non-numeric `blockdev --getsz` output skips only that device's last-MB `dd`), so one flaky or vanished device never aborts the wipe/`partprobe` for the remaining drives.

Each step uses `failed_when: false` so a stale or already-deactivated object never blocks the install. The final summary banner prints how many of each type were removed.

---

## 4. Mode `nvme` — namespace rebuild

The default preset path. Runs only after cleanup is done.

### 4.1 Topology collection

Source: [collect_topology.yml](../../collection/roles/nvme_namespace/tasks/collect_topology.yml). Hard-requires `nvme-cli` (`which nvme` must succeed; otherwise the play fails with a clear install hint).

For every controller in `nvme_data_drives` the role records three numbers:

| Field | How it's read | Fallback |
|---|---|---|
| `existing_namespaces` (list of NSIDs) | `nvme list-ns <ctrl> -a` (`-a` includes unattached NSes) | empty list |
| `capacity_bytes` (total NVM capacity) | `nvme id-ctrl` → `tnvmcap` | sum of namespace sizes from `nvme list` (TB/GB/MB parsed) |
| `lba_size` (bytes per LBA) | `nvme id-ns <ctrl> -n <first NSID of existing_namespaces>` → in-use `lbads` (log2); queried through the controller, so no block-device name is involved (§4.5) | `512` (also when the controller has no namespace) |

The list of dicts is stored as `nvme_topology`.

### 4.2 Converge path — reuse existing namespaces (state MATCH)

Source: [detect_existing_namespaces.yml](../../collection/roles/nvme_namespace/tasks/detect_existing_namespaces.yml).

A read-only preflight (`detect_storage_state.yml`) classifies the box as
`xinas_storage_state` ∈ {MATCH, EMPTY, FOREIGN, UNKNOWN} before any namespace decision (see §11).
When the box is **MATCH** (the expected xiRAID `data`+`log` arrays are online and
`/dev/xi_data` is XFS with the configured label) and `xinas_storage_reset` is not set,
the role reuses the namespaces already on the drives — no rebuild, no data loss:

- `files/nvme_ns_device.sh list <ctrl>` per data drive: every namespace block device of the controller as `<nsid> /dev/<dev> <serial>_<nsid>`, matched by controller serial + NSID — the identity xiRAID itself keys drives on (§4.5) — never by the `nvmeXnY` suffix.
- NSID 1 → log devices (`nvme_small_ns_devices`).
- NSID 2 and above → data devices (`nvme_large_ns_devices`).
- Requirement: existing-namespace reuse needs the NSID 1 (log) + NSID 2 (data) two-namespace layout on every data drive. If **no** NSID ≥ 2 namespace was found anywhere, the task fails explicitly ("Fail on single-namespace layout") naming the remedy — re-run with `xinas_storage_reset: true` to wipe and rebuild the two-namespace layout, or provision it manually. The per-tier detection banner is printed before this check, so the failure path shows which devices were classified as NSID 1. A single-namespace layout can never legitimately reach this task on a healthy converge: `MATCH` requires the `data` xiRAID array to report itself online — read out of the daemon's own per-array `state` words, not inferred from the array existing (§11) — **and** `/dev/xi_data` probing as XFS with the configured label, and that array is built from the NSID 2 devices (§6.4) — so a genuine MATCH implies NSID ≥ 2 namespaces exist, and the only way to trip this fail is a layout tampered with outside the role.

**EMPTY** (a fresh box, including a factory single-namespace drive) or an explicit
`xinas_storage_reset: true` falls through to the delete+recreate path in §4.3. **FOREIGN**
and **UNKNOWN** without reset fail fast before touching anything. The deprecated
`nvme_use_existing_namespaces` knob no longer drives this choice.

### 4.3 Delete + recreate

Source: [rebuild_namespaces.yml](../../collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml).

For every controller in `nvme_topology`:

**Step 1 — delete all existing namespaces.** For each NSID from `nvme list-ns <ctrl> -a`:

```
nvme detach-ns <ctrl> -n <nsid> -c <cntlid>   # cntlid pulled from id-ctrl
nvme delete-ns <ctrl> -n <nsid>
```

`detach` failures are swallowed (a not-attached NS isn't an error); `delete` failures always push the controller onto `nvme_failed_devices`, regardless of `nvme_skip_failed_devices`. With `nvme_skip_failed_devices=true` (default `true`) the play continues, skipping that drive in every downstream step (create/attach/wait, all gated on `item.controller not in nvme_failed_devices`); otherwise the play fails immediately on any delete failure.

**Step 2 — create the small (log) namespace.**

- Size: `nvme_small_ns_size_mb` × 1 MiB → blocks at `nvme_namespace_block_size`.
- LBA format: the role looks for an `lbaf` row in `nvme id-ns` with `ms:0` (no metadata) and `lbads:12` (`4096` bytes) or `lbads:9` (`512` bytes), whichever matches `nvme_namespace_block_size`. If no matching format exists, it falls back to format `0` with a warning — likely indicates the drive doesn't support the requested block size.
- Shared flag: `-m 1` only when `nvme_namespace_shared=true`. Default is `false`. On non-HA single-controller hardware (which is xiNAS's default target), `nvme create-ns -m 1` is rejected by the drive — leaving this `false` is mandatory there.

```
nvme create-ns <ctrl> -s <blocks> -c <blocks> -f <flbas> -d 0 [-m 1]
nvme attach-ns <ctrl> -n <new_nsid> -c <cntlid>
```

Failures land the controller in `nvme_failed_devices`. The NSID the controller assigned is read back (`nvme list-ns <ctrl> -a`, last entry — 1 on a controller whose namespaces were all just deleted, but the role never assumes so) and recorded as `nvme_small_ns_ids[<ctrl>]`; Step 4 waits for that NSID, never for a name.

**Step 3 — create the large (data) namespace.**

- Unallocated capacity: `nvme id-ctrl` → `unvmcap`; fallback subtracts the sum of existing NS sizes from `tnvmcap`.
- If unallocated ≤ 1 MiB the step prints a warning and skips the drive (cap pool exhausted by the small NS).
- Blocks: `(unalloc − 1 048 576) / block_size` — the 1 MiB reserve keeps create-ns from failing on rounding.
- Same LBA-format and shared-flag handling as Step 2.
- Create + attach exactly like Step 2; the returned NSID is recorded as `nvme_large_ns_ids[<ctrl>]`.

**Step 4 — make the kernel see them.**

For each controller:

```
nvme reset <ctrl> || echo 1 > /sys/class/nvme/<ctrl>/rescan || true
```

Then, per controller and per created namespace, `files/nvme_ns_device.sh wait <ctrl> <nsid> 30` polls sysfs for the block device whose identity is `<controller serial>_<nsid>` (§4.5) and prints its `/dev/nvmeXnY` path. A controller whose namespace never appears within 30 s — or whose create step returned without an NSID (the large step skips a drive with no unallocated capacity) — lands in `nvme_failed_devices`, exactly like a delete or create failure. With `nvme_skip_failed_devices=true` the drive is skipped downstream; otherwise the play fails once the wait loop has finished ("Fail on namespace devices that never came up" — which also catches create failures that previously slipped through fail-fast mode, because the create tasks themselves only ever track).

**Step 5 — gather device paths.**

The paths printed by Step 4 become `nvme_small_ns_devices` (small NSID) and `nvme_large_ns_devices` (large NSID); no `ls` by name is involved. These are what `generate_raid_config.yml` consumes next.

**Step 6 — refuse to hand an empty set downstream.**

If either list is empty after the rebuild, the task fails on the spot — regardless of `nvme_skip_failed_devices`, which tolerates *individual* drives, not an install with no usable namespaces — naming both counts, the failed controllers and the sysfs evidence to check. Before this guard existed the role skipped `generate_raid_config.yml` silently (it is gated on both lists being non-empty) and the install died three roles later in `raid_fs` with "xiraid_arrays is not defined".

### 4.4 What happens on disk

Before rebuild (typical OEM layout):

```
/dev/nvme1     (controller)
  └─ nvme1n1   (single namespace, full capacity, 512 B blocks)
```

After rebuild with `nvme_small_ns_size_mb=500`, `nvme_namespace_block_size=4096`:

```
/dev/nvme1     (controller, serial S)
  ├─ NSID 1    (~500 MB, 4 KB blocks)   → XFS log member   identity S_1
  └─ NSID 2    (rest, 4 KB blocks)      → data member      identity S_2
```

The block devices are usually `nvme1n1` / `nvme1n2` after a reboot, but right after a rebuild they can just as well be `nvme1n2` / `nvme1n3` (§4.5). Nothing in the role depends on which.

### 4.5 Block-device names are not NSIDs — devices are resolved by serial + NSID

The role never derives a namespace's block device from its `nvmeXnY` name. The `Y` is **not** the NSID: in the Linux NVMe host driver it is the namespace head's *instance*, handed out by an IDA (lowest free integer per subsystem) when the head is allocated — [`drivers/nvme/host/core.c`, `nvme_alloc_ns_head()`](https://github.com/torvalds/linux/blob/v6.8/drivers/nvme/host/core.c#L3484-L3493) (v6.8, the Ubuntu 24.04 kernel: `ret = ida_alloc_min(&ctrl->subsys->ns_ida, 1, GFP_KERNEL); head->instance = ret; … head->ns_id = info->nsid;`; the same in [v5.15, Ubuntu 22.04](https://github.com/torvalds/linux/blob/v5.15/drivers/nvme/host/core.c#L3632-L3641), via `ida_simple_get`). The disk name is formatted from that instance — [`nvme_alloc_ns()`](https://github.com/torvalds/linux/blob/v6.8/drivers/nvme/host/core.c#L3729-L3739): `sprintf(disk->disk_name, "nvme%dn%d", ctrl->instance, ns->head->instance)`; with kernel multipath on (`nvme_core.multipath=Y`, the Ubuntu default), the head device is `nvme<subsystem>n<instance>` ([`multipath.c`, `nvme_mpath_alloc_disk()`](https://github.com/torvalds/linux/blob/v6.8/drivers/nvme/host/multipath.c#L540-L541)) and the hidden per-controller path device is `nvme<subsystem>c<controller>n<instance>` — the instance is the same number in every form. The instance is released only when the last reference to the old head drops — [`nvme_free_ns_head()`](https://github.com/torvalds/linux/blob/v6.8/drivers/nvme/host/core.c#L656-L666): `ida_free(&head->subsys->ns_ida, head->instance)` — which happens through the namespace's own kref (`nvme_free_ns` → `nvme_put_ns_head`), and an open block device holds that kref (`nvme_ns_release` → `nvme_put_ns`).

So name and NSID coincide only when namespaces are scanned in order on a quiet controller (boot). During the delete-ns → create-ns → attach-ns cycle of §4.3 the old head for NSID 1 can still hold instance 1 — its removal is asynchronous scan work, or a udev/blkid worker still has the node open — when the new NSID 1 is scanned, so the new namespace takes instance 2 and the large one instance 3. Observed on `xinas-box` (Ubuntu 24.04, `6.8.0-124-generic`, `nvme_core.multipath=Y`, 22 × KIOXIA KCM61RUL3T84) on 2026-09-03 after the v3.13.1 rebuild, on every data controller:

```
/sys/block/nvme10n2/nsid = 1   size = 1024000 sectors      (the 500 MB namespace)
/sys/block/nvme10n3/nsid = 2   size = 7499413504 sectors   (the large namespace)
nvme list-ns /dev/nvme10 -a    → 0x1, 0x2
```

A reboot restores `n1`/`n2` (fresh IDA, in-order scan) and a re-run of the rebuild reproduces the shift, so the role must not depend on the name in either direction. With the old name-based lookup the `n1` wait timed out on all 22 controllers (30 s each), the `n2` wait matched the *small* namespaces, `nvme_small_ns_devices` came out empty, RAID generation was skipped and `raid_fs` aborted.

**The identity the role keys on is the one xiRAID itself uses.** xiRAID's array config stores members as drive identities, not device paths, and resolves them to `/dev` nodes at runtime. Read from the installed `xiraid-core` 4.4.1-15869 on `xinas-box` (the daemon ships as plain Python; no vendor document describes this): `/usr/lib/xraid/drive/v2/nvme.py`, `NVMeDrive._serial()`, builds `f"{ID_SERIAL_SHORT}_{NAMESPACE_ID}"` from the udev properties of the block device, and `drive/v2/manager.py`, `_get_system_drives_collection()`, maps those identities back to block devices by enumerating every block device through pyudev — never by name. Both properties come straight from sysfs: `60-persistent-storage.rules` sets `ID_SERIAL_SHORT` from the parent device's `serial` attribute and `ID_NSID` from the namespace's `nsid` attribute ([systemd 255, `rules.d/60-persistent-storage.rules`](https://github.com/systemd/systemd/blob/v255/rules.d/60-persistent-storage.rules) — the same file also derives `/dev/disk/by-id/nvme-<model>_<serial>_<nsid>`), and xiRAID's own `/usr/lib/udev/rules.d/99-xi-new-rules.rules` sets `NAMESPACE_ID` from that same `nsid` attribute. On the box, `udevadm info -q property /dev/nvme10n2` reports `ID_SERIAL_SHORT=6030A005TMYR`, `ID_NSID=1`: identity `6030A005TMYR_1`, the key xiRAID will list that member under.

[`files/nvme_ns_device.sh`](../../collection/roles/nvme_namespace/files/nvme_ns_device.sh) implements the same lookup for the role, from sysfs alone (no udev or nvme-cli dependency):

| Command | Output | Exit |
|---|---|---|
| `list <ctrl>` | one line per namespace block device of the controller, ascending NSID: `<nsid> /dev/<dev> <serial>_<nsid>` | 0 (also when empty) |
| `resolve <ctrl> <nsid>` | `/dev/<dev>` of that namespace | 1 when absent |
| `wait <ctrl> <nsid> [timeout=30]` | like `resolve`, polling once a second | 1 on timeout |

Lookup: the controller's serial is `/sys/class/nvme/<ctrl>/serial` (trimmed — the attribute is space-padded to the NVMe field width); every `/sys/block/nvme*n*` whose `device/serial` equals it and whose `nsid` equals the wanted NSID is a candidate (`device` is the controller without kernel multipath and the `nvme-subsysN` device with it; both carry `serial`). Hidden path devices (`hidden` = 1, no `/dev` node) and entries whose attributes vanish mid-scan are skipped. When two controllers share a serial (a dual-port drive with multipath off) the candidate whose `device` link is the requested controller wins, and each NSID is reported once. `<ctrl>` may be given as `/dev/nvme10` or `nvme10`. `SYSFS_ROOT` and `DEV_ROOT` (default `/sys`, `/dev`) exist so the resolver can be unit-tested against a fake tree ([tests/test_nvme_ns_device.py](../../tests/test_nvme_ns_device.py)). Unknown controller → exit 2.

The rebuild path (§4.3) records the NSID each `create-ns` returned and waits for *that* identity; the converge path (§4.2) lists what the controller has and classifies by NSID; topology (§4.1) queries `id-ns` through the controller with `-n <nsid>`. The `nvme_small_ns_devices` / `nvme_large_ns_devices` facts still carry `/dev/nvmeXnY` paths — that is what `xicli raid create -d` takes and what `xicli raid show` prints — but the paths are looked up, never constructed.

---

## 5. Mode `all` — whole-drive (VM) path

Used by `presets/xinnorVM/`. Source: [detect_all_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_all_drives.yml).

Differences from mode `nvme`:

1. **Detection** uses `lsblk -dnpo NAME,TYPE` and accepts any `disk` (so virtio `/dev/vdb`, SCSI `/dev/sdb`, and NVMe alike). System drives are excluded as in §2.
2. **No namespace operations.** `nvme list-ns`, `nvme create-ns`, and the topology pass are all skipped.
3. **Split is positional, not size-based.** The first `nvme_log_drive_count` drives (default `2`) become the log members:

```
nvme_small_ns_devices = nvme_data_drives[:nvme_log_drive_count]
nvme_large_ns_devices = nvme_data_drives[nvme_log_drive_count:]
```

So in the VM preset with 5 virtio data drives, drives 1–2 become log members and drives 3–5 become data members. The cleanup pass in §3 still runs against the same `nvme_data_drives` list, so any leftover virtio LVM/MD also gets wiped.

---

## 6. Generating `xiraid_arrays` and `xfs_filesystems`

Source: [generate_raid_config.yml](../../collection/roles/nvme_namespace/tasks/generate_raid_config.yml). Runs in both modes once `nvme_small_ns_devices` and `nvme_large_ns_devices` are populated.

### 6.1 Capacity checks

Both arrays are checked against **one** table, `nvme_raid_min_devices` in
[defaults/main.yml](../../collection/roles/nvme_namespace/defaults/main.yml),
keyed by RAID level:

| RAID level | Min members |
|---|---|
| 0, 1 | 2 |
| 5 | **4** |
| 6 | 4 |
| 10 | 4 (and see §6.2 — an odd count is trimmed to even) |
| 50, 60 | **8** |
| any level not in the table | 2 |

The data array checks `nvme_large_ns_count` against
`nvme_raid_min_devices[nvme_raid_data_level]` into `nvme_can_create_data_raid`;
the log array checks `nvme_small_ns_count` against
`nvme_raid_min_devices[nvme_raid_log_level]` into `nvme_can_create_log_raid`. If
either fails, the play fails with a message that names both checks, which one
came up short, and the count-vs-required numbers.

These are the **engine-enforced** minimums, not textbook RAID math. They are
xiRAID-version-specific and were read off xiRAID Classic 4.4's own rejection
messages (`Error: To create RAID level '5', a minimum of '4' disks are
required.`) rather than from `xicli raid create --help`, which does not document
them. The table is shared verbatim with the TUI Create Array wizard and the
control-path constraint table — see
[Storage/raid-management-spec.md §4](../Storage/raid-management-spec.md#engine-enforced-minimum-drive-counts),
which owns the numbers and the re-confirmation rule for a xiRAID version bump.

> **This tightened the default preset.** The RAID-5 minimum was `3` (the
> `nvme_min_devices_for_raid5` variable, now removed along with
> `nvme_min_devices_for_raid10`; both are rejected with an explicit error if an
> old inventory or preset still sets them). A node with exactly **three** data
> namespaces used to pass this preflight and then fail several tasks later, at
> `xicli raid create`, with the engine's rejection — after `nvme_namespace` had
> already destroyed and rebuilt every namespace. It now fails **here**, at
> preflight, with an actionable count. That is a behavior change for any
> three-data-drive node that previously got as far as the array create; such a
> node was never able to complete an install, so nothing that used to work stops
> working.

### 6.2 RAID 10 odd-count correction

If `nvme_raid_log_level=10` and the small-NS count is odd, the role drops the last device so the member count is even:

```
_log_devices_adjusted = nvme_small_ns_devices[:N-1]
_log_device_dropped   = [nvme_small_ns_devices[-1]]
```

The dropped device is reported in the summary banner but not used elsewhere. (It survives as an unused namespace and can be picked up later for a spare pool.)

### 6.3 Parity disks and XFS stripe width

```
_data_parity_disks = 1  if data_level == 5
                     2  if data_level == 6
                     0  otherwise
_xfs_stripe_width  = len(nvme_large_ns_devices) − _data_parity_disks
```

### 6.4 The two facts that get handed to `raid_fs`

```yaml
xiraid_arrays:
  - name: data
    level: "{{ nvme_raid_data_level }}"           # 5 by default
    strip_size_kb: "{{ nvme_raid_data_strip_kb }}" # 128 by default
    devices: "{{ nvme_large_ns_devices }}"
    parity_disks: "{{ _data_parity_disks }}"
  - name: log
    level: "{{ _log_raid_level }}"                # 10 (default preset) or 1 (xinnorVM)
    strip_size_kb: "{{ nvme_raid_log_strip_kb }}" # 16 by default
    devices: "{{ _log_devices_adjusted }}"

xfs_filesystems:
  - label: nfsdata
    data_device: /dev/xi_data
    log_device:  /dev/xi_log
    su_kb: "{{ nvme_raid_data_strip_kb }}"
    sw:    "{{ _xfs_stripe_width }}"
    log_size: 1G
    sector_size: 4k
    mountpoint: /mnt/data
    mount_opts: "logdev=/dev/xi_log,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k,uquota"
```

These are pure facts — nothing is written to disk yet. `raid_fs` consumes them in the next role.

---

## 7. `raid_fs` — license, arrays, filesystem, mount

Source: [collection/roles/raid_fs/tasks/main.yml](../../collection/roles/raid_fs/tasks/main.yml).

### 7.1 Variable validation

Fast-fail if either `xiraid_arrays` or `xfs_filesystems` is undefined / empty. The failure message explicitly distinguishes "auto path broken (`nvme_namespace` didn't run or found nothing)" from "manual preset missing the definitions."

### 7.2 License application

```
xicli license update -p /tmp/license
```

Re-runs are cheap. If the file is missing (cleared by a reboot — `/tmp/license` is tmpfs), this step fails and `xicli raid create` will not be reachable. The remedy is to re-enter the license via the menu, then re-run the play with `--tags raid_fs`. Such a re-run **converges** under the §11 contract — on a MATCH box nothing is reformatted, and a destructive reset still requires the explicitly confirmed `xinas_storage_reset`.

**License recovery caveat (finding #4).** When `/tmp/license` is gone but a
running xiRAID still reports `status: valid`, it is tempting to "recover" the
license from the live system. **`xicli license show` output is not a usable
license file** — it carries the hwkey, status, and metadata but **not the
`license_key` blob**, so it cannot be fed back to `xicli license update -p`. The
menu therefore does **not** write `xicli license show` output to `/tmp/license`
(doing so produced a malformed file that risked a parser error, or a partial
success, in this step). Instead it saves the captured details to
`/tmp/license.recovered` for reference and prompts the operator to re-supply the
original license file. The canonical license file format is:
`hwkey`, `license_key`, `version`, `crypto_version`, `created`, `expired`,
`disks`, `levels`, `type`.

### 7.3 Drive prep

Two passes against the union of every array's `devices` plus every spare pool's `devices`:

1. **`xicli drive clean -d <dev>`** — wipes xiRAID metadata on each member. Errors are logged as warnings but never fail the play, so a fresh drive with nothing to clean does not abort the install.
2. **MD-RAID sweep** — `lsblk` scans for `raid*` types; any active `/dev/md*` whose component overlaps a member in `xiraid_device_basenames` is `mdadm --stop`-ed, then each overlapping component gets `mdadm --zero-superblock`. This is the second layer of the MD safety net (the first is §3.3 in `nvme_namespace`), and catches arrays that were created **after** the cleanup pass but before xiRAID create — for example, by an operator running the play twice with different layouts.

### 7.4 Spare pools (optional)

If the preset defines `xiraid_spare_pools`, the role enumerates existing pools with `xicli pool show -f json`, parses either the dict-keyed or list-of-dicts form, and runs:

```
xicli pool create -n <name> -d <dev1 dev2 …>
```

for each pool name that isn't already present. `already exists` in stderr is treated as success (idempotent).

### 7.5 Array creation

Source: [create_array.yml](../../collection/roles/raid_fs/tasks/create_array.yml). Loop body, runs once per array whose name isn't in `existing_array_names`:

```
xicli raid create -n <name> -l <level> \
                  -d <devices…>      \
                  -ss <strip_size_kb> \
                  [-sp <spare_pool>] \
                  [--force_metadata]   # when xiraid_force_metadata=true
                  [--discard 1]        # when TRIM is enabled for this array
```

`xiraid_force_metadata` defaults to `true` in both presets. After creation, the role `wait_for`-s the resulting block device at `/dev/xi_<name>` with a 120 s timeout. If the array already existed and the preset declares a `spare_pool`, the role runs `xicli raid modify --name <name> -sp <pool>` separately so adding a pool to a live array is idempotent too.

#### TRIM / discard

New arrays are created with discard enabled when the hardware supports it, so discards
issued by XFS reach the NVMe media instead of being dropped at the RAID layer. The
xiRAID Classic 4.4 command reference defines two related knobs, and the installer sets
exactly one of them:

| Knob | What xiRAID does with it | Installer |
|---|---|---|
| `--discard 0\|1` | enables discarding of unused blocks in the RAID. Defaults to `0`; requires **every** member to support Deterministic Read Zero after TRIM (RZAT) | **set to `1`** when the probe passes |
| `--drive_trim 0\|1` | TRIMs the disks *before* the RAID is created. xiRAID enables it **by default** when all disks support RZAT **and none carries metadata** | **never passed** |

**`--drive_trim` is deliberately left alone.** Its default already does the right thing,
and its second condition — no metadata on any disk — is a data-safety check: TRIMming a
disk that still carries metadata makes the data on it unrecoverable. Forcing
`--drive_trim 1` would override exactly that check, so the installer does not name the
flag at all and lets xiRAID decide.

**Detection is per array, not per node.** For every member device the role checks two
things:

1. **Discard support** — `/sys/block/<dev>/queue/discard_max_bytes` is non-zero.
2. **RZAT** — the NVMe namespace's `DLFEAT` field (from `nvme id-ns`) has its low three
   bits equal to `1`, meaning deallocated blocks read back as zeroes. Plain discard
   support does not imply this, and the kernel attribute that used to answer it
   (`discard_zeroes_data`) was removed in 4.12, so it does not exist on the supported
   Ubuntu kernels. A non-NVMe member (the VM whole-disk path) answers neither and is
   treated as ineligible; so is any member on a host without `nvme-cli`, which a normal
   `site.yml` run cannot hit (`nvme_namespace` hard-requires it and runs first) but a
   bare `--tags raid_fs` run can. Both degrade to "create without discard", never to a
   failed create.

`--discard 1` is passed only when **every** member of *that* array passes both — so a log
array on eligible namespaces still gets discard when a data-array member does not.

**Discard cannot be added by a later install run.** A converging re-run of `site.yml`
never recreates a healthy array (§11), so an array created without `--discard` keeps that
setting until it is destroyed and rebuilt under an explicit, confirmed
`xinas_storage_reset`. (The 4.4 CLI does document `discard` as modifiable via
`xicli raid modify`, but the control path currently rejects it as create-only — that was
verified against the 4.3.1 gRPC descriptor and has not been re-checked on 4.4.)

Two role variables control it. Both shipping presets happen to set them to the same
values the role default already uses — under the configuration-overlay model
([Installer/spec.md §1.0](spec.md#10-the-configuration-layer-model)) that mirroring is
redundant rather than required: a preset key merges on top of the role default instead
of replacing the file, so a key a preset does not set simply falls back to the role
default instead of being lost:

| Variable | Default | Meaning |
|---|---|---|
| `xiraid_trim_mode` | `auto` | `auto` = enable iff every member passes both probes; `on` = force the flags on regardless of the probe; `off` = never pass them |
| `xiraid_trim_create_args` | `--discard 1` | the literal flags appended to `xicli raid create`; one-line override if a future xiRAID spells them differently |

**The CLI is probed before the flags are used.** The role runs `xicli raid create --help`
once, outside the per-array loop, and appends the flags only when every `--flag` named in
`xiraid_trim_create_args` appears in that help text. Without the guard an older xiRAID
would fail *every* array creation on an unrecognised argument; with it, an unsupporting
build — or an override naming a flag this build lacks — simply creates arrays without
discard. The decision and its reason (which member failed which probe, or which flag the
CLI does not accept) are printed per array before creation.

**A freshly created array's first sectors are wiped.** `xicli raid create` does not zero
the array's payload, and TRIM is skipped whenever a member fails the eligibility probes
above — so the head of a brand-new `/dev/xi_<name>` can still show a stale signature that
belonged to whatever the member disks held before. `blkid` reports it as a real
filesystem, and §7.6's FOREIGN gate then refuses to format an array created seconds
earlier in the same run. (Observed on a QEMU/virtio bench where every member reported
"no RZAT", so TRIM was disabled: the new data array's head carried `xfs_external_log`
left by a previous install.) The role therefore runs `udevadm settle` followed by
`wipefs -a /dev/xi_<name>` immediately after `wait_for` sees the device appear,
**inside the create branch only** (`wait_for` returns the moment the node exists,
while udev may still hold it open — `wipefs` on such a device fails with `EBUSY`).
It is safe by construction — the only thing that can be there is residue, because the
array was created by this very task. An array that already existed when the run started
is never wiped and stays subject to the §11 gates.

### 7.6 Filesystem creation

Source: [create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml). Per `xfs_filesystems` entry:

1. **Sniff existing state:** `blkid -s TYPE` and `blkid -s LABEL` against the data device.
2. **Decide (storage-reset-safe, finding C1):** compute `_do_mkfs`. mkfs runs only when:
   - `xinas_storage_reset` is set (after the §11 confirmation gate), **or**
   - the data device has no XFS at all (state EMPTY — a fresh install, nothing to lose).

   An XFS whose label **matches** the configured label → **converge**: mkfs is skipped and
   the live data is preserved. An XFS with a **different** label, or a non-xfs signature
   (state FOREIGN) → the play **fails fast** with an actionable message rather than
   reformatting. The old always-reformat behaviour (`xfs_force_mkfs=true` shipped by
   default, or "label ≠ configured") is gone; `xfs_force_mkfs` is disarmed (see §11).
3. **Pick geometry:** if the operator didn't set `su_kb`/`sw`, the role looks up the `data` array in `xiraid_arrays` and computes `su_kb = strip_size_kb`, `sw = device_count − parity_disks`.
4. **Release the device:** if it is already mounted and we are about to reformat it:
   - Snapshot whether `nfs-server` is active (`systemctl is-active`).
   - `systemctl stop nfs-server` if it was running.
   - `umount <data_device>`.
   This runs **only when `_do_mkfs` is true** (a reset, or a genuinely fresh device). On a
   converge re-run mkfs is skipped, so NFS is never stopped and the mount is left untouched.
5. **Cap the log size:** `blockdev --getsize64 <log_device>` is compared against `item.log_size` (`1G` by default). If the log array is smaller than 1 GiB, the requested size is clamped to the actual device size — important on small (500 MB × 4) RAID 10 log arrays.
6. **Format:**
   ```
   mkfs.xfs -f -L <label> \
            -d su=<su_kb>k,sw=<sw> \
            -l logdev=<log_device>,size=<effective_log_size> \
            -s size=<sector_size> \
            <data_device>
   ```
7. `udevadm settle`, create the mountpoint (mode `0755`).

### 7.7 Mount unit (systemd, not fstab)

Source: [mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2). A systemd `.mount` unit is rendered to `/etc/systemd/system/<mountpoint-as-unit-name>.mount`, e.g. `mnt-data.mount`:

```ini
[Unit]
Description=xiRAID Classic data
Requires=dev-xi_data.device dev-xi_log.device
After=dev-xi_data.device dev-xi_log.device
Before=umount.target
Conflicts=umount.target

[Mount]
What=/dev/xi_data
Where=/mnt/data
Options=defaults,logdev=/dev/xi_log,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k,uquota
Type=xfs

[Install]
WantedBy=local-fs.target
```

Why `.mount` units and not `/etc/fstab`: the `Requires=` / `After=` lines tie the mount to the **kernel block-device units** for both `/dev/xi_data` and `/dev/xi_log`, so the mount only attempts once xiRAID has actually exposed both arrays. With `/etc/fstab`, the early mount pass on boot would race xiRAID start.

`systemctl daemon-reload` runs via flushed handler, then `systemctl enable --now <unit>` brings it up. Finally, if NFS was stopped in step 4 above, it is started again — so a re-run of `raid_fs` does not leave NFS down.

### 7.8 What lands on disk by the end

| Path | Owner | What |
|---|---|---|
| `/dev/xi_data` | xiRAID kernel module | Block device exposing the data array |
| `/dev/xi_log` | xiRAID kernel module | Block device exposing the log array |
| `/etc/systemd/system/mnt-data.mount` | raid_fs | Systemd mount unit |
| `/mnt/data` | raid_fs | Mountpoint, XFS mounted with external log |
| `/etc/exports` *(via the `exports` role next)* | exports | `/mnt/data * rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0` |

---

## 8. End-state checklist

After `site.yml` completes (and the operator has rebooted once if DOCA was just installed), verify:

```bash
# 1. Drives detected and protected correctly
findmnt -no SOURCE /                        # OS drive — must NOT appear in xiRAID
xicli raid show                             # data + log arrays, both "online"

# 2. Namespaces (nvme mode only)
nvme list                                   # each data drive shows NSID 0x1 (~500 MB) + 0x2 (rest); the nvmeXnY names need not match (§4.5)
nvme id-ns /dev/nvme1 -n 2 | grep -E 'nsze|lbads'  # 4 KB LBA (lbads:12), expected size — query by NSID, not by device name

# 3. xiRAID arrays
xicli raid show -f json | jq '.'            # both arrays present, no degraded members
ls -l /dev/xi_data /dev/xi_log              # both block devices exist

# 4. XFS filesystem
blkid /dev/xi_data                          # TYPE="xfs", LABEL="nfsdata"
xfs_info /mnt/data                          # sectsize=4096, logdev=external, sunit/swidth correct
mount | grep /mnt/data                      # logdev=/dev/xi_log,noatime,...,uquota
df -h /mnt/data                             # capacity ≈ (members − parity) × namespace size

# 5. Systemd mount unit
systemctl status mnt-data.mount             # active (mounted), Requires xi_data + xi_log
systemctl is-enabled mnt-data.mount         # enabled

# 6. NFS export (sanity, owned by exports/nfs_server roles)
exportfs -v | grep /mnt/data                # the rule rendered from nfs_exports.yml
```

For one-shot validation, the Textual TUI's Health tab (`xinas-menu`) and the MCP `health.run_check` tool both bundle the equivalent of the checks above into a single JSON report.

---

## 9. Failure modes the install guards against

| Failure | Where it would show up | Guard |
|---|---|---|
| OS on LVM / dm-crypt / MD root misclassified as a data drive | `/` resolves to `/dev/mapper/…` or `/dev/mdX`, which failed the `^/dev/nvme` collapse, so the OS controller fell into `nvme_data_drives` and §3 cleanup ran `vgremove -f` + `wipefs`/`dd` on the boot disk | `resolve_system_disks.sh` walks `lsblk --inverse` from every OS mount down to the physical disk(s); the OS controller is excluded before cleanup (§2) |
| OS on a ZFS root pool, only one member carrying the ESP | root resolved via ESP to one disk, so the abort never fired and the *other* mirror member landed in `nvme_data_drives` | resolver resolves the zpool's own vdevs via `zpool status`; `nvme_system_root_resolved` fails the play closed when the root itself can't be mapped (§2) |
| Cleanup drags a protected disk in via string-prefix match | data controller `/dev/nvme1` prefix-matched OS partition `/dev/nvme10n1p3`, destroying its VG/array/pool | `is_data_member` (`files/disk_match.sh`) matches on device-name boundaries and vetoes any device on a protected disk (§3.1) |
| OS drive detected as a data drive | `xicli raid create` would clobber the boot disk | `nvme_abort_if_no_system_drive=true` halts the play **before cleanup** if no system disk resolves or the root did not resolve; a post-split `assert` re-checks that no protected drive leaked into `nvme_data_drives` |
| Unattended default-preset install on a virtio/SCSI VM (0 NVMe controllers) | `nvme_namespace` generated no facts → `raid_fs` aborted with "xiraid_arrays undefined" | Empty-NVMe fallback (§1.1): re-probe all disks; auto-continue in whole-disk mode on VMs, fail-fast with a remedy on bare metal |
| Namespace block devices named by kernel head instance, not by NSID | after delete+create the new NSID 1 came up as `/dev/nvme10n2` and NSID 2 as `/dev/nvme10n3` on every controller; the `n1` wait timed out 22 × 30 s, the `n2` wait matched the *small* namespaces, `nvme_small_ns_devices` was empty, RAID generation was skipped and `raid_fs` aborted with "xiraid_arrays is not defined" | Devices are resolved by controller serial + NSID through sysfs (`files/nvme_ns_device.sh`, §4.5) — the identity xiRAID itself keys on; an empty device set fails inside `nvme_namespace` (§4.3 Step 6) |
| Existing LVM / MD / ZFS still bound to data drives | `xicli drive clean` errors; arrays don't form | `cleanup_storage.yml` discovers + destroys all three before any namespace op |
| Operator did not consent to wiping prior storage | Silent destruction would be unacceptable | Interactive `YES` prompt; only bypassed by explicit `nvme_skip_cleanup_confirmation=true` |
| Drive doesn't support `nmic=1` (single-controller HW) | `nvme create-ns -m 1` rejected, namespace creation fails per-drive | `nvme_namespace_shared=false` default; xinnorVM preset and project memory both pin it off |
| Odd number of log namespaces and `raid_log_level=10` | xiRAID rejects the unbalanced array | `generate_raid_config.yml` drops one device and reports it in the summary |
| Routine `site.yml` re-run reformats the live array (finding C1) | any `site.yml` re-run (incl. the TUI update flow's `Requires-Rebuild: all`) stopped NFS, ran `mkfs -f` over the live array, and finished green | Read-only `detect_storage_state` → MATCH **converges**: mkfs, namespace rebuild, `drive clean`, the MD sweep, and all three `cleanup_storage` wipes are skipped. Destruction requires an explicit `xinas_storage_reset` behind a `YES` gate enforced in **both** roles (§11) |
| Existing storage doesn't match the expected layout | a stray/foreign array or wrong-label XFS would have been silently reformatted | **FOREIGN fail-fast** at both the namespace and filesystem layers, before any wipe; requires `xinas_storage_reset` to proceed |
| Storage probes can't answer (xiRAID daemon down, module not loaded, `xicli`/`blkid` unusable) | a live array looks exactly like a fresh box — `xicli raid show` fails and `/dev/xi_data` is absent — so detection classified it `EMPTY` and a routine re-run wiped it | Probe success is tracked; a non-answer yields **UNKNOWN**, which outranks every other state and fails fast in both roles. Undefined state defaults to `UNKNOWN`, never `EMPTY` (§11) |
| Log RAID array smaller than the requested `log_size=1G` | `mkfs.xfs` exits with E2BIG | `_effective_log_size` clamps the size to `blockdev --getsize64` of the log device |
| Boot-time race between xiRAID and fstab | `/mnt/data` would fail to mount on cold boot | Mount unit `Requires=` + `After=` the kernel `.device` units for `xi_data` and `xi_log` |
| Stale xiRAID metadata from a prior install | `xicli raid create` refuses | `xicli drive clean` runs per member; `--force_metadata` is set when `xiraid_force_metadata=true` |
| License missing after reboot (`/tmp` is tmpfs) | `xicli license update -p /tmp/license` fails, no arrays | Surfaces as an early `raid_fs` failure with a clear message; re-enter via menu, re-run `--tags raid_fs` |
| Operator runs the role before `xiraid_classic` finishes loading the kernel module | `xicli` not on PATH | Role ordering in `site.yml` puts `xiraid_classic` ahead of `nvme_namespace` and `raid_fs` |

---

## 10. What the installer does **not** do

- It does not configure tiered storage, snapshots, or replication. `xinas_history` snapshots are configuration only, not block-level.
- It does not configure user / group quotas beyond enabling `uquota` in the XFS mount options. Quota assignment is a day-2 operation in the TUI.
- It does not encrypt the data set. There is no LUKS step in the install path.
- It does not create more than one data array or more than one filesystem per node. Multi-pool support is a TUI/MCP operation post-install.
- It does not pick a non-`/mnt/data` path. The `nfs_exports` rules in both presets hardcode `/mnt/data` with `fsid=0`; changing that requires editing both the preset and the export rules.

---

## 11. Idempotency & the storage-reset contract

A `site.yml` run — tagged or untagged, attended or unattended — **never destroys an
existing, data-bearing xiNAS layout unless the operator explicitly requested a reset.**
Formatting happens only on a genuinely fresh box, or under an explicit, confirmed reset.

**Detection.** `nvme_namespace/tasks/detect_storage_state.yml` (read-only) sets
`xinas_storage_state`:

| State | Meaning | Effect (no reset) |
|---|---|---|
| **MATCH** | xiRAID `data`+`log` online **and** `/dev/xi_data` is XFS with the configured label | **converge** — every destructive op is skipped |
| **EMPTY** | both probes **answered**, and no xiRAID arrays and no fs signature exist (incl. a factory single-namespace drive) | provision as a first install |
| **FOREIGN** | some array/fs signature exists but doesn't match the expected layout | **fail fast** before any wipe |
| **UNKNOWN** | a probe could not answer, so the layout is undetermined | **fail fast** before any wipe |

**Probes must answer for EMPTY to be reachable.** `EMPTY` is the state that authorizes
destruction, so it is only ever derived from *successful* negative probes — never from a
probe that failed. This is not theoretical: with xiRAID down (daemon stopped, kernel module
not loaded, `xicli` absent) `xicli raid show` exits non-zero **and** `/dev/xi_data` does not
exist, which is byte-for-byte how a factory-fresh node looks. Treating that as `EMPTY` would
erase a live, data-bearing array on a routine re-run. Detection therefore records whether
each probe answered at all:

- **Array probe** — `xicli raid show -f json` answered iff `rc == 0`. An empty reply from a
  running daemon is a real "no arrays"; any other rc means the array list is unreadable.
- **Filesystem probe** — conclusive iff `/dev/xi_data` is absent (then there is provably no
  filesystem), or `blkid` returned `0` ("found") or `2` ("nothing found"). Any other rc
  (usage error, I/O error, `blkid` missing) leaves the volume's content unknown.

`UNKNOWN` **outranks every other state**, including `FOREIGN` — `FOREIGN` would assert
knowledge about an array list that could not be read. Both roles fail fast on it with the
remedy named (bring xiRAID up and re-run, or set `xinas_storage_reset=true` to wipe and
rebuild regardless), and nothing is modified before that point. An explicit, confirmed reset
still wins, exactly as it does over `FOREIGN`.

The gates read `xinas_storage_state | default('UNKNOWN')`: an undefined fact is a
non-answer, and a non-answer never authorizes destruction.

**"Online" is read from the daemon, not inferred from the array existing.**
`xicli raid show -f json` reports per-array `state` words; an array counts as
online only when it reported at least one word and **every** word is `online` or
`initialized` — the same allowlist the TUI health engine's `raid_status` check
applies. So a `degraded`, `offline`, `initializing` or reconstructing array — or
one whose record carries no `state` at all — is **not** a MATCH: with arrays
present it classifies FOREIGN, and the run fails fast without touching anything.
Both payload shapes are read (the `name → record` mapping xicli emits, and the
list-of-records shape), and both the list (`["online", "initialized"]`) and bare
string (`"online"`) spellings of `state` are accepted, case-insensitively.
Pinned by [tests/test_storage_state_fail_closed.py](../../tests/test_storage_state_fail_closed.py),
which replays the classifier's `set_fact` chain against synthetic probe output.

**An unhealthy array is not a foreign layout.** FOREIGN's generic remedy is
"set `xinas_storage_reset=true` to wipe and rebuild" — the wrong advice for a
degraded or rebuilding array, which is recoverable. When both expected arrays
are present but at least one is not online, the classifier sets
`xinas_storage_arrays_unhealthy` (with `xinas_storage_array_states` for the
detail), and **both** `nvme_namespace` and `raid_fs` fail *before* the generic
FOREIGN failure with the right remedy: repair the array or let the rebuild
finish, then re-run — a healthy array converges. An operator who really does
want to wipe a degraded array can still do so with an explicit
`xinas_storage_reset` (which keeps its `YES` gate).

**Single control.** `xinas_storage_reset` (default `false`) is the only operator switch
for destruction. The legacy `xfs_force_mkfs` and `nvme_use_existing_namespaces` knobs are
**disarmed** — neither can initiate a wipe on its own, and both are removed from the
shipping presets.

**Every destructive op is gated** on `xinas_storage_reset` OR `state == EMPTY` (never on
`!= MATCH`, which would also wipe FOREIGN): the three `cleanup_storage` wipes
(`wipefs`/`dd`, including the empty-NVMe fallback path of §1.1), the namespace rebuild
(`delete-ns`), `raid_fs`'s `xicli drive clean` and MD-superblock sweep, and
`create_fs.yml`'s `mkfs.xfs -f`.

**Confirmation.** When `xinas_storage_reset` is set, a shared, fact-guarded include
(`storage_reset_confirm.yml`) prints a banner and requires the operator to type `YES`. It
is enforced in **both** `nvme_namespace` and `raid_fs` (via `include_role`) so a
`--tags raid_fs` run can't bypass it; `raid_fs` hard-fails on a required-but-unconfirmed
reset. `nvme_skip_cleanup_confirmation: true` is the unattended bypass (an intentional
reset sets both).

**Update flow.** The in-TUI update runs a bare `site.yml` and never injects
`xinas_storage_reset`, so an update resolves to MATCH → converge — `Requires-Rebuild: all`
is safe. See [update-spec.md](update-spec.md).
