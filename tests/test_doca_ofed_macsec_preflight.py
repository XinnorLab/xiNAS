"""Regression guard for the ``doca_ofed`` roles' ``macsec`` preflight.

DOCA-Host's DKMS ``mlx5_ib`` needs symbols from the in-tree ``macsec``
module. On an Ubuntu 24.04.5 cloud image (kernel 6.8.0-142-generic, DOCA-Host
3.4.0, 2026-10-19) ``openibd`` failed with ``mlx5_ib: Unknown symbol
macsec_netdev_is_offloaded``: ``macsec.ko`` ships in
``linux-modules-extra-<kernel>``, which the virtual kernel metapackage does
not pull in. Before installing DOCA the role must check ``macsec`` for the
running kernel and every installed kernel version, add
``linux-modules-extra-<kernel>`` where apt has a candidate, re-check, and fail
before DOCA otherwise. Contract: docs/Installer/spec.md §3.2 *Kernel module
prerequisite*; the client role applies it under its NIC gate,
docs/Client/client-setup-spec.md §5.2.

Every check runs against both the server role and the client role. Everything
is validated as parsed YAML -- no host, no Ansible run -- in the style of
tests/test_doca_ofed_handler_order.py. The kernel-version extraction is checked
by applying the role's own ``sed`` expression with Python's ``re``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_TASKS = REPO_ROOT / "collection/roles/doca_ofed/tasks/main.yml"
CLIENT_TASKS = REPO_ROOT / "client_repo/collection/roles/doca_ofed/tasks/main.yml"

PREFLIGHT_TAGS = {"ofed", "deps", "install"}
NIC_GATE = "mlx_nic_check.rc == 0"


@pytest.fixture(params=[SERVER_TASKS, CLIENT_TASKS], ids=["server", "client"])
def tasks(request) -> list[dict]:
    return [t for t in yaml.safe_load(request.param.read_text()) if isinstance(t, dict)]


def _client_tasks() -> list[dict]:
    return [t for t in yaml.safe_load(CLIENT_TASKS.read_text()) if isinstance(t, dict)]


def _index(tasks: list[dict], predicate) -> tuple[int, dict]:
    for idx, t in enumerate(tasks):
        if predicate(t):
            return idx, t
    raise AssertionError("expected task not found in the doca_ofed role")


def _register(tasks: list[dict], name: str):
    return _index(tasks, lambda t: t.get("register") == name)


def _doca_install(tasks: list[dict]):
    return _index(tasks, lambda t: str(t.get("name", "")).startswith("Install DOCA-OFED packages"))


def _extra_install(tasks: list[dict]):
    def installs_extra(t: dict) -> bool:
        apt = t.get("ansible.builtin.apt") or {}
        return "linux-modules-extra-" in str(apt.get("name", ""))

    return _index(tasks, installs_extra)


def _macsec_fail(tasks: list[dict]):
    return _index(
        tasks,
        lambda t: "ansible.builtin.fail" in t and "macsec" in str(t["ansible.builtin.fail"]),
    )


def _kernel_list_script(tasks: list[dict]) -> str:
    _, task = _register(tasks, "doca_ofed_kernels")
    return str(task.get("ansible.builtin.shell", ""))


def _version_regex(tasks: list[dict]) -> re.Pattern[str]:
    """The ERE the role's sed uses to read a kernel version from a package name."""
    m = re.search(r"sed -nE 's/(\^linux-image-.*?\$)/\\2/p'", _kernel_list_script(tasks))
    assert m, "the kernel list must extract versions with sed -nE 's/<re>/\\2/p'"
    return re.compile(m.group(1))


def _preflight(tasks: list[dict]):
    return [
        _register(tasks, "doca_ofed_kernels"),
        _register(tasks, "doca_ofed_macsec_before"),
        _register(tasks, "doca_ofed_extra_candidates"),
        _extra_install(tasks),
        _register(tasks, "doca_ofed_macsec_after"),
        _macsec_fail(tasks),
    ]


@pytest.mark.parametrize(
    ("package", "kernel"),
    [
        ("linux-image-6.8.0-147-generic", "6.8.0-147-generic"),
        ("linux-image-unsigned-6.8.0-142-generic", "6.8.0-142-generic"),
        ("linux-image-7.0.0-38-generic", "7.0.0-38-generic"),
        ("linux-image-virtual", None),
        ("linux-image-generic-hwe-24.04", None),
    ],
)
def test_kernel_versions_come_from_versioned_image_packages_only(tasks, package, kernel):
    m = _version_regex(tasks).match(package)
    assert (m.group(2) if m else None) == kernel


def test_the_running_kernel_is_always_checked(tasks):
    assert "{{ ansible_kernel }}" in _kernel_list_script(tasks)


def test_the_list_reads_only_installed_packages(tasks):
    script = _kernel_list_script(tasks)
    assert "${db:Status-Abbrev}" in script
    assert "/^[ih]i/" in script, "installed and installed-but-held packages, nothing else"
    assert "!~ /-dbgsym$/" in script, "debug-symbol packages never yield a kernel"


def test_a_host_without_versioned_image_packages_still_checks_its_kernel(tasks):
    script = _kernel_list_script(tasks)
    assert "2>/dev/null || true; }" in script, (
        "dpkg-query exits 1 when nothing matches; with pipefail that must not fail the task"
    )


def test_the_preflight_runs_in_order_before_any_doca_package(tasks):
    indices = [idx for idx, _ in _preflight(tasks)]
    doca_idx, _ = _doca_install(tasks)
    assert indices == sorted(indices), (
        "list, check, look up, install, re-check, fail — in that order"
    )
    assert indices[-1] < doca_idx


def test_checks_are_per_kernel_and_never_fail_by_themselves(tasks):
    for name in ("doca_ofed_macsec_before", "doca_ofed_macsec_after"):
        _, task = _register(tasks, name)
        assert task["ansible.builtin.command"] == "modinfo -k {{ item }} -n macsec"
        assert "doca_ofed_kernels.stdout_lines" in str(task.get("loop", ""))
        assert task.get("failed_when") is False
        assert task.get("changed_when") is False


def test_the_candidate_lookup_reads_apt_policy(tasks):
    _, task = _register(tasks, "doca_ofed_extra_candidates")
    cmd = str(task.get("ansible.builtin.shell", ""))
    assert "apt-cache policy linux-modules-extra-" in cmd
    assert "Candidate:" in cmd
    assert "selectattr('rc', 'ne', 0)" in str(task.get("loop", ""))


def test_extra_modules_are_installed_only_where_apt_has_a_candidate(tasks):
    _, task = _extra_install(tasks)
    assert task["ansible.builtin.apt"].get("state") == "present"
    loop = str(task.get("loop", ""))
    assert "doca_ofed_extra_candidates.results" in loop
    assert "'(none)'" in loop


def test_the_failure_names_the_kernels_and_the_module(tasks):
    _, task = _macsec_fail(tasks)
    msg = str(task["ansible.builtin.fail"].get("msg", ""))
    assert "macsec" in msg
    assert "join(" in msg, "the message lists the kernels that lack the module"
    assert "doca_ofed_macsec_after" in str(task.get("when", ""))


@pytest.mark.parametrize("position", range(6))
def test_every_preflight_task_carries_the_ofed_deps_and_install_tags(tasks, position):
    _, task = _preflight(tasks)[position]
    assert set(task.get("tags", [])) >= PREFLIGHT_TAGS


# --- client only: the NIC gate (docs/Client/client-setup-spec.md §5.1, §5.2) ---


@pytest.mark.parametrize("position", range(6))
def test_every_client_preflight_task_is_gated_on_a_mellanox_nic(position):
    _, task = _preflight(_client_tasks())[position]
    when = task.get("when", [])
    when = when if isinstance(when, list) else [when]
    assert NIC_GATE in [str(w).strip() for w in when]


def test_the_client_nic_detection_runs_under_the_preflight_tags():
    _, task = _register(_client_tasks(), "mlx_nic_check")
    assert set(task.get("tags", [])) >= {"ofed", "detect", "deps", "install"}, (
        "a run limited to deps or install must still define mlx_nic_check"
    )


def test_client_loops_tolerate_a_skipped_nic_gate():
    """Ansible evaluates ``loop`` before ``when``: on a client without a Mellanox NIC
    the registered results are skipped, so every loop over them needs a default."""
    for idx, task in _preflight(_client_tasks()):
        loop = str(task.get("loop", ""))
        if "doca_ofed_" in loop:
            assert "default([])" in loop, f"client preflight task {idx} loops without a default"
