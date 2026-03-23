# Network Management Specification

## Overview

xiNAS manages high-performance InfiniBand (IB) and Ethernet networking through netplan YAML configuration. This document covers the architecture, configuration file ownership, and the policy-based routing (PBR) scheme used for multi-IP NFS trunking.

---

## Configuration File Ownership

### Canonical File: `/etc/netplan/99-xinas.yaml`

All IB/RDMA interface configuration is owned exclusively by `99-xinas.yaml`. This is the single source of truth for:

- IP addresses on InfiniBand interfaces (driver: `mlx5_core`)
- MTU settings
- Policy-based routing rules and tables
- Interface enable/disable state

**Writers:**

| Component | When |
|-----------|------|
| Ansible `net_controllers` role | Deployment via `site.yml` or standalone |
| TUI Network screen (`[2] Edit Interface IP`) | Manual IP changes via `_update_netplan()` |
| TUI IP Pool screen (`[5] IP Pool Configuration`) | Pool-based IP allocation |

### Other Netplan Files

Netplan merges ALL `*.yaml` and `*.yml` files in `/etc/netplan/` before applying. Files like `50-cloud-init.yaml` may exist for the management Ethernet interface.

**Critical rule:** IB interfaces must NEVER be defined in files other than `99-xinas.yaml`. If the same interface appears in two files, netplan merges them, producing:
- Duplicate IP addresses on the interface
- Conflicting PBR routing tables
- Stale secondary IPs that survive `netplan apply`

**Enforcement:** Both the TUI and Ansible automatically remove IB interface definitions from non-xinas netplan files before applying configuration.

### File Precedence (alphabetical merge)

```
01-netcfg.yaml          # May exist on some systems
50-cloud-init.yaml      # Cloud-init managed (management Ethernet only)
99-xinas.yaml           # xiNAS owned (all IB interfaces + PBR)
```

Netplan merges in alphabetical order. Higher-numbered files override lower ones for scalar values, but **arrays are concatenated** (e.g. `addresses`), which is why duplicate definitions cause problems.

---

## Interface Classification

| Prefix | Type | Driver | Managed by xiNAS |
|--------|------|--------|-----------------|
| `enp*`, `eno*`, `eth*` | Ethernet | `igb`, `ixgbe`, `ice` | No (management only) |
| `ibp*` | InfiniBand | `mlx5_core` | Yes |

Detection method: resolve `/sys/class/net/<iface>/device/driver` symlink; if the basename contains `mlx`, the interface is RDMA-capable and managed by xiNAS.

---

## IP Address Assignment

### IP Pool Mode (`net_ip_pool_enabled: true`)

Automatic assignment from a contiguous pool. Each IB interface gets one IP with an incrementing third octet.

**Configuration** (in `collection/roles/net_controllers/defaults/main.yml`):
```yaml
net_ip_pool_enabled: true
net_ip_pool_start: "10.10.1.1"    # First IP
net_ip_pool_prefix: 24            # Subnet mask
```

**Allocation formula:**
```
interface[i] = base.base.(start_octet + i).host_octet/prefix
```

Example with `net_ip_pool_start: "10.10.1.1"` and 3 interfaces:
```
ibp65s0:  10.10.1.1/24
ibp9s0f0: 10.10.2.1/24
ibp9s0f1: 10.10.3.1/24
```

**Overflow guard:** If `start_octet + interface_count > 255`, the Ansible task fails with an error explaining the overflow.

### Manual Mode (`net_ip_pool_enabled: false`)

Uses the netplan template with whatever variables are provided via inventory or preset YAML files.

### Manual Override (`net_manual_ips`)

Per-interface overrides that take priority over pool allocation:
```yaml
net_manual_ips:
  ibp65s0: "10.10.5.1/24"
```

---

## Policy-Based Routing (PBR)

PBR ensures NFS replies egress through the same interface they arrived on. Without PBR, the kernel's default routing could send replies out the wrong interface, breaking multi-IP trunking.

### Scheme

Each IB interface gets:
1. A dedicated routing table (ID = 100 + interface index)
2. A policy rule routing traffic FROM its IP to its table
3. A connected subnet route in its table

### Generated Netplan Structure

For interface index 0 (`ibp65s0`, IP `10.10.1.1/24`):
```yaml
ibp65s0:
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

### Kernel State After Apply

```
# ip rule show (relevant entries)
100:  from 10.10.1.1 lookup 100 proto static
101:  from 10.10.2.1 lookup 101 proto static
102:  from 10.10.3.1 lookup 102 proto static

# ip route show table 100
10.10.1.0/24 dev ibp65s0 proto static scope link

# ip route show table 101
10.10.2.0/24 dev ibp9s0f0 proto static scope link

# ip route show table 102
10.10.3.0/24 dev ibp9s0f1 proto static scope link
```

### Table ID Range

Tables 100-199 are reserved for xiNAS PBR. The flush logic targets this range exclusively.

---

## Apply Sequence

When network configuration changes, the following sequence ensures clean state:

### Step 1: Flush Stale State

Before applying new configuration, all previous network state on IB interfaces is cleared:

1. **PBR rules**: Remove all `ip rule` entries referencing tables 100-199
2. **Routing tables**: Flush all routes from tables 100-199
3. **IP addresses**: Flush all IPs from mlx interfaces (`ip addr flush dev <iface>`)
4. **Cross-file cleanup**: Remove IB interface definitions from non-xinas netplan files

### Step 2: Deploy Configuration

Write `99-xinas.yaml` with the current interface/IP/PBR definitions.

### Step 3: Apply

Run `netplan apply` which reads the merged configuration and programs the kernel.

### Why Full Flush Is Necessary

`netplan apply` has known limitations:
- Does **not** remove IP addresses from previous configurations
- Does **not** clean up PBR rules from deleted interfaces
- **Merges** arrays (like `addresses`) across files, creating duplicates

The flush-before-apply pattern compensates for these limitations.

---

## Code Paths

### Ansible (`collection/roles/net_controllers/`)

| File | Purpose |
|------|---------|
| `defaults/main.yml` | IP pool defaults (`net_ip_pool_start`, etc.) |
| `tasks/main.yml` | Interface detection, IP allocation, flush, deploy, apply |
| `templates/netplan.yaml.j2` | Jinja2 template generating `99-xinas.yaml` |
| `handlers/main.yml` | Flush + `netplan apply` handler (fires on template change) |

### TUI (`xinas_menu/screens/`)

| File | Function | Purpose |
|------|----------|---------|
| `network.py` | `_update_netplan()` | Write interface IP to `99-xinas.yaml` |
| `network.py` | `_remove_iface_from_other_netplan_files()` | Clean IB entries from other files |
| `network.py` | `_flush_pbr_rules()` | Flush PBR + IPs before apply |
| `network.py` | `_apply_netplan()` | Full flush-then-apply sequence |
| `ip_pool.py` | `_generate_netplan()` | Generate pool-based config |
| `main_menu.py` | `_routable_ips()` | Detect server IPs for client instructions |

---

## Troubleshooting

### Symptom: Phantom IPs in Dashboard

**Cause:** Another netplan file (e.g. `50-cloud-init.yaml`) defines the same IB interface with a different IP. Netplan merges both.

**Fix:** Check `ls /etc/netplan/` for extra files. Remove IB interface entries from non-xinas files, or use TUI `[3] Apply Network Changes` (auto-cleans since v2606da5).

### Symptom: Stale PBR Rules After IP Change

**Cause:** `netplan apply` does not remove old PBR rules when IP addresses change. The old `from <old-ip> lookup <table>` rule persists.

**Fix:** Use TUI `[3] Apply Network Changes` which flushes all PBR rules (tables 100-199) before applying. The Ansible role also does this automatically.

### Symptom: Interface Shows "no IP" But Should Have One

**Cause:** The interface may be physically down, or the netplan config references an interface name that doesn't match the system.

**Fix:** Check `ip link show` for interface state. Verify interface names in `99-xinas.yaml` match `ls /sys/class/net/`.

### Diagnostic Commands

```bash
# Show all netplan files (check for duplicates)
ls -la /etc/netplan/

# Show actual kernel IPs on IB interfaces
ip -4 -o addr show | grep -E 'ibp|mlx'

# Show PBR rules (should only have tables 100+)
ip rule show

# Show specific routing table
ip route show table 100

# Validate netplan without applying
netplan generate

# Show what netplan will apply
netplan get
```
