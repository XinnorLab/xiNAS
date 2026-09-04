"""install.sh: warn a direct root login that root SSH password access closes.

Step 1b writes ``/etc/ssh/sshd_config.d/10-xinas-root-access.conf`` with
``PermitRootLogin prohibit-password``. Drop-ins are included at the top of
``sshd_config`` and sshd keeps the first value it obtains, so that pins root
SSH to key-only even on a host whose main config says ``PermitRootLogin yes``.
The operator who loses something by it is the one logged in as root with a
password — recognisable by an empty ``SUDO_USER`` — so the notice has to reach
them while that session is still open. See docs/Installer/spec.md section 2.10.

The tests run the real notice block extracted live from install.sh, against a
stubbed ``sshd -T``.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO / "install.sh"

_BLOCK_RE = re.compile(
    r"^# ── Root SSH password notice ─+\n.*?^# ── end root SSH password notice ─+\n",
    re.M | re.S,
)

_PRELUDE = """
set -e
RED=""; GREEN=""; YELLOW=""; CYAN=""; WHITE=""; DIM=""; BOLD=""; NC=""
ok()   { echo "OK: $*"; }
info() { echo "INFO: $*"; }
warn() { echo "WARN: $*"; }
_sshd_dropin="/etc/ssh/sshd_config.d/10-xinas-root-access.conf"
"""


def _notice_block() -> str:
    m = _BLOCK_RE.search(INSTALL_SH.read_text())
    assert m, "install.sh: no root-SSH-password-notice block"
    return m.group(0)


def _run(
    tmp_path: Path,
    *,
    sudo_user: str | None,
    permitrootlogin: str | None,
    authorized_keys: str | None,
) -> str:
    """Run the notice block with a stubbed `sshd -T` and root key file."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    if permitrootlogin is None:
        # sshd absent or unable to dump its config: no output, nonzero exit.
        (bin_dir / "sshd").write_text("#!/bin/bash\nexit 1\n")
    else:
        (bin_dir / "sshd").write_text(
            f"#!/bin/bash\nprintf 'port 22\\npermitrootlogin {permitrootlogin}\\n'\n"
        )
    (bin_dir / "sshd").chmod(0o755)
    (bin_dir / "hostname").write_text("#!/bin/bash\necho nas01\n")
    (bin_dir / "hostname").chmod(0o755)

    keys = tmp_path / "authorized_keys"
    if authorized_keys is not None:
        keys.write_text(authorized_keys)

    block = _notice_block().replace("/root/.ssh/authorized_keys", str(keys))

    env = {"PATH": f"{bin_dir}:/usr/bin:/bin:/usr/sbin:/sbin"}
    if sudo_user is not None:
        env["SUDO_USER"] = sudo_user

    proc = subprocess.run(
        ["bash", "-c", _PRELUDE + block],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def test_direct_root_login_is_warned_password_access_closes(tmp_path: Path) -> None:
    out = _run(tmp_path, sudo_user=None, permitrootlogin="yes", authorized_keys=None)
    assert "root" in out.lower()
    assert "password" in out.lower()
    assert "PermitRootLogin prohibit-password" in out
    assert "key only" in out


def test_sudo_run_is_not_warned(tmp_path: Path) -> None:
    out = _run(tmp_path, sudo_user="ops", permitrootlogin="yes", authorized_keys=None)
    assert out.strip() == ""


def test_no_root_key_gets_the_recovery_command(tmp_path: Path) -> None:
    out = _run(tmp_path, sudo_user=None, permitrootlogin="yes", authorized_keys=None)
    assert "ssh-copy-id root@nas01" in out


def test_existing_root_key_is_reported_instead_of_the_recovery_command(
    tmp_path: Path,
) -> None:
    out = _run(
        tmp_path,
        sudo_user=None,
        permitrootlogin="yes",
        authorized_keys="ssh-ed25519 AAAA... ops@workstation\n",
    )
    assert "ssh-copy-id" not in out
    assert "key-based login keeps working" in out


def test_already_key_only_host_is_not_told_password_login_works_today(
    tmp_path: Path,
) -> None:
    """A re-run, or a stock cloud image: nothing changes, so claim nothing."""
    out = _run(
        tmp_path,
        sudo_user=None,
        permitrootlogin="prohibit-password",
        authorized_keys=None,
    )
    assert "accepts root SSH login with a password today" not in out
    assert "already has PermitRootLogin prohibit-password" in out
    assert "PermitRootLogin prohibit-password" in out


def test_unreadable_sshd_config_still_warns_and_does_not_abort(tmp_path: Path) -> None:
    """`sshd -T` failing must not take the installer down with errexit."""
    out = _run(tmp_path, sudo_user=None, permitrootlogin=None, authorized_keys=None)
    assert "PermitRootLogin prohibit-password" in out
    assert "already has PermitRootLogin" not in out
