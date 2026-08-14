"""WS5.4 — three unrelated small fixes, one module.

Each guards a place the TUI reported something it had not observed, or ran an
unbounded command: the MCP restart audit record, OS-disk detection on an
LVM/MD/ZFS root, and the health-check remediation runner.
"""

from __future__ import annotations

import asyncio
import json
import subprocess

from xinas_menu.screens.mcp import MCPScreen


class _StubAudit:
    def __init__(self):
        self.calls = []

    def log(self, *args):
        self.calls.append(args)


class _StubApp:
    def __init__(self):
        self.audit = _StubAudit()

    async def push_screen_wait(self, dialog):
        return True


class _StubView:
    def __init__(self):
        self.content = None

    def set_content(self, text):
        self.content = text


class _StubMCPScreen:
    """Hand-built `self` for driving `MCPScreen._restart.__wrapped__` directly.

    The source-text test above cannot tell "OK" hardcoded behind an
    always-true condition from a real dataflow check, so this drives the
    actual coroutine with a `ServiceController` stubbed to fail, and checks
    what actually reaches `audit.log` and the rendered view.
    """

    def __init__(self):
        self.app = _StubApp()
        self._view = _StubView()

    def query_one(self, selector, cls):
        return self._view

    def _show_status(self):
        pass


def test_mcp_restart_audits_fail_when_the_restart_actually_fails(monkeypatch):
    """A `ServiceController.restart` that reports failure must produce a
    `FAIL` audit row and a failure-coloured view, not `OK` — driving the real
    method, not just checking its source text."""
    from xinas_menu.utils import service_ctl

    class _FailingCtl:
        def restart(self, name):
            return False, "unit failed to start: boom"

    monkeypatch.setattr(service_ctl, "ServiceController", _FailingCtl)

    screen = _StubMCPScreen()
    asyncio.run(MCPScreen._restart.__wrapped__(screen))

    assert screen.app.audit.calls == [("mcp.restart", "xinas-nfs-helper", "FAIL")]
    assert "FAILED" in screen._view.content
    assert "boom" in screen._view.content


def test_mcp_restart_audits_ok_when_the_restart_actually_succeeds(monkeypatch):
    """Sanity check on the same path: a genuine success is still recorded as
    OK (guards against a fix that flips the polarity)."""
    from xinas_menu.utils import service_ctl

    class _SucceedingCtl:
        def restart(self, name):
            return True, ""

    monkeypatch.setattr(service_ctl, "ServiceController", _SucceedingCtl)

    screen = _StubMCPScreen()
    asyncio.run(MCPScreen._restart.__wrapped__(screen))

    assert screen.app.audit.calls == [("mcp.restart", "xinas-nfs-helper", "OK")]
    assert "restarted" in screen._view.content.lower()


_LVM_ROOT_TREE = {
    "blockdevices": [
        {
            "name": "sda",
            "mountpoint": None,
            "type": "disk",
            "children": [
                {
                    "name": "sda2",
                    "mountpoint": None,
                    "type": "part",
                    "children": [
                        {"name": "ubuntu--vg-ubuntu--lv", "mountpoint": "/", "type": "lvm"}
                    ],
                }
            ],
        },
        {"name": "nvme0n1", "mountpoint": None, "type": "disk", "children": []},
    ]
}


def test_os_disk_on_an_lvm_root_is_detected(monkeypatch):
    """`/` on a grandchild (disk -> part -> lvm) still marks the disk as OS."""
    from xinas_menu.api import grpc_client

    def _fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(_LVM_ROOT_TREE), stderr="")

    monkeypatch.setattr(grpc_client.subprocess, "run", _fake_run)
    assert grpc_client._get_os_drives() == {"sda"}


def test_data_disk_is_not_flagged(monkeypatch):
    from xinas_menu.api import grpc_client

    def _fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(_LVM_ROOT_TREE), stderr="")

    monkeypatch.setattr(grpc_client.subprocess, "run", _fake_run)
    assert "nvme0n1" not in grpc_client._get_os_drives()


# Same shape as _LVM_ROOT_TREE but with the OS disk and the data disk swapped,
# and different names throughout. A fake implementation that just hardcodes
# {"sda"} (which happens to satisfy both tests above, since "nvme0n1" is
# simply never in that hardcoded set) cannot pass this one too.
_LVM_ROOT_TREE_SWAPPED = {
    "blockdevices": [
        {"name": "nvme1n1", "mountpoint": None, "type": "disk", "children": []},
        {
            "name": "nvme0n1",
            "mountpoint": None,
            "type": "disk",
            "children": [
                {
                    "name": "nvme0n1p2",
                    "mountpoint": None,
                    "type": "part",
                    "children": [{"name": "vgroot-lvroot", "mountpoint": "/", "type": "lvm"}],
                }
            ],
        },
    ]
}


def test_os_disk_detection_is_not_hardcoded_to_a_fixed_name(monkeypatch):
    """Swap which disk hosts the LVM root relative to the other fixture — a
    hardcoded `{"sda"}` return would pass the two tests above but fail here."""
    from xinas_menu.api import grpc_client

    def _fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(
            cmd, 0, stdout=json.dumps(_LVM_ROOT_TREE_SWAPPED), stderr=""
        )

    monkeypatch.setattr(grpc_client.subprocess, "run", _fake_run)
    result = grpc_client._get_os_drives()
    assert result == {"nvme0n1"}
    assert "nvme1n1" not in result


def _action(command: list[str]):
    from xinas_menu.health import remediation as rem

    return rem.RemediationAction(
        check_name="stub_check", description="stub remediation", command=command
    )


def test_remediation_command_is_bounded_and_non_interactive(monkeypatch):
    """An unattended fix command must not be able to hang the wizard."""
    from xinas_menu.health import remediation as rem

    seen: dict = {}

    def _fake_run(cmd, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(rem.subprocess, "run", _fake_run)
    # RemediationWizard.__init__ requires json_path; apply() never reads
    # self._path/self._report, so a placeholder is fine here.
    wizard = rem.RemediationWizard(json_path="unused.json")
    wizard.apply(_action(["/bin/true"]))

    assert isinstance(seen.get("timeout"), (int, float)) and seen["timeout"] > 0
    assert seen.get("stdin") is subprocess.DEVNULL


def test_remediation_timeout_is_reported_not_raised(monkeypatch):
    from xinas_menu.health import remediation as rem

    def _boom(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 120)

    monkeypatch.setattr(rem.subprocess, "run", _boom)
    ok, detail = rem.RemediationWizard(json_path="unused.json").apply(
        _action(["/bin/sleep", "999"])
    )
    assert ok is False
    assert "timed out" in detail.lower()
