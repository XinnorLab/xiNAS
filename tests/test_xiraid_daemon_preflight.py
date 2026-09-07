"""Regression guard for the `xiraid_classic` role's daemon preflight.

`xiraid_classic` used to verify only that the kernel module was loaded and
that `xicli -v` printed a version — neither needs the xiRAID daemon. A box
whose `xiraid.target` never came up therefore sails through the role and
only fails one role later, in `nvme_namespace`, as storage state UNKNOWN —
the message a host install log ended with on 2026-09-04 ("'xicli raid show'
failed (rc=2) — is xiraid-core running?"), which cannot tell a dead daemon
from a missing `xicli`. The role must bring the target up and prove the CLI
can read the array list before any storage role runs, failing with the
daemon named. Contract: docs/Installer/spec.md §3.4.

Structural assertions over the parsed task YAML, in the style of
tests/test_common_avx_preflight.py — the repo has no behavioral Ansible
harness.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
TASKS = REPO / "collection/roles/xiraid_classic/tasks/main.yml"

PROBE_CMD = "xicli raid show -f json"


def _top_level() -> list[dict]:
    return [t for t in yaml.safe_load(TASKS.read_text()) if isinstance(t, dict)]


def _flatten(tasks: list[dict], inherited: tuple[str, ...] = ()) -> list[dict]:
    """Depth-first list of every task, descending into block/rescue/always.

    Ansible applies a block's tags to every task inside it; each returned
    task carries that effective set under ``_effective_tags``.
    """
    out: list[dict] = []
    for t in tasks:
        own = t.get("tags", [])
        tags = tuple(dict.fromkeys((*inherited, *([own] if isinstance(own, str) else own))))
        out.append({**t, "_effective_tags": tags})
        for key in ("block", "rescue", "always"):
            if isinstance(t.get(key), list):
                out.extend(_flatten([x for x in t[key] if isinstance(x, dict)], tags))
    return out


def _find(pred) -> tuple[int, dict]:
    for idx, t in enumerate(_flatten(_top_level())):
        if pred(t):
            return idx, t
    raise AssertionError("no task matched")


def _start_target_task() -> tuple[int, dict]:
    def pred(t: dict) -> bool:
        mod = t.get("ansible.builtin.systemd") or t.get("ansible.builtin.systemd_service")
        return isinstance(mod, dict) and mod.get("name") == "xiraid.target"

    try:
        return _find(pred)
    except AssertionError:
        raise AssertionError("xiraid_classic has no systemd task for xiraid.target") from None


def _probe_task() -> tuple[int, dict]:
    def pred(t: dict) -> bool:
        cmd = t.get("ansible.builtin.command")
        if isinstance(cmd, dict):
            cmd = cmd.get("cmd", "")
        return isinstance(cmd, str) and PROBE_CMD in cmd

    try:
        return _find(pred)
    except AssertionError:
        raise AssertionError(f"xiraid_classic never runs `{PROBE_CMD}`") from None


def _module_check_task() -> tuple[int, dict]:
    return _find(lambda t: t.get("register") == "mod_check")


def _reboot_task() -> tuple[int, dict]:
    return _find(lambda t: "ansible.builtin.reboot" in t)


def _fail_tasks() -> list[dict]:
    return [t for t in _flatten(_top_level()) if "ansible.builtin.fail" in t]


def test_target_is_started_not_merely_inspected():
    _, task = _start_target_task()
    mod = task.get("ansible.builtin.systemd") or task["ansible.builtin.systemd_service"]
    assert mod.get("state") == "started", (
        "the preflight must converge xiraid.target to started; a postinst that "
        "did not start it is the case being fixed"
    )


def test_probe_is_the_same_command_the_storage_roles_rely_on():
    _, task = _probe_task()
    assert task.get("changed_when") is False, "a read-only probe must not report changed"
    assert task.get("failed_when") is not False, (
        "the probe must be allowed to fail — that failure is the whole point"
    )


def test_probe_retries_while_the_daemon_comes_up():
    _, task = _probe_task()
    assert "until" in task and "rc" in str(task["until"]), (
        "the probe must wait on rc == 0: the gRPC server binds a moment after "
        "xiraid.target reports active"
    )
    assert int(task.get("retries", 0)) >= 3
    assert int(task.get("delay", 0)) >= 1


def test_target_is_started_before_the_probe():
    start_idx, _ = _start_target_task()
    probe_idx, _ = _probe_task()
    assert start_idx < probe_idx


def test_preflight_runs_after_module_check_and_reboot():
    """It verifies the role's *final* state: after the module check, and after
    the optional post-install reboot, so a reboot never invalidates it."""
    mod_idx, _ = _module_check_task()
    reboot_idx, _ = _reboot_task()
    start_idx, _ = _start_target_task()
    probe_idx, _ = _probe_task()
    assert mod_idx < start_idx, "module check must precede the daemon preflight"
    assert reboot_idx < start_idx < probe_idx, (
        "the daemon preflight must be the last thing the role does, after any reboot"
    )


def test_failure_names_the_daemon_and_the_remedy():
    """The whole reason this preflight exists: a direct message in the role
    that owns xiRAID, instead of a storage-state UNKNOWN one role later."""
    msgs = [str(t["ansible.builtin.fail"]) for t in _fail_tasks()]
    assert any("xiraid.target" in m and "systemctl" in m for m in msgs), (
        "no fail task tells the operator to inspect xiraid.target with systemctl"
    )
    assert any("journalctl" in m for m in msgs), (
        "the message should point at the daemon's journal, where the real error is"
    )


def test_preflight_carries_the_role_tags():
    """`--tags xiraid` (and `verify`) must include it, like the sibling checks."""
    for _, task in (_start_target_task(), _probe_task()):
        tags = task["_effective_tags"]
        assert "xiraid" in tags and "verify" in tags, task.get("name")
