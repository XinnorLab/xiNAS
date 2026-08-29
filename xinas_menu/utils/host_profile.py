"""What kind of host this is, and which block devices it builds arrays from.

Both drive pickers — the Create Array wizard and Spare Pools — ask the same
question of every disk row, so the answer lives here rather than in each
screen. See docs/Storage/raid-management-spec.md §2.6.
"""

from __future__ import annotations

from functools import lru_cache

from xinas_menu.utils.subprocess_utils import run_cmd

#: Device-name prefixes a virtual machine presents its disks under —
#: ``vd*`` for virtio-blk, ``sd*`` for virtio-scsi / SATA / SAS.
_VM_PREFIXES = ("vd", "sd")


@lru_cache(maxsize=1)
def is_vm() -> bool:
    """True when this host is virtualized, per ``systemd-detect-virt``.

    Deliberately the same rule the installer already applies twice — ``is_vm()``
    in ``startup_menu.sh`` and the empty-NVMe fallback in the ``nvme_namespace``
    role — so there is no third definition of "VM" in the tree.

    The **exit status is not consulted**: ``systemd-detect-virt`` exits 1 on
    bare metal, so a return-code gate would report "detection failed" for every
    physical node and only accidentally reach the right answer. Reading stdout
    keeps bare metal ("none") distinguishable from a missing binary ("").

    Cached: virtualization does not change under a running TUI, and the pickers
    ask once per drive row.
    """
    _ok, stdout, _err = run_cmd("systemd-detect-virt", timeout=5)
    return stdout.strip() not in ("", "none")


def selectable_drive_name(name: str) -> bool:
    """True when a device of this name may be offered as an array/pool member.

    NVMe everywhere; on a VM also ``vd*`` / ``sd*``, which is what the
    ``xinnorVM`` preset and the ``nvme_namespace`` VM fallback already hand to
    ``xicli raid create``. The prefix match (rather than a substring one) is
    what keeps xiRAID's own array devices — ``xi_data``, ``xi_log`` — out of
    both pickers.
    """
    lowered = name.lower()
    if "nvme" in lowered:
        return True
    return is_vm() and lowered.startswith(_VM_PREFIXES)
