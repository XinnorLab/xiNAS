"""hc_scheduler.py — manage systemd timer for health check scheduling."""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

from xinas_menu.utils.service_ctl import ServiceController

_log = logging.getLogger(__name__)

_TIMER_NAME = "xinas-healthcheck.timer"
_SERVICE_NAME = "xinas-healthcheck.service"
_UNIT_DIR = Path("/etc/systemd/system")

_SERVICE_TEMPLATE = """\
[Unit]
Description=xiNAS Scheduled Health Check
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -m xinas_menu.health.runner
Environment=PYTHONPATH=/opt/xiNAS
"""

_TIMER_TEMPLATE = """\
[Unit]
Description=xiNAS Health Check Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec={interval_hours}h
Persistent=true

[Install]
WantedBy=timers.target
"""


def _write_unit(path: Path, content: str) -> None:
    """Atomic write of a systemd unit file."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, str(path))
    except Exception:
        os.unlink(tmp)
        raise


def scheduler_status() -> dict:
    """Return current scheduler state."""
    ctl = ServiceController()
    state = ctl.state(_TIMER_NAME)
    timer_path = _UNIT_DIR / _TIMER_NAME

    interval = None
    if timer_path.exists():
        for line in timer_path.read_text().splitlines():
            if line.strip().startswith("OnUnitActiveSec="):
                val = line.split("=", 1)[1].strip().rstrip("h")
                try:
                    interval = int(val)
                except ValueError:
                    pass

    r = subprocess.run(
        ["systemctl", "show", _TIMER_NAME,
         "--property=NextElapseUSecRealtime,LastTriggerUSec"],
        capture_output=True, text=True,
    )
    props: dict[str, str] = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            props[k.strip()] = v.strip()

    return {
        "enabled": state.load == "loaded" and state.active != "inactive",
        "active": state.is_active,
        "interval_hours": interval,
        "next_run": props.get("NextElapseUSecRealtime", "n/a"),
        "last_run": props.get("LastTriggerUSec", "n/a"),
    }


def scheduler_enable(interval_hours: int, profile: str = "standard") -> tuple[bool, str]:
    """Write systemd units and enable the timer."""
    ctl = ServiceController()

    try:
        svc_content = _SERVICE_TEMPLATE.rstrip() + f"\nEnvironment=HC_PROFILE={profile}\n"
        _write_unit(_UNIT_DIR / _SERVICE_NAME, svc_content)
        _write_unit(
            _UNIT_DIR / _TIMER_NAME,
            _TIMER_TEMPLATE.format(interval_hours=interval_hours),
        )
    except Exception as exc:
        return False, f"Failed to write unit files: {exc}"

    ok, err = ctl.daemon_reload()
    if not ok:
        return False, f"daemon-reload failed: {err}"

    ok, err = ctl.enable(_TIMER_NAME)
    if not ok:
        return False, f"enable failed: {err}"

    ok, err = ctl.start(_TIMER_NAME)
    if not ok:
        return False, f"start failed: {err}"

    _log.info("HC scheduler enabled: every %dh, profile=%s", interval_hours, profile)
    return True, ""


def scheduler_disable() -> tuple[bool, str]:
    """Stop and disable the health check timer."""
    ctl = ServiceController()

    ok, err = ctl.stop(_TIMER_NAME)
    if not ok and "not loaded" not in err.lower():
        return False, f"stop failed: {err}"

    ok, err = ctl.disable(_TIMER_NAME)
    if not ok and "not loaded" not in err.lower():
        return False, f"disable failed: {err}"

    _log.info("HC scheduler disabled")
    return True, ""
