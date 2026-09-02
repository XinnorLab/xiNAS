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
  the release notes (release body of the latest release), and the
  download source (the release's `html_url` / asset URL). The
  `Requires-Rebuild:` trailers are parsed from the release notes bodies
  of **every eligible release strictly newer than the installed
  version**, not just the latest one — see *Rebuild trailers* below.
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

## Rebuild trailers

A release requests an Ansible re-run by carrying a `Requires-Rebuild:`
trailer in its **release notes body** (the body aggregates the trailers
of the commits it ships — see *Update rebuild markers* in `CLAUDE.md`).

**Union across skipped releases.** An operator who updates from 3.6.0
straight to 3.6.2 never sees 3.6.1's notes, but 3.6.1's roles still have
to run on that host. The checker therefore parses trailers from **every
eligible release strictly newer than the installed version** and unions
the tags. Reading only the latest release's body silently drops the
rebuild of every release the operator skipped — a host would take the new
code without the role re-run that makes it effective. `all` anywhere in
that union short-circuits to `("all",)`.

Only the **latest** release's body is shown to the operator as release
notes; the union governs only which roles run.

**Tolerant syntax.** The trailer is matched case-insensitively at the
start of a line, ignoring Markdown decoration that authors reach for when
they want the line to render as a callout: leading blockquote markers
(`>`), leading/trailing emphasis (`*`, `_`), surrounding backticks, and
whitespace. All of these carry the same meaning:

```
Requires-Rebuild: nfs_server
> **Requires-Rebuild: nfs_server**
  _Requires-Rebuild: `nfs_server`_
```

This tolerance is a **safety property, not a convenience**: a trailer
that fails to parse is indistinguishable from no trailer at all, so the
update silently skips the Ansible step. That regression shipped in
v3.6.0 and v3.6.1, whose bolded, blockquoted trailers never matched the
line-anchored pattern. Tags are decoration-stripped individually, so
a tag list of ``**a**, `b` `` yields `("a", "b")`.

### Rebuilding dist/ restarts its consumers

`xinas-api` and `xinas-agent` are Node processes launched from
`xiNAS-MCP/dist/`. Node reads that JavaScript **once, at process start**,
so rewriting `dist/` changes nothing about what the running daemons
execute. Nothing else restarts them for a change confined to
`xiNAS-MCP/src`: the `xinas_api` / `xinas_agent` handlers fire only when
*those* roles' own unit or config tasks report changed, and a src-only
change touches neither.

**Contract:** the `xinas_node_build` role's build task MUST notify
handlers that restart `xinas-api` and then `xinas-agent` — api first,
matching the unit dependency (`xinas-agent` `Requires=xinas-api.service`).
A host with neither unit installed skips the restart instead of failing;
that is the first-install ordering (`xinas_node_build` precedes
`xinas_api` / `xinas_agent` in `site.yml`), and those roles then start the
services themselves against the dist/ just built.

Two consequences follow, and both are intended:

- **`Requires-Rebuild: xinas_node_build` is sufficient** for a
  TypeScript-only change. It does not have to be paired with `xinas_api` /
  `xinas_agent` for the new code to take effect.
- **Every run of the role restarts both services**, including a converged
  `site.yml` re-run, because `npm run build` is unconditionally `changed`.
  After a rebuild the running processes are stale relative to `dist/` by
  definition, so an unconditional restart is the honest outcome.

This is the second instance of the same class of bug as the unparsed
trailers above — the update reports success while the host keeps running
the old code. It shipped in **v3.8.0**: the release carried
`Requires-Rebuild: xinas_node_build`, the rebuild ran and rewrote `dist/`,
and both daemons kept serving the pre-update build. Among the fixes left
inert was the `raid_show` `size` parse (the daemon reports a formatted
string such as `"75092 GiB"`, which the superseded parser read only as a
number), so `usable_capacity_bytes` was absent from every
`GET /api/v1/arrays` row and the TUI rendered every array's capacity as
`N/A`.

## Update apply

Applying an update **checks out the release tag** — it never pulls a
branch:

1. `git fetch origin --tags` (via the privileged helper).
2. `git checkout --force <vX.Y.Z>` (via the privileged helper) — the
   exact commit the release points to (detached HEAD at the release
   tag).
3. If the incoming release carries `Requires-Rebuild:` trailers, run
   `ansible-playbook playbooks/site.yml --tags <tags>` (see *Update
   rebuild markers* in `CLAUDE.md`). **If this step fails (rc ≠ 0),
   STOP**: the code stays at the new release, the NFS helper is
   **not** refreshed, and the menu is **not** restarted — the operator
   is told to review the log. This is a deliberate safety stop that
   predates this document and MUST be preserved: neither the helper
   refresh nor a restarted menu should paper over a failed rebuild.
4. Refresh the NFS helper (see *NFS-helper refresh* below).
5. Restart the menu.

The refresh runs **after** the rebuild (step 3), not before it, precisely
so that a release which itself deploys new refresh machinery has
already done so by the time the refresh needs it — see *Bootstrapping
the helper-sync wrapper* below.

### NFS-helper refresh

The refresh (step 4) runs **after** a successful rebuild — i.e. after
step 3 completes with rc = 0 when the release carries `Requires-Rebuild:`
trailers — or directly after the checkout (step 2) when the release
carries no trailers at all, so no rebuild step runs. It **never** runs
if the rebuild step failed; that case stops at step 3 per the safety
stop above.

By the time the refresh runs, the checkout (step 2) has already taken
effect — the working tree is at the new release. A failure in the
helper refresh does **not** undo the checkout: it means the **code is
updated (and, if scheduled, already rebuilt) but the running
`xinas-nfs-helper` daemon and/or its installed files may not be**.

The refresh copies `*.py` from `<repo>/xiNAS-MCP/nfs-helper` to
`/usr/lib/xinas-mcp/nfs-helper` and restarts `xinas-nfs-helper`. Both the
destination directory and the systemd unit are root-owned
(`root:root`, service `User=root`), while the TUI driving the update
runs as the unprivileged `xinnor` user — copying the files or
restarting the unit directly as `xinnor` cannot work, for the same
reason a direct `git checkout` against a root-owned `/opt/xiNAS` cannot
(see below).

The refresh is therefore performed by a second privileged wrapper,
`/usr/local/sbin/xinas-update-helper-sync`, deployed by the `xinas_menu`
role and granted via the same passwordless-sudo mechanism as
`xinas-update-git`, restricted to that one binary. Its contract mirrors
`xinas-update-git`:

- `set -euo pipefail`.
- Hard-coded source `/opt/xiNAS/xiNAS-MCP/nfs-helper` and destination
  `/usr/lib/xinas-mcp/nfs-helper` — it accepts **no** caller-supplied
  paths.
- Copies `*.py` from source to destination, then runs
  `systemctl restart xinas-nfs-helper`.
- Exits non-zero on any failure. The caller MUST check the wrapper's
  exit status — no discarding the result of a `subprocess.run` call.

**Skip condition:** if step 3 ran `ansible-playbook` in a way that
already covers the `xinas_nfs_helper` role — that is, the resolved tag
set is either `("all",)`, which runs `site.yml` with **no** `--tags`
filter and therefore every role including `xinas_nfs_helper`, or a tag
set that explicitly contains `xinas_nfs_helper` — the refresh step is
skipped outright. Ansible has already synced the files and (re)started
the unit, running as root rather than as the unprivileged `xinnor` user
that drives the update. This is reported as a **plain success**, never
as a failure or as a separate warning: the rebuild already did the
refresh's job.

Apply distinguishes **four outcomes** — two of them a "skip" for a
different reason, one an unqualified success, one a partial success —
and reports each differently:

a. **Skipped — rebuild already covered it.** Step 3 ran with tags that
   include `xinas_nfs_helper`, so the refresh step does not run at all.
   This is **not** an error; the update is reported as a plain success.
b. **Skipped — helper not installed on this host** (destination
   directory absent). The refresh is skipped; this is **not** an
   error; the update is reported as a plain success.
c. **Refresh succeeds.** The update is reported as a plain success.
d. **Refresh fails.** The wrapper returns non-zero, or (wrapper absent)
   the direct fallback hits a permission error writing the root-owned
   destination. The update is reported as a **partial success**: the
   release tag IS already checked out, and any scheduled rebuild
   already succeeded (the refresh never runs after a failed rebuild —
   see the safety stop in *Update apply* above) — but the helper may be
   stale. This outcome MUST NOT be reported as a bare failure (the code
   update, and any rebuild, did succeed) and MUST NOT be reported as an
   unqualified success (the helper is stale). **The remediation depends
   on why it failed, and the two cases MUST NOT be conflated:**

- **Wrapper present but returned non-zero** — remediation:
  `sudo /usr/local/sbin/xinas-update-helper-sync`.
- **Wrapper absent** (a host predating this change, or one that
  skipped the bootstrapping release described below, so the direct
  fallback hit a permission error against the root-owned
  destination) — the remediation MUST NOT name the wrapper, because
  it does not exist on this host. Instead, tell the operator to
  redeploy the `xinas_menu` role, e.g.
  `sudo ansible-playbook playbooks/site.yml --tags xinas_menu` (run
  from `/opt/xiNAS`), which installs the wrapper; the *next* update
  then refreshes normally.

Telling an operator to run a binary that is not present on their host
is precisely the defect this distinction guards against: the two
remediations for outcome (d) are not interchangeable, and the reporting
logic MUST pick the one that matches whether the wrapper is actually
installed.

### Reset-to-release: local changes are discarded

Before the preset-overlay change
([docs/superpowers/specs/2026-08-18-preset-overlay-design.md](../superpowers/specs/2026-08-18-preset-overlay-design.md)),
the installed `/opt/xiNAS` working tree was **git-dirty by design**:
`apply_preset` materialized the chosen preset by copying preset files over
tracked files — `presets/<name>/playbook.yml` → `playbooks/site.yml`, and
each `presets/<name>/*.yml` → the matching role `defaults/main.yml`
(`raid_fs`, `net_controllers`, `nvme_namespace`, `exports`) plus
`net_controllers/templates/netplan.yaml.j2`. Whenever a new release also
changed one of those tracked files, a plain `git checkout <tag>` aborted with
*"Your local changes to the following files would be overwritten by
checkout"* and the update failed.

**That is no longer how a preset is applied.** `apply_preset` /
`xinas_apply_preset` ([lib/xinas_config.sh](../../lib/xinas_config.sh)) now
write only the untracked configuration overlay —
`playbooks/group_vars/all/10-preset.yml` (preset) and
`playbooks/group_vars/all/20-local.yml` (config editors, including the
manual-mode netplan override) — and never touch a file under
`collection/roles/` or `playbooks/site.yml` at runtime; see
[Installer/spec.md §1.0](./spec.md#10-the-configuration-layer-model). Both
overlay files, and the manual netplan template at
`.xinas-local/netplan.yaml.j2`, are listed in `.gitignore`, so on a fully
migrated node `git status` no longer reports the role defaults or
`playbooks/site.yml` as modified.

The apply still uses **`git checkout --force`**, for two reasons that are
now about the tree in general rather than about presets specifically:

- **Untracked survives `--force` unconditionally**, which is exactly what
  lets configuration persist across an update now, where before it did not.
  The checkout uses `--force`, never `git clean`, so the overlay
  (`playbooks/group_vars/all/`), `.xinas-local/`, install markers
  (`.xinas_applied_preset`), cached `keys/`, and logs all survive.
- **A pre-migration host may still have a dirty tracked tree.** A host that
  last applied or saved a preset before this change wrote it straight into
  `collection/roles/*/defaults/main.yml` and `playbooks/site.yml`, the old
  way. `--force` is what lets that host take *this* update at all — a plain
  checkout would still abort on those now-stale local modifications. See
  *Migration* below and *Bootstrapping the forcing helper* further down this
  document, which predates the overlay and remains in force for the same
  reason.

### Overlay migration: reconstructing the preset layer from the applied-preset marker

(Distinct from *Migration* further below, which covers the one-time move
from the old `git pull origin main` updater to this release-based one — this
section is about the configuration overlay specifically.)

The obvious migration — read the dirty tracked files on a pre-migration
host, extract the overridden keys, restore the files — cannot run on the
update path: `git checkout --force` (above) runs as part of Update apply
step 2, *before* any of the incoming release's new code executes, so by the
time that new code is live the old, mutated role defaults are already gone,
reset to the release's pristine values.

Instead, `xinas_migrate_overlay`
([lib/xinas_config.sh](../../lib/xinas_config.sh)) reconstructs the overlay
from what *does* survive the forced checkout: the untracked marker file,
`/opt/xiNAS/.xinas_applied_preset`, that `apply_preset` writes on every
successful apply. `startup_menu.sh`, `simple_menu.sh`, and `autoinstall.sh`
all call it once at startup, before any menu or install logic runs, and it
is idempotent:

1. If `playbooks/group_vars/all/10-preset.yml` already exists, the node is
   already migrated; do nothing.
2. Otherwise, if the marker file names a preset that still exists under
   `presets/`, re-apply that preset through the normal `xinas_apply_preset`
   path. This write goes to the untracked overlay, so — unlike the
   pre-migration write it replaces — it survives the *next* forced checkout
   too.
3. Otherwise (no marker — the node predates it, or the marker names a
   preset that has since been removed) the overlay is left empty; the role
   defaults apply as-is, and the caller reports that to the operator.

**Config-editor edits made before a node's first migrated run are not
recoverable.** They lived only in the tracked files the pre-migration code
mutated directly, and `git checkout --force` has discarded local
modifications to tracked files on *every* update since the forcing checkout
was introduced — this is not a new loss particular to this change. The
migration bridge recovers the **preset selection**, because the preset name
survives in the untracked marker; it has no equivalent record of a later
config-editor edit, because that edit was never written anywhere the forced
checkout would spare. It is also only as complete as the marker itself:
before the `apply_preset` consolidation that shipped alongside this change,
only the `startup_menu.sh` copy of `apply_preset` wrote the marker, so a
preset last applied through the old `simple_menu.sh` copy leaves nothing for
the bridge to recover from either. This is a one-time gap on the update that
first brings in this change — after migration, every preset and
config-editor write goes to the untracked overlay and survives every
subsequent update in full.

Consequence to be aware of: after an update, the role `defaults/main.yml`
files and `playbooks/site.yml` always hold the **release's** values — that
is now true of every update, not a one-time side effect of materializing a
preset. Day-2 desired state (preset selection, config-editor edits) lives
entirely in the untracked overlay, which the checkout never touches, so it
is unaffected by a code-only update. If the same update also carries a
`Requires-Rebuild:` trailer for `raid_fs`, `net_controllers`, or `exports`,
that role re-runs with the overlay merged on top of the new release's
defaults, the same as any other `ansible-playbook playbooks/site.yml`
invocation from the repo root (`group_vars` resolves relative to the
playbook directory regardless of `--tags`; see the design doc §3
measurements) — so a customized layout is carried forward across the
rebuild rather than reset to the release defaults. Before the overlay, this
was the opposite: a rebuild reverted a customized role to the release
defaults, and operators had to re-apply their preset afterward — that
limitation is gone for a fully migrated host.

The privileged helper `/usr/local/sbin/xinas-update-git` (deployed by
the `xinas_menu` Ansible role) whitelists exactly two operations:
`fetch` (→ `git fetch origin --tags --quiet`) and `checkout <tag>`
(→ `git checkout --force --quiet <tag>`, tag validated against
`^v?[0-9]+\.[0-9]+\.[0-9]+`). It never accepts a branch name and no
longer offers `pull`.

If the helper is not deployed (host predating this change), apply falls
back to invoking `git fetch --tags` + `git checkout --force <tag>`
directly; on a root-owned `/opt/xiNAS` that fails with a permissions
error, which is surfaced to the user with a hint to re-run the
`xinas_menu` role. The fallback still targets the release tag — never
`main`.

### Bash-path parity

The `--force` checkout and semantic-version comparison rules above bind
**every** update/install code path — bash and Python alike:

- **Tag checkout** — any path that checks out a release tag MUST use
  `git checkout --force <tag>`, never a plain `git checkout <tag>`. The
  working tree is git-dirty by design (see *Reset-to-release* above),
  so a non-forcing checkout can abort mid-update, leaving the host
  straddling two releases. This binds `startup_menu.sh`, `install.sh`,
  `install_client.sh`, and `prepare_system.sh` equally with the Python
  updater.
- **Version comparison** — "is an update available" MUST be decided by
  semantic-version ordering (as in *Update check* above), never by
  string inequality between tag strings. A string comparison reports
  "update available" whenever the feed's tag string differs from the
  installed one at all — including when it is older — which can walk
  an installation backwards.
- **No false success** — a bash update path MUST propagate the exit
  status of `fetch`/`checkout` and MUST NOT print or report a
  success/updated message when either command failed. A pattern such
  as `git fetch ... || true` followed by an unconditional "updated"
  message is prohibited: swallowing the failure denies the operator
  any signal that the tree did not move.
- **Tag validation before checkout** — every bash update/install path
  MUST validate the resolved tag against the shared semver
  release-tag regex (`^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`,
  the same pattern the `xinas-update-git` wrapper enforces) BEFORE
  invoking `git`, and MUST refuse — with a clear error and a non-zero
  exit, never a branch fallback — any value that fails it. The tag
  comes from an unanchored `grep`/`sed` over the GitHub API response,
  so a spoofed or malformed `tag_name` (`main`, `--quiet`, a
  shell-injection payload) would otherwise reach `git checkout`. The
  canonical check is `_is_release_tag` in `lib/menu_lib.sh`;
  `install.sh` carries a character-identical inline copy because it
  runs before the clone exists and cannot source the library.
- **Non-interactive git access** — every unattended install/update path
  MUST `export GIT_TERMINAL_PROMPT=0` before it invokes `git` against
  GitHub, and MUST do so ahead of the first `git` call in the script.
  When GitHub answers a fetch/clone with `401` — a stale credential in
  root's `~/.git-credentials` or credential helper, an authenticating
  proxy, or a repository that has been made private or renamed — git
  falls back to prompting `Username for 'https://github.com':` on
  `/dev/tty`. None of these installers is interactive at that point:
  `install.sh` runs its clone backgrounded behind a spinner with
  stdout/stderr redirected to the install log, so the prompt surfaces
  as an unattributed line over the spinner and the installer blocks
  forever on a terminal read it never announced; `curl … | sudo bash`
  and unattended provisioning have no operator to answer it at all.
  With the variable set, git fails immediately with
  `could not read Username … terminal prompts disabled` instead of
  hanging. This binds `install.sh`, `prepare_system.sh`,
  `install_client.sh`, and the `xinas-update-git` wrapper (which has
  set it since it landed). The dev-only `configure_git_repo` affordance
  in `startup_menu.sh` is explicitly **out of scope**: it is gated
  behind `XINAS_DEV_REPO_CONFIG=1`, clones an operator-supplied URL
  that may legitimately be private, and runs interactively where a
  prompt can actually be answered.
- **Naming the authentication failure** — a path that fails its clone
  or fetch because GitHub refused it MUST NOT leave the operator with
  only a raw git error. It MUST print the release URL it tried and name
  the host-side causes worth checking (root's git credentials and
  credential helper, `insteadOf` rewrites, an HTTP proxy), since the
  xiNAS repository is public and a `401` on that path is a host
  configuration problem, not a xiNAS one.
- **Bounded, non-blocking check** — the automatic update check that
  runs at menu startup (`check_for_updates` in `startup_menu.sh` and
  `simple_menu.sh`) MUST run synchronously, never backgrounded: a
  background subshell's result variables never reach the parent shell,
  so the banner can never fire. Because it therefore blocks startup,
  **every** network operation on that path MUST carry an explicit
  timeout — an unreachable GitHub may delay the menu by a few seconds,
  never indefinitely. Note the reachability probe and the release-API
  call target *different hosts* (`github.com` vs `api.github.com`), so
  a bounded probe does not bound the API call; each needs its own
  limit. A network or API failure on this path MUST read as "no update
  available": it MUST NOT abort the menu (under `set -e` a failing
  `var=$(pipeline)` assignment kills the calling shell, so the
  pipeline needs an explicit escape), and MUST NOT be reported as an
  update being available.
- **A tighter bound on the passive check does not bind the interactive
  apply.** `_latest_release_tag` (`lib/menu_lib.sh`) takes the curl
  `--max-time`/`--connect-timeout` bound as optional arguments,
  defaulting to the tight passive-check bound above (3s / 2s). The
  interactive path — `do_update`, in both menus, resolving
  `"${UPDATE_TARGET_TAG:-$(_latest_release_tag …)}"` when the operator
  picks "Update" without an already-cached target tag — passes a
  materially longer bound instead. The operator explicitly requested a
  blocking action and is already waiting on it; failing fast after ~3s
  on a slow-but-live link is the wrong trade there, and is a distinct
  failure mode from the passive, unattended startup probe this bullet
  otherwise governs. The tight default MUST NOT be relaxed for the
  passive check; the longer bound is scoped to the explicit apply path
  only.

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
that tag: `git clone --branch <tag>` on first install; on an existing
clone, `git fetch --tags && git checkout --force <tag>` — per *Bash-path
parity* above, never a plain (non-forcing) checkout. If no published
release can be resolved, install **fails with a clear error** rather
than falling back to `main`.

## Release-detection source is fixed

The repository queried for release detection — version comparison,
release notes, `Requires-Rebuild:` trailers, and the displayed download
URL (see *Update check* above) — is **fixed** at `XinnorLab/xiNAS`.
There is **no** environment variable, config file, or other mechanism
to redirect it.

`XINAS_UPDATE_REPO` — an environment variable that previously existed,
undocumented, in `xinas_menu/utils/update_check.py` and in four bash
scripts (`simple_menu.sh`, `startup_menu.sh`, `post_install_menu.sh`,
`client_repo/client_setup.sh`) — is **removed**. It only ever
redirected the release-detection source, never the git checkout target
(which always uses the local `origin` remote); its removal does not
change checkout behavior.

Rationale: per the Release and Update Policy (`CLAUDE.md`), production
update information must originate only from the official GitHub
Releases feed for `XinnorLab/xiNAS`. A redirectable release-detection
source lets an environment variable point the version check, release
notes, `Requires-Rebuild:` trailers, and download link at an arbitrary
repository — spoofed content in any of those would reach the
operator's confirmation dialog indistinguishably from the genuine feed.

`XINAS_UPDATE_CHANNEL` (below) remains the **only** supported override
knob, and it does not change *which* repository is queried — only
*which releases within* `XinnorLab/xiNAS` are eligible (stable vs.
prerelease).

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

### Release-candidate cycle

Work for the next minor accumulates on a long-lived `release/X.Y` branch
(see `CLAUDE.md` §*Branching model*). An RC is the vehicle for testing that
branch on real hardware:

1. `XINAS_MENU_VERSION` is set to `X.Y.0-rc.N`. The same literal is valid on
   both sides of the version boundary — setuptools normalizes it to PEP 440
   `X.Y.0rcN` for the editable install the `xinas_menu` role performs, and
   `_semver_key` gives it correct semver precedence
   (`3.13.0 < 3.14.0-rc.1 < 3.14.0`). No second version string is kept.
2. The tag `vX.Y.0-rc.N` is created on `release/X.Y` and published with
   `gh release create … --prerelease --target release/X.Y`.
3. The test host sets `XINAS_UPDATE_CHANNEL=prerelease` for the menu
   process; the normal update flow then offers RC tags. `apply_update`
   accepts them because `_TAG_RE` admits a prerelease suffix, and the ref
   is still a tag — never a branch.

**Release assets are not required on an RC.** `UpdateChecker` enforces the
asset contract only when constructed with `required_asset`, and neither
call site (`xinas_menu/app.py`, `xinas_menu/screens/startup/startup_menu.py`)
passes one. The stable-channel install one-liner is unaffected either way,
because it never resolves an RC — see below.

### RC trailers do not reach the stable channel

`Requires-Rebuild:` trailers carried by RC release notes are invisible to
production hosts, and this is a property of the filter order, not an
oversight:

- `_check_sync` drops prereleases from `candidates` when
  `allow_prerelease` is false;
- the trailer union is computed *afterwards*, from `candidates` only.

A host on the stable channel therefore goes `X.Y-1.Z` → `X.Y.Z` and reads
only final release bodies. **The final release notes must re-state every
trailer accumulated during the RC cycle**, or the roles those changes
depend on never run on production hosts. `CLAUDE.md` §*Publishing a new
version* carries the command that collects them.

### Fresh installs cannot select an RC

`install.sh` resolves `/repos/<slug>/releases/latest`, which GitHub defines
to exclude prereleases, and then validates the result against the release-tag
regex. An RC is consequently reachable only as an **update** from an already
installed host on the prerelease channel. This is deliberate: it keeps the
`--prerelease` flag a single switch that isolates an RC from both the update
checker and the installer, with no second gate to keep in sync.

## Dev-only: expert-menu Git Repository Configuration

`startup_menu.sh`'s expert menu (Advanced Settings → "Git Repository
Configuration", `configure_git_repo()`) can repoint a local provisioning
clone at `/opt/provision` to an arbitrary git URL and branch, then
`git pull`s (or clones) that branch and `cd`s the running menu session
into it. Left unguarded, this would let the menu's own `check_for_updates`
/ `do_update` operate against that arbitrary clone afterward — exactly
the branch/arbitrary-URL fallback the Release and Update Policy forbids
in a user-facing update path.

This affordance exists only for development (pointing the provisioning
tree at a fork or feature branch while iterating on xiNAS itself). It is
**never** part of the production install/update flow, is not invoked by
the automatic update checker, and is **disabled by default**:

- The function refuses immediately — before touching any git remote,
  checkout, pull, or clone — unless the environment variable
  `XINAS_DEV_REPO_CONFIG=1` is set for the menu process.
- With the gate off (unset, or any value other than `1`), the menu shows
  a "Developer Feature" notice and returns without side effects. The
  menu entry itself remains visible (labeled `(dev, disabled)`) so an
  operator isn't confused by a missing option, but selecting it does
  nothing destructive.
- With `XINAS_DEV_REPO_CONFIG=1` set, the entry is labeled `(dev)` and
  the feature behaves as before: it prompts for a URL/branch and
  repoints `/opt/provision`.

A normal expert session — the one a customer or field engineer runs —
never sets this variable, so this path is unreachable in production use.

## Migration

Hosts installed before this change run the old `git pull origin main`
updater. Their final main-based pull brings in this release-based
updater (and, via the `Requires-Rebuild: xinas_menu` trailer, the
re-deployed privileged helper). Every subsequent update is
release-based.

### Bootstrapping the forcing helper

The `--force` checkout lives in the privileged helper, which is deployed
by the `xinas_menu` role. A host that already carries the **old**
(non-forcing) helper and whose tree is dirty on a file the incoming
release also changed cannot self-heal on that first update: the old
helper's plain `git checkout <tag>` fails *before* the rebuild step that
would deploy the new helper. The release shipping this fix carries
`Requires-Rebuild: xinas_menu`, so any host that updates while its tree
is **clean or non-conflicting** proactively picks up the forcing helper
and every later conflicting update self-heals.

A host that is already wedged (old helper + conflicting dirty file)
needs a one-time manual reset before its next update:

```bash
sudo git -C /opt/xiNAS checkout --force <vX.Y.Z>   # or: sudo git -C /opt/xiNAS stash
```

after which the update proceeds and installs the forcing helper.

### Bootstrapping the helper-sync wrapper

The `/usr/local/sbin/xinas-update-helper-sync` wrapper is deployed by
the `xinas_menu` role, same as `xinas-update-git`. The release that
introduces it carries `Requires-Rebuild: xinas_menu`, so on a host that
takes that update, the rebuild step (step 3) installs the wrapper
*before* the refresh step (step 4) needs it — that update self-heals
and reports outcome (c), a plain success, with no spurious warning
about a binary the host doesn't have yet.

A host that skips that release and later takes a **code-only** update —
no `Requires-Rebuild:` trailer, per the trailer rules in `CLAUDE.md`, so
no rebuild runs and the wrapper never gets deployed — hits outcome (d)
with the wrapper absent, and is told to redeploy the `xinas_menu` role
directly, exactly as described in *NFS-helper refresh* above.

### Bootstrapping the dist/-consumer restart

The restart handlers described in *Rebuilding dist/ restarts its
consumers* live in the `xinas_node_build` role — that is, in the repo,
not on the host. The checkout (step 2) therefore installs them **before**
the rebuild (step 3) invokes the role, so the release that introduces
them applies them on the very update that delivers them, with no
intermediate release needed. This is unlike the two wrappers above, which
must be written to `/usr/local/sbin` by a role before a later update can
call them.

The one precondition is that the release carrying the fix declares
`Requires-Rebuild: xinas_node_build` — without it no rebuild runs, the
role is never invoked, and the handlers sit in the checked-out tree doing
nothing.

A host that took **v3.8.0** is the wedged case: it has the new code but
both daemons still run the build they loaded before that update, and
`xinas_node_build` will not re-run on its own. It self-heals on the next
release that carries the trailer. To recover before then, either restart
the two services directly (the TUI exposes this as a break-glass action —
*Advanced → restart the control-plane services*) or re-run the role:

```bash
sudo ansible-playbook playbooks/site.yml --tags xinas_node_build
```
