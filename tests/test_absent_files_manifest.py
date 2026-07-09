"""S13 T2: Manifest.absent_files — recorded at creation, never inferred (ADR-0017)."""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest
from xinas_history.store import FilesystemStore

# ---------------------------------------------------------------------------
# Unit tests: Manifest roundtrip
# ---------------------------------------------------------------------------


def test_absent_files_roundtrip():
    m = Manifest(
        id="s1",
        timestamp="2026-01-01T00:00:00Z",
        user="root",
        source="api",
        absent_files=["etc_exports"],
    )
    d = m.to_dict()
    assert d["absent_files"] == ["etc_exports"]
    assert Manifest.from_dict(d).absent_files == ["etc_exports"]


def test_absent_files_omitted_when_empty():
    assert (
        "absent_files"
        not in Manifest(
            id="s1", timestamp="2026-01-01T00:00:00Z", user="root", source="api"
        ).to_dict()
    )
    assert Manifest.from_dict({"id": "s1", "timestamp": "t"}).absent_files == []


# ---------------------------------------------------------------------------
# Integration test: engine.create_snapshot records absent_files
# ---------------------------------------------------------------------------


class _FakeConfigCollector:
    """Mirrors the stub in test_snapshot_files_changed.py; adds absent_files."""

    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        # Only etc_exports is present on disk — nfs_conf is absent.
        return {"etc_exports": b"LIVE-EXPORTS"}

    def collect_absent_system_files(self) -> list[str]:
        # Explicitly tombstone nfs_conf (simulates missing /etc/nfs.conf).
        return ["nfs_conf"]

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
    engine._config_collector = _FakeConfigCollector()  # type: ignore[assignment]
    engine._runtime_collector = _FakeRuntimeCollector(checksums)  # type: ignore[assignment]

    async def _no_hw() -> None:
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]
    return engine


def test_create_snapshot_records_absent_files(tmp_path):
    """engine.create_snapshot populates manifest.absent_files from the collector."""
    engine = _make_engine(tmp_path, Checksums(etc_exports="sha256:NEW"))
    manifest = asyncio.run(engine.create_snapshot(source="api", operation="share_create"))

    assert manifest.absent_files == ["nfs_conf"]


def test_create_snapshot_absent_files_persisted(tmp_path):
    """absent_files round-trips through the store (written to YAML, read back)."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = _make_engine(tmp_path, Checksums(etc_exports="sha256:NEW"))
    manifest = asyncio.run(engine.create_snapshot(source="api", operation="share_create"))

    reloaded = store.read_manifest(manifest.id)
    assert reloaded is not None
    assert reloaded.absent_files == ["nfs_conf"]
