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

PLUGIN = Path(__file__).resolve().parents[1] / "collection/callback_plugins/xinas_install_state.py"


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


# ── Post-install role report inputs (docs/Installer/spec.md §2.9 / §7.7) ──────


def test_start_records_the_expected_role_list(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default", expected=["common", "doca_ofed", "xiraid_classic"])
    assert _read(tmp_path)["expected"] == ["common", "doca_ofed", "xiraid_classic"]


def test_task_results_are_counted_per_role(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default", expected=["common"])
    w.role_running("common")
    w.task_result("common", "ok")
    w.task_result("common", "changed")
    w.task_result("common", "skipped")
    w.task_result("common", "failed")
    tasks = _read(tmp_path)["roles"][0]["tasks"]
    assert tasks == {"ok": 1, "changed": 1, "skipped": 1, "failed": 1}


def test_role_whose_every_task_was_skipped_ends_as_skipped_not_ok(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default", expected=["xiraid_classic", "nvme_namespace"])
    w.role_running("xiraid_classic")
    for _ in range(3):
        w.task_result("xiraid_classic", "skipped")
    w.role_running("nvme_namespace")  # closes xiraid_classic
    assert _read(tmp_path)["roles"][0]["status"] == "skipped"


def test_last_role_all_skipped_is_skipped_at_finish(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default", expected=["motd"])
    w.role_running("motd")
    w.task_result("motd", "skipped")
    w.finish(failed=False)
    state = _read(tmp_path)
    assert state["roles"][0]["status"] == "skipped"
    assert state["status"] == "completed"


def test_role_with_any_executed_task_stays_ok(tmp_path):
    w = _make(tmp_path)
    w.start(preset="default", expected=["common", "doca_ofed"])
    w.role_running("common")
    w.task_result("common", "skipped")
    w.task_result("common", "ok")
    w.role_running("doca_ofed")
    assert _read(tmp_path)["roles"][0]["status"] == "ok"


def test_task_result_for_an_unstarted_role_is_ignored(tmp_path):
    # A stray result (e.g. a handler attributed to a role that never had a
    # task start) must not invent a roles[] entry.
    w = _make(tmp_path)
    w.start(preset="default", expected=["common"])
    w.task_result("ghost", "ok")
    assert _read(tmp_path)["roles"] == []


# ── preset resolution (spec §7.7: the state file's preset is never null) ─────


def _module():
    spec = importlib.util.spec_from_file_location("xinas_install_state", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_autoinstall_var_wins():
    mod = _module()
    assert (
        mod._resolve_preset({"xinas_install_preset": "xinnorVM", "preset": "default"}) == "xinnorVM"
    )


def test_tui_preset_var_is_second():
    mod = _module()
    assert mod._resolve_preset({"preset": "existing-raid"}) == "existing-raid"


def test_blank_vars_fall_through(tmp_path):
    mod = _module()
    (tmp_path / "playbooks").mkdir()
    (tmp_path / ".xinas_applied_preset").write_text("xinnorVM\n")
    allvars = {
        "xinas_install_preset": "  ",
        "preset": "",
        "playbook_dir": str(tmp_path / "playbooks"),
    }
    assert mod._resolve_preset(allvars) == "xinnorVM"


def test_bash_menu_marker_beside_the_checkout_is_third(tmp_path):
    """The bash menus pass no variable; apply_preset leaves a marker instead."""
    mod = _module()
    (tmp_path / "playbooks").mkdir()
    (tmp_path / ".xinas_applied_preset").write_text("xinnorVM\n")
    assert mod._resolve_preset({"playbook_dir": str(tmp_path / "playbooks")}) == "xinnorVM"


def test_no_preset_anywhere_is_default(tmp_path):
    """The xinas-box case: bash-menu install, no preset applied → 'default', not None."""
    mod = _module()
    (tmp_path / "playbooks").mkdir()
    assert mod._resolve_preset({"playbook_dir": str(tmp_path / "playbooks")}) == "default"
    assert mod._resolve_preset({}) == "default"
    assert mod.DEFAULT_PRESET == "default"


def test_unreadable_or_empty_marker_is_default(tmp_path):
    mod = _module()
    (tmp_path / "playbooks").mkdir()
    (tmp_path / ".xinas_applied_preset").write_text("   \n")
    assert mod._resolve_preset({"playbook_dir": str(tmp_path / "playbooks")}) == "default"
    (tmp_path / ".xinas_applied_preset").unlink()
    (tmp_path / ".xinas_applied_preset").mkdir()  # a directory: open() raises OSError
    assert mod._resolve_preset({"playbook_dir": str(tmp_path / "playbooks")}) == "default"
