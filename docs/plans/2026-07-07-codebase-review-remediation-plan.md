# Codebase Review Remediation Plan (2026-07-07)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the confirmed defects from the 2026-07-07 full-codebase review — 90 verified findings across storage data-safety, the bash installer, Ansible roles, the Python TUI, `xinas_history`, the TypeScript control-path, `client_repo`, security, and spec drift.

**Architecture:** This is a **master plan**: findings are grouped into 9 sequenced workstreams (WS1–WS9). Small fixes carry their exact change inline; the two large workstreams (WS1 storage safety, WS4 `xinas_history` hardening) get their own dated detailed plans before execution (WS1's already exists). Ordering is safety-driven: destructive-on-re-run defects land and **ship in a release first**, because the update flow itself re-runs Ansible roles via `Requires-Rebuild:` trailers.

**Tech Stack:** Bash (installer), Ansible (roles), Python 3.12+ (Textual TUI, `xinas_history`, pytest), TypeScript/Node 20 (`xiNAS-MCP`), GitHub Actions CI.

---

## How this plan was produced

Multi-agent review (13 area reviewers + adversarial verification, 3 independent
refuters per critical/high finding, 1 per medium/low): 108 raw findings,
86 survived verification. Verification agents for three areas (`tests-ci`,
`docs-consistency`, `client-repo`) failed on infrastructure limits; their
unique findings were re-verified manually against the tree and are included
below. 4 findings were genuinely refuted and are excluded.

Severity: **critical** = data loss / bricked install reachable in normal use;
**high** = broken main path or binding-policy violation; **medium** = edge-path
bug, idempotency break, spec drift; **low** = maintainability hazard.

## Re-baseline (2026-07-08, against origin/main 4ef129d)

The review ran against a pre-C1 tree; concurrent sessions landed fixes the
same day. Every WS2-WS9 item was re-verified individually:

- **WS1 is LANDED**: the C1 gating merged to main (0143bfb..63cb2ab —
  `xinas_storage_reset` gate, MATCH/EMPTY/FOREIGN detection, disarmed
  `xfs_force_mkfs`, presets cleaned, `tests/test_raid_fs_safe_defaults.py`).
  The residual items (WS1.2 lab.ini pin, WS1.4 cleanup-scope bugs including
  ZFS vdev resolution, WS1.5 dead MD-scan + single-namespace fallback, WS1.6
  §7.2 wording) are fixed on branch `worktree-ws1-storage-residuals`
  (e67b8d7, 8b8a78e, 7140314, 7612e42, 845d8b0, bc4e0dd, efe48b2, f55295c,
  7e1aafe). WS1.7 (ship as a release, verify on a lab box) and WS1.8
  (per-drive n1+n2 validation) remain open.
- **Fixed on main since the review**: WS4 snapshot-ID collision (models.py —
  microsecond ids, 7cdb7c6); WS3 update-apply uses `git checkout --force` on
  the Python path plus an orchestration test (d5e0257) — the bash menu paths
  still use a plain checkout; the fabricated-license recovery was fixed in
  startup_menu.sh (7260810) but **simple_menu.sh:691 is still open**; WS5
  mcp.py toggle path now audits honestly (`_restart` still open); WS7
  perf_tuning GRUB accumulation panic fixed (08f32fc; the changed-flap
  remains).
- **Narrowed**: WS4 runner.py:519 netplan flush already loops tables 100-199
  and flushes mlx IPs (4683001, predates the review's evidence); the
  remaining gap is only that it deletes one `ip rule` per table instead of
  draining duplicates.
- **In flight on a branch**: WS5 raid.py:115 envelope-warning surfacing
  (branch claude/happy-knuth-84c624).
- **Everything else in WS2-WS9 re-verified STILL-OPEN** at 4ef129d,
  including both WS2 uninstall data-safety items, the WS3 installer errexit
  bug, all WS6 security items, and the WS9 release-policy violations.

## Sequencing constraint (read first)

The TUI update flow re-runs `ansible-playbook site.yml --tags <role>` when a
release's notes carry `Requires-Rebuild:` trailers. Until WS1 lands, a
`Requires-Rebuild: raid_fs` (or `nvme_namespace`, or `all`) release **reformats
customer data**. Therefore:

1. WS1 must be the first storage-role change to ship, and its release must be
   published before any other release that carries storage-role rebuild
   trailers.
2. WS1's own release must NOT carry `Requires-Rebuild: raid_fs` /
   `nvme_namespace` — flipping the defaults takes effect on the *next* Ansible
   run; forcing a rebuild against old code is exactly the hazard being fixed.
3. WS2 (uninstall + history-store deletion) is second: also
   destructive-on-re-run.

---

## WS1 — Storage-reset safety (C1) — CRITICAL, land first

**Owning specs:** `docs/Installer/raid-spec.md`; detailed design + plan already
written: `docs/superpowers/specs/2026-07-06-storage-reset-safety-design.md`,
`docs/superpowers/plans/2026-07-06-storage-reset-safety.md` (commits 1c15c4c,
6832b37, dff7e98).

> **Status 2026-07-08:** LANDED on main (0143bfb..63cb2ab) except the
> residual items, which are fixed on branch `worktree-ws1-storage-residuals`;
> WS1.7 (release + lab verification) and the WS1.8 follow-up remain. The
> table below is kept as review history; at review time nothing had landed
> (`grep -r xinas_storage_reset collection/` was empty).

**Findings covered:**

| Sev | Location | Defect |
|-----|----------|--------|
| critical | `collection/roles/raid_fs/defaults/main.yml:16`, `presets/default/raid_fs.yml:16`, `presets/xinnorVM/raid_fs.yml:11` | `xfs_force_mkfs: true` by default → `mkfs.xfs -f` on every run (`create_fs.yml:91`); the role even stops nfs-server and unmounts the live FS to let the reformat succeed |
| critical | `inventories/lab.ini:2` | `xfs_force_mkfs=true` pinned at inventory host-var precedence — outranks presets/defaults, so the documented off-switch is silently ignored (`ansible.cfg:2` makes lab.ini the default inventory) |
| critical | `collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml:34` | `nvme_use_existing_namespaces: false` default → `nvme delete-ns` for every namespace on every data drive on every run; the only YES prompt (`cleanup_storage.yml:165-192`) fires solely for LVM/MD/ZFS — a healthy xiRAID+XFS box gets no prompt |
| critical | `collection/roles/raid_fs/tasks/main.yml:51` | `xicli drive clean -d {{ item }}` runs unconditionally on every run |
| medium | `collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml:55` | with default `nvme_skip_failed_devices=true`, delete-ns failures are untracked → create-ns proceeds on a drive still holding old namespaces |
| medium | `collection/roles/nvme_namespace/tasks/cleanup_storage.yml:278-291` | when ONE drive has an LVM/MD/ZFS artifact, wipefs+dd runs on ALL data drives; the confirmation banner never says this |
| medium | `collection/roles/nvme_namespace/tasks/cleanup_storage.yml:98` | ZFS detection only matches vdevs named `nvme*`/`sd*` — pools on `vdX` (the xinnorVM preset's own device type) or by-id vdevs are missed and destroyed unprompted |
| low | `collection/roles/nvme_namespace/tasks/detect_existing_namespaces.yml:40` | single-namespace fallback is dead code (empties `nvme_small_ns_devices`, failing main.yml's Phase 7 gate) |
| low | `collection/roles/raid_fs/tasks/main.yml:118` | "Find active MD RAID arrays" passes a shell pipeline to `ansible.builtin.command` → always fails, masked by `failed_when: false`; `mdraid_scan` never consumed |

**Tasks:**

- [x] **WS1.1** Execute the existing C1 plan
  (`docs/superpowers/plans/2026-07-06-storage-reset-safety.md`) as written:
  storage-state detection (MATCH / EMPTY / FOREIGN), the `xinas_storage_reset`
  gate variable, gated namespace rebuild / drive clean / MD sweep / `mkfs -f`,
  confirmation enforced in both `nvme_namespace` and `raid_fs`, plus the safety
  test file it specifies (`tests/test_raid_fs_safe_defaults.py`).
- [x] **WS1.2** Remove `xfs_force_mkfs=true` from `inventories/lab.ini:2`
  (leave `localhost ansible_connection=local`). Grep for other inventory-level
  pins: `grep -rn "xfs_force_mkfs\|nvme_use_existing" inventories/`.
- [x] **WS1.3** Flip `xfs_force_mkfs` to `false` in the role defaults **and both
  presets**; flip `nvme_use_existing_namespaces` handling per the C1 design
  (rebuild only when state ≠ MATCH and the gate is set).
- [x] **WS1.4** Fix the cleanup-scope bugs while in the area: track delete-ns
  failures and skip create-ns on those drives (`rebuild_namespaces.yml:55`);
  fix the wipe step (`cleanup_storage.yml:278-291`) — it currently loops
  `nvme_data_drives`, which holds controller char devices (`/dev/nvmeX`) in
  the default mode, so wipefs/dd silently no-op; it must resolve the block
  namespaces, wipe only drives with detected artifacts (or state the full
  scope in the YES banner); widen ZFS vdev matching to resolve pool member
  devices instead of name-prefix matching (`cleanup_storage.yml:98`).
- [x] **WS1.5** Delete the broken MD-scan task (`raid_fs/tasks/main.yml:117-122`)
  — the correct shell-based scan at line 124 stays; or convert it to
  `ansible.builtin.shell` and actually consume the register. Fix the dead
  single-namespace fallback (`detect_existing_namespaces.yml:40`) or remove it
  and document the constraint in `raid-spec.md`.
- [x] **WS1.6** Update `docs/Installer/raid-spec.md` §7.2: the license-recovery
  remedy ("re-run with `--tags raid_fs`") must state the new gate behavior.
- [ ] **WS1.7** Ship as a release with **no storage rebuild trailers**; verify
  on a lab box: populate `/mnt/data`, re-run `site.yml`, confirm data intact
  and play reports MATCH/no-op.
- [ ] **WS1.8** (follow-up found during WS1-R4 review) Per-drive n1+n2
  validation in existing-namespace reuse: a MIXED layout — some drives
  n1-only, others n1+n2 — passes both the explicit-fail gate ("no n2
  anywhere") and the Phase-7 gates ("both lists non-empty") and proceeds to
  build asymmetric arrays. Validate the layout per drive
  (`detect_existing_namespaces.yml`) and fail listing the offending drives.

## WS2 — Uninstall & history-store safety — HIGH

**Owning specs:** `docs/Installer/uninstall-spec.md`,
`docs/config-history/specs.md`.

| Sev | Location | Defect |
|-----|----------|--------|
| high | `collection/roles/xinas_history/tasks/main.yml:11` | role deletes the entire config-history store (snapshots, baseline, state) on every run — any day-2 `site.yml` re-run destroys rollback history |
| high | `uninstall.sh:233` | `--dry-run` still runs the unconditional `rm -rf "$INSTALL_DIR"` |
| high | `collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml:39-63,86` | teardown parses ALL array/pool names from `xicli raid show` — destroys arrays xiNAS does not manage; spec §4.3 scopes consent to xiNAS-managed names (baseline or name-match) |
| medium | `collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml:110` | `xicli drive clean` loops `/dev/nvme[0-9]*n[0-9]*` — includes the OS disk namespace, no system-drive exclusion |
| medium | `docs/Installer/uninstall-spec.md:259` (§4.3.5) | conditional NVMe namespace re-consolidation is specified but not implemented (no namespace ops anywhere in `xinas_uninstall`) |
| medium | `collection/roles/xinas_uninstall/tasks/70_remove_paths.yml:31` | removes `/etc/cron.d/xinas-banner`, but motd role installs the banner via root's crontab (cron module) — job survives uninstall |
| low | `uninstall.sh:73` | any single `--remove-*` flag disables ALL interactive prompting, contrary to the in-file comment and spec |

- [ ] **WS2.1** `xinas_history` role: make store creation idempotent — create
  dirs only if absent; never delete `/var/lib/xinas/config-history/` content.
  Add a regression test asserting the tasks contain no `state: absent` on the
  store path.
- [ ] **WS2.2** `uninstall.sh`: guard every destructive step (including the
  `rm -rf "$INSTALL_DIR"`) behind the dry-run check; make `--remove-*` flags
  answer only their own question, leaving other prompts interactive.
- [ ] **WS2.3** `30_teardown_raid.yml`: filter parsed names against
  xiNAS-managed names per spec §4.3 (baseline snapshot first, fallback
  name-match `data`/`log`/`*_spare_pool`); exclude the system drive from the
  drive-clean loop (reuse `nvme_namespace`'s system-drive detection).
- [ ] **WS2.4** motd/uninstall cron mismatch: pick one location (prefer
  `/etc/cron.d/xinas-banner`, no user crontab) and make install+uninstall
  symmetric.
- [ ] **WS2.5** §4.3.5 re-consolidation: implement, or amend the spec to state
  it is not performed and why (decision needed — implementing requires the
  baseline to record the pre-install namespace layout).

## WS3 — Installer & update flow correctness — HIGH

**Owning specs:** `docs/Installer/update-spec.md`, `docs/Installer/spec.md`.

| Sev | Location | Defect |
|-----|----------|--------|
| high | `prepare_system.sh:184-194` (+ `set -e` at :4) | menus exit 2 on normal Exit; under errexit the shell dies before `status=$?` — the exit-2 handling is dead code and `install.sh:251` aborts before installing `/usr/local/bin/xinas-menu` |
| high | `simple_menu.sh:691` | "license recovery" writes `xicli license show` output (no key material) to `/tmp/license`; the fabricated file is later fed to `xicli license update` |
| medium | `startup_menu.sh:144` | `check_for_updates &` sets `UPDATE_AVAILABLE`/`UPDATE_TARGET_TAG` in a subshell — parent menu never sees them |
| medium | `startup_menu.sh:102`, `install.sh:238`, all bash update paths | plain `git checkout <tag>` on a tree that preset materialization dirties by design — update-spec §"apply" mandates `git checkout --force` |
| medium | `menu_lib.sh:1133` | install-failure dialog offers "Collect Logs (auto-uploads…)" but the choice is a dead-end handled identically to close |
| medium | `install_client.sh:158` | update path swallows git failures with `\|\| true`, then reports "Client updated to <tag>" |
| medium | `autoinstall.sh:235` | no `set -e`, `copy_if` cp status unchecked → failed preset copy provisions with stale RAID/net config |
| medium | `xinas_menu/utils/update_check.py:368` | NFS-helper sync ignores service-restart result; in the documented unprivileged (xinnor) deployment it fails after checkout — update half-applied |
| low | `startup_menu.sh:78` | update detection is string inequality of tags → offers downgrades; spec mandates semver compare |
| low | `startup_menu.sh:251` | `./hwkey` non-zero inside the license pipeline kills the whole menu under `set -euo pipefail` |
| low | `prepare_system.sh:108` | yq fetched from `releases/latest`, no pin/checksum, hardcoded amd64 |
| low | `xinas_menu/utils/update_check.py:35` | undocumented `XINAS_UPDATE_REPO` env var can redirect the production update source |

- [ ] **WS3.1** Fix the errexit bug: `status=0; ./simple_menu.sh || status=$?`
  (same for `startup_menu.sh` call sites); add a bats/shell test or at minimum
  a `bash -n` + scripted exit-2 harness under `tests/`.
- [ ] **WS3.2** Remove the fabricated-license path in `simple_menu.sh:691`
  (recovery must instruct the user to re-enter the real key; never synthesize
  `/tmp/license`).
- [ ] **WS3.3** `startup_menu.sh`: write update-check results to a temp file
  the parent reads, or run the check synchronously with a short timeout;
  switch tag comparison to the same semver rule as `update_check.py`; use
  `git checkout --force <tag>` in every bash apply path (matches spec).
- [ ] **WS3.4** `install_client.sh`: propagate git failures, report accurately.
  `autoinstall.sh`: `set -euo pipefail` + check `copy_if`.
  `prepare_system.sh:108`: pin yq to a tested version + sha256, select the
  binary by `uname -m`.
- [ ] **WS3.5** `menu_lib.sh:1133`: wire the collect choice to
  `collect_data.sh` (after WS6 fixes its transport) or drop the option.
- [ ] **WS3.6** `update_check.py:368`: check the restart result; on failure,
  surface "updated, helper restart failed — run <cmd>" instead of silence.
  Either document `XINAS_UPDATE_REPO` in update-spec.md (dev-only, off by
  default) or drop it. Add an orchestration test for
  `prompt_and_apply_update`/`_apply_update` (checkout → rebuild → rc≠0 keeps
  code, no restart), which is currently untested.

## WS4 — `xinas_history` hardening (the safety net itself) — HIGH

**Owning spec:** `docs/config-history/specs.md` (+ `requirements.md`). This
workstream needs its own detailed TDD plan before execution; the library is the
rollback mechanism everything else leans on.

| Sev | Location | Defect |
|-----|----------|--------|
| high | `xinas_history/runner.py:519` | netplan reconverge flush deletes only one PBR rule per table, never flushes tables 100-199 or mlx IPs — diverges from the binding apply sequence |
| high | `xinas_history/engine.py:176` | GC can delete the snapshot being restored mid-restore (`in_progress_ids` never populated, GC takes no lock) → restore silently degrades |
| medium | `xinas_history/runner.py:257` | post-apply validation vacuous: `expected_state` never passed; validator gets the PRE-change manifest |
| medium | `xinas_history/engine.py:150` | every snapshot created `status=applied`; PENDING unused → ephemeral pre-change snapshots never GC'd |
| medium | `xinas_history/lock.py:305` | stale-lock recovery clears meta/journal without holding the flock (TOCTOU); EPERM treated as "process gone" |
| medium | `xinas_history/store.py:128` | crash during `write_snapshot` leaks `.tmp-*` dir containing a valid manifest → listed as a real applied snapshot |
| medium | `xinas_history/store.py:251` | no snapshot-id validation — `..`/absolute ids escape the store; `delete_snapshot` will rmtree outside it |
| medium | `xinas_history/classifier.py:151` | unknown operation types classified NON_DISRUPTIVE — new destructive ops get the no-confirmation path |
| medium | `xinas_history/models.py:327` | 1-second-resolution snapshot IDs + same slug → sub-second apply collides pre/applied snapshots |
| medium | `xinas_history/drift.py:458` | mount-unit drift compares only live active/sub state, not unit-file content as spec requires |
| low | `xinas_history/lock.py:127` (+5 more) | `datetime.utcnow()` deprecated — 20 DeprecationWarnings across the test suite |

- [ ] **WS4.1** Write `docs/plans/2026-MM-DD-xinas-history-hardening-plan.md`
  covering the table above with TDD tasks (each fix has an obvious failing
  test: traversal id, tmp-dir listing, GC-during-restore, classifier default,
  ID collision, lock TOCTOU).
- [ ] **WS4.2** Quick safe fixes that need no design: reject snapshot ids not
  matching `^[A-Za-z0-9._-]+$` in `store.py`; filter `.tmp-*` in
  `list_snapshots`; flip classifier default to `DESTROYING_DATA` (fail safe);
  replace `utcnow()` with `datetime.now(timezone.utc)`; add a monotonic
  suffix/UUID to snapshot IDs.
- [ ] **WS4.3** The netplan reconverge flush (`runner.py:519`) must reuse or
  mirror the one authoritative flush implementation (see WS7 note on
  spec-network-management ownership) — loop `while ip rule del` per table
  100-199 and flush mlx IPs, same as `net_controllers`.
- [ ] **WS4.4** Sync `docs/config-history/specs.md` §11 with the real CLI
  (`snapshot rollback`, `drift check`, `lock status|clear` documented but not
  implemented; `snapshot restore`/`reset-to-baseline` exist) and
  `requirements.md:58` retention language with the implemented GC policy —
  or implement the missing subcommands (decision needed).

## WS5 — Python TUI correctness — HIGH

**Owning specs:** `docs/Storage/*.md`, `docs/Management/*.md`.

| Sev | Location | Defect |
|-----|----------|--------|
| high | `xinas_menu/screens/nfs.py:655` | `_remove_share` is async without `@work` — "Remove Share" creates a never-awaited coroutine; the feature silently does nothing |
| medium | `xinas_menu/screens/config_history.py:408` | Reset-to-Baseline progress callback calls `call_from_thread` from the event-loop thread → always RuntimeError, silently suppressed |
| medium | `xinas_menu/screens/nfs.py:882` | `_format_exports` runs blocking `df` per share (no timeout) on the event loop — TUI freezes if any export FS hangs |
| medium | `xinas_menu/screens/raid.py:1086` | delete/teardown worker sequences cancel silently on any keypress/Escape mid-sequence, after mutations started |
| medium | `xinas_menu/screens/raid.py:115` | `_list_api_disks` drops envelope warnings → degraded Disk collector shows "No available NVMe" with no cause |
| medium | `xinas_menu/screens/quick_actions.py:165` | btop launched in an executor thread without suspending the app — terminal corruption |
| low | `xinas_menu/screens/mcp.py:371` | unconditional "OK" audit record even when helper restart failed |
| low | `xinas_menu/utils/op_tracker.py:62` | OpTracker/OpStatusWidget + two `@work` methods are dead code |
| low | `xinas_menu/api/grpc_client.py:152` | OS-disk detection inspects one lsblk level — LVM/MD/ZFS-rooted hosts don't flag the OS drive in Drive picker |
| low | `xinas_menu/utils/xfs_helpers.py:174` | dead destructive code (unconditional `mkfs.xfs -f`) with no callers |
| low | `xinas_menu/health/remediation.py:288` | remediation commands run with no timeout and inherited stdin — a prompting command hangs the wizard |

- [ ] **WS5.1** `_remove_share`: decorate with `@work` (match the other
  mutating methods in nfs.py); add a screen test that the menu action
  schedules the worker.
- [ ] **WS5.2** Thread-safety pass: fix `config_history.py:408`
  (`call_from_thread` only from workers; direct call otherwise); move the `df`
  calls in `nfs.py:882` into a worker with `timeout=`; suspend the app around
  btop (`app.suspend()`).
- [ ] **WS5.3** raid.py: make teardown workers `exclusive=True` and
  non-cancellable by stray input (confirm-then-run-to-completion, disable
  bindings while running); surface envelope warnings in the empty-disk state.
- [ ] **WS5.4** Small fixes: audit record honesty in `mcp.py:371`; deepen
  OS-disk detection (recurse lsblk children — mirror the fix pattern from
  commit 691ef7d); add timeout+`stdin=DEVNULL` in `remediation.py:288`.
- [ ] **WS5.5** Delete dead code: `op_tracker.py`/`OpStatusWidget` consumers,
  `xfs_helpers.py:174` block (grep callers first: `grep -rn "xfs_helpers\|OpTracker" xinas_menu/`).

## WS6 — Security — HIGH (two items), rest MEDIUM/LOW

| Sev | Location | Defect |
|-----|----------|--------|
| high | `client_repo/client_setup.sh:2896` | CSI driver install pipes an unpinned master-branch script to root bash with `curl -k` (TLS off) |
| medium | `collect_data.sh:62` | uploads install logs, hardware inventory, hwkey, user email over plaintext HTTP to a hardcoded public IP, no consent screen |
| medium | `xinas_menu/utils/email_sender.py:58` | STARTTLS without certificate validation |
| low | `simple_menu.sh:691` | root writes `/tmp/license` via symlink-following ops at a predictable world-writable path |
| low | `client_repo/lib/gds_state.sh:66` | root truncate-writes fixed `/tmp/.xinas-gds-state.json`; no-jq branch follows planted symlinks |
| low | `post_install_menu.sh:1871`, `configure_nfs_exports.sh:54` | user input string-embedded into root shell / yq expressions |

- [ ] **WS6.1** CSI install: pin the upstream script to a release tag + sha256
  check; remove `-k` (fix the CA problem it papered over, or vendor the
  script).
- [ ] **WS6.2** `collect_data.sh`: HTTPS with verification, explicit consent
  dialog enumerating what is sent (also unblocks WS3.5). If the endpoint can't
  do TLS, gate upload behind an explicit `--i-understand-plaintext` flag.
- [ ] **WS6.3** `email_sender.py`: `smtplib` with
  `context=ssl.create_default_context()`.
- [ ] **WS6.4** License/tmp handling: write license and gds-state under
  `/run/xinas/` (0700, root) or use `mktemp`; keep `/tmp/license` only as a
  documented compat read path. Note: `/tmp/license` location is baked into
  presets (`xiraid_license_path`) and docs — change spec + presets together
  (spec-first rule).
- [ ] **WS6.5** Quote/validate user input in the two injection sites (or fold
  into WS8's deprecation of those scripts).

## WS7 — Ansible roles robustness & policy — MEDIUM

**Owning specs:** `docs/Network/spec-network-management.md`,
`docs/Installer/spec.md`.

| Sev | Location | Defect |
|-----|----------|--------|
| high | `collection/roles/common/templates/unattended-upgrades.conf.j2:6` | `Automatic-Reboot "true"` — a NAS reboots itself on security updates |
| medium | `collection/roles/xinas_node_build/tasks/main.yml:115` | `npm ci` + build run unconditionally — every re-run rebuilds; hard-fails offline |
| medium | `collection/roles/xinas_menu/tasks/main.yml:38` | pip `state: latest` → PyPI contact every run; air-gapped day-2 runs fail |
| medium | `collection/roles/doca_ofed/defaults/main.yml:2` | floats on NVIDIA "latest" repo alias; signing key re-downloaded `force: true` every run |
| medium | `collection/roles/common/tasks/main.yml:94` | hwkey hostname chain: opaque abort when hwkey fails; empty string passed to hostname module on partial success |
| low | `collection/roles/doca_ofed/defaults/main.yml:14` | `ib_netplan_template` defaults to stale `/opt/provision` path — udev rename rules silently never generated on release installs |
| low | `collection/roles/perf_tuning/tasks/main.yml:24` | GRUB strip-then-re-add flaps changed every run |

- [ ] **WS7.1** Flip `Automatic-Reboot` to `"false"` (keep unattended security
  installs). One-line template change + `Requires-Rebuild: common`.
- [ ] **WS7.2** Idempotence/offline: guard `npm ci`/build with a
  dist-freshness check (compare git rev or package-lock hash marker file);
  pin pip installs (`state: present` + version range from `pyproject.toml`);
  pin `doca_ofed` repo to the version already in `doca_ofed_version` and drop
  `force: true` on the key.
- [ ] **WS7.3** hwkey chain: fail with a clear message naming hwkey as the
  cause; skip hostname change when the derived name is empty.
- [ ] **WS7.4** Fix `ib_netplan_template` default to the real install path;
  make perf_tuning GRUB edit idempotent (`lineinfile` with a stable
  assembled value instead of strip+append).

## WS8 — Deprecated day-2 shell scripts — MEDIUM (policy-driven)

Policy: these scripts must not gain features; the dangerous paths must not
stay. Prefer **removal/redirect** over repair.

| Sev | Location | Defect |
|-----|----------|--------|
| medium | `post_install_menu.sh:233` | its updater overwrites `/usr/local/bin/xinas-menu` (the Python TUI entry point) with the 3400-line bash script |
| medium | `post_install_menu.sh:1004` | writes interface config into the first non-xinas netplan file when 99-xinas.yaml is absent (ownership violation) |
| medium | `post_install_menu.sh:1198` | bare `netplan apply` without PBR/IP flush (ownership violation) |
| medium | `post_install_menu.sh:1108` | edit-IP replaces the interface mapping, discarding routes/PBR/MTU |
| low | `configure_network.sh:68` | rewrites net_controllers defaults from a hardcoded template, dropping `net_manual_ips`, `net_mtu`, detection flags |
| low | `healthcheck.sh:1839` | Deep Check options checklist result never used |

- [ ] **WS8.1** Decision (Sergey): hard-deprecate — replace the
  netplan-editing and self-update code paths in `post_install_menu.sh` with a
  message pointing to `xinas-menu`, rather than fixing them. Keeps the file as
  a thin shim; removes both ownership violations and the wrapper-overwrite bug
  in one move.
- [ ] **WS8.2** If shim: also neuter `configure_network.sh` save-path (print
  redirect message). If repair instead: apply the flush sequence + 99-xinas
  ownership from `spec-network-management.md` and preserve unknown keys.
- [ ] **WS8.3** `healthcheck.sh`: honor the checklist selection (pass chosen
  checks to the runner) — small, worth fixing regardless.

## WS9 — Release policy, client_repo, docs & tests — MEDIUM

**Release policy (owning spec `docs/Installer/update-spec.md`):**

| Sev | Location | Defect |
|-----|----------|--------|
| high | `install.MD:33` | primary install doc instructs bootstrap from raw-main URLs — violates the Releases-only contract |
| medium/low | `startup_menu.sh:363` | expert menu "Git Repository Configuration" clones/pulls arbitrary branches (default `main`) and repoints provisioning |
| low | `client_repo/client_setup.sh:4335` | reinstall hint points at `https://xinnor.io/install_client.sh` instead of the release asset |

- [ ] **WS9.1** Rewrite `install.MD` to the release-asset one-liner
  (`releases/latest/download/install.sh`); fix the client hint URL. Gate
  `configure_git_repo` behind an explicit dev flag (env var documented as
  dev-only) or remove it from the menu.

**client_repo:**

| Sev | Location | Defect |
|-----|----------|--------|
| high | `client_repo/collection/roles/doca_ofed/defaults/main.yml:1` | `doca_distro_series` hardcoded `ubuntu24.04` — breaks 22.04 clients |
| medium | `client_repo/client_setup.sh:1202` | fstab persistence indexes `server_ips` by success count → writes the wrong (failed) IP on partial trunked success |
| medium | `client_repo/client_setup.sh:1203` | fstab uses `hard` without `nofail`/`bg`, one line per trunked IP for the same mountpoint → boot hangs when NAS is down |
| medium | `client_repo/client_setup.sh:4054` | client netplan apply never flushes stale IPs |
| low | `client_repo/lib/menu_lib.sh:668` | stale fork of `lib/menu_lib.sh`, missing upstream input-handling fixes |

- [ ] **WS9.2** Derive `doca_distro_series` from `ansible_distribution_version`
  (mirror the main-repo role); fix the fstab index bug (iterate successes with
  their IPs, not counters); add `nofail` (+ document `bg`/`_netdev` choice) and
  collapse trunked mounts to the spec'd multi-IP form; port the flush sequence
  to client netplan apply; sync `menu_lib.sh` from the main repo (or vendor it
  at build time to prevent re-drift).

**Docs (spec-first hygiene):**

- [ ] **WS9.3** Root `CLAUDE.md`: fix "10 Ansible roles" → 20 (list them),
  replace "No build/test system" with the actual pytest/ruff/CI reality.
  `README.md:195`: stop labeling `startup_menu.sh`/`simple_menu.sh` deprecated
  (contradicts CLAUDE.md's installer-surface contract).
- [ ] **WS9.4** Refresh stale specs to S8 reality:
  `docs/Installer/spec.md` (preset playbook DOES list `nvme_namespace`;
  site.yml order includes `xinas_node_build`/`xinas_api`/`xinas_agent`/
  `xinas_nfs_helper`), `docs/Network/spec-network-management.md` writers/code-path
  tables (TUI now delegates to the control-path API per ADR-0010 — name the
  API executor as the owner of render/flush/apply).
- [ ] **WS9.5** Move the C1 design/plan from `docs/superpowers/{specs,plans}/`
  to `docs/Installer/` (design content merged into `raid-spec.md`) and
  `docs/plans/` (plan file), leaving no active docs outside the CLAUDE.md map.
- [ ] **WS9.6** MCP node fixes: bound + time-expire the `/mcp` session map
  (`xiNAS-MCP/src/api/mcp/transport.ts:56`); derive XFS quota project ids
  deterministically (hashlib, not Python's randomized `hash()`) in
  `xiNAS-MCP/nfs-helper/nfs_helper.py:140`.
- [ ] **WS9.7** Test gaps (from CI review; CI itself exists and is green):
  storage-safety gating tests land with WS1; netplan flush/ownership invariant
  test (assert `net_controllers` task list contains the flush before apply);
  update-apply orchestration test lands with WS3.6.

---

## Suggested landing order & release cadence

1. **Release A (safety):** WS1 + WS2 (+ WS7.1 reboot flip). No storage rebuild
   trailers in this release.
2. **Release B (flows):** WS3 + WS5 + WS6.2/6.3.
3. **Release C (hardening):** WS4 (after its detailed plan) + WS7.2-7.4 +
   WS9.6.
4. **Release D (cleanup):** WS8 + WS9 remainder. Docs-only parts of WS9 can
   ride any release.

Per-commit: follow `Requires-Rebuild:` rules (role changes in WS2/WS7 need
their role tags; WS1 deliberately ships without storage trailers, see
Sequencing constraint). Every code change updates its owning spec in the same
change (spec-first rule).

## Excluded (genuinely refuted during verification)

- `disk_match.sh` staged at a world-writable path — refuted (staging dir is
  root-owned with safe perms).
- Three others were duplicates refuted in one area but confirmed with
  corrected details in another; the corrected versions appear above.
