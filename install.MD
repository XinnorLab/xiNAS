# xiNAS Server Installation Guide

## Table of Contents

- [Quick Start](#quick-start)
- [Settings Reference](#settings-reference)
  - [Network Configuration](#network-configuration)
  - [RAID and Storage Configuration](#raid-and-storage-configuration)
  - [NFS Export Configuration](#nfs-export-configuration)
  - [Hostname Configuration](#hostname-configuration)
  - [Performance Tuning](#performance-tuning)
  - [Presets](#presets)
- [Detailed Architecture](#detailed-architecture)
  - [Installation Flow](#installation-flow)
  - [Menu System](#menu-system)
  - [Ansible Playbook Execution Order](#ansible-playbook-execution-order)
  - [Ansible Roles Reference](#ansible-roles-reference)
  - [Variable Priority](#variable-priority)
- [Prerequisites](#prerequisites)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### One-Command Install

```bash
bash <(curl -fsSL https://github.com/XinnorLab/xiNAS/raw/main/prepare_system.sh)
```

This bootstraps the system (installs Ansible, yq, git, dialog), clones the repository, and launches the Simple Menu.

### Step-by-Step

1. **Run the installer** (downloads dependencies and opens the menu):
   ```bash
   ./prepare_system.sh
   ```

2. **Enter your xiRAID license** (menu option 2). The hardware key is displayed on screen -- send it to `support@xinnor.io` to receive a license.

3. **Press Install** (menu option 3). The installer will:
   - Configure baseline OS settings (timezone, NTP, packages)
   - Install NVIDIA DOCA-OFED drivers for RDMA networking
   - Assign static IPs to high-speed interfaces
   - Install Xinnor xiRAID software
   - Auto-detect NVMe drives, create namespaces and RAID arrays
   - Create an XFS filesystem and mount it at `/mnt/data`
   - Configure NFS exports so clients can connect
   - Apply performance tuning for 400 Gbit throughput

4. **Done.** Clients can mount the share:
   ```bash
   mount -t nfs -o vers=4.1,proto=rdma,port=20049 <server-ip>:/mnt/data /mnt/nas
   ```

### Expert Mode

For full control over every setting before deployment:

```bash
./prepare_system.sh -e
```

This opens the Expert Menu with access to network configuration, RAID device assignment, NFS export editing, hostname, and preset management before running the playbook.

### Update Only

Pull the latest xiNAS code without launching the menu:

```bash
./prepare_system.sh -u
```

---

## Settings Reference

All settings below can be edited through the interactive menus or by directly modifying the Ansible role defaults in `collection/roles/<role>/defaults/main.yml`.

### Network Configuration

Edit via: `./configure_network.sh` or Expert Menu > Advanced Settings > Network

#### Automatic IP Pool (Default)

Each detected high-speed interface gets an IP from the pool, incrementing by subnet.
Example: ib0 = 10.10.1.1/24, ib1 = 10.10.2.1/24, ib2 = 10.10.3.1/24.

| Variable | Default | Description |
|----------|---------|-------------|
| `net_ip_pool_enabled` | `true` | Enable automatic IP allocation |
| `net_ip_pool_start` | `10.10.1.1` | First IP in the pool |
| `net_ip_pool_end` | `10.10.255.1` | Last IP in the pool |
| `net_ip_pool_prefix` | `24` | CIDR prefix length |

#### Interface Detection

| Variable | Default | Description |
|----------|---------|-------------|
| `net_detect_infiniband` | `true` | Auto-detect native InfiniBand interfaces |
| `net_detect_mlx5` | `true` | Auto-detect Mellanox MLX5 (RoCE) interfaces |
| `net_mtu` | `0` | MTU size. 0 = auto (4092 for IB, 9000 for RoCE/Ethernet) |
| `net_manual_ips` | `{}` | Manual IP overrides per interface |

#### Manual Mode

Set `net_ip_pool_enabled: false` and define IPs per interface:

```yaml
net_manual_ips:
  ib0: "192.168.1.10/24"
  ib1: "192.168.2.10/24"
```

### RAID and Storage Configuration

Edit via: `./configure_raid.sh` or Expert Menu > Advanced Settings > RAID

#### Automatic Drive Detection (Default)

The `nvme_namespace` role auto-detects system vs. data drives and builds RAID arrays.

| Variable | Default | Description |
|----------|---------|-------------|
| `nvme_auto_namespace` | `true` | Enable automatic drive detection and namespace creation |
| `nvme_detect_mode` | `nvme` | `nvme` = NVMe only (bare metal), `all` = all block devices (VMs) |
| `nvme_log_drive_count` | `2` | Number of drives for log array (used in `all` mode) |
| `nvme_small_ns_size_mb` | `500` | Size of log namespace per drive (MB) |
| `nvme_use_existing_namespaces` | `false` | Skip namespace rebuild, use drives as-is |

#### RAID Levels

| Variable | Default | Description |
|----------|---------|-------------|
| `nvme_raid_data_level` | `5` | RAID level for data array |
| `nvme_raid_log_level` | `10` | RAID level for log array (1 for VMs) |
| `nvme_raid_data_strip_kb` | `128` | Data array strip size (KB) |
| `nvme_raid_log_strip_kb` | `16` | Log array strip size (KB) |

#### Namespace Format

| Variable | Default | Description |
|----------|---------|-------------|
| `nvme_namespace_block_size` | `4096` | Block size in bytes (512 or 4096) |
| `nvme_namespace_shared` | `true` | Shared namespace flag for multi-controller access |

#### Safety Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `nvme_abort_if_no_system_drive` | `true` | Abort if OS drive cannot be identified |
| `nvme_skip_failed_devices` | `true` | Continue if a single device fails |
| `nvme_cleanup_existing_storage` | `true` | Remove existing LVM/MD/ZFS on data drives |
| `nvme_skip_cleanup_confirmation` | `false` | Skip cleanup confirmation (set `true` for automation) |
| `nvme_min_devices_for_raid5` | `3` | Minimum drives for RAID 5 |
| `nvme_min_devices_for_raid10` | `4` | Minimum drives for RAID 10 (must be even) |

#### Filesystem and Array Creation

| Variable | Default | Description |
|----------|---------|-------------|
| `xiraid_license_path` | `/tmp/license` | Path to xiRAID license file |
| `xiraid_force_metadata` | `true` | Force metadata overwrite on array creation |
| `xfs_force_mkfs` | `true` | Force XFS filesystem recreation (destroys existing data) |

#### Manual RAID Configuration

Disable auto-detection and define arrays explicitly:

```yaml
nvme_auto_namespace: false

xiraid_arrays:
  - name: data
    level: 5
    strip_size_kb: 128
    devices: [/dev/nvme1n2, /dev/nvme2n2, /dev/nvme3n2]
    parity_disks: 1
  - name: log
    level: 10
    strip_size_kb: 16
    devices: [/dev/nvme1n1, /dev/nvme2n1, /dev/nvme3n1, /dev/nvme4n1]

xfs_filesystems:
  - label: nfsdata
    data_device: "/dev/xi_data"
    log_device: "/dev/xi_log"
    log_size: 1G
    sector_size: 4k
    mountpoint: /mnt/data
    mount_opts: "logdev=/dev/xi_log,noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k"
```

### NFS Export Configuration

Edit via: `./configure_nfs_exports.sh` or Expert Menu > Advanced Settings > NFS Exports

| Variable | Default | Description |
|----------|---------|-------------|
| `exports` | (see below) | List of NFS export rules |

```yaml
exports:
  - path: /mnt/data
    clients: "*"
    options: "rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0"
```

Each export entry has:
- **path** -- directory to share (created if missing)
- **clients** -- `*` (everyone), a network (`192.168.1.0/24`), or a single host IP
- **options** -- comma-separated NFS export options

Common options: `rw`, `ro`, `sync`, `async`, `no_root_squash`, `root_squash`, `insecure`, `no_subtree_check`, `fsid=0`

#### NFS Server Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `nfs_threads` | CPU cores | Thread count for nfsd and exportd daemons |
| `nfs_rdma_port` | `20049` | Port for NFS-RDMA service |

### Hostname Configuration

Edit via: `./configure_hostname.sh`

| Variable | Default | Description |
|----------|---------|-------------|
| `xinas_hostname` | `""` (auto-generate) | System hostname. If empty, generates `xiNAS-<HWKEY>` |

### Performance Tuning

All tuning is applied by the `perf_tuning` role. Override via inventory or preset playbook vars.

#### CPU and Kernel

| Variable | Default | Description |
|----------|---------|-------------|
| `perf_disable_mitigations` | `true` | Disable Spectre/Meltdown mitigations (~5-10% latency improvement) |
| `perf_cpu_governor` | `performance` | CPU frequency governor |
| `perf_disable_cpupower` | `false` | Skip governor adjustment (set `true` for VMs) |
| `perf_stop_irqbalance` | `false` | Stop irqbalance service |
| `perf_disable_thp` | `true` | Disable Transparent Huge Pages |
| `perf_disable_ksm` | `true` | Disable Kernel Same-page Merging |

#### Storage I/O

| Variable | Default | Description |
|----------|---------|-------------|
| `perf_nvme_poll_queues` | `4` | NVMe polling queues (reduces interrupt latency) |
| `perf_nr_requests` | `512` | I/O queue depth (0 for VMs) |
| `perf_read_ahead_kb` | `65536` | Block device read-ahead (KB) |

#### Memory Management

| Variable | Default | Description |
|----------|---------|-------------|
| `perf_vm_swappiness` | `1` | Swap preference (1 = strongly prefer file cache) |
| `perf_vm_dirty_background_ratio` | `5` | Start background writeback at 5% dirty |
| `perf_vm_dirty_ratio` | `15` | Block processes at 15% dirty |
| `perf_vm_lru_gen` | `1` | Enable Multi-Gen LRU (kernel 6.1+) |
| `perf_vm_min_ttl_ms` | `10000` | Minimum page age before reclaim |
| `perf_vm_vfs_cache_pressure` | `200` | Aggressively reclaim dentries/inodes |
| `perf_vm_zone_reclaim_mode` | `0` | Disable zone reclaim (NUMA) |

#### Network (400 Gbit)

| Variable | Default | Description |
|----------|---------|-------------|
| `perf_net_mtu` | `9000` | Jumbo frame MTU |
| `perf_net_ring_rx` | `8192` | RX ring buffer descriptors |
| `perf_net_ring_tx` | `8192` | TX ring buffer descriptors |
| `perf_net_rmem_max` | `1073741824` | Max socket receive buffer (1 GiB) |
| `perf_net_wmem_max` | `1073741824` | Max socket send buffer (1 GiB) |
| `perf_net_backlog` | `250000` | Network backlog queue |

### Presets

Presets bundle all configuration into a reusable profile stored in `presets/<name>/`.

#### Default Preset (`presets/default/`)

For bare-metal servers with NVMe drives:
- Auto IP pool 10.10.1.1-10.10.255.1/24
- NVMe namespace rebuild (500MB log + remaining data per drive)
- RAID 5 data + RAID 10 log
- NFS export at `/mnt/data` to all hosts

#### VM Preset (`presets/xinnorVM/`)

For virtual machines with virtio/SCSI drives:
- Same IP pool as default
- Detects all block devices (`nvme_detect_mode: all`)
- First 2 drives become log array (RAID 1), rest become data (RAID 5)
- Disables CPU governor adjustment (`perf_disable_cpupower: true`)
- Sets I/O queue depth to 0 (`perf_nr_requests: 0`)

#### Custom Presets

Save from Expert Menu > Advanced Settings > Presets > Save. Creates a directory under `presets/<name>/` with all current settings.

---

## Detailed Architecture

### Installation Flow

```
prepare_system.sh                     # Bootstrap: install deps, clone repo
  |
  +--> simple_menu.sh                 # Default: guided install
  |      1. Enter license
  |      2. Press Install
  |      3. Playbook runs automatically
  |
  +--> startup_menu.sh  (with -e)    # Expert: full configuration control
         1. Collect system data
         2. Enter license
         3. Configure network, RAID, NFS, hostname
         4. Choose install profile
         5. Playbook runs with selected preset
```

### Menu System

#### Simple Menu (`simple_menu.sh`)

| Option | Action |
|--------|--------|
| 1 | Collect system data and upload |
| 2 | Enter xiRAID license |
| 3 | Run full installation playbook |
| 4 | Advanced settings (network, presets, monitor) |
| 0 | Exit |

Detects existing xiRAID arrays and offers to reuse them. Auto-detects VMs and suggests the VM preset.

#### Expert Menu (`startup_menu.sh`)

| Option | Action |
|--------|--------|
| 1 | Collect system data |
| 2 | Enter xiRAID license |
| 3 | Install (choose profile: Full NVMe, VM, or Existing RAID) |
| 4 | Advanced settings (network, RAID, NFS, hostname, presets) |
| 0 | Exit |

**Installation profiles:**

- **Full (NVMe)** -- complete deployment for bare-metal servers. Erases all non-OS NVMe drives. Uses `default` preset.
- **VM** -- optimized for virtual machines. Detects all block devices. Uses `xinnorVM` preset.
- **Existing RAID** -- skips xiRAID install and array creation. Creates XFS on pre-existing `/dev/xi_data` and `/dev/xi_log`. Uses `default` preset with `xiraid_skip_install=true`.

### Ansible Playbook Execution Order

The main playbook (`playbooks/site.yml`) runs roles in this order:

```
common ──> doca_ofed ──> net_controllers ──> xiraid_classic ──> nvme_namespace ──> raid_fs ──> exports ──> nfs_server ──> perf_tuning ──> motd
```

Each role is idempotent and safe to re-run, except `xfs_force_mkfs: true` which forces filesystem recreation.

#### Standalone Playbooks

```bash
ansible-playbook playbooks/common.yml             # Baseline OS config only
ansible-playbook playbooks/doca_ofed_install.yml   # DOCA-OFED drivers only
ansible-playbook playbooks/site.yml                # Full deployment
ansible-playbook playbooks/site.yml --tags nfs_server  # Single role
```

### Ansible Roles Reference

#### 1. common

**Purpose:** Baseline OS configuration.

**What it does:**
- Sets system timezone
- Installs packages: curl, vim, htop, chrony, ca-certificates, quota, unattended-upgrades
- Configures chrony NTP
- Applies kernel sysctl tuning (network buffers, swappiness)
- Sets hostname (optional)

| Variable | Default |
|----------|---------|
| `common_timezone` | `Europe/Amsterdam` |
| `common_packages` | `[curl, vim, htop, chrony, ...]` |
| `xinas_hostname` | `""` (auto-generate from HWKEY) |

#### 2. doca_ofed

**Purpose:** Install NVIDIA DOCA-OFED drivers for RDMA networking.

**What it does:**
- Adds Mellanox APT repository
- Installs doca-ofed kernel stack (DKMS), userspace tools, and mlnx-nfsrdma-dkms
- Generates udev rules for InfiniBand interface naming
- Optionally reboots for kernel module activation

| Variable | Default |
|----------|---------|
| `doca_version` | `2.9.1` |
| `doca_pkgs` | `[doca-ofed, doca-ofed-userspace, mlnx-nfsrdma-dkms]` |
| `doca_ofed_auto_reboot` | `false` |

Supports: InfiniBand, RoCE (RDMA over Converged Ethernet) on Mellanox ConnectX NICs.

#### 3. net_controllers

**Purpose:** Configure static IPs on high-speed network interfaces.

**What it does:**
- Detects InfiniBand and MLX5 interfaces
- Allocates IPs from pool (auto) or uses manual overrides
- Generates and applies netplan configuration

See [Network Configuration](#network-configuration) for all variables.

#### 4. xiraid_classic

**Purpose:** Install Xinnor xiRAID software.

**What it does:**
- Downloads and installs the xiraid-repo package
- Installs xiraid-core with DKMS kernel module
- Accepts EULA automatically

| Variable | Default |
|----------|---------|
| `xiraid_version` | `4.3.0` |
| `xiraid_repo_version` | `1.3.0-1588` |
| `xiraid_repo_kernel` | `6.8` |
| `xiraid_packages` | `[xiraid-core]` |
| `xiraid_accept_eula` | `true` |
| `xiraid_auto_reboot` | `false` |

Skip with: `xiraid_skip_install: true` (for systems with xiRAID already installed).

#### 5. nvme_namespace

**Purpose:** Auto-detect drives, rebuild NVMe namespaces, generate RAID configuration.

**What it does:**
1. Identifies the system drive (root/boot/EFI partitions) and excludes it
2. Enumerates all other NVMe controllers (or all block devices in VM mode)
3. Optionally cleans existing LVM/MD/ZFS on data drives
4. Rebuilds namespaces: small (500MB) for log, large (remaining) for data
5. Generates `xiraid_arrays` and `xfs_filesystems` facts consumed by the `raid_fs` role

**Two modes:**
- `nvme` (default) -- bare metal with NVMe SSDs. Rebuilds namespaces with 4KB blocks.
- `all` -- VMs with virtio/SCSI. Uses whole drives, no namespace rebuild. First N drives = log, rest = data.

See [RAID and Storage Configuration](#raid-and-storage-configuration) for all variables.

**WARNING:** Destroys all data on non-system drives.

#### 6. raid_fs

**Purpose:** Create xiRAID arrays and XFS filesystems.

**What it does:**
1. Loads xiRAID license
2. Cleans drives with `xicli drive clean`
3. Creates RAID arrays (data + log)
4. Creates XFS filesystem with tuned parameters:
   - External log device (`/dev/xi_log`)
   - Stripe-aligned allocation
   - 256KB log buffer, 128MB allocation size
   - noatime, nodiratime, largeio, inode64
5. Creates persistent systemd mount units

| Variable | Default |
|----------|---------|
| `xiraid_license_path` | `/tmp/license` |
| `xiraid_force_metadata` | `true` |
| `xfs_force_mkfs` | `true` |
| `xiraid_arrays` | (generated by nvme_namespace) |
| `xfs_filesystems` | (generated by nvme_namespace) |

#### 7. exports

**Purpose:** Generate `/etc/exports` and reload NFS export table.

**What it does:**
- Creates export directories if missing
- Writes `/etc/exports` from template
- Runs `exportfs -ra` to activate

See [NFS Export Configuration](#nfs-export-configuration) for variables.

#### 8. nfs_server

**Purpose:** Install and configure the NFS kernel server with RDMA support.

**What it does:**
- Installs nfs-kernel-server
- Sets nfsd and exportd thread counts (default = CPU core count)
- Enables NFS-RDMA on port 20049
- Starts and enables the nfs-server systemd unit

| Variable | Default |
|----------|---------|
| `nfs_threads` | CPU cores |
| `nfs_rdma_port` | `20049` |

#### 9. perf_tuning

**Purpose:** Apply performance optimizations for high-throughput NFS-RDMA.

**What it does:**
- Optionally disables Spectre/Meltdown mitigations
- Enables NVMe polling queues
- Sets CPU governor to `performance`
- Disables THP and KSM
- Tunes I/O scheduler, queue depth, read-ahead
- Configures memory writeback ratios and MGLRU
- Tunes network stack for 400 Gbit (jumbo frames, large ring buffers, 1 GiB socket buffers)

See [Performance Tuning](#performance-tuning) for all variables.

#### 10. motd

**Purpose:** Set up login banner and management menu hint.

**What it does:**
- Creates a branded MOTD displayed on SSH login
- Optionally removes Ubuntu default MOTD
- Installs `xinas-menu` command for post-install management

| Variable | Default |
|----------|---------|
| `motd_enabled` | `true` |
| `motd_disable_default` | `true` |

### Variable Priority

Settings are resolved in this order (highest wins):

1. **CLI / inventory variables** -- `ansible-playbook -e "var=value"` or `inventories/lab.ini`
2. **Preset playbook vars** -- `presets/<name>/playbook.yml` vars section
3. **Role defaults** -- `collection/roles/<role>/defaults/main.yml`

---

## Prerequisites

### Hardware

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 32 GB | 64+ GB |
| System disk | 20 GB | 50+ GB SSD |
| Data drives | 3 NVMe (RAID 5) | 4+ NVMe |
| Network | 25 Gbit Ethernet | 100-400 Gbit NVIDIA ConnectX-7 |

### Software

- **OS:** Ubuntu 22.04 LTS or 24.04 LTS
- **Internet access:** Required during install for APT repos, DOCA-OFED, and xiRAID packages

The installer automatically installs all software dependencies (Ansible, yq, git, chrony, nfs-kernel-server, etc.).

### License

A xiRAID license is required. The hardware key is displayed in the menu -- send it to `support@xinnor.io`. The license file is stored at `/tmp/license` (cleared on reboot; re-enter via the management menu).

---

## Troubleshooting

### yq version mismatch

The installer requires mikefarah/yq v4 at `/usr/local/bin/yq`. If an older Python yq is installed:
```bash
which -a yq        # check which versions are in PATH
/usr/local/bin/yq --version  # should show mikefarah/yq v4.x
```

### NVMe drives not detected

If the system drive cannot be identified, the `nvme_namespace` role aborts. Override with:
```bash
ansible-playbook playbooks/site.yml -e "nvme_abort_if_no_system_drive=false"
```

### RAID creation fails

Verify minimum drive counts: RAID 5 needs 3+ drives, RAID 10 needs 4+ (even number). Check detected drives:
```bash
xicli drive list
```

### NFS client cannot mount

Check that the NFS server is running and exports are active:
```bash
systemctl status nfs-server
exportfs -v
showmount -e localhost
```

For RDMA mounts, verify DOCA-OFED is installed on both server and client, and port 20049 is reachable.

### Re-running the playbook

All roles are idempotent. To re-run safely:
```bash
ansible-playbook playbooks/site.yml -i inventories/lab.ini
```

To force filesystem recreation (destroys data):
```bash
ansible-playbook playbooks/site.yml -e "xfs_force_mkfs=true"
```

### Checking status after install

```bash
xicli raid show           # RAID array status
xicli license show        # License info
xicli drive list          # Drive inventory
df -h /mnt/data           # Filesystem usage
exportfs -v               # Active NFS exports
nfsstat -s                # NFS server statistics
```
