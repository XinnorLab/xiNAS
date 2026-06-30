"""Regression guard for findings #9 and #11 (InstallationFeedback).

The perf_tuning role ships a oneshot systemd unit that re-applies tunables which
do not survive a reboot: vm.swappiness (clobbered by the common role's
swappiness=10 at boot) and the THP 'defrag' sysfs knob (the kernel cmdline pins
'enabled' but not 'defrag'). The on-host check is "restart the unit, defrag is
[never] and swappiness is 1"; this test pins the unit template's structure and
its perf_disable_thp gating so a future edit cannot silently drop the re-apply.

The template is validated as text (not rendered): jinja2 is an ansible-layer
dependency and is intentionally not in the `[dev]` test extras (which mirror the
TUI deployment venv). The Jinja itself is validated by the `ansible` CI job.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = REPO_ROOT / "collection/roles/perf_tuning/templates/xinas-perf-runtime.service.j2"


def _template_text() -> str:
    return TEMPLATE.read_text()


def test_unit_reapplies_sysctl_and_enables_at_boot():
    text = _template_text()
    # Re-apply all drop-ins, then force the perf VM file (swappiness=1) to win.
    assert "ExecStart=/sbin/sysctl --system" in text
    assert "ExecStart=/sbin/sysctl -p /etc/sysctl.d/90-perf-vm.conf" in text
    # Oneshot that stays "active" and is pulled in at boot.
    assert "Type=oneshot" in text
    assert "RemainAfterExit=yes" in text
    assert "WantedBy=multi-user.target" in text


def test_thp_defrag_is_gated_on_perf_disable_thp():
    # The THP re-pin must live inside the `{% if perf_disable_thp %}` guard so
    # it is omitted when THP is intentionally left enabled, and the
    # unconditional sysctl re-apply must sit outside (before) that guard.
    text = _template_text()
    if_idx = text.index("{% if perf_disable_thp %}")
    endif_idx = text.index("{% endif %}", if_idx)
    defrag_idx = text.index("echo never > /sys/kernel/mm/transparent_hugepage/defrag")
    sysctl_idx = text.index("ExecStart=/sbin/sysctl --system")

    assert if_idx < defrag_idx < endif_idx, "THP defrag re-pin must be gated by perf_disable_thp"
    assert sysctl_idx < if_idx, "the sysctl re-apply must be unconditional (outside the THP guard)"
