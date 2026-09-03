# xiNAS

Ansible-based provisioning and management framework for high-performance NAS storage nodes powered by [Xinnor xiRAID](https://xinnor.io) with NVIDIA DOCA-OFED networking and NFS-RDMA exports.

**Target Platform:** Ubuntu 22.04 / 24.04 LTS

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  User Interfaces                                         │
│  • xinas-menu (Python Textual TUI) — server console      │
│  • xinasctl (CLI) + MCP clients — control path           │
│  • xinas-client — NFS client setup and management        │
│  • install.sh — one-command provisioning                 │
├──────────────────────────────────────────────────────────┤
│  Configuration & History                                 │
│  • presets/ (YAML deployment profiles)                   │
│  • xinas_history/ (snapshot engine, rollback)            │
├──────────────────────────────────────────────────────────┤
│  Ansible Orchestration                                   │
│  • playbooks/ (site.yml, common.yml, doca_ofed_install)  │
│  • collection/roles/ (20 roles)                          │
├──────────────────────────────────────────────────────────┤
│  Runtime Services                                        │
│  • xinas-api (REST /api/v1 + MCP /mcp endpoint)          │
│  • xinas-agent (privileged observe/execute daemon)       │
│  • xinas-nfs-helper (NFS export daemon)                  │
│  • xiraid-server (gRPC :6066)                            │
│  • NFS v4.2 + RDMA                                       │
└──────────────────────────────────────────────────────────┘
```

## Getting Started

### Server Installation

Run on the target NAS server as root:

```bash
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo bash
```

xiNAS installs and updates **only from published GitHub Releases** — never from the `main` branch (see [docs/Installer/update-spec.md](docs/Installer/update-spec.md)). The installer resolves the latest release tag, installs all dependencies (Ansible, yq, git), checks that release out to `/opt/xiNAS`, and launches the provisioning menu. The menu walks you through:

1. **Collect system data** — gather hardware info and generate a hardware key
2. **Enter license** — send the hardware key to `support@xinnor.io`, then enter the received license
3. **Install** — choose a profile (Full NVMe / VM / Existing RAID) and deploy

Behind a shared public address (a lab, an office NAT, a fleet of clients) GitHub's per-IP limit on anonymous requests can refuse the clone with a `401` or the release lookup with a `403`. Hand the installer a GitHub token — a fine-grained personal access token with no permissions is enough — and it keeps it in `/etc/xinas/github-token` (mode `0600`) for the update checks that follow. Pass it by name, not as `sudo XINAS_GH_TOKEN=… bash` (that would put the value in `ps` and in sudo's log):

```bash
read -rs XINAS_GH_TOKEN && export XINAS_GH_TOKEN
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo --preserve-env=XINAS_GH_TOKEN bash
```

Ansible runs the `site.yml` playbook, executing all configured roles in order:

```
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace
→ raid_fs → exports → nfs_server → xinas_node_build → xinas_api
→ xinas_agent → xinas_nfs_helper → xinas_mcp → xinas_menu
→ xinas_history → perf_tuning → motd
```

### Unattended Installation

For scripted provisioning (kickstart, cloud-init, golden images, fleet rollout), xiNAS supports a fully non-interactive install path. Place the xiRAID license at `/tmp/license` (or pass `--license-file`), set `XINAS_UNATTENDED=1`, and choose a preset:

```bash
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh \
  | sudo XINAS_UNATTENDED=1 XINAS_PRESET=default bash
```

If the repository is already on the host, run the provisioning engine directly:

```bash
sudo ./autoinstall.sh --preset xinnorVM --license-file /root/node.lic
```

Configuration can also come from an answer file (`/etc/xinas/autoinstall.conf`). `--dry-run` validates the configuration without touching the system. See [docs/Installer/spec.md](docs/Installer/spec.md) §7 for the full contract — config keys, the license file, and exit codes.

### Client Installation

Run on each NFS client machine as root:

```bash
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install_client.sh | sudo bash
```

This installs NFS tools and RDMA prerequisites, checks out the client package at the latest release tag, and registers the `xinas-client` command. The client setup wizard launches automatically. Run it again any time:

```bash
sudo xinas-client
```

The same two lines work here — `install_client.sh` keeps the token for `xinas-client` the same way; clients on one NAT share GitHub's anonymous quota just like servers do.

The client contract lives in [docs/Client/client-setup-spec.md](docs/Client/client-setup-spec.md).

### Post-Deployment Management

After installation, the server management console is always available:

```bash
sudo xinas-menu
```

The TUI groups every day-2 operation under four menus:

- **System** — status, license, user management, health checks, quick actions, configuration history, log collection
- **Storage** — RAID management, NFS management, physical drives, filesystems, spare pools
- **Network** — current configuration, interface IP editing, netplan file, IP pool configuration
- **Management** — settings, integrations (e.g. xiRAID Prometheus exporter), update check, uninstall

See [install.MD](install.MD) for the full installation guide, settings reference, and troubleshooting.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `playbooks/` | Ansible playbooks (`site.yml`, `common.yml`, `doca_ofed_install.yml`, `uninstall.yml`) |
| `collection/roles/` | 20 Ansible roles |
| `presets/` | Deployment profiles (`default/`, `xinnorVM/`) |
| `xinas_menu/` | Python Textual TUI — post-deployment management console + health engine |
| `xinas_history/` | Configuration history engine (snapshots, rollback, drift detection) |
| `xiNAS-MCP/` | TypeScript control path — `xinas-api` (REST + `/mcp`), `xinas-agent`, `xinasctl` CLI, `xinas-mcp-stdio` (Node ≥ 20) |
| `client_repo/` | Standalone NFS client package |
| `inventories/` | Ansible inventory (default: localhost) |
| `tests/` | pytest suite — TUI screens, installer bash contracts, Ansible template rendering |
| `docs/` | Design documents and specs (`Installer/`, `Storage/`, `Management/`, `Network/`, `Client/`, `Notifications/`, `HealthCheck/`, `control-path/`, `config-history/`, `plans/`, `troubleshooting/`, …) |

## Ansible Roles

Deployed by `site.yml`, in execution order:

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
| `xinas_node_build` | Node 20 toolchain + `xiNAS-MCP` TypeScript build (`dist/`) |
| `xinas_api` | `xinas-api.service` — REST `/api/v1` and the MCP `/mcp` endpoint |
| `xinas_agent` | `xinas-agent.service` — privileged observation and execution daemon |
| `xinas_nfs_helper` | `xinas-nfs-helper` daemon (UDS at `/run/xinas-nfs-helper.sock`) |
| `xinas_mcp` | Retirement shim (ADR-0010) — removes the legacy standalone MCP service, installs the `xinas-mcp-stdio` and `xinasctl` wrappers |
| `xinas_menu` | Deploy the Python/Textual console and its `xinas-menu` / `xinas-setup` wrappers |
| `xinas_history` | Deploy configuration history library and CLI |
| `perf_tuning` | TCP window scaling, NFS read-ahead, CPU governor |
| `motd` | Status banner with RAID/NFS/network info |

Run on demand, outside `site.yml`:

| Role | Purpose |
|------|---------|
| `roce_lossless` | RoCE / InfiniBand lossless transport configuration |
| `xiraid_exporter` | Prometheus metrics exporter for xiRAID |
| `xinas_uninstall` | Reverses everything `site.yml` installs (`playbooks/uninstall.yml`) |

Each role has its own README at `collection/roles/<role>/README.md`.

## Presets

Deployment profiles live in `presets/` (currently `default/` and `xinnorVM/`). Each preset contains:

- `playbook.yml` — role execution order and preset-specific variables
- `raid_fs.yml` — RAID levels, stripe size, spare pool configuration
- `nfs_exports.yml` — NFS export paths and access control
- `network.yml` — IP pool ranges, MTU, interface detection
- `nvme_namespace.yml` — namespace layout overrides (`xinnorVM` only)

The netplan template itself is owned by the `net_controllers` role
(`collection/roles/net_controllers/templates/netplan.yaml.j2`) and rendered
from the preset's `network.yml`.

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

## Control Path (REST · CLI · MCP)

`xiNAS-MCP/` is the TypeScript control path. A single declarative catalog
(`src/api/mcp/catalog.ts`, 62 operations) drives three clients at once — the
REST router under `/api/v1`, the generated `xinasctl` command tree, and the MCP
`tools/list` dispatcher — so the three surfaces cannot drift apart.

The standalone MCP server was retired in favour of an endpoint inside
`xinas-api.service` (ADR-0010): the Streamable HTTP `/mcp` route plus the
`xinas-mcp-stdio` adapter used by Claude Code and other MCP clients. **61** of
the 62 catalog operations are exposed as MCP tools (the binary support-bundle
download is CLI-only), across 23 namespaces:

`system` · `arrays` · `pools` · `disks` · `filesystems` · `shares` ·
`export_groups` · `service_ips` · `network` · `users` · `groups` · `quotas` ·
`nfs_profiles` · `nfs_idmap` · `nfs_sessions` · `health` · `drift` · `tasks` ·
`config_history` · `audit` · `mail` · `auth` · `support`

Mutations use a plan/apply contract (`mode: plan` returns a diff, `mode: apply`
executes it against an expected `state_revision`), guarded by per-operation RBAC
(`viewer` / `operator` / `admin`), idempotency keys, and audit logging. MCP
`mode=apply` is additionally gated by `mcp.allow_apply` in
`/etc/xinas-api/config.json` — **off by default**.

Contracts: [docs/control-path/adr/0010-clients-mcp-cli-tui.md](docs/control-path/adr/0010-clients-mcp-cli-tui.md),
[docs/control-path/s8-clients-spec.md](docs/control-path/s8-clients-spec.md),
and the OpenAPI schema [docs/control-path/api-v1.yaml](docs/control-path/api-v1.yaml).
The spec set under `docs/MCP/` describes the retired standalone server and is
kept for reference only.

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

- **Two shell surfaces, two rules** — the installer scripts (`prepare_system.sh`, `startup_menu.sh`, `simple_menu.sh`) run before the Python TUI exists and remain the supported install path. The post-install scripts (`post_install_menu.sh`, `configure_*.sh`) are deprecated: all new day-2 features go into the Python TUI (`xinas_menu/`)
- **yq v4 required** — shell scripts use [mikefarah/yq](https://github.com/mikefarah/yq), not the Python jq wrapper. Ensure `/usr/local/bin/yq` is in PATH. Re-run `prepare_system.sh` if needed
- **Roles are idempotent** — re-running `site.yml` over a healthy array converges (no reformat, no namespace rebuild). Destroying and rebuilding storage requires the explicit `xinas_storage_reset: true` plus an interactive `YES`; the legacy `xfs_force_mkfs` / `nvme_use_existing_namespaces` knobs no longer trigger wipes on their own. See [docs/Installer/raid-spec.md](docs/Installer/raid-spec.md) §11
- **License** — stored at `/tmp/license` (cleared on reboot); enter via menu before deployment
- **Netplan ownership** — all InfiniBand interface config must live in `/etc/netplan/99-xinas.yaml` only. See [docs/Network/spec-network-management.md](docs/Network/spec-network-management.md) for details
- **Updates ship through GitHub Releases only** — the TUI update check compares the installed version against the latest published release tag; drafts and prereleases are excluded and there is no branch fallback. See [docs/Installer/update-spec.md](docs/Installer/update-spec.md)
- **Variable priority** — CLI/inventory (highest) → preset YAML → role `defaults/main.yml` (lowest)

## License

xiNAS is released under the [MIT License](LICENSE). Note that this covers the
xiNAS provisioning and management code only — Xinnor xiRAID and NVIDIA
DOCA-OFED are third-party products that ship under their own licenses, and
xiRAID still requires the per-node license key described above.
