"""Regression guard for the `common` role's unattended-upgrades reboot policy.

The role used to hard-code ``Unattended-Upgrade::Automatic-Reboot "true"``:
on 2026-10-20 xinas-rc-vm (v3.14.0-rc.1) upgraded git at 06:09, found
/var/run/reboot-required and rebooted itself at 06:10, dropping every NFS
client. The reboot is now a knob that defaults to off, with an optional
maintenance time. Making the fix reach updating hosts needed two more
changes, pinned here too: every task carries the `common` tag (otherwise
``Requires-Rebuild: common`` runs nothing), and the sysctl task no longer
reloads from the task (a re-run would drop perf_tuning's live values), with
the legacy /etc/sysctl.conf strip gated on perf_tuning's drop-ins.
Contract: docs/Installer/spec.md §3.1 (*Role tag*, *Unattended upgrades*,
*`common` does not reload from the task*, *Migration*), FEAT-INST-02.

Structural assertions over the parsed role, plus the real template and
the assert's expressions rendered with Jinja2 set up the way Ansible's
template module sets it up -- the repo has no behavioral Ansible harness.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import jinja2
import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/common"
TASKS = ROLE / "tasks/main.yml"
DEFAULTS = ROLE / "defaults/main.yml"
TEMPLATE = ROLE / "templates/unattended-upgrades.conf.j2"

DEPLOY_NAME = "Deploy unattended-upgrades configuration"
TIME_VAR = "common_unattended_reboot_time"
SPEC_PHRASE = "must be a quoted 24-hour HH:MM string"
PERF_DROPINS = {"/etc/sysctl.d/90-perf-net.conf", "/etc/sysctl.d/90-perf-vm.conf"}

BASE_LINES = [
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
]


def _ansible_bool(value: Any) -> bool:
    # ansible-core's `bool` filter: true/yes/on/1 (any case) are true, the rest false.
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("yes", "on", "true", "1")
    return value == 1


def _ansible_match(value: Any, pattern: str) -> bool:
    # ansible's `match` test is re.match; it raises on a non-string, which is
    # why the assert must test `is string` first and short-circuit.
    return re.match(pattern, value) is not None


def _env() -> jinja2.Environment:
    # Ansible's template module renders with trim_blocks=True.
    env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, autoescape=False)
    env.filters["bool"] = _ansible_bool
    env.tests["match"] = _ansible_match
    return env


def _top_tasks() -> list[dict]:
    return [t for t in yaml.safe_load(TASKS.read_text()) if isinstance(t, dict)]


def _defaults() -> dict:
    return yaml.safe_load(DEFAULTS.read_text())


def _lines(**overrides: Any) -> list[str]:
    variables = {**_defaults(), **overrides}
    out = _env().from_string(TEMPLATE.read_text()).render(**variables)
    return [ln for ln in out.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def _find(predicate) -> tuple[int, dict]:
    for idx, t in enumerate(_top_tasks()):
        if predicate(t):
            return idx, t
    raise AssertionError("task not found")


def _assert_task() -> tuple[int, dict]:
    return _find(lambda t: "ansible.builtin.assert" in t and TIME_VAR in str(t))


def _deploy_task() -> tuple[int, dict]:
    return _find(lambda t: t.get("name") == DEPLOY_NAME)


def _when(task: dict) -> list[str]:
    when = task.get("when", [])
    return [str(w) for w in (when if isinstance(when, list) else [when])]


def _truthy(expr: str, variables: dict) -> bool:
    return _ansible_bool(_env().from_string("{{ (" + expr + ") }}").render(**variables).strip())


# ---------------------------------------------------------------------------
# Defaults and the rendered file
# ---------------------------------------------------------------------------


def test_defaults_keep_the_node_from_rebooting_itself():
    defaults = _defaults()
    assert defaults.get("common_unattended_reboot") is False
    assert defaults.get("common_unattended_reboot_time") == ""


def test_default_render_is_exactly_the_three_spec_lines():
    assert _lines() == [*BASE_LINES, 'Unattended-Upgrade::Automatic-Reboot "false";']


def test_knob_on_without_a_time_reboots_immediately():
    assert _lines(common_unattended_reboot=True) == [
        *BASE_LINES,
        'Unattended-Upgrade::Automatic-Reboot "true";',
    ]


def test_knob_on_with_a_time_adds_the_reboot_time_line():
    assert _lines(common_unattended_reboot=True, common_unattended_reboot_time="02:00") == [
        *BASE_LINES,
        'Unattended-Upgrade::Automatic-Reboot "true";',
        'Unattended-Upgrade::Automatic-Reboot-Time "02:00";',
    ]


@pytest.mark.parametrize("time", ["02:00", "24:00", 1320])
def test_knob_off_never_renders_a_time(time):
    lines = _lines(common_unattended_reboot=False, common_unattended_reboot_time=time)
    assert not any("Automatic-Reboot-Time" in ln for ln in lines), lines
    assert 'Unattended-Upgrade::Automatic-Reboot "false";' in lines


def test_null_time_is_empty():
    lines = _lines(common_unattended_reboot=True, common_unattended_reboot_time=None)
    assert not any("Automatic-Reboot-Time" in ln for ln in lines), lines


KNOB_CASES = [
    ("yes", "true"),
    ("true", "true"),
    ("on", "true"),
    ("false", "false"),
    ("no", "false"),
    ("maybe", "false"),
]


@pytest.mark.parametrize(("knob", "expected"), KNOB_CASES)
def test_string_knob_values_render_like_ansible_bool(knob, expected):
    line = f'Unattended-Upgrade::Automatic-Reboot "{expected}";'
    assert line in _lines(common_unattended_reboot=knob)


# ---------------------------------------------------------------------------
# The time assert
# ---------------------------------------------------------------------------


def _assert_outcome(knob: Any, time: Any) -> str:
    """Replay the assert task: 'skipped', 'pass' or 'fail' (never an exception)."""
    _, task = _assert_task()
    variables = {**_defaults(), "common_unattended_reboot": knob, TIME_VAR: time}
    if not all(_truthy(w, variables) for w in _when(task)):
        return "skipped"
    that = task["ansible.builtin.assert"]["that"]
    for cond in that if isinstance(that, list) else [that]:
        if not _truthy(str(cond), variables):
            return "fail"
    return "pass"


@pytest.mark.parametrize("time", ["00:00", "02:00", "09:59", "22:00", "23:59"])
def test_assert_accepts_a_quoted_24_hour_time(time):
    assert _assert_outcome(True, time) == "pass"


@pytest.mark.parametrize("time", ["", None])
def test_assert_skips_an_empty_time(time):
    assert _assert_outcome(True, time) == "skipped"


@pytest.mark.parametrize("time", ["24:00", "2:00", "now", "+5", "02:00:00", "22:60", " 02:00"])
def test_assert_rejects_a_malformed_time(time):
    assert _assert_outcome(True, time) == "fail"


@pytest.mark.parametrize("time", [1320, 600])
def test_assert_rejects_an_unquoted_time_that_yaml_loaded_as_an_integer(time):
    # YAML 1.1 (PyYAML, which Ansible uses) reads unquoted 22:00 as base-60 1320.
    assert _assert_outcome(True, time) == "fail"


def test_assert_is_skipped_while_the_reboot_is_off():
    assert _assert_outcome(False, "24:00") == "skipped"
    assert _assert_outcome("false", 1320) == "skipped"


def test_assert_message_names_the_variable_and_says_to_quote_it():
    _, task = _assert_task()
    msg = str(task["ansible.builtin.assert"]["fail_msg"])
    assert TIME_VAR in msg
    assert SPEC_PHRASE in msg, "the §5 failure row quotes this phrase"
    assert "common_unattended_reboot" in msg.replace(TIME_VAR, ""), (
        "name the way out that keeps the node from rebooting"
    )


def test_assert_runs_before_the_template_under_the_same_tags():
    a_idx, a_task = _assert_task()
    d_idx, d_task = _deploy_task()
    assert a_idx < d_idx, "check the time before rendering the file"
    for t in (a_task, d_task):
        assert {"security", "common"} <= set(t.get("tags", [])), t.get("tags")


def test_template_task_writes_20auto_upgrades():
    _, task = _deploy_task()
    args = task["ansible.builtin.template"]
    assert args["src"] == "unattended-upgrades.conf.j2"
    assert args["dest"] == "/etc/apt/apt.conf.d/20auto-upgrades"


# ---------------------------------------------------------------------------
# `Requires-Rebuild: common` must run the role
# ---------------------------------------------------------------------------


def test_every_task_carries_the_common_tag():
    # site.yml lists the role without tags and Ansible does not tag a role's
    # tasks with its name, so `--tags common` runs only tasks tagged `common`.
    # A block's tags are inherited by its children, so a tagged block counts.
    missing = []

    def visit(node: Any, inherited: set[str]) -> None:
        for task in node if isinstance(node, list) else []:
            if not isinstance(task, dict):
                continue
            tags = task.get("tags", [])
            tags = inherited | set(tags if isinstance(tags, list) else [tags])
            if any(k in task for k in ("block", "rescue", "always")):
                for key in ("block", "rescue", "always"):
                    visit(task.get(key, []), tags)
            elif "common" not in tags:
                missing.append(task.get("name"))

    visit(yaml.safe_load(TASKS.read_text()), set())
    assert not missing, f"tasks without the `common` tag: {missing}"


# ---------------------------------------------------------------------------
# A re-run must not undo perf_tuning
# ---------------------------------------------------------------------------


def test_sysctl_task_does_not_reload_from_the_task():
    # ansible.posix.sysctl's `reload` defaults to true and then compares the
    # *live* value too, so on a perf-tuned host every run reloaded the 80-
    # baseline alone. The handler (`sysctl -e --system`) applies the drop-ins.
    _, task = _find(lambda t: "ansible.builtin.sysctl" in t)
    assert task["ansible.builtin.sysctl"].get("reload") is False
    assert task.get("notify") == "Reload sysctl"


def _is_legacy_strip(task: dict) -> bool:
    args = task.get("ansible.builtin.lineinfile")
    return isinstance(args, dict) and args.get("path") == "/etc/sysctl.conf"


def test_legacy_strip_is_gated_on_both_perf_dropins():
    stat_idx, stat = _find(lambda t: "ansible.builtin.stat" in t and "90-perf" in str(t))
    assert set(stat.get("loop", [])) == PERF_DROPINS, stat.get("loop")
    register = stat["register"]

    strip_idx, strip = _find(_is_legacy_strip)
    assert stat_idx < strip_idx
    for t in (stat, strip):
        assert {"sysctl", "common"} <= set(t.get("tags", [])), t.get("tags")

    def gate(exists: list[bool]) -> bool:
        results = {register: {"results": [{"stat": {"exists": e}} for e in exists]}}
        return all(_truthy(w, results) for w in _when(strip))

    assert gate([True, True]) is True
    assert gate([True, False]) is False, "a half-migrated host keeps its legacy keys"
    assert gate([False, True]) is False
    assert gate([False, False]) is False, "a <= 3.10.2-layout host keeps its legacy keys"
