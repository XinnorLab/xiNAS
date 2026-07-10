"""Regression guards for the ``doca_ofed`` -> ``net_controllers`` handoff.

On a ConnectX card in InfiniBand mode ``mlx5_core`` creates no netdev; the
``ibN`` interfaces are created by ``ib_ipoib``, which is only loaded when
``openibd`` starts. ``doca_ofed`` restarts ``openibd`` via ``notify:``, and
Ansible defers handlers to the *end of the play* unless they are explicitly
flushed.

``net_controllers`` runs immediately after ``doca_ofed`` and detects
high-speed NICs by scanning ``/sys/class/net``. Without a flush, that scan
runs while the restart is still queued, finds nothing on a host that did not
already have DOCA-OFED installed, and writes the "no high-speed
InfiniBand/mlx5 interfaces were detected" placeholder netplan. The IB ports
then come up with no addresses -- and the install still exits 0.

That failure only reproduces on a genuinely cold node: any reinstall over an
existing OFED already has ``ib_ipoib`` loaded, so the netdevs exist at play
start. These tests pin the ordering contract so it cannot silently regress.

Everything is validated as parsed YAML -- no host, no Ansible run.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
OFED_TASKS = REPO_ROOT / "collection/roles/doca_ofed/tasks/main.yml"
OFED_HANDLERS = REPO_ROOT / "collection/roles/doca_ofed/handlers/main.yml"
PLAYBOOKS = [
    REPO_ROOT / "presets/default/playbook.yml",
    REPO_ROOT / "presets/xinnorVM/playbook.yml",
    REPO_ROOT / "playbooks/site.yml",
]

FLUSH_KEYS = ("meta", "ansible.builtin.meta")


def _tasks() -> list[dict]:
    return yaml.safe_load(OFED_TASKS.read_text()) or []


def _index_of_flush(tasks: list[dict]) -> int:
    for i, task in enumerate(tasks):
        for key in FLUSH_KEYS:
            if task.get(key) == "flush_handlers":
                return i
    return -1


def _index_of_notify(tasks: list[dict], handler: str) -> int:
    for i, task in enumerate(tasks):
        notify = task.get("notify")
        if notify == handler or (isinstance(notify, list) and handler in notify):
            return i
    return -1


def test_openibd_restart_is_still_a_handler() -> None:
    """The premise of this whole module: openibd is notified, not called."""
    handlers = yaml.safe_load(OFED_HANDLERS.read_text()) or []
    names = [h.get("name") for h in handlers]
    assert "Restart openibd" in names, names
    assert _index_of_notify(_tasks(), "Restart openibd") >= 0, (
        "no task notifies 'Restart openibd' -- if the restart became a direct "
        "task, this module's flush_handlers guard is obsolete"
    )


def test_doca_ofed_flushes_handlers() -> None:
    """Without this, ib_ipoib loads at end-of-play, after net_controllers."""
    assert _index_of_flush(_tasks()) >= 0, (
        "doca_ofed must `meta: flush_handlers` so openibd restarts (loading "
        "ib_ipoib, creating the ibN netdevs) before net_controllers scans "
        "/sys/class/net -- otherwise a cold install writes an empty netplan"
    )


def test_flush_comes_after_the_openibd_notify() -> None:
    """A flush before the notify would drain an empty handler queue."""
    tasks = _tasks()
    notify_at = _index_of_notify(tasks, "Restart openibd")
    flush_at = _index_of_flush(tasks)
    assert notify_at >= 0 and flush_at >= 0
    assert flush_at > notify_at, (
        f"flush_handlers at index {flush_at} precedes the 'Restart openibd' "
        f"notify at index {notify_at}; it would flush nothing"
    )


@pytest.mark.parametrize("playbook", PLAYBOOKS, ids=lambda p: p.name)
def test_net_controllers_runs_after_doca_ofed(playbook: Path) -> None:
    """The flush only helps if net_controllers is downstream of the OFED role."""
    if not playbook.exists():
        pytest.skip(f"{playbook} not present")
    plays = yaml.safe_load(playbook.read_text()) or []
    for play in plays:
        names = [
            role["role"] if isinstance(role, dict) else role
            for role in play.get("roles", [])
        ]
        if "doca_ofed" in names and "net_controllers" in names:
            assert names.index("doca_ofed") < names.index("net_controllers"), names
            return
    pytest.skip(f"{playbook.name} does not run both roles in one play")
