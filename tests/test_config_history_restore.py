"""S11 T8: TUI snapshot Restore — restorability gate + targeted rollback body."""

from __future__ import annotations

from xinas_history.engine import SnapshotEngine
from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore
from xinas_menu.screens.snapshot_detail import _snapshot_restorable

# `stub_socket` is provided via tests/conftest.py.


def _engine(tmp_path) -> SnapshotEngine:
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    return SnapshotEngine(store=store, repo_root=str(tmp_path))


def test_snapshot_restorable_gate(tmp_path):
    engine = _engine(tmp_path)
    engine._store.write_snapshot(
        snapshot_id="snap-new",
        manifest=Manifest(id="snap-new", timestamp="t", user="root", source="api"),
        config_files={},
        runtime_files={},
        system_files={"etc_exports": b"X"},
    )
    engine._store.write_snapshot(
        snapshot_id="snap-old",
        manifest=Manifest(id="snap-old", timestamp="t", user="root", source="api"),
        config_files={},
        runtime_files={},
    )
    assert _snapshot_restorable(engine, "snap-new") is True
    assert _snapshot_restorable(engine, "snap-old") is False


def test_restore_posts_targeted_rollback_body(stub_socket):
    """The body the Restore action sends — {to: <id>, reason} + dangerous —
    drives the rollback route to a terminal task via the control client."""
    from tests.test_control_client import BODIES, ROUTES, client

    posts = {"n": 0}

    def rollback_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 3, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    ROUTES[("POST", "/api/v1/config-history/rollback")] = rollback_post
    ROUTES[("GET", "/api/v1/tasks/t1")] = (200, {"result": {"task_id": "t1", "state": "success"}})

    result = client(stub_socket).plan_apply_wait(
        "POST",
        "/api/v1/config-history/rollback",
        {"to": "snap-1", "reason": "TUI restore"},
        dangerous=True,
        poll_s=0.01,
    )
    assert result["state"] == "success"
    plan_bodies = [b for (_, p, b) in BODIES if p.endswith("/rollback") and b.get("mode") == "plan"]
    assert plan_bodies[0]["spec"] == {"to": "snap-1", "reason": "TUI restore"}
    apply_bodies = [
        b for (_, p, b) in BODIES if p.endswith("/rollback") and b.get("mode") == "apply"
    ]
    assert apply_bodies[0]["dangerous"] is True
