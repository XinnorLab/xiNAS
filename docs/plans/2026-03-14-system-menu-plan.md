# System Menu Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganize the flat 11-item main menu into 4 logical groups (System, Storage, Network, Management) and add Settings screen with email configuration and health-check scheduler.

**Architecture:** Three new submenu screens route to existing screens. New System Status dashboard mirrors `xinas-status` MOTD output. New Settings screen manages email (SMTP via smtplib) and health-check scheduler (systemd timer). Config stored in existing `/etc/xinas-mcp/config.json`. New `health/runner.py` CLI entry point for scheduled execution.

**Tech Stack:** Python 3.10+, Textual TUI, systemd timers, smtplib, existing gRPC/NFS helpers, existing `service_ctl.py` and `subprocess_utils.py`

**Design doc:** `docs/plans/2026-03-14-system-menu-design.md`

---

## Task 1: Config Helpers — Extract shared config read/write

Move `_cfg_read` / `_cfg_write` from `mcp.py` to a shared utility so Settings and MCP can both use them.

**Files:**
- Create: `xinas_menu/utils/config.py`
- Modify: `xinas_menu/screens/mcp.py`

**Step 1: Create `xinas_menu/utils/config.py`**

```python
"""config.py — shared config read/write for /etc/xinas-mcp/config.json."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

CONFIG_PATH = Path("/etc/xinas-mcp/config.json")


def cfg_read() -> dict:
    """Read config JSON, returning empty dict on failure."""
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {}


def cfg_write(data: dict) -> None:
    """Atomic write of config JSON (mktemp + rename, mode 0600)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, str(CONFIG_PATH))
    except Exception:
        os.unlink(tmp)
        raise
```

**Step 2: Update `xinas_menu/screens/mcp.py`**

Replace the local `_MCP_CONFIG`, `_cfg_read`, `_cfg_write` definitions with imports:

```python
from xinas_menu.utils.config import CONFIG_PATH as _MCP_CONFIG, cfg_read as _cfg_read, cfg_write as _cfg_write
```

Remove lines 24 and 28-52 (the old definitions). Keep `_cfg_restart_service` local to mcp.py.

**Step 3: Verify syntax**

Run: `python3 -m py_compile xinas_menu/utils/config.py && python3 -m py_compile xinas_menu/screens/mcp.py`
Expected: no output (success)

**Step 4: Commit**

```bash
git add xinas_menu/utils/config.py xinas_menu/screens/mcp.py
git commit -m "refactor: extract shared config read/write to utils/config.py"
```

---

## Task 2: Email Sender Utility

**Files:**
- Create: `xinas_menu/utils/email_sender.py`

**Step 1: Create `xinas_menu/utils/email_sender.py`**

```python
"""email_sender.py — send email via SMTP using xiNAS config."""
from __future__ import annotations

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

_log = logging.getLogger(__name__)


def send_email(
    subject: str,
    body: str,
    config: dict,
    html: bool = False,
) -> tuple[bool, str]:
    """Send an email using SMTP settings from config["email"].

    Args:
        subject: Email subject line.
        body: Plain text (or HTML if html=True) body.
        config: Full xiNAS config dict (reads config["email"]).
        html: If True, send as HTML; otherwise plain text.

    Returns:
        (ok, error_message) — ok=True on success, error_message="" on success.
    """
    email_cfg = config.get("email", {})
    if not email_cfg.get("enabled"):
        return False, "Email not enabled in settings"

    host = email_cfg.get("smtp_host", "")
    port = int(email_cfg.get("smtp_port", 587))
    use_tls = email_cfg.get("smtp_tls", True)
    user = email_cfg.get("smtp_user", "")
    password = email_cfg.get("smtp_password", "")
    from_addr = email_cfg.get("from_addr", user)
    to_addrs = email_cfg.get("to_addrs", [])

    if not host:
        return False, "SMTP host not configured"
    if not to_addrs:
        return False, "No recipient addresses configured"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(to_addrs)
    content_type = "html" if html else "plain"
    msg.attach(MIMEText(body, content_type))

    try:
        if use_tls:
            smtp = smtplib.SMTP(host, port, timeout=30)
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
        else:
            smtp = smtplib.SMTP(host, port, timeout=30)
            smtp.ehlo()

        if user and password:
            smtp.login(user, password)

        smtp.sendmail(from_addr, to_addrs, msg.as_string())
        smtp.quit()
        _log.info("Email sent to %s: %s", to_addrs, subject)
        return True, ""
    except Exception as exc:
        _log.warning("Email send failed: %s", exc)
        return False, str(exc)
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/utils/email_sender.py`

**Step 3: Commit**

```bash
git add xinas_menu/utils/email_sender.py
git commit -m "feat: add email sender utility (smtplib)"
```

---

## Task 3: Health Check Scheduler Utility

**Files:**
- Create: `xinas_menu/utils/hc_scheduler.py`

**Step 1: Create `xinas_menu/utils/hc_scheduler.py`**

```python
"""hc_scheduler.py — manage systemd timer for health check scheduling."""
from __future__ import annotations

import logging
import os
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
    """Return current scheduler state.

    Returns dict with keys:
        enabled (bool), active (bool), interval_hours (int | None),
        next_run (str), last_run (str)
    """
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

    # Get next/last run from systemctl show
    import subprocess
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
    """Write systemd units and enable the timer.

    Args:
        interval_hours: Run interval in hours (1-168).
        profile: Health check profile name (quick/standard/deep).

    Returns:
        (ok, error_message)
    """
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
    """Stop and disable the health check timer.

    Returns:
        (ok, error_message)
    """
    ctl = ServiceController()

    ok, err = ctl.stop(_TIMER_NAME)
    if not ok and "not loaded" not in err.lower():
        return False, f"stop failed: {err}"

    ok, err = ctl.disable(_TIMER_NAME)
    if not ok and "not loaded" not in err.lower():
        return False, f"disable failed: {err}"

    _log.info("HC scheduler disabled")
    return True, ""
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/utils/hc_scheduler.py`

**Step 3: Commit**

```bash
git add xinas_menu/utils/hc_scheduler.py
git commit -m "feat: add health check scheduler utility (systemd timer)"
```

---

## Task 4: Health Check Runner CLI Entry Point

**Files:**
- Create: `xinas_menu/health/runner.py`

**Step 1: Create `xinas_menu/health/runner.py`**

```python
"""runner.py — CLI entry point for scheduled health checks.

Invoked by the systemd timer: python3 -m xinas_menu.health.runner

Runs the health engine with the configured profile, then emails the results
if email is enabled in /etc/xinas-mcp/config.json.
"""
from __future__ import annotations

import json
import logging
import os
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
    import re
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def main() -> None:
    profile_name = os.environ.get("HC_PROFILE", "standard")
    _log.info("Starting scheduled health check (profile=%s)", profile_name)

    profile_path = _find_profile(profile_name)
    if profile_path is None:
        _log.error("Profile '%s' not found", profile_name)
        sys.exit(1)

    # Ensure log directory exists
    Path(_LOG_DIR).mkdir(parents=True, exist_ok=True)

    # Run health check
    from xinas_menu.health.engine import run_health_check

    try:
        text_report, json_path = run_health_check(
            str(profile_path), _LOG_DIR, []
        )
    except Exception as exc:
        _log.error("Health check failed: %s", exc)
        sys.exit(1)

    _log.info("Health check complete. Report: %s", json_path)

    # Parse results summary for email subject
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

    # Send email if configured
    from xinas_menu.utils.config import cfg_read
    config = cfg_read()
    email_cfg = config.get("email", {})

    if email_cfg.get("enabled") and email_cfg.get("to_addrs"):
        from xinas_menu.utils.email_sender import send_email

        import socket
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
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/health/runner.py`

**Step 3: Commit**

```bash
git add xinas_menu/health/runner.py
git commit -m "feat: add health check runner CLI for systemd timer"
```

---

## Task 5: System Status Screen

**Files:**
- Create: `xinas_menu/screens/system_status.py`

**Step 1: Create `xinas_menu/screens/system_status.py`**

This screen mirrors the `xinas-status` MOTD. Primary strategy: call the existing `xinas-status` script if available (exactly what `_collect_system_status()` in `quick_actions.py` already does). Fallback: build the dashboard from system data.

```python
"""SystemStatusScreen — dashboard mirroring xinas-status MOTD."""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Refresh"),
    MenuItem("0", "Back"),
]


class SystemStatusScreen(Screen):
    """System status dashboard — mirrors xinas-status MOTD output."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  System Status", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="status-nav")
            yield ScrollableTextView("  Loading...", id="status-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_status()
        self._auto_refresh = self.set_interval(10, self._refresh_status)

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._refresh_status()

    @work(exclusive=True)
    async def _refresh_status(self) -> None:
        view = self.query_one("#status-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        # Primary: run xinas-status script
        text = await loop.run_in_executor(None, _run_xinas_status)

        if text:
            view.set_content(text)
        else:
            # Fallback: build from system data
            fallback = await loop.run_in_executor(None, _build_fallback_status)
            view.set_content(fallback)

        # Append xiRAID info via gRPC
        try:
            ok, info, err = await asyncio.wait_for(
                self.app.grpc.get_server_info(), timeout=5,
            )
            if ok:
                view.append(f"\n  xiRAID: connected\n{_format_server_info(info)}")
            else:
                view.append(f"\n  xiRAID: {grpc_short_error(err)}")
        except asyncio.TimeoutError:
            view.append("\n  xiRAID: timed out")
        except Exception:
            _log.debug("gRPC server_info failed", exc_info=True)


def _run_xinas_status() -> str:
    """Run xinas-status if available and return its colored output."""
    xinas_status = shutil.which("xinas-status")
    if not xinas_status:
        return ""
    try:
        env = {**os.environ}
        env.setdefault("TERM", "xterm-256color")
        r = subprocess.run(
            ["bash", xinas_status],
            capture_output=True, text=True, timeout=10,
            env=env,
        )
        raw = r.stdout or r.stderr or ""
        if raw.strip():
            return raw
    except Exception:
        _log.debug("xinas-status failed", exc_info=True)
    return ""


def _build_fallback_status() -> str:
    """Build status from /proc, sysfs, etc. when xinas-status is not installed."""
    GRN, YLW, RED, CYN, BLD, DIM, NC = (
        "\033[32m", "\033[33m", "\033[31m", "\033[36m",
        "\033[1m", "\033[2m", "\033[0m",
    )
    lines: list[str] = [f"{BLD}{CYN}System Status{NC}\n"]

    # System info
    try:
        import platform
        lines.append(f"  {DIM}Hostname:{NC}  {GRN}{platform.node()}{NC}")
        lines.append(f"  {DIM}Kernel:{NC}    {platform.release()}")
    except Exception:
        pass

    # Uptime
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        days, rem = divmod(int(secs), 86400)
        hours, rem = divmod(rem, 3600)
        lines.append(f"  {DIM}Uptime:{NC}    {days}d {hours}h {rem // 60}m")
    except Exception:
        pass

    # NFS threads
    try:
        with open("/proc/fs/nfsd/threads") as f:
            threads = f.read().strip()
        lines.append(f"  {DIM}NFS Threads:{NC} {threads}")
    except Exception:
        pass

    lines.append("")

    # Resources
    lines.append(f"  {BLD}RESOURCES{NC}")
    try:
        with open("/proc/loadavg") as f:
            la = f.read().split()
        lines.append(f"  {DIM}Load:{NC}  {la[0]}  {la[1]}  {la[2]}")
    except Exception:
        pass

    try:
        with open("/proc/meminfo") as f:
            meminfo = {}
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    meminfo[parts[0].strip()] = parts[1].strip()
        total_kb = int(meminfo.get("MemTotal", "0 kB").split()[0])
        avail_kb = int(meminfo.get("MemAvailable", "0 kB").split()[0])
        used_kb = total_kb - avail_kb
        pct = (used_kb * 100 // total_kb) if total_kb else 0
        bar_len = 20
        filled = pct * bar_len // 100
        bar = f"{'█' * filled}{'░' * (bar_len - filled)}"
        color = GRN if pct < 70 else (YLW if pct < 90 else RED)
        lines.append(
            f"  {DIM}Memory:{NC} {color}{bar}{NC}  {pct}%  "
            f"({used_kb // 1048576:.1f} / {total_kb // 1048576:.1f} GB)"
        )
    except Exception:
        pass

    lines.append("")

    # Network
    lines.append(f"  {BLD}NETWORK{NC}")
    try:
        import pathlib
        net_dir = pathlib.Path("/sys/class/net")
        for iface in sorted(net_dir.iterdir()):
            name = iface.name
            if name == "lo":
                continue
            try:
                state = (iface / "operstate").read_text().strip()
            except Exception:
                state = "unknown"
            icon = f"{GRN}●{NC}" if state == "up" else f"{RED}○{NC}"

            # Speed
            try:
                speed = (iface / "speed").read_text().strip()
                speed_str = f"{int(speed) // 1000}G" if int(speed) >= 1000 else f"{speed}M"
            except Exception:
                speed_str = "?"

            # IP
            try:
                r = subprocess.run(
                    ["ip", "-4", "-o", "addr", "show", name],
                    capture_output=True, text=True, timeout=2,
                )
                import re
                m = re.search(r"inet\s+(\S+)", r.stdout)
                ip_str = m.group(1) if m else "no IP"
            except Exception:
                ip_str = "no IP"

            # Driver / type badge
            badge = "ETH"
            try:
                driver = (iface / "device" / "driver").resolve().name
                if "mlx" in driver:
                    badge = "RDMA"
            except Exception:
                pass
            try:
                itype = (iface / "type").read_text().strip()
                if itype == "32":
                    badge = "IB"
            except Exception:
                pass

            lines.append(f"  {icon} {name:<16} {DIM}{badge}{NC}  {ip_str:<20} {speed_str}")
    except Exception:
        pass

    lines.append("")

    # Services
    lines.append(f"  {BLD}SERVICES{NC}")
    try:
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        for svc in ("xiraid-server", "nfs-server", "xinas-nfs-helper", "xinas-mcp"):
            st = ctl.state(svc)
            if st.is_active:
                lines.append(f"  {GRN}●{NC} {svc:<28} {GRN}{st.active}{NC}")
            else:
                lines.append(f"  {RED}○{NC} {svc:<28} {RED}{st.active}{NC}")
    except Exception:
        pass

    return "\n".join(lines)


def _format_server_info(info) -> str:
    try:
        if isinstance(info, dict):
            lic = info.get("license")
            if lic:
                return f"  License: {lic}"
            return ""
        return f"  {info}"
    except Exception:
        return ""
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/system_status.py`

**Step 3: Commit**

```bash
git add xinas_menu/screens/system_status.py
git commit -m "feat: add System Status dashboard screen"
```

---

## Task 6: License Screen

**Files:**
- Create: `xinas_menu/screens/license.py`

**Step 1: Create `xinas_menu/screens/license.py`**

```python
"""LicenseScreen — show and set xiRAID license."""
from __future__ import annotations

import asyncio
import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Show License"),
    MenuItem("2", "Set License"),
    MenuItem("0", "Back"),
]


class LicenseScreen(Screen):
    """License management screen."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  License Management", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="license-nav")
            yield ScrollableTextView(id="license-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_license()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._show_license()
        elif event.key == "2":
            self._set_license()

    @work(exclusive=True)
    async def _show_license(self) -> None:
        view = self.query_one("#license-content", ScrollableTextView)
        view.set_content("  Loading license info...")
        ok, data, err = await self.app.grpc.license_show()
        if ok:
            GRN, BLD, DIM, NC = "\033[32m", "\033[1m", "\033[2m", "\033[0m"
            lines = [f"{BLD}License Information{NC}", ""]
            if isinstance(data, dict):
                for k, v in data.items():
                    lines.append(f"  {DIM}{k}:{NC}  {GRN}{v}{NC}")
            else:
                lines.append(f"  {data}")
            view.set_content("\n".join(lines))
        else:
            view.set_content(f"\033[31m  Error: {grpc_short_error(err)}\033[0m")

    @work(exclusive=True)
    async def _set_license(self) -> None:
        path = await self.app.push_screen_wait(
            InputDialog(
                "Enter path to license file:",
                "Set License",
                default="/tmp/license",
                placeholder="/tmp/license",
            )
        )
        if not path:
            return

        ok, data, err = await self.app.grpc.set_license(path)
        if ok:
            self.app.audit.log("license.set", path, "OK")
            self.app.notify("License set successfully", severity="information")
            self._show_license()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to set license.\n{grpc_short_error(err)}", "Error")
            )
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/license.py`

**Step 3: Commit**

```bash
git add xinas_menu/screens/license.py
git commit -m "feat: add License management screen"
```

---

## Task 7: Settings Screen

**Files:**
- Create: `xinas_menu/screens/settings.py`

**Step 1: Create `xinas_menu/screens/settings.py`**

```python
"""SettingsScreen — email config, HC scheduler, test email."""
from __future__ import annotations

import asyncio
import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.config import cfg_read, cfg_write
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Email Configuration"),
    MenuItem("2", "Health Check Scheduler"),
    MenuItem("3", "Send Test Email"),
    MenuItem("0", "Back"),
]


class SettingsScreen(Screen):
    """Application settings — email and health-check scheduler."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="settings-nav")
            yield ScrollableTextView(id="settings-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_overview()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._email_config()
        elif event.key == "2":
            self._hc_scheduler()
        elif event.key == "3":
            self._send_test_email()

    # ── Overview ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _show_overview(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)

        GRN, RED, BLD, DIM, NC = "\033[32m", "\033[31m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Settings Overview{NC}", ""]

        # Email
        email = cfg.get("email", {})
        if email.get("enabled"):
            lines.append(f"  Email:     {GRN}enabled{NC}  ({email.get('smtp_host', '?')}:{email.get('smtp_port', '?')})")
            lines.append(f"  Recipients: {', '.join(email.get('to_addrs', []))}")
        else:
            lines.append(f"  Email:     {DIM}not configured{NC}")

        lines.append("")

        # Scheduler
        sched = cfg.get("healthcheck_schedule", {})
        if sched.get("enabled"):
            from xinas_menu.utils.hc_scheduler import scheduler_status
            status = await loop.run_in_executor(None, scheduler_status)
            lines.append(f"  HC Scheduler: {GRN}enabled{NC}  (every {status.get('interval_hours', '?')}h)")
            lines.append(f"  Profile:      {sched.get('profile', 'standard')}")
            lines.append(f"  Next run:     {status.get('next_run', 'n/a')}")
            lines.append(f"  Last run:     {status.get('last_run', 'n/a')}")
        else:
            lines.append(f"  HC Scheduler: {DIM}not configured{NC}")

        view.set_content("\n".join(lines))

    # ── Email Configuration ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _email_config(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)
        email = cfg.get("email", {})

        # Show current
        GRN, BLD, DIM, NC = "\033[32m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Email Configuration{NC}", ""]
        lines.append(f"  Enabled:   {email.get('enabled', False)}")
        lines.append(f"  SMTP Host: {email.get('smtp_host', '(not set)')}")
        lines.append(f"  SMTP Port: {email.get('smtp_port', 587)}")
        lines.append(f"  TLS:       {email.get('smtp_tls', True)}")
        lines.append(f"  User:      {email.get('smtp_user', '(not set)')}")
        pw = email.get("smtp_password", "")
        lines.append(f"  Password:  {'●' * min(len(pw), 8) if pw else '(not set)'}")
        lines.append(f"  From:      {email.get('from_addr', '(not set)')}")
        lines.append(f"  To:        {', '.join(email.get('to_addrs', []))}")
        view.set_content("\n".join(lines))

        # Ask to configure
        choice = await self.app.push_screen_wait(
            SelectDialog(
                ["Configure Email", "Disable Email", "Cancel"],
                title="Email Configuration",
                prompt="Choose an action:",
            )
        )
        if choice is None or choice == "Cancel":
            return

        if choice == "Disable Email":
            cfg.setdefault("email", {})["enabled"] = False
            await loop.run_in_executor(None, cfg_write, cfg)
            self.app.notify("Email disabled")
            self._show_overview()
            return

        # Wizard: collect SMTP settings
        host = await self.app.push_screen_wait(
            InputDialog("SMTP Host:", "Email Setup", default=email.get("smtp_host", ""))
        )
        if host is None:
            return

        port_str = await self.app.push_screen_wait(
            InputDialog("SMTP Port:", "Email Setup", default=str(email.get("smtp_port", 587)))
        )
        if port_str is None:
            return
        try:
            port = int(port_str)
        except ValueError:
            self.app.notify("Invalid port number", severity="error")
            return

        tls_choice = await self.app.push_screen_wait(
            SelectDialog(["Yes", "No"], title="Email Setup", prompt="Use STARTTLS?")
        )
        if tls_choice is None:
            return
        use_tls = tls_choice == "Yes"

        user = await self.app.push_screen_wait(
            InputDialog("SMTP Username:", "Email Setup", default=email.get("smtp_user", ""))
        )
        if user is None:
            return

        password = await self.app.push_screen_wait(
            InputDialog("SMTP Password:", "Email Setup", password=True)
        )
        if password is None:
            return

        from_addr = await self.app.push_screen_wait(
            InputDialog("From Address:", "Email Setup", default=email.get("from_addr", user))
        )
        if from_addr is None:
            return

        to_str = await self.app.push_screen_wait(
            InputDialog(
                "To Addresses (comma-separated):", "Email Setup",
                default=", ".join(email.get("to_addrs", [])),
            )
        )
        if to_str is None:
            return
        to_addrs = [a.strip() for a in to_str.split(",") if a.strip()]

        if not to_addrs:
            self.app.notify("At least one recipient required", severity="error")
            return

        # Save
        cfg["email"] = {
            "enabled": True,
            "smtp_host": host,
            "smtp_port": port,
            "smtp_tls": use_tls,
            "smtp_user": user,
            "smtp_password": password,
            "from_addr": from_addr,
            "to_addrs": to_addrs,
        }
        await loop.run_in_executor(None, cfg_write, cfg)
        self.app.audit.log("settings.email", f"host={host}", "OK")
        self.app.notify("Email configuration saved")
        self._show_overview()

    # ── Health Check Scheduler ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _hc_scheduler(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)
        sched = cfg.get("healthcheck_schedule", {})

        from xinas_menu.utils.hc_scheduler import (
            scheduler_status, scheduler_enable, scheduler_disable,
        )
        status = await loop.run_in_executor(None, scheduler_status)

        GRN, RED, BLD, DIM, NC = "\033[32m", "\033[31m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Health Check Scheduler{NC}", ""]
        if status["enabled"]:
            lines.append(f"  Status:    {GRN}enabled{NC}")
            lines.append(f"  Interval:  every {status.get('interval_hours', '?')}h")
            lines.append(f"  Profile:   {sched.get('profile', 'standard')}")
            lines.append(f"  Next run:  {status.get('next_run', 'n/a')}")
            lines.append(f"  Last run:  {status.get('last_run', 'n/a')}")
        else:
            lines.append(f"  Status:    {RED}disabled{NC}")
        view.set_content("\n".join(lines))

        options = ["Enable/Update Scheduler", "Disable Scheduler", "Cancel"]
        choice = await self.app.push_screen_wait(
            SelectDialog(options, title="HC Scheduler", prompt="Choose an action:")
        )
        if choice is None or choice == "Cancel":
            return

        if choice == "Disable Scheduler":
            ok, err = await loop.run_in_executor(None, scheduler_disable)
            cfg["healthcheck_schedule"] = {"enabled": False}
            await loop.run_in_executor(None, cfg_write, cfg)
            if ok:
                self.app.audit.log("settings.hc_scheduler", "disabled", "OK")
                self.app.notify("Health check scheduler disabled")
            else:
                self.app.notify(f"Disable failed: {err}", severity="error")
            self._show_overview()
            return

        # Enable/Update flow
        interval_str = await self.app.push_screen_wait(
            InputDialog(
                "Run interval in hours (1-168):", "HC Scheduler",
                default=str(sched.get("interval_hours", 24)),
            )
        )
        if interval_str is None:
            return
        try:
            interval = int(interval_str)
            if not 1 <= interval <= 168:
                raise ValueError("out of range")
        except ValueError:
            self.app.notify("Invalid interval (must be 1-168)", severity="error")
            return

        profile = await self.app.push_screen_wait(
            SelectDialog(
                ["quick", "standard", "deep"],
                title="HC Scheduler",
                prompt="Health check profile:",
            )
        )
        if profile is None:
            return

        ok, err = await loop.run_in_executor(
            None, lambda: scheduler_enable(interval, profile)
        )
        if ok:
            cfg["healthcheck_schedule"] = {
                "enabled": True,
                "interval_hours": interval,
                "profile": profile,
            }
            await loop.run_in_executor(None, cfg_write, cfg)
            self.app.audit.log(
                "settings.hc_scheduler", f"enabled every {interval}h profile={profile}", "OK"
            )
            self.app.notify(f"Scheduler enabled: every {interval}h ({profile})")
        else:
            self.app.notify(f"Enable failed: {err}", severity="error")
        self._show_overview()

    # ── Test Email ─────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _send_test_email(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)

        if not cfg.get("email", {}).get("enabled"):
            view.set_content(
                "\033[33m  Email is not configured.\n\n"
                "  Use 'Email Configuration' first.\033[0m"
            )
            return

        view.set_content("  Sending test email...")
        from xinas_menu.utils.email_sender import send_email
        import socket

        hostname = socket.gethostname()
        ok, err = await loop.run_in_executor(
            None,
            lambda: send_email(
                f"[xiNAS] Test Email — {hostname}",
                f"This is a test email from xiNAS Management Console on {hostname}.\n\n"
                "If you received this, email delivery is working correctly.",
                cfg,
            ),
        )
        if ok:
            GRN, NC = "\033[32m", "\033[0m"
            view.set_content(f"  {GRN}Test email sent successfully!{NC}")
            self.app.audit.log("settings.test_email", "sent", "OK")
        else:
            RED, NC = "\033[31m", "\033[0m"
            view.set_content(f"  {RED}Email send failed:{NC} {err}")
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/settings.py`

**Step 3: Commit**

```bash
git add xinas_menu/screens/settings.py
git commit -m "feat: add Settings screen (email config, HC scheduler)"
```

---

## Task 8: Submenu Screens — System, Storage, Management

**Files:**
- Create: `xinas_menu/screens/system.py`
- Create: `xinas_menu/screens/storage.py`
- Create: `xinas_menu/screens/management.py`

**Step 1: Create `xinas_menu/screens/system.py`**

```python
"""SystemScreen — System submenu (Status, License, Settings, Exporter, Quick Actions)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_MENU = [
    MenuItem("1", "Status"),
    MenuItem("2", "License"),
    MenuItem("3", "Settings"),
    MenuItem("4", "xiRAID Exporter"),
    MenuItem("5", "Quick Actions"),
    MenuItem("0", "Back"),
]


class SystemScreen(Screen):
    """System submenu — routes to system-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  System", id="main-prompt")
        yield NavigableMenu(_MENU, id="system-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.system_status import SystemStatusScreen
            self.app.push_screen(SystemStatusScreen())
        elif key == "2":
            from xinas_menu.screens.license import LicenseScreen
            self.app.push_screen(LicenseScreen())
        elif key == "3":
            from xinas_menu.screens.settings import SettingsScreen
            self.app.push_screen(SettingsScreen())
        elif key == "4":
            from xinas_menu.screens.exporter import ExporterScreen
            self.app.push_screen(ExporterScreen())
        elif key == "5":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            self.app.push_screen(QuickActionsScreen())
```

**Step 2: Create `xinas_menu/screens/storage.py`**

```python
"""StorageScreen — Storage submenu (RAID, NFS, Physical Drives)."""
from __future__ import annotations

import asyncio
import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "RAID Management"),
    MenuItem("2", "NFS Access Rights"),
    MenuItem("3", "Physical Drives"),
    MenuItem("0", "Back"),
]


class StorageScreen(Screen):
    """Storage submenu — routes to storage-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Storage", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="storage-nav")
            yield ScrollableTextView(id="storage-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.raid import RAIDScreen
            self.app.push_screen(RAIDScreen())
        elif key == "2":
            from xinas_menu.screens.nfs import NFSScreen
            self.app.push_screen(NFSScreen())
        elif key == "3":
            self._show_drives()

    @work(exclusive=True)
    async def _show_drives(self) -> None:
        """Show physical drives — logic extracted from QuickActionsScreen."""
        view = self.query_one("#storage-content", ScrollableTextView)
        view.set_content("  Scanning drives...")
        ok, data, err = await self.app.grpc.disk_list()
        if not ok:
            view.set_content(f"\033[31m  Error: {grpc_short_error(err)}\033[0m")
            return

        GRN, YLW, RED, CYN, BLD, DIM, NC = (
            "\033[32m", "\033[33m", "\033[31m", "\033[36m",
            "\033[1m", "\033[2m", "\033[0m",
        )
        lines = [f"{BLD}{CYN}Physical Drives{NC}\n"]
        try:
            disks = data if isinstance(data, list) else []
            if not disks:
                lines.append(f"  {DIM}(no drives found){NC}")
            for d in disks:
                name = d.get("name", "?") if isinstance(d, dict) else str(d)
                model = (d.get("model", "") if isinstance(d, dict) else "").strip()
                size = d.get("size", "?") if isinstance(d, dict) else "?"
                raid_name = d.get("raid_name", "") if isinstance(d, dict) else ""
                member_state = d.get("member_state", "") if isinstance(d, dict) else ""
                transport = d.get("transport", "") if isinstance(d, dict) else ""
                ms = member_state.lower()
                if ms == "online":
                    sc = GRN
                elif ms in ("degraded", "rebuilding"):
                    sc = YLW
                elif ms in ("offline", "failed"):
                    sc = RED
                else:
                    sc = ""
                role = (
                    f"({raid_name}) {sc}{member_state}{NC}"
                    if raid_name
                    else f"{DIM}unassigned{NC}"
                )
                lines.append(f"  {GRN}{name}{NC}  {model}  {size}  {transport}  {role}")
        except Exception as exc:
            lines.append(f"  {RED}(parse error: {exc}){NC}")
        view.set_content("\n".join(lines))
```

**Step 3: Create `xinas_menu/screens/management.py`**

```python
"""ManagementScreen — Management submenu (Users, Health Check, MCP, Updates)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_MENU = [
    MenuItem("1", "User Management"),
    MenuItem("2", "Health Check"),
    MenuItem("3", "MCP Server"),
    MenuItem("4", "Check for Updates"),
    MenuItem("0", "Back"),
]


class ManagementScreen(Screen):
    """Management submenu — routes to management-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Management", id="main-prompt")
        yield NavigableMenu(_MENU, id="mgmt-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.users import UsersScreen
            self.app.push_screen(UsersScreen())
        elif key == "2":
            from xinas_menu.screens.health import HealthScreen
            self.app.push_screen(HealthScreen())
        elif key == "3":
            from xinas_menu.screens.mcp import MCPScreen
            self.app.push_screen(MCPScreen())
        elif key == "4":
            self._do_update_check()

    @work(exclusive=True)
    async def _do_update_check(self) -> None:
        available = await self.app._update_checker.check()
        if available:
            self.app.update_available = True
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("An update is available. Apply now?", "Update Available")
            )
            if confirmed:
                await self.app._apply_update()
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.app.push_screen_wait(
                ConfirmDialog("xiNAS is up to date.", "Updates")
            )
```

**Step 4: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/system.py && python3 -m py_compile xinas_menu/screens/storage.py && python3 -m py_compile xinas_menu/screens/management.py`

**Step 5: Commit**

```bash
git add xinas_menu/screens/system.py xinas_menu/screens/storage.py xinas_menu/screens/management.py
git commit -m "feat: add System, Storage, Management submenu screens"
```

---

## Task 9: Rewrite Main Menu — 4 groups + Exit

**Files:**
- Modify: `xinas_menu/screens/main_menu.py`

**Step 1: Rewrite `main_menu.py`**

Replace the entire file:

```python
"""MainMenuScreen — top-level navigation (4 groups + Exit)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_ITEMS = [
    MenuItem("1", "System"),
    MenuItem("2", "Storage"),
    MenuItem("3", "Network"),
    MenuItem("4", "Management"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Exit"),
]


class MainMenuScreen(Screen):
    """Root navigation screen — routes to group submenus."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=True, key_display="0/Esc"),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  xiNAS Management Console", id="main-prompt")
        yield NavigableMenu(_ITEMS, id="main-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.exit()
        elif key == "1":
            from xinas_menu.screens.system import SystemScreen
            self.app.push_screen(SystemScreen())
        elif key == "2":
            from xinas_menu.screens.storage import StorageScreen
            self.app.push_screen(StorageScreen())
        elif key == "3":
            from xinas_menu.screens.network import NetworkScreen
            self.app.push_screen(NetworkScreen())
        elif key == "4":
            from xinas_menu.screens.management import ManagementScreen
            self.app.push_screen(ManagementScreen())

    def action_exit_app(self) -> None:
        self.app.exit()
```

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/main_menu.py`

**Step 3: Commit**

```bash
git add xinas_menu/screens/main_menu.py
git commit -m "refactor: main menu now routes to 4 group submenus"
```

---

## Task 10: Clean Up Quick Actions — Remove Moved Items

**Files:**
- Modify: `xinas_menu/screens/quick_actions.py`

**Step 1: Update Quick Actions**

The "System Status" menu item (key "1") stays as `_system_status()`. The `show_status` constructor flag is no longer used since System Status has its own screen now. Remove the `_show_status` logic and the `show_status` parameter from `__init__`.

In `quick_actions.py`:
- Remove `show_status` parameter from `__init__`
- Remove `self._show_status` and the `on_mount` check
- The screen keeps all 7 items (status, restart NFS, logs, disk health, services, btop, audit) — Physical Drives in Storage uses its own inline implementation rather than importing from here

**Step 2: Verify syntax**

Run: `python3 -m py_compile xinas_menu/screens/quick_actions.py`

**Step 3: Commit**

```bash
git add xinas_menu/screens/quick_actions.py
git commit -m "refactor: remove show_status flag from QuickActionsScreen"
```

---

## Task 11: Version Bump and Final Verification

**Files:**
- Modify: `xinas_menu/version.py`

**Step 1: Bump version**

Change `XINAS_MENU_VERSION = "2.8.0"` to `XINAS_MENU_VERSION = "2.9.0"`.

**Step 2: Verify ALL new files compile**

Run:
```bash
python3 -m py_compile xinas_menu/utils/config.py && \
python3 -m py_compile xinas_menu/utils/email_sender.py && \
python3 -m py_compile xinas_menu/utils/hc_scheduler.py && \
python3 -m py_compile xinas_menu/health/runner.py && \
python3 -m py_compile xinas_menu/screens/system_status.py && \
python3 -m py_compile xinas_menu/screens/license.py && \
python3 -m py_compile xinas_menu/screens/settings.py && \
python3 -m py_compile xinas_menu/screens/system.py && \
python3 -m py_compile xinas_menu/screens/storage.py && \
python3 -m py_compile xinas_menu/screens/management.py && \
python3 -m py_compile xinas_menu/screens/main_menu.py && \
python3 -m py_compile xinas_menu/screens/quick_actions.py && \
python3 -m py_compile xinas_menu/screens/mcp.py && \
echo "ALL OK"
```
Expected: `ALL OK`

**Step 3: Commit**

```bash
git add xinas_menu/version.py
git commit -m "chore: bump version to 2.9.0"
```
