# FEAT-INST-01 Install on Ubuntu's virtual kernel flavour

Area: INST (`docs/Installer/`)
Profile: medium (two areas — INST and CLIENT — after Q-INST-001)
Owner: Sergey Platonov
Approvers: spec and plan Sergey Platonov; acceptance Sergey Platonov
Current gate: G6 Feature
Spec status: approved (server: docs/Installer/spec.md; client: docs/Client/client-setup-spec.md §5)
Branch: fix/installer-virtual-kernel-flavour (off release/3.14 @ `dd979de9`)

## Documents

- Spec: `docs/Installer/spec.md` §3.1 (*Kernel held*, *Kernel flavour*),
  §3.2 (*Kernel module prerequisite*), §4.1, §4.2, §5 (two rows), §6
  (`common` row) — amended
- Role READMEs: `collection/roles/common/README.md` (the hold),
  `collection/roles/doca_ofed/README.md` (the `macsec` observation and
  what NVIDIA documents)
- Client spec: `docs/Client/client-setup-spec.md` §1 (scope row), §5
  (new) — the client part, approved
- Deferred: `docs/TODO.md` — uninstaller does not release the hold; the
  client DOCA role entry is deleted when TASK-INST-01-03 lands
- Cause and evidence: `docs/troubleshooting/installer-virtual-kernel-flavour.md`
  (lands with #411)
- Hardware results: `docs/control-path/hardware-smoke-runbook.md` §2,
  2026-10-19 note (lands with #411)

## Plan

### TASK-INST-01-01 Hold the installed kernel metapackages

Basis: `docs/Installer/spec.md` §3.1 *Kernel held*
Files: `collection/roles/common/tasks/main.yml` (replace the "Hold current
Ubuntu kernel" task); `tests/test_common_kernel_hold.py`, modelled on
`tests/test_common_avx_preflight.py`
Result: `package_facts`, a selection of the installed names by the
spec's pattern, one `dpkg_selections` hold per member, a warning when the
selection is empty; all tagged `kernel`
Checks (pytest, evaluating the role's selection expression against
fixture package lists): generic host → `linux-image-generic`; cloud host
→ `linux-image-virtual`; HWE host with both → both; `-edge` variant
kept; per-version and `linux-image-unsigned-*` names excluded; empty
list → no hold and the warning task runs; the tasks carry the `kernel`
tag. On hardware: `xinas-rc-vm` (virtual flavour, plus `linux-generic`
added there earlier) re-run is idempotent
Command: CLAUDE.md *Verification* (`pytest …`, `ansible-lint
collection/roles/`, `yamllint`); a `--tags kernel` run on `xinas-rc-vm`
Out of scope: holding `linux-headers-*` or the top-level `linux-generic`
/ `linux-virtual`; releasing the hold on uninstall (TODO)
Acceptance: on a fresh, unmodified cloud image `apt-mark showhold` lists
`linux-image-virtual` and `common` completes
Rebuild: decided in Q-INST-003 (see Approvals)

### TASK-INST-01-02 Ensure the macsec module before installing DOCA

Basis: `docs/Installer/spec.md` §3.2 *Kernel module prerequisite*
Files: `collection/roles/doca_ofed/tasks/main.yml` (new tasks before
"Install DOCA-OFED packages"); `tests/test_doca_ofed_macsec_preflight.py`,
modelled on `tests/test_doca_ofed_handler_order.py`
Result: for the running kernel and every installed `linux-image-<version>`:
`modinfo -k <version> macsec`; on failure, `apt-cache policy` candidate
check, install of `linux-modules-extra-<version>`, re-check; failure
before DOCA naming the kernel when the module is still missing, there is
no candidate, or apt fails; tags `ofed`, `deps`, `install`
Checks (pytest on the task file): the check tasks precede the DOCA
package task; they carry the three tags; the failure message names the
kernel and the module; the candidate test reads the `Candidate:` line.
On hardware: a fresh `xinnorVM` install on an unmodified Ubuntu 24.04
cloud image VM with two kernels installed, as `xinas-rc-vm` had
Command: as TASK-INST-01-01, plus that install
Out of scope: the client `doca_ofed` role (Q-INST-001); headers for
non-running kernels; kernels installed after the role runs (known limit,
spec §3.2)
Acceptance: the fresh cloud-image install completes all roles, and
`modinfo -k <k> macsec` resolves for every installed kernel afterwards
Rebuild: decided in Q-INST-003 (see Approvals)

### TASK-INST-01-03 The same macsec check in the client DOCA role

Basis: `docs/Client/client-setup-spec.md` §5.2 (approved 2026-10-20), with
`docs/Installer/spec.md` §3.2 as the normative text
Files: `client_repo/collection/roles/doca_ofed/tasks/main.yml` (the six
preflight tasks after "Ensure build dependencies are present", each also
gated `when: mlx_nic_check.rc == 0`; the NIC-detection task gains the
`deps` and `install` tags); `tests/test_doca_ofed_macsec_preflight.py`
parametrized over both roles; `client_repo/collection/roles/doca_ofed/README.md`
(a pointer to the check); `CHANGELOG.md` (the DOCA entry names the
client too); `docs/TODO.md` (delete the client entry)
Result: identical behavior to TASK-INST-01-02, only when a Mellanox NIC
is detected
Checks: the server test cases run against the client task file too; every
client preflight task is NIC-gated; the detection task carries `deps` and
`install`; ordering before "Install DOCA-OFED packages"
Command: as TASK-INST-01-02 (pytest, ruff, yamllint, ansible-lint)
Out of scope: a client run on hardware (no client with a Mellanox NIC on
a virtual-flavour kernel is available)
Acceptance: the tests pass for both roles
Rebuild: none — clients do not use the server update flow (§5.3)

## Approvals

| Gate | Object and version | Decision | Person | Date | Limits |
|------|--------------------|----------|--------|------|--------|
| G3 | `docs/Installer/spec.md` §3.1, §3.2, §4, §5, §6 as amended on this branch (docs commit before the code), after spec review 3 "ready" | approved | Sergey Platonov | 2026-10-19 | server part only; the client part (Q-INST-001) needs its own spec amendment, review and approval |
| G4 | TASK-INST-01-01 and TASK-INST-01-02 in this card | approved | Sergey Platonov | 2026-10-19 | as above |
| Q-INST-001 | client `doca_ofed` role | in this change | Sergey Platonov | 2026-10-19 | adds TASK-INST-01-03 after its spec is approved |
| Q-INST-002 | target release | 3.14, as `v3.14.0-rc.2`; forward-port to 3.15 | Sergey Platonov | 2026-10-19 | none |
| Q-INST-003 | rebuild trailers | `Requires-Rebuild: common` on TASK-01 and `Requires-Rebuild: doca_ofed` on TASK-02 | Sergey Platonov | 2026-10-19 | the owner accepts that every updating host re-runs `doca_ofed` |
| post-G3 clarification | `docs/Installer/spec.md` §3.2 *Which kernels* and the §4.2 loop: `-dbgsym` packages yield no kernel (from the implementation review; spec reviewer: no new review needed) | accepted | Sergey Platonov | 2026-10-20 | none |
| G3 (client) | `docs/Client/client-setup-spec.md` §1 scope row and §5 as on this branch, after the client spec review "ready" and its four minor findings fixed | approved | Sergey Platonov | 2026-10-20 | none |
| G4 (client) | TASK-INST-01-03 in this card | approved | Sergey Platonov | 2026-10-20 | none |

## Reviews

- Spec review 1 (2026-10-19, `spec-reviewer`): **rework** — flavour
  claims beyond the observation; an implied support statement for HWE
  7.0; gaps in the `macsec` contract (candidacy, re-check, apt failure,
  tags); an inexact held set; documents not updated (§5, §6, READMEs,
  TODO); thin plan checks and rebuild reasoning; the check covering only
  the running kernel. All addressed on this branch; the last one by
  checking every installed kernel instead of stating it as a limit.
- Spec review 2 (2026-10-19, same reviewer): **rework** — a card table
  row one cell short (would fail markdownlint MD056); how K is read from
  package names unstated; the §4.2 loop scanning `/lib/modules` instead
  of the §3.2 set; one §5 row generalising past the observed image. All
  four fixed; the §4.2 loop was run on `xinas-rc-vm` and resolved
  `macsec` for both installed kernels.
- Spec review 3 (2026-10-19, same reviewer): **ready**.
- Implementation review (G5, 2026-10-19, `implementation-reviewer`):
  spec compliance **pass**, code quality **fix needed** — three test
  lines over ruff's 100 columns; `dpkg-query` exiting 1 with no versioned
  image package would fail the kernel list under `pipefail`; the hold test
  re-implemented the selection instead of rendering it; no CHANGELOG
  entry; the failure message overstated its cause; `-dbgsym` packages
  would yield a bogus K. All fixed. The `-dbgsym` exclusion is a
  post-approval clarification of spec §3.2 (*Which kernels*) and of the
  §4.2 loop — it only narrows K by debug-symbol packages, which are never
  bootable kernels; recorded here for the owner.

## Task results

- TASK-INST-01-01 (commit `6cece3e1`) and TASK-INST-01-02, 2026-10-19:
  - Tests first: the new tests failed 32/33 before the role changes.
    After: `test_common_kernel_hold.py`, `test_doca_ofed_macsec_preflight.py`,
    `test_common_avx_preflight.py`, `test_doca_ofed_handler_order.py` —
    47 passed (pytest on `xinas-rc-vm`, files copied with LF endings).
  - `ruff format --check` and `ruff check` on the two test files: clean.
    `yamllint -c .yamllint.yml` on both roles: clean. `ansible-lint
    collection/roles/` with `community.general` and `ansible.posix`:
    0 failures, 0 warnings (production profile passed).
  - On hardware (`xinas-rc-vm`, Ubuntu 24.04.5 cloud image returned to
    plain virtual flavour — no `linux-image-generic`, no
    `linux-modules-extra-*` for either installed kernel; ansible-core
    2.16.3): `--tags kernel,deps` held `linux-image-virtual`, found both
    kernels without `macsec`, installed `linux-modules-extra` for
    `6.8.0-142` and `6.8.0-147`, re-check passed, `failed=0`; a second
    run `changed=0`; with no kernel metapackage installed the hold was
    skipped and the warning printed, `failed=0`.
  - Not run: the full pytest suite, the TypeScript suites (no change
    there); the "no apt candidate" failure path on a host (covered by
    the structural test only); a fresh install on an unmodified cloud
    image (needs a new VM and a licence for its hardware key).
  - Unplanned real-world check, 2026-10-20: `xinas-rc-vm` rebooted on its
    own at 06:10 (unattended-upgrades with `Automatic-Reboot "true"`) into
    `6.8.0-147-generic`, a kernel it had never run. `mlx5_ib`, `macsec`
    and `xiraid` loaded, `openibd` and xiRAID came up, both arrays and
    `/mnt/data` were online — because TASK-02 had installed
    `linux-modules-extra` for that kernel the day before.
- TASK-INST-01-03, 2026-10-20:
  - Tests first: with the test parametrized over both roles, the client
    cases failed 26/45 before the client change. After: 86 passed
    (`test_doca_ofed_macsec_preflight.py` both roles,
    `test_common_kernel_hold.py`, `test_common_avx_preflight.py`,
    `test_doca_ofed_handler_order.py`, `test_doca_repo_pin.py`).
  - Found while writing it: Ansible evaluates `loop` before `when`, so on
    a client without a Mellanox NIC the preflight loops would have failed
    on skipped registers; they default to `[]`, pinned by a test.
  - ruff format/check clean; yamllint clean; `ansible-lint` on the client
    role and on `collection/roles/`: 0 findings each.
  - On the VM (no Mellanox NIC): `--tags deps,install` ran the detection
    and skipped all 8 gated tasks, `failed=0`; an untagged run printed
    the skip message, `failed=0`.
  - Not run: a client with a Mellanox NIC on a virtual-flavour kernel
    (none available); covered by the shared tests and the server-side
    hardware run.

## Open questions

| Id | Question | Why it matters | Addressed to | Needed material |
|----|----------|----------------|--------------|-----------------|
| Q-INST-001 | Should the client-side `doca_ofed` role get the same `macsec` check in this change? | NFS clients are often cloud VMs; that role installs DOCA's `mlx5_ib` when it detects a Mellanox NIC. Deferred in `docs/TODO.md` until decided | owner | decision |
| Q-INST-002 | Should this land in 3.14 (an rc.2) or 3.15? | `xinnorVM` is the VM preset, and the observed Ubuntu 24.04.5 cloud image ships the virtual flavour, so a VM install from that image fails without a manual workaround | owner | decision |
| Q-INST-003 | Which `Requires-Rebuild:` trailers do the two tasks carry? Recommendation: `Requires-Rebuild: common` on TASK-01, none on TASK-02 | `.claude/rules/installer.md` asks for a trailer when packages or kernel modules change. `common` is idempotent and cheap to re-run, and re-running it completes the hold on existing hosts that carry an HWE metapackage beside `linux-image-generic`, which today stay half-held. The `macsec` check matters only before DOCA installs; re-running `doca_ofed` everywhere is heavy and changes nothing where DOCA already works | owner | decision |

## Assumptions

| Id | Assumption | Owner | Confirm by |
|----|------------|-------|------------|
| A-1 | Ubuntu 22.04 cloud images have the same metapackage split as 24.04 | owner | a 22.04 cloud-image install, or accepted risk |

## Known limits (found later)

- 2026-10-20, from the FEAT-INST-02 spec review: the Q-INST-003 trailers
  did not run on update as decided. `playbooks/site.yml` lists every role
  without tags, and at the time no task in `common` or `doca_ofed`
  carried the role's name as a tag, so `ansible-playbook
  playbooks/site.yml --tags common,doca_ofed` (what the update flow
  runs) matched no task in either role.
  - `common`: fixed in FEAT-INST-02, which tags every task `common`.
  - `doca_ofed`: still a no-op. The fix is tracked in `docs/TODO.md`
    ("roles that do not answer to their own tag"). `CHANGELOG.md` keeps
    `Requires-Rebuild: doca_ofed` on purpose, so that the trailer takes
    effect if that fix lands before 3.14.0.

## Accepted risks

- none yet

## Next step

Spec review 2 (G3), then owner approval of the spec and the two-task
plan (G4) and answers to Q-INST-001…003; then the two tasks, CI, and a
fresh install on an unmodified cloud image.

## Retrospective (after G7)

- Findings that repeated:
- Where agents went wrong:
- Rules to change:
