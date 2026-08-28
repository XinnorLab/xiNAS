"""WS3.1 (T1, F1): prepare_system.sh and install.sh must not let a menu's
deliberate `exit 2` (operator chose "Exit") propagate as a real failure
(docs/Installer/spec.md §2.7). Both run under `set -e`; a bare
`cmd; status=$?` does not protect a non-zero `cmd` from errexit, so the
status capture must be wrapped in `set +e ... set -e`.

The first suite runs the real prepare_system.sh end-to-end with stubbed
menu scripts (only the exit-2 contract is a menu concern; the package-
install block is bypassed by stubbing `sudo` as a no-op, since every
privileged command in prepare_system.sh runs through `sudo` — except the
yq download itself (T9, F2 — pinned + checksum-verified, downloaded without
sudo by design), which is bypassed with `wget`/`sha256sum` stubs so that
step also succeeds hermetically without touching the network). The second
suite extracts install.sh's guarded "Preparing system" block verbatim and
executes it with a stub ./prepare_system.sh — install.sh itself requires
root (EUID check) and performs real system mutations before reaching this
step, so full end-to-end execution is impractical; the guarded-call PATTERN
is extracted and exercised directly instead.

Note on the install.sh assertions: bash's `errexit` preserves a failing
top-level command's own exit code when it aborts the script, so a bare
`set -e; ./prepare_system.sh` (no guard at all) and the guarded
`set +e; ./prepare_system.sh; rc=$?; set -e; [[ $rc -ne 0 ]] && exit "$rc"`
produce the SAME returncode on failure — the guard's observable effect is
that it also gets a chance to call `fail()` with a useful message before
exiting, which the unguarded form never does. That is the assertion below
that is genuinely red before the Step 4 fix and green after.
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
    # prepare_system.sh unconditionally `chmod +x`s BOTH menu scripts
    # (line 174: `chmod +x startup_menu.sh simple_menu.sh`) regardless of
    # which one -e selects — chmod fails (and, under set -e, aborts the
    # script) if either file is missing, so both must exist up front.
    for name in ("startup_menu.sh", "simple_menu.sh"):
        menu = tmp_path / name
        menu.write_text("#!/bin/bash\nexit 0\n")
        menu.chmod(0o755)
    # Without lib/menu_lib.sh, expert mode (-e) falls back to a raw
    # `read -r response` prompt (prepare_system.sh:166) that FAILS on EOF —
    # a bare failing command under `set -e` that aborts the script before
    # ever reaching the menu call, unrelated to the bug under test. Stub
    # menu_lib.sh's `yes_no`/`msg_box` so that branch is skipped cleanly
    # instead (real menu_lib.sh's `yes_no` is a full interactive TUI
    # reader, unsuitable for a hermetic test).
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    (lib_dir / "menu_lib.sh").write_text("#!/bin/bash\nyes_no() { return 1; }\nmsg_box() { :; }\n")
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
    # yq's download+verify (T9, F2) runs without sudo, so it isn't covered by
    # the no-op sudo stub above — stub wget/sha256sum too so that step
    # succeeds hermetically without a real network call. sha256sum answers
    # with the real pinned hash for whichever arch `uname -m` reports, so the
    # in-script checksum comparison passes regardless of host architecture.
    (stub_bin / "wget").write_text('#!/bin/bash\nprintf fake-yq-bytes > "$2"\n')
    (stub_bin / "wget").chmod(0o755)
    (stub_bin / "sha256sum").write_text(
        "#!/bin/bash\n"
        'case "$(uname -m)" in\n'
        '    x86_64) echo "fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4  -" ;;\n'
        '    aarch64|arm64) echo "578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea  -" ;;\n'
        '    *) echo "0000000000000000000000000000000000000000000000000000000000000000  -" ;;\n'
        "esac\n"
    )
    (stub_bin / "sha256sum").chmod(0o755)

    env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}", XINAS_QUIET="1")
    args = ["-e"] if expert else []
    return subprocess.run(
        ["bash", str(PREPARE_SYSTEM), *args],
        cwd=sandbox,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        # _sandbox() plants a stub lib/menu_lib.sh, so expert mode always
        # takes the yes_no-guarded branch, never the raw `read -r` fallback;
        # a closed stdin is just defensive insurance against any stray
        # stdin read hanging the suite.
        stdin=subprocess.DEVNULL,
    )


def test_default_menu_exit_2_propagates_verbatim(tmp_path):
    # spec.md 2.7: status 2 means "operator aborted, nothing was
    # provisioned". Collapsing it to 0 erases the only signal install.sh
    # has that no playbook ran.
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=2)
    assert proc.returncode == 2, f"stdout={proc.stdout}\nstderr={proc.stderr}"


def test_expert_menu_exit_2_propagates_verbatim(tmp_path):
    proc = _run_prepare_system(tmp_path, expert=True, menu_exit_code=2)
    assert proc.returncode == 2, f"stdout={proc.stdout}\nstderr={proc.stderr}"


def test_real_menu_failure_still_propagates(tmp_path):
    # A genuine crash (not the Exit choice) must still abort with that code —
    # the fix must not swallow every exit code, only 2.
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=1)
    assert proc.returncode == 1


def test_menu_success_exits_zero(tmp_path):
    # A normally-completed menu (status 0) must exit 0 with no diagnostic —
    # only non-zero, non-2 statuses are a "real failure".
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=0)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert "status" not in proc.stderr.lower()


def test_real_failure_prints_diagnostic(tmp_path):
    # Running prepare_system.sh standalone (not via install.sh) must explain
    # a real menu failure on stderr instead of exiting non-zero silently.
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=1)
    assert proc.returncode == 1
    assert "status 1" in proc.stderr.lower()


def test_menu_exit_2_prints_no_diagnostic(tmp_path):
    # exit 2 (operator chose "Exit") is not a failure, so it must stay silent
    # — the status is propagated, but no "Menu exited with status" complaint.
    proc = _run_prepare_system(tmp_path, expert=False, menu_exit_code=2)
    assert proc.returncode == 2
    assert "status" not in proc.stderr.lower()


def _extract_install_sh_prepare_block() -> str:
    # Bounded by the NEXT top-level "# ── " section header rather than by
    # the next literal "fi" — pre-fix there is no `if` around this call at
    # all, so anchoring on "\nfi\n" over-captures all the way through the
    # unrelated (and already-guarded) "Unattended provisioning" block below
    # it, which happens to close with its own `fi`. The section-header
    # lookahead isolates exactly the "Preparing system" step both before
    # and after the Step 4 fix adds its own `if`/`fi` guard.
    src = INSTALL_SH.read_text()
    m = re.search(r'step "Preparing system".*?(?=\n# ── )', src, re.S)
    assert m, "install.sh's 'Preparing system' step block not found"
    return m.group(0)


def _run_install_sh_prepare_block(tmp_path: Path, *, prepare_exit_code: int):
    stub_prepare = tmp_path / "prepare_system.sh"
    stub_prepare.write_text(f"#!/bin/bash\nexit {prepare_exit_code}\n")
    stub_prepare.chmod(0o755)

    snippet = (
        "set -e\n"
        'WHITE=""; NC=""; UNATTENDED="0"; LOG_FILE="/tmp/nonexistent.log"\n'
        "step() { :; }\n"
        "info() { :; }\n"
        'fail() { echo "FAIL: $*" >&2; }\n'
        + _extract_install_sh_prepare_block()
        + '\necho "REACHED_END"\n'
    )
    return subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_install_sh_prepare_block_continues_on_success(tmp_path):
    # Smoke check: success is unaffected by the guard either way (bash's
    # errexit only changes behavior on a *failing* command), but this
    # pins down that the extracted block still reaches the step after it.
    proc = _run_install_sh_prepare_block(tmp_path, prepare_exit_code=0)
    assert proc.returncode == 0, proc.stderr
    assert "REACHED_END" in proc.stdout


def test_install_sh_prepare_block_aborts_on_real_failure(tmp_path):
    # Note: under `set -e`, an UNGUARDED failing simple command aborts the
    # script with that same exit code anyway (errexit preserves the failing
    # command's own status) — so returncode/REACHED_END alone can't tell a
    # guarded call from an unguarded one here. The `fail()` message is the
    # part that only happens once the guard exists to capture the status
    # and act on it explicitly, so it is the assertion that is genuinely
    # red pre-fix and green post-fix.
    proc = _run_install_sh_prepare_block(tmp_path, prepare_exit_code=1)
    assert proc.returncode == 1
    assert "REACHED_END" not in proc.stdout
    assert "FAIL:" in proc.stderr, f"expected fail() to report before exiting; stderr={proc.stderr}"


# ── install.sh: an aborted setup must not install the management TUI ─────────
# spec.md §2.7 "exit 2 is not a success either". Pre-fix, install.sh could not
# tell "operator chose Exit" (menu 2 -> prepare_system 0) from "deployment
# completed" (menu 0 -> prepare_system 0), so it bootstrapped the xinas-menu /
# xinas-setup wrappers and printed "xiNAS installed successfully!" for a host
# on which no playbook had ever run.


def _extract_install_sh_tail() -> str:
    """install.sh from the 'Preparing system' step through the final banner."""
    src = INSTALL_SH.read_text()
    m = re.search(r'step "Preparing system".*', src, re.S)
    assert m, "install.sh's 'Preparing system' step block not found"
    return m.group(0)


def _run_install_sh_tail(tmp_path: Path, *, prepare_exit_code: int):
    stub_prepare = tmp_path / "prepare_system.sh"
    stub_prepare.write_text(f"#!/bin/bash\nexit {prepare_exit_code}\n")
    stub_prepare.chmod(0o755)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    install_dir = tmp_path / "opt-xinas"
    install_dir.mkdir()

    # MENU_WRAPPER / SETUP_WRAPPER are assigned in install.sh ABOVE the
    # extracted region (next to INSTALL_DIR), so redirecting them at the
    # host's real /usr/local/bin is a plain variable override here — no
    # test-only env knob in the shipped script.
    snippet = (
        "set -e\n"
        'RED=""; GREEN=""; YELLOW=""; CYAN=""; WHITE=""; DIM=""; BOLD=""; NC=""\n'
        'UNATTENDED="0"; LOG_FILE="/dev/null"\n'
        f'INSTALL_DIR="{install_dir}"\n'
        f'MENU_WRAPPER="{bindir}/xinas-menu"\n'
        f'SETUP_WRAPPER="{bindir}/xinas-setup"\n'
        "step() { :; }\n"
        "info() { :; }\n"
        'ok()   { echo "OK: $*"; }\n'
        'warn() { echo "WARN: $*"; }\n'
        'fail() { echo "FAIL: $*" >&2; }\n'
        "run_quiet() { :; }\n" + _extract_install_sh_tail()
    )
    proc = subprocess.run(
        ["bash", "-c", snippet],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return proc, bindir, install_dir


def test_aborted_setup_does_not_install_management_tui(tmp_path):
    proc, bindir, _ = _run_install_sh_tail(tmp_path, prepare_exit_code=2)
    assert not (bindir / "xinas-menu").exists(), (
        "operator exited setup without provisioning, but install.sh still "
        f"wrote the management-console wrapper; stdout={proc.stdout}"
    )
    assert not (bindir / "xinas-setup").exists()


def test_aborted_setup_does_not_claim_success(tmp_path):
    proc, _, _ = _run_install_sh_tail(tmp_path, prepare_exit_code=2)
    assert "installed successfully" not in proc.stdout, (
        f"success banner printed for an aborted setup; stdout={proc.stdout}"
    )


def test_aborted_setup_is_not_reported_as_a_failure(tmp_path):
    # spec.md §2.7 "exit 2 is not a failure": no ✗, no fail(), exit 0.
    proc, _, _ = _run_install_sh_tail(tmp_path, prepare_exit_code=2)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert "FAIL:" not in proc.stderr, proc.stderr


def test_aborted_setup_explains_how_to_resume(tmp_path):
    proc, _, install_dir = _run_install_sh_tail(tmp_path, prepare_exit_code=2)
    out = proc.stdout
    assert str(install_dir) in out, f"staged directory not named; stdout={out}"
    # Resume goes back through install.sh — the one supported entry point —
    # not straight into prepare_system.sh (spec.md 2.7).
    assert f"{install_dir}/install.sh" in out, f"no resume command; stdout={out}"


def test_completed_setup_still_bootstraps_wrapper_and_reports_success(tmp_path):
    # The status-0 path is unchanged: the wrapper bootstrap remains a safety
    # net for a preset whose playbook.yml omits the xinas_menu role.
    proc, bindir, _ = _run_install_sh_tail(tmp_path, prepare_exit_code=0)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert (bindir / "xinas-menu").exists(), proc.stdout
    assert (bindir / "xinas-setup").exists(), proc.stdout
    assert "installed successfully" in proc.stdout


def test_real_prepare_failure_still_aborts_the_tail(tmp_path):
    proc, bindir, _ = _run_install_sh_tail(tmp_path, prepare_exit_code=1)
    assert proc.returncode == 1
    assert "FAIL:" in proc.stderr
    assert not (bindir / "xinas-menu").exists()
    assert "installed successfully" not in proc.stdout
