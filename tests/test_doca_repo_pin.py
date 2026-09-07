"""The DOCA-Host APT source is pinned to one release directory, never to
NVIDIA's moving ``latest`` alias, and every path that refreshes apt on an
installed host survives the alias having moved (docs/Installer/spec.md §3.2
and §8.5).

Background: on 2026-08-20 NVIDIA re-pointed ``doca/latest`` from DOCA-Host
3.4.0 to 3.5.0. apt refuses to follow a source whose release identity
(Suite/Codename) changed until told to (apt-get(8)
``--allow-releaseinfo-change``), so ``apt-get update`` exited 100 on every
host that had installed from ``latest``, and ``prepare_system.sh`` aborted the
install before Ansible ran.

Structural assertions over the role YAML and the shell scripts: the repo has
no molecule harness (see tests/test_raid_fs_safe_defaults.py).
"""

from __future__ import annotations

import re
from pathlib import Path

import jinja2
import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]

ROLES = {
    "server": REPO / "collection/roles/doca_ofed",
    "client": REPO / "client_repo/collection/roles/doca_ofed",
}
SOURCES_FILE = "/etc/apt/sources.list.d/mellanox-doca.list"
UNINSTALL_OFED = REPO / "collection/roles/xinas_uninstall/tasks/92_optional_ofed.yml"
COMMON_TASKS = REPO / "collection/roles/common/tasks/main.yml"
BOOTSTRAP_SCRIPTS = {
    "prepare_system.sh": REPO / "prepare_system.sh",
    "install.sh": REPO / "install.sh",
    "client_setup.sh": REPO / "client_repo/client_setup.sh",
}
RELEASE_DIR_RE = re.compile(r"^\d+\.\d+\.\d+$")
ALLOW_FLAG = "--allow-releaseinfo-change"


def _defaults(role: Path) -> dict:
    return yaml.safe_load((role / "defaults/main.yml").read_text()) or {}


def _tasks(path: Path) -> list:
    return yaml.safe_load(path.read_text()) or []


def _flatten(tasks):
    """Yield every task, descending into block/rescue/always."""
    for task in tasks:
        if not isinstance(task, dict):
            continue
        nested = False
        for section in ("block", "rescue", "always"):
            if section in task:
                nested = True
                yield from _flatten(task[section])
        if not nested:
            yield task


def _module_args(task: dict, module: str):
    """Return the args of *module* in *task* (short or FQCN form), else None."""
    for key in (module, f"ansible.builtin.{module}"):
        if key in task:
            return task[key]
    return None


def _render_vars(raw: dict) -> dict:
    """Resolve Ansible-style lazy templates in a defaults dict (a few passes
    suffice: doca_repo_component -> doca_distro_series -> a fact)."""
    env = jinja2.Environment(undefined=jinja2.StrictUndefined, autoescape=False)
    resolved = dict(raw)
    for _ in range(5):
        changed = False
        for key, value in list(resolved.items()):
            if isinstance(value, str) and "{{" in value:
                new = env.from_string(value).render(resolved)
                if new != value:
                    resolved[key] = new
                    changed = True
        if not changed:
            break
    return resolved


def _sources_task(role: Path) -> dict:
    for task in _flatten(_tasks(role / "tasks/main.yml")):
        args = _module_args(task, "copy")
        if isinstance(args, dict) and args.get("dest") == SOURCES_FILE:
            return task
    raise AssertionError(f"{role}: no copy task writes {SOURCES_FILE}")


# --- the pin -----------------------------------------------------------------


@pytest.mark.parametrize("role", ROLES.values(), ids=list(ROLES))
def test_doca_version_is_one_release_directory_not_an_alias(role: Path):
    version = _defaults(role).get("doca_version")
    assert isinstance(version, str) and RELEASE_DIR_RE.match(version), (
        f"{role}: doca_version={version!r} must be a release directory such as "
        "3.4.0 — `latest`, `lts` and `latest-<X.Y>-LTS` all re-point without "
        "notice and apt then refuses the source (spec §3.2)"
    )


def test_server_and_client_roles_pin_the_same_release():
    versions = {name: _defaults(role)["doca_version"] for name, role in ROLES.items()}
    assert len(set(versions.values())) == 1, versions


# --- the sources file is owned whole -----------------------------------------


@pytest.mark.parametrize("role", ROLES.values(), ids=list(ROLES))
def test_role_writes_the_sources_file_whole(role: Path):
    """`apt_repository` is add-only: it would keep a stale `latest` line beside
    the pinned one, and apt would keep failing on it. The role must own the
    file (copy) and no task may still use apt_repository."""
    task = _sources_task(role)
    assert task.get("register") == "repo_added", "cache refresh is gated on repo_added"
    args = _module_args(task, "copy")
    assert args.get("mode") == "0644"
    for other in _flatten(_tasks(role / "tasks/main.yml")):
        assert _module_args(other, "apt_repository") is None, (
            f"{role}: {other.get('name')!r} still uses apt_repository"
        )


@pytest.mark.parametrize("role", ROLES.values(), ids=list(ROLES))
def test_rendered_sources_line_targets_the_pinned_directory(role: Path):
    facts = {
        "ansible_distribution_version": "24.04",
        "ansible_kernel": "6.8.0-45-generic",
        "playbook_dir": "/opt/xiNAS/playbooks",
    }
    variables = _render_vars({**_defaults(role), **facts})
    content = _module_args(_sources_task(role), "copy")["content"]
    env = jinja2.Environment(undefined=jinja2.StrictUndefined, autoescape=False)
    lines = [
        line
        for line in env.from_string(content).render(variables).splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    version = variables["doca_version"]
    assert lines == [
        f"deb https://linux.mellanox.com/public/repo/doca/{version}/ubuntu24.04/x86_64 /"
    ]
    assert "/latest/" not in content


def test_uninstaller_removes_the_file_the_role_writes():
    for task in _flatten(_tasks(UNINSTALL_OFED)):
        args = _module_args(task, "file")
        if isinstance(args, dict) and args.get("path") == SOURCES_FILE:
            assert args.get("state") == "absent"
            return
    raise AssertionError(f"uninstaller no longer removes {SOURCES_FILE}")


# --- refreshes on an already-installed host ----------------------------------


@pytest.mark.parametrize("script", BOOTSTRAP_SCRIPTS.values(), ids=list(BOOTSTRAP_SCRIPTS))
def test_every_bootstrap_apt_refresh_accepts_a_release_info_change(script: Path):
    """Accepting once is durable (apt stores the new release file), which is
    what carries a host installed from `latest` through the rest of the
    install (spec §8.5)."""
    offenders = [
        f"{script.name}:{n}: {line.strip()}"
        for n, line in enumerate(script.read_text().splitlines(), 1)
        if re.search(r"\bapt-get update\b", line)
        and not line.lstrip().startswith("#")
        and ALLOW_FLAG not in line
    ]
    assert not offenders, "\n".join(offenders)


def test_common_cache_refresh_retries_once_accepting_a_release_info_change():
    """The TUI update runs ansible-playbook with no bootstrap in front of it,
    and `common` refreshes apt before doca_ofed can re-pin the source."""
    for task in _tasks(COMMON_TASKS):
        if not isinstance(task, dict) or "block" not in task:
            continue
        inner = list(_flatten(task["block"]))
        if not any(
            isinstance(_module_args(t, "apt"), dict) and _module_args(t, "apt").get("update_cache")
            for t in inner
        ):
            continue
        rescue = list(_flatten(task.get("rescue") or []))
        commands = [
            str(_module_args(t, "command"))
            for t in rescue
            if _module_args(t, "command") is not None
        ]
        assert any(f"apt-get update {ALLOW_FLAG}" in c for c in commands), commands
        assert "packages" in (task.get("tags") or []), "block must keep the packages tag"
        return
    raise AssertionError("common: no block/rescue around the apt cache refresh")
