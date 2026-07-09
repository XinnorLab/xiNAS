# WS2 — Uninstall & history-store safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close remediation WS2 (all 7 verified findings): stop the config-history store wipe on every `site.yml` re-run, make `uninstall.sh --dry-run` truly non-destructive and `--remove-*` flags per-question, scope the RAID teardown to xiNAS-managed names with an OS-disk exclusion, make the banner cron install/uninstall symmetric, and amend spec §4.3 step 5 (re-consolidation declared not performed — user decision 2026-07-09).

**Architecture:** Ansible role fixes (`xinas_history`, `xinas_uninstall`, `motd`) + bash (`uninstall.sh`) + owning-spec updates in the same commits (spec-first rule). Regression tests are text/structure tests over the role YAML and script, following the repo's existing pattern (`tests/test_storage_role_structure.py`, `tests/test_agent_unit.py`). Source of truth: `docs/plans/2026-07-07-codebase-review-remediation-plan.md` §WS2; owning specs `docs/Installer/uninstall-spec.md`, `docs/config-history/specs.md`.

**Tech Stack:** Ansible (ansible-lint in CI), bash, Python text-tests (pytest, venv `/tmp/xinas-pytest-venv`), markdownlint.

---

## Conventions

- **TDD:** failing test → red → minimal fix → green → commit. For pure spec/doc tasks, markdownlint is the check.
- **Python:** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`; `ruff check`/`ruff format --check` on any touched python.
- **Ansible:** `ansible-lint collection/roles/` must stay green (CI job). Bash: `bash -n uninstall.sh`.
- **Commits:** per task, explicit paths (never `git add -A`), end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Requires-Rebuild:** ONLY Task 4 (motd cron relocation needs the role to re-run on update): `Requires-Rebuild: motd`. Tasks 1–3: the fixes take effect on the NEXT run of those roles/scripts by construction — no trailer (per the trailer rules, don't train users to click through).
- **Verified findings:** all 7 re-verified against origin/main on 2026-07-09 (F1–F7 in the conversation record; line refs below are current).

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `collection/roles/xinas_history/tasks/main.yml` | drop the purge; idempotent store dirs | T1 |
| `docs/config-history/specs.md` | store-lifecycle note (never deleted by install) | T1 |
| `tests/test_xinas_history_role_safety.py` (new) | no `state: absent` on the store path | T1 |
| `uninstall.sh` | dry-run guards the `rm -rf`; per-question `--remove-*` | T2 |
| `tests/test_uninstall_script_safety.py` (new) | structural asserts on both fixes | T2 |
| `collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml` | managed-name filter + OS-disk exclusion | T3 |
| `tests/test_uninstall_teardown_scoping.py` (new) | structural asserts on filter + exclusion | T3 |
| `collection/roles/motd/tasks/main.yml` | banner cron → `/etc/cron.d/xinas-banner` + migration | T4 |
| `docs/Installer/uninstall-spec.md` | §4.3 step 5 amended (not performed + why); §4.3 fallback note | T3, T5 |
| `docs/plans/2026-07-07-codebase-review-remediation-plan.md` | WS2 checkboxes + status | T6 |

---

### Task 1 (WS2.1): xinas_history store idempotence

**Files:** Modify `collection/roles/xinas_history/tasks/main.yml`; Modify `docs/config-history/specs.md`; Create `tests/test_xinas_history_role_safety.py`.

The role currently has (main.yml, right after the store-dir creation):

```yaml
- name: Purge existing config history on install
  ansible.builtin.file:
    path: "/var/lib/xinas/config-history/{{ item }}"
    state: absent
  loop:
    - snapshots
    - baseline
    - state
```

followed by a task recreating `snapshots` + `state` as directories. Every `site.yml` re-run destroys all rollback history (and the S11–S13 restore/adopt payloads).

- [ ] **Step 1: failing test** — `tests/test_xinas_history_role_safety.py`:

```python
"""WS2.1: the xinas_history role must never delete the config-history store.

A day-2 `site.yml` re-run previously purged snapshots/baseline/state on every
role execution (remediation plan WS2, high). Structural regression guard in
the style of test_storage_role_structure.py.
"""

from pathlib import Path

import yaml

ROLE_TASKS = Path("collection/roles/xinas_history/tasks/main.yml")
STORE = "/var/lib/xinas/config-history"


def _tasks() -> list[dict]:
    return yaml.safe_load(ROLE_TASKS.read_text())


def test_no_state_absent_on_store_path():
    for task in _tasks():
        file_mod = task.get("ansible.builtin.file") or task.get("file") or {}
        if not isinstance(file_mod, dict):
            continue
        path = str(file_mod.get("path", ""))
        if STORE in path:
            assert file_mod.get("state") != "absent", (
                f"task {task.get('name')!r} deletes {path} — the config-history "
                "store must survive role re-runs (WS2.1)"
            )


def test_store_dirs_created_idempotently():
    # The store dirs must still be ensured as directories (create-if-absent).
    dir_paths = [
        str((task.get("ansible.builtin.file") or {}).get("path", ""))
        for task in _tasks()
        if isinstance(task.get("ansible.builtin.file"), dict)
        and (task.get("ansible.builtin.file") or {}).get("state") == "directory"
    ]
    joined = " ".join(dir_paths)
    assert STORE in joined, "store base dir must be ensured as a directory"
```

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_xinas_history_role_safety.py -q` → `test_no_state_absent_on_store_path` FAILS (the purge task).

- [ ] **Step 3: fix the role.** In `collection/roles/xinas_history/tasks/main.yml`, DELETE the whole "Purge existing config history on install" task (the `state: absent` loop). Keep the directory-creation tasks (they're already create-if-absent). The loop creating subdirectories should ensure all three (`snapshots`, `state` — check whether `baseline` is created lazily by the library's `ensure_dirs`; do NOT add `baseline` if the library creates it on demand — main's `9faf573` made `ensure_dirs` stop pre-creating `baseline/`, so the role must not pre-create it either; leave the existing loop items as they are minus nothing).

- [ ] **Step 4: green** + `ansible-lint collection/roles/xinas_history/` clean.

- [ ] **Step 5: spec.** In `docs/config-history/specs.md`, find the store section (`/var/lib/xinas/config-history/`) and add one paragraph: the store is created idempotently by the `xinas_history` role (dirs only if absent) and is NEVER deleted by install/re-install; only the library's GC (retention policy) and explicit operator action remove snapshots. Run `npx --yes markdownlint-cli2 'docs/config-history/specs.md'` → 0 errors.

- [ ] **Step 6: commit** — `fix(xinas_history): never purge the config-history store on role re-runs (WS2.1)` + spec + test files.

---

### Task 2 (WS2.2): uninstall.sh — dry-run rm guard + per-question flags

**Files:** Modify `uninstall.sh`; Create `tests/test_uninstall_script_safety.py`.

Two verified defects:
(a) `DRY_RUN` adds `--check --diff` to ansible, but the final `rm -rf "$INSTALL_DIR"` (after the playbook, ~line 233) runs unconditionally — a dry run deletes `/opt/xiNAS`.
(b) The flag block sets global `INTERACTIVE="false"` when ANY of `FLAG_XIRAID_GIVEN`/`FLAG_OFED_GIVEN`/`FLAG_PERF_GIVEN` is true, contradicting its own comment ("the other questions still get prompted unless --yes is set").

- [ ] **Step 1: failing test** — `tests/test_uninstall_script_safety.py`:

```python
"""WS2.2: uninstall.sh safety — dry-run must not delete, flags are per-question.

Structural asserts on the script text (the repo's pattern for bash surfaces).
"""

import re
import subprocess
from pathlib import Path

SCRIPT = Path("uninstall.sh")
SRC = SCRIPT.read_text()


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_rm_rf_is_dry_run_guarded():
    # The rm -rf "$INSTALL_DIR" must sit inside a DRY_RUN != true branch.
    # Find the rm line and require a dry-run guard between it and the
    # preceding 100 chars... robust form: the line region from the ansible run
    # to the rm must contain a DRY_RUN conditional that skips the rm.
    rm_idx = SRC.index('rm -rf "$INSTALL_DIR"')
    window = SRC[max(0, rm_idx - 400) : rm_idx]
    assert re.search(r'if\s+\[\[\s+"\$DRY_RUN"\s+!=\s+"true"\s+\]\]', window) or re.search(
        r'"\$DRY_RUN"\s+==\s+"true"\s+\]\].*then', window, re.S
    ), "rm -rf $INSTALL_DIR must be guarded by the dry-run check (WS2.2)"


def test_remove_flags_do_not_disable_all_prompting():
    # The old bug: any FLAG_*_GIVEN forced global INTERACTIVE=false.
    assert not re.search(
        r'FLAG_XIRAID_GIVEN.*==.*true.*\|\|.*FLAG_OFED_GIVEN.*\n?.*INTERACTIVE="false"',
        SRC,
    ), "--remove-* flags must answer only their own question (WS2.2)"
    # --yes (SKIP_GATE) alone may still force non-interactive:
    assert 'SKIP_GATE" == "true"' in SRC
```

(Adapt the regexes to the final script shape — the intent is pinned: guard present around the `rm`, no global-INTERACTIVE coupling to the per-question flags.)

- [ ] **Step 2: red** (both asserts fail against the current script).

- [ ] **Step 3: fix (a)** — wrap the rm:

```bash
# Remove the install dir LAST, from here rather than inside the playbook:
# ansible cannot delete the playbook/role tree it is executing from without
# throwing "FileNotFoundError: ${INSTALL_DIR}/playbooks" and failing the run.
# We are already cd'd to /tmp (above), so this is safe.
if [[ "$DRY_RUN" == "true" ]]; then
    info "dry-run: would remove ${INSTALL_DIR} (skipped)"
else
    rm -rf "$INSTALL_DIR"
fi
```

Also audit the dry-run summary text so it doesn't claim "uninstall complete" on a dry run — if the summary block is shared, add a `(dry run — no changes applied)` line under the banner when `DRY_RUN == true`.

- [ ] **Step 4: fix (b)** — replace the global block:

```bash
# --yes answers every question; an explicit --remove-* flag answers ONLY its
# own question. Everything else stays interactive.
if [[ "$SKIP_GATE" == "true" ]]; then
    INTERACTIVE="false"
fi
```

Then, where each question is asked (the `ask_yes_no` call sites for xiRAID / OFED / perf), skip the prompt when that question's `FLAG_*_GIVEN` is true (its variable already holds the flag's answer). Read the ask flow and adjust each call site:

```bash
if [[ "$FLAG_XIRAID_GIVEN" != "true" && "$INTERACTIVE" == "true" ]]; then
    REMOVE_XIRAID="$(ask_yes_no "Remove xiRAID packages?")"
fi
```

(Mirror for OFED and perf, matching the real variable names in the script.)

- [ ] **Step 5: green** — pytest file passes; `bash -n uninstall.sh`; manual sanity: `grep -n "INTERACTIVE" uninstall.sh` shows only the `--yes` coupling.

- [ ] **Step 6: commit** — `fix(uninstall): dry-run never deletes; --remove-* flags answer only their own question (WS2.2)`.

---

### Task 3 (WS2.3): teardown scoping + OS-disk exclusion

**Files:** Modify `collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml`; Modify `docs/Installer/uninstall-spec.md` (§4.3 note); Create `tests/test_uninstall_teardown_scoping.py`.

Spec §4.3 already mandates: names from the install baseline first (`xinas-history snapshot show baseline`), fallback name-match (`data`, `log`, `*_spare_pool`); drive clean only for devices that backed an array. The code parses ALL names and cleans ALL nvme devices.

- [ ] **Step 1: failing test** — `tests/test_uninstall_teardown_scoping.py`:

```python
"""WS2.3: RAID teardown must only touch xiNAS-managed names + never the OS disk."""

from pathlib import Path

TEARDOWN = Path("collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml")
SRC = TEARDOWN.read_text()


def test_array_names_filtered_to_managed():
    # The parsed names must pass through the managed-name filter before delete.
    assert "_xinas_managed_array_names" in SRC or "select('match'" in SRC, (
        "array names from xicli must be filtered to xiNAS-managed names "
        "(baseline or data/log/*_spare_pool match) before destroy (WS2.3)"
    )


def test_drive_clean_excludes_system_disks():
    assert "nvme_system_drives" in SRC or "resolve_system_disks" in SRC, (
        "drive clean must exclude the resolved OS disk set (WS2.3)"
    )
```

- [ ] **Step 2: red.**

- [ ] **Step 3: implement the managed-name filter.** After the existing parse tasks, add (names + regex per spec §4.3):

```yaml
    - name: "RAID | read managed names from the install baseline (preferred)"
      ansible.builtin.command: /usr/local/bin/xinas-history snapshot show baseline --format json
      register: _xinas_baseline_show
      changed_when: false
      failed_when: false

    - name: "RAID | filter to xiNAS-managed names (spec §4.3: baseline, else name-match)"
      ansible.builtin.set_fact:
        # Fallback pattern: the names xiNAS creates — data/dataN, log/logN,
        # and *_spare_pool. Arrays/pools with other names are NOT ours and are
        # preserved.
        _xinas_managed_array_names: >-
          {{ _xinas_array_names | default([])
             | select('match', '^(data|log)[0-9]*$')
             | list }}
        _xinas_managed_pool_names: >-
          {{ _xinas_pool_names | default([])
             | select('match', '^.*_spare_pool$')
             | list }}

    - name: "RAID | record preserved foreign arrays in the summary"
      ansible.builtin.set_fact:
        uninstall_summary: >-
          {{ uninstall_summary | combine({
               'preserved': uninstall_summary.preserved + [
                 'foreign xiRAID arrays/pools left untouched: '
                 ~ ((_xinas_array_names | default([]) | difference(_xinas_managed_array_names))
                    + (_xinas_pool_names | default([]) | difference(_xinas_managed_pool_names))
                   | join(', '))
               ]
             }) }}
      when: >-
        (_xinas_array_names | default([]) | difference(_xinas_managed_array_names) | length > 0)
        or (_xinas_pool_names | default([]) | difference(_xinas_managed_pool_names) | length > 0)
```

Baseline-preferred refinement: when `_xinas_baseline_show.rc == 0` and its JSON carries the created array/pool names, intersect the parsed names with the baseline's instead of the regex (keep the regex as the fallback when the baseline is absent/unreadable). Read the actual baseline JSON shape (`xinas_history` manifest `to_dict`) while implementing; if the baseline does not record array names in an extractable field, keep regex-only and note it in the spec §4.3 ("baseline source pending baseline schema — name-match in effect"). Do not invent fields.

Then repoint the delete loops: `loop: "{{ _xinas_managed_array_names | default([]) }}"` and `loop: "{{ _xinas_managed_pool_names | default([]) }}"`.

- [ ] **Step 4: implement the OS-disk exclusion.** Before the drive-clean task, resolve the protected set (reuse the tested resolver):

```yaml
    - name: "RAID | resolve OS disks to exclude from drive clean"
      ansible.builtin.include_role:
        name: nvme_namespace
        tasks_from: resolve_system_disks
      # publishes nvme_system_drives (list of /dev/... physical disks)
```

and rewrite the clean loop to skip any namespace whose parent disk is protected:

```yaml
    - name: "RAID | clean every non-OS NVMe device once arrays are gone"
      ansible.builtin.shell: |
        set +e
        protected="{{ nvme_system_drives | default([]) | join(' ') }}"
        for dev in /dev/nvme[0-9]*n[0-9]*; do
          [ -e "$dev" ] || continue
          parent="/dev/$(lsblk -no PKNAME "$dev" 2>/dev/null || true)"
          base="${dev%n[0-9]*}"
          skip=0
          for p in $protected; do
            [ "$parent" = "$p" ] && skip=1
            [ "$base" = "$p" ] && skip=1
            case "$dev" in "$p"*) skip=1 ;; esac
          done
          [ "$skip" = "1" ] && continue
          xicli drive clean -d "$dev" 2>/dev/null || true
        done
        exit 0
      args:
        executable: /bin/bash
      changed_when: false
```

- [ ] **Step 5: green** — pytest file; `ansible-lint collection/roles/xinas_uninstall/ collection/roles/nvme_namespace/` clean.

- [ ] **Step 6: spec touch.** In `docs/Installer/uninstall-spec.md` §4.3, if the baseline JSON turned out not to carry names (step 3), adjust point 1 to say name-match is the effective source until the baseline records names. Run markdownlint on the file.

- [ ] **Step 7: commit** — `fix(xinas_uninstall): scope RAID teardown to xiNAS-managed names; exclude OS disk from drive clean (WS2.3)`.

---

### Task 4 (WS2.4): banner cron symmetry

**Files:** Modify `collection/roles/motd/tasks/main.yml`; Test: extend `tests/test_uninstall_teardown_scoping.py` or a tiny `tests/test_motd_cron_symmetry.py` (new).

motd installs the banner refresh into ROOT'S CRONTAB (`ansible.builtin.cron` without `cron_file`), while `xinas_uninstall` removes `/etc/cron.d/xinas-banner`. Decision (per the remediation plan): standardize on `/etc/cron.d/xinas-banner`.

- [ ] **Step 1: failing test** — `tests/test_motd_cron_symmetry.py`:

```python
"""WS2.4: banner cron lives in /etc/cron.d/xinas-banner (what uninstall removes)."""

from pathlib import Path

import yaml

MOTD = Path("collection/roles/motd/tasks/main.yml")
UNINSTALL_PATHS = Path("collection/roles/xinas_uninstall/tasks/70_remove_paths.yml")


def test_motd_installs_cron_d_file():
    tasks = yaml.safe_load(MOTD.read_text())
    cron_tasks = [
        t.get("ansible.builtin.cron") or t.get("cron")
        for t in tasks
        if isinstance(t.get("ansible.builtin.cron") or t.get("cron"), dict)
    ]
    installs = [c for c in cron_tasks if c.get("state", "present") == "present"]
    assert installs, "motd must install the banner cron"
    assert all(c.get("cron_file") == "xinas-banner" for c in installs), (
        "banner cron must be a cron.d file (xinas-banner), not a user crontab (WS2.4)"
    )


def test_uninstall_removes_the_same_path():
    assert "/etc/cron.d/xinas-banner" in UNINSTALL_PATHS.read_text()
```

- [ ] **Step 2: red.**

- [ ] **Step 3: fix motd** — change the install task and add a migration cleanup for hosts upgraded from the old layout:

```yaml
- name: Remove legacy banner cron from root's crontab (pre-WS2.4 layout)
  ansible.builtin.cron:
    name: "Refresh xiNAS login banner"
    user: root
    state: absent
  tags: [motd, banner]

- name: Set up cron job to refresh banner
  ansible.builtin.cron:
    name: "Refresh xiNAS login banner"
    minute: "*/{{ banner_refresh_minutes }}"
    job: "/usr/local/bin/xinas-generate-banner"
    user: root
    cron_file: xinas-banner
    state: present
  when: banner_enabled | bool
  tags: [motd, banner]
```

(The legacy-removal task runs unconditionally — removing an absent entry is a no-op — so disabled-banner hosts also get cleaned.)

- [ ] **Step 4: green** + `ansible-lint collection/roles/motd/`.

- [ ] **Step 5: commit** — message MUST carry the trailer (the relocation only takes effect when the role re-runs on update):

```text
fix(motd): banner cron in /etc/cron.d/xinas-banner — symmetric with uninstall (WS2.4)

Migrates the legacy root-crontab entry away; uninstall already removes the
cron.d path, so the banner job no longer survives uninstall.

Requires-Rebuild: motd

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 5 (WS2.5): amend spec §4.3 step 5 (re-consolidation not performed)

**Files:** Modify `docs/Installer/uninstall-spec.md`.

- [ ] **Step 1: amend.** Replace §4.3 step 5's promise with the decision (2026-07-09, remediation WS2.5): namespace re-consolidation is **not performed**. Wording to adapt into the list style:

> NVMe namespaces are left exactly as they are. Re-consolidating to a
> single full-size namespace is **deliberately not performed**: the install
> baseline does not record the pre-install namespace layout, so a rebuild
> would be a guess — and a wrong guess is itself destructive. A subsequent
> xiNAS install reshapes namespaces via `nvme_namespace` anyway; operators
> who want a different layout after uninstall can use `nvme` CLI directly.
> (Revisit if the baseline ever records the pre-install layout.)

(Keep it as list item 5 in the spec itself — the numbering above is omitted
here only to satisfy the plan's own linter.)

- [ ] **Step 2:** `npx --yes markdownlint-cli2 'docs/Installer/uninstall-spec.md'` → 0 errors.

- [ ] **Step 3: commit** — `docs(uninstall-spec): §4.3 — namespace re-consolidation deliberately not performed (WS2.5)`.

---

### Task 6: remediation-plan bookkeeping + full gate

**Files:** Modify `docs/plans/2026-07-07-codebase-review-remediation-plan.md`.

- [ ] **Step 1:** In the WS2 section, tick `- [x]` on WS2.1–WS2.5 and add a status line under the `## WS2` heading mirroring WS1's: `> **Status <date>:** LANDED (<short-shas or branch>); §4.3.5 resolved by spec amendment (not performed).` Do NOT edit other workstreams.

- [ ] **Step 2: FULL GATE.** From repo root: `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q` (all green incl. the 3 new test files); `/tmp/xinas-pytest-venv/bin/ruff check xinas_menu xinas_history` + `ruff format --check` (new test files formatted); `pyright` unchanged; `ansible-lint collection/roles/`; `bash -n uninstall.sh`; `npx --yes markdownlint-cli2 'docs/**/*.md'`; `npx --yes yamllint -c .yamllint.yml .` (or skip if not installed locally — CI covers); `gitleaks git --config .gitleaks.toml --log-opts="origin/main..HEAD" .`. TS untouched — run `cd xiNAS-MCP && npm run test:contracts` only as a smoke (nothing should change).

- [ ] **Step 3: commit** — `docs(plans): WS2 landed — tick remediation checkboxes`.

---

## Self-Review

- **Coverage:** WS2.1→T1, WS2.2(a+b incl. F7)→T2, WS2.3(F3+F4)→T3, WS2.4(F6)→T4, WS2.5(F5, amend per user decision)→T5, bookkeeping→T6. All 7 findings mapped.
- **Spec-first:** every behavior change rides its owning-spec update in the same task (T1 config-history specs; T3/T5 uninstall-spec). motd has no owning spec — the uninstall-spec's path list is the contract and already names `/etc/cron.d/xinas-banner`.
- **Requires-Rebuild:** only T4 (`motd`), justified (relocation needs a role re-run); T1–T3 take effect on next run by construction.
- **No placeholders;** all code blocks concrete. Two explicitly-bounded adaptation points (T2 regexes to final script shape; T3 baseline-JSON shape "do not invent fields" with a spec-note fallback) are instructions, not gaps.
- **Type consistency:** fact names (`_xinas_managed_array_names`/`_xinas_managed_pool_names`, `nvme_system_drives`) used consistently across T3's steps and test.
