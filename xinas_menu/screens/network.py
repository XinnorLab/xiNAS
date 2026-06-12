"""NetworkScreen — show and edit network interfaces.

Mutations go through the control-path API (S8, ADR-0010): per-interface
address/MTU edits are ``PATCH /api/v1/network/interfaces/{id}`` plan/apply
operations. The API executor owns the netplan render, the surgical
flush, and ``netplan apply`` (ADR-0008) — this screen no longer runs
``netplan`` or touches ``/etc/netplan`` / ip rules directly.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import socket
import subprocess
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.api.control_client import ControlPathError, PlanBlocked
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
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
    MenuItem("3", "View Netplan Config File"),
    MenuItem("", "", separator=True),
    MenuItem("4", "IP Pool Configuration"),
    MenuItem("0", "Back"),
]


class NetworkScreen(XiNASAppMixin, Screen):
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
                "  \033[1m2\033[0m  \033[36mEdit Interface IP\033[0m   \033[2mChange IP/MTU via the control-path API\033[0m\n"
                "  \033[1m3\033[0m  \033[36mShow Netplan\033[0m        \033[2mDisplay current netplan configuration\033[0m\n"
                "  \033[1m4\033[0m  \033[36mIP Pool\033[0m             \033[2mConfigure IP pool for high-speed interfaces\033[0m\n"
                "\n"
                "  \033[2mChanges are planned and applied through xinas-api; the\033[0m\n"
                "  \033[2mexecutor rewrites netplan and applies it server-side.\033[0m\n",
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
            self._view_netplan_file()
        elif key == "4":
            from xinas_menu.screens.ip_pool import IPPoolScreen

            self.app.push_screen(IPPoolScreen())

    def _task_progress(self, label: str):
        """Build an ``on_progress`` callback for ``plan_apply_wait``.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before raising the toast.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    async def _api_interfaces(self) -> list[dict]:
        """GET /network/interfaces → merged desired+observed rows."""
        rows = await asyncio.to_thread(self.app.control.result, "/api/v1/network/interfaces")
        if not isinstance(rows, list):
            return []
        return [r for r in rows if isinstance(r, dict) and r.get("id")]

    @work(exclusive=True)
    async def _show_network_info(self) -> None:
        view = self.query_one("#net-content", ScrollableTextView)
        try:
            rows = await self._api_interfaces()
        except ControlPathError as exc:
            # Read-only degraded view when the api is unreachable (e.g.
            # before the control path is provisioned).
            text = await asyncio.to_thread(_collect_network_info, None)
            view.set_content(
                f"{_YLW}Control API unavailable ({exc}) — local read-only view.{_NC}\n\n{text}"
            )
            return
        text = await asyncio.to_thread(_collect_network_info, rows)
        view.set_content(text)

    @work(exclusive=True)
    async def _edit_interface_ip(self) -> None:
        view = self.query_one("#net-content", ScrollableTextView)
        try:
            rows = await self._api_interfaces()
        except ControlPathError as exc:
            view.set_content(f"{_RED}Control API: {exc}{_NC}")
            return

        managed = [r for r in rows if _is_managed(r)]
        if not managed:
            view.set_content(
                f"{_RED}No xiNAS-managed interfaces found.{_NC}\n\n"
                f"{_DIM}Only RDMA-capable (mlx-driver) interfaces are managed via the\n"
                f"control-path API; the management Ethernet stays cloud-init-owned.{_NC}"
            )
            return

        labels = _iface_labels(managed)
        choice = await self.app.push_screen_wait(
            SelectDialog(labels, title="Edit Interface IP", prompt="Select interface:")
        )
        if choice is None:
            return
        iface = choice.split()[0]
        row = next((r for r in managed if r.get("id") == iface), {})

        # Pre-fill from the API row (desired spec first, then netplan stanza,
        # then the live address).
        cur_ip, cur_mtu = _iface_current(row)

        while True:
            ip = await self.app.push_screen_wait(
                InputDialog(
                    f"IP address/prefix for {iface} (CIDR):",
                    "Edit Interface IP",
                    default=cur_ip,
                    placeholder="192.168.1.10/24",
                )
            )
            if ip is None:
                return
            if not ip.strip():
                self.app.notify("IP address must not be empty.", severity="error")
                continue
            if "/" not in ip:
                self.app.notify(
                    "IP address must be in CIDR format (e.g. 192.168.1.10/24).", severity="error"
                )
                continue
            ip = ip.strip()
            break

        # MTU dialog — default depends on interface type (IB vs Ethernet)
        default_mtu = cur_mtu or ("4092" if iface.startswith("ib") else "9000")
        while True:
            mtu_str = await self.app.push_screen_wait(
                InputDialog(
                    f"MTU for {iface}:",
                    "Edit Interface IP",
                    default=default_mtu,
                    placeholder="9000",
                )
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

        summary = f"Set {iface} to {ip}, MTU {mtu_val}"
        confirmed = await self.app.push_screen_wait(ConfirmDialog(summary + "?", "Confirm"))
        if not confirmed:
            return

        spec: dict[str, Any] = {"addresses": [ip], "mtu": mtu_val}
        if not await self._patch_interface(iface, spec):
            return

        self.app.audit.log("network.edit_ip", f"{iface}={ip} mtu={mtu_val}", "OK")
        await self.app.snapshots.record(
            "network_modify",
            diff_summary=summary,
        )
        self._show_network_info()

    async def _patch_interface(self, iface: str, spec: dict[str, Any]) -> bool:
        """plan/apply a PATCH; offer the cleanup re-plan on duplicate blockers.

        Returns ``True`` on success, ``False`` when blocked/failed/cancelled
        (the error dialog has already been shown).
        """
        path = f"/api/v1/network/interfaces/{iface}"
        label = f"Edit {iface}"
        try:
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "PATCH",
                    path,
                    spec,
                    on_progress=self._task_progress(label),
                )
            except PlanBlocked as exc:
                dup_msgs = _cleanup_repairable(exc.blockers)
                if not dup_msgs:
                    raise
                cleanup = await self.app.push_screen_wait(
                    ConfirmDialog(
                        "Plan blocked by duplicate netplan definitions:\n\n"
                        + "\n".join(f"  {m}" for m in dup_msgs)
                        + "\n\nRemove the duplicate stanza(s) and retry?\n"
                        "(audited netplan repair via the API)",
                        "Duplicate Netplan Definition",
                    )
                )
                if not cleanup:
                    return False
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "PATCH",
                    path,
                    {**spec, "cleanup": True},
                    on_progress=self._task_progress(label),
                )
        except ControlPathError as exc:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {exc}", "Error"))
            return False
        return True

    @work(exclusive=True)
    async def _view_netplan_file(self) -> None:
        view = self.query_one("#net-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        path, text = await loop.run_in_executor(None, _read_netplan_file)
        if text:
            view.set_content(f"Netplan: {path}\n{'=' * 60}\n\n{text}")
        else:
            view.set_content("No netplan configuration file found in /etc/netplan/")


# ── API row helpers ───────────────────────────────────────────────────────────


def _is_managed(row: dict) -> bool:
    """True for rows the API will accept a PATCH for (mlx/RDMA-capable)."""
    status = row.get("status") or {}
    if status.get("rdma_capable") is True:
        return True
    return "mlx" in str(status.get("driver", ""))


def _cleanup_repairable(blockers: list[dict[str, Any]]) -> list[str]:
    """Blocker messages when EVERY blocker is a duplicate-netplan one.

    Only then does a ``cleanup: true`` re-plan have a chance to succeed;
    any other blocker mix is surfaced as a plain failure.
    """
    if blockers and all(str(b.get("code")) == "duplicate_netplan_definition" for b in blockers):
        return [str(b.get("message", b.get("code", "?"))) for b in blockers]
    return []


def _row_addresses(row: dict) -> list[str]:
    """Preferred address list: desired spec → netplan stanza → live."""
    spec = row.get("spec") or {}
    status = row.get("status") or {}
    netplan = status.get("netplan") or {}
    for source in (spec.get("addresses"), netplan.get("addresses")):
        if isinstance(source, list) and source:
            return [str(a) for a in source]
    live = status.get("current_addresses") or status.get("ip4_addresses") or []
    return [str(a) for a in live if isinstance(a, str) and ":" not in a]


def _row_mtu(row: dict) -> str:
    spec = row.get("spec") or {}
    status = row.get("status") or {}
    netplan = status.get("netplan") or {}
    for source in (spec.get("mtu"), netplan.get("mtu"), status.get("mtu")):
        if isinstance(source, int):
            return str(source)
    return ""


def _iface_labels(rows: list[dict]) -> list[str]:
    """Display labels like 'ibp65s0  10.10.1.1/24' from API rows."""
    names = [str(r.get("id", "")) for r in rows]
    max_len = max((len(n) for n in names), default=0)
    labels: list[str] = []
    for row in rows:
        name = str(row.get("id", ""))
        addrs = _row_addresses(row)
        padded = name.ljust(max_len)
        labels.append(f"{padded}  {addrs[0]}" if addrs else padded)
    return labels


def _iface_current(row: dict) -> tuple[str, str]:
    """(current_ip_cidr, current_mtu) pre-fill values from an API row."""
    addrs = _row_addresses(row)
    return (addrs[0] if addrs else "", _row_mtu(row))


# ── Formatter ─────────────────────────────────────────────────────────────────


def _run_cmd(cmd: str) -> str:
    try:
        return subprocess.check_output(
            shlex.split(cmd),
            stderr=subprocess.DEVNULL,
            text=True,
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


def _sysfs_speed(name: str) -> int:
    try:
        return int(Path(f"/sys/class/net/{name}/speed").read_text().strip())
    except Exception:
        return 0


def _local_iface_rows() -> list[dict]:
    """Interface rows from /sys/class/net + ip(8) (api-unreachable fallback)."""
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

        interfaces.append(
            {
                "name": iface,
                "state": state,
                "speed": speed,
                "mac": mac,
                "driver": driver,
                "ip4": ip4,
                "ip6": ip6,
                "mtu": mtu,
                "managed": "mlx" in driver,
                "duplicates": [],
            }
        )
    return interfaces


def _api_iface_rows(api_rows: list[dict]) -> list[dict]:
    """Adapt GET /network/interfaces rows to the rendered columns.

    Link speed is not part of the API row; it is supplemented from sysfs
    (read-only).
    """
    interfaces: list[dict] = []
    for row in sorted(api_rows, key=lambda r: str(r.get("id", ""))):
        name = str(row.get("id", ""))
        status = row.get("status") or {}
        state = str(status.get("link_state") or status.get("operstate") or "unknown").lower()
        ip4 = ""
        for addr in status.get("ip4_addresses") or status.get("current_addresses") or []:
            if isinstance(addr, str) and ":" not in addr:
                ip4 = addr
                break
        ip6 = ""
        for addr in status.get("ip6_addresses") or []:
            if isinstance(addr, str):
                ip6 = addr
                break
        mtu = status.get("mtu")
        duplicates = status.get("duplicates_detected_in") or []
        interfaces.append(
            {
                "name": name,
                "state": state,
                "speed": _sysfs_speed(name),
                "mac": str(status.get("mac", "")) or "N/A",
                "driver": str(status.get("driver", "")),
                "ip4": ip4,
                "ip6": ip6,
                "mtu": str(mtu) if isinstance(mtu, int) else "N/A",
                "managed": _is_managed(row),
                "duplicates": [str(f) for f in duplicates if isinstance(f, str)],
            }
        )
    return interfaces


def _collect_network_info(api_rows: list[dict] | None = None) -> str:
    GRN, YLW, RED, CYN, BLD, DIM, NC = (
        "\033[32m",
        "\033[33m",
        "\033[31m",
        "\033[36m",
        "\033[1m",
        "\033[2m",
        "\033[0m",
    )
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
        with open("/etc/resolv.conf") as f:
            for line in f:
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

    interfaces = _api_iface_rows(api_rows) if api_rows is not None else _local_iface_rows()

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
        lines.append(
            f"      {DIM}State:{NC}   {sc}{state:<10}{NC} {DIM}Speed:{NC} {bar} {speed_str}"
        )
        lines.append(f"      {DIM}IPv4:{NC}    {iface['ip4'] or f'{DIM}(not configured){NC}'}")
        if iface["ip6"]:
            lines.append(f"      {DIM}IPv6:{NC}    {iface['ip6']}")
        lines.append(f"      {DIM}MAC:{NC}     {iface['mac']}    {DIM}MTU:{NC} {iface['mtu']}")
        if iface["driver"]:
            managed = f"  {DIM}(xiNAS-managed){NC}" if iface.get("managed") else ""
            lines.append(f"      {DIM}Driver:{NC}  {iface['driver']}{managed}")
        if iface.get("duplicates"):
            lines.append(
                f"      {RED}Duplicate netplan definition in: {', '.join(iface['duplicates'])}{NC}"
            )
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

    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append(f"  {BLD}{CYN}POLICY ROUTING{NC}")
    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append("")

    rules = _run_cmd("ip rule show")
    custom_tables: list[int] = []
    if rules:
        for line in rules.splitlines():
            if "lookup" in line:
                parts = line.split()
                try:
                    idx = parts.index("lookup")
                    table = int(parts[idx + 1])
                    if 100 <= table < 200:
                        lines.append(f"  {line.strip()}")
                        if table not in custom_tables:
                            custom_tables.append(table)
                except (ValueError, IndexError):
                    pass

    if custom_tables:
        lines.append("")
        for table in sorted(custom_tables):
            table_routes = _run_cmd(f"ip route show table {table}")
            if table_routes:
                lines.append(f"  {DIM}Table {table}:{NC}")
                for rt_line in table_routes.splitlines()[:5]:
                    lines.append(f"    {rt_line}")
                lines.append("")
    else:
        lines.append(f"  {DIM}No policy routing rules configured{NC}")
        lines.append(
            f"  {DIM}(PBR is auto-configured when multiple high-speed interfaces exist){NC}"
        )
        lines.append("")

    lines.append(f"{DIM}{'=' * W}{NC}")
    return "\n".join(lines)


def _read_netplan_file() -> tuple[str, str]:
    cfg = Path("/etc/netplan/99-xinas.yaml")
    if cfg.exists():
        try:
            return str(cfg), cfg.read_text()
        except Exception:
            _log.debug("failed to read %s", cfg, exc_info=True)
    return str(
        cfg
    ), "No xiNAS netplan configuration found.\nUse [2] Edit Interface IP Address to create one."
