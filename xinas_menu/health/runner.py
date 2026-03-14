"""runner.py — CLI entry point for scheduled health checks.

Invoked by the systemd timer: python3 -m xinas_menu.health.runner

Runs the health engine with the configured profile, then emails the results
if email is enabled in /etc/xinas-mcp/config.json.
"""
from __future__ import annotations

import json
import logging
import os
import re
import socket
import sys
from datetime import datetime
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_log = logging.getLogger("xinas_menu.health.runner")

_LOG_DIR = "/var/log/xinas/healthcheck"
_PROFILES_DIR_CANDIDATES = [
    Path("/opt/xiNAS/healthcheck_profiles"),
    Path(__file__).parent.parent.parent / "healthcheck_profiles",
    Path("/home/xinnor/xiNAS/healthcheck_profiles"),
]


def _find_profile(name: str) -> Path | None:
    for d in _PROFILES_DIR_CANDIDATES:
        for ext in (".yml", ".yaml"):
            p = d / f"{name}{ext}"
            if p.exists():
                return p
    return None


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape codes for plain-text email."""
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def main() -> None:
    profile_name = os.environ.get("HC_PROFILE", "standard")
    _log.info("Starting scheduled health check (profile=%s)", profile_name)

    profile_path = _find_profile(profile_name)
    if profile_path is None:
        _log.error("Profile '%s' not found", profile_name)
        sys.exit(1)

    Path(_LOG_DIR).mkdir(parents=True, exist_ok=True)

    from xinas_menu.health.engine import run_health_check

    try:
        text_report, json_path = run_health_check(
            str(profile_path), _LOG_DIR, []
        )
    except Exception as exc:
        _log.error("Health check failed: %s", exc)
        sys.exit(1)

    _log.info("Health check complete. Report: %s", json_path)

    summary = "completed"
    if json_path:
        try:
            data = json.loads(Path(json_path).read_text())
            n_fail = data.get("summary", {}).get("fail", 0)
            n_warn = data.get("summary", {}).get("warn", 0)
            n_pass = data.get("summary", {}).get("pass", 0)
            if n_fail:
                summary = f"FAIL ({n_fail} failed, {n_warn} warnings, {n_pass} passed)"
            elif n_warn:
                summary = f"WARN ({n_warn} warnings, {n_pass} passed)"
            else:
                summary = f"OK ({n_pass} passed)"
        except Exception:
            pass

    from xinas_menu.utils.config import cfg_read
    config = cfg_read()
    email_cfg = config.get("email", {})

    if email_cfg.get("enabled") and email_cfg.get("to_addrs"):
        from xinas_menu.utils.email_sender import send_email

        hostname = socket.gethostname()
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        subject = f"[xiNAS] Health Check {summary} — {hostname} ({timestamp})"
        body = _strip_ansi(text_report) if text_report else "No output from health engine."

        ok, err = send_email(subject, body, config)
        if ok:
            _log.info("Email report sent to %s", email_cfg["to_addrs"])
        else:
            _log.error("Email send failed: %s", err)
    else:
        _log.info("Email not configured — skipping notification")


if __name__ == "__main__":
    main()
