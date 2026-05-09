"""InstallNfsScreen -- install and configure NFS client tools."""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Check Status"),
    MenuItem("2", "Install NFS Tools"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

# ── High-throughput NFS client configuration ──────────────────────────

_MODPROBE_CONF = "/etc/modprobe.d/nfsclient.conf"
_MODPROBE_CONTENT = """\
options sunrpc tcp_slot_table_entries=128
options sunrpc tcp_max_slot_table_entries=128
"""

_SYSCTL_CONF = "/etc/sysctl.d/90-nfs-client.conf"
_SYSCTL_CONTENT = """\
sunrpc.tcp_slot_table_entries = 128
sunrpc.tcp_max_slot_table_entries = 128
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
"""


class InstallNfsScreen(Screen):
    """Install NFS tools and configure for high-throughput operation."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Install NFS Tools", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="nfs-nav")
            yield ScrollableTextView("  Loading\u2026", id="nfs-content")
        yield Footer()

    def on_mount(self) -> None:
        self._check_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._check_status()
        elif key == "2":
            self._install_nfs()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── Check Status ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _check_status(self) -> None:
        view = self.query_one("#nfs-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_status)
        except Exception:
            _log.debug("NFS status check failed", exc_info=True)
            text = f"  {_RED}Error checking NFS status{_NC}"
        view.set_content(text)

    # ── Install NFS Tools ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _install_nfs(self) -> None:
        # Check if already installed
        if shutil.which("mount.nfs4"):
            already = await self.app.push_screen_wait(
                ConfirmDialog(
                    "NFS client tools are already installed.\n\n"
                    "Re-apply high-throughput configuration?",
                    "NFS Tools Installed",
                )
            )
            if not already:
                return
            # Skip apt install, just reconfigure
            await self._apply_config()
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "This will install nfs-common and configure the system\n"
                "for high-throughput NFS operation.\n\n"
                "The following will be configured:\n"
                "  - sunrpc.tcp_slot_table_entries = 128\n"
                "  - sunrpc.tcp_max_slot_table_entries = 128\n"
                "  - net.core.rmem_max = 268435456 (256 MB)\n"
                "  - net.core.wmem_max = 268435456 (256 MB)\n\n"
                "Proceed?",
                "Install NFS Tools",
            )
        )
        if not confirmed:
            return

        view = self.query_one("#nfs-content", ScrollableTextView)
        view.set_content(f"  {_YLW}Installing nfs-common\u2026{_NC}\n")

        loop = asyncio.get_running_loop()

        # Install nfs-common via apt
        rc, out, err = await loop.run_in_executor(None, _run_apt_install)

        if rc != 0:
            msg = err.strip() or out.strip() or f"apt exited with code {rc}"
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Failed to install nfs-common:\n\n{msg}",
                    "Installation Failed",
                    ok_only=True,
                )
            )
            self._check_status()
            return

        view.append(f"  {_GRN}nfs-common installed successfully.{_NC}\n")

        # Apply configuration
        await self._apply_config()

    async def _apply_config(self) -> None:
        """Write modprobe and sysctl configuration files, then apply."""
        view = self.query_one("#nfs-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        view.append(f"  {_YLW}Applying high-throughput configuration\u2026{_NC}\n")

        try:
            ok, msg = await loop.run_in_executor(None, _write_configs)
        except Exception as exc:
            ok, msg = False, str(exc)

        if ok:
            view.append(f"  {_GRN}Configuration applied successfully.{_NC}\n")
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "NFS tools installed and configured.\n\n"
                    "A reboot is recommended for modprobe changes\n"
                    "to take full effect.",
                    "Installation Complete",
                    ok_only=True,
                )
            )
        else:
            view.append(f"  {_RED}Configuration failed: {msg}{_NC}\n")
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Configuration failed:\n\n{msg}",
                    "Configuration Error",
                    ok_only=True,
                )
            )

        # Refresh status view
        self._check_status()


# ── Helpers (run in executor threads) ─────────────────────────────────


def _run_apt_install() -> tuple[int, str, str]:
    """Run ``apt-get install -y nfs-common``."""
    try:
        r = subprocess.run(
            ["apt-get", "install", "-y", "nfs-common"],
            capture_output=True, text=True, timeout=300,
            env={"DEBIAN_FRONTEND": "noninteractive", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "apt-get timed out after 300 seconds"
    except Exception as exc:
        return 1, "", str(exc)


def _write_configs() -> tuple[bool, str]:
    """Write modprobe and sysctl configs, then apply sysctl.

    Returns ``(success, message)``.
    """
    errors: list[str] = []

    # Write modprobe config
    try:
        Path(_MODPROBE_CONF).write_text(_MODPROBE_CONTENT)
    except OSError as exc:
        errors.append(f"Failed to write {_MODPROBE_CONF}: {exc}")

    # Write sysctl config
    try:
        Path(_SYSCTL_CONF).write_text(_SYSCTL_CONTENT)
    except OSError as exc:
        errors.append(f"Failed to write {_SYSCTL_CONF}: {exc}")

    # Apply sysctl settings immediately
    try:
        r = subprocess.run(
            ["sysctl", "--system"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            errors.append(f"sysctl --system failed: {r.stderr.strip()}")
    except Exception as exc:
        errors.append(f"sysctl --system error: {exc}")

    if errors:
        return False, "\n".join(errors)
    return True, "OK"


def _build_status() -> str:
    """Build the NFS tools status text."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}NFS CLIENT TOOLS STATUS{_NC}")
    lines.append(rule)
    lines.append("")

    # ── Package status ────────────────────────────────────────────────
    lines.append(f"  {_BLD}Package{_NC}")

    nfs4_path = shutil.which("mount.nfs4")
    if nfs4_path:
        lines.append(f"  {_GRN}\u25cf{_NC} nfs-common {_GRN}installed{_NC}")
        lines.append(f"    {_DIM}mount.nfs4: {nfs4_path}{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} nfs-common {_RED}NOT installed{_NC}")
        lines.append(f"    {_DIM}Select [2] to install.{_NC}")

    lines.append("")

    # ── Module configuration ──────────────────────────────────────────
    lines.append(f"  {_BLD}Module Configuration{_NC}")

    modprobe_path = Path(_MODPROBE_CONF)
    if modprobe_path.is_file():
        lines.append(f"  {_GRN}\u25cf{_NC} {_MODPROBE_CONF} {_GRN}present{_NC}")
        try:
            content = modprobe_path.read_text().strip()
            for line in content.splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    lines.append(f"    {_DIM}{line}{_NC}")
        except OSError:
            pass
    else:
        lines.append(f"  {_YLW}\u25cf{_NC} {_MODPROBE_CONF} {_YLW}not configured{_NC}")

    lines.append("")

    # ── Sysctl settings ───────────────────────────────────────────────
    lines.append(f"  {_BLD}Sysctl Settings{_NC}")

    sysctl_path = Path(_SYSCTL_CONF)
    if sysctl_path.is_file():
        lines.append(f"  {_GRN}\u25cf{_NC} {_SYSCTL_CONF} {_GRN}present{_NC}")
        try:
            content = sysctl_path.read_text().strip()
            for line in content.splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    lines.append(f"    {_DIM}{line}{_NC}")
        except OSError:
            pass
    else:
        lines.append(f"  {_YLW}\u25cf{_NC} {_SYSCTL_CONF} {_YLW}not configured{_NC}")

    lines.append("")

    # ── Live sysctl values ────────────────────────────────────────────
    lines.append(f"  {_BLD}Active Sysctl Values{_NC}")

    sysctl_keys = [
        "sunrpc.tcp_slot_table_entries",
        "sunrpc.tcp_max_slot_table_entries",
        "net.core.rmem_max",
        "net.core.wmem_max",
    ]
    expected = {
        "sunrpc.tcp_slot_table_entries": "128",
        "sunrpc.tcp_max_slot_table_entries": "128",
        "net.core.rmem_max": "268435456",
        "net.core.wmem_max": "268435456",
    }

    for key in sysctl_keys:
        try:
            r = subprocess.run(
                ["sysctl", "-n", key],
                capture_output=True, text=True, timeout=3,
            )
            val = r.stdout.strip() if r.returncode == 0 else "N/A"
        except Exception:
            val = "N/A"

        exp = expected.get(key, "")
        if val == exp:
            lines.append(f"  {_GRN}\u25cf{_NC} {_DIM}{key}{_NC} = {_GRN}{val}{_NC}")
        elif val == "N/A":
            lines.append(f"  {_DIM}\u25cf{_NC} {_DIM}{key}{_NC} = {_DIM}N/A{_NC}")
        else:
            lines.append(
                f"  {_YLW}\u25cf{_NC} {_DIM}{key}{_NC} = {_YLW}{val}{_NC}"
                f" {_DIM}(expected {exp}){_NC}"
            )

    lines.append("")
    return "\n".join(lines)
