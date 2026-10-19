"""Regression guard for the `common` role's kernel hold.

The role used to hold a fixed `linux-image-generic`. On an Ubuntu 24.04.5
cloud image, which carries `linux-image-virtual` instead, `dpkg_selections`
failed with "Failed to find package 'linux-image-generic' to perform selection
'hold'" and the install stopped in `common` (2026-10-19). The role must hold
every installed kernel image metapackage, read from package facts by a name
pattern, and warn instead of failing when there is none.
Contract: docs/Installer/spec.md §3.1 *Kernel held*.

Structural assertions over the parsed task YAML, in the style of
tests/test_common_avx_preflight.py. The selection itself is checked by
rendering the role's own `set_fact` expression with Jinja's NativeEnvironment,
as tests/test_storage_state_fail_closed.py does, with Ansible's `match` and
`search` tests supplied as `re.match` and `re.search` (their Ansible
definitions).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

jinja2 = pytest.importorskip("jinja2")
from jinja2 import StrictUndefined  # noqa: E402
from jinja2.nativetypes import NativeEnvironment  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/common"
TASKS = ROLE / "tasks/main.yml"
DEFAULTS = ROLE / "defaults/main.yml"

SET_FACT = "ansible.builtin.set_fact"


def _tasks() -> list[dict]:
    return [t for t in yaml.safe_load(TASKS.read_text()) if isinstance(t, dict)]


def _defaults() -> dict:
    return yaml.safe_load(DEFAULTS.read_text())


def _index(predicate) -> tuple[int, dict]:
    for idx, t in enumerate(_tasks()):
        if predicate(t):
            return idx, t
    raise AssertionError("expected task not found in the common role")


def _facts_task():
    return _index(lambda t: "ansible.builtin.package_facts" in t)


def _select_task():
    return _index(lambda t: "common_kernel_hold_packages" in (t.get(SET_FACT) or {}))


def _hold_task():
    return _index(lambda t: "ansible.builtin.dpkg_selections" in t)


def _warn_task():
    return _index(
        lambda t: (
            "ansible.builtin.debug" in t and "common_kernel_hold_packages" in str(t.get("when", ""))
        )
    )


def _env() -> Any:
    env = NativeEnvironment(undefined=StrictUndefined)
    env.tests["match"] = lambda value, pattern: re.match(pattern, value) is not None
    env.tests["search"] = lambda value, pattern: re.search(pattern, value) is not None
    return env


def _select(installed: list[str]) -> list[str]:
    """Render the role's selection expression against an installed-package list."""
    _, task = _select_task()
    expr = task[SET_FACT]["common_kernel_hold_packages"].strip()
    context = dict(_defaults())
    context["ansible_facts"] = {"packages": {name: [{"version": "1"}] for name in installed}}
    return _env().from_string(expr).render(**context)


@pytest.mark.parametrize(
    ("installed", "held"),
    [
        (
            ["linux-generic", "linux-image-generic", "linux-image-6.8.0-142-generic"],
            ["linux-image-generic"],
        ),
        (
            ["linux-virtual", "linux-image-virtual", "linux-image-6.8.0-142-generic"],
            ["linux-image-virtual"],
        ),
        (
            [
                "linux-image-generic",
                "linux-image-generic-hwe-24.04",
                "linux-image-7.0.0-38-generic",
            ],
            ["linux-image-generic", "linux-image-generic-hwe-24.04"],
        ),
        (
            [
                "linux-image-generic-hwe-24.04-edge",
                "linux-image-unsigned-6.8.0-142-generic",
                "linux-image-unsigned-6.8.0-142-generic-dbgsym",
            ],
            ["linux-image-generic-hwe-24.04-edge"],
        ),
        (["linux-image-6.8.0-142-generic", "linux-headers-generic", "curl"], []),
        ([], []),
    ],
)
def test_the_held_set_is_the_installed_metapackages(installed, held):
    assert _select(installed) == held


def test_no_task_names_a_fixed_kernel_package():
    for t in _tasks():
        assert "linux-image-generic" not in str(t.get("ansible.builtin.dpkg_selections", "")), (
            "the hold must come from the installed set, never a fixed package name"
        )


def test_facts_are_gathered_before_the_selection_and_the_hold():
    facts_idx, facts = _facts_task()
    select_idx, _ = _select_task()
    hold_idx, _ = _hold_task()
    assert facts_idx < select_idx < hold_idx
    assert facts["ansible.builtin.package_facts"].get("manager") == "apt"


def test_each_selected_package_is_held():
    _, task = _hold_task()
    assert task["ansible.builtin.dpkg_selections"] == {
        "name": "{{ item }}",
        "selection": "hold",
    }
    assert task.get("loop") == "{{ common_kernel_hold_packages }}"


def test_an_empty_set_warns_instead_of_failing():
    _, task = _warn_task()
    assert "length == 0" in str(task["when"])
    msg = str(task["ansible.builtin.debug"].get("msg", ""))
    assert msg.startswith("WARNING")
    assert "not held" in msg


@pytest.mark.parametrize("finder", [_facts_task, _select_task, _hold_task, _warn_task])
def test_every_kernel_hold_task_carries_the_kernel_tag(finder):
    _, task = finder()
    assert "kernel" in task.get("tags", [])
