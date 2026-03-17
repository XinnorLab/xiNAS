# Sysctl Performance Tunables — Health Check Tunables

Kernel sysctl parameters verified by the xiNAS health check engine.
Applied by the `perf_tuning` Ansible role via `/etc/sysctl.d/90-perf-vm.conf` and runtime sysctl.

## VM / Memory Management

| Sysctl | Recommended | Default | Why it matters | Remediation |
|--------|-------------|---------|----------------|-------------|
| `vm.swappiness` | `1` | `60` | Controls preference for swapping vs dropping file cache — value of 1 means "only swap to avoid OOM". NAS nodes should keep file cache hot for NFS serving | `sysctl -w vm.swappiness=1` |
| `vm.dirty_background_ratio` | `5` | `10` | Percentage of memory at which background writeback starts — lower value means earlier flushing, preventing large dirty page buildups that cause write stalls | `sysctl -w vm.dirty_background_ratio=5` |
| `vm.dirty_ratio` | `15` | `20` | Percentage of memory at which processes block on writes — prevents runaway dirty page accumulation that causes sudden I/O storms | `sysctl -w vm.dirty_ratio=15` |
| `vm.vfs_cache_pressure` | `200` | `100` | Controls aggressiveness of reclaiming dentries and inodes — higher value frees VFS caches faster, making room for file data cache which matters more for NFS | `sysctl -w vm.vfs_cache_pressure=200` |
| `vm.zone_reclaim_mode` | `0` | `0` | Controls NUMA zone reclaim behavior — value 0 disables zone reclaim, allowing allocation from remote NUMA nodes rather than evicting local cache | `sysctl -w vm.zone_reclaim_mode=0` |
| `vm.lru_gen.enabled` | `1` | `0` | Enables Multi-Gen LRU (MGLRU, kernel 6.1+) — improves page reclaim decisions for large memory systems by tracking page age more accurately, reducing unnecessary evictions | `sysctl -w vm.lru_gen.enabled=1` |
| `vm.lru_gen.min_ttl_ms` | `10000` | `0` | Minimum time-to-live before a page can be reclaimed — 10 seconds prevents premature eviction of recently used file cache pages during burst NFS traffic | `sysctl -w vm.lru_gen.min_ttl_ms=10000` |
| `vm.watermark_scale_factor` | `200` | `10` | Controls how early kswapd wakes up for background reclaim — higher value means kswapd starts reclaiming sooner, avoiding direct reclaim stalls in the I/O path | `sysctl -w vm.watermark_scale_factor=200` |

## Network

| Sysctl | Recommended | Default | Why it matters | Remediation |
|--------|-------------|---------|----------------|-------------|
| `net.core.rmem_max` | `1073741824` (1 GiB) | `212992` | Maximum receive socket buffer size — NFS-RDMA and high-speed TCP require large buffers to sustain 400 Gbit throughput without flow control stalls | `sysctl -w net.core.rmem_max=1073741824` |
| `net.core.wmem_max` | `1073741824` (1 GiB) | `212992` | Maximum send socket buffer size — same rationale as rmem_max; both must be large for RDMA and TCP autotuning to reach full bandwidth | `sysctl -w net.core.wmem_max=1073741824` |
| `net.core.netdev_max_backlog` | `250000` | `1000` | Per-CPU backlog queue length — at 400 Gbit, packets arrive faster than a single CPU can process; larger backlog absorbs bursts without drops | `sysctl -w net.core.netdev_max_backlog=250000` |
| `net.core.somaxconn` | `65535` | `4096` | Maximum TCP listen queue length — NFS server can receive hundreds of simultaneous TCP connections; default 4096 can overflow during client storms | `sysctl -w net.core.somaxconn=65535` |
| `net.ipv4.tcp_rmem` | `4096 1048576 16777216` | `4096 131072 6291456` | TCP receive buffer auto-tuning range (min, default, max) — larger max allows individual TCP flows to reach higher throughput on high-BDP links | `sysctl -w net.ipv4.tcp_rmem="4096 1048576 16777216"` |
| `net.ipv4.tcp_wmem` | `4096 1048576 16777216` | `4096 16384 4194304` | TCP send buffer auto-tuning range — same rationale; both rmem and wmem must be tuned together for balanced throughput | `sysctl -w net.ipv4.tcp_wmem="4096 1048576 16777216"` |

## SunRPC (NFS Transport)

| Sysctl | Recommended | Default | Why it matters | Remediation |
|--------|-------------|---------|----------------|-------------|
| `sunrpc.tcp_max_slot_table_entries` | `128` | `2` | Maximum concurrent outstanding RPC requests per TCP connection — the default of 2 severely limits NFS throughput; 128 allows full pipeline utilization | `sysctl -w sunrpc.tcp_max_slot_table_entries=128` |

## Notes

- **Persistence**: All sysctls are persisted via `/etc/sysctl.d/90-perf-vm.conf` (VM settings) and `/etc/sysctl.conf` or additional files (network settings) by the Ansible role.
- **MGLRU availability**: `vm.lru_gen.*` sysctls only exist on kernels >= 6.1. The health check gracefully SKIPs on older kernels.
- **SunRPC module**: `sunrpc.tcp_max_slot_table_entries` requires the `sunrpc` kernel module to be loaded. The health check SKIPs if the sysctl path doesn't exist.

## Health Check Integration

- **Existing checks** (section `vm`): swappiness, dirty_background_ratio, dirty_ratio, vfs_cache_pressure, zone_reclaim
- **Existing checks** (section `network`): sysctl_rmem, sysctl_wmem, sysctl_backlog
- **New checks** (section `vm`): lru_gen, lru_gen_ttl, watermark_scale
- **New checks** (section `network`): sysctl_somaxconn, sysctl_sunrpc
- **Profile coverage**: quick = lru_gen + watermark_scale; standard += lru_gen_ttl + somaxconn + sunrpc; deep = all
- **Source files**: `collection/roles/perf_tuning/defaults/main.yml`, `collection/roles/perf_tuning/tasks/main.yml`
