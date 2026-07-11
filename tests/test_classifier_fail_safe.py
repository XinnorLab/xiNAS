"""T1(a) / F-classifier-151: an operation the classifier cannot recognize
must be classified at the MOST destructive tier (specs.md §4.7) -- the
system knows the LEAST about what an unrecognized operation will do, so it
must get the two-screen destroying_data gate, never the auto-proceed
non_disruptive path. Three independent fallback sites share this bug:
classifier.py's own terminal fallthrough, runner.py's execute() catching a
non-parsing operation string, and engine.py's create_snapshot() doing the
same (reachable directly via `snapshot create --operation <anything>`,
since --operation is a free-form argparse string, not a choices= list).
"""

from __future__ import annotations

import asyncio

from xinas_history.classifier import RollbackClassifier
from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, OperationType, RollbackClass
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore


def test_classifier_unknown_operation_type_defaults_destroying_data():
    classifier = RollbackClassifier()
    import xinas_history.classifier as classifier_module

    original = dict(classifier_module._OPERATION_CLASS)
    try:
        classifier_module._OPERATION_CLASS.pop(OperationType.SHARE_CREATE, None)
        result = classifier.classify_operation(OperationType.SHARE_CREATE)
    finally:
        classifier_module._OPERATION_CLASS.clear()
        classifier_module._OPERATION_CLASS.update(original)
    assert result is RollbackClass.DESTROYING_DATA


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


def test_engine_create_snapshot_unparseable_operation_defaults_destroying_data(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    manifest = asyncio.run(
        engine.create_snapshot(source="api", operation="totally-bogus-operation")
    )
    assert manifest.rollback_class == RollbackClass.DESTROYING_DATA.value


def test_runner_execute_unparseable_operation_defaults_destroying_data(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw():
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    runner = TransactionalRunner(engine)

    async def _apply_ok() -> bool:
        return True

    result = asyncio.run(
        runner.execute(
            operation="totally-bogus-operation",
            source="api",
            apply_fn=_apply_ok,
            skip_preflight=True,
        )
    )
    assert result.rollback_class == RollbackClass.DESTROYING_DATA.value


def test_classify_change_entry_unknown_defaults_destroying_data():
    """specs.md §4.7: a change entry whose change_type does not parse to a
    known operation and whose file path matches no heuristic must fail safe
    to destroying_data, not non_disruptive."""
    cls = RollbackClassifier()
    result = cls._classify_change_entry(
        {"change_type": "totally-unknown-change", "file": "/etc/something-unmapped.conf"}
    )
    assert result == RollbackClass.DESTROYING_DATA
