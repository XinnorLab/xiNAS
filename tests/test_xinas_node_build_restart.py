"""Regression guards for the ``xinas_node_build`` -> dist/-consumer handoff.

``xinas-api`` and ``xinas-agent`` are Node processes launched from
``xiNAS-MCP/dist/``. Node reads that JavaScript once, at process start, so
``npm run build`` rewriting ``dist/`` changes nothing about what the running
daemons execute. Nothing else restarts them for a change confined to
``xiNAS-MCP/src``: the ``xinas_api`` / ``xinas_agent`` handlers fire only when
*those* roles' own unit/config tasks report changed.

That gap shipped v3.8.0. The release carried ``Requires-Rebuild:
xinas_node_build``, the rebuild ran, and both daemons kept serving the
pre-update build -- including the ``raid_show`` ``size`` parse fix, so
``usable_capacity_bytes`` stayed absent from every ``GET /api/v1/arrays`` row
and the TUI rendered every array's capacity as "N/A". The update reported
success throughout.

These tests pin the contract so it cannot silently regress. Everything is
validated as parsed YAML -- no host, no Ansible run.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
ROLE = REPO_ROOT / "collection/roles/xinas_node_build"
TASKS = ROLE / "tasks/main.yml"
HANDLERS = ROLE / "handlers/main.yml"
SPEC = REPO_ROOT / "docs/Installer/update-spec.md"

#: The units that run code out of ``dist/``, in required restart order --
#: the api first, because ``xinas-agent`` declares ``Requires=xinas-api``.
DIST_CONSUMERS = ["xinas-api.service", "xinas-agent.service"]

#: Handler names owned by OTHER roles. Ansible resolves a duplicate handler
#: name to the last definition in the play, so reusing one of these here
#: would silently dispatch to that role's handler instead.
FOREIGN_HANDLER_NAMES = {"Restart xinas-api", "Restart xinas-agent", "Reload systemd"}


def _tasks() -> list[dict]:
    return yaml.safe_load(TASKS.read_text()) or []


def _handlers() -> list[dict]:
    return yaml.safe_load(HANDLERS.read_text()) or []


def _build_task() -> dict:
    for task in _tasks():
        cmd = task.get("ansible.builtin.command")
        if isinstance(cmd, dict) and "npm run build" in str(cmd.get("cmd", "")):
            return task
    pytest.fail(f"no `npm run build` task found in {TASKS}")


def _notify_topics(task: dict) -> list[str]:
    notify = task.get("notify")
    if notify is None:
        return []
    return [notify] if isinstance(notify, str) else list(notify)


# --------------------------------------------------------------------------- #
# The build must notify, and the notify must resolve
# --------------------------------------------------------------------------- #
def test_handlers_file_exists() -> None:
    """Without handlers/main.yml the notify below is an unresolved topic."""
    assert HANDLERS.is_file(), f"{HANDLERS} is missing"


def test_build_task_notifies() -> None:
    """A rebuild that notifies nothing leaves both daemons on the old code."""
    assert _notify_topics(_build_task()), (
        "`npm run build` must notify the dist/-consumer restart handlers; "
        "without it a TypeScript-only release rebuilds dist/ and the running "
        "xinas-api / xinas-agent keep executing the previous build (v3.8.0)."
    )


def test_notify_topics_resolve_to_handlers() -> None:
    """Every notified topic must match a handler name or `listen` topic."""
    known: set[str] = set()
    for handler in _handlers():
        if name := handler.get("name"):
            known.add(name)
        listen = handler.get("listen")
        if isinstance(listen, str):
            known.add(listen)
        elif isinstance(listen, list):
            known.update(listen)
    unresolved = [t for t in _notify_topics(_build_task()) if t not in known]
    assert not unresolved, f"notify topics with no handler in {HANDLERS}: {unresolved}"


# --------------------------------------------------------------------------- #
# The handlers must restart both consumers, api first
# --------------------------------------------------------------------------- #
def test_both_dist_consumers_are_restarted() -> None:
    """Restarting only one of the two leaves the other serving stale code."""
    restarted = [
        systemd.get("name")
        for handler in _handlers()
        if isinstance(systemd := handler.get("ansible.builtin.systemd"), dict)
        and systemd.get("state") == "restarted"
    ]
    for unit in DIST_CONSUMERS:
        assert unit in restarted, f"{unit} is never restarted by {HANDLERS}"


def test_api_restarts_before_agent() -> None:
    """Handlers run in definition order; the agent Requires= the api."""
    order = [
        systemd.get("name")
        for handler in _handlers()
        if isinstance(systemd := handler.get("ansible.builtin.systemd"), dict)
        and systemd.get("name") in DIST_CONSUMERS
    ]
    assert order == DIST_CONSUMERS, (
        f"handler order is {order}; xinas-api must be restarted before "
        "xinas-agent, which declares Requires=xinas-api.service"
    )


def test_handler_names_do_not_collide_with_other_roles() -> None:
    """Ansible resolves a duplicate handler name to the LAST definition.

    A handler named "Restart xinas-api" here would be shadowed by the
    xinas_api role's handler of that name, and this role's notify would
    dispatch there instead -- past the guard below.
    """
    collisions = [
        name for handler in _handlers() if (name := handler.get("name")) in FOREIGN_HANDLER_NAMES
    ]
    assert not collisions, (
        f"handler names collide with another role's handlers: {collisions}. "
        "Ansible resolves duplicates to the last definition in the play."
    )


# --------------------------------------------------------------------------- #
# The restart must be skippable, not fatal, where the units are absent
# --------------------------------------------------------------------------- #
def test_restart_handlers_are_guarded_on_the_unit_existing() -> None:
    """`state: restarted` against an unknown unit is a hard failure.

    xinas_node_build runs BEFORE xinas_api / xinas_agent in site.yml, so on
    a first install neither unit exists yet when the build fires.
    """
    for handler in _handlers():
        systemd = handler.get("ansible.builtin.systemd")
        if not isinstance(systemd, dict) or systemd.get("name") not in DIST_CONSUMERS:
            continue
        assert handler.get("when"), (
            f"handler {handler.get('name')!r} restarts {systemd.get('name')} "
            "unconditionally; it must be guarded on the unit being installed"
        )


def test_guard_facts_are_registered_before_the_build() -> None:
    """The handler `when:` reads a stat registered by the role itself.

    An undefined variable there would make the guard raise instead of skip.
    """
    registered: set[str] = set()
    for task in _tasks():
        if "ansible.builtin.stat" in task and (var := task.get("register")):
            registered.add(var)
        if isinstance(cmd := task.get("ansible.builtin.command"), dict) and "npm run build" in str(
            cmd.get("cmd", "")
        ):
            break  # only facts registered BEFORE the build are guaranteed set

    for handler in _handlers():
        systemd = handler.get("ansible.builtin.systemd")
        if not isinstance(systemd, dict) or systemd.get("name") not in DIST_CONSUMERS:
            continue
        when = str(handler.get("when", ""))
        assert any(var in when for var in registered), (
            f"handler {handler.get('name')!r} guards on {when!r}, which no "
            f"stat task registers before the build; registered: {sorted(registered)}"
        )


def test_stat_tasks_share_the_build_tag() -> None:
    """`--tags xinas_node_build` must run the stats, not just the build.

    A stat skipped by the tag filter leaves its variable undefined and the
    handler guard raises on a run that is otherwise the whole point of this
    role -- the update flow invokes exactly that tag.
    """
    build_tags = set(_build_task().get("tags") or [])
    for task in _tasks():
        if "ansible.builtin.stat" not in task:
            continue
        if not str(task.get("register", "")).startswith("_xinas_node_build_"):
            continue
        missing = build_tags - set(task.get("tags") or [])
        assert not missing, f"stat task {task.get('name')!r} is missing tags {sorted(missing)}"


# --------------------------------------------------------------------------- #
# Spec parity
# --------------------------------------------------------------------------- #
def test_update_spec_documents_the_restart() -> None:
    """The behavior contract lives in the update spec, per the spec-first rule."""
    text = SPEC.read_text()
    assert "Rebuilding dist/ restarts its consumers" in text, (
        f"{SPEC} must carry the section describing the dist/-consumer restart"
    )
