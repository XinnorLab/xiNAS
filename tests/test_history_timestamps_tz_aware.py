"""T1(d) / F-lock-127: datetime.utcnow() is deprecated at 6 sites
(lock.py:127,222,330; engine.py:146; models.py:342; drift.py:208). Each
call site must switch to datetime.now(timezone.utc) while preserving the
existing "...Z"-suffixed serialized form (specs.md §1: "the serialized
form is unchanged: ISO 8601 with a Z suffix").
"""

from __future__ import annotations

import warnings
from datetime import datetime as real_datetime

from xinas_history.drift import DriftDetector
from xinas_history.engine import SnapshotEngine
from xinas_history.lock import GlobalConfigLock
from xinas_history.models import Checksums
from xinas_history.store import FilesystemStore


def _assert_z_suffix_and_parses(ts: str) -> None:
    assert ts.endswith("Z"), ts
    real_datetime.fromisoformat(ts.replace("Z", "+00:00"))  # must not raise


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums()


def test_engine_snapshot_timestamp_is_tz_aware_with_z_suffix(tmp_path):
    import asyncio

    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        manifest = asyncio.run(
            engine.create_snapshot(source="api", operation="install", snapshot_type="baseline")
        )
    _assert_z_suffix_and_parses(manifest.timestamp)


def test_lock_meta_started_is_tz_aware_with_z_suffix(tmp_path):
    lock = GlobalConfigLock(str(tmp_path / "state"))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            lock.acquire(operation="raid_create", source="api")
        info = lock.get_lock_info()
        assert info is not None
        _assert_z_suffix_and_parses(info["started"])
        journal = lock.get_journal()
        assert journal is not None
        _assert_z_suffix_and_parses(journal["started"])
        _assert_z_suffix_and_parses(journal["last_updated"])
    finally:
        lock.release()


def test_drift_report_timestamp_is_tz_aware_with_z_suffix(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    detector = DriftDetector(store=store, repo_root=str(tmp_path))
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        report = detector.check()
    _assert_z_suffix_and_parses(report.timestamp)
