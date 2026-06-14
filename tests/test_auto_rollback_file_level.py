"""C3: the transactional runner's auto-rollback must restore captured
pre-change config bytes file-level (the S11 model) — never re-run Ansible.

Regression guard for the defect where ``_auto_rollback`` re-ran
``playbooks/site.yml`` with the pre-change snapshot's (empty/forward)
``extra_vars``, re-applying the broken desired state and reporting success
while the captured ``system/`` bytes were never written back.
"""

from __future__ import annotations

import asyncio

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest, SnapshotStatus
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


def _build_runner(tmp_path):
    """A runner whose engine + restore seams are faked. Returns
    (runner, store, live_dir, commands, ansible_calls)."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))
    engine._config_collector = _FakeConfigCollector()
    engine._runtime_collector = _FakeRuntimeCollector()

    async def _no_hw() -> None:
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]

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

    # Record any Ansible invocation so tests can assert it never happens.
    ansible_calls: list[dict] = []

    async def _record_ansible(**kwargs) -> tuple[bool, str | None]:
        ansible_calls.append(kwargs)
        return True, None

    runner._run_ansible_playbook = _record_ansible  # type: ignore[attr-defined]

    return runner, store, live_dir, commands, ansible_calls


def _write_pre_change(store, *, system_files, checksums, snapshot_id="20260706T100000Z-pre"):
    store.write_snapshot(
        snapshot_id=snapshot_id,
        manifest=Manifest(
            id=snapshot_id,
            timestamp="2026-07-06T10:00:00Z",
            user="root",
            source="api",
            operation="share_create",
            checksums=checksums,
        ),
        config_files={},
        runtime_files={},
        system_files=system_files,
    )
    return snapshot_id


def test_auto_rollback_restores_captured_bytes_without_ansible(tmp_path):
    runner, store, live_dir, commands, ansible_calls = _build_runner(tmp_path)
    pre_id = _write_pre_change(
        store,
        system_files={"etc_exports": b"PRE-CHANGE"},
        checksums={"etc_exports": "sha256:PRE"},
    )

    # Live state drifted from the pre-change capture → etc_exports is in the set.
    async def _live() -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live  # type: ignore[attr-defined]

    ok, err = asyncio.run(runner._auto_rollback(pre_id, "share_create"))

    assert ok is True
    assert err is None
    # Captured pre-change bytes written back over the live path.
    assert (live_dir / "exports").read_bytes() == b"PRE-CHANGE"
    # Reconverged NFS.
    assert ["exportfs", "-ra"] in commands
    # NEVER re-ran Ansible.
    assert ansible_calls == []
    # Pre-change snapshot marked rolled_back.
    assert store.read_manifest(pre_id).status == SnapshotStatus.ROLLED_BACK.value


def test_auto_rollback_empty_set_is_truthful_noop(tmp_path):
    runner, store, live_dir, commands, ansible_calls = _build_runner(tmp_path)
    pre_id = _write_pre_change(
        store,
        system_files={"etc_exports": b"PRE-CHANGE"},
        checksums={"etc_exports": "sha256:SAME"},
    )

    # Live checksum == pre-change checksum → nothing to restore.
    async def _live() -> Checksums:
        return Checksums(etc_exports="sha256:SAME")

    runner._collect_current_checksums = _live  # type: ignore[attr-defined]

    ok, err = asyncio.run(runner._auto_rollback(pre_id, "share_create"))

    assert ok is True
    assert err is None
    assert commands == []
    assert ansible_calls == []
    assert not (live_dir / "exports").exists()


def test_auto_rollback_reports_failure_when_reconverge_fails(tmp_path):
    runner, store, live_dir, commands, ansible_calls = _build_runner(tmp_path)
    pre_id = _write_pre_change(
        store,
        system_files={"etc_exports": b"PRE-CHANGE"},
        checksums={"etc_exports": "sha256:PRE"},
    )

    async def _live() -> Checksums:
        return Checksums(etc_exports="sha256:LIVE")

    runner._collect_current_checksums = _live  # type: ignore[attr-defined]

    async def _fail_run(argv: list[str]) -> tuple[bool, str]:
        commands.append(argv)
        return False, "boom"

    runner._run_command = _fail_run  # type: ignore[attr-defined]

    ok, err = asyncio.run(runner._auto_rollback(pre_id, "share_create"))

    assert ok is False
    assert err is not None
    assert ansible_calls == []


def test_auto_rollback_missing_pre_change_snapshot(tmp_path):
    runner, store, live_dir, commands, ansible_calls = _build_runner(tmp_path)

    ok, err = asyncio.run(runner._auto_rollback("does-not-exist", "share_create"))

    assert ok is False
    assert err is not None
    assert ansible_calls == []


def test_execute_failed_apply_rolls_back_file_level(tmp_path):
    """Integration: a failing apply drives execute() into auto-rollback,
    which restores the pre-change bytes and never spawns Ansible."""
    runner, store, live_dir, commands, ansible_calls = _build_runner(tmp_path)

    # The pre-change ephemeral (captured by engine.create_snapshot) records
    # checksum sha256:LIVE; force the live re-checksum to differ so the
    # restore set is non-empty.
    async def _broken_live() -> Checksums:
        return Checksums(etc_exports="sha256:BROKEN")

    runner._collect_current_checksums = _broken_live  # type: ignore[attr-defined]

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
    assert result.rollback_performed is True
    assert result.rollback_success is True
    # The engine captured etc_exports=b"EPHEMERAL-LIVE"; rollback wrote it back.
    assert (live_dir / "exports").read_bytes() == b"EPHEMERAL-LIVE"
    assert ["exportfs", "-ra"] in commands
    assert ansible_calls == []
