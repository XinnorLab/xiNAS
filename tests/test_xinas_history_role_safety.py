"""WS2.1: the xinas_history role must never delete the config-history store.

A day-2 `site.yml` re-run previously purged snapshots/baseline/state on every
role execution (remediation plan WS2, high). Structural regression guard in
the style of test_storage_role_structure.py.
"""

from pathlib import Path

import yaml

ROLE_TASKS = Path("collection/roles/xinas_history/tasks/main.yml")
STORE = "/var/lib/xinas/config-history"


def _raw_tasks() -> list:
    return yaml.safe_load(ROLE_TASKS.read_text())


def _iter_tasks(tasks):
    """Yield every task dict, recursing into `block:`/`rescue:`/`always:` lists.

    A future purge task could be nested inside a `block:` (e.g. wrapped for
    error handling) — a flat top-level-only walk would silently miss it and
    defeat the whole point of this regression guard. Mirrors the recursive
    walker in test_storage_role_structure.py.
    """
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        if isinstance(t.get("block"), list):
            yield from _iter_tasks(t["block"])
        if isinstance(t.get("rescue"), list):
            yield from _iter_tasks(t["rescue"])
        if isinstance(t.get("always"), list):
            yield from _iter_tasks(t["always"])


def _find_by_name(tasks, name: str) -> dict | None:
    for t in _iter_tasks(tasks):
        if t.get("name") == name:
            return t
    return None


def test_no_state_absent_on_store_path():
    for task in _iter_tasks(_raw_tasks()):
        file_mod = task.get("ansible.builtin.file") or task.get("file") or {}
        if not isinstance(file_mod, dict):
            continue
        path = str(file_mod.get("path", ""))
        if STORE in path:
            assert file_mod.get("state") != "absent", (
                f"task {task.get('name')!r} deletes {path} — the config-history "
                "store must survive role re-runs (WS2.1)"
            )


def test_store_dirs_created_idempotently():
    base_dir_tasks = []
    for task in _iter_tasks(_raw_tasks()):
        file_mod = task.get("ansible.builtin.file") or task.get("file")
        if not isinstance(file_mod, dict):
            continue
        if file_mod.get("state") == "directory" and str(file_mod.get("path", "")) == STORE:
            base_dir_tasks.append(task)
    assert base_dir_tasks, (
        f"expected a `state: directory` file task ensuring the exact base "
        f"store dir {STORE!r} — a substring match anywhere among directory "
        "paths is not enough to pin this"
    )


def test_baseline_snapshot_task_is_idempotent_across_reruns():
    """Companion guard for a regression this fix would otherwise introduce.

    Once the store is no longer wiped before this task runs (WS2.1),
    ``xinas-history snapshot create --type baseline`` on a second/day-2
    ``site.yml`` run hits an existing baseline: ``SnapshotEngine.create_baseline``
    raises ``ValueError("Baseline snapshot already exists")`` (see
    ``xinas_history/engine.py``), the CLI's top-level handler turns that into a
    non-zero exit, and this task has no ``failed_when`` override (deliberately,
    per the "Finding #13" comment in this same file) — so every subsequent
    ``site.yml`` re-run would fail outright here. Confirmed empirically against
    ``xinas_history/__main__.py`` before writing this guard. The task must be
    self-skipping once a baseline already exists on disk.
    """
    tasks = _raw_tasks()
    create_task = _find_by_name(tasks, "Create baseline snapshot")
    assert create_task is not None, "task 'Create baseline snapshot' not found"
    cmd_mod = create_task.get("ansible.builtin.command") or {}
    assert isinstance(cmd_mod, dict), (
        "expected ansible.builtin.command as a mapping (cmd + creates)"
    )
    creates = str(cmd_mod.get("creates", ""))
    assert creates == f"{STORE}/baseline/manifest.yml", (
        "Create baseline snapshot must guard on the baseline manifest path via "
        "`creates:` so it self-skips once a baseline already exists (WS2.1 rerun safety)"
    )
