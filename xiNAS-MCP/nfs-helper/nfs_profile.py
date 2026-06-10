"""
ADR-0005 NFS-profile renderer (S3 N7.1, s3-nfs-executor-spec §6.2).

Renders the four effective NFS service-config files on Ubuntu 22.04/24.04
from a full NfsProfile spec (ADR-0005 §"Effective-config rendering"):

* ``/etc/nfs/nfsd.conf``             — modular nfs-utils: enabled versions, RDMA, threads
* ``/etc/default/nfs-kernel-server`` — Ubuntu-style: RPCNFSDCOUNT, RPCMOUNTDOPTS
* ``/etc/modprobe.d/lockd.conf``     — lockd module params when v3 locking enabled
* ``/etc/default/nfs-common``        — statd needs (fixed statd ports are Phase 1+)

``/etc/nfs.conf`` is NOT authoritative here — the legacy ``fix_nfs_conf`` op
must not be used for the profile path (s3 spec §3.4).

Rendering is deterministic (same spec → byte-identical files), each file is
written atomically (mkstemp + os.replace, mode 0644) under one
``fcntl.LOCK_EX`` on the profile lock, and each file gets a sha256 checksum
keyed by its absolute production path (feeds ``status.effective_files``).

The ``restart`` flag drives the service action after a successful render
(ADR-0005 apply stage ``reload_or_restart``): ``true`` → ``systemctl restart
nfs-server``; ``false`` → ``systemctl reload nfs-server``.

Testable via keyword overrides: ``root`` prefixes all file paths (tests pass
a tmp dir), ``lock_path`` relocates the lock, ``run_systemctl`` injects the
service runner.
"""

import fcntl
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile

LOCK_PATH = "/run/xinas-nfs-profile.lock"

NFSD_CONF_PATH = "/etc/nfs/nfsd.conf"
NFS_KERNEL_SERVER_PATH = "/etc/default/nfs-kernel-server"
LOCKD_CONF_PATH = "/etc/modprobe.d/lockd.conf"
NFS_COMMON_PATH = "/etc/default/nfs-common"

MANAGED_HEADER = "# Managed by xiNAS (render_nfs_profile) — do not edit"

# OpenAPI bounds for spec.threads.count (api-v1.yaml NfsProfile).
THREADS_MIN = 8
THREADS_MAX = 1024

# ADR-0005 defaults used when optional fields are absent from the spec.
DEFAULT_THREADS = 64
DEFAULT_RDMA_PORT = 20049
DEFAULT_LOCKD_UDP = 32803
DEFAULT_LOCKD_TCP = 32803

log = logging.getLogger("nfs_profile")


# --- Validation ---


def _require_int(value, name: str, lo: int | None = None, hi: int | None = None) -> int:
    """Validate *value* is a real int (not bool) within [lo, hi]."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer, got {value!r}")
    if lo is not None and value < lo:
        raise ValueError(f"{name} must be >= {lo}, got {value}")
    if hi is not None and value > hi:
        raise ValueError(f"{name} must be <= {hi}, got {value}")
    return value


def _validate(spec) -> dict:
    """Minimal spec validation → ValueError (mapped to INVALID_ARGUMENT).

    Returns a normalized view: {versions, rdma_enabled, rdma_port,
    threads_count, v3_locking_active, lockd_udp, lockd_tcp}.
    """
    if not isinstance(spec, dict):
        raise ValueError(f"spec must be an object, got {type(spec).__name__}")

    versions = spec.get("versions", {})
    if not isinstance(versions, dict):
        raise ValueError("spec.versions must be an object")

    def _enabled(ver: str) -> bool:
        entry = versions.get(ver) or {}
        if not isinstance(entry, dict):
            raise ValueError(f"spec.versions.{ver} must be an object")
        return bool(entry.get("enabled"))

    threads = spec.get("threads") or {}
    if not isinstance(threads, dict):
        raise ValueError("spec.threads must be an object")
    count = threads.get("count", DEFAULT_THREADS)
    count = _require_int(count, "spec.threads.count", THREADS_MIN, THREADS_MAX)

    rdma = spec.get("rdma") or {}
    if not isinstance(rdma, dict):
        raise ValueError("spec.rdma must be an object")
    rdma_enabled = bool(rdma.get("enabled"))
    rdma_port = rdma.get("port", DEFAULT_RDMA_PORT)
    if rdma_enabled:
        rdma_port = _require_int(rdma_port, "spec.rdma.port", 1, 65535)

    v3_locking = spec.get("v3_locking") or {}
    if not isinstance(v3_locking, dict):
        raise ValueError("spec.v3_locking must be an object")
    ports = v3_locking.get("fixed_rpc_ports") or {}
    if not isinstance(ports, dict):
        raise ValueError("spec.v3_locking.fixed_rpc_ports must be an object")
    v3_enabled = _enabled("v3")
    # lockd.conf carries module options only when v3 locking is on AND v3 itself is on.
    v3_locking_active = bool(v3_locking.get("enabled")) and v3_enabled
    lockd_udp = ports.get("lockd_udp", DEFAULT_LOCKD_UDP)
    lockd_tcp = ports.get("lockd_tcp", DEFAULT_LOCKD_TCP)
    if v3_locking_active:
        lockd_udp = _require_int(lockd_udp, "spec.v3_locking.fixed_rpc_ports.lockd_udp", 1, 65535)
        lockd_tcp = _require_int(lockd_tcp, "spec.v3_locking.fixed_rpc_ports.lockd_tcp", 1, 65535)

    return {
        "v3": v3_enabled,
        "v4_0": _enabled("v4_0"),
        "v4_1": _enabled("v4_1"),
        "v4_2": _enabled("v4_2"),
        "rdma_enabled": rdma_enabled,
        "rdma_port": rdma_port,
        "threads_count": count,
        "v3_locking_active": v3_locking_active,
        "lockd_udp": lockd_udp,
        "lockd_tcp": lockd_tcp,
    }


# --- Renderers (deterministic: same normalized spec → identical bytes) ---


def _yn(flag: bool) -> str:
    return "y" if flag else "n"


def _render_nfsd_conf(n: dict) -> list[str]:
    any_v4 = n["v4_0"] or n["v4_1"] or n["v4_2"]
    lines = [
        MANAGED_HEADER,
        "[nfsd]",
        f"vers3={_yn(n['v3'])}",
        f"vers4={_yn(any_v4)}",
        f"vers4.0={_yn(n['v4_0'])}",
        f"vers4.1={_yn(n['v4_1'])}",
        f"vers4.2={_yn(n['v4_2'])}",
        f"rdma={_yn(n['rdma_enabled'])}",
    ]
    if n["rdma_enabled"]:
        lines.append(f"rdma-port={n['rdma_port']}")
    lines.append(f"threads={n['threads_count']}")
    return lines


def _render_nfs_kernel_server(n: dict) -> list[str]:
    return [
        MANAGED_HEADER,
        f"RPCNFSDCOUNT={n['threads_count']}",
        'RPCMOUNTDOPTS="--manage-gids"',
    ]


def _render_lockd_conf(n: dict) -> list[str]:
    if n["v3_locking_active"]:
        return [
            MANAGED_HEADER,
            f"options lockd nlm_udpport={n['lockd_udp']} nlm_tcpport={n['lockd_tcp']}",
        ]
    return [
        MANAGED_HEADER,
        "# NFSv3 locking is disabled in the NfsProfile — no lockd module options are managed.",
    ]


def _render_nfs_common(n: dict) -> list[str]:
    # Phase-0 minimal form: statd is needed iff NFSv3 is enabled. Fixed statd
    # ports (STATDOPTS/STATDPRIV_*) are Phase 1+ per ADR-0005 / OpenAPI readOnly.
    return [
        MANAGED_HEADER,
        f"NEED_STATD={'yes' if n['v3'] else 'no'}",
        'STATDOPTS=""',
    ]


# --- File plumbing (mirrors nfs_idmap/nfs_conf) ---


def _with_lock(lock_path: str, fn):
    with open(lock_path, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _atomic_write(path: str, lines: list[str]) -> bytes:
    """Atomically write *lines* to *path* (mode 0644); return the final bytes."""
    body = "\n".join(lines)
    if not body.endswith("\n"):
        body += "\n"
    data = body.encode("utf-8")
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".",
        suffix=".tmp",
        dir=directory,
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if os.path.exists(path):
            shutil.copymode(path, tmp)
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return data


def _default_run_systemctl(cmd: list[str], timeout: int = 60) -> None:
    """Run a systemctl command; raise RuntimeError on any failure."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise RuntimeError("systemctl not found") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{' '.join(cmd)} timed out") from None
    if r.returncode != 0:
        msg = r.stderr.strip() or r.stdout.strip() or f"{' '.join(cmd)} failed"
        raise RuntimeError(msg)


# --- Public op ---


def render_nfs_profile(
    spec: dict,
    restart: bool,
    *,
    root: str = "/",
    lock_path: str = LOCK_PATH,
    run_systemctl=None,
) -> dict:
    """Render the four ADR-0005 effective files from the NfsProfile spec.

    Returns ``{"effective_files": {"<abs path>": "sha256:<hex>", ...},
    "restarted": bool, "reloaded": bool}``. Checksums are keyed by the
    absolute production path even when *root* relocates the writes.

    Raises ValueError on an invalid spec (→ INVALID_ARGUMENT) and
    RuntimeError if the post-render service action fails (→ INTERNAL; the
    files have already been rendered at that point).

    A mid-render write failure can leave a PARTIAL set (earlier files already
    replaced, later ones untouched; each individual write is atomic). That is
    accepted: the executor's prior-spec rollback re-renders all four files,
    restoring a coherent set (s3-nfs-executor-spec §3.4).
    """
    normalized = _validate(spec)
    if run_systemctl is None:
        run_systemctl = _default_run_systemctl

    renderers = {
        NFSD_CONF_PATH: _render_nfsd_conf,
        NFS_KERNEL_SERVER_PATH: _render_nfs_kernel_server,
        LOCKD_CONF_PATH: _render_lockd_conf,
        NFS_COMMON_PATH: _render_nfs_common,
    }

    def _do() -> dict:
        effective_files: dict[str, str] = {}
        for prod_path, renderer in renderers.items():
            target = os.path.join(root, prod_path.lstrip("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            data = _atomic_write(target, renderer(normalized))
            digest = hashlib.sha256(data).hexdigest()
            effective_files[prod_path] = f"sha256:{digest}"
            log.info("rendered %s (%s)", prod_path, effective_files[prod_path])
        return effective_files

    effective_files = _with_lock(lock_path, _do)

    action = "restart" if restart else "reload"
    try:
        run_systemctl(["systemctl", action, "nfs-server"])
    except Exception as e:
        raise RuntimeError(
            f"systemctl {action} nfs-server failed after the effective files "
            f"were already rendered: {e}"
        ) from e

    return {
        "effective_files": effective_files,
        "restarted": restart,
        "reloaded": not restart,
    }
