"""Client startup checklist + storage-network predicate.

docs/Client/client-setup-spec.md §3-§4.

Two regressions are guarded here:

* ``Connect to NAS`` gated on the existence of
  ``/etc/netplan/99-xinas-client.yaml`` — the file the client's *own* wizard
  writes. A host whose storage network came from cloud-init, a hand-written
  netplan, or DHCP was told "Network Not Configured" even with a share
  already mounted. §3.1: the file's presence is evidence, its absence is not.
* The five-line startup checklist carried no state at all, on the one screen
  whose job is telling a new user where to start. §4.2.

Functions are pulled live out of ``client_repo/client_setup.sh`` so a
regression in the real script cannot leave these passing for the wrong
reason — same approach as tests/test_client_nfs_tuning_dropins.py.
"""

import re
import subprocess
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLIENT_SETUP = REPO / "client_repo" / "client_setup.sh"

_REQUIRED = (
    "storage_network_pending",
    "checklist_state",
)
_OPTIONAL = (
    "storage_network_has_ip",
    "nfs_mount_count",
    "checklist_marker",
    "check_kubernetes_available",
    "check_csi_nfs_installed",
)


def _extract(name: str, *, required: bool) -> str:
    src = CLIENT_SETUP.read_text()
    m = re.search(rf"^{re.escape(name)}\(\) \{{\n.*?\n\}}\n", src, re.M | re.S)
    if m is None:
        assert not required, f"{name}() definition not found in client_repo/client_setup.sh"
        return ""
    return m.group(0)


def _function_bodies() -> str:
    parts = [_extract(n, required=False) for n in _OPTIONAL]
    parts += [_extract(n, required=True) for n in _REQUIRED]
    return "\n".join(p for p in parts if p)


def _harness(
    tmp_path,
    *,
    call: str,
    storage_ifaces: str = "",
    iface_ips: dict[str, str] | None = None,
    nfs_mounts: int = 0,
    ib_devices: str = "",
    mellanox: bool = False,
    kubectl: str = "absent",
) -> Path:
    """Sandbox the predicate away from this machine's real sysfs and mounts.

    ``detect_high_speed_interfaces`` / ``detect_mellanox_nic`` are stubbed as
    shell functions and ``ip`` / ``mount`` / ``kubectl`` / ``timeout`` as PATH
    executables, so the logic under test is the real thing while every input
    it reads is ours.

    ``kubectl``: "absent" | "hang" (cluster-info never returns) | "csi" |
    "no-csi".
    """
    iface_ips = iface_ips or {}
    # Several tests build more than one harness, so each gets its own work dir.
    work = tmp_path / f"h{len(list(tmp_path.glob('h*')))}"
    work.mkdir()
    stub_bin = work / "bin"
    stub_bin.mkdir()

    ip_cases = "\n".join(f'    {name}) echo "{addr}";;' for name, addr in iface_ips.items())
    (stub_bin / "ip").write_text(
        "#!/bin/bash\n"
        "# usage under test: ip -o -4 addr show <iface>\n"
        'iface="${@: -1}"\n'
        'case "$iface" in\n'
        f"{ip_cases}\n"
        "    *) : ;;\n"
        "esac\n"
        "exit 0\n"
    )
    (stub_bin / "mount").write_text(
        "#!/bin/bash\n"
        + "".join(f'echo "server:/e{i} on /mnt/{i} type nfs4 (rw)"\n' for i in range(nfs_mounts))
    )

    # coreutils `timeout` is not on macOS, where this suite also runs. Stub a
    # portable equivalent so the probes exercise the real `timeout N kubectl …`
    # call shape on every platform.
    (stub_bin / "timeout").write_text(
        "#!/bin/bash\n"
        'secs="$1"; shift\n'
        '"$@" & pid=$!\n'
        '( sleep "$secs"; kill -9 $pid 2>/dev/null ) & watcher=$!\n'
        "wait $pid 2>/dev/null; rc=$?\n"
        "kill -9 $watcher 2>/dev/null\n"
        "# coreutils reports a killed child as 124; `wait` reports 128+SIGKILL.\n"
        "# The distinction matters: the product bails out of further probes on\n"
        "# 124 specifically.\n"
        "[[ $rc -ge 128 ]] && rc=124\n"
        "exit $rc\n"
    )

    if kubectl != "absent":
        if kubectl == "hang":
            body = 'if [[ "$1" == "cluster-info" ]]; then sleep 120; fi\nexit 0\n'
        elif kubectl == "hang-get":
            # Cluster answers, every lookup stalls — the case that used to
            # cost one timeout per lookup.
            body = 'if [[ "$1" == "cluster-info" ]]; then exit 0; fi\nsleep 120\n'
        elif kubectl == "csi":
            body = "exit 0\n"
        else:  # no-csi
            body = 'if [[ "$1" == "cluster-info" ]]; then exit 0; fi\nexit 1\n'
        (stub_bin / "kubectl").write_text(
            f'#!/bin/bash\necho "$1" >> "{work}/kubectl-calls.log"\n' + body
        )

    for f in stub_bin.iterdir():
        f.chmod(0o755)

    script = work / "harness.sh"
    script.write_text(
        f"""#!/bin/bash
set -euo pipefail
export PATH="{stub_bin}:/usr/bin:/bin"
command_not_found_handle() {{ echo "harness: missing command: $1" >&2; exit 127; }}

XINAS_SYSFS_IB="{work}/sys-infiniband"
CHECKLIST_PROBE_TIMEOUT=3
detect_high_speed_interfaces() {{ echo "{storage_ifaces}"; }}
detect_mellanox_nic() {{ {"echo 'stub mlx'; return 0" if mellanox else "return 1"}; }}

{_function_bodies()}

{call}
"""
    )
    script.chmod(0o755)

    ib_dir = work / "sys-infiniband"
    if ib_devices:
        ib_dir.mkdir()
        for dev in ib_devices.split():
            (ib_dir / dev).mkdir()

    return script


def _run(script: Path, *, expect_rc: int | None = 0) -> subprocess.CompletedProcess:
    proc = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=60)
    if expect_rc is not None:
        assert proc.returncode == expect_rc, (
            f"expected rc={expect_rc}, got {proc.returncode}\n{proc.stdout}\n{proc.stderr}"
        )
    return proc


def _kubectl_calls(script: Path) -> list[str]:
    """kubectl subcommands the harness recorded, in order."""
    log = script.parent / "kubectl-calls.log"
    return log.read_text().split() if log.exists() else []


def _pending(tmp_path, **kw) -> bool:
    """True when storage_network_pending() says there is work to do."""
    script = _harness(
        tmp_path,
        call="if storage_network_pending; then echo PENDING; else echo OK; fi",
        **kw,
    )
    out = _run(script).stdout.strip()
    assert out in ("PENDING", "OK"), f"unexpected harness output: {out!r}"
    return out == "PENDING"


# ── §3.2: the predicate ──────────────────────────────────────────────────


def test_pending_when_storage_nic_has_no_address(tmp_path):
    assert _pending(tmp_path, storage_ifaces="ibs1", iface_ips={}, nfs_mounts=0)


def test_not_pending_when_storage_nic_has_address(tmp_path):
    """The address is ground truth — whoever wrote the config."""
    assert not _pending(
        tmp_path,
        storage_ifaces="ibs1",
        iface_ips={"ibs1": "inet 10.10.1.5/24 scope global ibs1"},
    )


def test_not_pending_when_no_storage_nic_exists(tmp_path):
    """A TCP-only client on a stock adapter has nothing to configure."""
    assert not _pending(tmp_path, storage_ifaces="", nfs_mounts=0)


def test_not_pending_when_a_share_is_already_mounted(tmp_path):
    """The reported bug: mounted share, wizard still says 'not configured'."""
    assert not _pending(tmp_path, storage_ifaces="ibs1", iface_ips={}, nfs_mounts=1)


def test_pending_ignores_the_clients_own_netplan_file(tmp_path):
    """§3.2: a written-but-unapplied netplan leaves work to do.

    The predicate must not consult 99-xinas-client.yaml at all.
    """
    src = CLIENT_SETUP.read_text()
    m = re.search(r"^storage_network_pending\(\) \{\n.*?\n\}\n", src, re.M | re.S)
    assert m
    assert "99-xinas-client" not in m.group(0), (
        "storage_network_pending() must key off interface addresses, not the "
        "filename the client's own wizard happens to write"
    )


# ── §3.3: the Connect to NAS gate ────────────────────────────────────────


def test_connect_wizard_no_longer_gates_on_the_netplan_filename(tmp_path):
    src = CLIENT_SETUP.read_text()
    m = re.search(r"^configure_nfs_mount\(\) \{\n.*?\n\}\n", src, re.M | re.S)
    assert m, "configure_nfs_mount() not found"
    body = m.group(0)
    assert "/etc/netplan/99-xinas-client.yaml" not in body, (
        "configure_nfs_mount() still gates on the netplan filename — that is "
        "the bug: a working, mounted client is told its network is unconfigured"
    )
    assert "storage_network_pending" in body, (
        "configure_nfs_mount() must use the shared predicate (spec §3.3)"
    )


# ── §4.3: per-step checklist state ───────────────────────────────────────


def _state(tmp_path, step: str, **kw) -> str:
    script = _harness(tmp_path, call=f"checklist_state {step}", **kw)
    return _run(script).stdout.strip()


def test_network_step_states(tmp_path):
    assert _state(tmp_path, "network", storage_ifaces="ibs1") == "pending"
    assert (
        _state(
            tmp_path,
            "network",
            storage_ifaces="ibs1",
            iface_ips={"ibs1": "inet 10.10.1.5/24 scope global ibs1"},
        )
        == "done"
    )
    assert _state(tmp_path, "network", storage_ifaces="") == "na"


def test_mount_step_states(tmp_path):
    assert _state(tmp_path, "mount", nfs_mounts=0) == "pending"
    assert _state(tmp_path, "mount", nfs_mounts=2) == "done"


def test_doca_step_states(tmp_path):
    assert _state(tmp_path, "doca_ofed", ib_devices="mlx5_0", mellanox=True) == "done"
    assert _state(tmp_path, "doca_ofed", mellanox=True) == "pending"
    assert _state(tmp_path, "doca_ofed", mellanox=False) == "na", (
        "a host with no Mellanox/NVIDIA adapter cannot install DOCA OFED"
    )


def test_csi_step_is_na_without_kubectl(tmp_path):
    assert _state(tmp_path, "csi", kubectl="absent") == "na"


def test_csi_step_states_with_a_cluster(tmp_path):
    assert _state(tmp_path, "csi", kubectl="csi") == "done"
    assert _state(tmp_path, "csi", kubectl="no-csi") == "pending"


# ── §4.4: the checklist may not stall the welcome screen ─────────────────


def test_csi_probe_cannot_hang_the_startup_screen(tmp_path):
    """`kubectl cluster-info` against an unreachable cluster blocks for its
    own default timeout. The checklist renders on every startup, so the probe
    runs under `timeout` and degrades to not-applicable."""
    script = _harness(tmp_path, call="checklist_state csi", kubectl="hang")
    started = time.monotonic()
    proc = _run(script)
    elapsed = time.monotonic() - started

    assert elapsed < 8, f"csi probe took {elapsed:.1f}s — welcome screen would stall"
    assert proc.stdout.strip() == "na"
    # Unreachable cluster costs exactly one probe.
    assert _kubectl_calls(script) == ["cluster-info"]


def test_csi_step_is_bounded_to_two_probes(tmp_path):
    """Spec §4.4: a cluster that answers but whose lookups stall must cost one
    reachability probe plus one lookup — not one per driver lookup."""
    script = _harness(tmp_path, call="checklist_state csi", kubectl="hang-get")
    started = time.monotonic()
    proc = _run(script)
    elapsed = time.monotonic() - started

    assert proc.stdout.strip() == "pending"
    assert elapsed < 10, f"csi step took {elapsed:.1f}s — probes are not bounded"
    calls = _kubectl_calls(script)
    assert len(calls) == 2, f"expected 2 kubectl probes, got {len(calls)}: {calls}"
    assert calls[0] == "cluster-info"


@pytest.mark.parametrize("step", ["nfs_tools", "doca_ofed", "network", "mount", "csi"])
def test_every_checklist_step_yields_a_known_state(tmp_path, step):
    assert _state(tmp_path, step) in ("done", "pending", "na")
