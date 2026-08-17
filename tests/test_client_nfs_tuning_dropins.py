"""`Install NFS Tools` must write its tuning drop-ins on every path.

docs/Client/client-setup-spec.md §2.2: after ``install_nfs_tools`` returns,
``/etc/modprobe.d/nfsclient.conf`` and ``/etc/sysctl.d/90-nfs-client.conf``
exist — *including* the path where ``mount.nfs4`` was already on the host.

The regression this guards: ``install_nfs_tools`` used to ``return 0`` on a
"NFS already installed" early-exit that sat above both ``cat >`` blocks, so on
an image that ships ``nfs-common`` the drop-ins were never created. The health
report then WARNs on ``NFS Client > sysctl_conf`` and tells the user to run
``Install NFS Tools``, which reports "Already Installed" and does nothing — a
loop with no exit.

The functions are pulled live out of ``client_repo/client_setup.sh`` (not
hand-copied) so a regression in the real script cannot leave these passing for
the wrong reason — same approach as tests/test_bash_checkout_force_parity.py.
"""

import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLIENT_SETUP = REPO / "client_repo" / "client_setup.sh"

MODPROBE_REL = "modprobe.d/nfsclient.conf"
SYSCTL_REL = "sysctl.d/90-nfs-client.conf"

# Functions lifted from the real script into the harness. Only the entry
# point is required — the helper it delegates to is optional so that these
# tests fail on *behavior* (drop-ins absent) rather than on a missing symbol.
_REQUIRED = ("install_nfs_tools",)
_OPTIONAL = ("nfs_client_tuning_missing", "apply_nfs_client_tuning")


def _extract(name: str, *, required: bool) -> str:
    src = CLIENT_SETUP.read_text()
    m = re.search(rf"^{re.escape(name)}\(\) \{{\n.*?\n\}}\n", src, re.M | re.S)
    if m is None:
        assert not required, f"{name}() definition not found in client_repo/client_setup.sh"
        return ""
    return m.group(0)


def _function_bodies() -> str:
    parts = [_extract(n, required=False) for n in _OPTIONAL]
    parts += [_extract(n, required=True) for n in _REQUIRED]
    return "\n".join(p for p in parts if p)


def _harness(tmp_path, *, nfs_installed: bool, answer_yes: bool = True) -> Path:
    """Build a runnable sandbox around the extracted functions.

    Everything the functions touch that is not the drop-ins themselves is
    stubbed: the dialog helpers, the op_status frame, the package managers,
    ``enable_nfs_rdma``, and ``sysctl``. Calls are appended to log files so the
    assertions can check what ran.
    """
    etc = tmp_path / "etc"
    (etc / "modprobe.d").mkdir(parents=True, exist_ok=True)
    (etc / "sysctl.d").mkdir(parents=True, exist_ok=True)

    calls = tmp_path / "calls.log"
    steps = tmp_path / "steps.log"

    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    # `command -v mount.nfs4` is the branch selector; a real file on PATH is
    # the only thing bash's `command -v` will accept.
    if nfs_installed:
        for tool in ("mount.nfs4", "mount.nfs"):
            (stub_bin / tool).write_text("#!/bin/bash\nexit 0\n")
            (stub_bin / tool).chmod(0o755)
    # Package manager: present so install_nfs_tools takes the apt branch, and
    # logged so we can assert it is *not* invoked on the already-installed path.
    for tool in ("apt-get", "sysctl"):
        (stub_bin / tool).write_text(f'#!/bin/bash\necho "{tool} $*" >> "{calls}"\nexit 0\n')
        (stub_bin / tool).chmod(0o755)

    script = tmp_path / "harness.sh"
    body = _function_bodies()
    script.write_text(
        f"""#!/bin/bash
# Same flags as the real client_setup.sh — a helper that returns non-zero
# where the script does not expect it kills the menu under `set -e`, so the
# harness has to run under the same rules to catch that.
set -euo pipefail
export PATH="{stub_bin}:/usr/bin:/bin"

# A helper the real script grew but this harness does not lift would
# otherwise degrade silently into a non-zero "command not found" and send
# install_nfs_tools down the wrong branch. Make it a hard failure.
command_not_found_handle() {{ echo "harness: missing command: $1" >&2; exit 127; }}
NFS_CLIENT_MODPROBE_CONF="{etc}/{MODPROBE_REL}"
NFS_CLIENT_SYSCTL_CONF="{etc}/{SYSCTL_REL}"

msg_box() {{ echo "msg_box: $1" >> "{calls}"; }}
info_box() {{ :; }}
yes_no() {{ echo "yes_no: $1" >> "{calls}"; {"return 0" if answer_yes else "return 1"}; }}
enable_nfs_rdma() {{ echo "enable_nfs_rdma" >> "{calls}"; return 0; }}
op_start() {{ echo "op_start: $1" >> "{steps}"; }}
op_step() {{ echo "op_step: $1 rc=${{2:-0}}" >> "{steps}"; }}
op_run() {{ local n="$1"; shift; "$@" >/dev/null 2>&1; local ec=$?; \
echo "op_run: $n rc=$ec" >> "{steps}"; return $ec; }}
op_verify() {{ local d="$1"; shift; "$@" >/dev/null 2>&1; local ec=$?; \
echo "op_verify: $d rc=$ec" >> "{steps}"; return $ec; }}
op_end() {{ echo "op_end: ${{2:-}}" >> "{steps}"; return 0; }}

{body}

install_nfs_tools
"""
    )
    script.chmod(0o755)
    return script


def _run(script: Path) -> subprocess.CompletedProcess:
    proc = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, f"harness failed:\n{proc.stdout}\n{proc.stderr}"
    return proc


def _log(tmp_path: Path, name: str) -> str:
    p = tmp_path / name
    return p.read_text() if p.exists() else ""


@pytest.fixture()
def etc(tmp_path):
    return tmp_path / "etc"


def test_dropins_written_when_nfs_already_installed(tmp_path, etc):
    """The reported bug: nfs-common preinstalled, drop-ins never created."""
    script = _harness(tmp_path, nfs_installed=True)
    _run(script)

    sysctl_conf = etc / SYSCTL_REL
    modprobe_conf = etc / MODPROBE_REL
    assert sysctl_conf.exists(), (
        "install_nfs_tools returned without creating 90-nfs-client.conf on a host "
        "that already had mount.nfs4 — the health report's fix hint is a dead end"
    )
    assert modprobe_conf.exists(), "modprobe drop-in missing on the already-installed path"

    # Content is the contract the health report checks against.
    sysctl_text = sysctl_conf.read_text()
    assert "net.core.rmem_max" in sysctl_text
    assert "net.core.wmem_max" in sysctl_text
    assert "vm.swappiness" in sysctl_text

    modprobe_text = modprobe_conf.read_text()
    for param in (
        "max_session_slots",
        "max_session_cb_slots",
        "nfs4_disable_idmapping",
        "delay_retrans",
        "enable_ino64",
    ):
        assert param in modprobe_text, f"modprobe drop-in missing {param}"

    # No package install on this path, and RDMA wiring still runs.
    calls = _log(tmp_path, "calls.log")
    assert "apt-get" not in calls, "already-installed path must not run the package manager"
    assert "enable_nfs_rdma" in calls


def test_sysctl_reloaded_when_sysctl_dropin_created(tmp_path):
    script = _harness(tmp_path, nfs_installed=True)
    _run(script)
    steps = _log(tmp_path, "steps.log")
    assert "sysctl --system" in steps or "sysctl" in _log(tmp_path, "calls.log"), (
        "a newly created 90-nfs-client.conf must be applied with `sysctl --system`"
    )


def test_existing_dropins_are_not_overwritten(tmp_path, etc):
    """Spec §2.3: a drop-in that already exists is admin-owned."""
    (etc / "modprobe.d").mkdir(parents=True)
    (etc / "sysctl.d").mkdir(parents=True)
    (etc / MODPROBE_REL).write_text("options nfs max_session_slots=64\n")
    (etc / SYSCTL_REL).write_text("vm.swappiness = 1\n")

    script = _harness(tmp_path, nfs_installed=True)
    _run(script)

    assert (etc / MODPROBE_REL).read_text() == "options nfs max_session_slots=64\n"
    assert (etc / SYSCTL_REL).read_text() == "vm.swappiness = 1\n"

    # Spec §2.4: nothing was created, so no host-wide sysctl reload.
    assert "sysctl" not in _log(tmp_path, "calls.log"), (
        "sysctl --system must not run when no drop-in was created"
    )


def test_fresh_install_path_still_writes_dropins(tmp_path, etc):
    script = _harness(tmp_path, nfs_installed=False, answer_yes=True)
    _run(script)

    assert (etc / SYSCTL_REL).exists()
    assert (etc / MODPROBE_REL).exists()
    calls = _log(tmp_path, "calls.log")
    assert "apt-get" in calls, "fresh-install path must still install the package"


def test_declined_install_writes_nothing(tmp_path, etc):
    """Declining the install prompt leaves the host untouched."""
    script = _harness(tmp_path, nfs_installed=False, answer_yes=False)
    _run(script)

    assert not (etc / SYSCTL_REL).exists()
    assert not (etc / MODPROBE_REL).exists()
