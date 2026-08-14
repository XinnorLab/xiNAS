"""T2 (F-engine-176, HIGH): GC must never delete a snapshot while a restore
is reading it, and standalone GC entry points must not run lock-free
(specs.md §7.4: "no lock-free deletion, and an active restore's source
snapshot is always protected").
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from xinas_history.engine import SnapshotEngine
from xinas_history.gc import GarbageCollector, RetentionPolicy
from xinas_history.lock import GlobalConfigLock
from xinas_history.models import Checksums, Manifest, SnapshotType
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore

REPO_ROOT = Path(__file__).resolve().parents[1]


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"EPHEMERAL-LIVE"}

    def collect_absent_system_files(self) -> list[str]:
        return []

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")


def test_gc_does_not_delete_in_flight_restore_source(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    engine._gc = GarbageCollector(store, RetentionPolicy(max_snapshots=1))

    old_id = "20260101T000000000000Z-share-create"  # the restore target/source
    other_id = "20260103T000000000000Z-share-modify"  # a second, newer rollback_eligible snapshot
    store.write_snapshot(
        snapshot_id=old_id,
        manifest=Manifest(
            id=old_id,
            timestamp="2026-01-01T00:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            status="applied",
            type=SnapshotType.ROLLBACK_ELIGIBLE.value,
            checksums={"etc_exports": "sha256:TARGET"},
        ),
        config_files={},
        runtime_files={},
        system_files={"etc_exports": b"TARGET-EXPORTS"},
    )
    store.write_snapshot(
        snapshot_id=other_id,
        manifest=Manifest(
            id=other_id,
            timestamp="2026-01-03T00:00:00Z",
            user="root",
            source="api",
            operation="share_modify",
            status="applied",
            type=SnapshotType.ROLLBACK_ELIGIBLE.value,
        ),
        config_files={},
        runtime_files={},
    )

    runner = TransactionalRunner(engine)
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {"etc_exports": str(live_dir / "exports")}  # type: ignore[attr-defined]

    async def _fake_run(argv):
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]

    async def _live_checksums():
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live_checksums  # type: ignore[attr-defined]

    result = asyncio.run(
        runner.execute_restore_snapshot(old_id, source="api", reason="concurrency-check")
    )

    assert store.read_manifest(old_id) is not None, (
        "the restore's own pre-snapshot creation fired an inline GC pass "
        "that deleted the snapshot being restored FROM"
    )
    assert result.success is True
    assert (live_dir / "exports").read_bytes() == b"TARGET-EXPORTS", (
        "old code: read_system_file() on the deleted target silently "
        "returned None, so the restore no-op'd while still reporting success"
    )


def test_cli_gc_run_refuses_when_lock_held(tmp_path):
    lock = GlobalConfigLock(str(tmp_path / "state"))
    lock.acquire(operation="raid_create", source="xinas_menu")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "xinas_history", "--store-path", str(tmp_path), "gc", "run"],
            cwd=tmp_path,
            env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
        )
    finally:
        lock.release()
    assert result.returncode != 0
    assert "lock" in (result.stdout + result.stderr).lower()


def test_cli_gc_run_succeeds_when_lock_free(tmp_path):
    result = subprocess.run(
        [sys.executable, "-m", "xinas_history", "--store-path", str(tmp_path), "gc", "run"],
        cwd=tmp_path,
        env={"PYTHONPATH": str(REPO_ROOT), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
