# IP Pool Network Configuration — Design

**Goal:** Add an IP Pool configuration screen to the xinas-menu Network Settings sub-menu that detects high-speed interfaces, allocates IPs from a pool, auto-detects MTU, and applies the configuration directly via netplan — no Ansible needed.

**Architecture:** New `IPPoolScreen` (Textual TUI) with NavigableMenu + ScrollableTextView layout. Pool settings stored in `/etc/xinas/network-pool.json`. On apply, generates `/etc/netplan/99-xinas-pool.yaml` and runs `netplan apply`.

---

## Menu Integration

NetworkScreen (`xinas_menu/screens/network.py`) gets new item `[5] IP Pool Configuration` which pushes `IPPoolScreen`.

## IPPoolScreen Menu

| Key | Label | Action |
|-----|-------|--------|
| 1 | Configure Pool | InputDialog prompts for start IP, end IP, CIDR prefix |
| 2 | Preview Allocation | Detect interfaces, calculate IPs + MTU, show in right panel |
| 3 | Apply Configuration | Write netplan YAML, run `netplan apply`, show result |
| 4 | Show Current Settings | Display saved pool config + current netplan state |
| 0 | Back | Pop screen |

## Config Storage

File: `/etc/xinas/network-pool.json`

```json
{
  "pool_enabled": true,
  "pool_start": "10.10.1.1",
  "pool_end": "10.10.255.1",
  "pool_prefix": 24
}
```

Atomic writes: `tempfile.mkstemp()` + `os.replace()` + `chmod 0600`.

## Interface Detection

Scan `/sys/class/net/*/`:
- Skip `lo` and interfaces without `/device` symlink
- Type 32 (`/sys/class/net/<iface>/type`) → InfiniBand
- Driver `mlx5_core` (via `/sys/class/net/<iface>/device/driver` readlink) → Mellanox
- Collect: name, type (IB/ETH), driver, link state, MAC

## IP Allocation Algorithm

Same logic as the Ansible `net_controllers` role:

1. Parse `pool_start` into octets: `[o1, o2, o3, o4]`
2. For each detected interface at index `i`:
   - IP = `o1.o2.(o3+i).o4/prefix`
3. Validate: `o3 + i <= 255` for all interfaces
4. If overflow → show error, do not apply

## MTU Auto-Detection

- Interface type 32 (InfiniBand) → MTU 4092
- All other (RoCE/Ethernet) → MTU 9000

## Netplan Output

Written to `/etc/netplan/99-xinas-pool.yaml`:

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    ib0:
      dhcp4: no
      addresses: [10.10.1.1/24]
      mtu: 4092
    ib1:
      dhcp4: no
      addresses: [10.10.2.1/24]
      mtu: 4092
```

Apply via `subprocess.run(["netplan", "apply"])`.

## Files to Create/Modify

| File | Change |
|------|--------|
| `xinas_menu/screens/ip_pool.py` | **New** — IPPoolScreen with pool config, preview, apply |
| `xinas_menu/screens/network.py` | Add menu item [5] IP Pool, import and push IPPoolScreen |

## Validation

- IPv4 format: regex `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` + each octet 0-255
- CIDR prefix: integer 1-32
- Pool capacity: `(end_3rd_octet - start_3rd_octet + 1) >= detected_interfaces`
- No octet overflow after allocation
