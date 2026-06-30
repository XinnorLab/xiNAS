# Role: perf_tuning

High-performance tuning for xiRAID storage nodes running Ubuntu 22.04/24.04, as
recommended in Xinnor blogs (2023-2025) and NVIDIA ConnectX-7 (400 Gbit) docs.

## Features
* Disables or relaxes CPU security mitigations (optional) to reduce latency.
* Enables NVMe polling queues.
* Optionally stops **irqbalance**, sets CPU governor to *performance*, applies TuneD
  *throughput-performance* profile.
* Turns off THP/KSM and ups read-ahead, queue depth and *nr_requests*.
* Installs a `xinas-perf-runtime.service` oneshot that re-applies the volatile
  tunables at every boot — `vm.swappiness=1` (otherwise clobbered by the
  `common` role's `swappiness=10`) and THP `defrag=never` (the kernel cmdline
  pins THP `enabled` but not `defrag`). Without it those two settings silently
  revert after a reboot.
* Network block:
  * MTU 9000, enlarged RX/TX rings, big socket buffers, netdev backlog for
    400 Gbit ConnectX-7 links.

## Variables
See `defaults/main.yml` for the full list; most tuning knobs can be disabled or
altered via inventory variables. Notably, set `perf_disable_cpupower: true` to
skip adjusting the CPU frequency governor. The `cpupower` tool is provided by
the `linux-tools-common` package, which the role installs automatically.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - perf_tuning
```
