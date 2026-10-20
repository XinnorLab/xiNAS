# xiNAS Client Setup — Behavior Spec

Owns the behavior contract for the client-side surface shipped in
`client_repo/`: the `xinas-client` menu (`client_setup.sh`) and the
configuration it writes on an NFS client host.

The client health report (`client_repo/client_healthcheck.sh`) reads the
same on-disk state this spec defines; where a check names a file, that file
is defined here.

Related:
- [docs/Installer/update-spec.md](../Installer/update-spec.md) — release-only
  install/update rule, which the client installer follows too.
- `docs/plans/2026-03-23-client-tui-redesign-design.md` — historical redesign
  plan (append-only history of intent, not the live contract).

---

## 1. Scope

| Surface | File | Status |
|---------|------|--------|
| Client menu | `client_repo/client_setup.sh` | Active (bash; the client host has no Python TUI) |
| Client health report | `client_repo/client_healthcheck.sh` | Active |
| Health profiles | `client_repo/client_health_profiles/*.yml` | Active |
| DOCA-OFED install | `client_repo/collection/roles/doca_ofed/` | Active (Ansible role, run only when a Mellanox/NVIDIA NIC is present) |

The "Python-only for day-2 management" rule in the repo's `CLAUDE.md`
applies to the **server** node. The client package is a standalone bash
deliverable and stays bash.

---

## 2. NFS client tuning drop-ins

### 2.1 The two files

`Install NFS Tools` owns two configuration drop-ins. They are xiNAS-authored
files; nothing else in the client package writes them.

| File | Purpose |
|------|---------|
| `/etc/modprobe.d/nfsclient.conf` | `options nfs …` — session slots, idmapping, retrans, ino64 |
| `/etc/sysctl.d/90-nfs-client.conf` | socket buffer maxima, `vm.swappiness` |

Required content is defined by the `nfs_client` checks in
`client_healthcheck.sh` (`modprobe_conf`, the per-parameter `modprobe *`
checks, and `sysctl_conf`). The health-check expectations and the values
written here are one contract — changing a value means changing both.

### 2.2 The contract

**After `Install NFS Tools` returns, both drop-ins exist — on every path
through the action, including the path where NFS client tools were already
installed.**

This is the whole point of the section. `nfs-common` is present out of the
box on many images, and on those hosts the *only* work `Install NFS Tools`
has left to do is write the drop-ins. A version of the action that reports
"Already Installed" and returns without writing them leaves the host
permanently un-tuned, and puts the user in a loop: the health report says
`[WARN] NFS Client > sysctl_conf → Run installer: Install NFS Tools`, the
installer says "Already Installed", and nothing changes.

### 2.3 Write policy

Applied per file, independently:

| On-disk state | Action | Reported step |
|---------------|--------|---------------|
| Missing | Write the xiNAS content | `create <path>` |
| Present | Leave untouched | `<path> already present` |

A drop-in that exists but carries edited values is **not** rewritten. It is
an admin-owned file once it exists, and silently reverting a deliberate
local tuning change is worse than the drift. Drift is visible: the
per-parameter `modprobe *` checks in the health report compare actual values
against the profile and WARN on a mismatch.

Consequence, accepted deliberately: a stale or hand-broken drop-in is
reported but not auto-repaired. Repair is `rm` the file and re-run
`Install NFS Tools`.

### 2.4 sysctl reload

`sysctl --system` runs only when `/etc/sysctl.d/90-nfs-client.conf` was
created by this invocation. When the file was already present its values are
already live (applied at boot), and an unconditional reload would re-apply
every other drop-in on the host as a side effect of an action that changed
nothing.

### 2.5 Reporting

Both paths report through the same `op_status.sh` frame:

- **Tools missing** — drop-in steps are part of the existing
  `Install NFS Tools` operation, between the package install and
  `op_verify mount.nfs4`.
- **Tools already installed** — when at least one drop-in is missing, the
  action opens its own operation frame so the user sees what was written.
  When both are already present, no frame is opened; the action reports
  "Already Installed" and returns, as before.

`enable_nfs_rdma` continues to run on both paths, unchanged.

---

## 3. Storage network state

### 3.1 What "configured" means

`/etc/netplan/99-xinas-client.yaml` is the file the client's own
`Configure Network` wizard writes. **Its presence is evidence that the
network is configured; its absence is not evidence that it is not.** A
storage network reached by cloud-init, a pre-existing netplan file, a
hand-written config, or DHCP is configured — the client just did not write
it.

Gating on that one filename told users with a working, mounted share that
their network was unconfigured.

### 3.2 The predicate

`storage_network_pending()` answers one question: *is there storage-network
work the user could act on right now?* It is true only when **all** of the
following hold.

| Condition | Rationale |
|-----------|-----------|
| At least one storage-class interface exists | Storage-class = `type == 32` (IPoIB) or driver `mlx5_core`, i.e. `detect_high_speed_interfaces`. With no such NIC, `Configure Network` has nothing to configure and the prompt is noise |
| None of them carries an IPv4 address | An interface with an address is configured, whoever configured it |
| There is no active NFS mount | A live mount is proof the client already reaches a NAS. Whatever the interface inventory looks like, the network works |

The predicate deliberately ignores `99-xinas-client.yaml`. A netplan file
that has been written but not applied — or applied and then flushed — leaves
no address on the interface, and the user does still have work to do. The
address is the ground truth; the file is not.

Hosts with no storage-class NIC at all (a TCP-only client on a stock
Ethernet adapter) never trip the predicate. That is intended: such a client
mounts over its existing network and `Configure Network` has nothing to
offer it.

### 3.3 Where it is used

- **`Connect to NAS`** — when the predicate is true, the wizard warns before
  step 1 and offers to continue anyway. When it is false, the wizard opens
  directly.
- **The startup checklist** — supplies the state of step ③ (§4).

---

## 4. Startup checklist state

### 4.1 The problem

The welcome screen lists five recommended actions. They were five static
lines: no indication of which had been done, on a screen whose entire job is
to tell a new user where to start. The `SYSTEM STATUS` block above covered
three of the five, in different words, with no visual link to the steps.

### 4.2 The contract

**Every checklist entry carries a state marker.** Each is derived from live
system state at render time — nothing is persisted, and nothing is inferred
from a previous run of the menu.

| Marker | Meaning |
|--------|---------|
| `✔` (green) | Done — the step's end state is present on this host |
| `○` (yellow) | Pending — the step is applicable and not done |
| `–` (dim) | Not applicable — this host has no hardware or platform for the step |

### 4.3 Per-step derivation

| Step | Done | Not applicable | Pending |
|------|------|----------------|---------|
| ① Install NFS Tools | `mount.nfs4` on `PATH` | never | otherwise |
| ② Install DOCA OFED | `/sys/class/infiniband` non-empty | no Mellanox/NVIDIA adapter (`detect_mellanox_nic` fails) | otherwise |
| ③ Configure Network | a storage-class interface has an IPv4, or an NFS mount is active | no storage-class interface | otherwise (`storage_network_pending()`, §3.2) |
| ④ Connect to NAS | at least one `nfs`/`nfs4` mount | never | otherwise |
| ⑤ K8s CSI Driver | CSI NFS driver found in the cluster | `kubectl` absent, or no reachable cluster | otherwise |

### 4.4 Cost ceiling

The checklist renders on every startup, so no probe may block it.

`kubectl cluster-info` against an unreachable cluster hangs for its own
default timeout. Every cluster probe behind step ⑤ runs under `timeout 3`,
and the step is bounded to **two** probes end to end:

1. One reachability probe. On expiry the step is not-applicable and no
   further probe runs.
2. One driver lookup. The three driver lookups are alternatives against the
   same API server, so a timeout on the first means the rest would time out
   too — the step stops there and reports "to do" rather than spending the
   budget twice more.

Worst case is therefore 6s, and the common failure (no cluster) costs 3s
once. `check_csi_nfs_installed` returns `0` driver found / `2` cluster
reachable, no driver / `1` no reachable cluster, so the checklist derives all
three states from a single call; boolean callers are unaffected.

The remaining probes are `sysfs` and `mount` reads and are effectively free.

---

## 5. DOCA-OFED install (`doca_ofed` role)

### 5.1 When it runs

The role first looks for a Mellanox/NVIDIA NIC (PCI vendor `15b3`, via
`lspci -d 15b3:` or `/sys/bus/pci/devices/*/vendor`). With none it reports
that the install is skipped and does nothing else; every task below
carries `when: mlx_nic_check.rc == 0`.

### 5.2 Kernel module prerequisite

DOCA-Host's DKMS `mlx5_ib` needs the in-tree `macsec` module.
**[Installer/spec.md §3.2 *Kernel module prerequisite*](../Installer/spec.md)
is the normative text** — which kernels are checked, how a kernel version is
read from a package name, the `Candidate:` test, the re-check, the three
failure cases and their message, and the known limit all apply to the client
role unchanged. The client role differs only in this:

- **NIC gate.** Every preflight task also carries `when: mlx_nic_check.rc ==
  0`, so a client without a Mellanox/NVIDIA NIC runs none of them (§5.1).
- **Tags.** The preflight tasks carry `ofed`, `deps` and `install`, as on
  the server. The NIC-detection task carries `ofed`, `detect`, `deps` and
  `install`, so a run limited to `deps` or `install` still evaluates the
  gate instead of failing on an undefined `mlx_nic_check`. (Before this
  change every gated client task would fail that way under such a tag, by
  reading the role — not observed; the
  client menu runs the playbook untagged, so it was not hit there.)

**Evidence.** The failure was observed on a server, not on a client:
Ubuntu 24.04.5 cloud image, kernel `6.8.0-142-generic`, DOCA-Host 3.4.0,
2026-10-19 — `openibd` failed with `mlx5_ib: Unknown symbol
macsec_netdev_is_offloaded` until `linux-modules-extra-6.8.0-142-generic`
was installed
(`docs/troubleshooting/installer-virtual-kernel-flavour.md`). The client
role installs the same DOCA-Host release (`doca_version` is pinned to
`3.4.0` in both roles), so a client on a virtual-flavour kernel with a
Mellanox NIC is expected to fail the same way. No client was observed
failing.

### 5.3 Updates and re-runs

Clients do not use the server's release update flow or its
`Requires-Rebuild:` trailers. The client menu's update checks out the
new release tag and restarts the menu; it runs no Ansible
(`client_setup.sh`, *Update Available*). The role runs again only when:

- the operator picks **Install DOCA OFED** in the client menu, which runs
  `playbooks/doca_ofed_install.yml` untagged — but skips it, showing "DOCA
  OFED appears to be installed", when `/sys/class/infiniband` already
  lists devices and `ibstat` exists; or
- the operator runs `ansible-playbook playbooks/doca_ofed_install.yml`
  from the client checkout by hand, which is what that message suggests
  for a reinstall.

So a client that already has a working DOCA install is not touched by
this change; it matters for new installs.
