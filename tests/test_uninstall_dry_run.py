"""`uninstall.sh --dry-run` must survive `--check` *and* still say what it would remove.

Ansible skips `command`/`shell` under `--check` and hands the task's register a
synthetic result: ``{"rc": 0, "stdout": "", "skipped": true, ...}``. Two things
follow, and Phase C hit both:

1. ``(_xicli_raid_show.stdout | default('{}')) | from_json`` fed ``from_json``
   an *empty string*. Jinja's ``default()`` substitutes only for an **undefined**
   value, and ``stdout`` here is defined-but-empty, so the fallback never fired
   and every dry run died at::

       TASK [xinas_uninstall : RAID | parse array names]
       the field 'args' has an invalid value ...
       The error was: Expecting value: line 1 column 1 (char 0)

   Fix: ``default('{}', true)`` — the second argument also replaces falsy values.

2. Even without the crash, ``rc: 0`` + empty stdout reads as "xicli is installed
   and owns no arrays". The dry run would have completed against no data at all
   and reported nothing to tear down — which is the entire point of ``--dry-run``.
   Fix: ``check_mode: false`` on the read-only discovery commands so they really
   run under ``--check``.

The destructive half of the role must keep honouring check mode, so the
``check_mode: false`` allowlist below is exhaustive on purpose.

Spec: docs/Installer/uninstall-spec.md §2.1.1 (dry-run contract) and §4.3.

The structural half of this module is parsed YAML — no host, no Ansible run.
The behavioural half replays the role's real Jinja through the check-mode
register shape, the way tests/test_storage_state_fail_closed.py does, so a
"fix" that only re-words the template cannot pass.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml

jinja2 = pytest.importorskip("jinja2")
from jinja2 import ChainableUndefined  # noqa: E402
from jinja2.nativetypes import NativeEnvironment  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/xinas_uninstall"
TEARDOWN = ROLE / "tasks/30_teardown_raid.yml"
MOUNTS = ROLE / "tasks/40_remove_mounts.yml"
PATHS = ROLE / "tasks/70_remove_paths.yml"
FINALIZE = ROLE / "tasks/99_finalize.yml"
RESOLVE_DISKS = REPO / "collection/roles/nvme_namespace/tasks/resolve_system_disks.yml"
UNINSTALL_SH = REPO / "uninstall.sh"

SET_FACT = "ansible.builtin.set_fact"

# Read-only probes. Each one only *looks* at the host, so forcing it to run
# under --check costs nothing and is the only way the dry run learns anything.
READ_ONLY_DISCOVERY = [
    (TEARDOWN, "RAID | locate xicli"),
    (TEARDOWN, "RAID | list current arrays"),
    (TEARDOWN, "RAID | list current pools"),
    (MOUNTS, "Mounts | find xiNAS-generated mount units"),
    (PATHS, "Paths | check whether /etc/issue.net is xiNAS-managed"),
]

# The report scratch file (/tmp) is written even under --check, otherwise
# uninstall.sh has nothing to render at the end of a dry run.
REPORT_ARTIFACT = (FINALIZE, "Finalize | write summary JSON for the bash wrapper")

# Anything that changes the host must stay skippable.
DESTRUCTIVE = [
    (TEARDOWN, "RAID | stop systemd mount units before raid delete"),
    (TEARDOWN, "RAID | delete xiNAS-managed arrays"),
    (TEARDOWN, "RAID | delete xiNAS-managed spare pools"),
    (TEARDOWN, "RAID | clean every non-OS NVMe device once arrays are gone"),
    (FINALIZE, "Finalize | also write a persistent uninstall log"),
]


# --- YAML helpers ----------------------------------------------------------


def _walk(node: Any) -> Iterator[dict]:
    """Yield every task-shaped mapping, descending through block/rescue/always."""
    if isinstance(node, list):
        for item in node:
            yield from _walk(item)
    elif isinstance(node, dict):
        if "name" in node or any(k in node for k in ("block", "rescue", "always")):
            yield node
        for key in ("block", "rescue", "always"):
            if key in node:
                yield from _walk(node[key])


def _tasks(path: Path) -> list[dict]:
    return list(_walk(yaml.safe_load(path.read_text()) or []))


def _task(path: Path, name: str) -> dict:
    for task in _tasks(path):
        if task.get("name") == name:
            return task
    pytest.fail(f"{path.relative_to(REPO)}: no task named {name!r} — did it get renamed?")


def _role_task_files() -> list[Path]:
    return sorted((ROLE / "tasks").glob("*.yml"))


# --- check_mode: false, exactly where it belongs ---------------------------


@pytest.mark.parametrize(
    ("path", "name"),
    READ_ONLY_DISCOVERY,
    ids=[name for _, name in READ_ONLY_DISCOVERY],
)
def test_read_only_discovery_runs_under_check(path: Path, name: str):
    task = _task(path, name)
    assert task.get("check_mode") is False, (
        f"{name!r} is a read-only probe; without `check_mode: false` a dry run "
        "skips it, gets back rc=0 with empty stdout, and reports that there is "
        "nothing to remove"
    )


def test_the_report_artifact_is_written_under_check():
    path, name = REPORT_ARTIFACT
    task = _task(path, name)
    assert task.get("check_mode") is False, (
        f"{name!r} writes the /tmp scratch file uninstall.sh reads back; under "
        "check mode copy() no-ops and the dry run ends with 'No summary ... the "
        "playbook may have exited early' instead of the report"
    )


@pytest.mark.parametrize(("path", "name"), DESTRUCTIVE, ids=[name for _, name in DESTRUCTIVE])
def test_destructive_tasks_still_honour_check_mode(path: Path, name: str):
    task = _task(path, name)
    assert task.get("check_mode", None) is not False, (
        f"{name!r} changes the host — `check_mode: false` would make --dry-run apply it for real"
    )


def test_check_mode_false_is_confined_to_the_allowlist():
    """A future dry-run failure must not be 'fixed' by force-running a teardown."""
    allowed = {name for _, name in READ_ONLY_DISCOVERY} | {REPORT_ARTIFACT[1]}
    offenders = [
        f"{path.relative_to(REPO)}: {task.get('name')!r}"
        for path in _role_task_files()
        for task in _tasks(path)
        if task.get("check_mode") is False and task.get("name") not in allowed
    ]
    assert not offenders, (
        "these tasks opt out of check mode without being read-only probes or the "
        "report artifact: " + "; ".join(offenders)
    )


def test_the_os_disk_resolver_runs_under_check():
    """Phase C aborts fail-closed when the OS disk cannot be resolved.

    The resolver lives in nvme_namespace and is pulled in with `tasks_from`. If
    it ever loses its own `check_mode: false`, a dry run resolves no system disk
    and Phase C's fail-closed guard aborts the whole --dry-run.
    """
    task = _task(RESOLVE_DISKS, "Resolve physical disks hosting the OS")
    assert task.get("check_mode") is False


# --- no empty payload may reach from_json ----------------------------------


TRUTHY_DEFAULT = re.compile(r"default\(\s*[^)]*,\s*true\s*\)")
PIPES_INTO_FROM_JSON = re.compile(r"\|\s*from_json")


def test_every_from_json_in_the_role_is_fed_a_truthy_default():
    offenders = []
    for path in _role_task_files():
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if not PIPES_INTO_FROM_JSON.search(line):
                continue
            if not TRUTHY_DEFAULT.search(line):
                offenders.append(f"{path.relative_to(REPO)}:{lineno}: {line.strip()}")
    assert not offenders, (
        "from_json fed without a truthy default — an empty stdout/file raises "
        "'Expecting value: line 1 column 1 (char 0)' and kills the run: " + "; ".join(offenders)
    )


# --- behavioural replay of the parse expressions ---------------------------


def _env() -> Any:
    env = NativeEnvironment(undefined=ChainableUndefined)
    env.filters["from_json"] = json.loads
    env.filters["b64decode"] = lambda v: base64.b64decode(v).decode()
    return env


ENV = _env()

# (task name, fact it sets, register it reads, how the payload is delivered)
LIVE_PARSES = [
    ("RAID | parse array names", "_xinas_array_names", "_xicli_raid_show"),
    ("RAID | parse pool names", "_xinas_pool_names", "_xicli_pool_show"),
]
BASELINE_PARSES = [
    ("RAID | parse baseline-captured array names", "_xinas_baseline_array_names", "raid"),
    ("RAID | parse baseline-captured pool names", "_xinas_baseline_pool_names", "pool"),
]


def _render(task_name: str, fact: str, context: dict) -> Any:
    expr = _task(TEARDOWN, task_name)[SET_FACT][fact]
    return ENV.from_string(expr).render(**context)


def _live(task_name: str, fact: str, register: str, stdout: str) -> Any:
    # The shape Ansible hands back for a *skipped* command carries rc=0 and an
    # empty stdout — the exact input that used to blow up.
    return _render(task_name, fact, {register: {"rc": 0, "stdout": stdout, "skipped": True}})


def _baseline(task_name: str, fact: str, kind: str, payload: str) -> Any:
    register = f"_xinas_baseline_{kind}_show"
    content = base64.b64encode(payload.encode()).decode()
    return _render(task_name, fact, {register: {"content": content}})


@pytest.mark.parametrize(("task_name", "fact", "register"), LIVE_PARSES)
@pytest.mark.parametrize("stdout", ["", "   \n", "\n"], ids=["empty", "spaces", "newline"])
def test_empty_stdout_parses_to_no_names_instead_of_crashing(
    task_name: str, fact: str, register: str, stdout: str
):
    """The reported regression: this raised instead of returning []."""
    assert _live(task_name, fact, register, stdout) == []


@pytest.mark.parametrize(("task_name", "fact", "register"), LIVE_PARSES)
def test_mapping_payload_yields_the_live_names(task_name: str, fact: str, register: str):
    # `xicli raid show -f json` returns an object keyed by array name.
    payload = json.dumps({"data": {"level": "5"}, "log": {"level": "10"}})
    assert _live(task_name, fact, register, payload) == ["data", "log"]


@pytest.mark.parametrize(("task_name", "fact", "register"), LIVE_PARSES)
def test_list_payload_yields_the_live_names(task_name: str, fact: str, register: str):
    payload = json.dumps([{"name": "data"}, {"name": "log"}])
    assert _live(task_name, fact, register, payload) == ["data", "log"]


@pytest.mark.parametrize(("task_name", "fact", "kind"), BASELINE_PARSES)
def test_empty_baseline_capture_parses_to_no_names(task_name: str, fact: str, kind: str):
    """A truncated 0-byte capture slurps to content='' — defined, so the
    `content is defined` gate lets it through to from_json."""
    assert _baseline(task_name, fact, kind, "") == []


@pytest.mark.parametrize(("task_name", "fact", "kind"), BASELINE_PARSES)
def test_baseline_capture_yields_its_names(task_name: str, fact: str, kind: str):
    payload = json.dumps({"data": {"level": "5"}, "log": {"level": "10"}})
    assert _baseline(task_name, fact, kind, payload) == ["data", "log"]


@pytest.mark.parametrize(("task_name", "fact", "kind"), BASELINE_PARSES)
def test_baseline_collector_error_yields_no_names(task_name: str, fact: str, kind: str):
    payload = json.dumps({"error": "xicli not found"})
    assert _baseline(task_name, fact, kind, payload) == []


# --- the wrapper -----------------------------------------------------------


def test_dry_run_passes_check_to_ansible():
    assert "--check" in UNINSTALL_SH.read_text()


def test_wrapper_clears_a_stale_summary_before_running():
    """The renderer keys off the file's existence. Now that a dry run writes it
    too, a leftover file would otherwise be printed as a later run's result."""
    src = UNINSTALL_SH.read_text()
    run_at = src.index('ansible-playbook "${ANSIBLE_ARGS[@]}"')
    assert 'rm -f "$SUMMARY_PATH"' in src[:run_at], (
        "uninstall.sh must delete the summary scratch file before invoking the playbook, not after"
    )
