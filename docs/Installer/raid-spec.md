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
| `nvme` *(default)* | `presets/default/` | `/dev/nvme[0-9]+` (controllers only) | Delete all NSes per drive → create `n1` (500 MB) + `n2` (rest) |
| `all` | `presets/xinnorVM/` | `lsblk -dnpo NAME,TYPE` (every `disk`) | None — whole drives used as-is |

If `nvme_auto_namespace: false`, the role prints a notice and does nothing — operators must define `xiraid_arrays` / `xfs_filesystems` themselves in the preset.

---

## 2. System-drive detection (both modes)

Before touching anything, the role figures out which drives are off-limits.

Source: [detect_drives.yml](../../collection/roles/nvme_namespace/tasks/detect_drives.yml) (and the matching block in `detect_all_drives.yml`).

It builds `nvme_system_drives` by collecting the parent device of:

1. **Root** — `findmnt -no SOURCE /`, stripped of partition suffix (`nvme0n1p2 → nvme0n1`, `vda1 → vda`).
2. **Boot** — `findmnt -no SOURCE /boot` (only if separate from root).
3. **EFI System Partition** — `lsblk -nro NAME,PARTTYPE` with the standard ESP GUID `c12a7328-f81f-11d2-ba4b-00a0c93ec93b`.

In `nvme` mode, anything matching `/dev/nvmeXnY` is collapsed to the controller path `/dev/nvmeX` and pushed into `nvme_system_controllers`. That set is then **excluded** from `nvme_data_drives`.

Hard safety stop: if `nvme_abort_if_no_system_drive=true` (default) and none of the three queries returned a device, the play fails with a CRITICAL message rather than risk wiping the OS disk. Override to `false` only for diskless boot / iSCSI roots where you know what you're doing.

Result: `nvme_system_drives` (protected list) and `nvme_data_drives` (everything else).

---

## 3. Pre-namespace cleanup — LVM / MD RAID / ZFS

Source: [cleanup_storage.yml](../../collection/roles/nvme_namespace/tasks/cleanup_storage.yml). Runs only if `nvme_cleanup_existing_storage=true` (the default) and at least one data drive was found.

### 3.1 Discovery

Three independent scans, each restricted to `nvme_data_drives`:

- **LVM** — `pvs --noheadings -o pv_name,vg_name` filtered by drive path. Produces `nvme_found_lvm_pvs` and the unique `nvme_found_lvm_vgs`.
- **MD RAID** — for every `/dev/md*` block device, `mdadm --detail` is parsed and each component compared against the data-drive set. Matching arrays land in `nvme_found_md_arrays`.
- **ZFS** — only if `which zpool` succeeds. `zpool status` is parsed for `nvme*` / `sd*` devices and any pool that includes one of the data drives is added to `nvme_found_zpools`.

`nvme_cleanup_required` is the OR of the three.

### 3.2 Confirmation gate

If anything was found:

- A banner is printed listing the VGs/MD arrays/pools that will be destroyed.
- Unless `nvme_skip_cleanup_confirmation=true` (default `false` — operators must type `YES` interactively), an `ansible.builtin.pause` task waits for confirmation. Anything other than `YES` aborts with `Cleanup cancelled by user.`

For unattended deployments set `nvme_skip_cleanup_confirmation: true` in the preset or inventory — that is the dangerous knob the comments call out.

### 3.3 Destruction order

The order is chosen so dependent objects are gone before their backing store is wiped:

1. **ZFS** — `zpool destroy -f <pool>` for every found pool.
2. **MD RAID** — `mdadm --stop <md>` for each array, then `mdadm --zero-superblock` on every partition of every data drive.
3. **LVM** — `vgchange -an <vg>`, `vgremove -f <vg>`, then `pvremove -f` on every partition of every data drive.
4. **Partition tables** — `wipefs -a` plus `dd` on the first MB and the last MB of each data drive (so both MBR and the GPT backup header at end-of-disk are gone).
5. **Kernel re-read** — `partprobe` per data drive.

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
| `lba_size` (bytes per LBA) | `nvme id-ns <ctrl>n1` → in-use `lbads` (log2) | `512` |

The list of dicts is stored as `nvme_topology`.

### 4.2 Skip path — `nvme_use_existing_namespaces: true`

Source: [detect_existing_namespaces.yml](../../collection/roles/nvme_namespace/tasks/detect_existing_namespaces.yml).

If the operator opts to reuse what's already on the drives:

- `ls /dev/<ctrl>n*` per data drive.
- `n1` → log devices (`nvme_small_ns_devices`).
- `n2`–`n9` (and `n10+`) → data devices (`nvme_large_ns_devices`).
- Special case: if **no** `n2+` were found, the role treats `n1` as data (single-namespace drives) and leaves the log device list empty — at which point `raid_fs` will fail with a clear message in §6.

Default (`nvme_use_existing_namespaces=false`) falls through to §4.3.

### 4.3 Delete + recreate

Source: [rebuild_namespaces.yml](../../collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml).

For every controller in `nvme_topology`:

**Step 1 — delete all existing namespaces.** For each NSID from `nvme list-ns <ctrl> -a`:

```
nvme detach-ns <ctrl> -n <nsid> -c <cntlid>   # cntlid pulled from id-ctrl
nvme delete-ns <ctrl> -n <nsid>
```

`detach` failures are swallowed (a not-attached NS isn't an error); `delete` failures push the controller onto `nvme_failed_devices` unless `nvme_skip_failed_devices=true` (default `true`), in which case the play continues without that drive.

**Step 2 — create the small (log) namespace.**

- Size: `nvme_small_ns_size_mb` × 1 MiB → blocks at `nvme_namespace_block_size`.
- LBA format: the role looks for an `lbaf` row in `nvme id-ns` with `ms:0` (no metadata) and `lbads:12` (`4096` bytes) or `lbads:9` (`512` bytes), whichever matches `nvme_namespace_block_size`. If no matching format exists, it falls back to format `0` with a warning — likely indicates the drive doesn't support the requested block size.
- Shared flag: `-m 1` only when `nvme_namespace_shared=true`. Default is `false`. On non-HA single-controller hardware (which is xiNAS's default target), `nvme create-ns -m 1` is rejected by the drive — leaving this `false` is mandatory there.

```
nvme create-ns <ctrl> -s <blocks> -c <blocks> -f <flbas> -d 0 [-m 1]
nvme attach-ns <ctrl> -n <new_nsid> -c <cntlid>
```

Failures land the controller in `nvme_failed_devices`.

**Step 3 — create the large (data) namespace.**

- Unallocated capacity: `nvme id-ctrl` → `unvmcap`; fallback subtracts the sum of existing NS sizes from `tnvmcap`.
- If unallocated ≤ 1 MiB the step prints a warning and skips the drive (cap pool exhausted by the small NS).
- Blocks: `(unalloc − 1 048 576) / block_size` — the 1 MiB reserve keeps create-ns from failing on rounding.
- Same LBA-format and shared-flag handling as Step 2.
- Create + attach exactly like Step 2.

**Step 4 — make the kernel see them.**

For each controller:

```
nvme reset <ctrl> || echo 1 > /sys/class/nvme/<ctrl>/rescan || true
```

Then `wait_for path=/dev/<ctrl>n1 timeout=30` and the same for `n2`. If `nvme_skip_failed_devices=true`, missing namespaces are tolerated; otherwise the play fails.

**Step 5 — gather device paths.**

`ls /dev/<ctrl>n1` → `nvme_small_ns_devices`; `ls /dev/<ctrl>n2` → `nvme_large_ns_devices`. These are what `generate_raid_config.yml` consumes next.

### 4.4 What happens on disk

Before rebuild (typical OEM layout):

```
/dev/nvme1     (controller)
  └─ nvme1n1   (single namespace, full capacity, 512 B blocks)
```

After rebuild with `nvme_small_ns_size_mb=500`, `nvme_namespace_block_size=4096`:

```
/dev/nvme1     (controller)
  ├─ nvme1n1   (~500 MB, 4 KB blocks)   → XFS log member
  └─ nvme1n2   (rest, 4 KB blocks)      → data member
```

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

| RAID level | Min members | Source variable |
|---|---|---|
| RAID 5 (data) | `nvme_min_devices_for_raid5` (default `3`) | `nvme_can_create_data_raid` |
| RAID 6 (data) | hardcoded `4` | same |
| RAID 10 (log) | `nvme_min_devices_for_raid10` (default `4`, must be even) | `nvme_can_create_log_raid` |
| RAID 1 (log) | hardcoded `2` | same |
| Other levels (default fallback) | `≥ 2` | same |

If either array fails its check, the play fails with a message that names both checks and which one came up short.

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

Re-runs are cheap. If the file is missing (cleared by a reboot — `/tmp/license` is tmpfs), this step fails and `xicli raid create` will not be reachable. The remedy is to re-enter the license via the menu, then re-run the play with `--tags raid_fs`.

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
```

`xiraid_force_metadata` defaults to `true` in both presets. After creation, the role `wait_for`-s the resulting block device at `/dev/xi_<name>` with a 120 s timeout. If the array already existed and the preset declares a `spare_pool`, the role runs `xicli raid modify --name <name> -sp <pool>` separately so adding a pool to a live array is idempotent too.

### 7.6 Filesystem creation

Source: [create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml). Per `xfs_filesystems` entry:

1. **Sniff existing state:** `blkid -s TYPE` and `blkid -s LABEL` against the data device.
2. **Decide:** mkfs is performed if any of the following holds:
   - `xfs_force_mkfs=true` (default `true` in both presets), **or**
   - filesystem type ≠ `xfs`, **or**
   - label ≠ the configured label.
3. **Pick geometry:** if the operator didn't set `su_kb`/`sw`, the role looks up the `data` array in `xiraid_arrays` and computes `su_kb = strip_size_kb`, `sw = device_count − parity_disks`.
4. **Release the device:** if it is already mounted and we are about to reformat it:
   - Snapshot whether `nfs-server` is active (`systemctl is-active`).
   - `systemctl stop nfs-server` if it was running.
   - `umount <data_device>`.
   This is how re-running the install on a live NAS doesn't wedge with "device busy" — the helper actually drops NFS first.
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
nvme list                                   # each data drive shows n1 (~500 MB) + n2 (rest)
nvme id-ns /dev/nvme1n2 | grep -E 'nsze|lbads'  # 4 KB LBA (lbads:12), expected size

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
| OS drive detected as a data drive | `xicli raid create` would clobber the boot disk | `nvme_abort_if_no_system_drive=true` halts the play if none of root / boot / EFI resolves |
| Existing LVM / MD / ZFS still bound to data drives | `xicli drive clean` errors; arrays don't form | `cleanup_storage.yml` discovers + destroys all three before any namespace op |
| Operator did not consent to wiping prior storage | Silent destruction would be unacceptable | Interactive `YES` prompt; only bypassed by explicit `nvme_skip_cleanup_confirmation=true` |
| Drive doesn't support `nmic=1` (single-controller HW) | `nvme create-ns -m 1` rejected, namespace creation fails per-drive | `nvme_namespace_shared=false` default; xinnorVM preset and project memory both pin it off |
| Odd number of log namespaces and `raid_log_level=10` | xiRAID rejects the unbalanced array | `generate_raid_config.yml` drops one device and reports it in the summary |
| Re-run with NFS already serving `/mnt/data` | `umount` fails with "device busy" → mkfs aborts | `create_fs.yml` snapshots `nfs-server` state, stops it, reformats, restarts |
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
