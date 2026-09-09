"""S19c (spec §8.5, AC-06, G-03): the engine names what it cannot check.

``deep.yml`` enables a ``kerberos`` section, but ``engine.main()`` only ever
iterated its own ``section_map`` — an enabled section without a checker
silently produced nothing, so a profile could claim coverage the engine
never had. Now every enabled section without a checker yields one SKIP
``checker`` row, and ``python3 -m xinas_menu.health --sections`` publishes
the supported list so the api can compute ``sections_without_checker``
from the engine rather than from a copy of its keys.
"""

from __future__ import annotations

import json
import sys

import pytest

from xinas_menu.health import engine
from xinas_menu.version import XINAS_MENU_VERSION


def _run_main(monkeypatch, capsys, argv):
    monkeypatch.setattr(sys, "argv", ["health_engine", *argv])
    code = 0
    try:
        engine.main()
    except SystemExit as exc:  # pragma: no cover - only on the error paths
        code = int(exc.code or 0)
    return code, capsys.readouterr()


def test_sections_flag_prints_the_supported_sections_and_the_version(monkeypatch, capsys):
    code, out = _run_main(monkeypatch, capsys, ["--sections"])
    assert code == 0
    payload = json.loads(out.out)
    assert payload == {"sections": list(engine.SUPPORTED_SECTIONS), "version": XINAS_MENU_VERSION}
    assert "nvme_health" in payload["sections"]
    assert "kerberos" not in payload["sections"]
    assert out.err == ""


def _profile(tmp_path, sections):
    """Write a profile in the engine's own (PyYAML-free) YAML dialect."""
    lines = ["profile: t", "description: test", "timeout_seconds: 10", "sections:"]
    for name, cfg in sections.items():
        lines.append(f"  {name}:")
        lines.append(f"    enabled: {'true' if cfg['enabled'] else 'false'}")
        checks = cfg["checks"]
        if checks:
            lines.append("    checks:")
            lines.extend(f"      - {check}" for check in checks)
        else:
            lines.append("    checks: []")
    lines.append("expectations: {}")
    path = tmp_path / "profile.yml"
    path.write_text("\n".join(lines) + "\n")
    return path


def _silence_checkers(monkeypatch):
    for name in engine.SUPPORTED_SECTIONS:
        monkeypatch.setattr(engine, f"check_{name}", lambda _exp, _checks: [])


def test_enabled_section_without_a_checker_is_a_skip_row(monkeypatch, capsys, tmp_path):
    _silence_checkers(monkeypatch)
    profile = _profile(
        tmp_path,
        {
            "storage": {"enabled": True, "checks": ["raid_status"]},
            "kerberos": {"enabled": True, "checks": ["krb5_conf", "klist_ticket"]},
        },
    )
    code, out = _run_main(
        monkeypatch, capsys, [str(profile), str(tmp_path / "logs"), "--json", "--no-save"]
    )
    assert code == 0
    report = json.loads(out.out)
    assert report["checks"] == [
        {
            "section": "kerberos",
            "name": "checker",
            "status": "SKIP",
            "actual": "not supported by this engine",
            "expected": "N/A",
            "evidence": "section has no checker",
            "impact": "",
            "fix_hint": "",
        }
    ]
    assert report["summary"]["skip"] == 1
    assert not (tmp_path / "logs").exists()


def test_disabled_or_empty_unknown_sections_produce_no_row(monkeypatch, capsys, tmp_path):
    _silence_checkers(monkeypatch)
    profile = _profile(
        tmp_path,
        {
            "kerberos": {"enabled": False, "checks": ["krb5_conf"]},
            "zzz": {"enabled": True, "checks": []},
        },
    )
    code, out = _run_main(
        monkeypatch, capsys, [str(profile), str(tmp_path / "logs"), "--json", "--no-save"]
    )
    assert code == 0
    assert json.loads(out.out)["checks"] == []


def test_supported_sections_match_the_checker_functions():
    for name in engine.SUPPORTED_SECTIONS:
        assert callable(getattr(engine, f"check_{name}"))
    assert len(set(engine.SUPPORTED_SECTIONS)) == len(engine.SUPPORTED_SECTIONS)


@pytest.mark.parametrize("argv", [[], ["only-one-arg"]])
def test_usage_error_still_exits_1(monkeypatch, capsys, argv):
    code, out = _run_main(monkeypatch, capsys, argv)
    assert code == 1
    assert "Usage" in out.err
