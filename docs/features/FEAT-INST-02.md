# FEAT-INST-02 Stop unattended-upgrades from rebooting the node

Area: INST (`docs/Installer/`)
Profile: small
Owner: Sergey Platonov
Approvers: spec and plan Sergey Platonov; acceptance Sergey Platonov
Current gate: G5 Task (PR open)
Spec status: approved
Branch: fix/unattended-upgrades-reboot-policy (off release/3.14 @ `d22e88c1`)

## Documents

- Spec: `docs/Installer/spec.md` §2.4 (note on role tags), §3.1 *Role
  tag* (new) and *Unattended upgrades* (rewritten), §4.1 (one line), §5
  (one row), §6 (`common` row)
- Role README: `collection/roles/common/README.md` (two variables, the
  role tag)
- Deferred: `docs/TODO.md`, "a pending reboot is not reported"
- Evidence: `xinas-rc-vm`,
  `/var/log/unattended-upgrades/unattended-upgrades.log`, 2026-10-20
  06:09–06:10 (quoted in the spec)
- Spec review: independent `spec-reviewer` passes, recorded below
- Plan: one task, below (small profile)

## Plan

### TASK-INST-02-01 Make the unattended reboot a knob that defaults to off

Basis: `docs/Installer/spec.md` §3.1 *Role tag* and *Unattended upgrades*
(this branch)
Files: `collection/roles/common/defaults/main.yml` (two variables),
`collection/roles/common/templates/unattended-upgrades.conf.j2`,
`collection/roles/common/tasks/main.yml` (an assert before "Deploy
unattended-upgrades configuration"; `common` added to every task's
tags; `reload: false` on "Apply sysctl parameters"; a `stat` of the two
`90-perf-*.conf` drop-ins gating "Remove legacy xiNAS sysctl keys"),
`tests/test_common_unattended_reboot.py`, modelled on
`tests/test_common_avx_preflight.py`, `CHANGELOG.md` (`### Fixed`)
Result:
- The role defaults are `common_unattended_reboot: false` and
  `common_unattended_reboot_time: ""`.
- The template renders `Automatic-Reboot "false"` by default and
  `"true"` when the knob is on. It renders the `-Time` line only when the
  knob is on and the time is non-empty.
- While the knob is on, a non-empty time that is not a string or does not
  match `HH:MM` fails the assert. The message names
  `common_unattended_reboot_time` and contains "must be a quoted 24-hour
  HH:MM string".
- Every task in the role carries `common`.
- "Apply sysctl parameters" sets `reload: false` and still notifies
  `Reload sysctl`.
- "Remove legacy xiNAS sysctl keys" runs only when both
  `/etc/sysctl.d/90-perf-net.conf` and `90-perf-vm.conf` exist.
- The CHANGELOG entry says the default flipped from rebooting to not
  rebooting, how to opt back in, that the time must be quoted, and that
  `Requires-Rebuild: common` now actually re-runs the role, which also
  makes FEAT-INST-01's kernel-hold migration take effect. It also warns
  that an update re-running the role resets a hostname set outside
  `configure_hostname.sh` and a timezone set outside `common_timezone`.
Checks (pytest, rendering the real template with a Jinja2 environment
that mirrors Ansible: `trim_blocks=True` and the `bool` shim from
`tests/test_raid_fs_trim.py`; "lines" means non-comment, non-blank lines):
- With the defaults, the lines are exactly the three in the spec.
- Knob on with no time gives `"true"` and no `-Time` line.
- Knob on with `"02:00"` gives the `-Time` line.
- Knob off with a time gives no `-Time` line.
- The string forms of the knob (`"yes"`, `"false"`) render like the
  booleans.
- Evaluating the assert's conditions with Jinja2 and the `string` test:
  `"00:00"`, `"02:00"`, `"23:59"` and `""` pass. `"24:00"`, `"2:00"`,
  `"now"`, `"+5"`, `"02:00:00"` and the integers `1320` and `600` fail.
  `None` passes, as empty. A failing value makes the condition evaluate
  to false; it does not raise.
  Knob off with `"24:00"` passes, because the assert is skipped.
- The assert's message names the variable and contains the §5 phrase.
- The assert sits before the template task.
- The assert and the template carry `security`.
- The template omits the `-Time` line for `None`.
- The sysctl task has `reload: false` (the module defaults to `true`)
  and notifies `Reload sysctl`.
- A task registering the `stat` of both perf drop-ins comes before the
  legacy strip, and the strip's `when` requires both to exist.
- Every task in `tasks/main.yml`, including the tasks inside a block,
  carries `common`.
Command: CLAUDE.md *Verification* (`pytest …`, `ruff check`, `ruff
format --check .`, `ansible-lint collection/roles/`, `yamllint`). The
workstation has no Python, so these run on a Linux node or in CI on the
PR. On hardware, on `xinas-rc-vm`, which still has `"true"`:
1. Run `ansible-playbook playbooks/site.yml --tags common --list-tasks`
   and check that it lists "Deploy unattended-upgrades configuration".
2. Run `ansible-playbook playbooks/site.yml --tags common`, the argv
   that `build_rebuild_cmd` produces for this trailer alone.
3. Run `apt-config dump | grep Automatic-Reboot`.
4. Run `--tags common` a second time. Record the recap's `changed=`
   count, then check that `sysctl net.core.rmem_max vm.swappiness` reads
   `1073741824` and `1` (`perf_tuning` is deployed there). Record the result in
   spec §3.1 *Role tag* as [observed].
5. Optional: run with `-e common_unattended_reboot=true -e
   common_unattended_reboot_time=02:00`, check that both lines appear,
   then re-run without the flags.
6. Optional, for the strip gate: append the marker line
   `net.core.somaxconn = 4096` to `/etc/sysctl.conf`. Rename
   `90-perf-net.conf` away and run `--tags sysctl`; the marker must stay.
   Restore the file and run again; the marker must be gone. Record both as
   [observed].
Out of scope:
- reporting a pending reboot (TODO)
- editing `50unattended-upgrades`
- `Automatic-Reboot-WithUsers`
- the uninstaller
- the role-name tags of the six other roles listed in spec §2.4 (TODO,
  "roles that do not answer to their own tag")
Acceptance: after step 2, `apt-config dump` shows
`Unattended-Upgrade::Automatic-Reboot "false";` and no `-Time` line, and
after step 4 the perf values are unchanged.
Rebuild: `Requires-Rebuild: common`

## Approvals

| Gate | Object and version | Decision | Person | Date | Limits |
|------|--------------------|----------|--------|------|--------|
| G1 | policy: a knob `common_unattended_reboot`, default off, optional `Automatic-Reboot-Time`; target `release/3.14` | approved (in chat) | Sergey Platonov | 2026-10-20 | none |
| Q-INST-006 | tag every `common` task `common` | approved (in chat) | Sergey Platonov | 2026-10-20 | none |
| Q-INST-007 | `reload: false` on the common sysctl task | approved (in chat) | Sergey Platonov | 2026-10-20 | none |
| Q-INST-008 | gate the legacy `/etc/sysctl.conf` strip on both `90-perf-*.conf` drop-ins | approved (in chat) | Sergey Platonov | 2026-10-20 | none |
| G3 + G4 | spec as of `c432788c` and this one-task plan | approved (in chat: "do") | Sergey Platonov | 2026-10-20 | given after review 2, before the review-3 amendment (`c5ae2bfa`, Q-INST-008) existed |
| G3 (amendment) | `c5ae2bfa` plus the review-4 text fixes; spec review 4 "ready" | approved (in chat: "confirmed") | Sergey Platonov | 2026-10-20 | none |

## Open questions

| Id | Question | Why it matters | Addressed to | Needed material |
|----|----------|----------------|--------------|-----------------|
| Q-INST-004 | Reboot policy for unattended-upgrades | the node rebooted itself on `xinas-rc-vm` and dropped NFS clients | owner | **decided 2026-10-20: a knob, default off, with an optional maintenance time** |
| Q-INST-005 | Which release carries the fix? | 3.14.0 is at rc.1 | owner | **decided 2026-10-20: `release/3.14`, forward-ported to `release/3.15`** |
| Q-INST-006 | `--tags common` matches no task, so `Requires-Rebuild: common` is a no-op. How do existing hosts get the policy? | without it only fresh installs are fixed; FEAT-INST-01's trailer has the same defect | owner | **decided 2026-10-20: tag every `common` task `common`** |
| Q-INST-007 | With the role re-run on every update, the sysctl task (`reload: yes`) drops a perf-tuned host to the baseline until the end-of-play handler runs | a routine update would briefly undo `perf_tuning`, or keep it undone after a failed run | owner | **decided 2026-10-20: `reload: false`; the `Reload sysctl` handler applies the drop-ins** |
| Q-INST-008 | With every update running `common`, its unconditional legacy strip would remove the perf keys from a ≤ 3.10.2-layout host, and no trailer can re-add them | silent loss of NFS/RDMA tuning | owner | **decided 2026-10-20: gate the strip on both `90-perf-*.conf` drop-ins existing** |

## Assumptions

| Id | Assumption | Owner | Confirm by |
|----|------------|-------|------------|
| A-1 | unattended-upgrades 2.8 (Ubuntu 22.04) reads the three keys with the same defaults as 2.9.1 | owner | a 22.04 node run, or accepted risk |
| A-2 | Ansible loads an unquoted `22:00` from `group_vars` as the integer `1320` (YAML 1.1) | owner | the assert rejects both the integer and a bad string, so either way the play fails with the message |

## Accepted risks

- none yet

## Reviews

- Spec review 1 (2026-10-20, `spec-reviewer`): **rework**. There was 1
  blocking finding, 2 major and 6 minor:
  1. `Requires-Rebuild: common` runs no task (blocking). Q-INST-006 was
     decided as tag every task, and §2.4 and §3.1 *Role tag* were
     amended.
  2. An unquoted `HH:MM` loads as an integer. The spec now requires a
     string, and the assert checks `is string`.
  3. Was the assert conditional on the knob? It is now gated on the knob.
  4. The hardware acceptance covered only the default. An optional
     opt-in step and a message test were added.
  5. When the reboot happens was not stated. The timer and the past-time
     behaviour are now cited.
  6. Vendor citations had gaps. They are now pinned and dated.
  7. "Exactly three lines" was ambiguous. The checks now name non-comment
     lines and use `trim_blocks`.
  8. The §5 and §6 rows were missing. They have been added.
  9. The card lacked sections and the CHANGELOG wording. Both were added.
- Spec review 2 (2026-10-20, same reviewer): **rework**. All nine
  findings from review 1 were closed. There were 2 new major findings and
  3 minor:
  1. The idempotency claim was incomplete (major). A re-run also resets
     the timezone, and the sysctl task with `reload: yes` dropped
     perf-tuned live values on every run. The second point was confirmed
     in the ansible.posix 1.5.4 source. Q-INST-007 was decided as
     `reload: false`. The *Role tag* bullet now lists the resets, a second
     run was added to the hardware steps, and the CHANGELOG warning was
     planned.
  2. §2.4 contradicted itself, and the six untagged roles were not
     tracked (major). The examples and the opening sentence were fixed,
     a `docs/TODO.md` entry was added, and FEAT-INST-01 got a "Known
     limits" note. The `doca_ofed` trailer is kept on purpose.
  3. "Non-empty" was undefined for values that are not strings. Empty
     now means `""` or `None`, without `length`, and the checks require
     false rather than an exception.
  4. The README overstated what fails. It now reads "anything
     non-empty".
  5. The §5 way out offered an immediate reboot. It now leads with
     `common_unattended_reboot: false`.
- Spec review 3 (2026-10-20, same reviewer): **rework**. All five
  findings from review 2 were closed. There was 1 new major finding and
  2 minor:
  1. A 3.14 update would strip perf keys from a host still in the
     ≤ 3.10.2 layout, and nothing could put them back (major). Q-INST-008
     was decided as gating the strip on the perf drop-ins, and
     *Migration* was rewritten, with the remedy now an untagged
     `site.yml`.
  2. Two sentences still described the old reload behaviour. Both were
     fixed.
  3. The Approvals table did not record the decisions. Rows were added.
- Spec review 4 (2026-10-20, same reviewer): **ready**. All three
  findings from review 3 were closed. There were 4 minor findings:
  1. The legacy layout was described inconsistently with §3.12
     (`vm.swappiness` held `common`'s 10). It is now stated per key and
     marked inferred.
  2. One untagged `site.yml` does not finish the migration. *Migrating a
     host* now says it takes two runs.
  3. The gate had no behavioural check. Hardware step 6 was added
     (optional).
  4. The approval came before the amended text. The G3 (amendment) row
     now waits for the owner's confirmation.

## Task results

- TASK-INST-02-01 (2026-10-20): code commit `940166df`, with
  `Requires-Rebuild: common`. The tests were written first, but nothing
  could be run on the workstation (no Python, WSL or Node). pytest,
  ruff, ansible-lint and yamllint run in CI on the PR. The deploy task was
  renamed to an ASCII hyphen (it had U+2011) so that `--list-tasks` and
  the tests match it. The implementation review (G5) is in progress.

## Next step

1. CI on the PR runs the Verification lines.
2. The implementation review (G5) finishes; its findings go into the PR.
3. The hardware steps on `xinas-rc-vm` (G6), then forward-port to
   `release/3.15`.

## Retrospective (after G7)

- Findings that repeated:
- Where agents went wrong:
- Rules to change:
