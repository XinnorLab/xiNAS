"""T1(b) / F-store-251: any snapshot id turned into a filesystem path MUST
be validated against the allowlist ^[A-Za-z0-9._-]+$ and MUST reject a
".." path segment or an absolute path (specs.md §1, "Snapshot ID and
Store-Path Safety") before joining it onto the store root. Defense-in-depth:
ids are normally generated internally, never taken from untrusted input, but
the store must not rely on that as its only safeguard.
"""

from __future__ import annotations

import pytest

from xinas_history.store import FilesystemStore


def test_snapshot_path_rejects_traversal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("../etc")


def test_snapshot_path_rejects_bare_dotdot(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("..")


def test_snapshot_path_rejects_absolute_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    with pytest.raises(ValueError):
        store.snapshot_path("/etc/passwd")


def test_delete_snapshot_rejects_traversal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    store.ensure_dirs()
    with pytest.raises(ValueError):
        store.delete_snapshot("../x")


def test_snapshot_path_accepts_normal_id(tmp_path):
    store = FilesystemStore(root=str(tmp_path))
    normal_id = "20260711T120000123456Z-raid-create"
    assert store.snapshot_path(normal_id) == store.snapshots_path / normal_id
