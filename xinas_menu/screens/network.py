"""NetworkScreen — show and edit network interfaces."""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import shlex
import subprocess
from pathlib import Path

_log = logging.getLogger(__name__)

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_RED = "\033[31m"
_GRN = "\033[32m"
_YLW = "\033[33m"
_CYN = "\033[36m"
_BLD = "\033[1m"
_DIM = "\033[2m"
_NC = "\033[0m"

_MENU = [
    MenuItem("1", "View Current Configuration"),
    MenuItem("2", "Edit Interface IP Address"),
    MenuItem("3", "Apply Network Changes"),
    MenuItem("4", "View Netplan Config File"),
    MenuItem("", "", separator=True),
    MenuItem("5", "IP Pool Configuration"),
    MenuItem("0", "Back"),
]


class NetworkScreen(Screen):
    """Network settings — view and basic editing."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Network Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="net-nav")
            yield ScrollableTextView(
                "\033[1m\033[36mNetwork Settings\033[0m\n"
                "\n"
                "  \033[1m1\033[0m  \033[36mShow Interfaces\033[0m     \033[2mView network interfaces and IP addresses\033[0m\n"
                "  \033[1m2\033[0m  \033[36mEdit Interface IP\033[0m   \033[2mChange interface IP address (CIDR)\033[0m\n"
                "  \033[1m3\033[0m  \033[36mApply Netplan\033[0m       \033[2mApply netplan changes\033[0m\n"
                "  \033[1m4\033[0m  \033[36mShow Netplan\033[0m        \033[2mDisplay current netplan configuration\033[0m\n"
                "  \033[1m5\033[0m  \033[36mIP Pool\033[0m             \033[2mConfigure IP pool for high-speed interfaces\033[0m\n",
                id="net-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._show_network_info()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_network_info()
        elif key == "2":
            self._edit_interface_ip()
        elif key == "3":
            self._apply_netplan()
        elif key == "4":
            self._view_netplan_file()
        elif key == "5":
            from xinas_menu.screens.ip_pool import IPPoolScreen
            self.app.push_screen(IPPoolScreen())

    @work(exclusive=True)
    async def _show_network_info(self) -> None:
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, _collect_network_info)
        view = self.query_one("#net-content", ScrollableTextView)
        view.set_content(text)

    @work(exclusive=True)
    async def _edit_interface_ip(self) -> None:
        # Enumerate available interfaces (exclude loopback) with current IPs
        try:
            iface_names = sorted(
                p.name for p in Path("/sys/class/net").iterdir()
                if p.name != "lo"
            )
        except Exception:
            iface_names = []

        if not iface_names:
            view = self.query_one("#net-content", ScrollableTextView)
            view.set_content(f"{_RED}No network interfaces found.{_NC}")
            return

        loop = asyncio.get_running_loop()
        labels = await loop.run_in_executor(None, lambda: _iface_labels(iface_names))

        choice = await self.app.push_screen_wait(
            SelectDialog(labels, title="Edit Interface IP", prompt="Select interface:")
        )
        if choice is None:
            return
        iface = choice.split()[0]

        # Fetch current IP, gateway, and MTU for pre-filling
        cur_ip, cur_gw, cur_mtu = await loop.run_in_executor(None, lambda: _iface_current(iface))

        while True:
            ip = await self.app.push_screen_wait(
                InputDialog(f"IP address/prefix for {iface} (CIDR):",
                            "Edit Interface IP",
                            default=cur_ip,
                            placeholder="192.168.1.10/24")
            )
            if ip is None:
                return
            if not ip.strip():
                self.app.notify("IP address must not be empty.", severity="error")
                continue
            if "/" not in ip:
                self.app.notify("IP address must be in CIDR format (e.g. 192.168.1.10/24).", severity="error")
                continue
            ip = ip.strip()
            break

        gw = await self.app.push_screen_wait(
            InputDialog("Default gateway (leave blank to keep):",
                        "Edit Interface IP",
                        default=cur_gw,
                        placeholder="192.168.1.1")
        )
        if gw is None:
            return

        # MTU dialog — default depends on interface type (IB vs Ethernet)
        default_mtu = cur_mtu or ("4092" if iface.startswith("ib") else "9000")
        while True:
            mtu_str = await self.app.push_screen_wait(
                InputDialog(f"MTU for {iface}:",
                            "Edit Interface IP",
                            default=default_mtu,
                            placeholder="9000")
            )
            if mtu_str is None:
                return
            mtu_str = mtu_str.strip()
            if not mtu_str.isdigit():
                self.app.notify("MTU must be a number.", severity="error")
                continue
            mtu_val = int(mtu_str)
            if mtu_val < 576 or mtu_val > 9216:
                self.app.notify("MTU must be between 576 and 9216.", severity="error")
                continue
            break

        summary = f"Set {iface} to {ip}"
        if gw:
            summary += f" via {gw}"
        summary += f", MTU {mtu_str}"

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(summary + "?", "Confirm")
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(None, lambda: _update_netplan(iface, ip, gw, mtu_val))
        if ok:
            self.app.audit.log("network.edit_ip", f"{iface}={ip} mtu={mtu_val}", "OK")
            await self.app.snapshots.record(
                "network_modify",
                diff_summary=summary,
            )
            self._show_network_info()
        else:
            view = self.query_one("#net-content", ScrollableTextView)
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _apply_netplan(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Apply network configuration?\n\nThis runs 'netplan apply'.\nActive connections may be briefly interrupted.",
                "Apply Network Changes",
            )
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        ok, out, err = await loop.run_in_executor(None, lambda: _run("netplan", "apply"))
        if ok:
            self.app.audit.log("network.netplan_apply", "", "OK")
            await self.app.snapshots.record(
                "network_modify", diff_summary="Applied netplan configuration",
            )
            view = self.query_one("#net-content", ScrollableTextView)
            view.set_content(f"{_GRN}Network configuration applied.{_NC}")
            self._show_network_info()
        else:
            view = self.query_one("#net-content", ScrollableTextView)
            view.set_content(
                f"{_RED}netplan apply failed:{_NC}\n\n{(err or out)[:300]}"
            )

    @work(exclusive=True)
    async def _view_netplan_file(self) -> None:
        view = self.query_one("#net-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        path, text = await loop.run_in_executor(None, _read_netplan_file)
        if text:
            view.set_content(f"Netplan: {path}\n{'=' * 60}\n\n{text}")
        else:
            view.set_content("No netplan configuration file found in /etc/netplan/")


# ── Formatter ─────────────────────────────────────────────────────────────────

def _run_cmd(cmd: str) -> str:
    try:
        return subprocess.check_output(
            shlex.split(cmd), stderr=subprocess.DEVNULL, text=True,
        ).strip()
    except Exception:
        _log.debug("command failed: %s", cmd, exc_info=True)
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
    GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    W = 72
    lines: list[str] = []

    hostname = socket.gethostname()
    try:
        fqdn = socket.getfqdn()
    except Exception:
        _log.debug("getfqdn failed", exc_info=True)
        fqdn = hostname

    lines.append(f"{BLD}{CYN}NETWORK CONFIGURATION{NC}")
    lines.append(f"{DIM}{'=' * W}{NC}")
    lines.append("")
    lines.append(f"  {DIM}Hostname:{NC}  {GRN}{hostname}{NC}")
    if fqdn != hostname:
        lines.append(f"  {DIM}FQDN:{NC}      {fqdn}")
    lines.append("")

    gw_info = _run_cmd("ip route | grep default")
    if gw_info:
        parts = gw_info.split()
        gw_ip = parts[2] if len(parts) > 2 else "N/A"
        gw_dev = parts[4] if len(parts) > 4 else ""
        lines.append(f"  {DIM}Gateway:{NC}   {gw_ip}" + (f" via {gw_dev}" if gw_dev else ""))

    dns_servers: list[str] = []
    try:
        for line in open("/etc/resolv.conf"):
            if line.strip().startswith("nameserver"):
                dns_servers.append(line.split()[1])
    except Exception:
        _log.debug("failed to read /etc/resolv.conf", exc_info=True)
    if dns_servers:
        lines.append(f"  {DIM}DNS:{NC}       {', '.join(dns_servers[:3])}")

    lines.append("")
    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append(f"  {BLD}{CYN}NETWORK INTERFACES{NC}")
    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append("")

    interfaces: list[dict] = []
    net_path = "/sys/class/net"
    try:
        names = sorted(os.listdir(net_path))
    except Exception:
        _log.debug("failed to list /sys/class/net", exc_info=True)
        names = []

    for iface in names:
        if iface == "lo":
            continue
        iface_path = os.path.join(net_path, iface)
        if not os.path.isdir(iface_path):
            continue

        def _read(rel: str, _base: str = iface_path) -> str:
            try:
                with open(os.path.join(_base, rel)) as f:
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

        mtu = _read("mtu") or "N/A"

        interfaces.append({
            "name": iface, "state": state, "speed": speed,
            "mac": mac, "driver": driver, "ip4": ip4, "ip6": ip6,
            "mtu": mtu,
        })

    up_count = sum(1 for i in interfaces if i["state"] == "up")
    lines.append(f"  Found {len(interfaces)} interface(s), {GRN}{up_count} active{NC}")
    lines.append("")

    for iface in interfaces:
        state = iface["state"]
        if state == "up":
            icon = f"{GRN}[UP]{NC}"
            sc = GRN
        elif state == "down":
            icon = f"{RED}[DN]{NC}"
            sc = RED
        else:
            icon = f"{YLW}[??]{NC}"
            sc = YLW
        speed = iface["speed"]
        speed_str = _format_speed(speed)
        bar = _speed_bar(speed)

        lines.append(f"  {icon} {BLD}{iface['name']}{NC}")
        lines.append(f"      {DIM}State:{NC}   {sc}{state:<10}{NC} {DIM}Speed:{NC} {bar} {speed_str}")
        lines.append(f"      {DIM}IPv4:{NC}    {iface['ip4'] or f'{DIM}(not configured){NC}'}")
        if iface["ip6"]:
            lines.append(f"      {DIM}IPv6:{NC}    {iface['ip6']}")
        lines.append(f"      {DIM}MAC:{NC}     {iface['mac']}    {DIM}MTU:{NC} {iface['mtu']}")
        if iface["driver"]:
            lines.append(f"      {DIM}Driver:{NC}  {iface['driver']}")
        lines.append("")

    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append(f"  {BLD}{CYN}ROUTING TABLE{NC}")
    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append("")
    routes = _run_cmd("ip route show")
    if routes:
        for line in routes.splitlines()[:10]:
            lines.append(f"  {line}")
    else:
        lines.append(f"  {DIM}No routes configured{NC}")
    lines.append("")
    lines.append(f"{DIM}{'=' * W}{NC}")
    return "\n".join(lines)


def _read_netplan_file() -> tuple[str, str]:
    search = ["/etc/netplan/99-xinas.yaml"]
    try:
        search += sorted(Path("/etc/netplan").glob("*.yaml"))
        search += sorted(Path("/etc/netplan").glob("*.yml"))
    except Exception:
        _log.debug("failed to glob /etc/netplan", exc_info=True)
    for p in search:
        p = Path(p)
        if p.exists():
            try:
                return str(p), p.read_text()
            except Exception:
                _log.debug("failed to read netplan file %s", p, exc_info=True)
    return "", ""


def _update_netplan(iface: str, ip_cidr: str, gateway: str, mtu: int | None = None) -> tuple[bool, str]:
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
        if mtu is not None:
            iface_cfg["mtu"] = mtu
        with cfg_path.open("w") as f:
            yaml.dump(cfg, f, default_flow_style=False)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _iface_labels(names: list[str]) -> list[str]:
    """Return display labels like 'eth0  192.168.1.10/24' for each interface."""
    max_len = max((len(n) for n in names), default=0)
    labels: list[str] = []
    for name in names:
        ip = ""
        out = _run_cmd(f"ip -o -4 addr show {name}")
        if out:
            parts = out.split()
            for i, p in enumerate(parts):
                if p == "inet" and i + 1 < len(parts):
                    ip = parts[i + 1]
                    break
        padded = name.ljust(max_len)
        labels.append(f"{padded}  {ip}" if ip else padded)
    return labels


def _iface_current(name: str) -> tuple[str, str, str]:
    """Return (current_ip_cidr, current_gateway, current_mtu) for an interface."""
    ip = ""
    out = _run_cmd(f"ip -o -4 addr show {name}")
    if out:
        parts = out.split()
        for i, p in enumerate(parts):
            if p == "inet" and i + 1 < len(parts):
                ip = parts[i + 1]
                break
    gw = ""
    routes = _run_cmd(f"ip -4 route show dev {name}")
    if routes:
        for line in routes.splitlines():
            if line.startswith("default via "):
                gw = line.split()[2]
                break
    mtu = ""
    try:
        mtu_path = Path(f"/sys/class/net/{name}/mtu")
        if mtu_path.exists():
            mtu = mtu_path.read_text().strip()
    except Exception:
        pass
    return ip, gw, mtu


def _run(*args: str) -> tuple[bool, str, str]:
    r = subprocess.run(list(args), capture_output=True, text=True)
    return r.returncode == 0, r.stdout, r.stderr
