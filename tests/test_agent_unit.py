"""Contract guard (#254) for the xinas-agent systemd unit's writable-paths
sandbox.

The task runner's ``snapshot_before`` / ``snapshot_after`` steps shell out to
``xinas_history snapshot create``, which writes
``/var/lib/xinas/config-history``. If that path is not in ``ReadWritePaths``
the write hits EROFS, ``snapshot_before`` throws, and every apply wedges.
Conversely ``/var/lib/xinas/state`` must stay read-only — per ADR-0002 the api
is the sole SQLite writer.

Validated as unit-file text (no systemd on the test host), mirroring
``test_nfs_helper_unit.py``.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UNIT = REPO_ROOT / "xiNAS-MCP" / "xinas-agent.service"


def _read_write_paths() -> str:
    """Joined text of every ``ReadWritePaths=`` directive (comments excluded:
    comment lines start with ``#``, not ``ReadWritePaths=``)."""
    return " ".join(ln for ln in UNIT.read_text().splitlines() if ln.startswith("ReadWritePaths="))


def _directive(name: str) -> list[str]:
    """Values of every ``name=`` directive, comments excluded."""
    prefix = f"{name}="
    return [
        ln[len(prefix) :].strip() for ln in UNIT.read_text().splitlines() if ln.startswith(prefix)
    ]


def test_unit_file_exists():
    assert UNIT.is_file(), UNIT


def test_config_history_is_writable():
    # Without this the agent cannot capture snapshots and every apply hangs.
    assert "/var/lib/xinas/config-history" in _read_write_paths()


def test_state_dir_stays_read_only():
    # ADR-0002: the api is the sole SQLite writer; the agent must NOT be granted
    # write access to /var/lib/xinas/state.
    assert "/var/lib/xinas/state" not in _read_write_paths()


def test_netplan_runtime_dirs_are_writable():
    """``netplan generate`` writes /run/systemd/network **and** /run/udev/rules.d.

    ``ProtectSystem=strict`` mounts all of ``/run`` read-only, so a missing
    ``/run/udev`` makes the S6 ``render_write`` stage die with
    ``cannot create file run/udev/rules.d/90-netplan.rules: Read-only file
    system``. The rollback re-runs the same ``netplan generate`` and dies the
    same way, escalating a change-nothing failure to
    ``requires_manual_recovery``.
    """
    paths = _read_write_paths()
    assert "/run/systemd" in paths
    assert "/run/udev" in paths


def test_restrict_namespaces_parses():
    """A repeated ``~`` makes systemd drop the directive, unsandboxing the agent.

    ``RestrictNamespaces=~cgroup ~user`` logs "Failed to parse namespace type
    string, ignoring: cgroup ~user" and applies NO restriction at all. The
    leading ``~`` already negates the whole list.
    """
    values = _directive("RestrictNamespaces")
    assert values, "RestrictNamespaces directive is missing"
    for value in values:
        assert not value.lstrip("~").lstrip().startswith("~"), value
        assert "~" not in value[1:], f"only a leading ~ is valid, got: {value!r}"

    # The hardening the surrounding comment promises: deny cgroup + user ns.
    assert values[-1].split() == ["~cgroup", "user"], values[-1]


def test_mkfs_and_growfs_capability_is_held_and_inheritable():
    """``fs.create``/``fs.grow`` need CAP_SYS_ADMIN, in *both* capability sets.

    ``mkfs.xfs`` sets the block device's soft block size with
    ``ioctl(BLKBSZSET)``; ``blkdev_bszset()`` opens with
    ``if (!capable(CAP_SYS_ADMIN)) return -EACCES``. ``xfs_growfs`` takes the
    same capability via ``xfs_growfs_data()`` (``-EPERM``). Both are capability
    checks, not DAC checks, so uid-0 ownership of ``/dev/xi_*`` does not satisfy
    them — the ADR-0007 audit row said "no extra capability needed" on DAC
    grounds and every ``fs.create`` died with ``mkfs.xfs: error - cannot set
    blocksize 4096 on block device /dev/xi_ss: Permission denied``.

    Bounding is the set that actually reaches ``mkfs.xfs``: a root process
    exec'ing a binary that carries no file capabilities gets
    ``pP' = bounding | pI`` with ``pE' = pP'`` (``handle_privileged_root()``).
    The ``NoNewPrivileges`` downgrade that intersects a child's permitted set
    with its parent's only fires when the exec *gains* permitted capabilities,
    which cannot happen while the agent's own permitted set already equals the
    bounding set. Ambient is asserted alongside it because it is what
    ``systemctl show xinas-agent -p AmbientCapabilities`` reports, and because
    it keeps the grant intact if the unit ever stops running as ``User=root``,
    where a bounding entry on its own confers nothing.
    """
    bounding = _directive("CapabilityBoundingSet")
    ambient = _directive("AmbientCapabilities")
    assert bounding and ambient, "both capability directives must be set"

    for name, values in (("CapabilityBoundingSet", bounding), ("AmbientCapabilities", ambient)):
        assert "CAP_SYS_ADMIN" in values[-1].split(), f"{name}: {values[-1]!r}"

    # The pre-existing grants must survive: CAP_CHOWN gates the agent.sock
    # chgrp (the socket gate), CAP_NET_ADMIN the S6 network executors.
    for values in (bounding, ambient):
        assert "CAP_CHOWN" in values[-1].split()
        assert "CAP_NET_ADMIN" in values[-1].split()

    # NoNewPrivileges bounds how far a subprocess can escalate past the sets
    # above; dropping it would silently widen what mkfs.xfs may acquire.
    assert _directive("NoNewPrivileges") == ["true"]


def test_agent_is_ordered_after_the_nfs_helper():
    """The NfsSession initialSweep() connects to the helper's unix socket.

    With no ordering the agent raced it on every boot and lost the sweep to
    ENOENT. Soft (``Wants=``) so the agent still starts where the helper is
    absent; ``Requires=`` would make the agent fail with it.
    """
    after = " ".join(_directive("After"))
    wants = " ".join(_directive("Wants"))
    assert "xinas-nfs-helper.service" in after
    assert "xinas-nfs-helper.service" in wants
    assert "xinas-nfs-helper.service" not in " ".join(_directive("Requires"))
