"""Esc in a `configure_*.sh` sub-dialog must return to the calling menu,
never kill the whole configuration tool.

`lib/menu_lib.sh`'s `menu_select` and `input_box` return 1 when the operator
presses Esc, and every one of these editors advertises that in its own
footer ("Esc Cancel"). The editors consume that with

    value=$(input_box ...) || return

A *bare* `return` returns the exit status of the last command run — here the
failed command substitution, i.e. 1. Each of these functions is invoked as a
plain simple command from a top-level `case` branch, so under `set -e` /
`set -euo pipefail` that 1 propagates out of the `case`, out of the `while`
loop, and terminates the process: the operator opens a sub-dialog, presses
Esc, and the whole editor vanishes with no output and no diagnostic.

The tests below run the real scripts against a stubbed `lib/menu_lib.sh` and
stubbed `ip`/`lsblk`/`findmnt` — but the REAL `lib/xinas_config.sh` and the
REAL `yq` binary, the same technique tests/test_preset_overlay.py already
uses. These editors now source `lib/xinas_config.sh` for their reads and
writes (`xinas_config_effective`/`_get`/`_set`/`_seed_local`, all real yq
merges over real files), so a hand-written fake of that library would drift
from the real one and rot into a test that passes while the product breaks.
They script an Esc, and assert the editor is still alive afterwards — the
menu is re-entered and the operator's own "Back" choice is what ends the
process.

Contract: docs/Installer/spec.md 2.8.
"""

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]


def _find_bash4() -> str | None:
    """The editors use `mapfile`/`readarray`/`declare -A` (bash 4+).

    macOS ships bash 3.2, so a dev box may have nothing suitable; CI runs on
    Ubuntu where /bin/bash is 5.x.
    """
    candidates = [
        shutil.which("bash"),
        "/opt/homebrew/bin/bash",
        "/usr/local/bin/bash",
    ]
    for cand in candidates:
        if not cand or not os.access(cand, os.X_OK):
            continue
        proc = subprocess.run(
            [cand, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True
        )
        major = proc.stdout.strip()
        if proc.returncode == 0 and major.isdigit() and int(major) >= 4:
            return cand
    return None


BASH4 = _find_bash4()

pytestmark = pytest.mark.skipif(
    BASH4 is None,
    reason="the configure_*.sh editors need bash >= 4 (mapfile/readarray/declare -A)",
)


# --------------------------------------------------------------------------
# Test doubles
# --------------------------------------------------------------------------

# Answers are read from $XINAS_TEST_QUEUE, one directive per line, consumed in
# order across every primitive:
#     OK <value>   -> the primitive succeeds and prints <value>
#     CANCEL       -> the primitive returns 1, exactly as Esc does
# Every call is appended to $XINAS_TEST_LOG, so a test can prove the script
# came back to the menu rather than dying mid-dialog. A queue that runs dry
# yields CANCEL, which keeps a broken script from looping forever.
MENU_LIB_STUB = r"""
CYAN=''; NC=''; DIM=''; WHITE=''; YELLOW=''; GREEN=''; REVERSE=''

_xinas_test_take() {
    local idx line
    idx=$(cat "$XINAS_TEST_IDX")
    idx=$((idx + 1))
    printf '%s' "$idx" > "$XINAS_TEST_IDX"
    line=$(sed -n "${idx}p" "$XINAS_TEST_QUEUE")
    printf '%s' "$line"
}

_xinas_test_answer() {
    local kind="$1" title="$2" directive
    directive=$(_xinas_test_take)
    printf '%s|%s|%s\n' "$kind" "$title" "$directive" >> "$XINAS_TEST_LOG"
    case "$directive" in
        "OK "*) printf '%s\n' "${directive#OK }" ;;
        *) return 1 ;;
    esac
}

menu_select() { _xinas_test_answer menu_select "$1"; }
input_box() { _xinas_test_answer input_box "$1"; }
msg_box() { printf 'msg_box|%s|\n' "$1" >> "$XINAS_TEST_LOG"; }
text_box() { printf 'text_box|%s|\n' "$1" >> "$XINAS_TEST_LOG"; }
"""

# No yq stub: all three editors now `source lib/xinas_config.sh`, which itself
# shells out to yq for every read and write (xinas_config_effective/_get/_set/
# _seed_local). A fake yq that merely echoes a canned string back (the
# previous design here, before lib/xinas_config.sh existed) cannot perform a
# real multi-layer YAML merge, so xinas_config_effective would silently
# return garbage instead of the merged document. The sandbox instead runs
# against the REAL yq binary already on PATH plus real, minimal YAML fixtures
# (see _raid_sandbox/_nfs_sandbox below and the per-test setup in the
# network tests) — same approach as tests/test_preset_overlay.py.

IP_STUB = r"""#!/usr/bin/env bash
case "$*" in
    *"link show"*) printf '1: lo: <LOOPBACK,UP>\n2: eth0: <BROADCAST,UP>\n' ;;
    *) printf '2: eth0    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\n' ;;
esac
exit 0
"""

LSBLK_STUB = """#!/usr/bin/env bash
printf 'NAME VENDOR MODEL SIZE\\nnvme0n1 - FAKE 1T\\n'
exit 0
"""

FINDMNT_STUB = """#!/usr/bin/env bash
printf '/dev/sda1\\n'
exit 0
"""


def _sandbox(tmp_path: Path, script: str) -> Path:
    """Copy one real editor into an isolated tree with stubbed dependencies."""
    root = tmp_path / "sandbox"
    (root / "lib").mkdir(parents=True)
    (root / "bin").mkdir()

    shutil.copy(REPO / script, root / script)
    (root / "lib" / "menu_lib.sh").write_text(MENU_LIB_STUB)
    # The real helper, not a stub -- see the module docstring and the "No yq
    # stub" note above. lib/xinas_config.sh computes REPO_DIR from its own
    # BASH_SOURCE when not already set, so copying it under `root/lib/`
    # (alongside the copied editor) makes REPO_DIR resolve to `root` with no
    # override needed, exactly like the editor's own
    # `source "$SCRIPT_DIR/lib/xinas_config.sh"` expects.
    shutil.copy(REPO / "lib/xinas_config.sh", root / "lib" / "xinas_config.sh")

    for name, body in (
        ("ip", IP_STUB),
        ("lsblk", LSBLK_STUB),
        ("findmnt", FINDMNT_STUB),
    ):
        stub = root / "bin" / name
        stub.write_text(body)
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    return root


def _run(root: Path, script: str, queue: list[str]) -> tuple[int, list[str]]:
    """Drive one editor through `queue` and return (exit status, call log)."""
    (root / "queue").write_text("\n".join(queue) + "\n")
    (root / "idx").write_text("0")
    log = root / "log"
    log.write_text("")

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{root / 'bin'}{os.pathsep}{env['PATH']}",
            "XINAS_TEST_QUEUE": str(root / "queue"),
            "XINAS_TEST_IDX": str(root / "idx"),
            "XINAS_TEST_LOG": str(log),
            "TMP_DIR": str(root / "tmp"),
            # These editors call `clear` before drawing each menu; with no TERM
            # it exits nonzero and errexit would kill the script for a reason
            # that has nothing to do with what is under test.
            "TERM": "xterm",
        }
    )

    assert BASH4 is not None
    proc = subprocess.run(
        [BASH4, str(root / script)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    entries = [line for line in log.read_text().splitlines() if line]
    if proc.returncode != 0:
        entries.append(f"stderr|{proc.stderr.strip()[-400:]}|")
    return proc.returncode, entries


def _prompts(entries: list[str]) -> list[str]:
    """Just the interactive prompts, in order: 'menu_select|<title>' etc."""
    return [
        "|".join(e.split("|")[:2]) for e in entries if e.startswith(("menu_select|", "input_box|"))
    ]


# --------------------------------------------------------------------------
# configure_network.sh
# --------------------------------------------------------------------------


def test_network_ip_pool_esc_returns_to_menu(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    # Open "Configure IP Pool", press Esc at the start-address prompt, then
    # deliberately leave via "Back".
    rc, entries = _run(root, "configure_network.sh", ["OK 1", "CANCEL", "OK 4"])

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|Network Configuration",
        "input_box|IP Pool - Start Address",
        "menu_select|Network Configuration",
    ]


def test_network_ip_pool_esc_saves_nothing(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    defaults = root / "collection/roles/net_controllers/defaults/main.yml"
    rc, entries = _run(root, "configure_network.sh", ["OK 1", "CANCEL", "OK 4"])

    assert rc == 0
    # save_pool_settings() writes this file with a heredoc. Cancelling the
    # first prompt must not fall through to it with an unset new_start.
    assert not defaults.exists(), "Esc must not write pool settings"


def test_network_ip_pool_esc_at_prefix_prompt_returns_to_menu(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    defaults = root / "collection/roles/net_controllers/defaults/main.yml"
    # Answer the first two prompts, then Esc at the third.
    rc, entries = _run(
        root,
        "configure_network.sh",
        ["OK 1", "OK 10.10.1.1", "OK 10.10.255.1", "CANCEL", "OK 4"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries)[-1] == "menu_select|Network Configuration"
    assert not defaults.exists(), "Esc must not write pool settings"


def test_network_manual_esc_returns_to_menu(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    rc, entries = _run(root, "configure_network.sh", ["OK 2", "CANCEL", "OK 4"])

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|Network Configuration",
        "menu_select|Select Interface",
        "menu_select|Network Configuration",
    ]


def test_network_manual_esc_restores_pool_mode(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    defaults = root / "collection/roles/net_controllers/defaults/main.yml"
    defaults.parent.mkdir(parents=True)
    defaults.write_text("---\nnet_ip_pool_enabled: true\n")
    template = root / "collection/roles/net_controllers/templates/netplan.yaml.j2"
    template.parent.mkdir(parents=True)
    template.write_text("ORIGINAL\n")

    rc, entries = _run(root, "configure_network.sh", ["OK 2", "CANCEL", "OK 4"])

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    # configure_manual() disables pool mode up front. Abandoning the interface
    # picker must undo that, or the box is left with pool mode off and an
    # untouched template -- every NIC stranded without an address. Checked
    # against the real overlay file enable_pool_mode() (via the real
    # xinas_config_set) actually wrote, not a fake yq's call log.
    local_layer = yaml.safe_load((root / "playbooks/group_vars/all/20-local.yml").read_text())
    assert local_layer.get("net_ip_pool_enabled") is True, (
        f"pool mode was not restored after Esc; local layer={local_layer}"
    )
    assert template.read_text() == "ORIGINAL\n", "Esc must not rewrite the template"


def test_network_manual_esc_discards_staged_interfaces(tmp_path):
    root = _sandbox(tmp_path, "configure_network.sh")
    defaults = root / "collection/roles/net_controllers/defaults/main.yml"
    defaults.parent.mkdir(parents=True)
    defaults.write_text("---\nnet_ip_pool_enabled: true\n")
    template = root / "collection/roles/net_controllers/templates/netplan.yaml.j2"
    template.parent.mkdir(parents=True)
    template.write_text("ORIGINAL\n")

    # Stage an address for eth0, come back to the picker, then Esc. The menu
    # offers an explicit "Finish" to commit, so Esc means discard -- not
    # "commit whatever happens to be staged".
    rc, entries = _run(
        root,
        "configure_network.sh",
        ["OK 2", "OK eth0", "OK 192.0.2.5/24", "CANCEL", "OK 4"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert template.read_text() == "ORIGINAL\n", (
        "Esc after staging an address must not rewrite the netplan template"
    )
    # Real overlay file, not a fake yq's call log -- see the sibling test
    # above (test_network_manual_esc_restores_pool_mode) for why.
    local_layer = yaml.safe_load((root / "playbooks/group_vars/all/20-local.yml").read_text())
    assert local_layer.get("net_ip_pool_enabled") is True, (
        f"pool mode was not restored after Esc; local layer={local_layer}"
    )


# --------------------------------------------------------------------------
# configure_raid.sh
# --------------------------------------------------------------------------


def _raid_sandbox(tmp_path: Path) -> Path:
    root = _sandbox(tmp_path, "configure_raid.sh")
    vars_file = root / "collection/roles/raid_fs/defaults/main.yml"
    vars_file.parent.mkdir(parents=True)
    # edit_devices() bails out to a "Not Defined" msg_box (never reaching
    # input_box) when get_devices() comes back empty -- real yq against an
    # empty xiraid_arrays: [] would do exactly that, so the DATA (level 6)
    # array needs real devices for the Esc prompt to ever appear.
    vars_file.write_text(
        "---\n"
        "xiraid_arrays:\n"
        "  - name: data1\n"
        "    level: 6\n"
        "    devices: [/dev/nvme0n1, /dev/nvme1n1]\n"
        "  - name: log1\n"
        "    level: 1\n"
        "    devices: [/dev/nvme2n1]\n"
    )
    return root


def test_raid_edit_devices_esc_returns_to_menu(tmp_path):
    root = _raid_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_raid.sh",
        ["OK 1", "CANCEL", "OK 6"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|RAID Configuration",
        "input_box|DATA Array",
        "menu_select|RAID Configuration",
    ]


def test_raid_spare_pool_esc_returns_to_menu(tmp_path):
    root = _raid_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_raid.sh",
        ["OK 3", "CANCEL", "OK 6"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|RAID Configuration",
        "input_box|Spare Pool",
        "menu_select|RAID Configuration",
    ]


def test_raid_edit_devices_esc_leaves_vars_file_untouched(tmp_path):
    root = _raid_sandbox(tmp_path)
    vars_file = root / "collection/roles/raid_fs/defaults/main.yml"
    before = vars_file.read_text()
    rc, _ = _run(
        root,
        "configure_raid.sh",
        ["OK 1", "CANCEL", "OK 6"],
    )

    assert rc == 0
    assert vars_file.read_text() == before, "Esc must not rewrite the RAID vars file"


# --------------------------------------------------------------------------
# configure_nfs_exports.sh
# --------------------------------------------------------------------------


def _nfs_sandbox(tmp_path: Path) -> Path:
    root = _sandbox(tmp_path, "configure_nfs_exports.sh")
    vars_file = root / "collection/roles/exports/defaults/main.yml"
    vars_file.parent.mkdir(parents=True)
    vars_file.write_text("---\nexports: []\n")
    return root


def test_nfs_edit_export_esc_returns_to_menu(tmp_path):
    root = _nfs_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_nfs_exports.sh",
        ["OK /mnt/data/share", "CANCEL", "OK Back"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|NFS Exports",
        "input_box|Edit Export",
        "menu_select|NFS Exports",
    ]


def test_nfs_edit_export_esc_at_options_prompt_returns_to_menu(tmp_path):
    root = _nfs_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_nfs_exports.sh",
        ["OK /mnt/data/share", "OK *", "CANCEL", "OK Back"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries)[-1] == "menu_select|NFS Exports"


def test_nfs_add_export_esc_returns_to_menu(tmp_path):
    root = _nfs_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_nfs_exports.sh",
        ["OK Add", "CANCEL", "OK Back"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries) == [
        "menu_select|NFS Exports",
        "input_box|Add Export",
        "menu_select|NFS Exports",
    ]


def test_nfs_add_export_esc_at_options_prompt_returns_to_menu(tmp_path):
    root = _nfs_sandbox(tmp_path)
    rc, entries = _run(
        root,
        "configure_nfs_exports.sh",
        ["OK Add", "OK /mnt/data/new", "OK *", "CANCEL", "OK Back"],
    )

    assert rc == 0, f"editor died after Esc (exit {rc}); log={entries}"
    assert _prompts(entries)[-1] == "menu_select|NFS Exports"


# --------------------------------------------------------------------------
# Structural guard
# --------------------------------------------------------------------------


@pytest.mark.parametrize("script", ["configure_raid.sh", "configure_nfs_exports.sh"])
def test_backup_if_changed_survives_a_missing_file(tmp_path, script):
    """Same class, different trigger: `[ -f "$file" ] || return`.

    `backup_if_changed` is called as a plain command from functions that a
    `case` branch dispatches, so a bare `return` here hands `[ -f ]`'s own 1
    to errexit. Today every call site happens to guarantee the file exists,
    which makes this latent rather than live -- one refactor away from the
    Esc bug above.

    configure_network.sh carries the same line but its fix is in flight on
    another branch, so it is deliberately not asserted here.
    """
    body = (REPO / script).read_text()
    fn = re.search(r"^backup_if_changed\(\) \{.*?^\}", body, re.S | re.M)
    assert fn, f"could not extract backup_if_changed() from {script}"

    probe = tmp_path / "probe.sh"
    probe.write_text(
        "set -euo pipefail\n"
        + fn.group(0)
        + "\nbackup_if_changed /nonexistent/file /nonexistent/new\n"
        "echo SURVIVED\n"
    )
    assert BASH4 is not None
    proc = subprocess.run([BASH4, str(probe)], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0 and "SURVIVED" in proc.stdout, (
        f"{script}: backup_if_changed on a missing file killed the caller "
        f"(exit {proc.returncode}); stderr={proc.stderr!r}"
    )


@pytest.mark.parametrize(
    "script",
    ["configure_network.sh", "configure_raid.sh", "configure_nfs_exports.sh"],
)
def test_no_bare_return_after_cancellable_prompt(script):
    """`|| return` with no explicit status re-raises the prompt's own failure.

    The status must be spelled out (`return 0`) or the cancellation handled
    with `break`, so errexit never sees a nonzero status escape the `case`
    branch that dispatched the dialog.
    """
    offenders = [
        f"{script}:{n}: {line.strip()}"
        for n, line in enumerate((REPO / script).read_text().splitlines(), 1)
        if ("input_box" in line or "menu_select" in line) and line.rstrip().endswith("|| return")
    ]
    assert not offenders, "bare `|| return` after a cancellable prompt:\n" + "\n".join(offenders)
