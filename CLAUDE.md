# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

xiNAS is an Ansible-based provisioning framework for high-performance NAS storage nodes. It uses interactive Bash menus (whiptail TUI) to configure and deploy Xinnor xiRAID storage with NVIDIA DOCA-OFED networking and NFS-RDMA exports.

**Target Platform:** Ubuntu 22.04/24.04 LTS

## Key Commands

### Running Playbooks
```bash
ansible-playbook playbooks/site.yml              # Full deployment
ansible-playbook playbooks/common.yml            # Baseline only
ansible-playbook playbooks/doca_ofed_install.yml # NVIDIA OFED only
ansible-playbook playbooks/site.yml --tags "nfs_server"  # Run specific role
```

### Interactive Menus
```bash
./prepare_system.sh      # Initial setup (installs ansible, yq, whiptail)
./prepare_system.sh -e   # Expert mode with full menu
./startup_menu.sh        # Full provisioning menu
./simple_menu.sh         # Simplified menu
./post_install_menu.sh   # Post-deployment management
./client_setup.sh        # NFS client configuration (run from client_repo/)
```

### Test Design
```bash
# Manual: invoke /test-designer in Claude Code conversation
# Automated: triggers on PR via .github/workflows/test-designer.yml
# Publish manually: node scripts/tq-publish.mjs --input <json> [--pr <num>] [--dry-run]
```

### Configuration Editors
```bash
./configure_network.sh      # Edit netplan template
./configure_raid.sh         # Edit RAID/XFS configuration
./configure_nfs_exports.sh  # Edit NFS exports
./configure_hostname.sh     # Set hostname
./collect_data.sh           # Gather system info and upload
```

## Architecture

```
User → Interactive Menu Scripts → Preset/Config Files → Ansible Playbooks → System
```

### Layer Structure

1. **Interactive Layer** - Bash scripts with whiptail TUI (`startup_menu.sh`, `configure_*.sh`)
2. **Configuration Layer** - YAML presets in `/presets/{default,xinnorVM}/`
3. **Orchestration Layer** - Ansible playbooks in `/playbooks/`
4. **Implementation Layer** - Ansible roles in `/collection/roles/`

### Playbook Execution Order (site.yml)
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace → raid_fs → exports → nfs_server → perf_tuning

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `playbooks/` | Ansible playbooks (site.yml, common.yml, doca_ofed_install.yml) |
| `collection/roles/` | 10 Ansible roles (common, doca_ofed, xiraid_classic, nvme_namespace, raid_fs, exports, nfs_server, perf_tuning, net_controllers, xiraid_exporter) |
| `presets/` | Deployment profiles with role configs and templates |
| `inventories/` | Ansible inventory (default: localhost) |
| `client_repo/` | Standalone NFS client package |

### Preset Structure
Each preset directory (`presets/default/`, `presets/xinnorVM/`) contains:
- `playbook.yml` - Role execution order and preset-specific variables
- `raid_fs.yml` - RAID array and XFS filesystem definitions
- `nfs_exports.yml` - NFS export rules
- `netplan.yaml.j2` - Network interface template

## Important Notes

- **No build/test system** - This is infrastructure-as-code; validation occurs through Ansible modules
- **yq v4 required** - Shell scripts use mikefarah/yq (not the Python jq wrapper). Ensure `/usr/local/bin/yq` is in PATH
- **Roles are idempotent** - Safe to re-run, except `xfs_force_mkfs: true` forces filesystem recreation
- **License stored at `/tmp/license`** - Cleared on reboot; enter via menu before deployment
- **DOCA-OFED version** - Configured in `collection/roles/doca_ofed/defaults/main.yml` (`doca_ofed_version` variable)

## Automatic NVMe Namespace Management

The `nvme_namespace` role provides automatic device discovery and namespace configuration:

1. Detects system drive (root/boot/EFI partitions) and excludes it
2. Enumerates all other NVMe controllers as data drives
3. Rebuilds namespaces on data drives:
   - n1: Small namespace (500MB default) for XFS log device
   - n2: Large namespace (remaining capacity) for data
4. Generates `xiraid_arrays` and `xfs_filesystems` facts for `raid_fs` role:
   - RAID 10 from small namespaces (log array)
   - RAID 5 from large namespaces (data array)

Enable/disable via `nvme_auto_namespace: true/false` in `collection/roles/nvme_namespace/defaults/main.yml` or use the "Auto-Detect" option in `configure_raid.sh`.

## Variable Priority

1. CLI/inventory variables (highest)
2. Preset YAML files (loaded by menu scripts)
3. Role `defaults/main.yml` (lowest)

## Role Documentation

Each role has its own README at `collection/roles/<role>/README.md` with configuration options and examples.
