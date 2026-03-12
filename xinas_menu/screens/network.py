"""NetworkScreen — show and edit network interfaces."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label
from textual.widgets import Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Show Network Info"),
    MenuItem("2", "Edit Interface IP"),
    MenuItem("3", "Apply Netplan"),
    MenuItem("0", "Back"),
]


class NetworkScreen(Screen):
    """Network settings — view and basic editing."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── Network Settings ──", id="screen-title")
        yield NavigableMenu(_MENU, id="net-nav")
        yield ScrollableTextView(id="net-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._show_network_info())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_network_info())
        elif key == "2":
            asyncio.create_task(self._edit_interface_ip())
        elif key == "3":
            asyncio.create_task(self._apply_netplan())

    async def _show_network_info(self) -> None:
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(None, _collect_network_info)
        view = self.query_one("#net-content", ScrollableTextView)
        view.set_content(text)

    async def _edit_interface_ip(self) -> None:
        iface = await self.app.push_screen_wait(
            InputDialog("Interface name:", "Edit Interface IP", placeholder="eth0")
        )
        if not iface:
            return

        ip = await self.app.push_screen_wait(
            InputDialog(f"New IP address/prefix for {iface} (CIDR):",
                        "Edit Interface IP", placeholder="192.168.1.10/24")
        )
        if not ip:
            return

        gw = await self.app.push_screen_wait(
            InputDialog("Default gateway (leave blank to keep):",
                        "Edit Interface IP", placeholder="192.168.1.1")
        )
        if gw is None:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Set {iface} to {ip}" + (f" via {gw}" if gw else "") + "?",
                "Confirm",
            )
        )
        if not confirmed:
            return

        loop = asyncio.get_event_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _update_netplan(iface, ip, gw)
        )
        if ok:
            self.app.audit.log("network.edit_ip", f"{iface}={ip}", "OK")
            await self._show_network_info()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _apply_netplan(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Apply netplan configuration now?", "Apply Netplan")
        )
        if not confirmed:
            return

        loop = asyncio.get_event_loop()
        ok, out, err = await loop.run_in_executor(
            None,
            lambda: _run("netplan", "apply")
        )
        if ok:
            self.app.audit.log("network.netplan_apply", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Netplan applied.", "Done"))
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"netplan apply failed:\n{err[:200]}", "Error")
            )


def _collect_network_info() -> str:
    lines = ["[bold]Network Interfaces[/bold]\n"]
    r = subprocess.run(["ip", "addr", "show"], capture_output=True, text=True)
    if r.returncode == 0:
        lines.append(r.stdout)
    else:
        lines.append("[red]ip addr failed[/red]")

    lines.append("\n[bold]RDMA Interfaces[/bold]\n")
    r2 = subprocess.run(["rdma", "link"], capture_output=True, text=True)
    if r2.returncode == 0:
        lines.append(r2.stdout or "  (none)")
    else:
        lines.append("  (rdma not available)")

    return "\n".join(lines)


def _update_netplan(iface: str, ip_cidr: str, gateway: str) -> tuple[bool, str]:
    """Find and update the netplan config for a given interface."""
    import yaml
    netplan_dir = Path("/etc/netplan")
    cfg_files = sorted(netplan_dir.glob("*.yaml")) + sorted(netplan_dir.glob("*.yml"))
    if not cfg_files:
        return False, "no netplan config files found"
    cfg_path = cfg_files[0]
    try:
        with cfg_path.open() as f:
            cfg = yaml.safe_load(f) or {}
        ethernets = cfg.setdefault("network", {}).setdefault("ethernets", {})
        iface_cfg = ethernets.setdefault(iface, {})
        iface_cfg["addresses"] = [ip_cidr]
        if gateway:
            iface_cfg.setdefault("routes", [])
            iface_cfg["routes"] = [{"to": "default", "via": gateway}]
        with cfg_path.open("w") as f:
            yaml.dump(cfg, f, default_flow_style=False)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _run(*args: str) -> tuple[bool, str, str]:
    r = subprocess.run(list(args), capture_output=True, text=True)
    return r.returncode == 0, r.stdout, r.stderr
