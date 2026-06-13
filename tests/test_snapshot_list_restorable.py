"""S11 T4: `snapshot list --format json` reports a `restorable` flag."""

from __future__ import annotations

import argparse
import json

from xinas_history import __main__ as cli
from xinas_history.engine import SnapshotEngine
from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore


def test_snapshot_list_json_includes_restorable(tmp_path, capsys):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    # One restorable (has system payload) + one pre-S11 (no payload).
    store.write_snapshot(
        snapshot_id="20260601T120000Z-new",
        manifest=Manifest(id="20260601T120000Z-new", timestamp="t", user="root", source="api"),
        config_files={},
        runtime_files={},
        system_files={"etc_exports": b"X"},
    )
    store.write_snapshot(
        snapshot_id="20260101T000000Z-old",
        manifest=Manifest(id="20260101T000000Z-old", timestamp="t", user="root", source="api"),
        config_files={},
        runtime_files={},
    )
    engine = SnapshotEngine(store=store, repo_root=str(tmp_path))

    rc = cli._cmd_snapshot_list(argparse.Namespace(format="json"), engine)
    assert rc == 0
    rows = {r["id"]: r for r in json.loads(capsys.readouterr().out)}
    assert rows["20260601T120000Z-new"]["restorable"] is True
    assert rows["20260101T000000Z-old"]["restorable"] is False
