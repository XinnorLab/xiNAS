"""Regression guard for findings #9 and #11 (InstallationFeedback).

The perf_tuning role ships a oneshot systemd unit that re-applies tunables which
do not survive a reboot: vm.swappiness (clobbered by the common role's
swappiness=10 at boot) and the THP 'defrag' sysfs knob (the kernel cmdline pins
'enabled' but not 'defrag'). The on-host check is "restart the unit, defrag is
[never] and swappiness is 1"; this test pins the unit template's structure and
its perf_disable_thp gating so a future edit cannot silently drop the re-apply.
"""

from __future__ import annotations

from pathlib import Path

import jinja2

REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = REPO_ROOT / "collection/roles/perf_tuning/templates/xinas-perf-runtime.service.j2"


def _render(perf_disable_thp: bool) -> str:
    return jinja2.Template(TEMPLATE.read_text()).render(
        ansible_managed="Ansible managed: do not edit",
        perf_disable_thp=perf_disable_thp,
    )


def test_unit_reapplies_sysctl_and_enables_at_boot():
    out = _render(perf_disable_thp=True)
    # Re-apply all drop-ins, then force the perf VM file (swappiness=1) to win.
    assert "ExecStart=/sbin/sysctl --system" in out
    assert "ExecStart=/sbin/sysctl -p /etc/sysctl.d/90-perf-vm.conf" in out
    # Oneshot that stays "active" and is pulled in at boot.
    assert "Type=oneshot" in out
    assert "RemainAfterExit=yes" in out
    assert "WantedBy=multi-user.target" in out


def test_unit_pins_thp_defrag_when_thp_disabled():
    out = _render(perf_disable_thp=True)
    assert "echo never > /sys/kernel/mm/transparent_hugepage/defrag" in out


def test_unit_omits_thp_lines_when_thp_enabled():
    # If THP is intentionally left on, the unit must not force it off.
    out = _render(perf_disable_thp=False)
    assert "transparent_hugepage" not in out
