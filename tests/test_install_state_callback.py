"""TDD for finding #2 (InstallationFeedback): per-role install-state.json.

The `xinas_install_state` Ansible callback plugin records role-by-role progress
to `/var/lib/xinas/install-state.json` so an interrupted install has a resume
signal ("what step did I last complete?"). The plugin's pure accumulator
(`_StateWriter`) is unit-tested here with a deterministic clock and a temp path;
the ansible-facing CallbackModule is a thin adapter over it.
"""

from __future__ import annotations

import importlib.util
import itertools
import json
from pathlib import Path

PLUGIN = (
    Path(__file__).resolve().parents[1]
    / "collection/callback_plugins/xinas_install_state.py"
)


def _state_writer_cls():
    # Load by path; the module guards its `ansible` import so this works without
    # ansible installed (CallbackBase falls back to object).
    spec = importlib.util.spec_from_file_location("xinas_install_state", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._StateWriter


def _make(tmp_path):
    clock = itertools.count(1)  # deterministic, monotonically increasing ts
    writer = _state_writer_cls()(str(tmp_path / "install-state.json"), clock=lambda: next(clock))
    return writer


def _read(tmp_path):
    return json.loads((tmp_path / "install-state.json").read_text())


def test_start_records_preset_and_running(tmp_path):
    w = _make(tmp_path)
    w.start(preset="xinnorVM")
    state = _read(tmp_path)
    assert state["preset"] == "xinnorVM"
    assert state["status"] == "running"
    assert state["roles"] == []


def test_role_transitions_mark_prior_role_ok(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default")
    w.role_running("common")
    w.role_running("doca_ofed")
    state = _read(tmp_path)
    by = {r["role"]: r["status"] for r in state["roles"]}
    assert by["common"] == "ok"  # completed when the next role started
    assert by["doca_ofed"] == "running"


def test_finish_success_marks_last_role_ok_and_completed(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default")
    for role in ("common", "raid_fs", "motd"):
        w.role_running(role)
    w.finish(failed=False)
    state = _read(tmp_path)
    assert state["status"] == "completed"
    assert all(r["status"] == "ok" for r in state["roles"])


def test_role_failed_marks_failed_and_persists(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default")
    w.role_running("common")
    w.role_running("xiraid_classic")
    w.role_failed("xiraid_classic")
    w.finish(failed=True)
    state = _read(tmp_path)
    assert state["status"] == "failed"
    failed = [r for r in state["roles"] if r["status"] == "failed"]
    assert [r["role"] for r in failed] == ["xiraid_classic"]


def test_writes_are_incremental(tmp_path):
    # Each transition flushes, so a kill mid-install still leaves a readable file.
    w = _make(tmp_path)
    w.start(preset="default")
    w.role_running("common")
    state = _read(tmp_path)  # readable before finish()
    assert state["roles"][0]["role"] == "common"
    assert "updated" in state
