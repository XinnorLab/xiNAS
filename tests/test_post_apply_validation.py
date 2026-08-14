"""T4 (F-runner-257): post-apply validation must receive the operation's
expected post-change state (specs.md §13.1), and runner.execute() must
actually thread it through to PostApplyValidator -- not just that the
validator CAN use expected_state if given one (it already could; the bug is
that nothing ever passed it).
"""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest, ValidationResult
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore
from xinas_history.validator import PostApplyValidator


class _FakeInspector:
    """Reports one RAID array, 'data', at level 6."""

    async def raid_show(self, extended: bool = True):
        return True, {"data": {"level": "6"}}, ""


def test_post_apply_validator_catches_raid_level_mismatch():
    validator = PostApplyValidator(_FakeInspector())
    target = Manifest(id="x", timestamp="t", user="root", source="api")
    result = asyncio.run(
        validator.validate(
            target_manifest=target,
            expected_state={"raid_arrays": {"data": {"level": "5"}}},
        )
    )
    assert result.passed is False
    assert any("level mismatch" in b for b in result.blockers)


def test_post_apply_validator_passes_when_state_matches():
    validator = PostApplyValidator(_FakeInspector())
    target = Manifest(id="x", timestamp="t", user="root", source="api")
    result = asyncio.run(
        validator.validate(
            target_manifest=target,
            expected_state={"raid_arrays": {"data": {"level": "6"}}},
        )
    )
    assert result.passed is True


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


class _RecordingValidator:
    """Records the expected_state runner.execute() calls it with, so this
    test proves the RUNNER threads the param through -- not just that the
    validator can use one if handed one directly (the test above)."""

    def __init__(self) -> None:
        self.captured: dict | None = None

    async def validate(self, target_manifest, expected_state=None):
        self.captured = expected_state
        return ValidationResult(passed=True)


def test_execute_threads_expected_state_to_post_apply_validator(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

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

    recorder = _RecordingValidator()
    runner._post_apply = recorder  # type: ignore[assignment]

    async def _apply_ok() -> bool:
        return True

    expected = {"exports": [{"path": "/mnt/data"}]}
    result = asyncio.run(
        runner.execute(
            operation="share_create",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
            expected_state=expected,
        )
    )
    assert result.success is True
    assert recorder.captured == expected
