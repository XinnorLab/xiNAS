# Changelog

All notable changes to xiNAS are recorded here. Versions follow
[Semantic Versioning](https://semver.org/) with `vX.Y.Z` git tags, and
each entry corresponds to a published
[GitHub Release](https://github.com/XinnorLab/xiNAS/releases) — the only
supported source for installing and updating xiNAS.

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
