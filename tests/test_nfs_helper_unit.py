"""Contract guards for the xinas-nfs-helper systemd unit and lock surface.

Two things this pins (spec: docs/MCP/spec-nfs-helper.md §Systemd Unit,
§File Locking):

1. The unit orders *after* and *requires* the canonical
   ``nfs-kernel-server.service`` (the unit **file** names the canonical unit;
   systemd resolves it to the ``nfs-server.service`` alias at runtime — that
   resolution is expected and is asserted against the file text here, not a
   live ``systemctl`` query).

2. The four lock paths are regular **files** (never directories), and the
   daemon pre-creates all of them at startup so the lock surface is
   deterministic rather than appearing lazily on first use.

The unit is validated as text (no systemd on the test host). The lock tests
point ``precreate_locks`` at a temp dir so the suite never touches ``/run``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UNIT = REPO_ROOT / "xiNAS-MCP/nfs-helper/xinas-nfs-helper.service"

# The nfs-helper package directory has a hyphen, so it is not importable as a
# normal module path — add it to sys.path the way the daemon's siblings do.
_HELPER_DIR = str(REPO_ROOT / "xiNAS-MCP" / "nfs-helper")
if _HELPER_DIR not in sys.path:
    sys.path.insert(0, _HELPER_DIR)

import nfs_helper  # noqa: E402


def _unit_lines(prefix: str) -> list[str]:
    return [ln for ln in UNIT.read_text().splitlines() if ln.startswith(prefix)]


# --- Systemd unit ordering ------------------------------------------------


def test_unit_orders_after_nfs_kernel_server():
    after = _unit_lines("After=")
    assert after, "unit has no After= line"
    assert "nfs-kernel-server.service" in after[0]


def test_unit_requires_nfs_kernel_server():
    requires = _unit_lines("Requires=")
    assert requires, "unit has no Requires= line"
    assert "nfs-kernel-server.service" in requires[0]


# --- Lock surface ---------------------------------------------------------


def test_lock_paths_are_the_four_canonical_run_files():
    assert set(nfs_helper.LOCK_PATHS) == {
        "/run/xinas-exports.lock",
        "/run/xinas-nfs-conf.lock",
        "/run/xinas-nfs-idmap.lock",
        "/run/xinas-nfs-profile.lock",
    }


def test_precreate_locks_creates_missing_lock_files_as_files(tmp_path):
    paths = [
        str(tmp_path / name)
        for name in (
            "xinas-exports.lock",
            "xinas-nfs-conf.lock",
            "xinas-nfs-idmap.lock",
            "xinas-nfs-profile.lock",
        )
    ]
    for p in paths:
        assert not os.path.exists(p)

    nfs_helper.precreate_locks(paths)

    for p in paths:
        assert os.path.isfile(p), f"{p} must be a regular file, not a directory"


def test_precreate_locks_is_idempotent_and_preserves_the_file(tmp_path):
    p = str(tmp_path / "xinas-exports.lock")
    nfs_helper.precreate_locks([p])
    nfs_helper.precreate_locks([p])  # second pass must not raise or clobber
    assert os.path.isfile(p)
