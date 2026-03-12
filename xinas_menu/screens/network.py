"""NetworkScreen — show and edit network interfaces."""
from __future__ import annotations

import asyncio
import os
import socket
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "View Current Configuration"),
    MenuItem("2", "Edit Interface IP Address"),
    MenuItem("3", "Apply Network Changes"),
    MenuItem("4", "View Netplan Config File"),
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
        elif key == "4":
            asyncio.create_task(self._view_netplan_file())

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
        ok, err = await loop.run_in_executor(None, lambda: _update_netplan(iface, ip, gw))
        if ok:
            self.app.audit.log("network.edit_ip", f"{iface}={ip}", "OK")
            await self._show_network_info()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _apply_netplan(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Apply network configuration?\n\nThis runs 'netplan apply'.\nActive connections may be briefly interrupted.",
                "Apply Network Changes",
            )
        )
        if not confirmed:
            return

        loop = asyncio.get_event_loop()
        ok, out, err = await loop.run_in_executor(None, lambda: _run("netplan", "apply"))
        if ok:
            self.app.audit.log("network.netplan_apply", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Network configuration applied.", "Done"))
            await self._show_network_info()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"netplan apply failed:\n{(err or out)[:300]}", "Error")
            )

    async def _view_netplan_file(self) -> None:
        view = self.query_one("#net-content", ScrollableTextView)
        loop = asyncio.get_event_loop()
        path, text = await loop.run_in_executor(None, _read_netplan_file)
        if text:
            view.set_content(f"Netplan: {path}\n{'=' * 60}\n\n{text}")
        else:
            view.set_content("No netplan configuration file found in /etc/netplan/")


# ── Formatter ─────────────────────────────────────────────────────────────────

def _run_cmd(cmd: str) -> str:
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL,
                                       text=True).strip()
    except Exception:
        return ""


def _speed_bar(speed: int) -> str:
    if speed <= 0:
        return "[----]"
    if speed >= 100000:
        return "[****]"
    if speed >= 25000:
        return "[*** ]"
    if speed >= 10000:
        return "[**  ]"
    if speed >= 1000:
        return "[*   ]"
    return "[.   ]"


def _format_speed(speed: int) -> str:
    if speed <= 0:
        return "---"
    if speed >= 1000:
        return f"{speed // 1000}Gb/s"
    return f"{speed}Mb/s"


def _collect_network_info() -> str:
    W = 72
    lines: list[str] = []

    hostname = socket.gethostname()
    try:
        fqdn = socket.getfqdn()
    except Exception:
        fqdn = hostname

    lines.append("NETWORK CONFIGURATION")
    lines.append("=" * W)
    lines.append("")
    lines.append(f"  Hostname:  {hostname}")
    if fqdn != hostname:
        lines.append(f"  FQDN:      {fqdn}")
    lines.append("")

    gw_info = _run_cmd("ip route | grep default")
    if gw_info:
        parts = gw_info.split()
        gw_ip = parts[2] if len(parts) > 2 else "N/A"
        gw_dev = parts[4] if len(parts) > 4 else ""
        lines.append(f"  Gateway:   {gw_ip}" + (f" via {gw_dev}" if gw_dev else ""))

    dns_servers: list[str] = []
    try:
        for line in open("/etc/resolv.conf"):
            if line.strip().startswith("nameserver"):
                dns_servers.append(line.split()[1])
    except Exception:
        pass
    if dns_servers:
        lines.append(f"  DNS:       {', '.join(dns_servers[:3])}")

    lines.append("")
    lines.append("-" * W)
    lines.append("  NETWORK INTERFACES")
    lines.append("-" * W)
    lines.append("")

    interfaces: list[dict] = []
    net_path = "/sys/class/net"
    try:
        names = sorted(os.listdir(net_path))
    except Exception:
        names = []

    for iface in names:
        if iface == "lo":
            continue
        iface_path = os.path.join(net_path, iface)
        if not os.path.isdir(iface_path):
            continue

        def _read(rel: str) -> str:
            try:
                with open(os.path.join(iface_path, rel)) as f:
                    return f.read().strip()
            except Exception:
                return ""

        state = _read("operstate") or "unknown"
        try:
            speed = int(_read("speed") or "0")
        except Exception:
            speed = 0
        mac = _read("address") or "N/A"
        try:
            driver = os.path.basename(os.readlink(os.path.join(iface_path, "device/driver")))
        except Exception:
            driver = ""

        ip4 = ""
        out4 = _run_cmd(f"ip -o -4 addr show {iface}")
        if out4:
            parts = out4.split()
            for i, p in enumerate(parts):
                if p == "inet" and i + 1 < len(parts):
                    ip4 = parts[i + 1]
                    break

        ip6 = ""
        out6 = _run_cmd(f"ip -o -6 addr show {iface} scope global")
        if out6:
            parts = out6.split()
            for i, p in enumerate(parts):
                if p == "inet6" and i + 1 < len(parts):
                    ip6 = parts[i + 1]
                    break

        interfaces.append({
            "name": iface, "state": state, "speed": speed,
            "mac": mac, "driver": driver, "ip4": ip4, "ip6": ip6,
        })

    up_count = sum(1 for i in interfaces if i["state"] == "up")
    lines.append(f"  Found {len(interfaces)} interface(s), {up_count} active")
    lines.append("")

    for iface in interfaces:
        state = iface["state"]
        icon = "[UP]" if state == "up" else ("[DN]" if state == "down" else "[??]")
        speed = iface["speed"]
        speed_str = _format_speed(speed)
        bar = _speed_bar(speed)

        lines.append(f"  {icon} {iface['name']}")
        lines.append(f"      State:   {state:<10} Speed: {bar} {speed_str}")
        lines.append(f"      IPv4:    {iface['ip4'] or '(not configured)'}")
        if iface["ip6"]:
            lines.append(f"      IPv6:    {iface['ip6']}")
        lines.append(f"      MAC:     {iface['mac']}")
        if iface["driver"]:
            lines.append(f"      Driver:  {iface['driver']}")
        lines.append("")

    lines.append("-" * W)
    lines.append("  ROUTING TABLE")
    lines.append("-" * W)
    lines.append("")
    routes = _run_cmd("ip route show")
    if routes:
        for line in routes.splitlines()[:10]:
            lines.append(f"  {line}")
    else:
        lines.append("  No routes configured")
    lines.append("")
    lines.append("=" * W)
    return "\n".join(lines)


def _read_netplan_file() -> tuple[str, str]:
    search = ["/etc/netplan/99-xinas.yaml"]
    try:
        search += sorted(Path("/etc/netplan").glob("*.yaml"))
        search += sorted(Path("/etc/netplan").glob("*.yml"))
    except Exception:
        pass
    for p in search:
        p = Path(p)
        if p.exists():
            try:
                return str(p), p.read_text()
            except Exception:
                pass
    return "", ""


def _update_netplan(iface: str, ip_cidr: str, gateway: str) -> tuple[bool, str]:
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
            iface_cfg["routes"] = [{"to": "default", "via": gateway}]
        with cfg_path.open("w") as f:
            yaml.dump(cfg, f, default_flow_style=False)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _run(*args: str) -> tuple[bool, str, str]:
    r = subprocess.run(list(args), capture_output=True, text=True)
    return r.returncode == 0, r.stdout, r.stderr
