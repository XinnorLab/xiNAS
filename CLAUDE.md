# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

xiNAS is an Ansible-based provisioning framework for high-performance NAS storage nodes. Bash/whiptail menus drive the install; a Python/Textual TUI (`xinas_menu/`) and a TypeScript control path (`xiNAS-MCP/`) drive day-2 management. Deploys Xinnor xiRAID storage with NVIDIA DOCA-OFED networking and NFS-RDMA exports.

**Target Platform:** Ubuntu 22.04/24.04 LTS

## Language

**All repository artifacts are written in English, regardless of the
language used in the working session.** Binding for documentation, code
comments and docstrings, commit messages, branch names, tags, PR titles
and bodies, and issue text. A conversation may happen in any language;
anything committed to the repository must be in English.

## Key Commands

### Verification

Run these before proposing a change is done — each mirrors a blocking CI
job in `.github/workflows/ci.yml`. The path arguments matter: they are
repeated verbatim across five jobs, and `ruff check .` does not give the
same result.

```bash
pytest                                                     # or: pytest --cov=xinas_history --cov-fail-under=20
ruff check          xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
pyright             xinas_menu xinas_history xiNAS-MCP/nfs-helper
ansible-lint collection/roles/     # needs: ansible-galaxy collection install community.general ansible.posix
yamllint -c .yamllint.yml .
npx --yes markdownlint-cli2 'docs/**/*.md'
```

TypeScript control path (from `xiNAS-MCP/`, Node ≥20):

```bash
npm run typecheck && npm run lint && npm run format:check
npm test && npm run test:contracts
```

Dev dependencies: `pip install -e '.[dev]'`.

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

### Playbook Execution Order (site.yml)
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace → raid_fs → exports →
nfs_server → xinas_node_build → xinas_api → xinas_agent → xinas_nfs_helper → xinas_mcp →
xinas_menu → xinas_history → perf_tuning → motd

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `playbooks/` | Ansible playbooks (site.yml, common.yml, doca_ofed_install.yml, uninstall.yml) |
| `collection/roles/` | 20 Ansible roles — per-role options in `collection/roles/<role>/README.md` |
| `xinas_menu/` | Python/Textual management TUI + health engine (day-2 management surface) |
| `xiNAS-MCP/` | TypeScript control path — `xinas-api` (REST + `/mcp`), `xinas-agent`, `xinasctl` CLI, `xinas-mcp-stdio`. Node ≥20, biome + vitest |
| `xinas_history/` | Configuration history & rollback library (Python) — snapshots, drift detection, transactional runner |
| `tests/` | pytest suite — TUI screens, installer bash contracts, Ansible template rendering |
| `presets/` | Deployment profiles with role configs and templates |
| `inventories/` | Ansible inventory (default: localhost) |
| `client_repo/` | Standalone NFS client package |
| `docs/` | Design docs and specs, organized by area (see table below) |

### Specs and design docs (`docs/`)

All design specs live under `docs/` in topic subfolders. There is no flat
spec dump — every doc belongs to an area.

| Subfolder | What goes here |
|-----------|----------------|
| `docs/Installer/` | Install-time / Ansible-driven behavior: `spec.md` (preset + playbook + role map), `network-spec.md`, `raid-spec.md`, `fs-exports-spec.md`, `uninstall-spec.md` (uninstaller contract), `update-spec.md` (GitHub-Releases-only install + update contract) |
| `docs/Storage/` | Day-2 storage management surface (TUI screens, helpers, gRPC): `raid-management-spec.md`, `fs-shares-management-spec.md` |
| `docs/Management/` | Day-2 System management screens: `user-management-spec.md` (User Management TUI — accounts, lock status, groups, quota), `audit-log-spec.md` (View Audit Log — merges the local TUI trail with the control-path `GET /audit` trail), `xiraid-exporter-spec.md` (Integrations → xiRAID Exporter; the package/unit name split and the unit-name resolution contract) |
| `docs/MCP/` | LEGACY MCP server spec set — reference only, superseded by ADR-0010 / `s8-clients-spec.md` |
| `docs/Network/` | Cross-cutting network management (netplan ownership, PBR, day-2 IP edits): `spec-network-management.md` |
| `docs/Notifications/` | Email / alerting pipelines (xiNAS SMTP + xiRAID sendmail): `spec-email-notifications.md` |
| `docs/HealthCheck/` | Individual health-check designs (one file per check, e.g. `pcie-link-check.md`) |
| `docs/config-history/` | `xinas_history` library design (`requirements.md`, `architecture.md`, `specs.md`, `grpc-api-reference.md`) |
| `docs/control-path/` | Control Path foundation: `phase0-requirements.md`, the `sN-*-spec.md` slice specs, `api-v1.yaml` (CI-gated, see Important Notes), and `adr/` (architecture decision records `0001`–`0017`). ADRs supersede earlier plan/spec language where they conflict |
| `docs/healthcheck-tunables/` | Reference docs for tunable parameters (sysctl, filesystem, perf) |
| `docs/troubleshooting/` | Postmortems / known-issue writeups (one file per incident) |
| `docs/plans/` | Dated implementation plans (`YYYY-MM-DD-<topic>-plan.md`, `-design.md`). Append-only history of intent — do **not** edit landed plans to reflect later changes; the live spec in the topic subfolder is the source of truth |
| `docs/superpowers/` | Dated design/plan/test artifacts from skill-driven work, split into `plans/`, `specs/`, `tests/`. Same append-only rule as `docs/plans/` |

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

Snapshot-based configuration tracking and rollback: captures config files
plus runtime state (RAID, mounts, exports, services) before and after a
change, classifies rollback risk (`destroying_data` > `changing_access` >
`non_disruptive`), and wraps changes in a transactional
lock → preflight → snapshot → execute → validate → auto-rollback → release
sequence. Store: `/var/lib/xinas/config-history/`. CLI:
`python3 -m xinas_history snapshot list|show|create|diff`, `gc run`,
`status` (JSON output). Design docs: `docs/config-history/`.

### MCP surface

**The standalone MCP server was retired (ADR-0010, S8.)** The MCP transport
now lives inside `xinas-api.service` — the `/mcp` endpoint plus the
`xinas-mcp-stdio` adapter, catalog-generated tools, apply gated by
`mcp.allow_apply`. Live contract:
`docs/control-path/adr/0010-clients-mcp-cli-tui.md` and
`docs/control-path/s8-clients-spec.md`. The spec set under `docs/MCP/`
describes the legacy server and is kept for reference only — do not treat
it as current.

### Presets

Each preset directory (`presets/default/`, `presets/xinnorVM/`) holds
`playbook.yml` (role order + preset variables), `raid_fs.yml`,
`nfs_exports.yml`, and `netplan.yaml.j2`.

## Update rebuild markers (`Requires-Rebuild:` trailer)

The in-TUI update flow (`u` shortcut, Management → Check for Updates, MCP/Advanced "Check for Updates") checks out the **latest published GitHub Release tag** and restarts the service by default (see [Release and Update Policy](#release-and-update-policy) and [docs/Installer/update-spec.md](docs/Installer/update-spec.md)). It does **not** re-run Ansible unless the incoming release opts in.

If a commit changes anything that requires an Ansible role to re-run on the host to take effect (systemd unit files, package installs, sysctl/perf tuning, kernel module config, NFS server flags, RAID layout, network config that needs `net_controllers` to re-apply, etc.), **add a Git trailer to the commit message**:

```
fix(nfs_server): bump RPC thread count to 64

Requires-Rebuild: nfs_server
```

- `<ansible_tag>` is a tag accepted by `ansible-playbook playbooks/site.yml --tags <tag>` — usually the role name (`nfs_server`, `perf_tuning`, `net_controllers`, `xinas_mcp`, `xinas_menu`, …).
- Comma-separate multiple tags (`Requires-Rebuild: net_controllers, perf_tuning`). Multiple trailers across multiple commits are aggregated by the TUI.
- The special value `all` means run the full `site.yml` with no `--tags` filter; use it only when the change spans many roles.
- **Do not add this trailer for code-only changes** (Python TUI logic, `xiNAS-MCP/nfs-helper` Python, docs, plan/spec updates, test fixtures). The plain release-tag checkout + `xinas-nfs-helper` restart that already runs on every update is sufficient — adding a trailer here just trains users to click past an unnecessary Ansible warning.
- **TypeScript under `xiNAS-MCP/src/` is the exception: it MUST carry `Requires-Rebuild: xinas_node_build`.** `xinas-api` and `xinas-agent` run compiled JavaScript from `xiNAS-MCP/dist/`, which is **not** tracked in git — a release-tag checkout updates the sources and leaves `dist/` untouched, so without the trailer the change never reaches the host at all. The `xinas_node_build` role rebuilds `dist/` *and* restarts both daemons (they read their JS once at process start), so that one tag is sufficient; it does not need to be paired with `xinas_api` / `xinas_agent`. See [docs/Installer/update-spec.md](docs/Installer/update-spec.md) §*Rebuilding dist/ restarts its consumers*.
- Parsed case-insensitively from the **release notes** (the release body aggregates the trailers from the commits it ships). Backfilling old commit messages has no effect.
- Tags are **unioned across every published release newer than the installed version**, not just the latest one — a host jumping 3.6.0 → 3.6.2 still runs the roles 3.6.1 asked for.
- The trailer must **start a line** (leading `>` blockquote markers, `*`/`_` emphasis, backticks and whitespace are tolerated and stripped). A trailer that fails to parse is indistinguishable from no trailer, so the Ansible step is silently skipped — that regression shipped in v3.6.0 and v3.6.1. Prefer a bare, column-0 line. See `docs/Installer/update-spec.md` §*Rebuild trailers*.

Runtime behaviour of the update flow:
1. When a rebuild is required, the confirm dialog names the role(s) that will run before the user accepts.
2. When no trailer is present, the Ansible step is skipped entirely — no extra prompt.
3. If the playbook fails, the new code stays in place, the menu is **not** auto-restarted, and the user is told to review the log.

Parser + orchestration live in [xinas_menu/utils/update_check.py](xinas_menu/utils/update_check.py) (`parse_rebuild_trailers`, `build_rebuild_cmd`); both `XiNASApp` and `StartupApp` consume it via `prompt_and_apply_update(result)` / `_apply_update(result)`.

## Release and Update Policy

xiNAS ships to users **only through GitHub Releases**. The full
behavioral contract lives in
[docs/Installer/update-spec.md](docs/Installer/update-spec.md); the
rules below are binding and must be preserved whenever install or
update logic changes.

- **`main`/`master` is not a delivery channel.** It is the development
  integration branch. It is never a user installation source and never
  a production update source.
- **All user installations and updates use published GitHub Releases.**
  Install one-liners pull the installer from the latest release asset
  (`https://github.com/XinnorLab/xiNAS/releases/latest/download/…`);
  installers clone/check out the latest **release tag**, never `main`.
- **Update checks look only at published GitHub Releases** via the
  Releases API (`/repos/XinnorLab/xiNAS/releases`). The installed
  version (`xinas_menu.version.XINAS_MENU_VERSION`) is compared against
  the **latest published release tag** using semantic versioning
  (`v1.2.3` and `1.2.3` compare equal).
- **Drafts and prereleases are excluded from production updates.**
  Drafts are ignored unconditionally; prereleases are ignored unless a
  dedicated dev/prerelease channel is explicitly enabled in code
  (`XINAS_UPDATE_CHANNEL=prerelease` / `channel="prerelease"`).
- **No branch fallback, ever.** xiNAS must not suggest or perform an
  install or update from `main`, `master`, `HEAD`, branch zip/tarballs
  (`archive/refs/heads`), raw-GitHub URLs (`raw.githubusercontent.com`),
  or commit snapshots. If the GitHub API is unavailable, or the latest
  release lacks a required asset, xiNAS returns a **clear error** and
  stops — it does not degrade to a branch.
- **Behavior on comparison:** equal ⇒ report "no update available";
  latest newer ⇒ show the new version, release notes, and download
  source; latest older/none ⇒ "no update available".

### Publishing a new version

To cut a release (see also `CHANGELOG.md`):

1. Update the project version in
   [xinas_menu/version.py](xinas_menu/version.py) (`XINAS_MENU_VERSION`;
   `pyproject.toml` derives from it). Pick the next patch for
   backward-compatible changes, minor/major otherwise.
2. Update the changelog / release notes (`CHANGELOG.md`).
3. Run the tests, linters, and basic checks (see [Verification](#verification)).
4. Create a git tag in `vX.Y.Z` form.
5. Create a GitHub Release from that tag (`gh release create vX.Y.Z`).
6. Attach the release assets the project uses (`install.sh`,
   `install_client.sh`).

### Rule for Claude Code

**Whenever you change installation or update logic, preserve the rule
that xiNAS checks for updates and installs only through GitHub
Releases.** Do not (re)introduce `git pull origin main`, raw-`main`
URLs, branch archives, or any branch/commit fallback into a
user-facing install or production-update path. If you add a
dev/nightly path, keep it explicitly separated from the production
flow and off by default.

## Repo Etiquette

- **Commits** follow Conventional Commits — `type(scope): subject`, e.g.
  `fix(installer): validate the tag before the bootstrap clone`,
  `docs(plans): WS3 landed`. Common types: `feat`, `fix`, `refactor`,
  `test`, `docs`, `chore`. Releases are `chore(release): vX.Y.Z`.
- **Branches** are `<type>/<slug>` — `fix/doca-ofed-flush-handlers`,
  `feat/xiraid-only-shares`, `docs/…`.

## Important Notes

- **Shell vs. Python TUI scope** — There are two distinct user surfaces. Treat them differently:
  - **Installer / bootstrap (bash, still active):** `prepare_system.sh`, `startup_menu.sh`, `simple_menu.sh`, and the shared `lib/menu_lib.sh`. These run before the Python TUI is installed and remain the supported install path. Bug fixes, polish, and improvements to the install flow itself are welcome here.
  - **Post-install management (Python only):** `post_install_menu.sh`, `configure_*.sh`, and any other day-2 management/configuration UI. These are deprecated. Do NOT add new features, settings screens, or configuration UIs to these shell scripts — implement them in the Python-based `xinas_menu/` package (Textual TUI) instead.
  - When a feature touches both surfaces (e.g. how `ansible-playbook` output is presented during install), it is acceptable — and expected — to update both the bash installer side and the Python TUI side so they stay in feel-parity.
- **`docs/control-path/api-v1.yaml` is CI-gated** — it looks like a doc but is not. Spectral lints it against `.spectral.yaml`, and `oasdiff` fails the PR on any **breaking** schema change relative to the base branch. Edit it deliberately, and expect a red PR if you remove or tighten an existing field.
- **yq v4 required** - Shell scripts use mikefarah/yq (not the Python jq wrapper). Ensure `/usr/local/bin/yq` is in PATH
- **Roles are idempotent by default** - Re-running `site.yml` over a healthy array converges (no reformat, no namespace rebuild). Destroying and rebuilding storage requires the explicit `xinas_storage_reset: true` (with an interactive `YES`, or `nvme_skip_cleanup_confirmation: true` for automation). The legacy `xfs_force_mkfs` / `nvme_use_existing_namespaces` knobs are disarmed and no longer trigger wipes on their own. See [docs/Installer/raid-spec.md](docs/Installer/raid-spec.md) §11.
- **License stored at `/tmp/license`** - Cleared on reboot; enter via menu before deployment
- **DOCA-OFED version** - Configured in `collection/roles/doca_ofed/defaults/main.yml` (`doca_ofed_version` variable)
- **Netplan file ownership** - All IB interface config MUST live in `/etc/netplan/99-xinas.yaml` only. Netplan merges all `*.yaml` files in `/etc/netplan/`, so duplicate interface definitions in other files (e.g. `50-cloud-init.yaml`) cause phantom IPs and conflicting PBR tables. Both TUI and Ansible auto-clean IB entries from non-xinas files. See `docs/Network/spec-network-management.md` for full details.
- **Netplan apply limitations** - `netplan apply` does NOT remove old IPs or PBR rules. The `net_controllers` role and TUI "Apply Network Changes" always flush PBR tables 100-199 and all IPs from mlx interfaces before applying. See apply sequence in `docs/Network/spec-network-management.md`.

## Automatic NVMe Namespace Management

The `nvme_namespace` role detects and excludes the system drive, rebuilds
namespaces on every other NVMe controller (n1: small namespace, 500 MB by
default, for the XFS log device; n2: remaining capacity for data), and
generates the `xiraid_arrays` / `xfs_filesystems` facts consumed by
`raid_fs` — RAID 10 from the small namespaces, RAID 5 from the large ones.

Toggle via `nvme_auto_namespace: true/false` in
`collection/roles/nvme_namespace/defaults/main.yml`, or the "Auto-Detect"
option in `configure_raid.sh`. Full behavior:
[docs/Installer/raid-spec.md](docs/Installer/raid-spec.md).

## Variable Priority

1. CLI/inventory variables (highest)
2. Preset YAML files (loaded by menu scripts)
3. Role `defaults/main.yml` (lowest)
