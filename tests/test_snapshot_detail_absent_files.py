"""S13 T8: snapshot-detail screen renders absent_files (ADR-0017).

Tests the pure formatter helper ``_format_manifest`` directly — no Textual
harness required.  The helper is a sync function that accepts a Manifest
object and returns a plain string, making it trivially unit-testable.
"""

from __future__ import annotations

import re

from xinas_history.models import Manifest
from xinas_menu.screens.snapshot_detail import _format_manifest


def _manifest(**kwargs) -> Manifest:
    """Minimal Manifest suitable for _format_manifest."""
    defaults = dict(
        id="20260601T120000Z-test",
        timestamp="2026-06-01T12:00:00Z",
        user="root",
        source="api",
        status="applied",
        type="rollback_eligible",
    )
    defaults.update(kwargs)
    return Manifest(**defaults)


def test_absent_files_line_present_when_non_empty():
    """When manifest.absent_files is non-empty, the detail shows the tombstone
    line with each file name."""
    m = _manifest(absent_files=["etc_exports", "netplan"])
    text = _format_manifest(m)
    # Strip ANSI codes for simpler assertions
    plain = re.sub(r"\033\[[0-9;]*m", "", text)
    assert "Absent files (will be deleted on restore)" in plain
    assert "etc_exports" in plain
    assert "netplan" in plain


def test_absent_files_line_omitted_when_empty():
    """When manifest.absent_files is empty (pre-S13 / no tombstones), the
    detail must NOT contain the absent-files section."""
    m = _manifest(absent_files=[])
    text = _format_manifest(m)
    plain = re.sub(r"\033\[[0-9;]*m", "", text)
    assert "Absent files" not in plain
    assert "will be deleted on restore" not in plain


def test_absent_files_single_entry():
    """A single absent file is rendered without trailing comma clutter."""
    m = _manifest(absent_files=["etc_exports"])
    text = _format_manifest(m)
    plain = re.sub(r"\033\[[0-9;]*m", "", text)
    assert "etc_exports" in plain
    # Should not have a trailing comma
    assert "etc_exports," not in plain
