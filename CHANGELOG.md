# Changelog

All notable changes to xiNAS are recorded here. Versions follow
[Semantic Versioning](https://semver.org/) with `vX.Y.Z` git tags, and
each entry corresponds to a published
[GitHub Release](https://github.com/XinnorLab/xiNAS/releases) — the only
supported source for installing and updating xiNAS.

## [3.4.0] - 2026-07-08

### Added

- **Non-destructive `site.yml` re-run (storage-reset safety).** Re-running
  the installer over a healthy array now converges instead of risking a
  reformat. The `nvme_namespace` role performs read-only storage-state
  detection that classifies each data drive as **MATCH** (already
  provisioned to the intended layout), **EMPTY**, or **FOREIGN**, and
  gates namespace rebuild + cleanup on that state. `raid_fs` reuses the
  detected state to gate the drive-clean and MD sweep and makes a
  converge/fail-fast `mkfs` decision instead of reformatting on a label
  mismatch. Destroying and rebuilding storage now requires the explicit
  `xinas_storage_reset: true` with an interactive `YES` (or
  `nvme_skip_cleanup_confirmation: true` for automation), surfaced
  through a shared fact-guarded confirmation banner that discloses
  exactly which devices will be wiped. See
  [docs/Installer/raid-spec.md](docs/Installer/raid-spec.md) §11.

### Changed

- **Legacy wipe knobs disarmed.** `xfs_force_mkfs` and
  `nvme_use_existing_namespaces` no longer trigger destructive actions on
  their own; storage is only destroyed via the explicit
  `xinas_storage_reset` path above. The disarmed `xfs_force_mkfs` pin was
  removed from the lab inventory and the preset `raid_fs.yml` files.
- **OS disk protected across LVM/ZFS/MD roots.** Detection and cleanup
  now resolve the system disk through its LVM/ZFS/MD backing devices (via
  `lsblk` paths) and exclude it from every wipe and namespace operation.

### Fixed

- **`nvme_namespace` hardening.** Per-device wipe error isolation (one
  drive's failure no longer aborts the sweep); explicit failure on
  unexpected single-namespace layouts instead of a dead fallback;
  partition tables wiped on the resolved block devices with the scope
  disclosed in the confirm banner; ZFS vdevs resolved via `lsblk`;
  detection facts kept clean by routing helper `echo` output to stderr; a
  loud guard when a required helper is missing; and defensive `rc` checks
  in delete-tracking so skip mode reliably skips.
- **`xinas-agent` task lifecycle.** A pre/post-stage throw can no longer
  hang a task — the agent always emits a terminal event. Apply tasks no
  longer hang at `snapshot_before` (the agent is granted config-history
  RW). Disk observation batches with null model/serial are no longer
  rejected (null fields are omitted before the batch is sent).
- **Reinstall without reboot.** The installer now `reset-failed`s the
  xiNAS units so reinstalling no longer fails with `EBUSY` on units left
  in a failed state.
- **Config-history correctness.** Snapshot ids now carry microsecond
  resolution so two snapshots created in the same second no longer
  collide, and auto-rollback restores the changed files directly instead
  of re-running `site.yml`.
- **`/var/log/xinas` ownership.** The `xinas_menu` role no longer
  clobbers `/var/log/xinas` ownership, which was crash-looping
  `xinas-api`.

### Rebuild required

Updating to this release rebuilds the node agent and its TypeScript
bundle (agent lifecycle fixes) and re-runs the `xinas_menu` role (log
ownership fix):

    Requires-Rebuild: xinas_node_build, xinas_agent, xinas_menu

## [3.3.0] - 2026-07-06

### Added

- **Installing operator is auto-added to `xinas-admin`.** Without a human
  member of `xinas-admin`, a non-root operator hit
  `connect EACCES /run/xinas/api.sock` from `xinas-mcp-stdio` and the CLI
  until they manually ran `usermod -aG`. The `xinas_api` role now resolves
  the operator behind the install (`SUDO_USER`/`USER`; root and empty
  skipped) and appends them — plus any accounts in the new
  `xinas_api_admin_users` list — to `xinas-admin`. `append: true` means
  nobody is created or removed; opt out with
  `xinas_api_add_installing_operator: false`. Requires the `xinas_api`
  role to re-run on update.
- **Actionable hint when the API socket rejects an MCP connection.**
  `xinas-mcp-stdio` now maps the socket errno to a fix — `EACCES` → join
  `xinas-admin` (or run as root); `ENOENT`/`ECONNREFUSED` → check
  `systemctl status xinas-api` — instead of surfacing a bare
  `connect EACCES … api.sock`. The raw errno and socket path are kept.
- **Break-glass control-plane restart on the MCP screen.** A guarded
  "[R] Restart Control-Plane (api+agent)" action on Integrations → MCP
  Server restarts `xinas-api` then `xinas-agent` (order matters — the
  agent `Requires=`/`After=` the api). A confirm dialog warns it
  disconnects active remote MCP/API sessions; it never stops a daemon,
  never targets the agent alone, and is audit-logged as
  `mcp.control_plane_restart` (#250).
- **User deletion clears XFS quotas first.** XFS user quotas are keyed by
  numeric UID, so a plain `userdel` orphaned the account's block limits and
  a later `useradd` reusing the freed UID silently inherited them. Delete
  now snapshots the user's per-mount quotas, names them in the confirm
  dialog, clears each to 0/0 via the NFS helper, then runs `userdel -r`;
  on any failure every already-cleared quota is restored and the account
  left intact.
- **Account lock status in the List Users table.** A new Status
  (Locked/Active) column sourced from `passwd -S` surfaces lock state
  without drilling into Manage User.
- **NFS helper pre-creates its op lock files at startup.** All four flock
  lock files (`/run/xinas-exports.lock` and the nfs-conf/idmap/profile
  locks) are created empty in `run_server()` before accepting
  connections, so the lock surface is deterministic and observable from
  boot rather than appearing lazily on first use.

### Fixed

- **TUI MCP Server screen retargeted to `xinas-api` config.** The screen
  still spoke to the retired `xinas-mcp` daemon — restarting `xinas-mcp`
  after every write and reading/writing `/etc/xinas-mcp/config.json` in
  the legacy schema. Post-S8 (ADR-0010) the MCP transport lives inside
  `xinas-api.service`; the screen now restarts `xinas-api` and reads/writes
  `/etc/xinas-api/config.json` in the real `ApiConfig` schema
  (`mcp.http`, `mcp.allow_apply`, `tokens: {token: {principal, role}}`),
  preserving the file's `0640 root:xinas-admin` mode/owner. Drops the TLS
  UI, adds an "Allow MCP apply" toggle, protects the bootstrap admin
  token, and fixes the Claude Code registration hint (`xinas-mcp-stdio`).
- **VM-aware fallback when NVMe detection finds no data drives.** An
  unattended default-preset install on a KVM/virtio VM aborted
  mid-pipeline (`nvme_namespace` found 0 data drives, `raid_fs` then
  failed on an undefined `xiraid_arrays`). It now re-probes all block
  devices and, on a VM, auto-continues in whole-disk mode with a forced
  RAID1 log; on bare metal or a diskless host it fails with an actionable
  message.
- **Updates no longer abort on a dirty install tree.** The installer copies
  preset files over tracked files, so `/opt/xiNAS` is git-dirty by design;
  when a release also changed one of those files, `git checkout <tag>`
  aborted. The update now force-checks-out the release tag (discarding
  local modifications to *tracked* files only; untracked
  `.xinas_applied_preset`, `keys/`, logs preserved). Requires the
  `xinas_menu` role to re-run on update.
- **Active filesystems are no longer dropped from observed state.** The
  agent wrote `systemctl is-enabled` output into `mount_unit_state`, which
  the control-path schema constrains to systemd `ActiveState`, so every
  enabled `.mount` unit 400'd at `/internal/v1/observed` and was silently
  dropped — a mounted `/mnt/data` never reached the store and the TUI
  showed "No XFS filesystems found." The probe now queries
  `systemctl is-active`, and the publisher surfaces non-retryable 4xx
  rejections to the journal instead of dropping them silently.
- **Leaked task leases are reclaimed — no more spurious "resource is
  locked".** Deleting a just-created NFS share failed with
  `CONFLICT: resource is locked by another task` because nothing drove the
  60s lease TTL. A new 30s lease sweeper reaps expired leases whose holder
  is already terminal (never touching in-flight work), the terminal-event
  state transition and lease release now run in one transaction, and a
  `lease_held` conflict renders a calm "temporarily locked… wait and retry"
  dialog.
- **RAID/share/filesystem deletes no longer 404 on ids containing `/`.**
  A Share id mirrors the export path minus its leading slash
  (`/mnt/data` → `mnt/data`), so raw interpolation split
  `DELETE /api/v1/shares/mnt/data` into two segments and matched no route,
  aborting "Delete Array" on step 1. Every id-in-path call site now
  percent-encodes the id as a single segment via `control_client.quote_id()`.
- **View Audit Log merges the control-path trail.** The screen read only
  the local `/var/log/xinas/audit.log`, so shares created via MCP/API
  (recorded as `share.create` in the hash-chained `GET /api/v1/audit`
  trail) never appeared. It now queries both and renders them in one
  chronological view, degrading gracefully when either source is missing.
- **Retired `xinas-mcp` unit removed from the TUI.** The startup banner,
  system-status screen, Service Status view, and menu restart actions
  still referenced the standalone `xinas-mcp.service` (removed at install
  time), painting a false red "inactive" and producing spurious restart
  failures. They now reflect the real daemons — `xinas-api` + `xinas-agent`
  — and "Restart NFS Helper" targets only `xinas-nfs-helper` (#247, #249).
- **Wizard "Back" button styled flat to match Cancel.** `#btn-back` fell
  through to Textual's stock bordered button style; it now shares the
  neutral-button selector with `#btn-cancel`/`#btn-no` across
  SelectDialog, ConfirmDialog, and InputDialog.
- **`textual` pinned to `>=8.2.8,<8.3`.** An unpinned `textual>=0.71.0`
  floor let CI and production drift onto 8.2.8, whose `Worker` is no longer
  awaitable — breaking `python-typecheck` and the `_show_control_error`
  call sites. Pinned identically across `pyproject.toml`, the `xinas_menu`
  role, and `install.sh`, and `_show_control_error` dropped `@work` so it
  stays awaitable (#251). Requires the `xinas_menu` role to re-run on
  update.

## [3.2.1] - 2026-07-04

### Fixed

- **Repeated provisioning no longer bricks boot with "Too many boot init
  vars".** The `perf_tuning` role appended its high-performance kernel-arg
  block to `GRUB_CMDLINE_LINUX` on every run — a `\1` backref that
  re-prepended the existing value — so each re-provision added another full
  copy of `intel_idle.max_cstate=0 … mds=off`. The flag-style tokens the
  kernel does not consume (`noibrs`, `noibpb`, `no_stf_barrier`, …) pile into
  the init argument vector; once they cross the kernel's `MAX_INIT_ARGS` (32),
  PID 1 setup panics at boot with `Too many boot init vars` — reported after
  several reinstalls. The task now strips any previously-applied xiNAS args
  before prepending exactly one copy: it is idempotent, preserves foreign
  kernel args, and self-heals a host that already accumulated duplicates (as
  long as it can still boot to re-run). Regression from 3.1.x
  (`$1` → `\1` backref correction). Requires the `perf_tuning` role to
  re-run on update.

## [3.2.0] - 2026-07-03

### Added

- **Install-time NFS exports are seeded into control-path desired
  state.** The installer wrote `/etc/exports` directly but never
  registered those exports in desired state, so the install-time default
  share disappeared from the TUI the moment any share was added through
  the API (the export stayed live but became invisible and
  unmanageable). The `exports` role now renders a seed manifest that
  `xinas-api` adopts into desired state once at first boot, guarded by a
  one-time marker so operator deletes are not resurrected (#244).
- **Observed-read routes now signal a degraded backend instead of
  faking an empty result.** The list routes
  (`GET /api/v1/arrays|disks|filesystems`) attach a
  `DEGRADED_BACKEND_UNAVAILABLE` warning when their backing collector
  (`XiraidArray` / `Disk` / `Filesystem`) is errored, and the RAID and
  Filesystem TUI screens render a degraded banner rather than a
  misleading "(no … configured)" empty state — so a down or stale
  backend is distinguishable from "genuinely none". The result payload
  is unchanged (additive warning; no `api-v1.yaml` change) (#245).
- **State-preserving Back navigation across the day-2 wizards.** The Add
  Share, Edit Share, and Create Array wizards gained a Back button on a
  new headless `run_wizard` driver (`BACK` / `CANCEL` sentinels,
  conditional-step `applies()` predicates); previously entered answers
  are remembered when stepping back, and conditional RAID steps are
  handled correctly (#246).

### Fixed

- **Observed xiRAID arrays were invisible in the API and TUI.** The
  tolerant `parseRaidShow` parser only accepted the fake transport's
  JSON-array `raid_show` payload and rejected the real xiRAID 4.3.x
  daemon shape (an object keyed by array name, with devices expressed as
  `[idx, path, states]` tuples). Configured arrays therefore never
  reached the observed-state store, the Control-Path API, or the Textual
  TUI. The parser now normalizes both shapes and extracts device paths
  from the tuple form, with a regression test for the real
  object-keyed / tuple-device payload (#243).
- **Informational and error pop-ups no longer ask an unanswerable
  Yes/No.** `ConfirmDialog` defaults to Yes/No and only renders a single
  OK button when constructed with `ok_only=True`. Notices, detail views,
  and error dialogs across the day-2 screens (RAID, NFS, filesystem,
  spare pools, drives, network) omitted the kwarg and so prompted the
  operator to answer messages that have nothing to answer (e.g. "No
  available drives found."). Every informational dialog now passes
  `ok_only=True`; genuine consent prompts whose result is branched on
  (Create/Edit confirmations, delete warnings, final confirmations) keep
  Yes/No. The screen-wide convention is recorded in the RAID, FS/shares,
  and network management specs.

### Rebuild required

Updating to this release rebuilds the node agent, its TypeScript bundle,
and the API service so the `parseRaidShow` fix and the degraded-read
warnings take effect:

    Requires-Rebuild: xinas_node_build, xinas_agent, xinas_api

## [3.1.2] - 2026-07-03

### Fixed

- **Default install no longer aborts at array creation.** Installing a
  release via `install.sh` → `autoinstall.sh --preset default` failed on
  every host with `raid_fs/tasks/create_array.yml: 'raid_create_min_free_mb'
  is undefined` (`ansible-playbook` exit 2). `autoinstall.sh` applies a
  preset by copying `presets/<name>/raid_fs.yml` over the `raid_fs` role's
  `defaults/main.yml`, so the `raid_create_min_free_mb` default added in
  3.1.0 was wiped whenever a preset was applied and the memory-floor guard
  then evaluated an undefined variable (#242).
- Both shipped presets (`default`, `xinnorVM`) now carry
  `raid_create_min_free_mb: 2560`, with a comment documenting that role
  defaults must be mirrored into presets that replace them.
- The guard task is now defensive (`raid_create_min_free_mb | default(2560)`)
  so a preset that forgets the tunable can never hard-fail the whole install
  again — it loses the override, not the run.

## [3.1.1] - 2026-07-03

### Changed — GitHub-Releases-only delivery

- xiNAS now checks for updates **only through published GitHub
  Releases**. The update checker queries the GitHub Releases API,
  compares the installed version against the latest published release
  tag using semantic versioning (`v1.2.3` and `1.2.3` compare equal),
  and reports the new version, release notes, and download source.
- The `main` branch is **no longer used as a production update source**.
  The in-TUI updater checks out the latest **release tag** instead of
  running `git pull origin main`.
- **Protection against fallback to branch-based updates** was added:
  draft releases are always ignored, prereleases are ignored unless the
  `prerelease` channel is explicitly enabled, and any failure (API
  unavailable, missing required asset) surfaces a clear error instead of
  degrading to `main`/`master`, a branch archive, or a commit snapshot.
- Install one-liners now fetch the installer from the latest release
  asset
  (`https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh`),
  and `install.sh` / `prepare_system.sh` / `install_client.sh` resolve
  and check out the latest release tag rather than cloning `main`.
- The client TUI self-updater and the privileged `xinas-update-git`
  helper were converted to release-tag checkout (helper now accepts
  `fetch` / `checkout <vX.Y.Z>` only — no `pull`).
- The **Release and Update Policy** in `CLAUDE.md` was updated, and a new
  contract doc was added at `docs/Installer/update-spec.md`.

### Added

- `tests/test_update_check.py` covering release detection, draft and
  prerelease filtering, semver comparison, the no-`main`-fallback
  behavior, branch-archive avoidance, and the missing-asset error path.
