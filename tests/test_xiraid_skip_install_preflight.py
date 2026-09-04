"""Regression guard for the `common` role's existing-install preflight.

`xiraid_skip_install: true` promises xiRAID is already on the host:
`playbooks/site.yml` skips the whole `xiraid_classic` role under it, so nothing
later in the run installs one. On v3.13.2-rc.4 a host reached `site.yml` with
that flag left over in the operator overlay *and* no xiRAID installed (the menu
had purged the packages at 12:13:57; the run started at 12:18). Nothing noticed
until `raid_fs`'s storage gate 50 tasks later, and the message it printed
pointed at `xiraid-core` — a service that was not installed either, because
Ansible's `command` module reports a missing executable as `rc=2` with empty
stdout/stderr, indistinguishable on rc alone from `xicli` exiting 2.

`common` must therefore verify the promise before the first `apt` call.
Contract: docs/Installer/spec.md §3.1.

Structural assertions over the parsed task YAML, in the style of
tests/test_common_avx_preflight.py — the repo has no behavioral Ansible harness.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
TASKS = REPO / "collection/roles/common/tasks/main.yml"


def _tasks() -> list[dict]:
    return [t for t in yaml.safe_load(TASKS.read_text()) if isinstance(t, dict)]


def _when(task: dict) -> str:
    when = task.get("when", [])
    if not isinstance(when, list):
        when = [when]
    return " ".join(str(w) for w in when)


def _probe_task() -> tuple[int, dict]:
    for idx, t in enumerate(_tasks()):
        if t.get("register") == "xinas_xicli_check":
            return idx, t
    raise AssertionError("common role has no task registering xinas_xicli_check")


def _fail_task() -> tuple[int, dict]:
    for idx, t in enumerate(_tasks()):
        if "ansible.builtin.fail" in t and "xinas_xicli_check" in _when(t):
            return idx, t
    raise AssertionError("common role has no fail task guarded on xinas_xicli_check")


def test_preflight_runs_before_the_first_apt_call():
    tasks = _tasks()
    first_apt = next(i for i, t in enumerate(tasks) if "ansible.builtin.apt" in t)
    probe_idx, _ = _probe_task()
    fail_idx, _ = _fail_task()
    assert probe_idx < fail_idx < first_apt, (
        "the existing-install preflight must look for xicli and fail before any apt task"
    )


def test_preflight_only_runs_when_the_install_is_being_skipped():
    for _, t in (_probe_task(), _fail_task()):
        when = _when(t)
        assert "xiraid_skip_install" in when, when
        assert "not (xiraid_skip_install" not in when, (
            "this preflight is the inverse of the AVX one: it applies exactly when "
            f"xiRAID is NOT being installed by this run — {when}"
        )


def test_probe_never_fails_the_play_on_its_own():
    _, t = _probe_task()
    assert t.get("changed_when") is False
    assert t.get("failed_when") is False, "a missing xicli must reach the fail task's message"
    assert "xicli" in str(t.get("ansible.builtin.shell", t.get("ansible.builtin.command", "")))


def test_failure_is_keyed_on_the_probe_not_finding_xicli():
    _, t = _fail_task()
    when = _when(t)
    assert "xinas_xicli_check.rc" in when, when
    assert "!= 0" in when or "not in" in when, when


def test_failure_message_names_the_flag_the_overlay_and_both_ways_out():
    _, t = _fail_task()
    msg = str(t["ansible.builtin.fail"]["msg"])
    assert "xiraid_skip_install" in msg
    assert "20-local.yml" in msg, "name the file the sticky flag actually lives in"
    assert "xicli" in msg
    assert "xiraid_classic" in msg, "say which role installs xiRAID once the flag is cleared"


def test_preflight_carries_the_same_tags_as_the_avx_one():
    for _, t in (_probe_task(), _fail_task()):
        assert set(t.get("tags", [])) >= {"preflight", "xiraid"}, t.get("tags")
