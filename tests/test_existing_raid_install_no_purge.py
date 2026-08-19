"""Regression: startup_menu.sh's "Existing RAID Installation" path purged
xiRAID before running the playbook with xiraid_skip_install=true.

playbooks/site.yml:10 guards xiraid_classic with
`when: not (xiraid_skip_install | default(false) | bool)`. Before this
branch existed, apply_preset("default") copied a preset playbook.yml - which
carried no such guard - over site.yml, so the guard was inert and
xiraid_classic always reinstalled whatever check_remove_xiraid had just
purged: purge-then-reinstall, ugly but it worked (final review, Critical 1).
Once preset application stopped overwriting site.yml, the guard went live,
and install_menu()'s existing-RAID branch (case "3") still called
check_remove_xiraid two lines before running with xiraid_skip_install=true -
xiRAID gets purged and the guard now skips reinstalling it, so xicli and
/dev/xi_data, /dev/xi_log are gone before raid_fs ever runs.
autoinstall.sh:140-142 already encodes the correct rule for this exact
scenario (`existing_raid` => purge_xiraid="no", the whole purge block
skipped); this pins install_menu()'s interactive branch to the same rule.

install_menu() reads dialogs through menu_lib.sh's TUI primitives
(menu_select/yes_no/msg_box), which read/write /dev/tty directly and cannot
be driven headlessly - the same constraint documented at the top of the
Task 5 section of tests/test_preset_overlay.py. The real function is
extracted by regex and run verbatim with only those primitives (plus the
license/playbook-running calls it makes) stubbed, so this exercises
install_menu()'s own code path rather than a re-implementation of it.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STARTUP_MENU = (REPO / "startup_menu.sh").read_text()


def _extract_fn(src: str, name: str) -> str:
    m = re.search(rf"^{re.escape(name)}\(\) \{{.*?^\}}", src, re.M | re.S)
    assert m, f"{name}() not found in source"
    return m.group(0)


def _run_script(script: str, tmp_path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", script], cwd=tmp_path, capture_output=True, text=True, timeout=20
    )


INSTALL_MENU = _extract_fn(STARTUP_MENU, "install_menu")

# Stubs for every dialog/side-effecting call install_menu() makes other than
# check_remove_xiraid, which each test below supplies itself so it can
# observe whether it was invoked. menu_select echoes "3" to choose "Use
# Existing RAID Arrays"; yes_no answers every confirmation "Yes" (rc 0);
# apply_preset/check_license/confirm_playbook are no-ops that succeed;
# run_playbook_with_vars records its own arguments to stderr and fails, so
# install_menu() returns instead of reaching `exit 0`/xinas-status (neither
# of which needs to exist for this test).
COMMON_STUBS = (
    "has_license() { return 0; }\n"
    'menu_select() { echo 3; }\n'
    "yes_no() { return 0; }\n"
    'apply_preset() { echo "APPLY_PRESET:$1" >&2; }\n'
    "check_license() { return 0; }\n"
    "confirm_playbook() { return 0; }\n"
    "msg_box() { :; }\n"
    'run_playbook_with_vars() { echo "RAN_WITH_VARS:$2" >&2; return 1; }\n'
)


def test_existing_raid_install_never_calls_check_remove_xiraid(tmp_path: Path):
    script = (
        "set -euo pipefail\n"
        f"{INSTALL_MENU}\n"
        f"{COMMON_STUBS}"
        'check_remove_xiraid() { echo CALLED_CHECK_REMOVE_XIRAID >&2; return 0; }\n'
        "install_menu\n"
    )
    r = _run_script(script, tmp_path)
    assert r.returncode == 0, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert "CALLED_CHECK_REMOVE_XIRAID" not in r.stderr, (
        "install_menu()'s existing-RAID branch must never purge xiRAID packages: "
        f"stderr={r.stderr!r}"
    )
    # Not a vacuous pass: prove the branch really ran all the way through to
    # the playbook call, carrying the skip-install flag, rather than having
    # bailed out earlier (e.g. on a broken stub) for an unrelated reason -
    # a script that errored out before reaching check_remove_xiraid would
    # also produce an empty stderr match above without fixing anything.
    assert "RAN_WITH_VARS:xiraid_skip_install=true nvme_auto_namespace=false" in r.stderr, (
        f"stdout={r.stdout!r} stderr={r.stderr!r}"
    )
