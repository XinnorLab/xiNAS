# Changelog

All notable changes to xiNAS are recorded here. Versions follow
[Semantic Versioning](https://semver.org/) with `vX.Y.Z` git tags, and
each entry corresponds to a published
[GitHub Release](https://github.com/XinnorLab/xiNAS/releases) — the only
supported source for installing and updating xiNAS.

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
