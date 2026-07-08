"""Contract guard (#254) for the xinas-agent systemd unit's writable-paths
sandbox.

The task runner's ``snapshot_before`` / ``snapshot_after`` steps shell out to
``xinas_history snapshot create``, which writes
``/var/lib/xinas/config-history``. If that path is not in ``ReadWritePaths``
the write hits EROFS, ``snapshot_before`` throws, and every apply wedges.
Conversely ``/var/lib/xinas/state`` must stay read-only — per ADR-0002 the api
is the sole SQLite writer.

Validated as unit-file text (no systemd on the test host), mirroring
``test_nfs_helper_unit.py``.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UNIT = REPO_ROOT / "xiNAS-MCP" / "xinas-agent.service"


def _read_write_paths() -> str:
    """Joined text of every ``ReadWritePaths=`` directive (comments excluded:
    comment lines start with ``#``, not ``ReadWritePaths=``)."""
    return " ".join(ln for ln in UNIT.read_text().splitlines() if ln.startswith("ReadWritePaths="))


def test_unit_file_exists():
    assert UNIT.is_file(), UNIT


def test_config_history_is_writable():
    # Without this the agent cannot capture snapshots and every apply hangs.
    assert "/var/lib/xinas/config-history" in _read_write_paths()


def test_state_dir_stays_read_only():
    # ADR-0002: the api is the sole SQLite writer; the agent must NOT be granted
    # write access to /var/lib/xinas/state.
    assert "/var/lib/xinas/state" not in _read_write_paths()
