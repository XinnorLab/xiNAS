# WS3 — Installer & update-flow correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 12 verified WS3 findings (F1–F12) in the bash installer and the Python update flow so that install/update behavior matches `docs/Installer/update-spec.md` and `docs/Installer/spec.md` exactly — no swallowed exit codes, no fabricated licenses, semver-correct and force-checkout update logic in every bash path, a pinned+checksummed `yq`, a fail-closed preset copy, an honest install-failure dialog, and the new `xinas-update-helper-sync` privileged wrapper with its four-outcome NFS-helper refresh contract.

**Architecture:** Two parallel surfaces get fixed in the same change set: the bash installer (`prepare_system.sh`, `install.sh`, `startup_menu.sh`, `simple_menu.sh`, `install_client.sh`, `autoinstall.sh`, `lib/menu_lib.sh`) and the Python update path (`xinas_menu/utils/update_check.py`, a new `xinas_menu/utils/update_apply.py` shared orchestrator, `xinas_menu/app.py`, `xinas_menu/screens/startup/startup_menu.py`), plus one new Ansible-deployed privileged wrapper (`collection/roles/xinas_menu/files/xinas-update-helper-sync`). Tests follow the two behavioral precedents already in the repo (`tests/test_nvme_resolve_system_disks.py` — stub external binaries on `PATH`, run the real script; `tests/test_playbook_ticker_callback.py` — source `lib/menu_lib.sh` and drive a real function), falling back to structural/regex assertions only where root privileges or full interactive-TUI navigation make real execution impractical (documented per-task).

**Tech Stack:** Bash (installer surfaces, `set -e`/`pipefail` semantics), Python 3.12+ (Textual TUI, `pytest`), Ansible (role deployment, `ansible-lint`), `ruff` (CI-scoped), `markdownlint-cli2`, `gitleaks`.

---

## Conventions

- **TDD:** failing test → red → minimal fix → green → commit. Doc-only tasks (there are none pure doc-only in this plan, but the bookkeeping task T15 touches only the remediation-plan doc): markdownlint is the check.
- **Python venv:** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`; `/tmp/xinas-pytest-venv/bin/python -m ruff check <paths>` / `ruff format --check <paths>`.
- **CI only runs `ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper` — NOT `tests/`.** Do not chase format failures in `tests/`. (Confirmed against `.github/workflows/ci.yml:122,134`.)
- **Bash:** `bash -n <script>` must pass for every touched script. `ansible-lint collection/roles/` stays green.
- **Commits:** per task, explicit paths (never `git add -A`), ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **CRITICAL: no blank line between `Requires-Rebuild:` and `Co-Authored-By:` — git drops a trailer separated by a blank line.**
- **`Requires-Rebuild: xinas_menu` goes on T11's commit ONLY** (the task that deploys the new `xinas-update-helper-sync` wrapper + sudoers grant via the `xinas_menu` role). Per `docs/Installer/update-spec.md` "Bootstrapping the helper-sync wrapper," this is the bootstrapping mechanism the spec requires — not optional; a host that never re-runs the `xinas_menu` role never gets the wrapper and permanently hits the "wrapper absent" branch. No other task in this plan gets a trailer: every other fix is bash/Python logic that takes effect the moment the new code is checked out (menu scripts re-exec on next launch; `xinas_menu/utils/update_check.py` is interpreted, not compiled/installed by a role step).
- **Verified findings:** F1–F12 re-confirmed against this worktree's current line numbers on 2026-07-10 (see the finding table in the owning remediation-plan entry, `docs/plans/2026-07-07-codebase-review-remediation-plan.md` §WS3). Line numbers below are current as of this plan's writing; re-verify with `grep -n` before editing if time has passed.

---

## File Structure

| File | Responsibility | Task |
|------|-----------------|------|
| `prepare_system.sh` | errexit-safe menu-exit-code capture; pinned+checksummed `yq` install | T1, T9 |
| `install.sh` | errexit-safe `prepare_system.sh` call; forced checkout | T1, T5 |
| `simple_menu.sh` | license-recovery mirror; synchronous update check; semver compare; forced checkout; hwkey guard; `XINAS_UPDATE_REPO` removal | T2, T3, T4, T5, T6, T14 |
| `startup_menu.sh` | synchronous update check; semver compare; forced checkout; hwkey guard; `XINAS_UPDATE_REPO` removal | T3, T4, T5, T6, T14 |
| `lib/menu_lib.sh` | shared `_semver_gt`/`_semver_parse` helper; install-failure dialog wiring to `collect_data.sh` | T4, T10 |
| `install_client.sh` | propagate git failures; forced checkout (deferred from T5) | T7 |
| `autoinstall.sh` | fail-closed preset copy | T8 |
| `post_install_menu.sh` | `XINAS_UPDATE_REPO` removal | T14 |
| `client_repo/client_setup.sh` | `XINAS_UPDATE_REPO` removal | T14 |
| `collection/roles/xinas_menu/files/xinas-update-helper-sync` (new) | privileged NFS-helper refresh wrapper | T11 |
| `collection/roles/xinas_menu/files/sudoers-xinas-update` | grant for the new wrapper | T11 |
| `collection/roles/xinas_menu/tasks/main.yml` | install task for the new wrapper | T11 |
| `xinas_menu/utils/update_check.py` | `refresh_nfs_helper()` (four outcomes); `apply_update()` no longer syncs the helper; `XINAS_UPDATE_REPO` removal | T12, T14 |
| `xinas_menu/utils/update_apply.py` (new) | shared `apply_update_flow()` orchestration (checkout → rebuild → refresh → restart) | T13 |
| `xinas_menu/app.py` | `XiNASApp._apply_update` delegates to the shared flow | T13 |
| `xinas_menu/screens/startup/startup_menu.py` | `StartupApp._apply_update` delegates to the shared flow | T13 |
| `tests/test_bash_syntax_sweep.py` (new) | `bash -n` over every repo `*.sh` | T1 |
| `tests/test_installer_exit_code_contract.py` (new) | T1 behavioral + extracted-snippet tests | T1 |
| `tests/test_simple_menu_license_recovery.py` (new) | T2 structural guard | T2 |
| `tests/test_update_check_backgrounding.py` (new) | T3 pty + structural guard | T3 |
| `tests/test_bash_semver_compare.py` (new) | T4 behavioral table | T4 |
| `tests/test_bash_checkout_force_parity.py` (new) | T5 behavioral (prepare_system.sh) + structural (rest) | T5 |
| `tests/test_hwkey_guard.py` (new) | T6 extracted-snippet execution | T6 |
| `tests/test_install_client_update_accuracy.py` (new) | T7 structural | T7 |
| `tests/test_autoinstall_preset_fail_closed.py` (new) | T8 extracted-snippet execution | T8 |
| `tests/test_prepare_system_yq_pin.py` (new) | T9 extracted-snippet execution | T9 |
| `tests/test_install_failure_collect_wiring.py` (new) | T10 behavioral | T10 |
| `tests/test_xinas_update_helper_sync_role.py` (new) | T11 structural + `ansible-lint` | T11 |
| `tests/test_nfs_helper_refresh_outcomes.py` (new) | T12 outcome matrix | T12 |
| `tests/test_update_check.py` | edit: drop stale `_sync_nfs_helper` monkeypatch | T12 |
| `tests/test_update_apply_orchestration.py` (new) | T13 orchestration matrix | T13 |
| `tests/test_update_repo_env_var_removed.py` (new) | T14 grep + behavioral | T14 |
| `docs/plans/2026-07-07-codebase-review-remediation-plan.md` | tick WS3.1–WS3.6, add Status line | T15 |

---

## Task 1 (F1, WS3.1): errexit/exit-2 contract

**Files:** Modify `prepare_system.sh`, `install.sh`. Create `tests/test_installer_exit_code_contract.py`, `tests/test_bash_syntax_sweep.py`.

**The bug.** `prepare_system.sh:4` sets `set -e`. Lines 184–194:

```bash
if [ "$EXPERT" -eq 1 ]; then
    ./startup_menu.sh
    status=$?
else
    ./simple_menu.sh
    status=$?
fi

if [ "$status" -eq 2 ]; then
    exit 0
fi
```

`startup_menu.sh`/`simple_menu.sh` both `exit 2` when the operator picks "Exit" (`startup_menu.sh:814`, `simple_menu.sh:727`) — a deliberate, non-error exit per `docs/Installer/spec.md` §2.7. Under `set -e`, a bare `cmd` that returns non-zero kills the shell **on that line**, before `status=$?` on the next line ever runs — so the `if [ "$status" -eq 2 ]` branch is dead code and `prepare_system.sh` itself exits 2. `install.sh:9` also sets `set -e`, and `install.sh:251` calls `./prepare_system.sh` unguarded:

```bash
XINAS_QUIET=1 XINAS_UNATTENDED="$UNATTENDED" XINAS_LOG="$LOG_FILE" ./prepare_system.sh
```

So a clean "Exit" from the menu propagates as exit 2 all the way up through `install.sh`, which aborts under its own errexit **before** reaching the "Ensure xinas-menu wrapper exists" step at `install.sh:271-298` — the operator never gets `/usr/local/bin/xinas-menu`. `install.sh:260-264` already has the correct pattern for its `autoinstall.sh` call:

```bash
set +e
./autoinstall.sh
rc=$?
set -e
exit "$rc"
```

Per `docs/Installer/spec.md` §2.7, **both** callers must independently use this capture pattern — copy it into `prepare_system.sh`'s own menu call and into `install.sh`'s `prepare_system.sh` call.

- [ ] **Step 1: failing test.** Create `tests/test_installer_exit_code_contract.py`:

```python
"""WS3.1 (T1, F1): prepare_system.sh and install.sh must not let a menu's
deliberate `exit 2` (operator chose "Exit") propagate as a real failure
(docs/Installer/spec.md §2.7). Both run under `set -e`; a bare
`cmd; status=$?` does not protect a non-zero `cmd` from errexit, so the
status capture must be wrapped in `set +e ... set -e`.

The first suite runs the real prepare_system.sh end-to-end with stubbed
menu scripts (only the exit-2 contract is a menu concern; the package-
install block is bypassed by stubbing `sudo` as a no-op, since every
privileged command in prepare_system.sh runs through `sudo`). The second
suite extracts install.sh's guarded "Preparing system" block verbatim and
executes it with a stub ./prepare_system.sh — install.sh itself requires
root (EUID check) and performs real system mutations before reaching this
step, so full end-to-end execution is impractical; the guarded-call PATTERN
is extracted and exercised directly instead.
"""

import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PREPARE_SYSTEM = REPO / "prepare_system.sh"
INSTALL_SH = REPO / "install.sh"


def _sandbox(tmp_path: Path) -> Path:
    """A minimal repo-shaped CWD so prepare_system.sh skips the clone path."""
    (tmp_path / "ansible.cfg").write_text("")
    (tmp_path / "playbooks").mkdir()
    hwkey = tmp_path / "hwkey"
    hwkey.write_text("#!/bin/bash\necho STUBHWKEY\n")
    hwkey.chmod(0o755)
    return tmp_path


def _run_prepare_system(tmp_path: Path, *, expert: bool, menu_exit_code: int):
    sandbox = _sandbox(tmp_path)
    menu_name = "startup_menu.sh" if expert else "simple_menu.sh"
    menu = sandbox / menu_name
    menu.write_text(f"#!/bin/bash\nexit {menu_exit_code}\n")
    menu.chmod(0o755)

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    # Every privileged command in prepare_system.sh runs through `sudo` — a
    # no-op stub keeps the package-install block hermetic without touching
    # apt/wget for real.
    (stub_bin / "sudo").write_text("#!/bin/bash\nexit 0\n")
    (stub_bin / "sudo").chmod(0o755)

    env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}", XINAS_QUIET="1")
    args = ["-e"] if expert else []
    return subprocess.run(
        ["bash", str(PREPARE_SYSTEM), *args],
        cwd=sandbox, env=env, capture_output=True, text=True, timeout=30,
    )


def test_default_menu_exit_2_is_not_a_failure(tmp_path):
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=2)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"


def test_expert_menu_exit_2_is_not_a_failure(tmp_path):
    proc = _run_prepare_system(tmp_path, expert=True, menu_exit_code=2)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"


def test_real_menu_failure_still_propagates(tmp_path):
    # A genuine crash (not the Exit choice) must still abort with that code —
    # the fix must not swallow every exit code, only 2.
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=1)
    assert proc.returncode == 1


def _extract_install_sh_prepare_block() -> str:
    src = INSTALL_SH.read_text()
    m = re.search(r'step "Preparing system".*?\nfi\n', src, re.S)
    assert m, "install.sh's 'Preparing system' step block not found"
    return m.group(0)


def _run_install_sh_prepare_block(tmp_path: Path, *, prepare_exit_code: int):
    stub_prepare = tmp_path / "prepare_system.sh"
    stub_prepare.write_text(f"#!/bin/bash\nexit {prepare_exit_code}\n")
    stub_prepare.chmod(0o755)

    snippet = (
        "set -e\n"
        'WHITE=""; NC=""; UNATTENDED="0"; LOG_FILE="/tmp/nonexistent.log"\n'
        'step() { :; }\n'
        'info() { :; }\n'
        'fail() { echo "FAIL: $*" >&2; }\n'
        + _extract_install_sh_prepare_block()
        + '\necho "REACHED_END"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )


def test_install_sh_prepare_block_continues_on_success(tmp_path):
    proc = _run_install_sh_prepare_block(tmp_path, prepare_exit_code=0)
    assert proc.returncode == 0, proc.stderr
    assert "REACHED_END" in proc.stdout


def test_install_sh_prepare_block_aborts_on_real_failure(tmp_path):
    proc = _run_install_sh_prepare_block(tmp_path, prepare_exit_code=1)
    assert proc.returncode == 1
    assert "REACHED_END" not in proc.stdout
```

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_installer_exit_code_contract.py -q` → `test_default_menu_exit_2_is_not_a_failure` and `test_expert_menu_exit_2_is_not_a_failure` FAIL (both currently return 2); `test_install_sh_prepare_block_continues_on_success` FAILS too (the extracted block, copied from the CURRENT unfixed file, has no `set +e`/`set -e` guard yet — it will not exist until Step 3, so write this test file only after confirming the regex extracts the CURRENT unguarded lines; if `_extract_install_sh_prepare_block`'s regex doesn't match the pre-fix text, adjust the regex to the actual current line, then re-run red).

- [ ] **Step 3: fix `prepare_system.sh` (lines 184–194).** Replace:

```bash
if [ "$EXPERT" -eq 1 ]; then
    ./startup_menu.sh
    status=$?
else
    ./simple_menu.sh
    status=$?
fi

if [ "$status" -eq 2 ]; then
    exit 0
fi
```

with:

```bash
set +e
if [ "$EXPERT" -eq 1 ]; then
    ./startup_menu.sh
    status=$?
else
    ./simple_menu.sh
    status=$?
fi
set -e

if [ "$status" -eq 2 ]; then
    exit 0
fi
```

- [ ] **Step 4: fix `install.sh` (lines 247–251).** Replace:

```bash
step "Preparing system"
info "Detailed log: ${WHITE}${LOG_FILE}${NC}"

XINAS_QUIET=1 XINAS_UNATTENDED="$UNATTENDED" XINAS_LOG="$LOG_FILE" ./prepare_system.sh
```

with:

```bash
step "Preparing system"
info "Detailed log: ${WHITE}${LOG_FILE}${NC}"

set +e
XINAS_QUIET=1 XINAS_UNATTENDED="$UNATTENDED" XINAS_LOG="$LOG_FILE" ./prepare_system.sh
prep_rc=$?
set -e
if [[ $prep_rc -ne 0 ]]; then
    fail "System preparation failed (exit ${prep_rc}) — see ${LOG_FILE}"
    exit "$prep_rc"
fi
```

- [ ] **Step 5: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_installer_exit_code_contract.py -q` → all pass.

- [ ] **Step 6: bash -n sweep.** Create `tests/test_bash_syntax_sweep.py`:

```python
"""Every *.sh in the repo must at least parse. Cheap, repo-wide guard —
complements the per-file `bash -n` checks already embedded in individual
test files (test_uninstall_script_safety.py, etc.) with one sweep that
catches new scripts automatically.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__"}


def _all_shell_scripts():
    for p in REPO.rglob("*.sh"):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        yield p


def test_every_shell_script_parses():
    scripts = list(_all_shell_scripts())
    assert scripts, "no *.sh files found — sweep glob is broken"
    failures = []
    for script in scripts:
        proc = subprocess.run(
            ["bash", "-n", str(script)], capture_output=True, text=True
        )
        if proc.returncode != 0:
            failures.append(f"{script.relative_to(REPO)}: {proc.stderr.strip()}")
    assert not failures, "bash -n failed for:\n" + "\n".join(failures)
```

  Run `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_bash_syntax_sweep.py -q` → green (this only exercises `bash -n`, so it should already pass before Steps 3–4; it's here to catch any accidental syntax error the edits introduce).

- [ ] **Step 7: commit.**

```bash
git add prepare_system.sh install.sh tests/test_installer_exit_code_contract.py tests/test_bash_syntax_sweep.py
git commit -m "$(cat <<'EOF'
fix(installer): guard menu exit-2 against errexit in prepare_system.sh and install.sh

set -e kills a failing simple command before the next line's status=$? can
run, so the existing "if [ "$status" -eq 2 ]" check was dead code and a
clean menu Exit propagated as a real failure through install.sh, aborting
before the xinas-menu wrapper was installed (WS3.1, F1). Wrap both calls in
set +e / set -e, mirroring the pattern install.sh already uses for
autoinstall.sh.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 (F3, WS3.2): fabricated-license path in `simple_menu.sh`

**Files:** Modify `simple_menu.sh`. Create `tests/test_simple_menu_license_recovery.py`.

**The bug.** `simple_menu.sh` writes `xicli license show` output — which carries `hwkey`/`status`/metadata but **not** the `license_key` blob — directly to the canonical license path at three sites: lines 149–150 (`enter_license`, "Replace — recover from xiRAID"), lines 170–171 (`enter_license`, no-license-file recovery), and line 691 (main-menu "Install" auto-recovery). That fabricated file is later fed to `xicli license update -p {{ xiraid_license_path }}` (`collection/roles/raid_fs/tasks/main.yml:71`), producing a parser error or a misleading partial success. `startup_menu.sh` already carries the fix (`_save_recovered_license_note()`, lines 186–193) — mirror it into `simple_menu.sh` verbatim, per `docs/Installer/spec.md` §8.2 (the license-recovery invariant binds every installer surface).

- [ ] **Step 1: failing test.** Create `tests/test_simple_menu_license_recovery.py`:

```python
"""WS3.2 (T2, F3): simple_menu.sh must never write `xicli license show`
output straight to the canonical license path (docs/Installer/spec.md §8.2 —
that output has no license_key blob, so it is unusable by
`xicli license update -p`). startup_menu.sh already carries the fix
(_save_recovered_license_note, writing only <file>.recovered); mirror it.

Structural: driving simple_menu.sh's interactive menu_select prompts end to
end would need a full pty + arrow-key/digit-key navigation harness for a
pure text-content fix; a regex guard on the source (the same pattern already
used for startup_menu.sh's own regression coverage) is the practical check.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIMPLE = REPO / "simple_menu.sh"
STARTUP = REPO / "startup_menu.sh"


def test_helper_function_mirrored_from_startup_menu():
    assert "_save_recovered_license_note" in SIMPLE.read_text(), (
        "simple_menu.sh must define _save_recovered_license_note(), mirrored "
        "from startup_menu.sh's reference implementation"
    )


def test_xiraid_license_output_never_redirected_to_canonical_path():
    body = SIMPLE.read_text()
    # The only acceptable destination for $_XIRAID_LICENSE_OUTPUT is the
    # helper's own ".recovered" note file, never /tmp/license or
    # "$license_file" directly.
    assert not re.search(r'\$_XIRAID_LICENSE_OUTPUT"?\s*>\s*"?\$license_file', body)
    assert not re.search(r'\$_XIRAID_LICENSE_OUTPUT"?\s*>\s*/tmp/license\b', body)


def test_recovered_note_path_used_at_all_three_sites():
    body = SIMPLE.read_text()
    assert body.count("_save_recovered_license_note") >= 4  # 1 def + 3 call sites


def test_matches_startup_menu_function_body():
    # Same function body as the reference implementation (allow whitespace
    # drift only).
    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip()

    fn_re = re.compile(r"_save_recovered_license_note\(\)\s*\{.*?\n\}", re.S)
    simple_fn = fn_re.search(SIMPLE.read_text())
    startup_fn = fn_re.search(STARTUP.read_text())
    assert simple_fn and startup_fn
    assert _norm(simple_fn.group(0)) == _norm(startup_fn.group(0))
```

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_simple_menu_license_recovery.py -q` → all four FAIL (function doesn't exist yet).

- [ ] **Step 3: add the helper function.** In `simple_menu.sh`, immediately after `_xiraid_has_license()` (after its closing `}`, before `enter_license()`), add — verbatim from `startup_menu.sh:186-193`:

```bash
# Finding #4: `xicli license show` output is NOT a usable license file — it
# carries the hwkey/status/metadata but no license_key blob, so it cannot be fed
# back to `xicli license update -p`. Never write it to the canonical license
# path. Save the captured details to <file>.recovered for reference and return 1
# so callers fall through to manual license entry.
_save_recovered_license_note() {
    local license_file="${1:-/tmp/license}"
    local note="${license_file}.recovered"
    printf '%s\n' "$_XIRAID_LICENSE_OUTPUT" > "$note" 2>/dev/null || true
    msg_box "Cannot Auto-Recover License" \
        "xiRAID reports an active license, but 'xicli license show' is not a\nusable license file (no license key), so it cannot be reinstalled.\n\nCaptured details saved for reference:\n  $note\n\nPaste your original license, or place the license file at:\n  $license_file"
    return 1
}
```

- [ ] **Step 4: fix call site 1** (`enter_license`, choice 3 "Replace — recover from xiRAID", currently lines 147–152). Replace:

```bash
                3)
                    cp "$license_file" "${license_file}.$(date +%Y%m%d%H%M%S).bak"
                    echo "$_XIRAID_LICENSE_OUTPUT" > "$license_file"
                    msg_box "License Recovered" "License key recovered from running xiRAID\nand saved to $license_file"
                    return 0
                    ;;
```

with:

```bash
                3)
                    # Cannot recover a usable license from `xicli license show`
                    # (finding #4) — note it and fall through to manual paste.
                    _save_recovered_license_note "$license_file" || true
                    ;;
```

  (This now falls through to the shared `cp "$license_file" "${license_file}...bak"` line already present just below the `case`/`esac`, then to the hwkey + paste flow — identical control flow to `startup_menu.sh`.)

- [ ] **Step 5: fix call site 2** (`enter_license`, no-license-file recovery, currently lines 168–171). Replace:

```bash
        case "$choice" in
            1)
                echo "$_XIRAID_LICENSE_OUTPUT" > "$license_file"
                msg_box "License Recovered" "License key recovered from running xiRAID\nand saved to $license_file"
                return 0
                ;;
            2) ;; # fall through to manual paste
            0) return 0 ;;
        esac
```

with:

```bash
        case "$choice" in
            1)
                # `xicli license show` is not a reinstallable license (finding
                # #4) — note it and fall through to manual paste.
                _save_recovered_license_note "$license_file" || true
                ;;
            2) ;; # fall through to manual paste
            0) return 0 ;;
        esac
```

- [ ] **Step 6: fix call site 3** (main-menu "Install," currently lines 688–694). Replace:

```bash
            if ! has_license; then
                # Try to recover license from running xiRAID
                if _xiraid_has_license; then
                    echo "$_XIRAID_LICENSE_OUTPUT" > /tmp/license
                    msg_box "License Recovered" "License key recovered from running xiRAID\nand saved to /tmp/license"
                else
```

with:

```bash
            if ! has_license; then
                # Try to recover license from running xiRAID
                if _xiraid_has_license; then
                    # `xicli license show` can't be reinstalled (finding #4):
                    # don't fabricate /tmp/license. Note it and require a real
                    # license file.
                    _save_recovered_license_note /tmp/license || true
                    continue
                else
```

  (`continue` replaces falling through to `if ! check_license; then continue; fi`, so the operator sees the recovery note once instead of also immediately hitting a redundant "License Required" box.)

- [ ] **Step 7: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_simple_menu_license_recovery.py -q` → all pass. `bash -n simple_menu.sh` → clean.

- [ ] **Step 8: commit.**

```bash
git add simple_menu.sh tests/test_simple_menu_license_recovery.py
git commit -m "$(cat <<'EOF'
fix(installer): stop fabricating /tmp/license from xicli license show in simple_menu.sh

xicli license show carries hwkey/status/metadata but no license_key blob, so
writing it to the canonical license path produces a parser error or a
misleading partial success (docs/Installer/spec.md §8.2, F3). Mirror
startup_menu.sh's _save_recovered_license_note() at all three simple_menu.sh
call sites: save a non-canonical .recovered note and require the operator to
re-supply the real license.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 (F4): update-check subshell race

**Files:** Modify `startup_menu.sh`, `simple_menu.sh`. Create `tests/test_update_check_backgrounding.py`.

**The bug.** `startup_menu.sh:144` runs `check_for_updates &` — a **backgrounded** call. Bash never propagates a subshell's variable assignments back to the parent shell, so `UPDATE_AVAILABLE`/`UPDATE_TARGET_TAG` (declared at `startup_menu.sh:42-43`, assigned inside `check_for_updates` at `startup_menu.sh:79-80`) are set only in the throwaway child and stay empty in the parent forever — the "Update available!" banner and the Advanced Settings badge never appear from the automatic check (the *manual* re-check at `startup_menu.sh:754`, called synchronously, works fine — that's the existing proof the function itself is correct).

`simple_menu.sh:67` has the byte-identical bug (`check_for_updates &`, same var names, same function). It is not separately numbered in the finding list, but it is the same root cause in the default (non-expert) menu — the one most installs actually run — so this task fixes both call sites; see the Report's deviation note.

- [ ] **Step 1: failing test.** Create `tests/test_update_check_backgrounding.py`:

```python
"""WS3.3 (T3, F4): check_for_updates must run synchronously so its
UPDATE_AVAILABLE / UPDATE_TARGET_TAG assignments are visible to the parent
shell that prints the "Update available!" banner — bash never propagates a
background subshell's variables back to its parent.

Behavioral: runs the real, unmodified startup_menu.sh under a pty (using
pty.fork() so /dev/tty resolves to the child's controlling terminal —
menu_select/msg_box explicitly open /dev/tty, unlike the ticker path in
test_playbook_ticker_callback.py, which only checks `[ -t 1 ]`). Stubs
git/curl/timeout on PATH so check_for_updates deterministically finds (or
doesn't find) an update, drives the main menu to Exit by sending the digit
key "0" (menu_select's [0-9] case matches immediately, no Enter needed) then
"\\n" to dismiss the confirmation msg_box, and asserts on the captured
terminal transcript.

A cheap structural guard (no pty) complements this, following the existing
"static guard survives a constrained CI" precedent in
test_playbook_ticker_callback.py.
"""
import os
import pty
import re
import textwrap
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _stub_bin(tmp_path: Path, *, latest_tag: str, current_tag: str) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "timeout").write_text("#!/bin/bash\nexit 0\n")
    (bin_dir / "timeout").chmod(0o755)
    (bin_dir / "curl").write_text(
        "#!/bin/bash\n"
        f'echo \'{{"tag_name": "{latest_tag}"}}\'\n'
    )
    (bin_dir / "curl").chmod(0o755)
    (bin_dir / "git").write_text(textwrap.dedent(f"""\
        #!/bin/bash
        for a in "$@"; do
            if [[ "$a" == "describe" ]]; then
                echo "{current_tag}"
                exit 0
            fi
        done
        exit 0
        """))
    (bin_dir / "git").chmod(0o755)
    return bin_dir


def _drive(script_path: Path, sandbox: Path, bin_dir: Path) -> tuple[str, int]:
    driver = textwrap.dedent(f"""\
        cd "{sandbox}"
        export PATH="{bin_dir}:$PATH"
        exec bash "{script_path}"
        """)
    pid, master = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "-c", driver])
        os._exit(1)  # pragma: no cover — only reached on exec failure

    output = bytearray()
    time.sleep(1.0)  # let check_for_updates + the first render settle
    os.write(master, b"0\n")  # select "0" (Exit), then dismiss the msg_box
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
    os.close(master)
    _, status = os.waitpid(pid, 0)
    return output.decode("utf-8", "replace"), os.WEXITSTATUS(status)


def _sandbox(tmp_path: Path) -> Path:
    sandbox = tmp_path / "repo"
    sandbox.mkdir()
    (sandbox / ".git").mkdir()
    return sandbox


def test_startup_menu_shows_banner_when_update_available(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v9.9.9", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "startup_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" in plain, (
        "banner did not appear -> check_for_updates' variables were not "
        f"visible to the parent shell.\n--- transcript ---\n{plain}"
    )


def test_startup_menu_no_banner_when_up_to_date(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v1.0.0", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "startup_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" not in plain


def test_simple_menu_shows_banner_when_update_available(tmp_path):
    sandbox = _sandbox(tmp_path)
    bin_dir = _stub_bin(tmp_path, latest_tag="v9.9.9", current_tag="v1.0.0")
    transcript, exit_code = _drive(REPO / "simple_menu.sh", sandbox, bin_dir)
    assert exit_code == 2
    plain = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", transcript)
    assert "Update available!" in plain


def test_no_backgrounded_call_site_remains():
    for f in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / f).read_text()
        assert not re.search(r"^check_for_updates\s*&\s*$", body, re.M), (
            f"{f} still backgrounds check_for_updates (F4)"
        )
        assert re.search(r"^check_for_updates\s*$", body, re.M), (
            f"{f} must call check_for_updates synchronously"
        )
```

  **Note on flakiness:** the pty tests use a fixed `1.0s` settle sleep before sending the exit keystroke; if this proves flaky on the target CI runner, replace it with a poll loop reading `master` until the main-menu prompt text appears, then send the keystroke (same technique `test_playbook_ticker_callback.py` avoids needing because it never sends input). Keep the three structural/no-pty tests as the CI-robust fallback regardless.

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_update_check_backgrounding.py -q` → the three banner tests and the structural guard FAIL (`check_for_updates &` is still backgrounded).

- [ ] **Step 3: fix `startup_menu.sh:144`.** Replace:

```bash
# Run update check in background
check_for_updates &
```

with:

```bash
# Run synchronously (NOT backgrounded): a background subshell's
# UPDATE_AVAILABLE/UPDATE_TARGET_TAG assignments are invisible to this parent
# shell — bash never propagates a subshell's variables back to its parent —
# so `check_for_updates &` silently discarded every result (F4). The
# function's own `timeout 2` dtcp probe plus a fast curl call bound the
# worst-case delay when GitHub is unreachable.
check_for_updates
```

- [ ] **Step 4: fix `simple_menu.sh:67`** (identical bug, same fix):

```bash
# Run synchronously (NOT backgrounded) — see startup_menu.sh for why.
check_for_updates
```

- [ ] **Step 5: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_update_check_backgrounding.py -q` → all pass. `bash -n startup_menu.sh simple_menu.sh` clean.

- [ ] **Step 6: commit.**

```bash
git add startup_menu.sh simple_menu.sh tests/test_update_check_backgrounding.py
git commit -m "$(cat <<'EOF'
fix(installer): run check_for_updates synchronously, not backgrounded

`check_for_updates &` set UPDATE_AVAILABLE/UPDATE_TARGET_TAG only inside a
throwaway subshell — bash never propagates a background job's variables to
its parent, so the automatic update banner never appeared in either menu
(WS3.3, F4). Both startup_menu.sh and simple_menu.sh share the exact bug;
fixed in both.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 (F6): semver comparison in bash

**Files:** Modify `lib/menu_lib.sh` (new `_semver_parse`/`_semver_gt` helpers), `startup_menu.sh`, `simple_menu.sh`. Create `tests/test_bash_semver_compare.py`.

**The bug.** `startup_menu.sh:78` and `simple_menu.sh:41` both decide "update available" via `if [[ "$current_tag" != "$latest_tag" ]]`, a plain string inequality. Per `docs/Installer/update-spec.md` "Bash-path parity," this MUST be semantic-version ordering — a string compare reports "update available" whenever the tag strings differ **at all**, including when the feed's tag is *older*, which can walk an installation backwards. Both menus source `lib/menu_lib.sh` already, so the shared helper goes there.

- [ ] **Step 1: failing test.** Create `tests/test_bash_semver_compare.py`:

```python
"""WS3.3 (T4, F6): update-available decisions in the bash menus must use
semantic-version ordering, not string inequality (docs/Installer/update-spec.md
"Bash-path parity"). Mirrors xinas_menu/utils/update_check.py's _semver_key
precedence: a final release outranks a prerelease of the same X.Y.Z.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"


def _semver_gt(a: str, b: str) -> bool:
    script = f'source "{MENU_LIB}" >/dev/null 2>&1; _semver_gt "{a}" "{b}"'
    proc = subprocess.run(["bash", "-c", script])
    return proc.returncode == 0


def test_newer_patch_is_greater():
    assert _semver_gt("v3.1.1", "v3.1.0") is True
    assert _semver_gt("v3.1.0", "v3.1.1") is False


def test_equal_versions_not_greater():
    assert _semver_gt("v3.1.0", "3.1.0") is False
    assert _semver_gt("3.1.0", "v3.1.0") is False


def test_v_prefix_equivalence():
    assert _semver_gt("v3.2.0", "3.1.9") is True


def test_final_release_outranks_prerelease_same_xyz():
    assert _semver_gt("v3.2.0", "v3.2.0-rc.1") is True
    assert _semver_gt("v3.2.0-rc.1", "v3.2.0") is False


def test_older_release_is_not_greater():
    assert _semver_gt("v3.0.9", "v3.1.0") is False


def test_unparseable_tags_report_not_greater():
    # No comparison possible must never manufacture a false "update available".
    assert _semver_gt("v3.1.1", "") is False
    assert _semver_gt("v3.1.1", "not-a-tag") is False
    assert _semver_gt("", "v3.1.1") is False


def test_check_for_updates_uses_semver_not_string_inequality():
    for f in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / f).read_text()
        assert '"$current_tag" != "$latest_tag"' not in body, (
            f"{f} still compares release tags by string inequality (F6)"
        )
        assert "_semver_gt" in body, f"{f} must call the shared _semver_gt helper"
```

- [ ] **Step 2: red.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_bash_semver_compare.py -q` → all FAIL (`_semver_gt` doesn't exist; call sites still use `!=`).

- [ ] **Step 3: add the helper to `lib/menu_lib.sh`.** Append near the other small standalone helpers (e.g. after `msg_info`/`print_status`, before `_xinas_playbook_ticker`):

```bash
# ═══════════════════════════════════════════════════════════════════════════════
# _semver_gt / _semver_parse - pure-bash semantic-version comparison
# ═══════════════════════════════════════════════════════════════════════════════
# Mirrors xinas_menu/utils/update_check.py's _parse_semver / _semver_key so the
# bash update paths and the Python updater agree on ordering (a final release
# outranks a prerelease of the same X.Y.Z). Accepts an optional "v" prefix and
# an optional "-prerelease" suffix; build metadata ("+...") is stripped.

# Prints "MAJOR MINOR PATCH PRERELEASE" on success; returns 1 (and prints
# nothing) if $1 is not parseable as X.Y.Z.
_semver_parse() {
    local v="$1"
    v="${v#v}"; v="${v#V}"
    v="${v%%+*}"
    local core="${v%%-*}"
    local pre=""
    [[ "$v" == *-* ]] && pre="${v#*-}"
    local maj min pat
    IFS='.' read -r maj min pat <<< "$core"
    [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ && "$pat" =~ ^[0-9]+$ ]] || return 1
    printf '%s %s %s %s\n' "$maj" "$min" "$pat" "$pre"
}

# True (exit 0) iff $1 is a strictly newer semantic version than $2. False
# (exit 1) on a tie, on $1 older than $2, or if either argument fails to
# parse — an unparseable tag must never be treated as "older" in a way that
# manufactures a false "update available".
_semver_gt() {
    local a b
    a=$(_semver_parse "$1") || return 1
    b=$(_semver_parse "$2") || return 1
    local a_maj a_min a_pat a_pre b_maj b_min b_pat b_pre
    read -r a_maj a_min a_pat a_pre <<< "$a"
    read -r b_maj b_min b_pat b_pre <<< "$b"
    if ((a_maj != b_maj)); then ((a_maj > b_maj)); return; fi
    if ((a_min != b_min)); then ((a_min > b_min)); return; fi
    if ((a_pat != b_pat)); then ((a_pat > b_pat)); return; fi
    # Same X.Y.Z: a final release (empty prerelease) outranks any prerelease.
    if [[ -z "$a_pre" && -n "$b_pre" ]]; then return 0; fi
    if [[ -n "$a_pre" && -z "$b_pre" ]]; then return 1; fi
    [[ "$a_pre" > "$b_pre" ]]
}
```

- [ ] **Step 4: fix `startup_menu.sh:78`.** Replace:

```bash
    if [[ "$current_tag" != "$latest_tag" ]]; then
        UPDATE_AVAILABLE="true"
        UPDATE_TARGET_TAG="$latest_tag"
    fi
```

with:

```bash
    if _semver_gt "$latest_tag" "$current_tag"; then
        UPDATE_AVAILABLE="true"
        UPDATE_TARGET_TAG="$latest_tag"
    fi
```

- [ ] **Step 5: fix `simple_menu.sh:41`** (identical replacement).

- [ ] **Step 6: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_bash_semver_compare.py -q` → all pass. Re-run `tests/test_update_check_backgrounding.py` too (T3's tests exercise the same `check_for_updates` function and must still pass with the new comparison).

- [ ] **Step 7: commit.**

```bash
git add lib/menu_lib.sh startup_menu.sh simple_menu.sh tests/test_bash_semver_compare.py
git commit -m "$(cat <<'EOF'
fix(installer): compare release tags by semver, not string inequality

A plain "$current_tag" != "$latest_tag" reports "update available" whenever
the feed's tag differs at all, including when it is OLDER, which can walk an
install backwards (docs/Installer/update-spec.md "Bash-path parity", F6). Add
shared _semver_parse/_semver_gt helpers to lib/menu_lib.sh (mirroring
update_check.py's _semver_key precedence) and use them in both menus'
check_for_updates.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 (F5): `git checkout --force` in bash apply paths

**Files:** Modify `startup_menu.sh`, `simple_menu.sh`, `install.sh`, `prepare_system.sh`. Create `tests/test_bash_checkout_force_parity.py`.

**The bug.** The installed tree is git-dirty by design (the installer copies preset files over tracked role defaults + `playbooks/site.yml`; see `docs/Installer/update-spec.md` "Reset-to-release"). A plain `git checkout <tag>` aborts with "Your local changes ... would be overwritten by checkout." Every bash apply path must use `git checkout --force`, matching the already-correct Python path (`update_check.py:457`) and the already-correct `xinas-update-git` wrapper (`collection/roles/xinas_menu/files/xinas-update-git:43`). Current plain-checkout sites: `startup_menu.sh:102`, `simple_menu.sh:59` (identical `do_update`, same bug — not separately numbered but fixed here too), `install.sh:238`, `prepare_system.sh:93`.

`install_client.sh:157` is the fourth site named in F5 but is deliberately **NOT** touched here — it is fixed in Task 7 together with the failure-propagation fix (F8), since both touch the exact same two lines; fixing it twice across two tasks would just create merge noise.

- [ ] **Step 1: failing test.** Create `tests/test_bash_checkout_force_parity.py`:

```python
"""WS3.3 (T5, F5): every bash update/install path that checks out a release
tag must use `git checkout --force` — the installed tree is git-dirty by
design (docs/Installer/update-spec.md "Reset-to-release" / "Bash-path
parity"). install_client.sh is intentionally excluded here; it is fixed in
Task 7 alongside the failure-propagation fix (same two lines, F8).

prepare_system.sh's `-u` (update-only) mode is fully behavioral and
hermetic: it skips the package-install block entirely and exits right after
xinas_update_to_latest_release(), so it can be driven end-to-end with
stubbed git/curl. install.sh and the two interactive TUI menus require root
or full menu navigation to reach their checkout call, so those three are
checked structurally (the call site text), per this plan's documented
fallback.
"""
import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PREPARE_SYSTEM = REPO / "prepare_system.sh"


def test_prepare_system_update_only_forces_checkout(tmp_path):
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    (sandbox / "ansible.cfg").write_text("")
    (sandbox / "playbooks").mkdir()

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    git_log = tmp_path / "git-calls.log"
    (stub_bin / "git").write_text(
        "#!/bin/bash\n"
        f'echo "$@" >> "{git_log}"\n'
        "exit 0\n"
    )
    (stub_bin / "git").chmod(0o755)
    (stub_bin / "curl").write_text("#!/bin/bash\necho '{\"tag_name\": \"v9.9.9\"}'\n")
    (stub_bin / "curl").chmod(0o755)

    env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}")
    proc = subprocess.run(
        ["bash", str(PREPARE_SYSTEM), "-u"], cwd=sandbox, env=env,
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    calls = git_log.read_text().splitlines()
    checkout_calls = [c for c in calls if "checkout" in c]
    assert checkout_calls, f"no git checkout call recorded: {calls}"
    assert all("--force" in c for c in checkout_calls), checkout_calls


def test_install_sh_forces_checkout():
    body = (REPO / "install.sh").read_text()
    assert re.search(r"git checkout .*--force|git checkout --force", body), (
        "install.sh must checkout --force (F5)"
    )
    assert "git checkout -q '${RELEASE_TAG}'" not in body


def test_startup_and_simple_menu_do_update_forces_checkout():
    for f in ("startup_menu.sh", "simple_menu.sh"):
        body = (REPO / f).read_text()
        assert 'git -C "$REPO_DIR" checkout --force "$_tag"' in body, (
            f"{f} do_update() must use git checkout --force (F5)"
        )
```

- [ ] **Step 2: red.** All three FAIL against current code.

- [ ] **Step 3: fix `startup_menu.sh:101-102`.** Replace:

```bash
    if git -C "$REPO_DIR" fetch origin --tags 2>"$TMP_DIR/update.log" \
        && git -C "$REPO_DIR" checkout "$_tag" 2>>"$TMP_DIR/update.log"; then
```

with:

```bash
    if git -C "$REPO_DIR" fetch origin --tags 2>"$TMP_DIR/update.log" \
        && git -C "$REPO_DIR" checkout --force "$_tag" 2>>"$TMP_DIR/update.log"; then
```

- [ ] **Step 4: fix `simple_menu.sh:58-59`** (identical replacement).

- [ ] **Step 5: fix `install.sh:237-238`.** Replace:

```bash
    run_quiet "Updating xiNAS to ${RELEASE_TAG} at ${INSTALL_DIR}" \
        bash -c "git fetch origin --tags -q && git checkout -q '${RELEASE_TAG}'"
```

with:

```bash
    run_quiet "Updating xiNAS to ${RELEASE_TAG} at ${INSTALL_DIR}" \
        bash -c "git fetch origin --tags -q && git checkout --force -q '${RELEASE_TAG}'"
```

- [ ] **Step 6: fix `prepare_system.sh:92-93`.** Replace:

```bash
    git fetch origin --tags --quiet
    git checkout --quiet "$tag"
```

with:

```bash
    git fetch origin --tags --quiet
    git checkout --force --quiet "$tag"
```

- [ ] **Step 7: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_bash_checkout_force_parity.py -q` → all pass.

- [ ] **Step 8: commit.**

```bash
git add startup_menu.sh simple_menu.sh install.sh prepare_system.sh tests/test_bash_checkout_force_parity.py
git commit -m "$(cat <<'EOF'
fix(installer): git checkout --force in every bash update/install path

The installed tree is git-dirty by design (preset files copied over tracked
role defaults + playbooks/site.yml), so a plain checkout aborts mid-update on
"local changes would be overwritten" (docs/Installer/update-spec.md
"Bash-path parity", F5). Force-checkout in startup_menu.sh/simple_menu.sh
do_update(), install.sh's update-in-place step, and
prepare_system.sh's xinas_update_to_latest_release(), matching the already-
correct Python path and xinas-update-git wrapper. install_client.sh is fixed
in the next commit (Task 7) alongside its failure-propagation fix.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 (F7): guard `./hwkey` against errexit

**Files:** Modify `startup_menu.sh`, `simple_menu.sh`. Create `tests/test_hwkey_guard.py`.

**The bug.** Both menus run under `set -euo pipefail`. `enter_license()` has two failure vectors:

1. `[ -x ./hwkey ] || chmod +x ./hwkey` (`startup_menu.sh:199`, `simple_menu.sh:126`) — if `./hwkey` doesn't exist at all, `chmod` on a missing file fails, and under `set -e` that kills the whole menu (verified empirically: `chmod` on a nonexistent path exits 1, and a bare `A || B` line where `B` also fails aborts the script).
2. `hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')` (`startup_menu.sh:251`, `simple_menu.sh:179`) — under `pipefail`, a pipeline's exit status is the last command to exit non-zero **anywhere in the pipe**, not just the final stage (verified empirically: `false | tr -d '\n' | tr a-z A-Z` under `pipefail` reports exit 1, even though both `tr` stages succeed). So a `./hwkey` that exists but returns non-zero (a hardware-read error) also kills the whole menu via this line.

- [ ] **Step 1: failing test.** Create `tests/test_hwkey_guard.py`:

```python
"""WS3 (T6, F7): a missing or failing ./hwkey must not kill the whole menu
under `set -euo pipefail`. Two failure vectors in enter_license():
`[ -x ./hwkey ] || chmod +x ./hwkey` (chmod on a missing file fails) and
`hwkey_val=$(./hwkey | tr ... | tr ...)` (pipefail surfaces a failure
anywhere in the pipe, not just the last stage).

Extracts the two exact guarded lines from each real file (so this fails if a
future edit removes the guard) and executes them under set -euo pipefail
with a real failing/missing ./hwkey — proving the menu script survives.
Avoids driving the full interactive enter_license() function, which reads
the hardcoded absolute path /tmp/license and would be unsafe to exercise
against a real machine's /tmp/license.
"""
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _extract_hwkey_lines(script: str) -> tuple[str, str]:
    text = (REPO / script).read_text()
    chmod_line = re.search(r"^\s*\[ -x \./hwkey \] \|\| chmod \+x \./hwkey.*$", text, re.M)
    pipe_line = re.search(r"^\s*hwkey_val=\$\(\./hwkey.*$", text, re.M)
    assert chmod_line, f"{script}: hwkey chmod-guard line not found"
    assert pipe_line, f"{script}: hwkey_val pipe line not found"
    return chmod_line.group(0).strip(), pipe_line.group(0).strip()


def _run(script: str, tmp_path: Path, *, hwkey_exists: bool) -> subprocess.CompletedProcess:
    chmod_line, pipe_line = _extract_hwkey_lines(script)
    if hwkey_exists:
        hwkey = tmp_path / "hwkey"
        hwkey.write_text("#!/bin/bash\nexit 1\n")
        hwkey.chmod(0o755)
    snippet = (
        "set -euo pipefail\n"
        f"{chmod_line}\n"
        f"{pipe_line}\n"
        'echo "SURVIVED hwkey_val=[$hwkey_val]"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True, timeout=10,
    )


def test_startup_menu_survives_missing_hwkey(tmp_path):
    proc = _run("startup_menu.sh", tmp_path, hwkey_exists=False)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout


def test_startup_menu_survives_failing_hwkey(tmp_path):
    proc = _run("startup_menu.sh", tmp_path, hwkey_exists=True)
    assert proc.returncode == 0, proc.stderr
    assert "SURVIVED" in proc.stdout


def test_simple_menu_survives_missing_hwkey(tmp_path):
    proc = _run("simple_menu.sh", tmp_path, hwkey_exists=False)
    assert proc.returncode == 0, proc.stderr


def test_simple_menu_survives_failing_hwkey(tmp_path):
    proc = _run("simple_menu.sh", tmp_path, hwkey_exists=True)
    assert proc.returncode == 0, proc.stderr
```

- [ ] **Step 2: red.** All four FAIL (`proc.returncode` is 1, `SURVIVED` never printed).

- [ ] **Step 3: fix both guard lines in `startup_menu.sh`.** Replace:

```bash
    [ -x ./hwkey ] || chmod +x ./hwkey
```

with:

```bash
    [ -x ./hwkey ] || chmod +x ./hwkey 2>/dev/null || true
```

and replace:

```bash
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')
```

with:

```bash
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]') || hwkey_val=""
```

- [ ] **Step 4: fix both guard lines in `simple_menu.sh`** (identical replacements).

- [ ] **Step 5: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_hwkey_guard.py -q` → all pass.

- [ ] **Step 6: commit.**

```bash
git add startup_menu.sh simple_menu.sh tests/test_hwkey_guard.py
git commit -m "$(cat <<'EOF'
fix(installer): a failing or missing ./hwkey must not kill the whole menu

Both menus run under set -euo pipefail. chmod on a missing ./hwkey, and a
non-zero ./hwkey anywhere in the hwkey_val pipe (pipefail surfaces a failure
at any pipeline stage, not just the last), each independently aborted the
entire interactive menu (F7). Guard both with a trailing || true / ||
fallback.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 (F8 + deferred F5, WS3.4): `install_client.sh` accuracy

**Files:** Modify `install_client.sh`. Create `tests/test_install_client_update_accuracy.py`.

**The bug.** `install_client.sh:156-158`:

```bash
    git fetch --quiet origin --tags 2>/dev/null || true
    git checkout --quiet "$RELEASE_TAG" 2>/dev/null || true
    ok "Client updated to ${RELEASE_TAG}"
```

Both git calls swallow failure (`|| true`) and stderr (`2>/dev/null`), then print an unconditional success message — a fleet-wide rollout has no signal that a host didn't actually update (`docs/Installer/spec.md` §8.4, F8). This also carries the `--force` fix deferred from Task 5 (same two lines).

- [ ] **Step 1: failing test.** Create `tests/test_install_client_update_accuracy.py`:

```python
"""WS3.4 (T7, F8 + deferred F5): install_client.sh must propagate git
fetch/checkout failures and never print "Client updated" when either call
failed (docs/Installer/spec.md §8.4). Carries the --force checkout fix
deferred from Task 5 (same two lines).

Structural: install_client.sh requires EUID==0 at its very first gate, so it
cannot be executed end-to-end in an unprivileged CI sandbox — bash provides
no way to fake the effective UID. Regex guard on the fetch/checkout block,
following the repo's established pattern for root-requiring installers
(tests/test_uninstall_script_safety.py).
"""
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "install_client.sh"
SRC = SCRIPT.read_text()


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_no_swallowed_git_failures():
    assert "git fetch --quiet origin --tags 2>/dev/null || true" not in SRC
    assert 'git checkout --quiet "$RELEASE_TAG" 2>/dev/null || true' not in SRC


def test_checkout_forces():
    assert re.search(r"git checkout --force", SRC), "T5/T7: client checkout must use --force"


def test_update_block_is_if_guarded_with_a_failure_exit():
    m = re.search(r"git fetch.*?git checkout --force[^\n]*", SRC, re.S)
    assert m, "expected a fetch-then-force-checkout block"
    window = SRC[max(0, m.start() - 60): m.end() + 400]
    assert re.search(r"\bif\b.*git fetch", window, re.S), (
        "fetch/checkout must be inside an if-guard, not run-then-check"
    )
    assert "ok \"Client updated to ${RELEASE_TAG}\"" in window
    assert re.search(r"\belse\b", window)
    assert re.search(r"exit\s+[1-9]", window), (
        "a failed fetch/checkout must exit non-zero on the else branch"
    )
```

- [ ] **Step 2: red.** All FAIL except `test_bash_syntax_ok`.

- [ ] **Step 3: fix.** Replace (`install_client.sh:153-165`):

```bash
if [[ -d "$INSTALL_DIR" ]]; then
    info "Existing installation found — updating to ${RELEASE_TAG}..."
    cd "$INSTALL_DIR"
    git fetch --quiet origin --tags 2>/dev/null || true
    git checkout --quiet "$RELEASE_TAG" 2>/dev/null || true
    ok "Client updated to ${RELEASE_TAG}"
else
```

with:

```bash
if [[ -d "$INSTALL_DIR" ]]; then
    info "Existing installation found — updating to ${RELEASE_TAG}..."
    cd "$INSTALL_DIR"
    if git fetch --quiet origin --tags && git checkout --force --quiet "$RELEASE_TAG"; then
        ok "Client updated to ${RELEASE_TAG}"
    else
        fail "Failed to update client to ${RELEASE_TAG} (git fetch/checkout error)"
        exit 1
    fi
else
```

  (Dropping `2>/dev/null` lets git's real error text reach the operator on failure; `--quiet` alone already suppresses normal progress chatter on success.)

- [ ] **Step 4: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_install_client_update_accuracy.py -q` → all pass.

- [ ] **Step 5: commit.**

```bash
git add install_client.sh tests/test_install_client_update_accuracy.py
git commit -m "$(cat <<'EOF'
fix(installer): install_client.sh propagates git failures and forces checkout

git fetch/checkout swallowed failures with `|| true` and 2>/dev/null, then
unconditionally printed "Client updated" — a fleet rollout had no signal a
host didn't actually update (docs/Installer/spec.md §8.4, F8). Also applies
the --force checkout fix deferred from Task 5 (same two lines, F5).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 (F9, WS3.4): `autoinstall.sh` fail-closed preset copy

**Files:** Modify `autoinstall.sh`. Create `tests/test_autoinstall_preset_fail_closed.py`.

**The bug.** `autoinstall.sh:10` is `set -uo pipefail` (**no `-e`**). `copy_if()` (lines 233-236) does return `cp`'s exit status via `&&`, but the six call sites (lines 237-242) never check it, so a mid-sequence copy failure is silently ignored and execution falls through to `ok "Preset applied"` (line 243) and then to `ansible-playbook` (line 271) against a mixed old/new preset — exactly the inconsistent deployment `docs/Installer/spec.md` §7.8 requires aborting on.

- [ ] **Step 1: failing test.** Create `tests/test_autoinstall_preset_fail_closed.py`:

```python
"""WS3.4 (T8, F9): autoinstall.sh must abort the moment any single preset-file
copy fails, never fall through to `ok "Preset applied"` against a mixed
preset (docs/Installer/spec.md §7.8).

Behavioral: extracts the real copy_if() function and the real six call sites
from autoinstall.sh and executes them in a sandbox where one destination
directory is missing (cp fails), asserting the block aborts before the
"Preset applied" line. Running the whole script requires root (the EUID
check gates step 6), so the guarded-call pattern is extracted and exercised
directly, per this plan's documented fallback.
"""
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "autoinstall.sh"
SRC = SCRIPT.read_text()


def _extract_copy_block() -> str:
    fn = re.search(r"^copy_if\(\) \{.*?^\}", SRC, re.M | re.S)
    calls = re.search(
        r'^copy_if "\$preset_path/network\.yml".*?^ok "Preset applied"',
        SRC, re.M | re.S,
    )
    assert fn and calls, "copy_if function or call block not found in autoinstall.sh"
    return fn.group(0) + "\n" + calls.group(0)


def _stub_prelude() -> str:
    return (
        'info() { :; }\n'
        'fail() { echo "FAIL: $1" >&2; }\n'
        'die() { fail "$1"; exit 1; }\n'
        'ok() { echo "OK: $1"; }\n'
    )


def test_bash_syntax_ok():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_failed_copy_aborts_before_preset_applied(tmp_path):
    preset_dir = tmp_path / "presets" / "default"
    preset_dir.mkdir(parents=True)
    (preset_dir / "network.yml").write_text("net: 1\n")
    # collection/roles/net_controllers/defaults/ deliberately does NOT exist,
    # so `cp` fails for network.yml; the other five preset files are absent,
    # so copy_if short-circuits (return 0) for them.

    snippet = (
        "set -uo pipefail\n"
        'preset_dir_name="default"\n'
        f'preset_path="{preset_dir}"\n'
        + _stub_prelude()
        + _extract_copy_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode != 0, proc.stdout
    assert "REACHED_END" not in proc.stdout
    assert "Preset applied" not in proc.stdout


def test_all_copies_succeed_reaches_preset_applied(tmp_path):
    preset_dir = tmp_path / "presets" / "default"
    preset_dir.mkdir(parents=True)
    (preset_dir / "network.yml").write_text("net: 1\n")
    dest_dir = tmp_path / "collection/roles/net_controllers/defaults"
    dest_dir.mkdir(parents=True)

    snippet = (
        "set -uo pipefail\n"
        'preset_dir_name="default"\n'
        f'preset_path="{preset_dir}"\n'
        + _stub_prelude()
        + _extract_copy_block()
        + '\necho "REACHED_END"\n'
    )
    proc = subprocess.run(["bash", "-c", snippet], cwd=tmp_path, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "REACHED_END" in proc.stdout
    assert "Preset applied" in proc.stdout
```

- [ ] **Step 2: red.** `test_failed_copy_aborts_before_preset_applied` FAILS (currently reaches `REACHED_END` and prints "Preset applied" despite the failed copy); `test_all_copies_succeed_reaches_preset_applied` already passes (nothing to break in the success path) — that's fine, it's the regression guard for Step 3.

- [ ] **Step 3: fix.** Replace (`autoinstall.sh:237-243`):

```bash
copy_if "$preset_path/network.yml"        "collection/roles/net_controllers/defaults/main.yml"
copy_if "$preset_path/netplan.yaml.j2"    "collection/roles/net_controllers/templates/netplan.yaml.j2"
copy_if "$preset_path/raid_fs.yml"        "collection/roles/raid_fs/defaults/main.yml"
copy_if "$preset_path/nvme_namespace.yml" "collection/roles/nvme_namespace/defaults/main.yml"
copy_if "$preset_path/nfs_exports.yml"    "collection/roles/exports/defaults/main.yml"
copy_if "$preset_path/playbook.yml"       "playbooks/site.yml"
ok "Preset applied"
```

with:

```bash
copy_if "$preset_path/network.yml"        "collection/roles/net_controllers/defaults/main.yml" \
    || die "preset copy failed: network.yml"
copy_if "$preset_path/netplan.yaml.j2"    "collection/roles/net_controllers/templates/netplan.yaml.j2" \
    || die "preset copy failed: netplan.yaml.j2"
copy_if "$preset_path/raid_fs.yml"        "collection/roles/raid_fs/defaults/main.yml" \
    || die "preset copy failed: raid_fs.yml"
copy_if "$preset_path/nvme_namespace.yml" "collection/roles/nvme_namespace/defaults/main.yml" \
    || die "preset copy failed: nvme_namespace.yml"
copy_if "$preset_path/nfs_exports.yml"    "collection/roles/exports/defaults/main.yml" \
    || die "preset copy failed: nfs_exports.yml"
copy_if "$preset_path/playbook.yml"       "playbooks/site.yml" \
    || die "preset copy failed: playbook.yml"
ok "Preset applied"
```

  (`die()` already exists at the top of `autoinstall.sh` — `die()  { fail "$1"; exit 1; }` — exit 1 matches the "configuration/license error — nothing applied" contract in §7.5's exit-code table, which fits: an inconsistent preset copy means provisioning must not proceed.)

- [ ] **Step 4: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_autoinstall_preset_fail_closed.py -q` → all pass. `bash -n autoinstall.sh` clean.

- [ ] **Step 5: commit.**

```bash
git add autoinstall.sh tests/test_autoinstall_preset_fail_closed.py
git commit -m "$(cat <<'EOF'
fix(installer): autoinstall.sh aborts on any failed preset-file copy

autoinstall.sh runs under `set -uo pipefail` (no -e); copy_if()'s return
value was never checked at any of the six call sites, so a mid-sequence
copy failure silently continued to `ok "Preset applied"` and then Ansible,
provisioning against a mixed old/new preset (docs/Installer/spec.md §7.8,
F9). Check each call and die() on the first failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 (F2, WS3.4): pinned + checksum-verified `yq`

**Files:** Modify `prepare_system.sh`. Create `tests/test_prepare_system_yq_pin.py`.

**The bug.** `prepare_system.sh:107-111`:

```bash
    run_quiet "Installing yq (YAML processor)" bash -c '
        sudo wget -qO /usr/local/bin/yq \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
        && sudo chmod +x /usr/local/bin/yq'
```

No version pin, no checksum verification, hardcoded `amd64`. Per `docs/Installer/spec.md` §8.1 this MUST be a pinned, checksum-verified install selected by `uname -m`, aborting (never `chmod +x`'ing) on a mismatch.

**Pinned version:** `v4.53.3` (the latest published `mikefarah/yq` release as of 2026-07-10). Both SHA-256 values below were fetched directly from the release's official `checksums` asset (`https://github.com/mikefarah/yq/releases/download/v4.53.3/checksums`, column 19 — SHA-256 is hash #18 in that release's `checksums_hashes_order` asset, plus filename = column 1) **and independently re-verified** by downloading each binary and running `sha256sum` on it locally:

```
YQ_VERSION="v4.53.3"
YQ_SHA256_AMD64="fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4"   # yq_linux_amd64
YQ_SHA256_ARM64="578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea"   # yq_linux_arm64
```

A reviewer can re-derive/spot-check either hash directly from the release asset itself, with no dependency on the `checksums` file at all:

```bash
curl -sL https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_amd64 | sha256sum
# -> fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4
curl -sL https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_arm64 | sha256sum
# -> 578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea
```

If time has passed since this plan was written and a newer `yq` is preferred, re-derive with:

```bash
curl -fsSL https://github.com/mikefarah/yq/releases/download/<vX.Y.Z>/checksums_hashes_order
# confirm SHA-256 is still the 18th line (column 19 once the filename column is included)
curl -fsSL https://github.com/mikefarah/yq/releases/download/<vX.Y.Z>/checksums \
  | awk '$1=="yq_linux_amd64" || $1=="yq_linux_arm64" {print $1, $19}'
```

and double-check by downloading the two binaries and running `sha256sum` directly (the command shown above) — never trust the `checksums` asset alone without that second, independent confirmation.

**`YQ_VERSION` and both `YQ_SHA256_*` constants are updated together, as one deliberate, reviewed change — never bumped individually and never automated.** A version bump with a stale or missing hash is exactly the unverified-binary failure mode this fix exists to close.

- [ ] **Step 1: failing test.** Create `tests/test_prepare_system_yq_pin.py`:

```python
"""WS3.4 (T9, F2): prepare_system.sh must install yq pinned + checksum-
verified, selected by host architecture — never `releases/latest`, never
hardcoded amd64, never chmod +x an unverified download
(docs/Installer/spec.md §8.1).

Behavioral: extracts the real install_yq() function (and its YQ_VERSION /
YQ_SHA256_* constants) from prepare_system.sh and executes it in a sandbox
with stubbed wget/sudo/uname, so the checksum-mismatch abort path and the
arch-selection logic run against the actual shipped code. The test swaps in
test-controlled hashes (computed from a small fake payload) via string
substitution so it never depends on the real yq binary being reachable.
"""
import hashlib
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "prepare_system.sh"
SRC = SCRIPT.read_text()


def _extract_installer() -> str:
    m = re.search(r'YQ_VERSION=.*?\ninstall_yq\(\) \{.*?\n\}', SRC, re.S)
    assert m, "YQ_VERSION / install_yq() block not found in prepare_system.sh"
    return m.group(0)


def _run(tmp_path, *, arch, payload, tamper_hash):
    stub = tmp_path / "bin"
    stub.mkdir()
    (tmp_path / "download.bin").write_bytes(payload)
    real_sha = hashlib.sha256(payload).hexdigest()
    amd64_sha = "f" * 64 if arch != "x86_64" else ("0" * 64 if tamper_hash else real_sha)
    arm64_sha = "f" * 64 if arch != "aarch64" else ("0" * 64 if tamper_hash else real_sha)

    (stub / "uname").write_text(f"#!/bin/bash\necho {arch}\n")
    (stub / "uname").chmod(0o755)
    (stub / "wget").write_text(f'#!/bin/bash\ncp "{tmp_path}/download.bin" "$2"\n')
    (stub / "wget").chmod(0o755)
    sudo_log = tmp_path / "sudo.log"
    (stub / "sudo").write_text(f'#!/bin/bash\necho "$@" >> "{sudo_log}"\nexit 0\n')
    (stub / "sudo").chmod(0o755)

    installer = _extract_installer()
    installer = re.sub(r'YQ_SHA256_AMD64="[0-9a-f]{64}"', f'YQ_SHA256_AMD64="{amd64_sha}"', installer)
    installer = re.sub(r'YQ_SHA256_ARM64="[0-9a-f]{64}"', f'YQ_SHA256_ARM64="{arm64_sha}"', installer)

    snippet = f'set -euo pipefail\nRED=""; NC=""\n{installer}\ninstall_yq\n'
    env = {"PATH": f"{stub}:/usr/bin:/bin"}
    proc = subprocess.run(["bash", "-c", snippet], cwd=tmp_path, env=env, capture_output=True, text=True)
    return proc, sudo_log


def test_matching_checksum_installs_amd64(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="x86_64", payload=b"real-yq-bytes-v1", tamper_hash=False)
    assert proc.returncode == 0, proc.stderr
    calls = sudo_log.read_text()
    assert "yq" in calls and "chmod +x" in calls


def test_matching_checksum_installs_arm64(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="aarch64", payload=b"real-yq-arm-bytes", tamper_hash=False)
    assert proc.returncode == 0, proc.stderr


def test_mismatched_checksum_aborts_without_installing(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="x86_64", payload=b"tampered-bytes", tamper_hash=True)
    assert proc.returncode != 0
    combined = (proc.stdout + proc.stderr).lower()
    assert "checksum" in combined
    calls = sudo_log.read_text() if sudo_log.exists() else ""
    assert "chmod" not in calls, "must never chmod +x an unverified binary"


def test_no_releases_latest_url():
    assert "releases/latest/download/yq_linux_amd64" not in SRC


def test_pinned_version_and_hashes_present():
    assert re.search(r'YQ_VERSION="v\d+\.\d+\.\d+"', SRC)
    assert re.search(r'YQ_SHA256_AMD64="[0-9a-f]{64}"', SRC)
    assert re.search(r'YQ_SHA256_ARM64="[0-9a-f]{64}"', SRC)
```

- [ ] **Step 2: red.** All FAIL (`install_yq` doesn't exist yet; `releases/latest` URL still present).

- [ ] **Step 3: fix.** Replace `prepare_system.sh:107-111`:

```bash
    # Install yq v4 for YAML processing used by configuration scripts
    run_quiet "Installing yq (YAML processor)" bash -c '
        sudo wget -qO /usr/local/bin/yq \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
        && sudo chmod +x /usr/local/bin/yq'
```

with:

```bash
    # Install yq v4 (YAML processor) used by configuration scripts.
    # Pinned + checksum-verified (docs/Installer/spec.md §8.1) — never fetch
    # `releases/latest`: a latest-tracking install means the exact binary
    # running on a host silently changes between installs with no record of
    # which version is in use, and an unverified download must never be
    # chmod +x'd or installed. Selected by host architecture (uname -m), not
    # hardcoded to amd64. Bump both the version and the two hashes together,
    # deliberately, when updating yq — see docs/Installer/spec.md §8.1 for
    # how to re-derive the hashes.
    YQ_VERSION="v4.53.3"
    YQ_SHA256_AMD64="fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4"
    YQ_SHA256_ARM64="578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea"

    install_yq() {
        local arch yq_asset yq_sha tmp_yq actual_sha
        case "$(uname -m)" in
            x86_64)        arch="amd64"; yq_sha="$YQ_SHA256_AMD64" ;;
            aarch64|arm64) arch="arm64"; yq_sha="$YQ_SHA256_ARM64" ;;
            *)
                echo -e "${RED}Unsupported architecture for yq: $(uname -m)${NC}" >&2
                return 1
                ;;
        esac
        yq_asset="yq_linux_${arch}"
        tmp_yq="$(mktemp)"
        if ! sudo wget -qO "$tmp_yq" \
            "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/${yq_asset}"; then
            rm -f "$tmp_yq"
            echo -e "${RED}yq download failed${NC}" >&2
            return 1
        fi
        actual_sha="$(sha256sum "$tmp_yq" | awk '{print $1}')"
        if [ "$actual_sha" != "$yq_sha" ]; then
            rm -f "$tmp_yq"
            echo -e "${RED}yq checksum mismatch for ${yq_asset} ${YQ_VERSION}${NC}" >&2
            echo -e "${RED}expected ${yq_sha}, got ${actual_sha} — aborting, NOT installing.${NC}" >&2
            return 1
        fi
        sudo mv "$tmp_yq" /usr/local/bin/yq
        sudo chmod +x /usr/local/bin/yq
    }

    run_quiet "Installing yq ${YQ_VERSION} (YAML processor, checksum-verified)" install_yq
```

- [ ] **Step 4: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_prepare_system_yq_pin.py -q` → all pass. `bash -n prepare_system.sh` clean.

- [ ] **Step 5: commit.**

```bash
git add prepare_system.sh tests/test_prepare_system_yq_pin.py
git commit -m "$(cat <<'EOF'
fix(installer): pin + checksum-verify yq, select binary by uname -m

`releases/latest/download/yq_linux_amd64` had no version pin, no checksum,
and was hardcoded to amd64 (docs/Installer/spec.md §8.1, F2). Pin to
v4.53.3, verify sha256 for both amd64/arm64 assets before chmod +x, and
abort on any mismatch without installing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 (F10, WS3.5): wire "Collect Diagnostics" to `collect_data.sh`

**Files:** Modify `lib/menu_lib.sh`. Create `tests/test_install_failure_collect_wiring.py`.

**The bug.** `lib/menu_lib.sh:1099-1136` (`xinas_run_playbook`'s install-failure dialog) offers `"collect" "Collect Logs (auto-uploads diagnostic archive)"`, but the handler is `collect|close|*) break ;;` — identical to `close`, a dead end. `collect_data.sh` exists at the repo root and is already invoked from `startup_menu.sh:808` and `simple_menu.sh:724`, never from here. Per `docs/Installer/spec.md` §8.3, "Collect Diagnostics" MUST invoke it, and its label MUST NOT claim an "auto-upload" behavior that doesn't exist.

- [ ] **Step 1: failing test.** Create `tests/test_install_failure_collect_wiring.py`:

```python
"""WS3.5 (T10, F10): the install-failure dialog's "Collect Diagnostics"
choice must actually invoke collect_data.sh instead of falling through to
the same no-op branch as Continue (docs/Installer/spec.md §8.3), and its
label must not claim an "auto-upload" behavior that does not exist.

Behavioral: sources the real lib/menu_lib.sh and drives xinas_run_playbook
with a stubbed failing ansible-playbook, a stubbed whiptail that answers
"collect" once then "close" (so the loop-back after collect terminates),
and a stubbed ./collect_data.sh that records being invoked to a marker file.
No pty needed — neither whiptail (fully stubbed) nor collect_data.sh nor the
failure-dialog branch touch /dev/tty; only menu_select (unused here) does.
"""
import os
import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"


def test_collect_choice_invokes_collect_data_sh(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    (bin_dir / "ansible-playbook").write_text("#!/bin/bash\nexit 1\n")
    (bin_dir / "ansible-playbook").chmod(0o755)

    counter = tmp_path / "whiptail-calls"
    (bin_dir / "whiptail").write_text(textwrap.dedent(f"""\
        #!/bin/bash
        n=0
        [ -f "{counter}" ] && n=$(cat "{counter}")
        n=$((n + 1))
        echo "$n" > "{counter}"
        if [ "$n" -eq 1 ]; then echo collect >&2; else echo close >&2; fi
        exit 0
        """))
    (bin_dir / "whiptail").chmod(0o755)

    marker = tmp_path / "collected.marker"
    (tmp_path / "collect_data.sh").write_text(f'#!/bin/bash\ntouch "{marker}"\n')
    (tmp_path / "collect_data.sh").chmod(0o755)

    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")
    script = f'set -euo pipefail\nsource "{MENU_LIB}"\nxinas_run_playbook site.yml -i inventory\n'
    proc = subprocess.run(
        ["bash", "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30,
    )
    assert marker.exists(), (
        "collect_data.sh was not invoked by the install-failure dialog's "
        f"'collect' choice.\nstdout={proc.stdout}\nstderr={proc.stderr}"
    )


def test_collect_label_does_not_claim_auto_upload():
    body = MENU_LIB.read_text()
    assert "auto-uploads" not in body.lower()
    assert '"collect"' in body  # the whiptail menu tag itself is unchanged
```

- [ ] **Step 2: red.** `test_collect_choice_invokes_collect_data_sh` FAILS (marker never created; `collect` falls into the same branch as `close`).

- [ ] **Step 3: fix.** Replace `lib/menu_lib.sh:1099-1136`:

```bash
                choice=$(whiptail --title "Installation Failed" \
                    --menu "Installation failed (exit ${rc}).\n\nFull log: ${log_path}" \
                    16 70 3 \
                    "collect" "Collect Logs (auto-uploads diagnostic archive)" \
                    "view"    "View Log (opens less +G on full output)" \
                    "close"   "Continue (return to menu)" \
                    3>&1 1>&2 2>&3) || choice="close"
```

(relabel the "collect" tag) with:

```bash
                choice=$(whiptail --title "Installation Failed" \
                    --menu "Installation failed (exit ${rc}).\n\nFull log: ${log_path}" \
                    16 70 3 \
                    "collect" "Collect Diagnostics (writes a local archive)" \
                    "view"    "View Log (opens less +G on full output)" \
                    "close"   "Continue (return to menu)" \
                    3>&1 1>&2 2>&3) || choice="close"
```

and replace the handler:

```bash
            case "$choice" in
                view)
                    ...
                    ;;
                collect|close|*)
                    break
                    ;;
            esac
```

with:

```bash
            case "$choice" in
                view)
                    ...
                    ;;
                collect)
                    if [ -x ./collect_data.sh ]; then
                        ./collect_data.sh || true
                    else
                        printf '\n  collect_data.sh not found (expected at repo root).\n' >&2
                    fi
                    # Loop back to dialog, same as view.
                    ;;
                close|*)
                    break
                    ;;
            esac
```

  (keep the `view)` block's body exactly as-is — only the label text on the whiptail menu line and the `collect|close|*)` handler split change.)

- [ ] **Step 4: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_install_failure_collect_wiring.py -q` → both pass. Re-run `tests/test_playbook_ticker_callback.py` too (same function, unrelated branch, must still pass).

- [ ] **Step 5: commit.**

```bash
git add lib/menu_lib.sh tests/test_install_failure_collect_wiring.py
git commit -m "$(cat <<'EOF'
fix(installer): wire the install-failure dialog's Collect Diagnostics choice

"collect" was handled identically to "close" (case ... collect|close|*)
break), a dead end; the label also falsely claimed "auto-uploads diagnostic
archive" (docs/Installer/spec.md §8.3, F10). Invoke the same collect_data.sh
already called from both menus' top-level menus, and relabel honestly —
upload is a separate, not-yet-implemented workstream.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 (F11a): the `xinas-update-helper-sync` privileged wrapper

**Files:** Create `collection/roles/xinas_menu/files/xinas-update-helper-sync`. Modify `collection/roles/xinas_menu/files/sudoers-xinas-update`, `collection/roles/xinas_menu/tasks/main.yml`. Create `tests/test_xinas_update_helper_sync_role.py`.

**This is the bootstrapping task — its commit carries `Requires-Rebuild: xinas_menu`.** Per `docs/Installer/update-spec.md` "Bootstrapping the helper-sync wrapper," the wrapper only exists on a host after the `xinas_menu` role re-runs; without the trailer, no host would ever pick it up automatically.

`/opt/xiNAS` is root-owned but `xinas-menu` runs as the unprivileged `xinnor` user. The refresh step (Task 12) needs to copy `*.py` from `<repo>/xiNAS-MCP/nfs-helper` into the root-owned `/usr/lib/xinas-mcp/nfs-helper` and restart the root-run `xinas-nfs-helper` unit — neither is possible as `xinnor` without a privileged helper, exactly the reasoning behind the existing `xinas-update-git` wrapper. This wrapper mirrors that one's contract: `set -euo pipefail`, hard-coded source `/opt/xiNAS/xiNAS-MCP/nfs-helper` and destination `/usr/lib/xinas-mcp/nfs-helper` (no caller-supplied paths), copy `*.py`, then `systemctl restart xinas-nfs-helper`, non-zero exit on any failure.

- [ ] **Step 1: failing test.** Create `tests/test_xinas_update_helper_sync_role.py`:

```python
"""WS3 (T11, F11a): a new privileged wrapper, xinas-update-helper-sync, must
be deployed by the xinas_menu role so the NFS-helper refresh
(docs/Installer/update-spec.md "NFS-helper refresh") can run as root from
the unprivileged xinnor user, mirroring the existing xinas-update-git
wrapper's contract: hard-coded paths, no caller-supplied input,
set -euo pipefail, non-zero exit on any failure.
"""
import subprocess
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
WRAPPER = REPO / "collection/roles/xinas_menu/files/xinas-update-helper-sync"
SUDOERS = REPO / "collection/roles/xinas_menu/files/sudoers-xinas-update"
TASKS = REPO / "collection/roles/xinas_menu/tasks/main.yml"


def test_wrapper_exists_and_parses():
    assert WRAPPER.exists()
    subprocess.run(["bash", "-n", str(WRAPPER)], check=True)


def test_wrapper_hardcodes_paths_no_caller_input():
    body = WRAPPER.read_text()
    assert "set -euo pipefail" in body
    assert "SRC=/opt/xiNAS/xiNAS-MCP/nfs-helper" in body
    assert "DEST=/usr/lib/xinas-mcp/nfs-helper" in body
    assert "$1" not in body and "$2" not in body and "$@" not in body


def test_wrapper_restarts_helper_and_copies_py_only():
    body = WRAPPER.read_text()
    assert "systemctl restart xinas-nfs-helper" in body
    assert "*.py" in body


def test_wrapper_exits_nonzero_on_missing_source_or_dest():
    assert "exit 1" in WRAPPER.read_text()


def test_sudoers_grants_exactly_the_two_wrappers():
    lines = [
        ln.strip() for ln in SUDOERS.read_text().splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    assert any("xinas-update-git" in ln for ln in lines)
    assert any("xinas-update-helper-sync" in ln for ln in lines)
    for ln in lines:
        assert "NOPASSWD:" in ln
        assert ln.count("/usr/local/sbin/") == 1, f"grant must name exactly one binary: {ln}"


def test_role_installs_the_wrapper():
    tasks = yaml.safe_load(TASKS.read_text())
    copy_tasks = [
        t.get("ansible.builtin.copy", {}) for t in tasks
        if isinstance(t.get("ansible.builtin.copy"), dict)
    ]
    dests = {c.get("dest") for c in copy_tasks}
    assert "/usr/local/sbin/xinas-update-helper-sync" in dests
    installed = next(
        c for c in copy_tasks if c.get("dest") == "/usr/local/sbin/xinas-update-helper-sync"
    )
    assert installed.get("mode") == "0755"
    assert installed.get("src") == "xinas-update-helper-sync"
```

- [ ] **Step 2: red.** All FAIL (`WRAPPER.exists()` is False).

- [ ] **Step 3: create the wrapper.** `collection/roles/xinas_menu/files/xinas-update-helper-sync`:

```bash
#!/bin/bash
# /usr/local/sbin/xinas-update-helper-sync
#
# Privileged helper for xinas-menu's update flow. Runs as root via sudo
# (granted by /etc/sudoers.d/xinas-update) so that xinas-menu, running as the
# unprivileged xinnor user, can refresh the NFS-helper daemon's installed
# files after a code-only update (no Requires-Rebuild trailer, so the
# xinas_nfs_helper role itself does not re-run).
#
# Hard-coded source and destination — accepts NO caller-supplied paths.
# See docs/Installer/update-spec.md "NFS-helper refresh".

set -euo pipefail

SRC=/opt/xiNAS/xiNAS-MCP/nfs-helper
DEST=/usr/lib/xinas-mcp/nfs-helper

if [[ ! -d "$SRC" ]]; then
    echo "source not found: $SRC" >&2
    exit 1
fi
if [[ ! -d "$DEST" ]]; then
    echo "destination not found: $DEST (xinas_nfs_helper role not deployed on this host)" >&2
    exit 1
fi

cp "$SRC"/*.py "$DEST/"
systemctl restart xinas-nfs-helper
```

  `chmod +x` locally isn't required for the copy task (Ansible sets `mode: '0755'` on deploy), but it's good hygiene: `chmod +x collection/roles/xinas_menu/files/xinas-update-helper-sync`.

- [ ] **Step 4: extend the sudoers file.** Replace the whole content of `collection/roles/xinas_menu/files/sudoers-xinas-update`:

```
# /etc/sudoers.d/xinas-update
#
# Allow the xinnor user to run the xinas-update-git and
# xinas-update-helper-sync helpers as root without a password, so xinas-menu
# (running as xinnor) can refresh/apply updates in the root-owned
# /opt/xiNAS clone and sync the NFS helper into
# /usr/lib/xinas-mcp/nfs-helper.
#
# This grants ONLY these two wrapper scripts — not git, cp, or systemctl in
# general. Each wrapper accepts no caller-supplied paths and whitelists its
# own fixed set of operations.

xinnor ALL=(root) NOPASSWD: /usr/local/sbin/xinas-update-git
xinnor ALL=(root) NOPASSWD: /usr/local/sbin/xinas-update-helper-sync
```

- [ ] **Step 5: add the role task.** In `collection/roles/xinas_menu/tasks/main.yml`, immediately after the existing "Install xinas-update-git sudo helper" task (currently lines 150-157), add:

```yaml
- name: Install xinas-update-helper-sync sudo helper
  ansible.builtin.copy:
    src: xinas-update-helper-sync
    dest: /usr/local/sbin/xinas-update-helper-sync
    owner: root
    group: root
    mode: '0755'
  tags: [xinas_menu, update_helper]
```

  (The existing "Install sudoers entry for xinas-update-git" task, lines 159-167, already re-copies the whole `sudoers-xinas-update` file on every run — no task change needed there, only the file content from Step 4.) Optionally update the block comment at lines 141-148 to mention both wrappers.

- [ ] **Step 6: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_xinas_update_helper_sync_role.py -q` → all pass. `ansible-lint collection/roles/xinas_menu/` clean. `bash -n collection/roles/xinas_menu/files/xinas-update-helper-sync` clean.

- [ ] **Step 7: commit — carries `Requires-Rebuild: xinas_menu`.**

```bash
git add collection/roles/xinas_menu/files/xinas-update-helper-sync \
        collection/roles/xinas_menu/files/sudoers-xinas-update \
        collection/roles/xinas_menu/tasks/main.yml \
        tests/test_xinas_update_helper_sync_role.py
git commit -m "$(cat <<'EOF'
feat(xinas_menu): deploy the xinas-update-helper-sync privileged wrapper

The NFS-helper refresh needs to write into the root-owned
/usr/lib/xinas-mcp/nfs-helper and restart a root-run systemd unit from the
unprivileged xinnor user — the same problem xinas-update-git already solves
for the /opt/xiNAS checkout. New wrapper mirrors its contract exactly:
hard-coded paths, no caller input, set -euo pipefail, non-zero on failure
(docs/Installer/update-spec.md "NFS-helper refresh", F11a).

This is the bootstrapping release for the wrapper: a host must re-run the
xinas_menu role once to pick it up, per update-spec.md "Bootstrapping the
helper-sync wrapper" — hence the trailer below.
Requires-Rebuild: xinas_menu
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12 (F11b): `refresh_nfs_helper()` — four outcomes, checked exit status

**Files:** Modify `xinas_menu/utils/update_check.py`, `tests/test_update_check.py`. Create `tests/test_nfs_helper_refresh_outcomes.py`.

**The bug.** `update_check.py:356-372`'s `_sync_nfs_helper()`: returns `None` silently if `src`/`dest` aren't directories (can't distinguish "not installed" from "actually broken"); calls `shutil.copy2` which raises `PermissionError` when run as `xinnor` against the root-owned destination; then runs `subprocess.run(["systemctl", "restart", "xinas-nfs-helper"], capture_output=True, timeout=15)` and **discards the result** — a failed restart is invisible. It's called from `apply_update()` (`update_check.py:349`), between checkout and `return True`, so any raised exception there is caught by `apply_update`'s bare `except Exception` and reported as a **full apply failure** — even though the checkout already succeeded. Per `docs/Installer/update-spec.md` "NFS-helper refresh," this is wrong: none of the four outcomes should be an unqualified failure of `apply_update` itself.

- [ ] **Step 1: failing test.** Create `tests/test_nfs_helper_refresh_outcomes.py`:

```python
"""WS3 (T12, F11b): refresh_nfs_helper() implements the four documented
outcomes (docs/Installer/update-spec.md "NFS-helper refresh") instead of the
old _sync_nfs_helper(), which discarded the systemctl restart's result and
could not distinguish "not installed" from "actually broken." Calls the
xinas-update-helper-sync wrapper via `sudo -n`, checking its exit status —
never discarding a subprocess.run result — with a direct-copy fallback when
the wrapper isn't deployed, mirroring _privileged_git's existing shape.
"""
from xinas_menu.utils import update_check as uc


def test_skip_when_all_tag_covers_it(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "irrelevant")
    r = uc.refresh_nfs_helper(tmp_path, ("all",))
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_REBUILD_COVERED
    assert r.ok is True


def test_skip_when_xinas_nfs_helper_tag_covers_it(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "irrelevant")
    r = uc.refresh_nfs_helper(tmp_path, ("nfs_server", "xinas_nfs_helper"))
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_REBUILD_COVERED
    assert r.ok is True


def test_skip_when_dest_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", tmp_path / "not-installed")
    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.SKIPPED_NOT_INSTALLED
    assert r.ok is True


def test_success_via_wrapper(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\nexit 0\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.SUCCESS
    assert r.ok is True


def test_fails_with_wrapper_present_nonzero(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    wrapper = tmp_path / "xinas-update-helper-sync"
    wrapper.write_text("#!/bin/bash\necho boom >&2\nexit 1\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", wrapper)

    r = uc.refresh_nfs_helper(tmp_path, ())
    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_WRAPPER
    assert r.ok is False
    assert r.remediation == "sudo /usr/local/sbin/xinas-update-helper-sync"


def test_fails_without_wrapper_names_role_redeploy_not_wrapper(monkeypatch, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    monkeypatch.setattr(uc, "_NFS_HELPER_DEST", dest)
    monkeypatch.setattr(uc, "_HELPER_SYNC_WRAPPER", tmp_path / "no-such-wrapper")
    src = tmp_path / "xiNAS-MCP" / "nfs-helper"
    src.mkdir(parents=True)
    (src / "nfs_helper.py").write_text("# stub\n")
    dest.chmod(0o500)  # read-only: shutil.copy2 into it raises PermissionError
    try:
        r = uc.refresh_nfs_helper(tmp_path, ())
    finally:
        dest.chmod(0o700)  # restore so tmp_path cleanup can remove it

    assert r.outcome is uc.NfsHelperRefreshOutcome.FAILED_NO_WRAPPER
    assert r.ok is False
    assert r.remediation == "sudo ansible-playbook playbooks/site.yml --tags xinas_menu"
    assert "xinas-update-helper-sync" not in r.remediation


def test_apply_update_no_longer_calls_sync(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    c = uc.UpdateChecker(repo_path=tmp_path, current_version="3.1.0", releases_fetcher=lambda: [])
    monkeypatch.setattr(uc, "_privileged_git", lambda repo, *a: "")
    assert not hasattr(c, "_sync_nfs_helper")
    ok, _msg = c.apply_update("v3.1.1")
    assert ok is True
```

  Also **edit** the existing `tests/test_update_check.py::test_apply_update_checks_out_tag_not_main` — remove the now-invalid line `monkeypatch.setattr(c, "_sync_nfs_helper", lambda: None)` (the method no longer exists; `monkeypatch.setattr` on a missing attribute raises `AttributeError` by default).

- [ ] **Step 2: red.** New tests FAIL (`refresh_nfs_helper`, `NfsHelperRefreshOutcome`, `_NFS_HELPER_DEST`, `_HELPER_SYNC_WRAPPER` don't exist yet); the edited `test_update_check.py` test currently fails for the opposite reason (the stale monkeypatch line references a method that WILL be removed in Step 3 — confirm this test still passes pre-Step-3 with the line still present, then make the edit as part of Step 3's commit so red/green stays coherent per attribute).

- [ ] **Step 3: implement.** In `xinas_menu/utils/update_check.py`:

  Add near the top (after the existing imports, before `_TRAILER_RE`):

```python
from enum import Enum
```

  Add after the `_PRIVILEGED_HELPER` constant (currently line 400):

```python
_HELPER_SYNC_WRAPPER = Path("/usr/local/sbin/xinas-update-helper-sync")
_NFS_HELPER_DEST = Path("/usr/lib/xinas-mcp/nfs-helper")


class NfsHelperRefreshOutcome(Enum):
    """The four outcomes in docs/Installer/update-spec.md "NFS-helper refresh"."""

    SKIPPED_REBUILD_COVERED = "skipped_rebuild_covered"
    SKIPPED_NOT_INSTALLED = "skipped_not_installed"
    SUCCESS = "success"
    FAILED_WRAPPER = "failed_wrapper"
    FAILED_NO_WRAPPER = "failed_no_wrapper"


@dataclass(frozen=True)
class NfsHelperRefreshResult:
    outcome: NfsHelperRefreshOutcome
    detail: str = ""

    @property
    def ok(self) -> bool:
        """True unless the refresh actually failed (never a bare failure of
        apply_update itself — see update-spec.md outcome (d))."""
        return self.outcome not in (
            NfsHelperRefreshOutcome.FAILED_WRAPPER,
            NfsHelperRefreshOutcome.FAILED_NO_WRAPPER,
        )

    @property
    def remediation(self) -> str:
        """The one remediation that matches why it failed — never interchangeable."""
        if self.outcome is NfsHelperRefreshOutcome.FAILED_WRAPPER:
            return "sudo /usr/local/sbin/xinas-update-helper-sync"
        if self.outcome is NfsHelperRefreshOutcome.FAILED_NO_WRAPPER:
            return "sudo ansible-playbook playbooks/site.yml --tags xinas_menu"
        return ""


def refresh_nfs_helper(
    repo: Path | None, required_rebuilds: tuple[str, ...]
) -> NfsHelperRefreshResult:
    """Refresh the installed NFS-helper daemon after a code-only update.

    Call this AFTER a successful rebuild (or directly after checkout when no
    rebuild trailer is present) — never after a failed rebuild; the safety
    stop is enforced by the caller (see xinas_menu/utils/update_apply.py).
    """
    if required_rebuilds == ("all",) or "xinas_nfs_helper" in required_rebuilds:
        return NfsHelperRefreshResult(NfsHelperRefreshOutcome.SKIPPED_REBUILD_COVERED)

    if not _NFS_HELPER_DEST.is_dir():
        return NfsHelperRefreshResult(NfsHelperRefreshOutcome.SKIPPED_NOT_INSTALLED)

    if _HELPER_SYNC_WRAPPER.exists() and os.access(_HELPER_SYNC_WRAPPER, os.X_OK):
        r = subprocess.run(
            ["sudo", "-n", str(_HELPER_SYNC_WRAPPER)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if r.returncode == 0:
            return NfsHelperRefreshResult(NfsHelperRefreshOutcome.SUCCESS)
        return NfsHelperRefreshResult(
            NfsHelperRefreshOutcome.FAILED_WRAPPER,
            detail=(r.stderr or r.stdout or f"wrapper exited {r.returncode}").strip(),
        )

    # Wrapper not deployed (host predating this change) — direct fallback,
    # mirroring _privileged_git's fallback shape. This normally hits
    # PermissionError against the root-owned destination when run as the
    # unprivileged xinnor user; that is outcome (d) with the "wrapper
    # absent" remediation — there is no wrapper to name.
    if repo is None:
        return NfsHelperRefreshResult(
            NfsHelperRefreshOutcome.FAILED_NO_WRAPPER, detail="no repo found"
        )
    src = repo / "xiNAS-MCP" / "nfs-helper"
    if not src.is_dir():
        return NfsHelperRefreshResult(NfsHelperRefreshOutcome.SKIPPED_NOT_INSTALLED)
    try:
        import shutil

        for py_file in src.glob("*.py"):
            shutil.copy2(py_file, _NFS_HELPER_DEST / py_file.name)
        subprocess.run(
            ["systemctl", "restart", "xinas-nfs-helper"],
            check=True,
            capture_output=True,
            timeout=15,
        )
        return NfsHelperRefreshResult(NfsHelperRefreshOutcome.SUCCESS)
    except Exception as exc:  # noqa: BLE001 — surface any refresh failure
        return NfsHelperRefreshResult(NfsHelperRefreshOutcome.FAILED_NO_WRAPPER, detail=str(exc))
```

  Remove the `_sync_nfs_helper` method entirely and its call from `apply_update`. Change:

```python
        try:
            _privileged_git(self._repo, "fetch")
            out = _privileged_git(self._repo, "checkout", tag)
            self._sync_nfs_helper()
            return True, out or f"checked out {tag}"
        except subprocess.CalledProcessError as exc:
            return False, _short_git_error(exc)
        except Exception as exc:  # noqa: BLE001 — surface any apply failure verbatim
            return False, str(exc)

    def _sync_nfs_helper(self) -> None:
        """Copy nfs-helper sources to installed location and restart the service."""
        if self._repo is None:
            return
        src = self._repo / "xiNAS-MCP" / "nfs-helper"
        dest = Path("/usr/lib/xinas-mcp/nfs-helper")
        if not src.is_dir() or not dest.is_dir():
            return
        import shutil

        for py_file in src.glob("*.py"):
            shutil.copy2(py_file, dest / py_file.name)
        subprocess.run(
            ["systemctl", "restart", "xinas-nfs-helper"],
            capture_output=True,
            timeout=15,
        )
```

  to:

```python
        try:
            _privileged_git(self._repo, "fetch")
            out = _privileged_git(self._repo, "checkout", tag)
            return True, out or f"checked out {tag}"
        except subprocess.CalledProcessError as exc:
            return False, _short_git_error(exc)
        except Exception as exc:  # noqa: BLE001 — surface any apply failure verbatim
            return False, str(exc)
```

  Add a public accessor for the repo path (Task 13's shared orchestrator needs it and `self._repo` is private):

```python
    @property
    def repo_path(self) -> Path | None:
        return self._repo
```

  (Place it near `allow_prerelease` in the `UpdateChecker` class body.)

- [ ] **Step 4: edit the existing test.** In `tests/test_update_check.py`, `test_apply_update_checks_out_tag_not_main` — remove the line `monkeypatch.setattr(c, "_sync_nfs_helper", lambda: None)` (the method no longer exists on `UpdateChecker`).

- [ ] **Step 5: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_nfs_helper_refresh_outcomes.py tests/test_update_check.py -q` → all pass.

- [ ] **Step 6: lint.** `/tmp/xinas-pytest-venv/bin/python -m ruff check xinas_menu` and `ruff format --check xinas_menu` (both are CI-scoped, both must be clean).

- [ ] **Step 7: commit.**

```bash
git add xinas_menu/utils/update_check.py tests/test_nfs_helper_refresh_outcomes.py tests/test_update_check.py
git commit -m "$(cat <<'EOF'
fix(xinas_menu): refresh_nfs_helper() implements the four documented outcomes

_sync_nfs_helper() silently no-op'd when src/dest weren't directories
(indistinguishable from "actually broken") and discarded the systemctl
restart's exit status entirely; it was called inline from apply_update(), so
any exception there reported a FULL apply failure even though the checkout
had already succeeded (docs/Installer/update-spec.md "NFS-helper refresh",
F11b). New module-level refresh_nfs_helper() returns an explicit outcome
(skip-covered / skip-absent / success / fail-with-wrapper /
fail-without-wrapper) with the correct non-interchangeable remediation per
failure mode, calling the new xinas-update-helper-sync wrapper via `sudo -n`
with a checked exit status. Call site moves to Task 13's shared app-level
orchestrator.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13 (F11c): move the refresh into app-level orchestration, de-duplicate, add the missing test

**Files:** Create `xinas_menu/utils/update_apply.py`. Modify `xinas_menu/app.py`, `xinas_menu/screens/startup/startup_menu.py`. Create `tests/test_update_apply_orchestration.py`.

**The bug.** `_apply_update()` is **byte-identical** between `xinas_menu/app.py:237-268` (`XiNASApp`) and `xinas_menu/screens/startup/startup_menu.py:59-90` (`StartupApp`) — checkout, then rebuild-if-needed with a safety stop on `rc != 0`, then restart. Neither copy calls the NFS-helper refresh (that lived inside `apply_update()` itself, per Task 12's fix, and is now removed from there). Per `docs/Installer/update-spec.md` "Update apply," the refresh must run **after** a successful rebuild (or directly after checkout when no rebuild is required), and **never** after a failed rebuild. There is **zero existing test coverage** for either `_apply_update` or `prompt_and_apply_update`.

- [ ] **Step 1: failing test.** Create `tests/test_update_apply_orchestration.py`:

```python
"""WS3 (T13, F11c): shared update-apply orchestration (checkout -> rebuild ->
refresh -> restart), replacing the duplicated _apply_update() bodies in
xinas_menu/app.py (XiNASApp) and xinas_menu/screens/startup/startup_menu.py
(StartupApp). This path had ZERO test coverage before this task.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from xinas_menu.utils import update_check as uc
from xinas_menu.utils.update_apply import apply_update_flow


class _FakeApp:
    def __init__(self):
        self._update_checker = MagicMock()
        self.audit = MagicMock()
        self.notify = MagicMock()
        self.push_screen_wait = AsyncMock()


def _result(tag="v3.1.1", rebuilds=()):
    return uc.CheckResult(
        True, current_version="3.1.0", latest_version=tag, required_rebuilds=rebuilds
    )


def test_no_rebuild_refreshes_then_restarts(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    refreshed = uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)
    monkeypatch.setattr(
        "xinas_menu.utils.update_apply.refresh_nfs_helper", lambda repo, tags: refreshed
    )

    asyncio.run(apply_update_flow(app, _result(rebuilds=())))

    app._update_checker.restart_self.assert_called_once()
    app.push_screen_wait.assert_not_called()  # no rebuild -> no PlaybookRunScreen


def test_failed_rebuild_stops_before_refresh_or_restart(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    app.push_screen_wait.return_value = 1  # ansible rc != 0
    called = {"refresh": False}

    def _fake_refresh(repo, tags):
        called["refresh"] = True
        return uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)

    monkeypatch.setattr("xinas_menu.utils.update_apply.refresh_nfs_helper", _fake_refresh)

    asyncio.run(apply_update_flow(app, _result(rebuilds=("nfs_server",))))

    assert called["refresh"] is False, "refresh must not run after a failed rebuild"
    app._update_checker.restart_self.assert_not_called()
    app.notify.assert_called_once()
    assert "not restarting" in app.notify.call_args.args[0]


def test_successful_rebuild_refreshes_then_restarts(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    app.push_screen_wait.return_value = 0  # ansible rc == 0
    seen = {}

    def _fake_refresh(repo, tags):
        seen["tags"] = tags
        return uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)

    monkeypatch.setattr("xinas_menu.utils.update_apply.refresh_nfs_helper", _fake_refresh)

    asyncio.run(apply_update_flow(app, _result(rebuilds=("nfs_server",))))

    assert seen["tags"] == ("nfs_server",)
    app._update_checker.restart_self.assert_called_once()


def test_refresh_failure_is_partial_success_not_blocking_restart(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    failed = uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.FAILED_WRAPPER, detail="boom")
    monkeypatch.setattr(
        "xinas_menu.utils.update_apply.refresh_nfs_helper", lambda repo, tags: failed
    )

    asyncio.run(apply_update_flow(app, _result(rebuilds=())))

    app._update_checker.restart_self.assert_called_once()  # still restarts
    warn_call = app.notify.call_args
    assert warn_call.kwargs.get("severity") == "warning"
    assert "sudo /usr/local/sbin/xinas-update-helper-sync" in warn_call.args[0]


def test_checkout_failure_never_reaches_refresh_or_restart():
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (False, "permission denied")

    asyncio.run(apply_update_flow(app, _result()))

    app._update_checker.restart_self.assert_not_called()
    app.push_screen_wait.assert_not_called()
    app.notify.assert_called_once()
    assert "Update failed" in app.notify.call_args.args[0]


def test_app_and_startup_app_delegate_to_shared_flow():
    import inspect

    from xinas_menu.app import XiNASApp
    from xinas_menu.screens.startup.startup_menu import StartupApp

    for cls in (XiNASApp, StartupApp):
        src = inspect.getsource(cls._apply_update)
        assert "apply_update_flow" in src, (
            f"{cls.__name__}._apply_update must delegate to the shared helper"
        )
```

- [ ] **Step 2: red.** All FAIL (`xinas_menu.utils.update_apply` doesn't exist yet; both apps still have the duplicated inline body).

- [ ] **Step 3: create the shared orchestrator.** `xinas_menu/utils/update_apply.py`:

```python
"""Shared update-apply orchestration for XiNASApp and StartupApp.

Both apps' `_apply_update()` used to carry an identical, independently
maintained copy of this sequence. Factored here so there is exactly one
place implementing docs/Installer/update-spec.md "Update apply": fetch and
checkout, then (if a rebuild is required) run it and STOP on failure with no
refresh and no restart, then refresh the NFS helper, then restart — a
refresh failure is a partial success (the checkout/rebuild already
succeeded) and must not block the restart.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

from xinas_menu.utils.update_check import (
    CheckResult,
    UpdateChecker,
    build_rebuild_cmd,
    refresh_nfs_helper,
)

if TYPE_CHECKING:
    from xinas_menu.utils.audit import AuditLogger


class _UpdateApp(Protocol):
    """The subset of App state apply_update_flow needs from its caller."""

    _update_checker: UpdateChecker
    audit: "AuditLogger"

    def notify(self, message: str, *, severity: str = "information", timeout: float = 3) -> None: ...

    async def push_screen_wait(self, screen: object) -> object: ...


async def apply_update_flow(app: _UpdateApp, result: CheckResult | None) -> None:
    tag = result.latest_version if result else ""
    if not tag:
        app.notify("No release selected to apply.", severity="error")
        return

    loop = asyncio.get_running_loop()
    ok, msg = await loop.run_in_executor(None, app._update_checker.apply_update, tag)
    if not ok:
        app.notify(f"Update failed: {msg}", severity="error")
        return
    app.audit.log("system.update", f"checked out release {tag}")

    rebuilds = result.required_rebuilds if result else ()
    cmd = build_rebuild_cmd(rebuilds)
    if cmd:
        from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

        app.audit.log("system.update", f"rebuild required: {' '.join(cmd)}")
        rc = await app.push_screen_wait(
            PlaybookRunScreen(cmd=cmd, title="Applying update — Ansible rebuild")
        )
        if rc != 0:
            app.notify(
                "Update applied but Ansible failed — not restarting. "
                "Review the log and re-run the role manually.",
                severity="error",
                timeout=15,
            )
            return

    refresh = await loop.run_in_executor(
        None, refresh_nfs_helper, app._update_checker.repo_path, rebuilds
    )
    if not refresh.ok:
        app.audit.log("system.update", f"nfs-helper refresh failed: {refresh.detail}")
        app.notify(
            "Update applied, but the NFS-helper refresh failed — the helper "
            f"may be stale. Run: {refresh.remediation}",
            severity="warning",
            timeout=20,
        )
        # Partial success per update-spec.md outcome (d): checkout (and any
        # rebuild) already succeeded — still restart into the new code.

    app.audit.log("system.update", "complete — restarting")
    app._update_checker.restart_self()
```

- [ ] **Step 4: de-duplicate `xinas_menu/app.py`.** Replace `_apply_update` (currently lines 237-268):

```python
    async def _apply_update(self, result: CheckResult | None = None) -> None:
        tag = result.latest_version if result else ""
        if not tag:
            self.notify("No release selected to apply.", severity="error")
            return
        loop = asyncio.get_running_loop()
        ok, msg = await loop.run_in_executor(None, self._update_checker.apply_update, tag)
        if not ok:
            self.notify(f"Update failed: {msg}", severity="error")
            return
        self.audit.log("system.update", f"checked out release {tag}")

        rebuilds = result.required_rebuilds if result else ()
        cmd = build_rebuild_cmd(rebuilds)
        if cmd:
            from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

            self.audit.log("system.update", f"rebuild required: {' '.join(cmd)}")
            rc = await self.push_screen_wait(
                PlaybookRunScreen(cmd=cmd, title="Applying update — Ansible rebuild")
            )
            if rc != 0:
                self.notify(
                    "Update applied but Ansible failed — not restarting. "
                    "Review the log and re-run the role manually.",
                    severity="error",
                    timeout=15,
                )
                return

        self.audit.log("system.update", "complete — restarting")
        self._update_checker.restart_self()
```

  with:

```python
    async def _apply_update(self, result: CheckResult | None = None) -> None:
        from xinas_menu.utils.update_apply import apply_update_flow

        await apply_update_flow(self, result)
```

- [ ] **Step 5: de-duplicate `xinas_menu/screens/startup/startup_menu.py`.** Replace `_apply_update` (currently lines 59-90) the same way:

```python
    async def _apply_update(self, result: CheckResult | None = None) -> None:
        from xinas_menu.utils.update_apply import apply_update_flow

        await apply_update_flow(self, result)
```

  (`build_rebuild_cmd`/`CheckResult` may now be unused imports in this file — check with `ruff check` and drop them if so, keeping `UpdateChecker` since `self._update_checker = UpdateChecker()` still lives in `__init__`.)

- [ ] **Step 6: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_update_apply_orchestration.py -q` → all pass. Also run the full TUI test suite once (`/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q`) since this touches two app-level files other screens may import.

- [ ] **Step 7: lint.** `ruff check xinas_menu` / `ruff format --check xinas_menu` clean (CI-scoped).

- [ ] **Step 8: commit.**

```bash
git add xinas_menu/utils/update_apply.py xinas_menu/app.py xinas_menu/screens/startup/startup_menu.py tests/test_update_apply_orchestration.py
git commit -m "$(cat <<'EOF'
refactor(xinas_menu): shared apply_update_flow(), NFS-helper refresh wired in

XiNASApp._apply_update and StartupApp._apply_update carried a byte-identical
checkout -> rebuild -> restart sequence, independently maintained in two
files, and had zero test coverage (F11c). Factor into
xinas_menu/utils/update_apply.py: one place implementing
docs/Installer/update-spec.md "Update apply" — refresh_nfs_helper() (Task 12)
runs after a successful rebuild (or directly after checkout with no
trailer), never after a failed rebuild, and a refresh failure is a partial
success that still restarts. Both apps now delegate to it. Adds the
orchestration test that did not exist before this task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14 (F12): remove `XINAS_UPDATE_REPO`

**Files:** Modify `xinas_menu/utils/update_check.py`, `startup_menu.sh`, `simple_menu.sh`, `post_install_menu.sh`, `client_repo/client_setup.sh`. Create `tests/test_update_repo_env_var_removed.py`.

**The bug.** `docs/Installer/update-spec.md` "Release-detection source is fixed" (landed in commit `2bb3063`, already the live contract) states `XINAS_UPDATE_REPO` **is removed** — the spec is already ahead of the code here, so this task is a pure code-catch-up with no further spec edit needed. Five surfaces still read it: `xinas_menu/utils/update_check.py:35`, `startup_menu.sh:44`, `simple_menu.sh:19`, `post_install_menu.sh:175`, `client_repo/client_setup.sh:39`. `XINAS_UPDATE_CHANNEL` is unaffected and stays.

- [ ] **Step 1: failing test.** Create `tests/test_update_repo_env_var_removed.py`:

```python
"""WS3 (T14, F12): XINAS_UPDATE_REPO is removed — release-detection source
is fixed at XinnorLab/xiNAS everywhere (docs/Installer/update-spec.md
"Release-detection source is fixed", already landed in commit 2bb3063 — this
task is the code catch-up). No environment variable may redirect version
comparison, release notes, Requires-Rebuild trailers, or the download link
away from the official feed. XINAS_UPDATE_CHANNEL is unaffected.
"""
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

_SURFACES = [
    "xinas_menu/utils/update_check.py",
    "startup_menu.sh",
    "simple_menu.sh",
    "post_install_menu.sh",
    "client_repo/client_setup.sh",
]


def test_env_var_removed_from_all_five_surfaces():
    for rel in _SURFACES:
        body = (REPO / rel).read_text()
        assert "XINAS_UPDATE_REPO" not in body, f"{rel} still reads XINAS_UPDATE_REPO (F12)"


def test_no_grep_hits_repo_wide_on_the_five_surfaces():
    proc = subprocess.run(
        ["grep", "-l", "XINAS_UPDATE_REPO", *_SURFACES],
        cwd=REPO, capture_output=True, text=True,
    )
    # grep exits 1 when there are no matches at all — that IS the success case.
    assert proc.returncode == 1, proc.stdout


def test_update_checker_ignores_the_removed_env_var(monkeypatch):
    monkeypatch.setenv("XINAS_UPDATE_REPO", "some-fork/xiNAS")
    from xinas_menu.utils import update_check as uc

    c = uc.UpdateChecker(current_version="3.1.0", releases_fetcher=lambda: [])
    assert c._repo_slug == "XinnorLab/xiNAS"


def test_update_channel_env_var_still_works(monkeypatch):
    monkeypatch.setenv("XINAS_UPDATE_CHANNEL", "prerelease")
    from xinas_menu.utils import update_check as uc

    c = uc.UpdateChecker(current_version="3.1.0", releases_fetcher=lambda: [])
    assert c.allow_prerelease is True
```

- [ ] **Step 2: red.** `test_env_var_removed_from_all_five_surfaces` and `test_no_grep_hits_repo_wide_on_the_five_surfaces` FAIL; `test_update_checker_ignores_the_removed_env_var` also FAILS today (`_repo_slug` would be `"some-fork/xiNAS"`); `test_update_channel_env_var_still_works` already passes (unaffected knob) — that's the regression guard.

- [ ] **Step 3: fix `xinas_menu/utils/update_check.py:35`.** Replace:

```python
_DEFAULT_REPO = os.environ.get("XINAS_UPDATE_REPO", "XinnorLab/xiNAS")
```

with:

```python
# Fixed at the repository of record — docs/Installer/update-spec.md
# "Release-detection source is fixed". There is deliberately no environment
# variable or config knob here; XINAS_UPDATE_CHANNEL (below) only changes
# which releases within this repo are eligible, never which repo is queried.
_DEFAULT_REPO = "XinnorLab/xiNAS"
```

- [ ] **Step 4: fix `startup_menu.sh:44`.** Replace `REPO_SLUG="${XINAS_UPDATE_REPO:-XinnorLab/xiNAS}"` with `REPO_SLUG="XinnorLab/xiNAS"`.

- [ ] **Step 5: fix `simple_menu.sh:19`** (identical replacement).

- [ ] **Step 6: fix `post_install_menu.sh:175`.** Replace `_UPDATE_REPO_SLUG="${XINAS_UPDATE_REPO:-XinnorLab/xiNAS}"` with `_UPDATE_REPO_SLUG="XinnorLab/xiNAS"`.

- [ ] **Step 7: fix `client_repo/client_setup.sh:39`.** Replace `CLIENT_REPO_SLUG="${XINAS_UPDATE_REPO:-XinnorLab/xiNAS}"` with `CLIENT_REPO_SLUG="XinnorLab/xiNAS"`.

- [ ] **Step 8: green.** `/tmp/xinas-pytest-venv/bin/python -m pytest tests/test_update_repo_env_var_removed.py -q` → all pass. `bash -n` on the four bash files clean.

- [ ] **Step 9: commit.**

```bash
git add xinas_menu/utils/update_check.py startup_menu.sh simple_menu.sh post_install_menu.sh client_repo/client_setup.sh tests/test_update_repo_env_var_removed.py
git commit -m "$(cat <<'EOF'
fix(installer): remove XINAS_UPDATE_REPO — release source is fixed

docs/Installer/update-spec.md "Release-detection source is fixed" (landed in
2bb3063) already states this env var is removed; this is the code catch-up.
An env var that redirects version comparison, release notes,
Requires-Rebuild trailers, and the download link could point an operator's
confirmation dialog at spoofed content indistinguishable from the genuine
feed (F12). XINAS_UPDATE_CHANNEL is unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: bookkeeping + full gate

**Files:** Modify `docs/plans/2026-07-07-codebase-review-remediation-plan.md`.

- [ ] **Step 1.** In `docs/plans/2026-07-07-codebase-review-remediation-plan.md` §WS3, tick all six checkboxes:

```markdown
- [x] **WS3.1** Fix the errexit bug: `status=0; ./simple_menu.sh || status=$?`
  ...
- [x] **WS3.2** Remove the fabricated-license path in `simple_menu.sh:691`
  ...
- [x] **WS3.3** `startup_menu.sh`: write update-check results to a temp file
  ...
- [x] **WS3.4** `install_client.sh`: propagate git failures, report accurately.
  ...
- [x] **WS3.5** `menu_lib.sh:1133`: wire the collect choice to
  ...
- [x] **WS3.6** `update_check.py:368`: check the restart result; on failure,
  ...
```

  (Tick the `- [ ]` → `- [x]` on the six existing bullets; do not otherwise reword them — they are review history.)

- [ ] **Step 2.** Immediately under `## WS3 — Installer & update flow correctness — HIGH`, add a Status line mirroring WS1/WS2's format:

```markdown
> **Status 2026-07-10:** LANDED on `ws3-installer-update-correctness` (T1–T14
> in `docs/plans/2026-07-10-ws3-installer-update-correctness-plan.md`), all 12
> findings (F1–F12) closed. WS3.1 covers T1; WS3.2 covers T2; WS3.3 covers
> T3–T5; WS3.4 covers T7–T9; WS3.5 covers T10; WS3.6 covers T11–T14. The
> `xinas-update-helper-sync` wrapper (T11) ships with
> `Requires-Rebuild: xinas_menu` — see update-spec.md "Bootstrapping the
> helper-sync wrapper" for why a host must take that release before the
> refresh self-heals.
```

- [ ] **Step 3: full gate.** Run every check below; all must be green before merging:

```bash
/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q
/tmp/xinas-pytest-venv/bin/python -m ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
/tmp/xinas-pytest-venv/bin/python -m ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
ansible-lint collection/roles/
for f in $(find . -name '*.sh' -not -path './.git/*'); do bash -n "$f" || echo "SYNTAX ERROR: $f"; done
npx --yes markdownlint-cli2 'docs/**/*.md'
gitleaks git --config .gitleaks.toml --log-opts="origin/main..HEAD" .
(cd xiNAS-MCP && npm run test:contracts)
```

- [ ] **Step 4: commit.**

```bash
git add docs/plans/2026-07-07-codebase-review-remediation-plan.md
git commit -m "$(cat <<'EOF'
docs(plans): tick WS3.1-WS3.6, add WS3 status line

All 12 WS3 findings (F1-F12) closed per
docs/plans/2026-07-10-ws3-installer-update-correctness-plan.md.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Spec-coverage check — every spec MUST maps to a task

| Spec requirement | Task |
|---|---|
| Apply order fetch → checkout `--force` → rebuild (STOP on rc≠0, no refresh, no restart) → refresh → restart | T13 (orchestration), T5 (bash `--force` parity) |
| Refresh via privileged wrapper `xinas-update-helper-sync`, contract mirrors `xinas-update-git` | T11 |
| Four outcomes + two non-interchangeable remediations | T12 |
| Bash-path parity: `--force` everywhere, semver not string compare, no false success | T4, T5, T7 |
| Release-detection repo fixed at `XinnorLab/xiNAS`; `XINAS_UPDATE_REPO` removed from Python + 4 bash scripts | T14 |
| spec.md §2.7 — menu exit-code contract | T1 |
| spec.md §7.8 — fail-closed preset application | T8 |
| spec.md §8.1 — pinned + checksummed `yq` by `uname -m` | T9 |
| spec.md §8.2 — license-recovery invariant (no fabricated `/tmp/license`) | T2 |
| spec.md §8.3 — honest install-failure dialog | T10 |
| spec.md §8.4 — client-installer accuracy | T7 |

All 11 spec MUSTs enumerated in the brief map to at least one task. None are left uncovered.

### Placeholder scan

Every task above shows the exact current code (verified against this worktree on 2026-07-10) and the exact replacement code — no "TBD," no "add error handling," no "similar to Task N" deferrals. The one open-ended item is Task 9's yq version/hash re-derivation note, which is explicitly scoped to "if time has passed and a newer yq is preferred" with the exact commands to re-derive and re-verify — the version pinned in this plan (`v4.53.3`) and both hashes were fetched from the real GitHub release and independently re-verified by downloading the binaries and hashing them locally (see Task 9 and the Report below).

### Naming / type consistency across tasks

- `NfsHelperRefreshOutcome` / `NfsHelperRefreshResult` (T12) are consumed by name in T13's `apply_update_flow` — both reference `uc.NfsHelperRefreshOutcome.*` and `refresh.ok` / `refresh.remediation` identically.
- `_semver_gt`/`_semver_parse` (T4) are the only comparison primitives introduced in bash; T3's tests exercise `check_for_updates` (which calls `_semver_gt` after T4 lands) without redefining comparison logic.
- `refresh_nfs_helper(repo, required_rebuilds)` signature is identical at its two call sites: directly in T12's tests and via `app._update_checker.repo_path` in T13's `apply_update_flow`.
- The skip condition (`tags == ("all",) or "xinas_nfs_helper" in tags`) is implemented exactly once, inside `refresh_nfs_helper` (T12) — T13 does not re-implement or duplicate it.
- Every new test file's `REPO` constant uses the same `Path(__file__).resolve().parents[1]` anchor already established by `tests/test_nvme_resolve_system_disks.py` and `tests/test_playbook_ticker_callback.py`.

---

**Full task list:**

| # | Title | Files touched | Test type |
|---|---|---|---|
| T1 | errexit/exit-2 contract | `prepare_system.sh`, `install.sh` | behavioral (prepare_system.sh end-to-end) + extracted-snippet (install.sh) |
| T2 | fabricated license in `simple_menu.sh` | `simple_menu.sh` | structural |
| T3 | update-check subshell race | `startup_menu.sh`, `simple_menu.sh` | behavioral (pty) + structural guard |
| T4 | semver compare in bash | `lib/menu_lib.sh`, `startup_menu.sh`, `simple_menu.sh` | behavioral |
| T5 | `git checkout --force` (4 of 5 sites) | `startup_menu.sh`, `simple_menu.sh`, `install.sh`, `prepare_system.sh` | behavioral (prepare_system.sh) + structural (rest) |
| T6 | guard `./hwkey` | `startup_menu.sh`, `simple_menu.sh` | behavioral (extracted-snippet) |
| T7 | `install_client.sh` accuracy + deferred `--force` | `install_client.sh` | structural |
| T8 | `autoinstall.sh` fail-closed preset copy | `autoinstall.sh` | behavioral (extracted-snippet) |
| T9 | pinned + checksummed `yq` | `prepare_system.sh` | behavioral (extracted-snippet) |
| T10 | wire "Collect Diagnostics" | `lib/menu_lib.sh` | behavioral |
| T11 | `xinas-update-helper-sync` wrapper | `collection/roles/xinas_menu/files/*`, `tasks/main.yml` | structural + `ansible-lint` |
| T12 | `refresh_nfs_helper()` four outcomes | `xinas_menu/utils/update_check.py` | behavioral (outcome matrix) |
| T13 | shared `apply_update_flow`, dedupe, new orchestration test | `xinas_menu/utils/update_apply.py` (new), `app.py`, `startup_menu.py` | behavioral (mocked orchestration) |
| T14 | remove `XINAS_UPDATE_REPO` | `update_check.py` + 4 bash scripts | behavioral + grep |
| T15 | bookkeeping + full gate | remediation-plan doc | N/A |
