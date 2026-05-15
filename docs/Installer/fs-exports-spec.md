# xiNAS Installer — Filesystem & NFS Exports Specification

This document covers the three stages that turn `/dev/xi_data` + `/dev/xi_log` (produced by `nvme_namespace` + `raid_fs` — see [raid-spec.md](raid-spec.md)) into a live NFS-RDMA export reachable from a client:

```
raid_fs (XFS + systemd mount unit) → exports (/etc/exports) → nfs_server (/etc/nfs.conf + service)
```

Each section names the source file the behavior comes from. Where this spec overlaps with [raid-spec.md](raid-spec.md) (XFS mkfs + mount unit) it stays at the *configuration* layer — refer to raid-spec for the surrounding storage flow.

Sources:

- [collection/roles/raid_fs/tasks/create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml), [templates/mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2)
- [collection/roles/exports/tasks/main.yml](../../collection/roles/exports/tasks/main.yml), [templates/exports.j2](../../collection/roles/exports/templates/exports.j2), [handlers/main.yml](../../collection/roles/exports/handlers/main.yml), [defaults/main.yml](../../collection/roles/exports/defaults/main.yml)
- [collection/roles/nfs_server/tasks/main.yml](../../collection/roles/nfs_server/tasks/main.yml), [handlers/main.yml](../../collection/roles/nfs_server/handlers/main.yml), [defaults/main.yml](../../collection/roles/nfs_server/defaults/main.yml)
- Preset overrides: [presets/default/nfs_exports.yml](../../presets/default/nfs_exports.yml), [presets/xinnorVM/nfs_exports.yml](../../presets/xinnorVM/nfs_exports.yml)

---

## 1. Filesystem layer — XFS on `/dev/xi_data` with external log

Source: [raid_fs/tasks/create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml). Driven entirely by the `xfs_filesystems` fact emitted by `nvme_namespace` (see [raid-spec.md §6.4](raid-spec.md#64-the-two-facts-that-get-handed-to-raid_fs)).

### 1.1 Why XFS, why external log

xiNAS uses **XFS with the journal on a separate xiRAID array** (RAID 10 / RAID 1) rather than inside the data array (RAID 5). The reasons:

- Small synchronous metadata writes from NFS (`sync`, `no_wdelay`) would pay the full read-modify-write penalty on a RAID 5 stripe if the journal lived there.
- Putting the log on a mirror (RAID 10 / RAID 1) gives single-stripe writes for journal I/O.
- xiRAID exposes them as separate block devices: `/dev/xi_data` (data array) and `/dev/xi_log` (log array). XFS supports an external log natively via `mkfs.xfs -l logdev=…` and `mount -o logdev=…`.

This is why the `nvme_namespace` role splits each NVMe drive into `n1` (~500 MB, log member) and `n2` (rest, data member) — so both arrays span the same physical devices and survive the same failure domains.

### 1.2 Geometry the installer feeds to `mkfs.xfs`

The fact generator computes:

| Knob | Value | Where it comes from |
|---|---|---|
| `su` (stripe unit) | `nvme_raid_data_strip_kb` (default `128`) | `xiraid_arrays[data].strip_size_kb` |
| `sw` (stripe width) | `data_members − parity_disks` | RAID 5 with 4 members → `sw=3`; RAID 6 with 6 → `sw=4` |
| `sector size` | `4k` | hardcoded in `nvme_namespace` |
| `log size` | `1G` requested | clamped to actual log-device size at install time (see §1.3) |

`raid_fs` recomputes `_fs_su_kb` and `_fs_sw` if the preset didn't pre-set them — looking up the array named `data` in `xiraid_arrays` and applying the same `members − parity` rule. This lets a hand-edited preset override geometry without rebuilding the fact pipeline.

### 1.3 Effective log size clamp

Source: `create_fs.yml`, the `_log_dev_bytes` / `_effective_log_size` block.

`blockdev --getsize64 /dev/xi_log` gives the real size of the log array. With the default preset (3 × 500 MB namespaces in RAID 10) the log device is roughly 750 MB — smaller than the requested `1G`. The play then uses the device size in bytes as `size=` for `mkfs.xfs -l`, so the format does not fail with `XFS: log size too big`.

### 1.4 Reformat decision

mkfs is executed when **any** of the following is true (`xfs_force_mkfs` defaults to `true` in both presets, so in practice every install path reformats):

- `xfs_force_mkfs: true`, or
- `blkid -s TYPE /dev/xi_data` ≠ `xfs`, or
- `blkid -s LABEL /dev/xi_data` ≠ the configured label (`nfsdata`).

### 1.5 Reformat-while-serving safety

If `/dev/xi_data` is currently mounted (a re-run on a live NAS):

1. `systemctl is-active nfs-server` is recorded.
2. `systemctl stop nfs-server` if it was running.
3. `umount /dev/xi_data`.
4. mkfs runs.
5. Mount unit is re-enabled and started.
6. `systemctl start nfs-server` only if step 1 recorded it as active.

That last point matters: re-running `--tags raid_fs` does not flip NFS on when the previous state was off.

### 1.6 mkfs invocation

```
mkfs.xfs -f \
         -L nfsdata \
         -d su=128k,sw=3 \           # geometry derived from xiRAID 'data' array
         -l logdev=/dev/xi_log,size=<effective_log_size> \
         -s size=4k \
         /dev/xi_data
```

`-f` forces overwrite of any signature already on the device. The combination of `su`/`sw` tells XFS to align allocations to the RAID stripe; the kernel surfaces these as `sunit` / `swidth` in `xfs_info`.

### 1.7 Mount options decoded

Default mount line written into the systemd unit:

```
defaults,logdev=/dev/xi_log,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k,uquota
```

| Option | Effect |
|---|---|
| `logdev=/dev/xi_log` | Pin the external log to the xiRAID log array. Must match mkfs's `-l logdev=`. |
| `noatime,nodiratime` | Don't update access times on files or directories. Removes a write per read. |
| `logbsize=256k` | In-memory log buffer size. Larger buffers amortize metadata flushes on bursty NFS writes. |
| `largeio` | Report the stripe width as the optimal I/O size in `statvfs`. Apps that honor it (incl. NFS server) issue aligned, full-stripe writes. |
| `inode64` | Allow inodes anywhere in the address space, not just the first 1 TB. Required for any array larger than 1 TB. |
| `swalloc` | Round buffered writes up to the stripe-width boundary. Avoids partial-stripe RMW under streaming workloads. |
| `allocsize=131072k` | Preallocate writes in 128 MiB chunks. Cuts fragmentation under large sequential writes (the common NFS case). |
| `uquota` | Enable **user** quotas. Group/project quotas are not enabled by default; add `gquota`/`pquota` to `mount_opts` if you need them. |
| `defaults` | systemd shorthand for `rw,suid,dev,exec,auto,nouser,async`. Comes first so per-option overrides win. |

`uquota` is what the `quota` package (installed by the `common` role) hooks into. Quota assignment itself is a day-2 TUI operation; mounting with `uquota` is what makes that possible.

### 1.8 Mountpoint and systemd .mount unit

Source: [mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2).

- Mountpoint: `/mnt/data` (mode `0755`, root:root). Created if missing.
- Unit name: derived from the mountpoint — `/mnt/data` → `mnt-data.mount`. Written to `/etc/systemd/system/`.
- `Requires=` + `After=` the *kernel block-device units* for both `/dev/xi_data` and `/dev/xi_log` (`dev-xi_data.device dev-xi_log.device`). This is the key reason the install uses a `.mount` unit instead of `/etc/fstab`: the early fstab pass on boot runs **before** xiRAID has assembled the arrays, so a fstab line would fail at boot.
- `Before=umount.target` + `Conflicts=umount.target` — standard local-fs ordering so the unit unmounts cleanly on shutdown.
- `WantedBy=local-fs.target` — enables it on every subsequent boot.

`daemon-reload` is flushed as a handler before `systemctl enable --now mnt-data.mount`, so the unit becomes active in the same play.

---

## 2. Export rules — `/etc/exports`

Source: [collection/roles/exports/](../../collection/roles/exports). This role runs **after** `raid_fs` (mount is up) and **before** `nfs_server` (the server only re-reads exports when it starts or `exportfs -r` is called).

### 2.1 Inputs

The role's only input is the list `exports`, default:

```yaml
exports:
  - path: /mnt/data
    clients: "*"
    options: "rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0"
```

Both presets (`default` and `xinnorVM`) ship the same default. The list supports multiple entries; each entry maps 1:1 to one line in `/etc/exports`.

### 2.2 What the role does

1. **Create every `exports[*].path` as a directory** (mode `0755`, root:root). If `path` already exists as a directory, it's left alone; if it exists as a symlink or file, Ansible fails — which is intentional, since exporting through a symlink is a misconfiguration.
2. **Render `/etc/exports`** from the one-loop template:
   ```jinja
   {% for ex in exports %}
   {{ ex.path }} {{ ex.clients }}({{ ex.options }})
   {% endfor %}
   ```
   Mode `0644`, root:root.
3. **Reload** via the `reload exports` handler: `exportfs -r` (re-export everything, drop stale entries). The handler fires only when the template content changes, so a no-op re-run does not bounce the export table.

### 2.3 Decoding the default options

```
rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0
```

| Option | Effect |
|---|---|
| `rw` | Read-write export. |
| `sync` | Server replies only after data is on stable storage. Required for predictable NFS semantics; the XFS external log makes this fast. |
| `insecure` | Accept connections from client ports above `1023`. NFS-RDMA does not negotiate a privileged port, so without this, the RDMA mount is refused. |
| `no_root_squash` | UID `0` on the client stays UID `0` on the server. xiNAS is deployed as an appliance with trusted clients on a storage network; squashing would break root-owned workloads. Tighten this on multi-tenant deployments. |
| `no_subtree_check` | Don't verify that requested file is in the exported subtree on each call. Faster, and `fsid=0` makes the check redundant. |
| `no_wdelay` | Don't bunch writes — issue every write to the array immediately. Wins on RAID arrays with their own write coalescing; loses on single spindles. |
| `fsid=0` | **Mark this export as the NFSv4 root.** Clients can mount it as `server:/`; subsequent subdir exports become children of this root. |

### 2.4 NFSv4 root semantics (`fsid=0`)

With `fsid=0` on `/mnt/data`:

- v4 clients: `mount -t nfs4 -o vers=4.2,proto=rdma,port=20049 <server>:/ /mnt/test` — the leading `/` is the v4 root, which is mapped to `/mnt/data` on the server side. No path translation needed.
- v3 clients: `mount -t nfs -o vers=3 <server>:/mnt/data /mnt/test` — the literal server-side path still works for v3.

To export additional subdirectories under the same v4 namespace, add entries like:

```yaml
exports:
  - path: /mnt/data
    clients: "*"
    options: "rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0"
  - path: /mnt/data/projects
    clients: "10.10.0.0/16"
    options: "rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay"
```

Only the v4 root gets `fsid=0`; child exports omit it.

### 2.5 Rendered file

For the default single-rule preset, `/etc/exports` ends up as exactly:

```
/mnt/data *(rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0)
```

No managed-section markers — the file is treated as fully owned by the role and rewritten in place. Hand-editing it survives only until the next play run.

---

## 3. Server tuning — `/etc/nfs.conf` and `nfs-kernel-server`

Source: [collection/roles/nfs_server/](../../collection/roles/nfs_server).

### 3.1 Packages

```
apt install nfs-kernel-server nfs-common
```

`nfs-kernel-server` brings in `nfsd` and `exportd`; `nfs-common` is the client-side tooling but is also required for `mount.nfs4` on the server itself (used by health checks).

### 3.2 The managed block in `/etc/nfs.conf`

`blockinfile` writes the following block, fenced by `# BEGIN/END ANSIBLE managed section – nfs_server role`:

```ini
[exportd]
threads=<nfs_threads>

[nfsd]
threads=<nfs_threads>
vers3=y
vers4=y
vers4.0=y
vers4.1=y
vers4.2=y
rdma=y
rdma-port=<nfs_rdma_port>
```

Defaults:

| Variable | Default | Source |
|---|---|---|
| `nfs_threads` | `ansible_processor_cores × ansible_processor_count` (i.e. one thread per *physical* core, summed across sockets) | `nfs_server/defaults/main.yml` |
| `nfs_rdma_port` | `20049` | matches Xinnor's high-performance NFS blog (Feb 3 2025) |

The block is *additive* — anything else already in `/etc/nfs.conf` (system defaults, Debian/Ubuntu boilerplate) is preserved outside the managed markers.

### 3.3 Why each line

| Line | Effect |
|---|---|
| `[exportd] threads=N` | Number of `rpc.exportd` worker threads. `exportd` is the userspace daemon that authenticates clients and answers `MOUNT` calls; matching its thread count to nfsd avoids a bottleneck on mount-heavy workloads. |
| `[nfsd] threads=N` | Kernel nfsd thread count. One per core is the Xinnor-recommended starting point for high-IOPS NFS-RDMA on modern Xeons / EPYCs. |
| `vers3=y` | NFSv3 enabled — for legacy clients and tools that don't speak v4. |
| `vers4=y` + `vers4.{0,1,2}=y` | Enable every NFSv4 minor version up to 4.2 (pNFS layouts, sparse files, server-side copy, label-NFS). NFS-RDMA requires v4.0 minimum. |
| `rdma=y` | Bind `nfsd` to the RDMA transport in addition to TCP. The `rpcrdma` / `svcrdma` kernel modules (from `mlnx-nfsrdma-dkms`, installed by `doca_ofed` — see [network-spec.md §2](network-spec.md#2-stage-1--doca_ofed-drivers--ib-udev-rename)) must be loadable. |
| `rdma-port=20049` | Standard NFS-RDMA port. Clients connect with `-o proto=rdma,port=20049`. |

### 3.4 Service lifecycle

- Service unit: `nfs-server` (the systemd alias for `nfs-kernel-server` on Ubuntu).
- Enabled and started by the `enable + state: started` task.
- Reloaded via the `restart nfs` handler whenever the managed block changes (`notify: restart nfs`). The handler does a full restart, not just `exportfs -r`, because `/etc/nfs.conf` changes only take effect on server startup.

The interplay between the two roles is important:

- A change to `/etc/exports` → `exports` role fires `exportfs -r` (no service restart).
- A change to `/etc/nfs.conf` → `nfs_server` role fires `systemctl restart nfs-server` (which itself re-reads exports on start).

This means most operational changes (adding clients, new subdirs) don't bounce the server — only tuning changes do.

---

## 4. End-to-end flow on first install

```
[raid_fs]
  ├─ mkfs.xfs -f -L nfsdata -d su=128k,sw=N -l logdev=/dev/xi_log,size=… /dev/xi_data
  ├─ render /etc/systemd/system/mnt-data.mount
  └─ systemctl enable --now mnt-data.mount       ← /mnt/data now live

[exports]
  ├─ mkdir -p /mnt/data (mode 0755)              ← idempotent if already exists
  ├─ render /etc/exports from nfs_exports.yml
  └─ exportfs -r                                  ← export table populated

[nfs_server]
  ├─ apt install nfs-kernel-server nfs-common
  ├─ blockinfile managed section in /etc/nfs.conf
  └─ systemctl enable --now nfs-server            ← NFS-RDMA on :20049, TCP on :2049
```

After this, port `2049/tcp` (v3 + v4 over TCP) and `20049/rdma` (v3 + v4 over RDMA) are listening, and `exportfs -v` shows `/mnt/data` with the configured options.

---

## 5. End-state checklist

```bash
# ── XFS layer ───────────────────────────────────────────────────────────
mount | grep /mnt/data
#   /dev/xi_data on /mnt/data type xfs (rw,...,logdev=/dev/xi_log,uquota)
xfs_info /mnt/data
#   sectsz=4096 ; sunit=<su>blks, swidth=<sw>blks ; external log
blkid /dev/xi_data
#   TYPE="xfs", LABEL="nfsdata"
systemctl status mnt-data.mount
#   active (mounted); Requires=dev-xi_data.device dev-xi_log.device
systemctl is-enabled mnt-data.mount
#   enabled                                    ← survives reboot

# ── Quotas ──────────────────────────────────────────────────────────────
quotaon -p /mnt/data
#   user quota on /mnt/data (/dev/xi_data): on

# ── Export rules ────────────────────────────────────────────────────────
cat /etc/exports
#   /mnt/data *(rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0)
exportfs -v
#   /mnt/data       <world>(sync,wdelay,hide,no_subtree_check,fsid=0,...)

# ── NFS server config ───────────────────────────────────────────────────
grep -A2 '\[nfsd\]' /etc/nfs.conf
#   threads=<N>, vers3=y, vers4=y, vers4.{0,1,2}=y, rdma=y, rdma-port=20049
systemctl is-active nfs-server
#   active
ss -lntp | grep -E ':(2049|20049)\b'
#   nfsd listening on 2049/tcp and 20049 (RDMA shows via rpcinfo, not ss)
rpcinfo -p localhost | awk '$5 == "nfs"'
#   nfs versions 3 and 4 registered

# ── Client smoke test (run from a remote node on the storage network) ──
mount -t nfs4 -o vers=4.2,proto=rdma,port=20049 <server>:/ /mnt/test
mount -t nfs  -o vers=3                        <server>:/mnt/data /mnt/test_v3
```

A failed RDMA mount with a working TCP mount almost always points back to a missing `rpcrdma` kernel module — re-check `lsmod | grep rpcrdma` and the `doca_ofed` post-install verification in [network-spec.md §2](network-spec.md#2-stage-1--doca_ofed-drivers--ib-udev-rename).

---

## 6. Failure modes the install guards against

| Failure | Symptom | Guard |
|---|---|---|
| Mount unit attempts before xiRAID is up | `/mnt/data` empty after boot | `.mount` unit `Requires=dev-xi_data.device dev-xi_log.device`; no fstab entry |
| Requested XFS log larger than the log array | `mkfs.xfs` fails with "log size too big" | `_effective_log_size` clamps to `blockdev --getsize64 /dev/xi_log` |
| Re-run on a live NAS holds the FS busy | `umount: target is busy` | `create_fs.yml` stops `nfs-server` before unmount, restarts only if it was active |
| Geometry forgotten on a hand-edited preset | Misaligned writes, RMW penalty on RAID 5 | Geometry is auto-derived from the `data` array entry in `xiraid_arrays` |
| NFS-RDMA mount refused with "permission denied" | RDMA client uses a non-privileged port | `insecure` in default export options |
| NFSv4 client can't find a path | `mount server:/foo` returns `ENOENT` | `fsid=0` makes `/mnt/data` the v4 root; v4 clients mount `server:/` |
| Stale exports after a rule change | New rule visible in `/etc/exports`, server still serves the old set | `notify: reload exports` → `exportfs -r` fires on template change |
| `/etc/nfs.conf` edits don't take effect | nfsd thread count or RDMA port unchanged | `notify: restart nfs` runs `systemctl restart nfs-server` on managed-block change |
| Mixed v3 / v4 client fleet | One protocol works, the other doesn't | Both protocol families enabled (`vers3=y`, `vers4*=y`) by default |

---

## 7. What this stage does **not** do

- **Kerberos / sec=krb5.** All exports default to `sec=sys`. Add `sec=krb5p,krb5i,sys` to the options field if you need Kerberos; the install does not set up a KDC or `/etc/krb5.keytab`.
- **Per-user / per-host export ACLs.** The `clients` field accepts host, network, or `*`. Anything more granular (LDAP-based access lists, per-user squashing tables) is out of scope.
- **idmapd configuration.** `/etc/idmapd.conf` is left at Ubuntu defaults — fine when client UIDs/GIDs match server UIDs/GIDs (the appliance assumption). Domain-joined deployments need to edit this by hand.
- **Firewall rules.** Nothing opens or closes ports `2049/tcp` and `20049/rdma`. UFW / nftables are assumed not in the path on the storage network.
- **Quota assignment.** `uquota` is enabled at mount time but no per-user limits are set. Assignment happens in the TUI or by hand via `xfs_quota`.
- **More than one filesystem.** The presets export `/mnt/data` only. Multi-pool / multi-export deployments are a day-2 operation; the role does support a list of `exports`, but only one filesystem is mounted by default.
