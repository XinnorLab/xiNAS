"""S11 T4 / S13 T5: `snapshot list --format json` reports a `restorable` flag.

S13 extends restorable to cover tombstone-only snapshots (absent_files non-empty
but no system payload) and projects absent_files into the list row via to_dict().
"""

from __future__ import annotations

import argparse
import json

from xinas_history import __main__ as cli
from xinas_history.engine import SnapshotEngine
from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore


def _make_engine(tmp_path, snapshots: list) -> SnapshotEngine:
    """Write *snapshots* (list of (snapshot_id, manifest, system_files)) into store."""
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    for snap_id, manifest, system_files in snapshots:
        store.write_snapshot(
            snapshot_id=snap_id,
            manifest=manifest,
            config_files={},
            runtime_files={},
            **({"system_files": system_files} if system_files else {}),
        )
    return SnapshotEngine(store=store, repo_root=str(tmp_path))


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


def test_snapshot_list_json_tombstone_only_is_restorable(tmp_path, capsys):
    """S13 T5: absent_files-only snapshot (no system payload) → restorable: true.

    to_dict() emits absent_files when non-empty (T2), so it rides for free;
    restorable must be widened to OR in bool(m.absent_files).
    """
    # Tombstone-only: no system payload, but absent_files is set on the manifest.
    tombstone_id = "20260601T130000Z-tombstone"
    engine = _make_engine(
        tmp_path,
        [
            (
                tombstone_id,
                Manifest(
                    id=tombstone_id,
                    timestamp="t",
                    user="root",
                    source="api",
                    absent_files=["etc_exports"],
                ),
                None,  # no system payload
            ),
        ],
    )

    rc = cli._cmd_snapshot_list(argparse.Namespace(format="json"), engine)
    assert rc == 0
    rows = {r["id"]: r for r in json.loads(capsys.readouterr().out)}
    row = rows[tombstone_id]
    # Widened restorable: absent_files is non-empty → restorable.
    assert row["restorable"] is True
    # absent_files rides via to_dict() (T2).
    assert row["absent_files"] == ["etc_exports"]
