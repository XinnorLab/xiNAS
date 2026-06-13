"""S11 T1: collect_system_files + the store `system/` payload."""

from __future__ import annotations

from xinas_history import collector as collector_mod
from xinas_history.collector import ConfigCollector
from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore


def _manifest(snapshot_id: str = "20260613T120000Z-share-create") -> Manifest:
    return Manifest(
        id=snapshot_id,
        timestamp="2026-06-13T12:00:00Z",
        user="root",
        source="api",
        operation="share_create",
    )


def test_collect_system_files_reads_present_and_omits_absent(tmp_path, monkeypatch):
    present = tmp_path / "exports"
    present.write_bytes(b"/data 10.0.0.0/8(rw)\n")
    # 'netplan' points at a path that does not exist → omitted.
    monkeypatch.setattr(
        collector_mod,
        "SYSTEM_FILE_PATHS",
        {"etc_exports": str(present), "netplan": str(tmp_path / "missing.yaml")},
    )
    out = ConfigCollector().collect_system_files()
    assert out == {"etc_exports": b"/data 10.0.0.0/8(rw)\n"}
    assert "netplan" not in out


def test_store_system_payload_round_trip(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    sid = "20260613T120000Z-share-create"
    store.write_snapshot(
        snapshot_id=sid,
        manifest=_manifest(sid),
        config_files={},
        runtime_files={},
        system_files={"etc_exports": b"EXPORTS-BYTES", "netplan": b"NETPLAN-BYTES"},
    )
    assert store.read_system_file(sid, "etc_exports") == b"EXPORTS-BYTES"
    assert store.read_system_file(sid, "netplan") == b"NETPLAN-BYTES"
    assert sorted(store.list_system_files(sid)) == ["etc_exports", "netplan"]
    assert store.read_system_file(sid, "nope") is None


def test_list_system_files_empty_for_pre_s11_snapshot(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    sid = "20260101T000000Z-old"
    # Written WITHOUT a system_files payload (pre-S11 shape).
    store.write_snapshot(
        snapshot_id=sid,
        manifest=_manifest(sid),
        config_files={},
        runtime_files={},
    )
    assert store.list_system_files(sid) == []
    assert store.read_system_file(sid, "etc_exports") is None
