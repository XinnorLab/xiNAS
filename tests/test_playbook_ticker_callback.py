"""Regression test for the bash installer's playbook status ticker.

Root cause this guards against: ``lib/menu_lib.sh``'s ``_xinas_playbook_ticker``
only renders ansible's *default* stdout callback ("PLAY [...]" / "TASK [...]")
banners. ``ansible.cfg`` pins ``stdout_callback = minimal`` (compact logs for the
unattended install path), whose output contains none of those tokens, so the
ticker swallows 100% of it and the operator sees a blank screen ("status is not
shown"). The fix forces ``ANSIBLE_STDOUT_CALLBACK=default`` on the interactive
(TTY) branch of ``xinas_run_playbook``, mirroring what the Python TUI already
does in ``xinas_menu/screens/startup/playbook_screen.py``.

These tests stub ``ansible-playbook`` so they need neither real ansible nor a
configured host. The interactive case runs the real function under a pseudo-tty
so ``[ -t 1 ]`` is true and the ticker branch executes.
"""

import os
import pty
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MENU_LIB = REPO_ROOT / "lib" / "menu_lib.sh"

# A stub ansible-playbook that mimics the two callback formats. When
# ANSIBLE_STDOUT_CALLBACK=default it prints PLAY/TASK banners (what the ticker
# parses); otherwise it prints minimal-callback per-host lines (no banners).
STUB_ANSIBLE = textwrap.dedent(
    """\
    #!/usr/bin/env bash
    if [ "${ANSIBLE_STDOUT_CALLBACK:-}" = "default" ]; then
        printf 'PLAY [all] %s\\n' '****************************'
        printf 'TASK [common : install packages] %s\\n' '*******************'
        printf 'ok: [localhost]\\n'
        printf 'PLAY RECAP %s\\n' '*********************************'
        printf 'localhost : ok=1 changed=0 unreachable=0 failed=0\\n'
    else
        # minimal callback: per-host result lines only, no PLAY/TASK/RECAP
        printf 'localhost | SUCCESS => {\\n    "changed": false\\n}\\n'
    fi
    exit 0
    """
)


def _run_ticker_under_pty(bin_dir: Path, log_path: Path) -> str:
    """Source menu_lib.sh and run xinas_run_playbook on a real pty.

    Returns everything the function wrote to the terminal (the ticker output).
    """
    script = textwrap.dedent(
        f"""\
        set -euo pipefail
        export PATH="{bin_dir}:$PATH"
        source "{MENU_LIB}"
        # The ticker writes to stdout, which on a pty is the terminal we capture.
        xinas_run_playbook site.yml -i inventory
        """
    )
    # Run bash connected to a pty so `[ -t 1 ]` is true inside the function.
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["bash", "-c", script],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        while True:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
    finally:
        os.close(master)
        proc.wait(timeout=30)
    return output.decode("utf-8", "replace")


def test_ticker_shows_task_status_with_default_callback(tmp_path):
    """The interactive ticker path must force the default callback so the
    operator sees a live "TASK [...]" status line (regression for the blank
    "status is not shown" screen caused by ansible.cfg's minimal callback)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "ansible-playbook"
    stub.write_text(STUB_ANSIBLE)
    stub.chmod(0o755)

    term_output = _run_ticker_under_pty(bin_dir, tmp_path / "install.log")

    # If xinas_run_playbook forces ANSIBLE_STDOUT_CALLBACK=default, the stub
    # emits banners and the ticker renders the task name. If the override is
    # missing, the stub honors the inherited (minimal) callback, emits no
    # banners, and the ticker output is empty -> this assertion fails.
    assert "TASK [common : install packages]" in term_output, (
        "ticker produced no TASK status line; the interactive path is not "
        "forcing ANSIBLE_STDOUT_CALLBACK=default (see lib/menu_lib.sh "
        "xinas_run_playbook).\n--- terminal output ---\n" + repr(term_output)
    )


def test_menu_lib_forces_default_callback_on_tty_branch():
    """Static guard: the TTY branch of xinas_run_playbook pins the default
    stdout callback. Cheap check that survives even if the pty test is skipped
    in a constrained CI environment."""
    body = MENU_LIB.read_text()
    assert "ANSIBLE_STDOUT_CALLBACK=default ansible-playbook" in body, (
        "lib/menu_lib.sh no longer forces the default stdout callback on the "
        "interactive ticker path; the status ticker will go blank under "
        "ansible.cfg's stdout_callback=minimal."
    )
