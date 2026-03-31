# xiNAS

Ansible-based provisioning and management framework for high-performance NAS storage nodes powered by [Xinnor xiRAID](https://xinnor.io) with NVIDIA DOCA-OFED networking and NFS-RDMA exports.

**Target Platform:** Ubuntu 22.04 / 24.04 LTS

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  User Interfaces                                         │
│  • xinas-menu (Python Textual TUI) — server management   │
│  • xinas-client — NFS client setup and management         │
│  • install.sh — one-command provisioning                  │
├──────────────────────────────────────────────────────────┤
│  Configuration & History                                 │
│  • presets/ (YAML deployment profiles)                   │
│  • xinas_history/ (snapshot engine, rollback)            │
├──────────────────────────────────────────────────────────┤
│  Ansible Orchestration                                   │
│  • playbooks/ (site.yml, common.yml, doca_ofed_install)  │
│  • collection/roles/ (15 roles)                          │
├──────────────────────────────────────────────────────────┤
│  Runtime Services                                        │
│  • xiraid-server (gRPC :6066)                            │
│  • xinas-nfs-helper (NFS export daemon)                  │
│  • xinas-mcp (MCP server for AI-assisted management)     │
│  • NFS v4.2 + RDMA                                       │
└──────────────────────────────────────────────────────────┘
```

## Getting Started

### Server Installation

Run on the target NAS server as root:

```bash
curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install.sh | sudo bash
```

This installs all dependencies (Ansible, yq, git), clones the repository to `/opt/xiNAS`, and launches the provisioning menu. The menu walks you through:

1. **Collect system data** — gather hardware info and generate a hardware key
2. **Enter license** — send the hardware key to `support@xinnor.io`, then enter the received license
3. **Install** — choose a profile (Full NVMe / VM / Existing RAID) and deploy

Ansible runs the `site.yml` playbook, executing all configured roles in order:

```
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace
→ raid_fs → exports → nfs_server → xinas_history → perf_tuning → motd
```

### Client Installation

Run on each NFS client machine as root:

```bash
curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install_client.sh | sudo bash
```

This installs NFS tools and RDMA prerequisites, clones the client package, and registers the `xinas-client` command. The client setup wizard launches automatically. Run it again any time:

```bash
sudo xinas-client
```

### Post-Deployment Management

After installation, the server management console is always available:

```bash
sudo xinas-menu
```

The TUI provides:

- **Storage** — RAID arrays (create, modify, spare pools), XFS filesystems, quota management
- **Network** — IP pool configuration, interface management, netplan
- **Shares** — NFS export CRUD, access control wizard
- **Users** — User and group management, quotas
- **Health** — Health check profiles, monitoring, alerts
- **Config History** — Browse snapshots, diff versions, rollback

See [install.MD](install.MD) for the full installation guide, settings reference, and troubleshooting.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `playbooks/` | Ansible playbooks (`site.yml`, `common.yml`, `doca_ofed_install.yml`) |
| `collection/roles/` | 15 Ansible roles |
| `presets/` | Deployment profiles (`default/`, `xinnorVM/`) |
| `xinas_menu/` | Python Textual TUI — post-deployment management console |
| `xinas_history/` | Configuration history engine (snapshots, rollback, drift detection) |
| `xiNAS-MCP/` | MCP server for AI-assisted management (55 tools) |
| `client_repo/` | Standalone NFS client package |
| `inventories/` | Ansible inventory (default: localhost) |
| `specs/` | Architecture specifications |
| `docs/` | Design documents and plans |

## Ansible Roles

| Role | Purpose |
|------|---------|
| `common` | Baseline packages, sysctl tuning, chrony NTP |
| `doca_ofed` | NVIDIA DOCA-OFED installation and kernel modules |
| `net_controllers` | InfiniBand interface config (netplan, IP pools, PBR) |
| `xiraid_classic` | xiRAID package installation and EULA acceptance |
| `nvme_namespace` | Auto-detect NVMe drives, create namespaces for xiRAID |
| `raid_fs` | Create RAID arrays, XFS filesystems, systemd mounts |
| `exports` | Manage `/etc/exports` via Jinja2 templates |
| `nfs_server` | Kernel NFS v4.2 with RDMA tuning |
| `xinas_history` | Deploy configuration history library and CLI |
| `xinas_menu` | Deploy TUI application as a systemd service |
| `xinas_mcp` | Deploy MCP server (Node.js) |
| `perf_tuning` | TCP window scaling, NFS read-ahead, CPU governor |
| `motd` | Status banner with RAID/NFS/network info |
| `roce_lossless` | RoCE lossless network configuration (on-demand) |
| `xiraid_exporter` | Prometheus metrics exporter for xiRAID |

Each role has its own README at `collection/roles/<role>/README.md`.

## Presets

Deployment profiles live in `presets/` (currently `default/` and `xinnorVM/`). Each preset contains:

- `playbook.yml` — role execution order and preset-specific variables
- `raid_fs.yml` — RAID levels, stripe size, spare pool configuration
- `nfs_exports.yml` — NFS export paths and access control
- `netplan.yaml.j2` — network interface template
- `network.yml` — IP pool ranges, MTU, interface detection

Custom presets created through the expert menu are saved here and available across all menus.

## Configuration History

The `xinas_history/` package provides transactional configuration tracking:

- **Snapshots** capture config files and runtime state (RAID, mounts, exports, services) before and after changes
- **Rollback** classifies changes by risk level: `destroying_data` > `changing_access` > `non_disruptive`
- **Drift detection** compares checksums of `/etc/exports`, `/etc/nfs.conf`, and netplan against the last applied snapshot
- **Transactional runner** executes changes in an 8-step sequence: lock → preflight → snapshot → execute → validate → mark → auto-rollback on failure → release

```bash
python3 -m xinas_history snapshot list          # List snapshots
python3 -m xinas_history snapshot show <id>     # Show snapshot details
python3 -m xinas_history snapshot diff <a> <b>  # Compare two snapshots
python3 -m xinas_history status                 # Current status (JSON)
python3 -m xinas_history gc run                 # Garbage collect old snapshots
```

## MCP Server

The `xiNAS-MCP/` directory contains a Model Context Protocol server that exposes xiNAS operations to Claude and compatible AI agents. It provides 55 tools across 9 namespaces:

`system` · `health` · `disk` · `raid` · `share` · `auth` · `job` · `config` · `mail`

Features include RBAC permissions, audit logging, idempotency guarantees, and plan/apply workflows. See `xiNAS-MCP/REQUIREMENTS.md` for the full specification.

## Data Collection

Gather system information into a tar archive and upload it for support:

```bash
./collect_data.sh
```

The upload server is configured automatically. Override with:

```bash
export TRANSFER_SERVER="http://your-server:8080"
./collect_data.sh
```

## Important Notes

- **Shell menu scripts are deprecated** — `startup_menu.sh`, `post_install_menu.sh`, `configure_*.sh`, and `simple_menu.sh` still work but all new features must be implemented in the Python TUI (`xinas_menu/`)
- **yq v4 required** — shell scripts use [mikefarah/yq](https://github.com/mikefarah/yq), not the Python jq wrapper. Ensure `/usr/local/bin/yq` is in PATH. Re-run `prepare_system.sh` if needed
- **Roles are idempotent** — safe to re-run, except when `xfs_force_mkfs: true` forces filesystem recreation
- **License** — stored at `/tmp/license` (cleared on reboot); enter via menu before deployment
- **Netplan ownership** — all InfiniBand interface config must live in `/etc/netplan/99-xinas.yaml` only. See `specs/spec-network-management.md` for details
- **Variable priority** — CLI/inventory (highest) → preset YAML → role `defaults/main.yml` (lowest)
