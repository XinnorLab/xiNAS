"""Behavioral guard for boundary-safe data-drive membership (cleanup path).

The cleanup pass must never drag a device on a *protected* disk into
destruction. The historic bug was string-prefix matching: a data controller
`/dev/nvme1` matched `/dev/nvme10n1p3` (an OS partition on controller nvme10)
because `nvme1` is a string prefix of `nvme10`. These tests run the real
`disk_match.sh` helper so the boundary logic is exercised, not just its source.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MATCH = REPO / "collection/roles/nvme_namespace/files/disk_match.sh"


def is_data(dev: str, *, data: str, system: str = "", ctrls: str = "") -> bool:
    """Return True iff disk_match.sh classifies `dev` as a data member."""
    proc = subprocess.run(
        ["bash", str(MATCH), "is-data", dev],
        env={
            "PATH": "/usr/bin:/bin",
            "DATA_DRIVES": data,
            "SYSTEM_DISKS": system,
            "SYSTEM_CTRLS": ctrls,
        },
        capture_output=True,
    )
    return proc.returncode == 0


def test_helper_exists():
    assert MATCH.exists(), "disk_match.sh helper must exist"


# ── The reported bug: nvme1 (data) must NOT swallow nvme10 (OS) ──────────────


def test_data_controller_does_not_match_higher_numbered_controller():
    # OS root PV lives on controller nvme10; nvme1 is a data controller.
    assert not is_data(
        "/dev/nvme10n1p3", data="/dev/nvme1", system="/dev/nvme10n1", ctrls="/dev/nvme10"
    )


def test_data_controller_matches_its_own_namespace():
    assert is_data("/dev/nvme1n1p3", data="/dev/nvme1")
    assert is_data("/dev/nvme1n2", data="/dev/nvme1")


def test_whole_namespace_disk_does_not_match_higher_numbered_namespace():
    # all-mode data disk /dev/nvme1n1 must not swallow /dev/nvme1n10.
    assert not is_data("/dev/nvme1n10", data="/dev/nvme1n1")
    assert is_data("/dev/nvme1n1p3", data="/dev/nvme1n1")


def test_scsi_disk_partition_boundary():
    assert is_data("/dev/sda1", data="/dev/sda")
    # /dev/sdaa is a different disk, not a partition of /dev/sda.
    assert not is_data("/dev/sdaa1", data="/dev/sda")


def test_exact_device_matches():
    assert is_data("/dev/vdb", data="/dev/vda /dev/vdb")


# ── Defense in depth: never match anything on a protected disk ───────────────


def test_system_disk_is_never_a_data_member_even_if_prefix_would_match():
    # Contrived: a stale data entry overlaps the OS disk; guard must win.
    assert not is_data(
        "/dev/nvme0n1p3",
        data="/dev/nvme0",
        system="/dev/nvme0n1",
        ctrls="/dev/nvme0",
    )


@pytest.mark.parametrize("dev", ["", "/dev/nvme9", "/dev/sdz1"])
def test_unrelated_devices_are_not_data_members(dev):
    assert not is_data(dev, data="/dev/nvme1 /dev/sda")
