# Presets as overlays, not file replacements

**Date:** 2026-08-18
**Status:** Design, revision 2 (revised after review; see §12)
**Area:** Installer (`docs/Installer/spec.md` §1 is the durable spec this change makes true)

## 1. Problem

`docs/Installer/spec.md` §1 states that a preset is "a small set of YAML/J2
files that override role defaults", and its parameter tables read "effective
values come from each role's `defaults/main.yml`, overridden where a preset
explicitly sets a different value". The implementation does something else: it
overwrites the role's `defaults/main.yml` wholesale with the preset file.

```bash
# startup_menu.sh:592 — and identically in simple_menu.sh and autoinstall.sh
cp "$pdir/nvme_namespace.yml" "collection/roles/nvme_namespace/defaults/main.yml"
```

Under replacement semantics a preset does not override the defaults, it *is*
the defaults. Any key the preset omits ceases to exist.

That turned a correct refactor into an install blocker. Commit `fff7d0f`
replaced the per-level minimum-drive scalars with a `nvme_raid_min_devices`
table plus an `nvme_raid_min_devices_default` fallback, put both in the role
defaults, and updated `presets/xinnorVM/nvme_namespace.yml` to stop overriding
minimums — correct under the documented overlay model. Under replacement, the
VM preset's file became the defaults, and it carries neither the table nor the
fallback. Every `site.yml` run on a VM then aborts in `nvme_namespace`:

```
'nvme_raid_min_devices_default' is undefined
collection/roles/nvme_namespace/tasks/generate_raid_config.yml, line 31
```

`presets/default/` ships no `nvme_namespace.yml`, so the role defaults survive
there and physical nodes are unaffected. `suggest_vm_preset()` applies
`xinnorVM` automatically when `systemd-detect-virt` reports a VM, so the
failure reaches VM installs without anyone choosing the preset by hand.

The same class is already visible elsewhere and merely happens to be harmless
today: both `presets/*/network.yml` omit `net_detect_infiniband` and
`net_detect_mlx5`, so applying any preset deletes them from the
`net_controllers` defaults. Nothing breaks only because no task in the role
reads either key. `configure_network.sh:68` rewrites the same file with
`cat >`, dropping whatever it does not itself emit.

Two further consequences follow from writing to git-tracked files at all:

**Every update already discards the applied configuration.** Because the
installed tree is dirty by design, the update flow cannot use a plain checkout
and uses `git checkout --force` instead — `xinas_menu/utils/update_check.py:570`
and `collection/roles/xinas_menu/files/xinas-update-git:36`, both of which say
so in comments. Forcing discards local modifications to tracked files, which is
exactly where the preset and every config-editor edit live. So on each update
the node silently reverts to the release's role defaults. The overlay fixes
this: it is untracked, and `--force` leaves untracked files alone.

**`save_preset` freezes a snapshot.** It copies the mutated `defaults/main.yml`
into the new preset, so a saved preset is a full copy of the defaults as they
were that day — the divergence returns with the next refactor, through the
preset the operator just created.

A permanently dirty `git status` also hides real corruption; diagnosing the
original failure cost significant time for that reason.

## 2. Goals and non-goals

**Goals**

1. A preset overrides role defaults and cannot delete a key by omitting it.
2. A key added to a role's `defaults/main.yml` reaches every preset with no
   per-preset edit.
3. A preset written by a third party cannot break a role by being incomplete.
4. No runtime writes to git-tracked files — neither defaults nor templates.
5. Configuration survives an update instead of being reset by `checkout --force`.
6. One implementation of preset application, not three.
7. The overlay works with any `--inventory`, which `autoinstall.sh:125` allows.
8. `xinas_history` snapshots the new source of desired state.

**Non-goals**

- The Python TUI. It does not write role defaults; nothing to change.
- Removing the dead `net_detect_*` keys. Recorded in `docs/TODO.md` instead.
- Any change to `-e` extra-vars handling.

## 3. Layer model

Four layers, lowest first:

| Layer | Path | Written by | Tracked |
|---|---|---|---|
| Role defaults | `collection/roles/*/defaults/main.yml` | commits only | yes |
| Preset overlay | `playbooks/group_vars/all/10-preset.yml` | preset apply | no |
| Local overlay | `playbooks/group_vars/all/20-local.yml` | config editors | no |
| Extra-vars | `-e` on the command line | callers | n/a |

The overlay lives next to the **playbook**, not next to the inventory. Ansible
resolves `group_vars` relative to both the inventory directory and the playbook
directory, and only the playbook side is fixed: `autoinstall.sh:125` accepts
`--inventory PATH`, so an inventory-adjacent overlay disappears whenever a
caller supplies its own inventory.

Measured on ansible-core 2.21.0 rather than assumed:

| Scenario | `playbooks/group_vars` | `inventories/group_vars` |
|---|---|---|
| `site.yml` with the repo inventory | loaded | loaded |
| `site.yml` with an external `-i` | **loaded** | absent |
| A playbook outside `playbooks/`, run in place | absent | absent |
| A wrapper in `playbooks/` using `import_playbook` | **absent** | absent |

The last row rules out the obvious workaround: `group_vars` resolve against the
directory of the *imported* playbook, not the importing one, so a wrapper in
`playbooks/` cannot lend its `group_vars` to a preset playbook elsewhere. This
is what forces §4's decision to always run `playbooks/site.yml`.

Also measured: `20-local.yml` beats `10-preset.yml` (files in `group_vars/all/`
merge alphabetically, later wins); a key absent from both overlay files falls
back to the role default; `-e` still overrides everything.

**Resolved ambiguity.** Re-applying a preset rewrites `10-preset.yml` only.
Operator edits made through the config editors live in `20-local.yml`, survive
the re-apply, and win. Today a re-apply silently discards them. If a full reset
is wanted later it is one `rm` in `apply_preset`; this design chooses
persistence because the alternative destroys work without saying so.

Non-variable artefacts that must not be written into the repo — currently only
the live netplan template (§5) — go to `.xinas-local/` at the repo root.
`playbooks/group_vars/all/` and `.xinas-local/` are both added to `.gitignore`.

## 4. Preset application

`apply_preset` stops copying over tracked files. Per preset directory:

| Preset file | Today | After |
|---|---|---|
| `network.yml` | `cp` → `net_controllers/defaults/main.yml` | merged into `10-preset.yml` |
| `raid_fs.yml` | `cp` → `raid_fs/defaults/main.yml` | merged into `10-preset.yml` |
| `nvme_namespace.yml` | `cp` → `nvme_namespace/defaults/main.yml` | merged into `10-preset.yml` |
| `nfs_exports.yml` | `cp` → `exports/defaults/main.yml` | merged into `10-preset.yml` |
| `playbook.yml` `vars:` | `cp` → `playbooks/site.yml` | merged into `10-preset.yml` |
| `netplan.yaml.j2` | `cp` → `net_controllers/templates/` | branch removed; no preset may ship one (§5) |

The var files merge into one `10-preset.yml` with
`yq eval-all '. as $item ireduce ({}; . * $item)'`. They are already disjoint by
role prefix, and one file makes the overlay trivially inspectable.

**Presets contribute variables, not play structure.** `playbooks/site.yml` is
always the playbook that runs. A preset's `playbook.yml` contributes its play
`vars:` — `presets/xinnorVM/playbook.yml` sets `perf_disable_cpupower: true` and
`perf_nr_requests: 0` — which move into `10-preset.yml`. Its role list does not
contribute anything the overlay cannot: both preset playbooks list exactly the
roles `site.yml` lists, in the same order. A test pins that equality so the
narrowed contract cannot be violated silently, and the file stays as
documentation of the preset's intent.

The role lists match, but the files do not, and the difference is a live bug.
`playbooks/site.yml:10` guards `xiraid_classic` with
`when: not (xiraid_skip_install | default(false) | bool)`; neither preset
playbook carries that guard. Both callers that set the flag — `autoinstall.sh`
for `--preset existing-raid`, which resolves to the `default` preset directory,
and the equivalent branch at `startup_menu.sh:545`–`547` — apply the preset
first and pass `-e xiraid_skip_install=true` afterwards, to a `site.yml` whose
guard the copy has just deleted. `xiraid_classic` therefore runs on both
existing-RAID paths and the flag is inert. Always running the repository's
`site.yml` restores it, so this is a third defect the root fix closes rather
than a regression risk it introduces.

Note that moving play `vars:` into the overlay lowers their precedence from
play-vars level to group-vars level. Nothing in the tree sets those two keys at
any layer in between, and the change makes them overridable by an operator edit
in `20-local.yml`, which is the intended behaviour.

Overwriting `playbooks/site.yml` was the crudest of the six copies: it mutates
the repository's primary entry point, and it is why `playbooks/site.yml` shows
as modified on installed nodes.

`docs/Installer/spec.md` lines 24 and 80 state that `nvme_namespace` is not
listed in the default preset's playbook and that the menu therefore relies on
`site.yml` to run it. Both preset playbooks do list `nvme_namespace`, and the
copy means the preset's playbook is what runs regardless. The note is stale and
is corrected as part of §11.

## 5. The netplan template

`net_controllers` renders `src: netplan.yaml.j2` from the role's `templates/`
directory in two tasks, `tasks/main.yml:188` and `:225`. A template is not a
variable and cannot live in `group_vars`.

Add a role variable:

```yaml
# collection/roles/net_controllers/defaults/main.yml
net_netplan_template: netplan.yaml.j2   # role-relative; absolute path also accepted
```

Both tasks become `src: "{{ net_netplan_template }}"`. Ansible's template lookup
accepts a role-relative name or an absolute path, so the default preserves
current behaviour exactly. Anything wanting a different template writes it to
`.xinas-local/netplan.yaml.j2` and sets the absolute path in the overlay. The
tracked template is never written.

Only one writer survives. `apply_preset`'s netplan branch is deleted rather than
ported: `tests/test_net_controllers_template.py:35` already asserts that no
preset ships a `netplan.yaml.j2`, because a static preset snapshot replacing the
role's dynamic template was itself a shipped bug. Neither shipping preset
contains the file, so the branch is dead code that only invites the prohibited
state back. The prohibition stands and the test keeps enforcing it.

The remaining writer is `configure_network.sh` manual mode. `ROLE_TEMPLATE`
(line 10) points into the tracked role templates directory and line 263 `mv`s
the generated netplan into it. It writes to `.xinas-local/` and sets
`net_netplan_template` in `20-local.yml` instead. Returning to pool mode removes
both the override key and the file, so the role falls back to its own template
rather than silently keeping a stale manual one.

This is the one part of the change that alters role behaviour, so its commit
carries `Requires-Rebuild: net_controllers`.

## 6. Config editors

`configure_raid.sh` and `configure_nfs_exports.sh` are read-modify-write: they
read `.xiraid_arrays`, `.xiraid_spare_pools` and `.exports` out of the defaults
file, edit a member, and write the file back. They therefore need the effective
value to read, not merely a path to write.

Rule: **read effective, write `20-local.yml`.**

- Effective value = role defaults merged with `10-preset.yml` then
  `20-local.yml`, via `yq eval-all '. as $item ireduce ({}; . * $item)'`.
- When the edited top-level key is absent from `20-local.yml`, seed that one key
  from the effective value first, then edit it. Seeding a single key rather than
  the whole file keeps the overlay a genuine override set instead of a second
  frozen snapshot.

`configure_network.sh` needs two separate fixes. `save_pool_settings` (line 68)
does not read-modify-write at all: it emits a fixed eight-key document with
`cat >`, silently dropping any other key in the file. It becomes targeted
`yq -i` writes of the four pool keys into `20-local.yml`. Its manual-netplan
path is covered in §5.

A shared helper in `lib/menu_lib.sh` provides `xinas_config_get` and
`xinas_config_set` so the three editors do not each reimplement the merge.

## 7. `save_preset`

`save_preset` writes six files by copying the current role defaults, the role
template and `site.yml`. Once those are immutable, copying them would produce a
preset that captures the release defaults and none of the operator's actual
configuration — the inverse of what the function is for.

New semantics: a saved preset is the **overlay, decomposed**.

- Every key in the merged overlay is routed to the preset file belonging to the
  role whose `defaults/main.yml` defines it, using the same key→role map the
  §9 subset test builds. A key no role defines is an error, reported rather than
  written, because it cannot have had any effect.
- `netplan.yaml.j2` is copied from `.xinas-local/` when `net_netplan_template`
  is set in the overlay, and from the role's template otherwise.
- `playbook.yml` is copied from `playbooks/site.yml`, whose role list is
  unmodified by construction (§4).

Keys that came from `10-preset.yml` and keys from `20-local.yml` are written
identically; a saved preset is a flat statement of desired state, not a record
of which layer each value arrived through.

## 8. Consolidation

`apply_preset` exists three times: `startup_menu.sh:574`, `simple_menu.sh:504`,
and inline in `autoinstall.sh:231`. The three are near-identical and have
already drifted — only the `startup_menu.sh` copy writes
`/opt/xiNAS/.xinas_applied_preset`, which the `motd` role reads to stamp
`.installed_preset`. A preset applied from `simple_menu.sh` is therefore not
recorded.

One implementation moves to `lib/menu_lib.sh`; all three sites call it. This is
a prerequisite of the rest, not a tidy-up: with three copies the next fix lands
in one or two of them, which is how the drift above happened.

## 9. Migration

The obvious migration — read the dirty tracked files, extract the overridden
keys, restore the files — cannot run on the update path. The update sequence is
`git checkout --force` (§1) and *then* the new code. By the time any new
reconcile executes, the legacy defaults have already been discarded.

So the bridge reconstructs the overlay from what survives `--force`, which is
the untracked state:

1. If `playbooks/group_vars/all/10-preset.yml` already exists, the node is
   migrated; do nothing.
2. Otherwise, if `/opt/xiNAS/.xinas_applied_preset` names a preset, apply that
   preset into the overlay through the §4 path. This is untracked and therefore
   survives the forced checkout.
3. Otherwise the node predates the marker; leave the overlay empty so the role
   defaults apply, and report that in the menu.

**Edits made through the config editors are not recoverable** by this bridge —
they lived only in the overwritten tracked files. This must be stated in the
update notes rather than glossed. It is not a new loss: `checkout --force`
already discards them on *every* update today. The difference is that after
migration it stops happening, because the overlay is untracked.

A secondary repair path handles a tree dirtied outside the update flow: for the
six paths in §4, extract the keys that differ from `HEAD`, write those keys —
and only those — into `20-local.yml`, then `git checkout --` the path. Only
differing keys, because copying whole files would reintroduce the
frozen-snapshot problem through the migration itself. The path list is fixed;
no blanket `git checkout .`, and unrelated local modifications are reported,
not discarded.

## 10. `xinas_history`

`xinas_history/collector.py:16` lists `CONFIG_SOURCES` — the six role
`defaults/main.yml` files, the netplan template and `playbooks/site.yml`. After
this change those files are immutable between releases, and the desired state
they used to carry lives in the overlay. Left alone, snapshot, diff and drift
detection would all go blind to every configuration change the product makes.

`CONFIG_SOURCES` gains `playbooks/group_vars/all/10-preset.yml`,
`playbooks/group_vars/all/20-local.yml` and `.xinas-local/netplan.yaml.j2`. The
role defaults stay in the list: they still change across releases, and a diff
that spans an update should show it.

`docs/config-history/specs.md` line 203 enumerates the collected configuration
sources and is updated in the same change. This is a durable spec, so it is a
spec-first edit, not a follow-up.

## 11. Testing

| Test | Catches |
|---|---|
| Every key in every preset var file is defined by *some* role's defaults | typos, renamed keys, keys no role reads |
| Each preset `playbook.yml` role list equals `site.yml`'s | the narrowed §4 contract |
| No shell script writes under `collection/roles/**/defaults/` or `**/templates/` | regression to `cp` / `cat >` semantics |
| Overlay beats defaults; an absent key falls back; `20-` beats `10-` | the precedence the design rests on |
| `CONFIG_SOURCES` contains both overlay files | §10 silently regressing |
| Differing-key extraction returns only changed keys | the §9 repair path writing a snapshot |
| `_data_min_devices` / `_log_min_devices` render under `StrictUndefined` | the original blocker (already landed) |

The subset test is deliberately global — "defined by some role" rather than
"defined by the role this preset file is named after". The narrower form is
wrong against the tree as it stands: `presets/default/raid_fs.yml` sets five
`nvme_*` keys that `raid_fs` does not define and `nvme_namespace` does. That is
legitimate, both today (Ansible merges all role defaults into one host scope)
and after this change (all preset vars land in one overlay file), so the test
must not assume the filename partitions the keyspace.

The write-path test is a grep over the shell sources. The property worth
pinning is "nothing writes there", which is cheap to state textually and
expensive to state behaviourally.

## 12. Documentation

- `docs/Installer/spec.md` §1 — rewritten around the layer model. The section
  already describes overlay semantics; this change makes the description true.
- `docs/Installer/spec.md` lines 24 and 80 — the claim that `nvme_namespace` is
  absent from the default preset's playbook is false against the file and is
  removed.
- `docs/Installer/spec.md` lines 28 and 47 — both describe a
  `presets/*/netplan.yaml.j2` "seed template". Neither preset ships one and a
  test forbids it; the rows are removed.
- `docs/Installer/update-spec.md` — the reset-to-release section gains the
  migration bridge and the explicit statement that pre-migration config-editor
  edits are lost once.
- `docs/config-history/specs.md` line 203 — the collected-sources list (§10).
- `docs/TODO.md` — `net_detect_infiniband` / `net_detect_mlx5` are declared in
  `net_controllers` defaults, written by `configure_network.sh`, and read by
  nothing.
- The `net_controllers` commit carries `Requires-Rebuild: net_controllers`.
  Menu, editor and preset changes are installer-side bash and carry no trailer.

## 13. Review history

Revision 2 incorporates four blocking findings and two gaps, all confirmed
against the tree:

| Finding | Resolution |
|---|---|
| Migration cannot survive `checkout --force`; r1 wrongly called the checkout an unfired failure | §1 rewritten, §9 rebuilt around the marker-based bridge with documented one-time loss |
| `configure_network.sh:234` still wrote a tracked template | §5 |
| `xinas_history` would not see the new desired state | §10, new |
| An external `--inventory` breaks an inventory-adjacent overlay | §3, overlay moved playbook-adjacent; `import_playbook` workaround tested and rejected; §4 reversed to always run `site.yml` |
| `save_preset` semantics undefined | §7, new |
| The subset test as specified fails on `presets/default/raid_fs.yml` | §11, test generalised to "defined by some role" |

Verifying r1's claim that the preset playbooks are equivalent to `site.yml`
surfaced a further defect, recorded in §4: the preset copy deletes the
`xiraid_skip_install` guard, leaving that flag inert on both existing-RAID
paths. It is closed by §4 rather than tracked separately.
