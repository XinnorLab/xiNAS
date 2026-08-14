"""T1(c) / F-store-128: list_snapshots() must skip .tmp-* staging
directories -- a crash between write_snapshot() writing into its temp
staging dir and the atomic rename into snapshots/<id>/ leaves a directory
with a fully-valid manifest.yml sitting directly under snapshots/, and it
must never be surfaced as a real, committed snapshot (specs.md §1).
"""

from __future__ import annotations

from xinas_history.models import Manifest
from xinas_history.store import FilesystemStore


def test_list_snapshots_skips_tmp_staging_dir(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()

    # A real, committed snapshot.
    real_id = "20260711T120000000000Z-raid-create"
    store.write_snapshot(
        snapshot_id=real_id,
        manifest=Manifest(
            id=real_id,
            timestamp="2026-07-11T12:00:00Z",
            user="root",
            source="api",
        ),
        config_files={},
        runtime_files={},
    )

    # A crash-leaked staging dir: same shape write_snapshot creates before
    # the atomic rename, but never renamed (simulates a crash mid-write).
    # Its manifest.yml is fully valid and parseable on its own.
    stale_id = "20260711T130000000000Z-raid-delete"
    stale_dir = store.snapshots_path / f".tmp-{stale_id}-abcd12"
    stale_dir.mkdir()
    (stale_dir / "manifest.yml").write_text(
        f"id: {stale_id}\ntimestamp: '2026-07-11T13:00:00Z'\nuser: root\n"
        "source: api\nstatus: applied\n"
    )

    ids = {m.id for m in store.list_snapshots()}
    assert ids == {real_id}
    assert stale_id not in ids
