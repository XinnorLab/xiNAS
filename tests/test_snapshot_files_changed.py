"""S11 T2: create_snapshot stores the system payload + computes files_changed."""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine, compute_files_changed
from xinas_history.models import Checksums, Manifest
from xinas_history.store import FilesystemStore


def test_compute_files_changed_diffs_against_parent():
    new = {"etc_exports": "sha256:NEW", "netplan": "sha256:SAME"}
    parent = {"etc_exports": "sha256:OLD", "netplan": "sha256:SAME"}
    assert compute_files_changed(new, parent) == ["etc_exports"]


def test_compute_files_changed_counts_new_and_removed():
    assert compute_files_changed({"netplan": "sha256:X"}, {}) == ["netplan"]
    assert compute_files_changed({}, {"etc_exports": "sha256:Y"}) == ["etc_exports"]


def test_compute_files_changed_empty_when_no_parent_or_identical():
    assert compute_files_changed({"a": "1"}, None) == []
    assert compute_files_changed({"a": "1"}, {"a": "1"}) == []


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"LIVE-EXPORTS"}

    def get_repo_commit(self) -> str:
        return "deadbeef"


class _FakeRuntimeCollector:
    def __init__(self, checksums: Checksums) -> None:
        self._checksums = checksums

    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return self._checksums


def _make_engine(tmp_path, checksums: Checksums) -> SnapshotEngine:
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector(checksums)

    async def _no_hw() -> None:
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]
    return engine


def test_create_snapshot_stores_system_payload_and_files_changed(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    # Seed a parent snapshot with a DIFFERENT etc_exports checksum.
    parent_id = "20260101T000000Z-parent"
    store.write_snapshot(
        snapshot_id=parent_id,
        manifest=Manifest(
            id=parent_id,
            timestamp="2026-01-01T00:00:00Z",
            user="root",
            source="installer",
            checksums={"etc_exports": "sha256:OLD"},
        ),
        config_files={},
        runtime_files={},
    )

    engine = _make_engine(tmp_path, Checksums(etc_exports="sha256:NEW"))
    manifest = asyncio.run(
        engine.create_snapshot(source="api", operation="share_create", parent_id=parent_id)
    )

    assert manifest.files_changed == ["etc_exports"]
    assert store.list_system_files(manifest.id) == ["etc_exports"]
    assert store.read_system_file(manifest.id, "etc_exports") == b"LIVE-EXPORTS"


def test_create_snapshot_no_parent_has_empty_files_changed(tmp_path):
    # No parent_id (and none auto-detected on a fresh store) → files_changed [].
    engine = _make_engine(tmp_path, Checksums(etc_exports="sha256:NEW"))
    manifest = asyncio.run(engine.create_snapshot(source="api", operation="share_create"))
    assert manifest.files_changed == []
    # The payload is still captured (the snapshot is restorable).
    assert engine._store.list_system_files(manifest.id) == ["etc_exports"]
