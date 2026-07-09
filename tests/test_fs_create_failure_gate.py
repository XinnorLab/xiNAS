"""fs.create force-retry gating: the ⚠ Create Failed / "Retry with force?"
consent must appear ONLY when the task failed on the fs-executor's
existing-filesystem destruction gate — not on every TaskFailed."""

from xinas_menu.api.control_client import TaskFailed
from xinas_menu.screens.filesystem import _is_existing_fs_gate


def _failed(detail: str | None) -> TaskFailed:
    return TaskFailed("t1", "failed", "FAILED_PARTIAL_ROLLED_BACK", detail)


def test_destruction_gate_failure_offers_force_retry():
    exc = _failed(
        "preflight: /dev/xi_data already carries a xfs filesystem "
        "(label 'nfsdata') — re-plan with force: true to overwrite"
    )
    assert _is_existing_fs_gate(exc) is True


def test_live_mountpoint_failure_does_not_offer_force_retry():
    exc = _failed("preflight: /mnt/data is already a live mountpoint (/dev/sda1)")
    assert _is_existing_fs_gate(exc) is False


def test_unit_exists_failure_does_not_offer_force_retry():
    exc = _failed("preflight: unit mnt-data.mount already exists on disk")
    assert _is_existing_fs_gate(exc) is False


def test_detail_free_failure_does_not_offer_force_retry():
    assert _is_existing_fs_gate(_failed(None)) is False
