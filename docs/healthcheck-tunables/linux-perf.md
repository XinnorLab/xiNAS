# Linux Performance Tunables — Health Check Tunables

CPU, NVMe, I/O scheduler, and IRQ parameters verified by the xiNAS health check engine.
These settings are applied by the `perf_tuning` Ansible role.

## CPU & Scheduling

| Parameter | Recommended | Why it matters | How to check | Remediation |
|-----------|-------------|----------------|--------------|-------------|
| CPU governor | `performance` | Locks CPU at maximum frequency — eliminates frequency scaling latency that causes I/O jitter under load | `cpupower frequency-info -p` or `/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor` | `cpupower frequency-set -g performance` |
| CPU C-states | `intel_idle.max_cstate=0` | Disables deep idle states — C-state exit latency (10-100 us) causes tail latency spikes in storage I/O | Check `/proc/cmdline` for `intel_idle.max_cstate=0` | Add to `GRUB_CMDLINE_LINUX` in `/etc/default/grub`, then `update-grub` (requires reboot) |
| TuneD profile | `throughput-performance` | Applies a set of kernel tunables optimized for throughput — sets CPU governor, disables power saving, adjusts scheduler | `tuned-adm active` | `tuned-adm profile throughput-performance` |
| IRQ balance | stopped/disabled | The `irqbalance` daemon redistributes IRQs across CPUs — on dedicated NAS nodes this causes jitter; Mellanox OFED handles its own IRQ affinity | `systemctl is-active irqbalance` | `systemctl stop irqbalance && systemctl disable irqbalance` |
| NUMA balancing | disabled (`0`) | Automatic NUMA page migration causes unpredictable latency — NAS workloads are better served by static NUMA pinning | `cat /proc/sys/kernel/numa_balancing` | `sysctl -w kernel.numa_balancing=0` |

## NVMe Device Tuning

| Parameter | Recommended | Why it matters | How to check | Remediation |
|-----------|-------------|----------------|--------------|-------------|
| `poll_queues` | `4` | Enables NVMe polling I/O on 4 queues — polling bypasses interrupt overhead, reducing per-I/O latency by 2-5 us for small I/Os | `/sys/module/nvme/parameters/poll_queues` (or `nvme_core`) | Set `options nvme poll_queues=4` in `/etc/modprobe.d/nvme.conf`, then `update-initramfs -u` (requires reboot) |
| `nr_requests` | `512` | Queue depth per NVMe device — higher depth improves throughput for parallel I/O workloads (NFS serving multiple clients) | `/sys/block/nvmeXnY/queue/nr_requests` | `echo 512 > /sys/block/nvmeXnY/queue/nr_requests` |
| Read-ahead | `65536` KB (64 MB) | Kernel prefetch for sequential reads — NFS clients typically read large files sequentially, so aggressive read-ahead eliminates I/O stalls | `/sys/block/nvmeXnY/queue/read_ahead_kb` | `blockdev --setra 65536 /dev/nvmeXnY` |
| I/O scheduler | `none` or `noop` | NVMe devices have internal scheduling — kernel I/O schedulers add overhead without benefit for NVMe | `/sys/block/nvmeXnY/queue/scheduler` (active shown in `[brackets]`) | `echo none > /sys/block/nvmeXnY/queue/scheduler` |

## Memory Management (Runtime)

| Parameter | Recommended | Why it matters | How to check | Remediation |
|-----------|-------------|----------------|--------------|-------------|
| THP | `never` | Transparent Huge Pages cause latency spikes during compaction and splitting — especially harmful for NFS metadata operations | `/sys/kernel/mm/transparent_hugepage/enabled` (active in `[brackets]`) | `echo never > /sys/kernel/mm/transparent_hugepage/enabled` + kernel boot param `transparent_hugepage=never` |
| KSM | disabled (`0`) | Kernel Samepage Merging scans memory for duplicates — consumes CPU on NAS nodes where memory deduplication provides no benefit | `/sys/kernel/mm/ksm/run` | `echo 0 > /sys/kernel/mm/ksm/run` |

## Network (400 Gbit / ConnectX-7)

| Parameter | Recommended | Why it matters | How to check | Remediation |
|-----------|-------------|----------------|--------------|-------------|
| MTU | `9000` (jumbo frames) | Reduces per-packet overhead — 9 KB frames vs 1.5 KB means ~6x fewer packets for the same throughput | `/sys/class/net/<iface>/mtu` | `ip link set <iface> mtu 9000` |
| Ring buffers (RX/TX) | `8192` each | Larger NIC receive/transmit rings absorb traffic bursts — prevents packet drops during NFS write storms | `ethtool -g <iface>` | `ethtool -G <iface> rx 8192 tx 8192` |

## Spectre/Meltdown Mitigations

| Parameter | Recommended | Why it matters | How to check | Remediation |
|-----------|-------------|----------------|--------------|-------------|
| `mitigations=off` | kernel boot param | CPU vulnerability mitigations reduce throughput by 5-15% — on isolated NAS nodes in trusted networks the security trade-off is acceptable | Check `/proc/cmdline` for `mitigations=off` | Add to `GRUB_CMDLINE_LINUX` in `/etc/default/grub` (requires reboot) |

## Health Check Integration

- **Existing checks**: CPU governor, TuneD profile, NUMA balance, THP, KSM, mitigations, nr_requests, MTU, ring buffers (sections: `cpu`, `kernel`, `storage`, `network`)
- **New checks**: `nvme_poll_queues`, `read_ahead_kb`, `cpu_cstate`, `irqbalance`, `io_scheduler` (new section: `perf_tuning`)
- **Profile coverage**: quick = poll_queues + read_ahead; standard += cstate + scheduler; deep += irqbalance
- **Source files**: `collection/roles/perf_tuning/defaults/main.yml`, `collection/roles/perf_tuning/tasks/main.yml`
