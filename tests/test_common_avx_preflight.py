"""Regression guard for the `common` role's AVX preflight.

xiRAID's `xiraid-kmod` package refuses to install on a CPU without the `avx`
flag (its pre-install script aborts with "The CPU flag is not supported:
avx"), but `xiraid_classic` is the fourth role in `playbooks/site.yml`, so on
a VM whose CPU model hides AVX the install first spent ~20 minutes installing
DOCA-OFED and only then died in `apt` (host install log, 2026-09-02). The
`common` role must check the flag before its first `apt` call and fail with
the fix named. Contract: docs/Installer/spec.md §3.1.

Structural assertions over the parsed task YAML, in the style of
tests/test_nvme_namespace_fallback.py — the repo has no behavioral Ansible
harness.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/common"
TASKS = ROLE / "tasks/main.yml"
DEFAULTS = ROLE / "defaults/main.yml"


def _tasks() -> list[dict]:
    return [t for t in yaml.safe_load(TASKS.read_text()) if isinstance(t, dict)]


def _when(task: dict) -> str:
    when = task.get("when", [])
    if not isinstance(when, list):
        when = [when]
    return " ".join(str(w) for w in when)


def _fail_task() -> tuple[int, dict]:
    for idx, t in enumerate(_tasks()):
        if "ansible.builtin.fail" in t and "avx" in str(t.get("name", "")).lower():
            return idx, t
    raise AssertionError("common role has no AVX preflight fail task")


def _flags_task() -> tuple[int, dict]:
    for idx, t in enumerate(_tasks()):
        if t.get("register") == "xinas_cpu_flags":
            return idx, t
    raise AssertionError("common role has no task registering xinas_cpu_flags")


def test_preflight_fails_before_the_first_apt_call():
    tasks = _tasks()
    first_apt = next(i for i, t in enumerate(tasks) if "ansible.builtin.apt" in t)
    fail_idx, _ = _fail_task()
    flags_idx, _ = _flags_task()
    assert flags_idx < fail_idx < first_apt, (
        "the AVX preflight must read the flags and fail before any apt task runs"
    )


def test_preflight_reads_the_flags_line_from_a_configurable_path():
    _, t = _flags_task()
    cmd = str(t.get("ansible.builtin.command", ""))
    assert "^flags" in cmd and "xinas_cpuinfo_path" in cmd, cmd
    assert t.get("changed_when") is False
    assert t.get("failed_when") is False, "an unreadable flags line must reach the fail task"


def test_preflight_checks_the_avx_flag_as_a_whole_word():
    _, t = _fail_task()
    when = _when(t)
    assert "'avx' not in" in when, when
    assert ".split()" in when, "match the whole flag, not a substring of avx2/avx512"
    assert "xinas_cpu_flags.stdout" in when, when


def test_preflight_is_skipped_on_the_existing_raid_path():
    for _, t in (_flags_task(), _fail_task()):
        assert "xiraid_skip_install" in _when(t), _when(t)


def test_preflight_has_an_override_knob_defaulting_to_on():
    defaults = yaml.safe_load(DEFAULTS.read_text())
    assert defaults.get("xinas_require_avx") is True
    assert defaults.get("xinas_cpuinfo_path") == "/proc/cpuinfo"
    for _, t in (_flags_task(), _fail_task()):
        assert "xinas_require_avx" in _when(t), _when(t)


def test_preflight_message_is_actionable():
    _, t = _fail_task()
    msg = str(t["ansible.builtin.fail"]["msg"])
    assert "AVX" in msg
    assert "The CPU flag is not supported: avx" in msg, "quote the preinst error the operator saw"
    assert "-cpu host" in msg, "name the hypervisor-side fix"
    assert "xinas_require_avx" in msg, "name the override"


def test_preflight_runs_under_the_xiraid_tag():
    for _, t in (_flags_task(), _fail_task()):
        assert "xiraid" in t.get("tags", []), "`--tags xiraid` must run the preflight too"
