# xiNAS Installer — Network Configuration Specification

This document describes everything the installer does to the host network: which roles run, in what order, what files they write, how IP addresses and MTU are chosen, how policy-based routing (PBR) is laid out, and what the system looks like when the install is finished.

It is the install-time view. For the day-2 / TUI view (what the Network screen does when you edit IPs later), see [Network/spec-network-management.md](../Network/spec-network-management.md) — this spec deliberately stays focused on the deploy path so the two don't drift.

Sources this spec is derived from:

- [collection/roles/doca_ofed/tasks/main.yml](../../collection/roles/doca_ofed/tasks/main.yml) and [files/configure_ib_udev.sh](../../collection/roles/doca_ofed/files/configure_ib_udev.sh)
- [collection/roles/net_controllers/tasks/main.yml](../../collection/roles/net_controllers/tasks/main.yml), [templates/netplan.yaml.j2](../../collection/roles/net_controllers/templates/netplan.yaml.j2), [handlers/main.yml](../../collection/roles/net_controllers/handlers/main.yml)
- [collection/roles/perf_tuning/tasks/main.yml](../../collection/roles/perf_tuning/tasks/main.yml) (network sysctl + per-NIC ethtool block)
- [collection/roles/roce_lossless/defaults/main.yml](../../collection/roles/roce_lossless/defaults/main.yml) (optional, off by default)
- Preset overrides: [presets/default/network.yml](../../presets/default/network.yml), [presets/xinnorVM/network.yml](../../presets/xinnorVM/network.yml), [presets/*/netplan.yaml.j2](../../presets/default/netplan.yaml.j2)

---

## 1. Where network configuration happens in the install

`site.yml` touches the network in **three** distinct roles, in this order:

```
common              → baseline sysctl (rmem/wmem/swappiness only)
doca_ofed           → NVIDIA DOCA-Host install, IB udev rename rules
net_controllers     → detect IB/mlx5 NICs, allocate IPs, write 99-xinas.yaml, apply
perf_tuning         → 400 Gbit sysctl tuning + per-NIC MTU/ring buffers
```

Two other places can touch the stack but **do not run by default**:

- `roce_lossless` — PFC/ETS/DSCP for lossless RoCE Ethernet. Runs only when invoked explicitly (`--tags roce_lossless`).
- TUI Network screens (Edit Interface IP, IP Pool, Apply Network Changes) — post-install only; they rewrite the same `/etc/netplan/99-xinas.yaml` the installer wrote.

---

## 2. Stage 1 — `doca_ofed`: drivers + IB udev rename

[collection/roles/doca_ofed/tasks/main.yml](../../collection/roles/doca_ofed/tasks/main.yml)

### What it does

1. Installs build deps (`dkms`, `build-essential`, `linux-headers-<kernel>`, `libelf-dev`).
2. Adds Mellanox GPG key and the DOCA-Host APT repo:
   - Repo URL: `https://linux.mellanox.com/public/repo/doca/latest/ubuntu<22.04|24.04>/x86_64`
   - File: `/etc/apt/sources.list.d/mellanox-doca.list`
3. Installs `doca-all`, `mlnx-fw-updater`, `mlnx-nfsrdma-dkms`.
4. Validates DKMS build succeeded for `mlnx-ofed-kernel` and `nfsrdma`; fails the play if anything is in `added`, `error`, or `broken` state.
5. Verifies `modinfo mlx5_core` succeeds; warns (does not fail) if `modinfo rpcrdma` fails — that signals NFS-RDMA will be broken until the kernel module is loadable.
6. Copies [configure_ib_udev.sh](../../collection/roles/doca_ofed/files/configure_ib_udev.sh) to `/usr/local/sbin/` and runs it.
7. Reboots only if `doca_ofed_auto_reboot=true` (default is **off** — operator reboots manually after install).

### IB interface renaming (`configure_ib_udev.sh`)

The IB stack assigns names like `ibp65s0` based on PCI topology. To get stable `ib0`, `ib1`, … names that match the netplan template, the role writes udev rules tying MAC → friendly name:

- Reads the **role's own** netplan template (`/opt/provision/collection/roles/net_controllers/templates/netplan.yaml.j2` by default — `ib_netplan_template` variable) for desired IB names (`ib0`, `ib1`, …).
- Enumerates current IB interfaces (`/sys/class/net/<iface>/type == 32`).
- Reads each interface's hardware MAC from `/sys/class/net/<iface>/address`.
- Writes one rule per name into `/etc/udev/rules.d/70-ib-names.rules`:
  ```
  SUBSYSTEM=="net", ACTION=="add", ATTR{address}=="<mac>", NAME="ib0"
  ```
- Reloads udev with `udevadm control --reload`.

Renames take effect on the next interface re-bind — i.e. after the reboot that DOCA install requires anyway.

### Files written / changed

| Path | Owner | Purpose |
|---|---|---|
| `/etc/apt/sources.list.d/mellanox-doca.list` | apt | DOCA-Host repo |
| `/etc/udev/rules.d/70-ib-names.rules` | doca_ofed | IB MAC → name pinning |
| `/usr/local/sbin/configure_ib_udev.sh` | doca_ofed | Re-runnable rename helper |
| Kernel modules: `mlx5_core`, `mlx5_ib`, `rpcrdma`, `svcrdma`, `xprtrdma`, `ib_*` | DKMS | Provided by `doca-all` + `mlnx-nfsrdma-dkms` |

---

## 3. Stage 2 — `net_controllers`: detect, allocate, write netplan

[collection/roles/net_controllers/tasks/main.yml](../../collection/roles/net_controllers/tasks/main.yml)

This is the load-bearing role for installer networking. It runs five steps.

### 3.1 Interface detection

Detection happens entirely from sysfs and `/proc/net/dev` — no external tools:

1. **Primary path** — walk `/sys/class/net/*`, skip `lo`, require a `device/` symlink, and accept the interface if:
   - `/sys/class/net/<iface>/type == 32` (InfiniBand), **or**
   - basename of `device/driver` is `mlx5_core` (ConnectX-4 onwards in Ethernet/RoCE mode).
2. **Fallback path** — if the primary loop found nothing (`mlx5_core` driver bound but sysfs not yet populated, common right after DOCA install on the very first run), scan `/proc/net/dev` for any interface whose name starts with `ib`.

Result: an ordered list `detected_interfaces.stdout_lines` like `["ib0", "ib1", "ib2"]`. The order is whatever `/sys/class/net` returns, which is normally alphabetical.

The play prints the list via `debug:` so the operator can see it in the install log.

### 3.2 Per-interface MTU (auto-detect)

Default `net_mtu` is `0`, meaning auto-detect:

| Interface `type` | MTU |
|---|---|
| `32` (InfiniBand) | **4092** |
| anything else (RoCE / Ethernet) | **9000** |

Result stored in `net_iface_mtus` fact, e.g. `{ ib0: 4092, ib1: 4092 }`.

If `net_mtu` is overridden to a non-zero value (preset, inventory, or CLI), that single value is used for every interface and per-interface detection is skipped.

### 3.3 IP allocation from the pool

Defaults (overridable in preset's `network.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `net_ip_pool_enabled` | `true` | Allocate from pool. `false` falls through to whatever the j2 template says. |
| `net_ip_pool_start` | `10.10.1.1` | First IP. The third octet is the *iterator*; the fourth is the *host*. |
| `net_ip_pool_end` | `10.10.255.1` | Documentation only — the iterator stops when the third octet > 255. |
| `net_ip_pool_prefix` | `24` | Mask used for every allocated IP. |
| `net_manual_ips` | `{}` | Per-interface overrides (key by interface name). |

**Allocation rule** (from the Jinja in `tasks/main.yml`):

```
For each interface i (0-indexed) in detection order:
  if iface in net_manual_ips:
    iface → net_manual_ips[iface]
  else:
    iface → <oct1>.<oct2>.(<start_oct3> + i).<oct4>/<prefix>
```

With the defaults that yields:

```
ib0 → 10.10.1.1/24
ib1 → 10.10.2.1/24
ib2 → 10.10.3.1/24
…
```

**Overflow guard:** the play fails fast with a clear message if any allocated third octet exceeds 255. The error names the offending interface and the IP it would have been given, and suggests three remedies (lower start, fewer interfaces, manual overrides). There is **no** silent wrap.

### 3.4 Pre-apply flush (clean slate)

Two cleanup passes run before any new config is written. Both run as `become: true`.

**PBR + secondary IPs (shell):**

1. Walk every `ip rule` row whose `lookup` field is in `100..199`; delete the rule.
2. `ip route flush table <table>` for each of those tables.
3. For every interface bound to a `mlx*` driver, run `ip addr flush dev <iface>` to drop any leftover primary or secondary IPv4 addresses.

**Cross-file netplan cleanup (Python inline):**

1. Build the set of `mlx*`-driven interfaces from sysfs.
2. For every `*.yaml` / `*.yml` in `/etc/netplan/` **except** `99-xinas.yaml`:
   - Load the file with PyYAML.
   - Remove each managed interface from `network.ethernets.<iface>` if present.
   - Rewrite the file if anything changed; print `Cleaned IB interfaces from <path>`.

This is what prevents the most common installer surprise: cloud-init defined `ibp65s0` in `50-cloud-init.yaml` with one IP, the operator picked a different IP in the menu, and after `netplan apply` the interface ends up with *both* IPs because netplan **merges** `addresses` arrays across files.

### 3.5 Write `99-xinas.yaml` and apply

Template: [collection/roles/net_controllers/templates/netplan.yaml.j2](../../collection/roles/net_controllers/templates/netplan.yaml.j2)

The rendered file is written to `/etc/netplan/99-xinas.yaml`, mode `0600`, root:root. Two branches exist in the template:

- **Pool / allocated mode** (the normal case): one `ethernets.<iface>:` block per detected interface, each carrying `dhcp4: no`, `addresses: [ <ip>/<prefix> ]`, an `mtu` line, and — only when there is more than one interface — a `routes:` + `routing-policy:` block (see §4 below).
- **Empty mode** (no interfaces detected): the file is rendered with a commented stub showing an example IB block so the operator can hand-edit it.

After the template is written, the play **always** runs `netplan apply` (not just when the file changed). This is intentional: the PBR flush in §3.4 already wiped kernel state, so even a no-op template change still needs an apply pass to repopulate routes and rules.

### 3.6 Files written / changed

| Path | Mode | What's in it |
|---|---|---|
| `/etc/netplan/99-xinas.yaml` | `0600 root:root` | Per-interface IB config + PBR (see §4) |
| `/etc/netplan/50-cloud-init.yaml` (or similar) | unchanged perms | IB interfaces *removed* if they were defined here |

No `systemd-networkd` units are written directly — `netplan apply` renders them under `/run/systemd/network/`.

---

## 4. Policy-based routing layout

When more than one IB/mlx interface gets an IP, the template emits PBR so each interface's NFS replies egress through that same interface. With a single interface, PBR is omitted (it isn't needed).

For interface index `i` (0-based), IP `A.B.C.D/P`:

| Element | Value |
|---|---|
| Routing table ID | `100 + i` |
| Subnet route in that table | `A.B.C.0/P dev <iface> scope link proto static` |
| Routing policy rule | `from A.B.C.D lookup <table> priority <table>` |

Rendered netplan fragment per interface (when `len(detected) > 1`):

```yaml
ib0:
  dhcp4: no
  addresses: [ 10.10.1.1/24 ]
  mtu: 4092
  routes:
    - to: 10.10.1.0/24
      scope: link
      table: 100
  routing-policy:
    - from: 10.10.1.1
      table: 100
      priority: 100
```

Resulting kernel state after apply (three-interface example):

```
# ip rule show
100:  from 10.10.1.1 lookup 100 proto static
101:  from 10.10.2.1 lookup 101 proto static
102:  from 10.10.3.1 lookup 102 proto static

# ip route show table 100
10.10.1.0/24 dev ib0 proto static scope link

# ip route show table 101
10.10.2.0/24 dev ib1 proto static scope link

# ip route show table 102
10.10.3.0/24 dev ib2 proto static scope link
```

Tables `100..199` are **reserved** for xiNAS. The flush logic in §3.4 only touches that range, so anything an operator parked in tables `0..99` or `200+` survives.

---

## 5. Stage 3 — `perf_tuning`: 400 Gbit knobs

[collection/roles/perf_tuning/tasks/main.yml](../../collection/roles/perf_tuning/tasks/main.yml)

Network-relevant parts only (storage/CPU/memory knobs are documented in [spec.md §3.12](spec.md#312-perf_tuning--xinnor-recommended-performance-tuning)).

### Persisted sysctl (via `/etc/sysctl.d/`, applied immediately)

| Key | Value |
|---|---|
| `net.core.rmem_max` | `1073741824` (1 GiB) |
| `net.core.wmem_max` | `1073741824` |
| `net.core.netdev_max_backlog` | `250000` |
| `net.core.somaxconn` | `65535` |
| `net.ipv4.tcp_rmem` | `4096 1048576 16777216` |
| `net.ipv4.tcp_wmem` | `4096 1048576 16777216` |
| `sunrpc.tcp_max_slot_table_entries` | `128` (with `ignoreerrors`) |

These override the smaller `rmem_max`/`wmem_max` (`256 MiB`) that the `common` role wrote earlier — `perf_tuning` runs last and wins.

### Per-NIC ethtool / MTU (only if `perf_net_ifaces` is set)

`perf_net_ifaces` defaults to `[]`, so the block below is **skipped on a stock install** — `net_controllers` already set the right MTU and the IB stack already uses default ring sizes. Operators can opt in by overriding `perf_net_ifaces` in the preset or inventory:

```yaml
perf_net_ifaces: ["mlx0", "mlx1"]
perf_net_mtu: 9000          # for RoCE; do not use on InfiniBand
perf_net_ring_rx: 8192
perf_net_ring_tx: 8192
```

When set, the role runs:

```
ip link set dev <iface> mtu <perf_net_mtu>
ethtool -G <iface> rx <perf_net_ring_rx> tx <perf_net_ring_tx>
```

Caveat: `ip link set ... mtu 9000` on a native IB interface will fail (IB max is `4092` for IPoIB-CM, less for UD). Either leave `perf_net_ifaces` empty or list only RoCE/Ethernet NICs.

---

## 6. Optional — `roce_lossless`

[collection/roles/roce_lossless/defaults/main.yml](../../collection/roles/roce_lossless/defaults/main.yml)

**Not in `site.yml`. Off by default.** Invoke explicitly: `ansible-playbook playbooks/site.yml --tags roce_lossless`.

Defaults are tuned for RoCEv2 with PFC priority 3:

- `rdma_mode: "auto"` — skips itself on native IB (already lossless); configures PFC/ETS on RoCE.
- `roce_pfc_priority: 3`, `roce_pfc_enabled: true`.
- `roce_ets_tc_bw: "10,10,10,50,10,0,10,0"` (must sum to 100; TC3 gets 50%).
- `roce_dscp: 26` (AF31), `roce_cma_tos: 106` (DSCP 26 << 2 with ECN bits), `roce_trust_mode: "dscp"`.
- `roce_ecn_enabled: true`.
- `roce_persist: true` — writes a systemd unit and `/usr/local/sbin/roce-lossless-config.sh` so settings survive a reboot.

Use this only when the host talks NFS-RDMA over Ethernet to a switch that has matching PFC/ETS policy. On native IB it is a no-op.

---

## 7. End state on a freshly installed node

After `site.yml` completes and the operator reboots once (required by DOCA), the network should look like this.

### Files

```
/etc/netplan/99-xinas.yaml          # xiNAS, owns all IB/mlx interface definitions
/etc/netplan/50-cloud-init.yaml     # cloud-init, IB entries (if any) removed
/etc/udev/rules.d/70-ib-names.rules # MAC → ib0/ib1/… renames
/etc/sysctl.d/90-perf-vm.conf       # VM knobs from perf_tuning
/etc/apt/sources.list.d/mellanox-doca.list
```

### Kernel state

| Check | Expected |
|---|---|
| `ofed_info -s` | DOCA-Host version string |
| `ibstat` | each port `State: Active`, `Phys state: LinkUp` |
| `lsmod \| grep -E '^(mlx5_core\|mlx5_ib\|rpcrdma)'` | all three loaded |
| `ip -br link show \| awk '$1 ~ /^ib/'` | one row per IB port, all `UP` |
| `ip -4 -br addr show \| awk '$1 ~ /^ib/'` | each IB port has its `10.10.<n>.1/24` |
| `cat /sys/class/net/ib0/mtu` | `4092` (IB) or `9000` (Ethernet) |
| `ip rule show` | rules `100..N` from each IB IP into its table |
| `ip route show table 100` | one connected-scope route for the per-iface /24 |
| `sysctl net.core.rmem_max` | `1073741824` |
| `sysctl sunrpc.tcp_max_slot_table_entries` | `128` |

### Quick one-liner smoke test

```bash
echo "== interfaces =="     ; ip -br link show | awk '$1 ~ /^ib|^enp|^mlx/'
echo "== IB addresses =="   ; ip -4 -br addr show | awk '$1 ~ /^ib|^mlx/'
echo "== PBR rules =="      ; ip rule show | grep -E '^(1[0-9]{2}):'
echo "== netplan files =="  ; ls -la /etc/netplan/
echo "== rdma modules =="   ; lsmod | grep -E '^(mlx5_core|mlx5_ib|rpcrdma)'
echo "== ibstat =="         ; ibstat | grep -E 'CA|Port|State'
```

---

## 8. Failure modes the installer guards against

| Failure | Where it would manifest | Guard |
|---|---|---|
| Cloud-init redefines an IB interface and netplan merges duplicates | Two IPs on `ib0`, mismatched PBR | Pre-apply Python pass strips IB entries from non-xinas netplan files |
| PBR rules from a previous install survive an IP change | Replies leave the wrong interface; NFS times out under multi-IP trunking | Pre-apply shell pass flushes tables `100..199` and `ip addr flush` on mlx interfaces |
| IP pool overflows the third octet | Would produce `10.10.256.1/24`-style invalid IPs silently | `fail:` task explicitly checks every allocated octet against 255 |
| DKMS package compiled but silently broken | `mlx5_core` loads, `rpcrdma` is missing, NFS-RDMA dies later | DKMS-status grep in `doca_ofed`; play fails on `error`/`broken` and warns on missing `rpcrdma` |
| IB interfaces named by PCI topology (`ibp65s0`) drift between hosts | netplan template names don't match real NICs | `configure_ib_udev.sh` pins MAC → `ib0/ib1/…` via udev rules |
| `netplan apply` no-op because the template didn't change, but kernel state was just flushed | Empty `ip rule` / `ip addr` until next reboot | `Apply netplan to sync kernel state` task runs unconditionally after the flush |
| Operator runs the play before rebooting after DOCA install | `mlx5_core` driver bound but `/sys/class/net/<iface>/device` not yet populated | Detection has a fallback path that scans `/proc/net/dev` for `ib*` names |

---

## 9. What the installer does **not** do

These are deliberate non-features — flag them only if the operator asks for them:

- It does not configure VLANs, bonds, or bridges on IB/mlx interfaces. Multi-IP trunking is achieved via per-interface PBR, not LACP.
- It does not assign IPv6 addresses. Netplan blocks render IPv4-only.
- It does not set up firewall rules. Port 20049 (NFS-RDMA) and 2049 (NFS-TCP) are assumed open on the storage network.
- It does not configure lossless RoCE unless the operator runs `--tags roce_lossless`.
- It does not touch the management Ethernet (`enp*`, `eno*`, `eth*`). Anything cloud-init configured there is left intact.
- It does not enable jumbo frames on management interfaces. The 9000-byte default applies to detected `mlx5_core` (non-IB) ports only.
