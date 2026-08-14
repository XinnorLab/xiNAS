# xiNAS Installer — Filesystem & NFS Exports Specification

This document covers the three stages that turn `/dev/xi_data` + `/dev/xi_log` (produced by `nvme_namespace` + `raid_fs` — see [raid-spec.md](raid-spec.md)) into a live NFS-RDMA export reachable from a client:

```
raid_fs (XFS + systemd mount unit) → exports (/etc/exports) → nfs_server (/etc/nfs.conf + service)
```

Each section names the source file the behavior comes from. Where this spec overlaps with [raid-spec.md](raid-spec.md) (XFS mkfs + mount unit) it stays at the *configuration* layer — refer to raid-spec for the surrounding storage flow.

Sources:

- [collection/roles/raid_fs/tasks/create_fs.yml](../../collection/roles/raid_fs/tasks/create_fs.yml), [templates/mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2)
- [collection/roles/exports/tasks/main.yml](../../collection/roles/exports/tasks/main.yml), [templates/exports.j2](../../collection/roles/exports/templates/exports.j2), [templates/shares-seed.json.j2](../../collection/roles/exports/templates/shares-seed.json.j2), [handlers/main.yml](../../collection/roles/exports/handlers/main.yml), [defaults/main.yml](../../collection/roles/exports/defaults/main.yml)
- [collection/roles/nfs_server/tasks/main.yml](../../collection/roles/nfs_server/tasks/main.yml), [handlers/main.yml](../../collection/roles/nfs_server/handlers/main.yml), [defaults/main.yml](../../collection/roles/nfs_server/defaults/main.yml)
- Preset overrides: [presets/default/nfs_exports.yml](../../presets/default/nfs_exports.yml), [presets/xinnorVM/nfs_exports.yml](../../presets/xinnorVM/nfs_exports.yml)
- [xiNAS-MCP/src/api/seed-shares.ts](../../xiNAS-MCP/src/api/seed-shares.ts) — one-time install-time share adoption at first `xinas-api` boot (§2.6)

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
| `sync` | `exports(5)`: "Reply to requests only after the changes have been committed to stable storage." Required for predictable NFS semantics; the XFS external log makes this fast. |
| `insecure` | Turns off the default `secure`, which `exports(5)` describes as requiring that "requests not using gss originate on an Internet port less than IPPORT_RESERVED (1024)". **[observed]** NFS-RDMA on this stack does not use a privileged port, so without `insecure` the RDMA mount is refused — that consequence is from the field, not from `exports(5)`. |
| `no_root_squash` | `exports(5)`: "Turn off root squashing." UID `0` on the client stays UID `0` on the server. xiNAS is deployed as an appliance with trusted clients on a storage network; squashing would break root-owned workloads. Tighten this on multi-tenant deployments. |
| `no_subtree_check` | Don't verify on each call that the requested file is inside the exported subtree. **This is already the `exports(5)` default** (since nfs-utils 1.1.0) — listing it is explicitness, not a change. `exports(5)` frames the trade-off as reliability (subtree checking breaks on renames) rather than as a security requirement, and recommends disabling it for filesystems that see many renames. |
| `no_wdelay` | `exports(5)`: the server "will normally delay committing a write request to disc slightly if it suspects that another related write request may be in progress or may arrive soon"; `no_wdelay` disables that. **[rationale]** Wins on RAID arrays with their own write coalescing; loses on single spindles — our reasoning, not a man-page claim. |
| `fsid=0` | **Mark this export as the NFSv4 root.** `exports(5)`: "For NFSv4, there is a distinguished filesystem which is the root of all exported filesystem. This is specified with `fsid=root` or `fsid=0` both of which mean exactly the same thing." Clients can mount it as `server:/`; subsequent subdir exports become children of this root. |

> Options above are per [`exports(5)`](https://man7.org/linux/man-pages/man5/exports.5.html)
> (nfs-utils), reconciled 2026-08-14. One justification was **wrong** and has
> been replaced: `no_subtree_check` was described as redundant *because of*
> `fsid=0`. The two are unrelated — `fsid` assigns the export's filesystem
> identity for NFSv4, and has no bearing on subtree checking. What actually
> makes subtree checking unnecessary here is that `/mnt/data` is an entire
> filesystem rather than a subdirectory of one, and in any case
> `no_subtree_check` is the default.

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

### 2.6 Install-time share adoption (seed manifest)

Source: [collection/roles/exports/templates/shares-seed.json.j2](../../collection/roles/exports/templates/shares-seed.json.j2), [xiNAS-MCP/src/api/seed-shares.ts](../../xiNAS-MCP/src/api/seed-shares.ts). Design: [docs/superpowers/specs/2026-07-03-nfs-share-seed-adoption-design.md](../superpowers/specs/2026-07-03-nfs-share-seed-adoption-design.md).

In addition to `/etc/exports`, the `exports` role renders a JSON seed manifest at `/var/lib/xinas/seed/shares.json` (template `shares-seed.json.j2`) from the *same* `exports` preset var that drives `exports.j2` (§2.1), so the two are consistent by construction. This is an additive task — it does not change the existing `/etc/exports` template task.

Manifest shape — one entry per export, `options` carried as the raw comma-split token list:

```json
[
  {
    "path": "/mnt/data",
    "clients": "*",
    "options": ["rw", "sync", "insecure", "no_root_squash",
                "no_subtree_check", "no_wdelay", "fsid=0"]
  }
]
```

On its **first boot** after install, `xinas-api` (`seedShares()`) reads this manifest and writes one desired `Share` per entry:

```
/xinas/v1/desired/Share/<encExportId(path)> =
  { kind: "Share", id, spec: { path, clients: [{ pattern, options }], fsid } }
```

`fsid` is extracted from the option tokens (assigned `max(existing fsids) + 1` when an entry omits it). No executor runs and `/etc/exports` is not rewritten — the export already exists on disk from the role's own render. A one-time marker `/xinas/v1/meta/shares_seeded` makes this permanent-once: an operator delete of the seeded share is never resurrected on a later restart, while a fresh state database (re-install) has no marker and re-seeds.

**Scope:** only the install-declared exports are adopted this way. Out-of-band `exportfs` edits or hand-added `/etc/exports` lines are NOT auto-adopted — they remain drift, surfaced as `drift.nfs-exports` (`extra`). This does not carry a `Requires-Rebuild: exports` trailer — forcing the `exports` role to re-run on a plain release update would re-template `/etc/exports` and risk clobbering a helper-managed file (§7); existing installs adopt on their next full provision instead.

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
| `rdma-port=20049` | Standard NFS-RDMA port. Clients connect with `-o proto=rdma,port=20049`. Assigned by IANA to `nfsrdma` and specified as the default in [RFC 8267 §5](https://www.rfc-editor.org/rfc/rfc8267#section-5). |

> The section names and keys above are per [`nfs.conf(5)`](https://man7.org/linux/man-pages/man5/nfs.conf.5.html)
> (nfs-utils). **[rationale]** "One nfsd thread per core" is a xiNAS/Xinnor
> starting point, not a value nfs-utils documents or defaults to — `nfs.conf(5)`
> states no recommended `threads` count. Treat it as a tuning default to
> measure, not a vendor requirement.

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
