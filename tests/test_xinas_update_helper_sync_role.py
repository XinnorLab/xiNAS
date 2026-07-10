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
        ln.strip()
        for ln in SUDOERS.read_text().splitlines()
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
        t.get("ansible.builtin.copy", {})
        for t in tasks
        if isinstance(t.get("ansible.builtin.copy"), dict)
    ]
    dests = {c.get("dest") for c in copy_tasks}
    assert "/usr/local/sbin/xinas-update-helper-sync" in dests
    installed = next(
        c for c in copy_tasks if c.get("dest") == "/usr/local/sbin/xinas-update-helper-sync"
    )
    assert installed.get("mode") == "0755"
    assert installed.get("src") == "xinas-update-helper-sync"
    # Ownership is the single highest-severity property: a non-root-owned or
    # group/world-writable wrapper under a NOPASSWD sudo grant lets the
    # unprivileged xinnor user rewrite the very script it runs as root.
    assert installed.get("owner") == "root"
    assert installed.get("group") == "root"
