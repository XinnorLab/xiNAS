# nvme_namespace

Automatically detects non-system NVMe drives, rebuilds namespaces, and generates RAID configuration for the `raid_fs` role.

## Overview

This role implements the Default Storage Namespace and RAID Specification:

1. **Detects system drives** - Identifies the OS drive by detecting root, boot, and EFI partitions
2. **Enumerates data drives** - All NVMe controllers not hosting system partitions
3. **Rebuilds namespaces** - Deletes existing namespaces and creates:
   - Small namespace (n1): 500MB for XFS log device
   - Large namespace (n2): Remaining capacity for data
4. **Generates RAID config** - Creates `xiraid_arrays` and `xfs_filesystems` facts for `raid_fs` role:
   - RAID 10 from small namespaces (log array)
   - RAID 5 from large namespaces (data array)

## Requirements

- `nvme-cli` package must be installed
- NVMe drives must support namespace management (most enterprise NVMe do)
- Sufficient drives for requested RAID levels (minimum 3 for RAID 5, 4 for RAID 10)

## Role Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `nvme_auto_namespace` | `true` | Enable/disable automatic namespace management |
| `nvme_small_ns_size_mb` | `500` | Size of small namespace in MB |
| `nvme_raid_data_level` | `5` | RAID level for data array (large namespaces) |
| `nvme_raid_log_level` | `10` | RAID level for log array (small namespaces) |
| `nvme_raid_data_strip_kb` | `128` | Strip size for data array in KB |
| `nvme_raid_log_strip_kb` | `16` | Strip size for log array in KB |
| `nvme_abort_if_no_system_drive` | `true` | Abort if system drive cannot be detected |
| `nvme_skip_failed_devices` | `true` | Continue if individual device fails |
| `nvme_min_devices_for_raid5` | `3` | Minimum devices for RAID 5 |
| `nvme_min_devices_for_raid10` | `4` | Minimum devices for RAID 10 |

## Dependencies

This role must run **before** the `raid_fs` role and **after** `xiraid_classic`.

## Example Playbook

```yaml
- hosts: storage_nodes
  roles:
    - role: xiraid_classic
    - role: nvme_namespace
      vars:
        nvme_auto_namespace: true
        nvme_small_ns_size_mb: 500
        nvme_raid_data_level: 5
        nvme_raid_log_level: 10
    - role: raid_fs
```

## Disabling Auto-Detection

To use manual RAID configuration instead:

```yaml
- role: nvme_namespace
  vars:
    nvme_auto_namespace: false
```

When disabled, the role does nothing and `raid_fs` uses its default or preset configuration.

## System Drive Detection

The role identifies system drives using multiple methods:

1. **Root filesystem** - Device containing `/` mount
2. **Boot partition** - Device containing `/boot` mount (if separate)
3. **EFI partition** - Device with EFI System Partition GUID

All NVMe controllers hosting these partitions are excluded from namespace operations.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| System drive not detected | Aborts (configurable) |
| Namespace deletion fails | Skips device, continues (configurable) |
| Namespace creation fails | Skips device, logs failure |
| Insufficient devices for RAID | Fails with error message |
| nvme-cli not installed | Fails with installation instructions |

## Output Facts

The role sets these facts for the `raid_fs` role:

- `xiraid_arrays` - Array definitions for xiRAID
- `xfs_filesystems` - XFS filesystem definitions

## Storage-reset safety

A read-only preflight (`detect_storage_state.yml`) classifies the box as
`xinas_storage_state` ∈ {MATCH, EMPTY, FOREIGN}. On **MATCH** (an existing healthy xiNAS
array) a re-run **converges** — namespaces are reused, nothing is destroyed. Namespaces are
deleted and recreated only on a fresh box (**EMPTY**) or when the operator sets
`xinas_storage_reset: true` (guarded by an interactive `YES`, bypassable for automation
with `nvme_skip_cleanup_confirmation: true`). A **FOREIGN** layout fails fast rather than
being wiped. The legacy `nvme_use_existing_namespaces` knob is deprecated. See
[docs/Installer/raid-spec.md](../../../docs/Installer/raid-spec.md) §11.

## Warning

**With `xinas_storage_reset: true`, this role DESTROYS ALL DATA on non-system NVMe drives.**

In that case all existing namespaces on data drives are deleted and recreated. Ensure you have backups.
