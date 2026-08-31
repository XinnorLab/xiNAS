"""VM-profile drive eligibility — docs/Storage/raid-management-spec.md §2.6.

Both drive pickers (Create Array §4, Spare Pools §7.2) used to hard-code
"``nvme`` in the name". On a VM that made day-2 management refuse the very
disks the installer's own VM fallback had just built an array from: Physical
Drives listed ``vdb`` as ``Available`` while Create Pool said "no available
drives". The rule now lives in ``utils/host_profile`` and admits ``vd*`` /
``sd*`` when — and only when — the host is virtual.
"""

from __future__ import annotations

import asyncio

from xinas_menu.screens.raid import _drive_groups, _no_drives_message
from xinas_menu.screens.spare_pools import _get_free_nvme_drives, _no_free_drives_message
from xinas_menu.utils import host_profile


def _fake_virt(tmp_path, stdout: str, rc: int):
    """Put a stub `systemd-detect-virt` on PATH; return the new PATH value."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "systemd-detect-virt"
    stub.write_text(f"#!/bin/sh\necho {stdout}\nexit {rc}\n")
    stub.chmod(0o755)
    return str(bin_dir)


# --- is_vm() ----------------------------------------------------------------


def test_is_vm_true_when_detect_virt_names_a_hypervisor(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", _fake_virt(tmp_path, "kvm", 0))
    host_profile.is_vm.cache_clear()
    assert host_profile.is_vm() is True


def test_is_vm_false_on_bare_metal_despite_the_nonzero_exit(tmp_path, monkeypatch):
    """`systemd-detect-virt` exits 1 on bare metal. A reader that gates on the
    exit status would call every physical node "detection failed"; the rule is
    stdout, matching startup_menu.sh's is_vm() and the nvme_namespace fallback.
    """
    monkeypatch.setenv("PATH", _fake_virt(tmp_path, "none", 1))
    host_profile.is_vm.cache_clear()
    assert host_profile.is_vm() is False


def test_is_vm_false_when_detect_virt_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    host_profile.is_vm.cache_clear()
    assert host_profile.is_vm() is False


def test_is_vm_is_cached_across_calls(tmp_path, monkeypatch):
    """Virtualization cannot change under a running TUI, and both pickers ask
    per drive row — a shell-out per row would be the whole cost of the fetch."""
    marker = tmp_path / "calls"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "systemd-detect-virt"
    stub.write_text(f"#!/bin/sh\necho x >> {marker}\necho kvm\n")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))
    host_profile.is_vm.cache_clear()

    assert host_profile.is_vm() is True
    assert host_profile.is_vm() is True
    assert len(marker.read_text().splitlines()) == 1


# --- selectable_drive_name() ------------------------------------------------


def test_bare_metal_offers_nvme_only(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: False)
    assert host_profile.selectable_drive_name("nvme0n1") is True
    assert host_profile.selectable_drive_name("vdb") is False
    assert host_profile.selectable_drive_name("sdb") is False


def test_vm_also_offers_virtio_and_scsi(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: True)
    assert host_profile.selectable_drive_name("vdb") is True
    assert host_profile.selectable_drive_name("sdb") is True
    assert host_profile.selectable_drive_name("nvme0n1") is True


def test_xiraid_array_devices_are_never_offered(monkeypatch):
    """`xi_data` / `xi_log` are the arrays themselves. `startswith` for the two
    new prefixes (not a substring test) is what keeps them out on a VM.
    """
    for virtual in (True, False):
        monkeypatch.setattr(host_profile, "is_vm", lambda v=virtual: v)
        assert host_profile.selectable_drive_name("xi_data") is False
        assert host_profile.selectable_drive_name("xi_log") is False


# --- Create Array wizard groups ---------------------------------------------


def _row(name: str, size: int = 4_000_000_000, **over):
    row = {
        "id": name,
        "name": name,
        "device_path": f"/dev/{name}",
        "size_bytes": size,
        "numa_node": 0,
        "system": False,
        "safe_for_use": True,
        "claimed": False,
    }
    row.update(over)
    return row


def test_wizard_offers_virtio_drives_on_a_vm(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: True)
    _groups, pickable = _drive_groups([_row("vdb"), _row("vdc"), _row("sdb")])
    assert sorted(d["name"] for d in pickable) == ["sdb", "vdb", "vdc"]


def test_wizard_still_refuses_virtio_drives_on_bare_metal(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: False)
    _groups, pickable = _drive_groups([_row("vdb"), _row("sdb"), _row("nvme0n1")])
    assert [d["name"] for d in pickable] == ["nvme0n1"]


def test_group_labels_stay_nvme_when_every_member_is_nvme(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: False)
    groups, _ = _drive_groups([_row("nvme0n1"), _row("nvme1n1")])
    assert "All large NVMe, NUMA 0" in groups
    assert "All large NVMe (2 drives)" in groups


def test_group_labels_drop_the_nvme_noun_for_a_mixed_group(monkeypatch):
    """Calling a group of virtio disks "NVMe" would be a plain lie on screen."""
    monkeypatch.setattr(host_profile, "is_vm", lambda: True)
    groups, _ = _drive_groups([_row("nvme0n1"), _row("vdb")])
    assert "All large drives, NUMA 0" in groups
    assert not any("NVMe" in label for label in groups)


# --- Spare Pools ------------------------------------------------------------


class _StubControl:
    def __init__(self, disks, pools=(), arrays=()):
        self._envelopes = {
            "/api/v1/disks": {"result": list(disks)},
            "/api/v1/arrays": {"result": list(arrays)},
            "/api/v1/pools": {"result": list(pools)},
        }

    def get(self, path: str) -> dict:
        return self._envelopes[path]

    def result(self, path: str):
        return self._envelopes[path].get("result")


def _api_disk(name: str):
    return {
        "id": name,
        "status": {
            "name": name,
            "device_path": f"/dev/{name}",
            "system_disk": False,
            "safe_for_use": True,
        },
    }


def test_pools_offer_virtio_drives_on_a_vm(monkeypatch):
    monkeypatch.setattr(host_profile, "is_vm", lambda: True)
    free = asyncio.run(_get_free_nvme_drives(_StubControl([_api_disk("vdb"), _api_disk("vdc")])))
    assert sorted(d["name"] for d in free.drives) == ["vdb", "vdc"]
    assert free.excluded_by_name == []


def test_pools_report_which_drives_the_name_rule_dropped(monkeypatch):
    """The old message claimed the drives were "assigned to RAID arrays or
    other pools" — they were free, they just were not NVMe."""
    monkeypatch.setattr(host_profile, "is_vm", lambda: False)
    free = asyncio.run(_get_free_nvme_drives(_StubControl([_api_disk("vdb"), _api_disk("sdc")])))
    assert free.drives == []
    assert free.excluded_by_name == ["sdc", "vdb"]


def test_a_claimed_drive_is_not_reported_as_name_excluded(monkeypatch):
    """`excluded_by_name` must mean "dropped by the name rule alone" — a drive
    that is already an array member is out for a reason the operator can see.
    """
    monkeypatch.setattr(host_profile, "is_vm", lambda: False)
    control = _StubControl(
        [_api_disk("vdb")],
        arrays=[{"spec": {"member_disk_ids": ["vdb"], "spare_disk_ids": []}}],
    )
    free = asyncio.run(_get_free_nvme_drives(control))
    assert free.excluded_by_name == []


def test_pool_empty_state_names_the_excluded_drives():
    message = _no_free_drives_message(
        "No available drives found.",
        None,
        specific="All drives are assigned to RAID arrays or other pools.",
        excluded_by_name=["sdb", "sdc"],
    )
    assert "sdb" in message and "sdc" in message
    assert "All drives are assigned" not in message, (
        "the drives were not assigned to anything — that claim is what hid the real reason"
    )


def test_pool_empty_state_keeps_the_specific_reason_when_nothing_was_name_excluded():
    message = _no_free_drives_message(
        "No available drives found.",
        None,
        specific="All drives are assigned to RAID arrays or other pools.",
        excluded_by_name=[],
    )
    assert "All drives are assigned to RAID arrays or other pools." in message


def test_wizard_empty_state_names_the_excluded_drives():
    message = _no_drives_message(None, excluded_by_name=["sdb"])
    assert "sdb" in message


def test_wizard_empty_state_prefers_the_banner_over_the_name_list():
    """A degraded fetch never observed every drive, so the "these were excluded"
    list is not a complete answer — the banner is the honest one."""
    message = _no_drives_message("collector unavailable", excluded_by_name=["sdb"])
    assert "collector unavailable" in message
    assert "sdb" not in message


def test_the_real_repro_two_fresh_virtio_disks_on_a_vm(tmp_path, monkeypatch):
    """End to end over the reported bug, with a real `systemd-detect-virt` stub
    rather than a patched `is_vm`: a VM with two added virtio disks that
    Physical Drives shows as `Available`, and Create Pool refused.
    """
    monkeypatch.setenv("PATH", _fake_virt(tmp_path, "kvm", 0))
    host_profile.is_vm.cache_clear()
    try:
        free = asyncio.run(
            _get_free_nvme_drives(_StubControl([_api_disk("vdb"), _api_disk("vdc")]))
        )
    finally:
        host_profile.is_vm.cache_clear()
    assert sorted(d["name"] for d in free.drives) == ["vdb", "vdc"]
