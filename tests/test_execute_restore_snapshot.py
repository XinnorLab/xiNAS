"""S11 T3: file-level execute_restore_snapshot (current-vs-target)."""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest
from xinas_history.runner import TransactionalRunner
from xinas_history.store import FilesystemStore


class _FakeConfigCollector:
    def collect(self) -> dict[str, bytes]:
        return {}

    def collect_system_files(self) -> dict[str, bytes]:
        return {"etc_exports": b"EPHEMERAL-LIVE"}

    def get_repo_commit(self) -> str:
        return ""


class _FakeRuntimeCollector:
    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")


def _build(tmp_path, *, target_system: dict[str, bytes], target_checksums: dict):
    """A runner whose engine + restore seams are faked. Returns
    (runner, store, target_id, live_dir, commands)."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw() -> None:
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

    target_id = "20260601T120000Z-share-create"
    store.write_snapshot(
        snapshot_id=target_id,
        manifest=Manifest(
            id=target_id,
            timestamp="2026-06-01T12:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            checksums=target_checksums,
        ),
        config_files={},
        runtime_files={},
        system_files=target_system,
    )

    runner = TransactionalRunner(engine)

    live_dir = tmp_path / "live"
    live_dir.mkdir()
    runner._system_file_paths = {  # type: ignore[attr-defined]
        "etc_exports": str(live_dir / "exports"),
        "netplan": str(live_dir / "99-xinas.yaml"),
    }

    commands: list[list[str]] = []

    async def _fake_run(argv: list[str]) -> tuple[bool, str]:
        commands.append(argv)
        return True, ""

    runner._run_command = _fake_run  # type: ignore[attr-defined]

    async def _live_checksums() -> Checksums:
        # etc_exports differs from the target → in the restore set.
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live_checksums  # type: ignore[attr-defined]
    return runner, store, target_id, live_dir, commands


def test_restore_writes_changed_file_and_reconverges(tmp_path):
    runner, store, target_id, live_dir, commands = _build(
        tmp_path,
        target_system={"etc_exports": b"TARGET-EXPORTS"},
        target_checksums={"etc_exports": "sha256:TARGET"},
    )
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="oops"))
    assert result.success is True
    assert (live_dir / "exports").read_bytes() == b"TARGET-EXPORTS"
    assert ["exportfs", "-ra"] in commands
    assert ["systemctl", "restart", "nfs-server"] in commands
    assert "recovery applied" in (result.output or "")


def test_restore_empty_set_is_success_noop(tmp_path):
    # Live checksum == target checksum → nothing to restore.
    runner, store, target_id, live_dir, commands = _build(
        tmp_path,
        target_system={"etc_exports": b"TARGET-EXPORTS"},
        target_checksums={"etc_exports": "sha256:LIVE"},
    )
    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.success is True
    assert commands == []
    assert not (live_dir / "exports").exists()
    assert "already at target" in (result.output or "")


def test_restore_snapshot_not_found(tmp_path):
    runner, *_ = _build(
        tmp_path, target_system={"etc_exports": b"x"}, target_checksums={"etc_exports": "sha256:T"}
    )
    result = asyncio.run(runner.execute_restore_snapshot("nope", source="api", reason="x"))
    assert result.success is False
    assert result.error == "snapshot_not_found"


def test_restore_no_restorable_payload(tmp_path):
    runner, store, _target_id, *_ = _build(
        tmp_path, target_system={"etc_exports": b"x"}, target_checksums={"etc_exports": "sha256:T"}
    )
    # A snapshot written WITHOUT a system payload (pre-S11 shape).
    bare = "20260101T000000Z-old"
    store.write_snapshot(
        snapshot_id=bare,
        manifest=Manifest(id=bare, timestamp="t", user="root", source="installer"),
        config_files={},
        runtime_files={},
    )
    result = asyncio.run(runner.execute_restore_snapshot(bare, source="api", reason="x"))
    assert result.success is False
    assert result.error == "no_restorable_payload"


def test_restore_validation_fail_does_file_level_rollback(tmp_path):
    runner, store, target_id, live_dir, commands = _build(
        tmp_path,
        target_system={"etc_exports": b"TARGET-EXPORTS"},
        target_checksums={"etc_exports": "sha256:TARGET"},
    )

    async def _fail() -> bool:
        return False

    runner._validate_restore = _fail  # type: ignore[attr-defined]

    result = asyncio.run(runner.execute_restore_snapshot(target_id, source="api", reason="x"))
    assert result.success is False
    assert result.rollback_performed is True
    # The pre-change ephemeral captured etc_exports=b"EPHEMERAL-LIVE" (the fake
    # collector); the file-level rollback wrote THAT back over the target bytes.
    assert (live_dir / "exports").read_bytes() == b"EPHEMERAL-LIVE"


def test_reconverge_commands_netplan_includes_flush_and_apply():
    cmds = TransactionalRunner._reconverge_commands(["netplan"])
    assert ["netplan", "apply"] in cmds
    # PBR-flush + IP-flush precede the apply (the documented sequence).
    assert any("ip rule del table" in " ".join(c) for c in cmds)
    assert cmds.index(["netplan", "apply"]) == len(cmds) - 1
