"""InstallDocaScreen -- DOCA OFED installation and status screen."""
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
    MenuItem("2", "Install DOCA OFED"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


class InstallDocaScreen(Screen):
    """DOCA OFED installation and status screen with split-panel layout."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Install DOCA OFED", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="doca-nav")
            yield ScrollableTextView("  Loading\u2026", id="doca-content")
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
            self._install_doca()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── Check Status ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _check_status(self) -> None:
        view = self.query_one("#doca-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_status)
        except Exception:
            _log.debug("DOCA status check failed", exc_info=True)
            text = f"  {_RED}Error checking DOCA OFED status{_NC}"
        view.set_content(text)

    # ── Install DOCA OFED ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _install_doca(self) -> None:
        loop = asyncio.get_running_loop()

        # Check for ansible-playbook
        has_ansible = shutil.which("ansible-playbook") is not None
        if not has_ansible:
            # Try to install ansible
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    "ansible-playbook is not installed.\n\n"
                    "Install Ansible to proceed with DOCA OFED installation?",
                    "Ansible Required",
                )
            )
            if not confirmed:
                return

            view = self.query_one("#doca-content", ScrollableTextView)
            view.set_content(f"  {_YLW}Installing Ansible\u2026{_NC}\n")

            rc, out, err = await loop.run_in_executor(None, _install_ansible)
            if rc != 0:
                msg = err.strip() or out.strip() or f"apt exited with code {rc}"
                await self.app.push_screen_wait(
                    ConfirmDialog(
                        f"Failed to install Ansible:\n\n{msg}",
                        "Installation Failed",
                        ok_only=True,
                    )
                )
                return

            # Re-check
            if not shutil.which("ansible-playbook"):
                await self.app.push_screen_wait(
                    ConfirmDialog(
                        "ansible-playbook still not found after installation.",
                        "Installation Failed",
                        ok_only=True,
                    )
                )
                return

        # Find the repo root for playbook execution
        repo_root = _find_repo_root()

        playbook = Path(repo_root) / "playbooks" / "doca_ofed_install.yml"
        inventory = Path(repo_root) / "inventories" / "lab.ini"

        if not playbook.is_file():
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Playbook not found:\n{playbook}\n\n"
                    f"Ensure the xiNAS client repository is at\n{repo_root}",
                    "Playbook Missing",
                    ok_only=True,
                )
            )
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Install NVIDIA DOCA OFED drivers?\n\n"
                "This will run the Ansible playbook:\n"
                f"  {playbook.name}\n\n"
                "The installation may take several minutes\n"
                "and requires internet access.\n\n"
                "A reboot is required after installation.",
                "Install DOCA OFED",
            )
        )
        if not confirmed:
            return

        # Build command
        cmd = [
            "ansible-playbook",
            str(playbook),
            "-i", str(inventory),
        ]

        from xinas_client.screens.playbook_screen import PlaybookRunScreen

        exit_code = await self.app.push_screen_wait(
            PlaybookRunScreen(cmd, title="Installing DOCA OFED", workdir=repo_root)
        )

        if exit_code == 0:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "DOCA OFED installed successfully.\n\n"
                    "A reboot is required for the drivers to take effect.",
                    "Installation Complete",
                    ok_only=True,
                )
            )
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"DOCA OFED installation failed (exit code {exit_code}).\n\n"
                    "Check the playbook output above for details.",
                    "Installation Failed",
                    ok_only=True,
                )
            )

        # Refresh status
        self._check_status()


# ── Helpers (run in executor threads) ─────────────────────────────────


def _find_repo_root() -> str:
    """Locate the xiNAS client repository root."""
    # Check well-known installation path first
    if Path("/opt/xinas-client").exists():
        return "/opt/xinas-client"

    # Fall back to relative path from this file
    here = Path(__file__).resolve().parent.parent.parent
    if (here / "playbooks").is_dir():
        return str(here)

    return "/opt/xinas-client"


def _install_ansible() -> tuple[int, str, str]:
    """Install Ansible via apt."""
    try:
        r = subprocess.run(
            ["apt-get", "install", "-y", "ansible"],
            capture_output=True, text=True, timeout=300,
            env={"DEBIAN_FRONTEND": "noninteractive", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "apt-get timed out after 300 seconds"
    except Exception as exc:
        return 1, "", str(exc)


def _build_status() -> str:
    """Build the DOCA OFED status text."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}DOCA OFED STATUS{_NC}")
    lines.append(rule)
    lines.append("")

    # ── OFED installation ─────────────────────────────────────────────
    lines.append(f"  {_BLD}Installation{_NC}")

    ofed_info = shutil.which("ofed_info")
    if ofed_info:
        lines.append(f"  {_GRN}\u25cf{_NC} DOCA OFED {_GRN}installed{_NC}")
        # Get version
        try:
            r = subprocess.run(
                [ofed_info, "-s"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                lines.append(f"    {_DIM}Version: {r.stdout.strip()}{_NC}")
        except Exception:
            pass
    else:
        lines.append(f"  {_RED}\u25cf{_NC} DOCA OFED {_RED}not installed{_NC}")
        lines.append(f"    {_DIM}Select [2] to install.{_NC}")

    lines.append("")

    # ── InfiniBand devices ────────────────────────────────────────────
    lines.append(f"  {_BLD}InfiniBand Devices{_NC}")

    ib_dir = Path("/sys/class/infiniband")
    if ib_dir.is_dir():
        try:
            devices = sorted([d.name for d in ib_dir.iterdir() if d.is_dir()])
        except OSError:
            devices = []

        if devices:
            lines.append(f"  {_GRN}\u25cf{_NC} RDMA {_GRN}available{_NC}")
            for dev in devices:
                ports_dir = ib_dir / dev / "ports"
                if not ports_dir.is_dir():
                    lines.append(f"    {_DIM}{dev}{_NC}")
                    continue
                try:
                    for port_path in sorted(ports_dir.iterdir()):
                        if not port_path.is_dir():
                            continue
                        state_file = port_path / "state"
                        try:
                            raw = state_file.read_text().strip()
                            state = raw.split(":")[-1].strip() if ":" in raw else raw
                        except OSError:
                            state = "UNKNOWN"

                        port_num = port_path.name
                        if state == "ACTIVE":
                            lines.append(
                                f"    {_GRN}\u25b2{_NC} {_BLD}{dev}{_NC} port {port_num}: "
                                f"{_GRN}{state}{_NC}"
                            )
                        else:
                            lines.append(
                                f"    {_RED}\u25bc{_NC} {_BLD}{dev}{_NC} port {port_num}: "
                                f"{_RED}{state}{_NC}"
                            )
                except OSError:
                    lines.append(f"    {_DIM}{dev} (error reading ports){_NC}")
        else:
            lines.append(f"  {_YLW}\u25cf{_NC} RDMA module loaded, {_YLW}no devices found{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} {_RED}No InfiniBand sysfs directory{_NC}")
        lines.append(f"    {_DIM}/sys/class/infiniband does not exist{_NC}")

    lines.append("")

    # ── ibstat output ─────────────────────────────────────────────────
    lines.append(f"  {_BLD}ibstat Summary{_NC}")

    ibstat_bin = shutil.which("ibstat")
    if ibstat_bin:
        try:
            r = subprocess.run(
                [ibstat_bin, "-l"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                for dev_line in r.stdout.strip().splitlines():
                    dev_line = dev_line.strip()
                    if dev_line:
                        lines.append(f"    {_DIM}\u2022{_NC} {dev_line}")
            else:
                lines.append(f"  {_DIM}ibstat returned no devices{_NC}")
        except Exception:
            lines.append(f"  {_DIM}ibstat command failed{_NC}")
    else:
        lines.append(f"  {_DIM}ibstat not available (DOCA OFED not installed){_NC}")

    lines.append("")
    return "\n".join(lines)
