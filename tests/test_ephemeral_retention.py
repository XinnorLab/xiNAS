"""T3 / F-engine-150: ephemeral pre-change snapshots must be created
status=pending and moved to a terminal status (applied/rolled_back/failed)
by the runner once the operation they precede resolves -- otherwise GC's
cleanup_stale_ephemeral() (gc.py, already correct) and count/age retention
never reclaim them (specs.md §1 "Snapshot Status Lifecycle", §7.3).
"""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.gc import GarbageCollector, RetentionPolicy
from xinas_history.models import Checksums, Manifest, SnapshotStatus, SnapshotType
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore


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


class _FakePostApplyValidator:
    """Always-pass stand-in -- isolates the ephemeral-lifecycle behavior
    under test from the real PostApplyValidator's systemctl subprocess
    calls (which are environment-dependent; Task 7 gives it real teeth)."""

    async def validate(self, **kwargs):
        from xinas_history.models import ValidationResult

        return ValidationResult(passed=True)


def _build_runner(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    runner = TransactionalRunner(engine)
    runner._post_apply = _FakePostApplyValidator()  # type: ignore[assignment]
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {"etc_exports": str(live_dir / "exports")}  # type: ignore[attr-defined]

    async def _fake_run(argv):
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]
    return runner, store, engine


def test_ephemeral_snapshot_created_pending(tmp_path):
    """The RED-defining test for this task: immediately after creation,
    before any resolution, an ephemeral's status must be pending, not the
    old hardcoded applied."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    manifest = asyncio.run(
        engine.create_snapshot(
            source="api",
            operation="share_create",
            snapshot_type=SnapshotType.EPHEMERAL.value,
        )
    )
    assert manifest.status == SnapshotStatus.PENDING.value


def test_pre_change_ephemeral_marked_applied_after_successful_apply(tmp_path):
    """Confirms the end-to-end contract holds on the success path. NOTE:
    this specific assertion is NOT independently red against old code --
    the old hardcoded default happens to already read "applied" here too,
    coincidentally. It is kept as a non-regression / contract-pinning
    check; test_ephemeral_snapshot_created_pending and
    test_pre_change_ephemeral_marked_failed_when_rollback_also_fails below
    are this task's genuine RED tests."""
    runner, store, engine = _build_runner(tmp_path)

    async def _broken_live() -> Checksums:
        return Checksums(etc_exports="sha256:BROKEN")

    runner._collect_current_checksums = _broken_live  # type: ignore[attr-defined]

    async def _apply_ok() -> bool:
        return True

    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
        )
    )
    assert result.success is True
    pre_manifest = store.read_manifest(result.pre_change_snapshot_id)
    assert pre_manifest is not None
    assert pre_manifest.status == SnapshotStatus.APPLIED.value


def test_pre_change_ephemeral_marked_failed_when_rollback_also_fails(tmp_path):
    """RED-defining: when BOTH the forward apply AND the auto-rollback
    fail, the pre-change ephemeral must end up status=failed (specs.md §1:
    "failed... the snapshot is retained for forensic review"). Old code
    never marks this branch at all, leaving the hardcoded status=applied
    in place -- misleadingly implying the operation succeeded."""
    runner, store, engine = _build_runner(tmp_path)

    async def _broken_live() -> Checksums:
        return Checksums(etc_exports="sha256:BROKEN")

    runner._collect_current_checksums = _broken_live  # type: ignore[attr-defined]

    async def _fail_run(argv):
        return False, "boom"

    runner._run_command = _fail_run  # type: ignore[attr-defined]

    async def _apply_fails() -> bool:
        return False

    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_fails,
            skip_preflight=True,
        )
    )
    assert result.success is False
    assert result.rollback_success is False
    pre_manifest = store.read_manifest(result.pre_change_snapshot_id)
    assert pre_manifest is not None
    assert pre_manifest.status == SnapshotStatus.FAILED.value


def test_cleanup_stale_ephemeral_deletes_pending(tmp_path):
    """gc.py's cleanup_stale_ephemeral() is already correct; this confirms
    it actually fires now that PENDING is a reachable status."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    snap_id = "20260101T000000000000Z-share-create"
    store.write_snapshot(
        snapshot_id=snap_id,
        manifest=Manifest(
            id=snap_id,
            timestamp="2026-01-01T00:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            status=SnapshotStatus.PENDING.value,
            type=SnapshotType.EPHEMERAL.value,
        ),
        config_files={},
        runtime_files={},
    )
    gc = GarbageCollector(store, RetentionPolicy())
    cleaned = gc.cleanup_stale_ephemeral()
    assert snap_id in cleaned
    assert store.read_manifest(snap_id) is None
