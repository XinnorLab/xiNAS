# OS Layer Specification

All modules in `src/os/` read from sysfs/procfs or connect to local daemons.
**No subprocesses are ever spawned from this layer.**

---

## `src/os/systemInfo.ts`

### Data Sources
| Field | Source |
|---|---|
| `uptime_seconds` | `/proc/uptime` — field 1 |
| `load_avg[3]` | `/proc/loadavg` — fields 1-3 |
| `memory.total_kb` | `/proc/meminfo` — `MemTotal:` |
| `memory.available_kb` | `/proc/meminfo` — `MemAvailable:` |
| `memory.cached_kb` | `/proc/meminfo` — `Cached:` |
| `memory.used_pct` | `(total - available) / total * 100` |
| `cpu.model` | `/proc/cpuinfo` — `model name` |
| `cpu.logical_cores` | Count of `processor:` lines in `/proc/cpuinfo` |
| `cpu.numa_nodes` | `ls /sys/devices/system/node/node*/` |
| `os.name` | `/etc/os-release` — `PRETTY_NAME` |
| `os.version` | `/etc/os-release` — `VERSION_ID` |
| `os.kernel` | `/proc/version` — `Linux version X.Y.Z` |

### Service State Detection
`getServiceState(serviceName)` checks:
1. `/sys/fs/cgroup/system.slice/<name>.service` — present if active
2. `/run/systemd/units/<name>.service` — fallback

Returns `{ name, active: boolean, state: string }`.

---

## `src/os/networkInfo.ts`

### Data Sources
| Field | Source |
|---|---|
| `mac` | `/sys/class/net/<iface>/address` |
| `mtu` | `/sys/class/net/<iface>/mtu` |
| `operstate` | `/sys/class/net/<iface>/operstate` |
| `speed_mbps` | `/sys/class/net/<iface>/speed` (−1 = unknown) |
| `duplex` | `/sys/class/net/<iface>/duplex` |
| `rx_bytes, tx_bytes, errors, dropped` | `/proc/net/dev` — columns 2,10,4,12 |
| `is_rdma` | `/sys/class/infiniband/*/device/net/` — check if iface listed |
| `bond_mode, bond_members` | `/proc/net/bonding/<iface>` |

### Notes
- Loopback (`lo`) is excluded from results
- IPv4 addresses not populated in v1 (requires netlink or subprocess — deferred)
- `speed_mbps: null` when sysfs returns `−1` or file absent

---

## `src/os/diskInfo.ts`

### Block Device Enumeration
Iterates `/sys/class/block/`, skips:
- Partition names (end in digit)
- `loop*`, `dm-*`, `sr*`
- Includes `nvme*n*` and `sd*`, `hd*`

### Per-Device Data Sources
| Field | Source |
|---|---|
| `model` | `/sys/class/block/<dev>/device/model` |
| `serial` | `/sys/class/block/<dev>/device/serial` |
| `firmware` | `/sys/class/block/<dev>/device/firmware_rev` |
| `size_bytes` | `/sys/class/block/<dev>/size` × 512 |
| `logical_block_size` | `/sys/class/block/<dev>/queue/logical_block_size` |
| `physical_block_size` | `/sys/class/block/<dev>/queue/physical_block_size` |
| `rotational` | `/sys/class/block/<dev>/queue/rotational` = 1 |

### NVMe Health (sysfs)
Controller name mapped from namespace: `/sys/class/nvme/<ctrl>/`

| Field | Source |
|---|---|
| `temperature_celsius` | `/sys/class/nvme/<ctrl>/hwmon*/temp1_input` ÷ 1000 |
| `available_spare_pct` | `/sys/class/nvme/<ctrl>/available_spare` |
| `media_errors` | `/sys/class/nvme/<ctrl>/media_errors` |
| `critical_warning` | `/sys/class/nvme/<ctrl>/critical_warning` |
| `power_on_hours` | `/sys/class/nvme/<ctrl>/power_on_hours` |
| `unsafe_shutdowns` | `/sys/class/nvme/<ctrl>/unsafe_shutdowns` |

SATA SMART returns `UNSUPPORTED` — smartctl is not called.

---

## `src/os/prometheusClient.ts`

### Fetch
- `GET config.prometheus_url` with `AbortSignal.timeout(5000)`
- Uses `fetch` builtin (Node 20+)

### Parser
30-line Prometheus text-format parser:
- Skips `#` comment/TYPE/HELP lines
- Parses `metric_name{label="val",...} value [timestamp]`
- Returns `PrometheusMetric[]`

### Filtering
`getPerformanceSummary(target, metricNames)`:
- Filters by `metricNames` array (empty = all)
- Filters by label value matching `target` (e.g. `raid_name="md0"`)
- Returns `{ target, metrics, samples, fetched_at }`

### Label conventions (xiraid-exporter)
Labels used for filtering: `raid_name`, `drive`

---

## `src/os/nfsClient.ts`

### Protocol
Unix domain socket at `config.nfs_helper_socket` (default: `/run/xinas-nfs-helper.sock`).
One request per connection, newline-terminated JSON.

### Connection Timeout
5 seconds. Throws `McpToolError(INTERNAL)` if daemon unavailable.

### API Functions
| Function | op | Notes |
|---|---|---|
| `listExports()` | `list_exports` | Returns `ExportEntry[]` |
| `addExport(entry)` | `add_export` | Idempotent |
| `removeExport(path)` | `remove_export` | Error if not found |
| `updateExport(path, patch)` | `update_export` | Merge patch |
| `listSessions()` | `list_sessions` | Returns `SessionInfo[]` |
| `getSessions(path)` | `get_sessions` | Filter by export path |
| `setQuota(quota)` | `set_quota` | XFS project quota |
| `reloadExports()` | `reload` | `exportfs -r` |
