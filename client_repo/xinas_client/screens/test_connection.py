"""TestConnectionScreen -- verify NFS connectivity to a storage server."""
from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
from datetime import datetime

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.input_dialog import InputDialog
from xinas_client.utils.nfs_utils import run_showmount

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Run Connection Test"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}Connection Test{_NC}
  {_CYN}{'─' * 60}{_NC}

  {_DIM}Press [1] to test connectivity to a NAS server.{_NC}

  {_DIM}The following checks will be performed:{_NC}
    {_DIM}\u2022 ICMP ping (reachability){_NC}
    {_DIM}\u2022 NFS port 2049 (TCP){_NC}
    {_DIM}\u2022 NFS-RDMA port 20049 (TCP){_NC}
    {_DIM}\u2022 RPC services (rpcinfo){_NC}
    {_DIM}\u2022 Export listing (showmount){_NC}
"""


class TestConnectionScreen(Screen):
    """Verify NFS/RDMA connectivity to a storage server."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Test Connection", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="test-conn-nav")
            yield ScrollableTextView(_HELP_TEXT, id="test-conn-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._ask_and_run()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    @work(exclusive=True)
    async def _ask_and_run(self) -> None:
        ip = await self.app.push_screen_wait(
            InputDialog(
                "Enter the NAS server IP address or hostname:",
                title="Server Address",
                placeholder="e.g. 192.168.1.100",
            )
        )
        if not ip or not ip.strip():
            return
        ip = ip.strip()
        await self._run_tests(ip)

    async def _run_tests(self, ip: str) -> None:
        view = self.query_one("#test-conn-content", ScrollableTextView)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        lines: list[str] = []
        rule = f"  {_CYN}{'─' * 60}{_NC}"
        lines.append(f"\n{rule}")
        lines.append(f"  {_BLD}CONNECTION TEST: {ip}{_NC}")
        lines.append(rule)
        lines.append(f"  {_DIM}Started: {timestamp}{_NC}")
        lines.append("")

        view.set_content("\n".join(lines))

        loop = asyncio.get_running_loop()

        # ── Test 1: Ping ──────────────────────────────────────────────
        view.append(f"  {_BLD}[1/5] Ping test{_NC}")
        try:
            rc, out, err = await loop.run_in_executor(
                None, _run_ping, ip
            )
            if rc == 0:
                # Extract RTT summary line
                rtt_line = ""
                for line in out.splitlines():
                    if "rtt" in line or "round-trip" in line:
                        rtt_line = line.strip()
                        break
                view.append(f"    {_GRN}[OK]{_NC}   Host is reachable")
                if rtt_line:
                    view.append(f"    {_DIM}{rtt_line}{_NC}")
            else:
                view.append(f"    {_RED}[FAIL]{_NC} Host is unreachable")
                if err.strip():
                    for eline in err.strip().splitlines()[:3]:
                        view.append(f"    {_DIM}{eline}{_NC}")
        except Exception as exc:
            view.append(f"    {_RED}[FAIL]{_NC} Ping error: {exc}")
        view.append("")

        # ── Test 2: NFS port 2049 ────────────────────────────────────
        view.append(f"  {_BLD}[2/5] NFS port (2049/tcp){_NC}")
        try:
            ok = await loop.run_in_executor(None, _check_tcp_port, ip, 2049)
            if ok:
                view.append(f"    {_GRN}[OK]{_NC}   Port 2049 is open")
            else:
                view.append(f"    {_RED}[FAIL]{_NC} Port 2049 is closed or filtered")
        except Exception as exc:
            view.append(f"    {_RED}[FAIL]{_NC} Port check error: {exc}")
        view.append("")

        # ── Test 3: NFS-RDMA port 20049 ──────────────────────────────
        view.append(f"  {_BLD}[3/5] NFS-RDMA port (20049/tcp){_NC}")
        try:
            ok = await loop.run_in_executor(None, _check_tcp_port, ip, 20049)
            if ok:
                view.append(f"    {_GRN}[OK]{_NC}   Port 20049 is open (RDMA available)")
            else:
                view.append(
                    f"    {_YLW}[SKIP]{_NC} Port 20049 is closed "
                    f"{_DIM}(RDMA not available or not configured){_NC}"
                )
        except Exception as exc:
            view.append(f"    {_RED}[FAIL]{_NC} Port check error: {exc}")
        view.append("")

        # ── Test 4: RPC services ─────────────────────────────────────
        view.append(f"  {_BLD}[4/5] RPC services (rpcinfo){_NC}")
        try:
            rc, out, err = await loop.run_in_executor(
                None, _run_rpcinfo, ip
            )
            if rc == 0 and out.strip():
                nfs_found = False
                mountd_found = False
                for rline in out.splitlines():
                    if "nfs" in rline.lower():
                        nfs_found = True
                    if "mountd" in rline.lower():
                        mountd_found = True
                if nfs_found:
                    view.append(f"    {_GRN}[OK]{_NC}   NFS service registered")
                else:
                    view.append(f"    {_YLW}[WARN]{_NC} NFS service not found in RPC list")
                if mountd_found:
                    view.append(f"    {_GRN}[OK]{_NC}   mountd service registered")
                else:
                    view.append(f"    {_YLW}[WARN]{_NC} mountd service not found in RPC list")
                # Show a summary count
                svc_count = len([
                    l for l in out.strip().splitlines()
                    if l.strip() and not l.strip().startswith("program")
                ])
                view.append(f"    {_DIM}{svc_count} RPC service(s) listed{_NC}")
            else:
                errmsg = err.strip() or "rpcinfo returned no output"
                view.append(f"    {_RED}[FAIL]{_NC} {errmsg}")
        except Exception as exc:
            view.append(f"    {_RED}[FAIL]{_NC} rpcinfo error: {exc}")
        view.append("")

        # ── Test 5: Exports ──────────────────────────────────────────
        view.append(f"  {_BLD}[5/5] Export listing (showmount){_NC}")
        try:
            rc, out, err = await loop.run_in_executor(
                None, run_showmount, ip
            )
            if rc == 0 and out.strip():
                exports = [
                    l.strip() for l in out.strip().splitlines()
                    if l.strip() and not l.strip().lower().startswith("export")
                ]
                if exports:
                    view.append(
                        f"    {_GRN}[OK]{_NC}   {len(exports)} export(s) available:"
                    )
                    for exp in exports:
                        view.append(f"    {_DIM}  \u2022 {exp}{_NC}")
                else:
                    view.append(f"    {_YLW}[WARN]{_NC} Server responded but no exports listed")
            else:
                errmsg = err.strip() or "showmount returned no output"
                view.append(f"    {_RED}[FAIL]{_NC} {errmsg}")
        except Exception as exc:
            view.append(f"    {_RED}[FAIL]{_NC} showmount error: {exc}")

        # ── Summary ──────────────────────────────────────────────────
        view.append("")
        view.append(f"  {rule}")
        elapsed = datetime.now().strftime("%H:%M:%S")
        view.append(f"  {_DIM}Completed at {elapsed}{_NC}")
        view.append("")


# ── Helpers (run in executor threads) ─────────────────────────────────


def _run_ping(ip: str) -> tuple[int, str, str]:
    """Run ping -c 3 -W 2. Returns (rc, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["ping", "-c", "3", "-W", "2", ip],
            capture_output=True, text=True, timeout=15,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "ping timed out"
    except FileNotFoundError:
        return 1, "", "ping command not found"
    except Exception as exc:
        return 1, "", str(exc)


def _check_tcp_port(ip: str, port: int, timeout: float = 3.0) -> bool:
    """Test if a TCP port is open using a socket connect."""
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _run_rpcinfo(ip: str) -> tuple[int, str, str]:
    """Run rpcinfo -p <ip>. Returns (rc, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["rpcinfo", "-p", ip],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "rpcinfo timed out"
    except FileNotFoundError:
        return 1, "", "rpcinfo command not found (install rpcbind)"
    except Exception as exc:
        return 1, "", str(exc)


