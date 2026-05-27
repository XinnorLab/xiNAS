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
./uninstall.sh                                   # Remove xiNAS (interactive)
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
# Publish manually: node scripts/tq-publish.mjs --input <json> [--pr <num>] [--dry-run]
```
(The automated PR-time workflow was removed in the Phase 0 CI bootstrap;
the skill and publisher script remain for manual invocation.)

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
| `xinas_history/` | Configuration history & rollback library (Python) — snapshots, drift detection, transactional runner |
| `docs/` | Design docs and specs, organized by area: `Installer/`, `Storage/`, `MCP/`, `Network/`, `Notifications/`, `HealthCheck/`, `config-history/`, `control-path/`, `healthcheck-tunables/`, `troubleshooting/`, `plans/` |

### Specs and design docs (`docs/`)

All design specs live under `docs/` in topic subfolders. There is no flat
spec dump — every doc belongs to an area.

| Subfolder | What goes here |
|-----------|----------------|
| `docs/Installer/` | Install-time / Ansible-driven behavior: `spec.md` (preset + playbook + role map), `network-spec.md`, `raid-spec.md`, `fs-exports-spec.md`, `uninstall-spec.md` (uninstaller contract) |
| `docs/Storage/` | Day-2 storage management surface (TUI screens, helpers, gRPC): `raid-management-spec.md`, `fs-shares-management-spec.md` |
| `docs/MCP/` | MCP server spec set: `REQUIREMENTS.md`, `spec-core.md`, `spec-tools.md`, `spec-middleware.md`, `spec-config-history.md`, `spec-mail.md`, `spec-nfs-helper.md`, `spec-os.md`, `spec-server.md`, `modules.md` |
| `docs/Network/` | Cross-cutting network management (netplan ownership, PBR, day-2 IP edits): `spec-network-management.md` |
| `docs/Notifications/` | Email / alerting pipelines (xiNAS SMTP + xiRAID sendmail): `spec-email-notifications.md` |
| `docs/HealthCheck/` | Individual health-check designs (one file per check, e.g. `pcie-link-check.md`) |
| `docs/config-history/` | `xinas_history` library design (`requirements.md`, `architecture.md`, `specs.md`, `grpc-api-reference.md`) |
| `docs/control-path/` | Phase 0 Control Path foundation: `phase0-requirements.md` (live contract) and `adr/` (architecture decision records — `0001-api-surface.md`, …). The companion implementation plan lives at `docs/plans/2026-05-26-phase0-control-path-plan.md`. ADRs supersede earlier plan/spec language where they conflict |
| `docs/healthcheck-tunables/` | Reference docs for tunable parameters (sysctl, filesystem, perf) |
| `docs/troubleshooting/` | Postmortems / known-issue writeups (one file per incident) |
| `docs/plans/` | Dated implementation plans (`YYYY-MM-DD-<topic>-plan.md`, `-design.md`). Append-only history of intent — do **not** edit landed plans to reflect later changes; the live spec in the topic subfolder is the source of truth |

#### Spec-first rule

**Before writing code for any new function, screen, role, tool, or
behavior change, the matching spec must exist and reflect the intended
end state.**

1. Locate the spec that owns the area (use the table above). If a doc
   already covers it, **update the spec first** — change the behavior
   description, add the new section, adjust the table, whatever the
   change requires — and only then write the code.
2. If no spec covers the area, **create one in the right subfolder**
   before coding. Pick the filename in the style already used in that
   subfolder (`<area>-spec.md`, `spec-<topic>.md`, etc.). If the work
   doesn't fit any existing subfolder, create a new top-level area
   under `docs/` (with a clear noun name like `Installer/`, `Storage/`)
   rather than dropping the file flat into `docs/`.
3. Keep the spec and the code in sync in the same change. A PR that
   ships code without the matching spec update is incomplete; reviewers
   should bounce it back.
4. `docs/plans/` is for execution plans (sequenced work, milestones,
   rollout), not for the durable behavior contract. Plans reference the
   spec; the spec is what survives.

The only exemptions are trivial code-only fixes that don't change
externally observable behavior (typos, refactors, log-message tweaks,
test-only changes). When in doubt, write the spec.

### Configuration History (`xinas_history/`)

Python library providing snapshot-based configuration tracking and rollback for xiNAS:

- **Snapshots**: Captures config files + runtime state (RAID, mounts, exports, services) before/after changes
- **Rollback classification**: Three risk levels — `destroying_data` > `changing_access` > `non_disruptive`
- **Transactional runner**: 8-step sequence (lock → preflight → snapshot → execute → validate → mark → auto-rollback → release)
- **Drift detection**: Checksum comparison of `/etc/exports`, `/etc/nfs.conf`, netplan against last applied snapshot
- **Store**: `/var/lib/xinas/config-history/` with atomic writes, `baseline/` + `snapshots/{id}/`
- **CLI**: `python3 -m xinas_history snapshot list|show|create|diff`, `gc run`, `status` (JSON output for MCP bridge)
- **Consumers**: Textual TUI screens (`xinas_menu/screens/config_history.py`, `snapshot_detail.py`), MCP tools (`config.*`), installer hooks
- **Deployment**: Ansible role `collection/roles/xinas_history/` — copies package, installs PyYAML, creates CLI wrapper

### MCP Server Documentation

MCP (Model Context Protocol) server specification and design docs live under `docs/MCP/`. Server source remains in `xiNAS-MCP/`.

| File | Purpose |
|------|---------|
| `docs/MCP/REQUIREMENTS.md` | Functional requirements — 9 tool namespaces (system, network, health, disk, RAID, share, auth, job, config) |
| `docs/MCP/spec-tools.md` | Tool summary table (55 tools), preflight logic, health profiles, error scenarios |
| `docs/MCP/spec-middleware.md` | RBAC permission matrix, audit logging, locking, idempotency, plan/apply |
| `docs/MCP/spec-config-history.md` | Config-history tools spec (6 tools), subprocess protocol for `xinas_history` backend |
| `docs/MCP/spec-core.md` | Core server architecture, transport, error model |
| `docs/MCP/modules.md` | Module map, dependency graph, file count summary (42 files) |

### Preset Structure
Each preset directory (`presets/default/`, `presets/xinnorVM/`) contains:
- `playbook.yml` - Role execution order and preset-specific variables
- `raid_fs.yml` - RAID array and XFS filesystem definitions
- `nfs_exports.yml` - NFS export rules
- `netplan.yaml.j2` - Network interface template

## Update rebuild markers (`Requires-Rebuild:` trailer)

The in-TUI update flow (`u` shortcut, Management → Check for Updates, MCP/Advanced "Check for Updates") does `git pull` + service restart by default. It does **not** re-run Ansible unless the incoming commits opt in.

If a commit changes anything that requires an Ansible role to re-run on the host to take effect (systemd unit files, package installs, sysctl/perf tuning, kernel module config, NFS server flags, RAID layout, network config that needs `net_controllers` to re-apply, etc.), **add a Git trailer to the commit message**:

```
Requires-Rebuild: <ansible_tag>[, <ansible_tag>...]
```

- `<ansible_tag>` is a tag accepted by `ansible-playbook playbooks/site.yml --tags <tag>` — usually the role name (`nfs_server`, `perf_tuning`, `net_controllers`, `xinas_mcp`, `xinas_menu`, …).
- Comma-separate multiple tags. Multiple trailers across multiple commits are aggregated by the TUI.
- The special value `all` means run the full `site.yml` with no `--tags` filter; use it only when the change spans many roles.
- **Do not add this trailer for code-only changes** (Python TUI logic, MCP server Python code, docs, plan/spec updates, test fixtures). The plain `git pull` + `xinas-nfs-helper` restart that already runs on every update is sufficient — adding a trailer here just trains users to click past an unnecessary Ansible warning.
- Parsed case-insensitively, and only from commits in `local..origin/main` — backfilling old commits has no effect.

Examples:

```
fix(nfs_server): bump RPC thread count to 64

Requires-Rebuild: nfs_server
```

```
feat(net): add lossless RoCE tuning

Requires-Rebuild: net_controllers, perf_tuning
```

```
chore: re-template every role after defaults overhaul

Requires-Rebuild: all
```

Runtime behaviour of the update flow:
1. When a rebuild is required, the confirm dialog names the role(s) that will run before the user accepts.
2. When no trailer is present, the Ansible step is skipped entirely — no extra prompt.
3. If the playbook fails, the new code stays in place, the menu is **not** auto-restarted, and the user is told to review the log.

Parser + orchestration live in [xinas_menu/utils/update_check.py](xinas_menu/utils/update_check.py) (`parse_rebuild_trailers`, `build_rebuild_cmd`); both `XiNASApp` and `StartupApp` consume it via `prompt_and_apply_update(result)` / `_apply_update(result)`.

## Important Notes

- **Shell vs. Python TUI scope** — There are two distinct user surfaces. Treat them differently:
  - **Installer / bootstrap (bash, still active):** `prepare_system.sh`, `startup_menu.sh`, `simple_menu.sh`, and the shared `lib/menu_lib.sh`. These run before the Python TUI is installed and remain the supported install path. Bug fixes, polish, and improvements to the install flow itself are welcome here.
  - **Post-install management (Python only):** `post_install_menu.sh`, `configure_*.sh`, and any other day-2 management/configuration UI. These are deprecated. Do NOT add new features, settings screens, or configuration UIs to these shell scripts — implement them in the Python-based `xinas_menu/` package (Textual TUI) instead.
  - When a feature touches both surfaces (e.g. how `ansible-playbook` output is presented during install), it is acceptable — and expected — to update both the bash installer side and the Python TUI side so they stay in feel-parity.
- **No build/test system** - This is infrastructure-as-code; validation occurs through Ansible modules
- **yq v4 required** - Shell scripts use mikefarah/yq (not the Python jq wrapper). Ensure `/usr/local/bin/yq` is in PATH
- **Roles are idempotent** - Safe to re-run, except `xfs_force_mkfs: true` forces filesystem recreation
- **License stored at `/tmp/license`** - Cleared on reboot; enter via menu before deployment
- **DOCA-OFED version** - Configured in `collection/roles/doca_ofed/defaults/main.yml` (`doca_ofed_version` variable)
- **Netplan file ownership** - All IB interface config MUST live in `/etc/netplan/99-xinas.yaml` only. Netplan merges all `*.yaml` files in `/etc/netplan/`, so duplicate interface definitions in other files (e.g. `50-cloud-init.yaml`) cause phantom IPs and conflicting PBR tables. Both TUI and Ansible auto-clean IB entries from non-xinas files. See `docs/Network/spec-network-management.md` for full details.
- **Netplan apply limitations** - `netplan apply` does NOT remove old IPs or PBR rules. The `net_controllers` role and TUI "Apply Network Changes" always flush PBR tables 100-199 and all IPs from mlx interfaces before applying. See apply sequence in `docs/Network/spec-network-management.md`.

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
