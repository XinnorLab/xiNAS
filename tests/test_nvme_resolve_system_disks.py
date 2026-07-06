"""Behavioral guard for OS-disk resolution across storage stacks.

Runs the real `resolve_system_disks.sh` against stubbed `findmnt`, `lsblk`, and
`zpool` so the LVM / dm-crypt / MD / btrfs / ZFS cases described in the spec are
actually exercised. The script prints `root_resolved=1|0` on the first line
followed by the sorted-unique physical disks that must be protected.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RESOLVE = REPO / "collection/roles/nvme_namespace/files/resolve_system_disks.sh"

# lsblk --inverse output per mount source (TYPE column drives the disk filter).
LSBLK_INVERSE = {
    "/dev/mapper/ubuntu--vg-ubuntu--lv": "/dev/mapper/ubuntu--vg-ubuntu--lv lvm\n/dev/nvme0n1p3 part\n/dev/nvme0n1 disk\n",
    "/dev/md0": "/dev/md0 raid1\n/dev/nvme0n1p3 part\n/dev/nvme0n1 disk\n/dev/nvme1n1p3 part\n/dev/nvme1n1 disk\n",
    "/dev/sda2": "/dev/sda2 part\n/dev/sda disk\n",
    "/dev/nvme0n1p1": "/dev/nvme0n1p1 part\n/dev/nvme0n1 disk\n",
    "/dev/nvme1n1p1": "/dev/nvme1n1p1 part\n/dev/nvme1n1 disk\n",
    "/dev/nvme0n1p2": "/dev/nvme0n1p2 part\n/dev/nvme0n1 disk\n",
    "/dev/nvme1n1p2": "/dev/nvme1n1p2 part\n/dev/nvme1n1 disk\n",
}


def _write(path: Path, body: str) -> None:
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(0o755)


def run_resolver(tmp_path: Path, *, root, boot=None, efi=None, esps=(), zpool_status=None):
    """Stub findmnt/lsblk/zpool and run the resolver; return (root_resolved, [disks])."""
    stub = tmp_path / "bin"
    stub.mkdir()

    mounts = {"/": root}
    if boot:
        mounts["/boot"] = boot
    if efi:
        mounts["/boot/efi"] = efi
    findmnt_cases = "\n".join(f'    "{m}") echo "{src}" ;;' for m, src in mounts.items())
    _write(
        stub / "findmnt",
        'mnt="${@: -1}"\ncase "$mnt" in\n' + findmnt_cases + "\n    *) exit 1 ;;\nesac\n",
    )

    inv_cases = "\n".join(
        f'    "{src}") printf %s "{out}" ;;' for src, out in LSBLK_INVERSE.items()
    )
    esp_lines = "".join(f"{name} c12a7328-f81f-11d2-ba4b-00a0c93ec93b\\n" for name in esps)
    _write(
        stub / "lsblk",
        'args="$*"\n'
        'if [[ "$args" == *"-s"* ]]; then\n'
        '  dev="${@: -1}"\n'
        '  case "$dev" in\n' + inv_cases + "\n    *) : ;;\n  esac\n  exit 0\nfi\n"
        # partition-type listing for the ESP-by-GUID scan (-nrpo NAME,PARTTYPE)
        'if [[ "$args" == *"PARTTYPE"* ]]; then\n'
        f'  printf "{esp_lines}"\n'
        "  exit 0\nfi\nexit 0\n",
    )

    if zpool_status is not None:
        _write(
            stub / "zpool",
            f'if [ "$1" = "status" ]; then\n  printf %s "{zpool_status}"\n  exit 0\nfi\nexit 0\n',
        )

    env = dict(os.environ, PATH=f"{stub}:/usr/bin:/bin")
    proc = subprocess.run(["bash", str(RESOLVE)], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    root_resolved = "root_resolved=1" in lines
    disks = sorted(ln for ln in lines if ln.startswith("/dev/"))
    return root_resolved, disks


def test_helper_exists():
    assert RESOLVE.exists()


def test_lvm_root_resolves_to_physical_disk(tmp_path):
    resolved, disks = run_resolver(tmp_path, root="/dev/mapper/ubuntu--vg-ubuntu--lv")
    assert resolved is True
    assert disks == ["/dev/nvme0n1"]


def test_md_mirror_root_protects_all_members(tmp_path):
    resolved, disks = run_resolver(tmp_path, root="/dev/md0")
    assert resolved is True
    assert disks == ["/dev/nvme0n1", "/dev/nvme1n1"]


def test_btrfs_subvolume_suffix_is_stripped(tmp_path):
    resolved, disks = run_resolver(tmp_path, root="/dev/sda2[/@]")
    assert resolved is True
    assert disks == ["/dev/sda"]


def test_zfs_root_resolves_pool_members(tmp_path):
    # rpool mirrored across nvme0 + nvme1; ESP only on nvme0.
    status = (
        "  pool: rpool\n config:\n\tNAME STATE\n\trpool ONLINE\n"
        "\t  mirror-0 ONLINE\n\t    /dev/nvme0n1p2 ONLINE\n\t    /dev/nvme1n1p2 ONLINE\n"
    )
    resolved, disks = run_resolver(
        tmp_path,
        root="rpool/ROOT/ubuntu",
        efi="/dev/nvme0n1p1",
        esps=["/dev/nvme0n1p1"],
        zpool_status=status,
    )
    assert resolved is True
    # Both mirror members protected, not just the ESP's disk.
    assert disks == ["/dev/nvme0n1", "/dev/nvme1n1"]


def test_zfs_root_without_zpool_fails_closed(tmp_path):
    # No zpool binary / unresolvable pool: root does not resolve even though an
    # ESP exists, so root_resolved must be False (the abort guard fires).
    resolved, _ = run_resolver(
        tmp_path,
        root="rpool/ROOT/ubuntu",
        efi="/dev/nvme0n1p1",
        esps=["/dev/nvme0n1p1"],
    )
    assert resolved is False


def test_nfs_root_fails_closed(tmp_path):
    resolved, _ = run_resolver(tmp_path, root="192.168.1.1:/export")
    assert resolved is False


def test_mirrored_esps_protect_every_backing_disk(tmp_path):
    # Direct /dev root plus ESPs on two disks: both must be protected.
    resolved, disks = run_resolver(
        tmp_path,
        root="/dev/nvme0n1p2",
        esps=["/dev/nvme0n1p1", "/dev/nvme1n1p1"],
    )
    assert resolved is True
    assert disks == ["/dev/nvme0n1", "/dev/nvme1n1"]
