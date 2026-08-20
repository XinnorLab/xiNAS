"""Preset-overlay design §10: CONFIG_SOURCES gains the two group_vars overlay
layers and the live netplan override, so snapshot/diff/drift stop being blind
to the configuration changes presets and config editors actually make now
that the role defaults are immutable between releases.

``tests/test_system_files_payload.py::test_config_sources_cover_the_overlay``
covers the literal dict membership the brief for this task asks for, but that
assertion would still pass against a ``ConfigCollector.collect()`` that never
reads a byte off disk -- indeed, at the time this file was added, NO existing
test anywhere in the suite called the real (unstubbed) ``collect()`` for any
entry, old or new; every other test either fakes ``ConfigCollector`` outright
or exercises the sibling ``collect_system_files()`` against the unrelated
``SYSTEM_FILE_PATHS`` dict. The tests below exercise the real method end to
end: real bytes on disk, real snapshot creation, real diff, and the real
drift-policy classification the new entries fall into.
"""

from __future__ import annotations

import asyncio

from xinas_history.collector import CONFIG_SOURCES, ConfigCollector
from xinas_history.drift import DriftDetector
from xinas_history.engine import SnapshotEngine
from xinas_history.models import Checksums, Manifest
from xinas_history.store import FilesystemStore

# ---------------------------------------------------------------------------
# ConfigCollector.collect() itself, unstubbed
# ---------------------------------------------------------------------------


def test_collect_reads_real_overlay_bytes_off_disk(tmp_path):
    """The real ConfigCollector, pointed at a fake repo root, must read each
    overlay file's actual bytes under its documented snapshot key -- not a
    placeholder, not the wrong file."""
    group_vars = tmp_path / "playbooks" / "group_vars" / "all"
    group_vars.mkdir(parents=True)
    (group_vars / "10-preset.yml").write_bytes(b"preset_key: preset_value\n")
    (group_vars / "20-local.yml").write_bytes(b"local_key: local_value\n")
    local_artefacts = tmp_path / ".xinas-local"
    local_artefacts.mkdir()
    (local_artefacts / "netplan.yaml.j2").write_bytes(b"network:\n  version: 2\n")

    collected = ConfigCollector(repo_root=str(tmp_path)).collect()

    assert collected["overlay.preset.yml"] == b"preset_key: preset_value\n"
    assert collected["overlay.local.yml"] == b"local_key: local_value\n"
    assert collected["netplan.live.j2"] == b"network:\n  version: 2\n"


def test_collect_omits_absent_overlay_entries_without_crashing(tmp_path):
    """A host that has never applied a preset has none of the overlay files --
    playbooks/group_vars/all/ itself is typically empty and .xinas-local/
    typically does not exist at all (true of this very repo checkout before
    any install has run). collect() silently skips a missing source for every
    other entry already; this confirms that path actually holds for the three
    new ones too, rather than assuming the shared try/except covers them."""
    # tmp_path is an empty repo root: no playbooks/ and no .xinas-local/ at all.
    collected = ConfigCollector(repo_root=str(tmp_path)).collect()

    assert "overlay.preset.yml" not in collected
    assert "overlay.local.yml" not in collected
    assert "netplan.live.j2" not in collected
    # And it doesn't stop collecting everything else because of the misses.
    assert collected == {}


# ---------------------------------------------------------------------------
# End to end: create_snapshot -> collect() -> stored bytes -> diff()
# ---------------------------------------------------------------------------


class _FakeRuntimeCollector:
    """Stands in for the gRPC/systemd-backed RuntimeCollector, which this
    sandbox cannot reach (no xiraid-server, no systemd). Matches the
    convention already used throughout this suite, e.g.
    test_snapshot_files_changed.py's _FakeRuntimeCollector. The point of this
    test module is ConfigCollector / CONFIG_SOURCES, so that is the one piece
    left real."""

    def __init__(self, checksums: Checksums | None = None) -> None:
        self._checksums = checksums or Checksums()

    async def collect(self) -> dict[str, bytes]:
        return {}

    async def collect_checksums(self) -> Checksums:
        return self._checksums


def _make_engine(tmp_path):
    store = FilesystemStore(root=str(tmp_path / "store"))
    store.ensure_dirs()
    repo_root = tmp_path / "repo"
    group_vars = repo_root / "playbooks" / "group_vars" / "all"
    group_vars.mkdir(parents=True)

    engine = SnapshotEngine(store=store, repo_root=str(repo_root))
    # Deliberately NOT overriding engine._config_collector: it stays the real
    # ConfigCollector(repo_root=repo_root), which is exactly what production
    # wires up. Only the gRPC/systemd side is faked.
    engine._runtime_collector = _FakeRuntimeCollector()  # type: ignore[assignment]

    async def _no_hw() -> None:
        return None

    engine._get_hardware_id = _no_hw  # type: ignore[assignment]
    return engine, group_vars, store


def test_snapshot_then_edit_then_snapshot_diff_reflects_the_overlay_change(tmp_path):
    """THE property that matters most: a snapshot taken after a configuration
    change must actually differ from one taken before it. This drives the
    real pipeline end to end -- create_snapshot() calls the real
    ConfigCollector.collect(), which reads CONFIG_SOURCES off real disk, into
    two real snapshots on a real FilesystemStore -- then reads the result the
    way the TUI/CLI diff view would (engine.diff()), and separately re-reads
    the raw stored bytes to confirm the diff isn't reporting a coincidence.
    """
    engine, group_vars, store = _make_engine(tmp_path)
    local_yml = group_vars / "20-local.yml"

    # Simulate a config editor's read-modify-write of 20-local.yml (design
    # doc §6: "read effective, write 20-local.yml") across two points in time.
    local_yml.write_bytes(b"nfs_server_threads: 32\n")
    before = asyncio.run(engine.create_snapshot(source="api", operation="nfs_modify"))

    local_yml.write_bytes(b"nfs_server_threads: 64\n")
    after = asyncio.run(
        engine.create_snapshot(source="api", operation="nfs_modify", parent_id=before.id)
    )

    result = engine.diff(before.id, after.id)
    changed = {c["file"]: c for c in result.config_changes}
    assert "overlay.local.yml" in changed
    assert changed["overlay.local.yml"]["change_type"] == "modified"

    # Belt and suspenders: the stored bytes for each snapshot are exactly what
    # was on disk at the moment each snapshot was created, not e.g. both
    # snapshots sharing the same (say, most-recent) content.
    assert store.read_file(before.id, "overlay.local.yml") == b"nfs_server_threads: 32\n"
    assert store.read_file(after.id, "overlay.local.yml") == b"nfs_server_threads: 64\n"

    # Negative control: snapshotting again with NO further edit must NOT
    # report the file as changed. Without this, the positive assertions above
    # would not distinguish "diff reflects real content" from "diff always
    # reports every overlay file as modified regardless of content" -- which
    # is indistinguishable from broken if only the positive case is checked.
    unchanged = asyncio.run(
        engine.create_snapshot(source="api", operation="nfs_modify", parent_id=after.id)
    )
    result2 = engine.diff(after.id, unchanged.id)
    changed2 = {c["file"] for c in result2.config_changes}
    assert "overlay.local.yml" not in changed2


# ---------------------------------------------------------------------------
# Drift detection: the overlay must ADOPT, not block/warn, on routine changes
# ---------------------------------------------------------------------------


def test_overlay_drift_adopts_rather_than_blocks_or_warns(tmp_path):
    """DriftDetector classifies every CONFIG_SOURCES entry via a naming
    convention (drift.py: '.j2' -> template, 'playbook' in name -> playbook,
    else -> role_default), all three of which currently resolve to the ADOPT
    policy. That matters here specifically: preset apply rewrites
    10-preset.yml and the config editors rewrite 20-local.yml as their
    NORMAL, intended operation (design doc §10), so if this ever classified
    as WARN_AND_CONFIRM or BLOCK instead, routine use would surface a drift
    warning on every apply/edit. This drives the real check() end to end
    (real files on disk, a real stored snapshot) rather than asserting the
    policy table directly, so a future rename that breaks the naming
    convention is caught here."""
    store = FilesystemStore(root=str(tmp_path / "store"))
    store.ensure_dirs()
    repo_root = tmp_path / "repo"
    group_vars = repo_root / "playbooks" / "group_vars" / "all"
    group_vars.mkdir(parents=True)
    local_yml = group_vars / "20-local.yml"
    local_yml.write_bytes(b"a: 1\n")

    manifest = Manifest(id="snap1", timestamp="2026-01-01T00:00:00Z", user="root", source="api")
    store.write_snapshot(
        snapshot_id="snap1",
        manifest=manifest,
        config_files={"overlay.local.yml": b"a: 1\n"},
        runtime_files={},
    )

    # The config editor changes the live file after the snapshot was taken.
    local_yml.write_bytes(b"a: 2\n")

    detector = DriftDetector(store=store, repo_root=str(repo_root))
    report = detector.check(reference_snapshot_id="snap1")

    entries = {e.artifact: e for e in report.entries}
    rel_path = CONFIG_SOURCES["overlay.local.yml"]
    assert rel_path in entries, f"expected drift entry for {rel_path}, got {list(entries)}"
    entry = entries[rel_path]
    assert entry.policy == "adopt"
    assert entry.safety_impact != "affects_rollback_safety"
