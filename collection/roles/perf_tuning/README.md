# Role: perf_tuning

High-performance tuning for xiRAID storage nodes running Ubuntu 22.04/24.04, as
recommended in Xinnor blogs (2023-2025) and NVIDIA ConnectX-7 (400 Gbit) docs.

## Features
* Disables or relaxes CPU security mitigations (optional) to reduce latency.
* Enables NVMe polling queues and noop scheduler.
* Optionally stops **irqbalance**, sets CPU governor to *performance*, applies TuneD
  *throughput-performance* profile.
* Turns off THP/KSM and ups read-ahead, queue depth and *nr_requests*.
* Network block:
  * MTU 9000, enlarged RX/TX rings, big socket buffers, netdev backlog for
    400 Gbit ConnectX-7 links.

## Variables
See `defaults/main.yml` for the full list; most tuning knobs can be disabled or
altered via inventory/group_vars.

## Example
```yaml
- hosts: storage_nodes
  roles:
    - perf_tuning
```
