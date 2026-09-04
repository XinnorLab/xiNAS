"""Regression: the menus purged xiRAID on a run that would not reinstall it.

`playbooks/site.yml` guards `xiraid_classic` with
`when: not (xiraid_skip_install | default(false) | bool)`, and that flag is
sticky — `simple_menu.sh`'s reuse wizard writes it into the operator overlay
`playbooks/group_vars/all/20-local.yml`, where it survives into every later
run. On v3.13.2-rc.4 an operator declined `Reuse Arrays?`, which routes to
`clean_install` → `check_remove_xiraid`; the packages were purged at 12:13:57
and the run that started at 12:18 still carried the stale flag, so nothing
reinstalled them. `xicli` was gone, the storage probe came back `rc=2`/ENOENT,
and the install died in `raid_fs`'s UNKNOWN gate.

Reaching `check_remove_xiraid` at all means this run installs xiRAID itself
(the existing-RAID branches never call it), so the function clears the flag
before it touches a package. Contract: docs/Installer/raid-spec.md §11,
*A purge implies a reinstall*.

`check_remove_xiraid` is duplicated verbatim in both menus; both copies are
extracted by regex and run for real with only their dialog and side-effecting
calls stubbed, in the style of tests/test_existing_raid_install_no_purge.py.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MENUS = ("startup_menu.sh", "simple_menu.sh")

# `${Package} ${Status}` as dpkg-query -W renders it; the caller's awk keys on $4.
INSTALLED = "xiraid-core install ok installed\nxiraid-kmod install ok installed\n"


def _extract_fn(src: str, name: str) -> str:
    m = re.search(rf"^{re.escape(name)}\(\) \{{.*?^\}}", src, re.M | re.S)
    assert m, f"{name}() not found in source"
    return m.group(0)


def _fns(menu: str) -> str:
    src = (REPO / menu).read_text()
    out = [_extract_fn(src, "check_remove_xiraid")]
    # The helper, if the implementation factored one out; a copy that inlines
    # the same logic is just as correct, so its absence is not a failure.
    if re.search(r"^_xinas_clear_skip_install\(\) \{", src, re.M):
        out.append(_extract_fn(src, "_xinas_clear_skip_install"))
    return "\n".join(out)


def _stubs(*, skip_value: str, installed: str) -> str:
    """Stub every call check_remove_xiraid makes.

    Side effects are appended to $CALLS rather than echoed: the real function
    redirects its whole purge pipeline into a log file (`>"$log" 2>&1`), which
    would swallow a stub writing to stdout or stderr. The file keeps call order.
    """
    if skip_value:
        get = (
            'xinas_config_get() { [ "$1" = xiraid_skip_install ] || return 1; '
            f'printf "%s\\n" "{skip_value}"; }}\n'
        )
    else:
        get = "xinas_config_get() { return 1; }\n"
    return (
        get + 'note() { printf "%s\n" "$*" >> "$CALLS"; }\n'
        'xinas_config_set() { note "CONFIG_SET:$1 $2 $3"; }\n'
        'sudo() { note "SUDO:$*"; }\n'
        f'dpkg-query() {{ printf "%s" "{installed}"; }}\n'
        "pkg_status() { echo; }\n"
        "yes_no() { return 0; }\n"
        'msg_box() { note "MSG_BOX:$1"; }\n'
    )


class Run:
    def __init__(self, proc: subprocess.CompletedProcess, calls: list[str]):
        self.stdout = proc.stdout
        self.stderr = proc.stderr
        self.calls = calls

    def index(self, prefix: str) -> int:
        for i, line in enumerate(self.calls):
            if line.startswith(prefix):
                return i
        return -1


def _run(menu: str, tmp_path: Path, *, skip_value: str, installed: str, yes: bool = True) -> Run:
    calls = tmp_path / "calls.log"
    script = (
        "set -uo pipefail\n"
        f"{_fns(menu)}\n"
        f"{_stubs(skip_value=skip_value, installed=installed)}"
        + ("" if yes else "yes_no() { return 1; }\n")
        + "check_remove_xiraid; echo RC=$?\n"
    )
    proc = subprocess.run(
        ["bash", "-c", script],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=20,
        env={**os.environ, "CALLS": str(calls), "TMPDIR": str(tmp_path)},
    )
    return Run(proc, calls.read_text().splitlines() if calls.exists() else [])


@pytest.mark.parametrize("menu", MENUS)
def test_sticky_skip_install_is_cleared_before_anything_is_purged(menu: str, tmp_path: Path):
    r = _run(menu, tmp_path, skip_value="true", installed=INSTALLED)
    assert "RC=0" in r.stdout, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    cleared = r.index("CONFIG_SET:local xiraid_skip_install false")
    assert cleared >= 0, (
        "a purge must clear the sticky xiraid_skip_install, or the run removes xiRAID "
        f"and never puts it back: calls={r.calls}"
    )
    purged = r.index("SUDO:apt-get purge")
    assert purged >= 0, f"the purge itself must still happen: calls={r.calls}"
    assert cleared < purged, f"clear the flag before removing packages: {r.calls}"


@pytest.mark.parametrize("menu", MENUS)
def test_flag_is_cleared_even_when_no_xiraid_packages_are_left(menu: str, tmp_path: Path):
    """The exact rc-4 state: an earlier attempt had already purged xiRAID."""
    r = _run(menu, tmp_path, skip_value="true", installed="")
    assert "RC=0" in r.stdout, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert r.index("CONFIG_SET:local xiraid_skip_install false") >= 0, (
        f"nothing to purge is not nothing to fix: calls={r.calls}"
    )


@pytest.mark.parametrize("menu", MENUS)
def test_declining_the_removal_changes_nothing(menu: str, tmp_path: Path):
    r = _run(menu, tmp_path, skip_value="true", installed=INSTALLED, yes=False)
    assert "RC=1" in r.stdout, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert r.index("CONFIG_SET") < 0, (
        f"declining aborts the run; it must not rewrite the overlay: calls={r.calls}"
    )
    assert r.index("SUDO:apt-get purge") < 0, r.calls


@pytest.mark.parametrize("menu", MENUS)
def test_unset_flag_is_left_alone(menu: str, tmp_path: Path):
    r = _run(menu, tmp_path, skip_value="", installed=INSTALLED)
    assert "RC=0" in r.stdout, f"stdout={r.stdout!r} stderr={r.stderr!r}"
    assert r.index("CONFIG_SET") < 0, (
        f"an unset flag needs no write — do not create one: calls={r.calls}"
    )
    assert r.index("SUDO:apt-get purge") >= 0, r.calls
