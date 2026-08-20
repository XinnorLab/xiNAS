"""Every xiNAS role writes sysctls to a drop-in it owns — never to /etc/sysctl.conf.

``ansible.builtin.sysctl`` with ``reload: yes`` runs ``sysctl -p <sysctl_file>``,
which re-applies *every* key in that file and fails the task on any one of them.
While ``common`` and ``perf_tuning`` shared the module's default file
(``/etc/sysctl.conf``), ``perf_tuning``'s ``sunrpc.tcp_max_slot_table_entries``
line aborted the ``common`` role on any host that had not loaded the ``sunrpc``
kernel module::

    TASK [common : Apply sysctl parameters] ***
    failed: msg="Failed to reload sysctl: ... sysctl: cannot stat
    /proc/sys/sunrpc/tcp_max_slot_table_entries: No such file or directory"

``perf_tuning`` survived its own key via ``ignoreerrors: yes``; ``common`` had no
such flag. The uninstaller made it reproducible by stripping only ``common``'s
three keys from ``/etc/sysctl.conf`` and leaving the SunRPC line for the next
install to trip over.

Guards, per docs/Installer/spec.md §3.1/§3.12 and uninstall-spec.md §4.8/§3.3:
role ownership of the drop-ins, drop-in ordering, the SunRPC stat gate, the
legacy ``/etc/sysctl.conf`` purge, and the matching uninstall reverts.

Everything is validated as parsed YAML -- no host, no Ansible run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
ROLES = REPO_ROOT / "collection/roles"

COMMON_FILE = "/etc/sysctl.d/80-xinas-common.conf"
PERF_NET_FILE = "/etc/sysctl.d/90-perf-net.conf"
PERF_VM_FILE = "/etc/sysctl.d/90-perf-vm.conf"
SUNRPC_KEY = "sunrpc.tcp_max_slot_table_entries"
SUNRPC_PROC = "/proc/sys/sunrpc/tcp_max_slot_table_entries"
MODULES_LOAD = "/etc/modules-load.d/xinas-sunrpc.conf"

SYSCTL_MODULES = ("sysctl", "ansible.builtin.sysctl", "ansible.posix.sysctl")
STAT_MODULES = ("stat", "ansible.builtin.stat")

# Everything xiNAS <= 3.10.2 wrote into the shared /etc/sysctl.conf.
LEGACY_KEYS = (
    "net.core.rmem_max",
    "net.core.wmem_max",
    "net.core.netdev_max_backlog",
    "net.core.somaxconn",
    "net.ipv4.tcp_rmem",
    "net.ipv4.tcp_wmem",
    "vm.swappiness",
    SUNRPC_KEY,
)


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


def _role_tasks(role: str) -> list[dict]:
    out: list[dict] = []
    for path in sorted((ROLES / role / "tasks").glob("*.yml")):
        out.extend(_tasks(path))
    return out


def _module(task: dict, names: tuple[str, ...]) -> dict | None:
    for name in names:
        if isinstance(task.get(name), dict):
            return task[name]
    return None


def _all_sysctl_tasks() -> list[tuple[Path, dict, dict]]:
    found = []
    for path in sorted(ROLES.glob("*/tasks/*.yml")):
        for task in _tasks(path):
            args = _module(task, SYSCTL_MODULES)
            if args is not None:
                found.append((path, task, args))
    return found


def _loop_items(task: dict) -> list[dict]:
    loop = task.get("loop") or task.get("with_items") or []
    return [i for i in loop if isinstance(i, dict)] if isinstance(loop, list) else []


# ---------------------------------------------------------------------------
# The invariant: no role may write to the module's default /etc/sysctl.conf
# ---------------------------------------------------------------------------


def test_no_role_writes_to_the_shared_sysctl_conf():
    offenders = [
        f"{path.relative_to(REPO_ROOT)}: {task.get('name')!r}"
        for path, task, args in _all_sysctl_tasks()
        if not str(args.get("sysctl_file", "")).strip()
    ]
    assert not offenders, (
        "these sysctl tasks fall back to the shared /etc/sysctl.conf and would "
        "reload keys they do not own: " + "; ".join(offenders)
    )


def test_every_sysctl_file_is_a_xinas_owned_dropin():
    for path, task, args in _all_sysctl_tasks():
        target = str(args["sysctl_file"])
        assert target.startswith("/etc/sysctl.d/"), (
            f"{path.relative_to(REPO_ROOT)}: {task.get('name')!r} writes to {target}"
        )


# ---------------------------------------------------------------------------
# Ownership + ordering
# ---------------------------------------------------------------------------


def test_common_owns_the_baseline_dropin():
    targets = {
        str(args["sysctl_file"])
        for _, task, args in _all_sysctl_tasks()
        if "common/tasks" in str(_)
    }
    assert targets == {COMMON_FILE}


def test_perf_tuning_network_keys_live_in_the_perf_net_dropin():
    targets = {
        str(args["sysctl_file"])
        for path, task, args in _all_sysctl_tasks()
        if path.parts[-3] == "perf_tuning"
    }
    assert targets == {PERF_NET_FILE, PERF_VM_FILE}


def test_baseline_dropin_sorts_before_the_perf_dropins():
    # `sysctl --system` applies /etc/sysctl.d/*.conf in lexical order, so the
    # 80- baseline must load before the 90- perf files for the perf values to
    # win at boot (docs/Installer/spec.md §3.1).
    base = Path(COMMON_FILE).name
    for perf in (Path(PERF_NET_FILE).name, Path(PERF_VM_FILE).name):
        assert base < perf, f"{base} must sort before {perf}"


# ---------------------------------------------------------------------------
# The SunRPC gate
# ---------------------------------------------------------------------------


def _sunrpc_item() -> tuple[dict, dict]:
    for path, task, args in _all_sysctl_tasks():
        if path.parts[-3] != "perf_tuning":
            continue
        for item in _loop_items(task):
            if item.get("key") == SUNRPC_KEY:
                return task, item
        if str(args.get("name", "")) == SUNRPC_KEY:
            return task, {}
    pytest.fail(f"no perf_tuning sysctl task sets {SUNRPC_KEY}")


def test_sunrpc_key_is_gated_on_the_proc_path_existing():
    task, item = _sunrpc_item()
    assert item, (
        f"{SUNRPC_KEY} must be a gated loop item carrying `supported:`, not a "
        "standalone task — a standalone task cannot purge a stale line"
    )
    supported = str(item.get("supported", ""))
    assert supported, f"{SUNRPC_KEY} loop item is missing a `supported:` gate"

    # The gate must drive both `state` (absent purges a stale line) and `reload`.
    args = _module(task, SYSCTL_MODULES)
    assert args is not None
    assert "supported" in str(args.get("state", "")), "state must derive from `supported`"
    assert "supported" in str(args.get("reload", "")), "reload must derive from `supported`"

    # And `supported` must trace back to a stat of the real /proc path.
    stats = [
        t
        for t in _role_tasks("perf_tuning")
        if (a := _module(t, STAT_MODULES)) and str(a.get("path")) == SUNRPC_PROC
    ]
    assert stats, f"perf_tuning must stat {SUNRPC_PROC}"
    register = str(stats[0].get("register", ""))
    assert register and register in supported, (
        f"the `supported:` gate must reference the {register!r} stat register"
    )


def test_sunrpc_module_is_loaded_early_enough_to_survive_a_reboot():
    # systemd-sysctl runs long before nfs-kernel-server loads sunrpc, so the
    # key only persists across a reboot if a modules-load.d drop-in exists.
    text = "\n".join(p.read_text() for p in sorted((ROLES / "perf_tuning" / "tasks").glob("*.yml")))
    assert MODULES_LOAD in text, f"perf_tuning must write {MODULES_LOAD}"


# ---------------------------------------------------------------------------
# Migration: purge the legacy keys from the shared file
# ---------------------------------------------------------------------------


def _legacy_purge_index(tasks: list[dict]) -> int:
    for idx, task in enumerate(tasks):
        args = _module(task, ("lineinfile", "ansible.builtin.lineinfile"))
        if args and str(args.get("path")) == "/etc/sysctl.conf":
            return idx
    return -1


def test_common_purges_legacy_keys_from_sysctl_conf_before_writing_its_dropin():
    tasks = _role_tasks("common")
    purge_idx = _legacy_purge_index(tasks)
    assert purge_idx >= 0, "common must strip the legacy keys from /etc/sysctl.conf"

    sysctl_idx = next(idx for idx, t in enumerate(tasks) if _module(t, SYSCTL_MODULES) is not None)
    assert purge_idx < sysctl_idx, (
        "the purge must run before the sysctl task, otherwise the play still "
        "aborts on the stale SunRPC line before reaching it"
    )

    purge = _module(tasks[purge_idx], ("lineinfile", "ansible.builtin.lineinfile"))
    assert purge is not None
    assert str(purge.get("state")) == "absent"
    patterns = "".join(str(i) for i in (tasks[purge_idx].get("loop") or []))
    for key in LEGACY_KEYS:
        assert key.replace(".", r"\.") in patterns, f"purge is missing {key}"


# ---------------------------------------------------------------------------
# Uninstall symmetry
# ---------------------------------------------------------------------------


def test_uninstall_removes_the_baseline_dropin_unconditionally():
    text = (ROLES / "xinas_uninstall/tasks/80_revert_inplace_edits.yml").read_text()
    assert COMMON_FILE in text


def test_uninstall_purges_every_legacy_key_from_sysctl_conf():
    tasks = _tasks(ROLES / "xinas_uninstall/tasks/80_revert_inplace_edits.yml")
    idx = _legacy_purge_index(tasks)
    assert idx >= 0, "uninstall must strip the legacy keys from /etc/sysctl.conf"
    patterns = "".join(str(i) for i in (tasks[idx].get("loop") or []))
    for key in LEGACY_KEYS:
        assert key.replace(".", r"\.") in patterns, (
            f"uninstall leaves {key} in /etc/sysctl.conf — exactly the state that "
            "made the next install fail"
        )


def test_uninstall_perf_phase_removes_the_perf_net_dropin_and_modules_load():
    text = (ROLES / "xinas_uninstall/tasks/93_optional_perf.yml").read_text()
    assert PERF_NET_FILE in text
    assert MODULES_LOAD in text
