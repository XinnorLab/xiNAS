"""Tests for the nfs-helper ``render_nfs_profile`` op (S3 N7.1, spec §6.2, ADR-0005).

``nfs_profile.render_nfs_profile`` renders the four ADR-0005 effective files
(``/etc/nfs/nfsd.conf``, ``/etc/default/nfs-kernel-server``,
``/etc/modprobe.d/lockd.conf``, ``/etc/default/nfs-common``) deterministically
from a full NfsProfile spec, returns per-file sha256 checksums keyed by the
absolute production path, and drives the nfs-server service per the
``restart`` flag (true → restart, false → reload per ADR-0005's
``reload_or_restart`` stage / s3 spec §6.2).

These tests render into a temp ``root`` tree with an injected ``run_systemctl``
so the suite never touches ``/etc``, ``/run``, or systemd.
"""

import hashlib
import os
import sys

import pytest

# The nfs-helper package directory has a hyphen, so it is not importable as a
# normal module path — add it to sys.path the same way the daemon's siblings
# import each other (flat, by module name).
_HELPER_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "xiNAS-MCP",
    "nfs-helper",
)
if _HELPER_DIR not in sys.path:
    sys.path.insert(0, _HELPER_DIR)

import nfs_profile  # noqa: E402

PROD_PATHS = [
    "/etc/nfs/nfsd.conf",
    "/etc/default/nfs-kernel-server",
    "/etc/modprobe.d/lockd.conf",
    "/etc/default/nfs-common",
]


def full_spec() -> dict:
    """A full NfsProfile spec: all versions on, RDMA on 20049, 64 threads,
    v3 locking enabled with fixed lockd ports."""
    return {
        "versions": {
            "v3": {"enabled": True},
            "v4_0": {"enabled": True},
            "v4_1": {"enabled": True},
            "v4_2": {"enabled": True},
        },
        "rdma": {"enabled": True, "port": 20049},
        "threads": {"count": 64},
        "v3_locking": {
            "enabled": True,
            "fixed_rpc_ports": {
                "nfsd": 2049,
                "mountd": 20048,
                "lockd_udp": 32803,
                "lockd_tcp": 32803,
                "statd": 32765,
                "statd_outgoing": 32766,
            },
        },
        "v4_recovery": {
            "backend": "nfsdcltrack",
            "recovery_root": "/var/lib/nfs/v4recovery",
            "server_scope": "",
        },
        "service_policy": {
            "on_thread_count_change": "reload",
            "on_version_change": "restart",
            "on_rdma_change": "restart",
            "on_v3_settings_change": "restart",
        },
    }


@pytest.fixture()
def env(tmp_path):
    """(root, lock_path, calls, run_systemctl) — recording no-op systemctl."""
    calls: list[list[str]] = []

    def run_systemctl(cmd):
        calls.append(list(cmd))

    return str(tmp_path), str(tmp_path / "profile.lock"), calls, run_systemctl


def _rooted(root: str, prod_path: str) -> str:
    return os.path.join(root, prod_path.lstrip("/"))


def _read(root: str, prod_path: str) -> str:
    with open(_rooted(root, prod_path)) as f:
        return f.read()


def test_full_spec_renders_all_four_files(env):
    root, lock_path, _calls, run_systemctl = env
    result = nfs_profile.render_nfs_profile(
        full_spec(), False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )

    for prod in PROD_PATHS:
        assert os.path.isfile(_rooted(root, prod)), f"missing {prod}"
        assert prod in result["effective_files"]

    nfsd = _read(root, "/etc/nfs/nfsd.conf")
    assert "[nfsd]" in nfsd
    assert "vers3=y" in nfsd
    assert "vers4=y" in nfsd
    assert "vers4.0=y" in nfsd
    assert "vers4.1=y" in nfsd
    assert "vers4.2=y" in nfsd
    assert "rdma=y" in nfsd
    assert "rdma-port=20049" in nfsd
    assert "threads=64" in nfsd

    kernel_server = _read(root, "/etc/default/nfs-kernel-server")
    assert "RPCNFSDCOUNT=64" in kernel_server
    assert 'RPCMOUNTDOPTS="--manage-gids"' in kernel_server

    lockd = _read(root, "/etc/modprobe.d/lockd.conf")
    assert "options lockd nlm_udpport=32803 nlm_tcpport=32803" in lockd

    common = _read(root, "/etc/default/nfs-common")
    assert "NEED_STATD=yes" in common
    assert 'STATDOPTS=""' in common

    # Every file starts with the managed header.
    for prod in PROD_PATHS:
        first_line = _read(root, prod).splitlines()[0]
        assert first_line == nfs_profile.MANAGED_HEADER


def test_deterministic_checksums_keyed_by_production_path(env):
    root, lock_path, _calls, run_systemctl = env
    r1 = nfs_profile.render_nfs_profile(
        full_spec(), False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )
    r2 = nfs_profile.render_nfs_profile(
        full_spec(), False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )

    # Same spec → byte-identical files → identical checksums.
    assert r1["effective_files"] == r2["effective_files"]

    # Keys are the ABSOLUTE production paths, not root-prefixed ones.
    assert sorted(r1["effective_files"]) == sorted(PROD_PATHS)

    # Checksum equals a locally computed sha256 of the rendered bytes.
    for prod, checksum in r1["effective_files"].items():
        with open(_rooted(root, prod), "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        assert checksum == f"sha256:{digest}"


def test_v3_disabled_renders_disabled_forms(env):
    root, lock_path, _calls, run_systemctl = env
    spec = full_spec()
    spec["versions"]["v3"]["enabled"] = False

    result = nfs_profile.render_nfs_profile(
        spec, False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )

    nfsd = _read(root, "/etc/nfs/nfsd.conf")
    assert "vers3=n" in nfsd

    # lockd.conf is still rendered (stable managed file) but with no module
    # options — v3 locking requires v3 enabled.
    lockd = _read(root, "/etc/modprobe.d/lockd.conf")
    assert "options lockd" not in lockd
    assert "disabled" in lockd
    assert "/etc/modprobe.d/lockd.conf" in result["effective_files"]

    # No statd needed without v3.
    common = _read(root, "/etc/default/nfs-common")
    assert "NEED_STATD=no" in common


def test_restart_true_restarts_nfs_server(env):
    root, lock_path, calls, run_systemctl = env
    result = nfs_profile.render_nfs_profile(
        full_spec(), True, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )
    assert calls == [["systemctl", "restart", "nfs-server"]]
    assert result["restarted"] is True
    assert result["reloaded"] is False


def test_restart_false_reloads_nfs_server(env):
    """restart=false → `systemctl reload nfs-server` (ADR-0005 apply stage is
    `reload_or_restart`; s3 spec §6.2: 'reloads or restarts nfs-server per restart')."""
    root, lock_path, calls, run_systemctl = env
    result = nfs_profile.render_nfs_profile(
        full_spec(), False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )
    assert calls == [["systemctl", "reload", "nfs-server"]]
    assert result["restarted"] is False
    assert result["reloaded"] is True


def test_rejects_threads_below_minimum(env):
    root, lock_path, calls, run_systemctl = env
    spec = full_spec()
    spec["threads"]["count"] = 4
    with pytest.raises(ValueError):
        nfs_profile.render_nfs_profile(
            spec, False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
        )
    assert calls == []  # validation fails before any render/service action


def test_rejects_string_threads(env):
    root, lock_path, _calls, run_systemctl = env
    spec = full_spec()
    spec["threads"]["count"] = "64"
    with pytest.raises(ValueError):
        nfs_profile.render_nfs_profile(
            spec, False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
        )


def test_rejects_non_dict_spec(env):
    root, lock_path, _calls, run_systemctl = env
    with pytest.raises(ValueError):
        nfs_profile.render_nfs_profile(
            ["not", "a", "dict"],
            False,
            root=root,
            lock_path=lock_path,
            run_systemctl=run_systemctl,
        )


def test_rejects_bool_threads(env):
    """Python bool is an int subclass — True must NOT pass the int check."""
    root, lock_path, _calls, run_systemctl = env
    spec = full_spec()
    spec["threads"]["count"] = True
    with pytest.raises(ValueError):
        nfs_profile.render_nfs_profile(
            spec, False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
        )


def test_rdma_disabled_renders_no_rdma_port(env):
    root, lock_path, _calls, run_systemctl = env
    spec = full_spec()
    spec["rdma"] = {"enabled": False, "port": 20049}
    nfs_profile.render_nfs_profile(
        spec, False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )
    with open(os.path.join(root, "etc/nfs/nfsd.conf")) as f:
        nfsd = f.read()
    assert "rdma=n" in nfsd
    assert "rdma-port" not in nfsd


def test_rendered_files_are_world_readable(env):
    """Rendered files must be 0644, not inherit mkstemp's 0600 — nfs-utils
    tooling and drift detection read them as non-root."""
    root, lock_path, _calls, run_systemctl = env
    nfs_profile.render_nfs_profile(
        full_spec(), False, root=root, lock_path=lock_path, run_systemctl=run_systemctl
    )
    for prod in PROD_PATHS:
        mode = os.stat(_rooted(root, prod)).st_mode & 0o777
        assert mode == 0o644, f"{prod} has mode {oct(mode)}"


def test_failed_systemctl_raises_after_render(env):
    """A systemctl failure is post-render: RuntimeError propagates AND the
    files were still written (the error reports that)."""
    root, lock_path, _calls, _run = env

    def raiser(cmd):
        raise RuntimeError("boom: unit nfs-server failed")

    with pytest.raises(RuntimeError):
        nfs_profile.render_nfs_profile(
            full_spec(), True, root=root, lock_path=lock_path, run_systemctl=raiser
        )

    for prod in PROD_PATHS:
        assert os.path.isfile(_rooted(root, prod)), f"{prod} not rendered before failure"
