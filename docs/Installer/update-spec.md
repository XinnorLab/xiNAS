# xiNAS Update Spec — GitHub Releases only

**Status:** live contract. Supersedes the earlier `git pull origin main`
update flow described in older revisions of `CLAUDE.md` and the
control-path specs.

## Principle

xiNAS installs and updates itself **only from published GitHub
Releases**. The `main`/`master` branch is a development integration
branch — it is never a user installation source and never a production
update source. There is **no fallback** to a branch, a branch archive,
a raw-GitHub file, or a commit snapshot at any point in the install or
update path.

Repository of record: `XinnorLab/xiNAS`. Release tags use the
`vX.Y.Z` (semantic-versioning) form, e.g. `v3.1.1`.

## Update check (`xinas_menu/utils/update_check.py`)

The in-TUI update check (`u` shortcut, Management → Check for Updates,
MCP/Advanced → Check for Updates) does **not** touch git. It:

1. Reads the **installed version** from
   `xinas_menu.version.XINAS_MENU_VERSION`.
2. Queries the **GitHub Releases API**
   (`GET https://api.github.com/repos/XinnorLab/xiNAS/releases`) over
   HTTPS. An optional token is read from `XINAS_GH_TOKEN` /
   `GITHUB_TOKEN` for rate-limit headroom; unauthenticated is fine.
3. Filters the returned releases:
   - **draft** releases are dropped, always;
   - **prerelease** releases are dropped **by default**. They are only
     considered when the update channel is explicitly set to
     `prerelease` (see *Dev / prerelease mode* below);
   - releases whose tag is not parseable as semver are dropped.
4. Selects the release with the **highest semver tag** among what
   remains — the "latest published release".
5. Compares the latest release version against the installed version
   using semantic-version ordering (`v1.2.3` and `1.2.3` compare
   equal; a final release outranks a prerelease of the same `X.Y.Z`).

Outcomes:

- **Up to date** — latest ≤ installed: reports *no update available*.
- **Update available** — latest > installed: reports the new version,
  the release notes (release body), and the download source (the
  release's `html_url` / asset URL). The `Requires-Rebuild:` trailers
  are parsed from the **release notes body**.
- **API unavailable / error** — network failure, HTTP error, rate
  limit, or malformed response: returns a **clear error**. It does
  **not** fall back to `main` and does **not** report "up to date".
- **Required asset missing** — if a required release asset is
  configured (`UpdateChecker(required_asset=...)`) and the chosen
  release does not carry it, returns a **clear error**. No fallback.

`CheckResult` fields: `available`, `error`, `current_version`,
`latest_version`, `release_notes`, `download_url`, `required_rebuilds`.
Callers MUST treat a non-`None` `error` as "check failed", never as
"no update" — this is the silent-failure guard the type exists for.

## Update apply

Applying an update **checks out the release tag** — it never pulls a
branch:

1. `git fetch origin --tags` (via the privileged helper).
2. `git checkout <vX.Y.Z>` — the exact commit the release points to
   (detached HEAD at the release tag).
3. Sync the NFS helper sources and restart `xinas-nfs-helper`.
4. If the incoming release carries `Requires-Rebuild:` trailers, run
   `ansible-playbook playbooks/site.yml --tags <tags>` before
   restarting the menu (see *Update rebuild markers* in `CLAUDE.md`).

The privileged helper `/usr/local/sbin/xinas-update-git` (deployed by
the `xinas_menu` Ansible role) whitelists exactly two operations:
`fetch` (→ `git fetch origin --tags --quiet`) and `checkout <tag>`
(tag validated against `^v?[0-9]+\.[0-9]+\.[0-9]+`). It never accepts a
branch name and no longer offers `pull`.

If the helper is not deployed (host predating this change), apply falls
back to invoking `git fetch --tags` + `git checkout <tag>` directly;
on a root-owned `/opt/xiNAS` that fails with a permissions error, which
is surfaced to the user with a hint to re-run the `xinas_menu` role.
The fallback still targets the release tag — never `main`.

## Install / bootstrap

The one-line installers fetch from the **latest release asset**, not a
raw-`main` URL:

```bash
# server
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo bash
# client
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install_client.sh | sudo bash
```

`install.sh` and `prepare_system.sh` resolve the latest published
release tag from the API (`/releases/latest`) and clone / check out
that tag (`git clone --branch <tag>` on first install; `git fetch
--tags && git checkout <tag>` on an existing clone). If no published
release can be resolved, install **fails with a clear error** rather
than falling back to `main`.

## Dev / prerelease mode

Production updates ignore prereleases. A developer or nightly channel
is opted in **explicitly** and is separated from the production flow:

- Environment variable `XINAS_UPDATE_CHANNEL=prerelease` (default
  `stable`), or `UpdateChecker(channel="prerelease")` in code.
- In this mode prereleases (`vX.Y.Z-rc.1`, …) become eligible for
  selection. Drafts are **still** never used.

There is no code path in which the default (stable) channel selects a
prerelease, a draft, `main`, `master`, `HEAD`, a branch archive, or a
commit tarball.

## Migration

Hosts installed before this change run the old `git pull origin main`
updater. Their final main-based pull brings in this release-based
updater (and, via the `Requires-Rebuild: xinas_menu` trailer, the
re-deployed privileged helper). Every subsequent update is
release-based.
