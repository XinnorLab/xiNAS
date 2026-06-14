"""S13 T1: collect_absent_system_files — explicit tombstone set (ADR-0017)."""

from __future__ import annotations

from pathlib import Path

import pytest

from xinas_history import collector as collector_mod
from xinas_history.collector import ConfigCollector, SYSTEM_FILE_PATHS


def test_collect_absent_system_files(tmp_path, monkeypatch):
    present = {"etc_exports": tmp_path / "exports", "netplan": tmp_path / "99.yaml"}
    present["etc_exports"].write_text("X")
    present["netplan"].write_text("Y")
    paths = {name: str(present.get(name, tmp_path / f"missing-{name}")) for name in SYSTEM_FILE_PATHS}
    monkeypatch.setattr(collector_mod, "SYSTEM_FILE_PATHS", paths)

    absent = ConfigCollector().collect_absent_system_files()
    assert "etc_exports" not in absent and "netplan" not in absent
    assert "nfs_conf" in absent and "idmapd_conf" in absent
    assert set(absent).issubset(set(SYSTEM_FILE_PATHS))
