"""Tests for ``xinas_history snapshot create --format json`` (S2 T6).

The agent task runner's xinas_history bridge invokes
``python3 -m xinas_history snapshot create --source <s> --operation <op>
--format json`` and parses ``{"id": "..."}`` from stdout. These tests pin
that JSON contract at the CLI handler boundary, using a fake engine so the
test never touches gRPC or the live system.
"""

import argparse
import io
import json
from contextlib import redirect_stdout

from xinas_history.__main__ import _cmd_snapshot_create
from xinas_history.models import Manifest


class _FakeEngine:
    """Stand-in SnapshotEngine that records the create call and returns a
    fixed Manifest, so the CLI's output shaping can be tested in isolation."""

    def __init__(self, manifest: Manifest):
        self._manifest = manifest
        self.create_calls: list[dict] = []

    async def create_snapshot(self, **kwargs):
        self.create_calls.append(kwargs)
        return self._manifest

    async def create_baseline(self, **kwargs):
        self.create_calls.append(kwargs)
        return self._manifest


def _make_args(**overrides) -> argparse.Namespace:
    base = {
        "source": "api",
        "operation": "reference_echo",
        "preset": "",
        "type": "rollback_eligible",
        "summary": None,
        "format": "text",
    }
    base.update(overrides)
    return argparse.Namespace(**base)


def _manifest() -> Manifest:
    return Manifest(
        id="20260605T120000Z-reference-echo",
        timestamp="2026-06-05T12:00:00Z",
        user="root",
        source="api",
        operation="reference_echo",
    )


def test_snapshot_create_json_emits_parseable_id():
    manifest = _manifest()
    engine = _FakeEngine(manifest)
    args = _make_args(format="json")

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = _cmd_snapshot_create(args, engine)

    assert rc == 0
    payload = json.loads(buf.getvalue())
    assert payload == {"id": manifest.id}


def test_snapshot_create_text_still_prints_bare_id():
    manifest = _manifest()
    engine = _FakeEngine(manifest)
    args = _make_args(format="text")

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = _cmd_snapshot_create(args, engine)

    assert rc == 0
    # Text mode is unchanged: a bare id line (not JSON).
    assert buf.getvalue().strip() == manifest.id
