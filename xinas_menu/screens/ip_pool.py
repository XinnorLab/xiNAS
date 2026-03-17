"""IPPoolScreen — IP Pool configuration for high-speed interfaces."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import subprocess
import tempfile
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_CFG_PATH = Path("/etc/xinas/network-pool.json")
_NETPLAN_PATH = Path("/etc/netplan/99-xinas-pool.yaml")

_DEFAULTS = {
    "pool_enabled": True,
    "pool_start": "10.10.1.1",
    "pool_end": "10.10.255.1",
    "pool_prefix": 24,
}

_MENU = [
    MenuItem("1", "Configure Pool"),
    MenuItem("2", "Preview Allocation"),
    MenuItem("3", "Apply Configuration"),
    MenuItem("4", "Show Current Settings"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


# ── Config helpers ────────────────────────────────────────────────────────────

def _cfg_read() -> dict:
    """Read pool config from JSON file, returning defaults if missing."""
    try:
        data = json.loads(_CFG_PATH.read_text())
        merged = dict(_DEFAULTS)
        merged.update(data)
        return merged
    except Exception:
        return dict(_DEFAULTS)


def _cfg_write(cfg: dict) -> None:
    """Atomic write pool config to JSON file with 0600 permissions."""
    _CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(_CFG_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, str(_CFG_PATH))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Interface detection ───────────────────────────────────────────────────────

def _detect_interfaces() -> list[dict]:
    """Detect high-speed network interfaces (InfiniBand + mlx5_core).

    Returns list of dicts: {name, iface_type, driver, mtu_default, state, ip4, mac}
    """
    net_path = "/sys/class/net"
    result: list[dict] = []
    try:
        names = sorted(os.listdir(net_path))
    except Exception:
        return result

    for iface in names:
        if iface == "lo":
            continue
        iface_path = os.path.join(net_path, iface)
        if not os.path.isdir(iface_path):
            continue
        # Must have a backing device
        if not os.path.exists(os.path.join(iface_path, "device")):
            continue

        def _read(rel: str, _base: str = iface_path) -> str:
            try:
                with open(os.path.join(_base, rel)) as f:
                    return f.read().strip()
            except Exception:
                return ""

        iface_type_num = _read("type")
        try:
            driver = os.path.basename(os.readlink(os.path.join(iface_path, "device/driver")))
        except Exception:
            driver = ""

        # Filter: InfiniBand (type=32) or mlx5_core driver
        is_ib = iface_type_num == "32"
        is_mlx5 = driver == "mlx5_core"
        if not is_ib and not is_mlx5:
            continue

        state = _read("operstate") or "unknown"
        mac = _read("address") or "N/A"

        # Current IP
        ip4 = ""
        try:
            out = subprocess.check_output(
                ["ip", "-o", "-4", "addr", "show", iface],
                text=True, stderr=subprocess.DEVNULL,
            ).strip()
            if out:
                parts = out.split()
                for i, p in enumerate(parts):
                    if p == "inet" and i + 1 < len(parts):
                        ip4 = parts[i + 1]
                        break
        except Exception:
            pass

        result.append({
            "name": iface,
            "iface_type": "InfiniBand" if is_ib else "Ethernet",
            "driver": driver,
            "mtu_default": 4092 if is_ib else 9000,
            "state": state,
            "ip4": ip4,
            "mac": mac,
        })

    return result


# ── IP allocation ─────────────────────────────────────────────────────────────

def _allocate_ips(cfg: dict, interfaces: list[dict]) -> tuple[list[dict], str]:
    """Allocate IPs from pool to interfaces.

    Returns (allocations, error_string).
    Each allocation: {name, ip, prefix, mtu, iface_type}
    If error_string is non-empty, allocation failed.
    """
    start = cfg["pool_start"]
    end = cfg.get("pool_end", "")
    prefix = cfg["pool_prefix"]

    try:
        octets = list(map(int, start.split(".")))
        if len(octets) != 4:
            raise ValueError("not 4 octets")
    except Exception:
        return [], f"Invalid start IP: {start}"

    # Parse end IP for bounds checking
    end_third = 255
    if end:
        try:
            end_octets = list(map(int, end.split(".")))
            if len(end_octets) == 4:
                end_third = end_octets[2]
        except Exception:
            pass

    allocations: list[dict] = []
    for i, iface in enumerate(interfaces):
        third = octets[2] + i
        if third > 255:
            return [], (
                f"Pool overflow: interface {iface['name']} would get "
                f"{octets[0]}.{octets[1]}.{third}.{octets[3]} "
                f"(third octet {third} > 255). "
                f"Use a lower starting address or fewer interfaces."
            )
        if third > end_third:
            return [], (
                f"Pool exhausted: interface {iface['name']} would get "
                f"{octets[0]}.{octets[1]}.{third}.{octets[3]} "
                f"which exceeds pool end ({end}). "
                f"Expand the pool range or reduce the number of interfaces."
            )
        ip = f"{octets[0]}.{octets[1]}.{third}.{octets[3]}"
        allocations.append({
            "name": iface["name"],
            "ip": ip,
            "prefix": prefix,
            "mtu": iface["mtu_default"],
            "iface_type": iface["iface_type"],
        })

    return allocations, ""


# ── Netplan generation ────────────────────────────────────────────────────────

def _generate_netplan(allocations: list[dict]) -> str:
    """Generate netplan YAML string from allocations."""
    lines = [
        "# Generated by xinas-menu IP Pool configuration",
        "# Do not edit manually — changes will be overwritten on next Apply",
        "network:",
        "  version: 2",
        "  renderer: networkd",
        "  ethernets:",
    ]
    for alloc in allocations:
        lines.append(f"    {alloc['name']}:")
        lines.append("      dhcp4: no")
        lines.append(f"      addresses: [{alloc['ip']}/{alloc['prefix']}]")
        lines.append(f"      mtu: {alloc['mtu']}")
    lines.append("")
    return "\n".join(lines)


def _write_and_apply_netplan(netplan_content: str) -> tuple[bool, str]:
    """Write netplan file and run netplan apply. Returns (success, message)."""
    try:
        _NETPLAN_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(_NETPLAN_PATH.parent), suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w") as f:
                f.write(netplan_content)
            os.chmod(tmp, 0o644)
            os.replace(tmp, str(_NETPLAN_PATH))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception as exc:
        return False, f"Failed to write netplan file: {exc}"

    try:
        r = subprocess.run(
            ["netplan", "apply"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return False, f"netplan apply failed:\n{(r.stderr or r.stdout)[:500]}"
        return True, "Configuration applied successfully."
    except subprocess.TimeoutExpired:
        return False, "netplan apply timed out after 30 seconds."
    except Exception as exc:
        return False, f"Failed to run netplan apply: {exc}"


# ── Validation ────────────────────────────────────────────────────────────────

def _validate_ipv4(ip: str) -> str | None:
    """Return error message or None if valid IPv4."""
    try:
        addr = ipaddress.IPv4Address(ip)
        return None
    except Exception:
        return f"Invalid IPv4 address: {ip}"


def _validate_prefix(prefix_str: str) -> tuple[int | None, str | None]:
    """Return (prefix_int, error_message). One of them is None."""
    try:
        p = int(prefix_str)
        if not 1 <= p <= 32:
            return None, "Prefix must be between 1 and 32"
        return p, None
    except ValueError:
        return None, f"Invalid prefix: {prefix_str}"


# ── Screen ────────────────────────────────────────────────────────────────────

class IPPoolScreen(Screen):
    """IP Pool configuration — detect interfaces, allocate IPs, apply via netplan."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  IP Pool Configuration", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="pool-nav")
            yield ScrollableTextView(
                "\033[1m\033[36mIP Pool Configuration\033[0m\n"
                "\n"
                "  \033[1m1\033[0m  \033[36mConfigure Pool\033[0m      \033[2mSet IP range and subnet prefix\033[0m\n"
                "  \033[1m2\033[0m  \033[36mPreview Allocation\033[0m  \033[2mPreview IP assignments to interfaces\033[0m\n"
                "  \033[1m3\033[0m  \033[36mApply Configuration\033[0m \033[2mWrite netplan and activate pool\033[0m\n"
                "  \033[1m4\033[0m  \033[36mShow Settings\033[0m       \033[2mView current IP pool settings\033[0m\n",
                id="pool-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._show_current_settings()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._configure_pool()
        elif key == "2":
            self._preview_allocation()
        elif key == "3":
            self._apply_configuration()
        elif key == "4":
            self._show_current_settings()

    @work(exclusive=True)
    async def _configure_pool(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)

        while True:
            start = await self.app.push_screen_wait(
                InputDialog(
                    "Pool start IP address:",
                    "Configure IP Pool",
                    default=cfg["pool_start"],
                    placeholder="10.10.1.1",
                )
            )
            if start is None:
                return
            err = _validate_ipv4(start)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        while True:
            end = await self.app.push_screen_wait(
                InputDialog(
                    "Pool end IP address:",
                    "Configure IP Pool",
                    default=cfg["pool_end"],
                    placeholder="10.10.255.1",
                )
            )
            if end is None:
                return
            err = _validate_ipv4(end)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        while True:
            prefix_str = await self.app.push_screen_wait(
                InputDialog(
                    "Subnet prefix (CIDR):",
                    "Configure IP Pool",
                    default=str(cfg["pool_prefix"]),
                    placeholder="24",
                )
            )
            if prefix_str is None:
                return
            prefix, err = _validate_prefix(prefix_str)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        cfg["pool_start"] = start
        cfg["pool_end"] = end
        cfg["pool_prefix"] = prefix
        cfg["pool_enabled"] = True

        try:
            await loop.run_in_executor(None, _cfg_write, cfg)
            self.app.audit.log("network.pool_config", f"{start}-{end}/{prefix}", "OK")
            await self.app.snapshots.record(
                "network_modify",
                diff_summary=f"Configured IP pool {start}-{end}/{prefix}",
            )
            view = self.query_one("#pool-content", ScrollableTextView)
            view.set_content(
                f"Pool configuration saved.\n\n"
                f"  Start: {start}\n"
                f"  End:   {end}\n"
                f"  Prefix: /{prefix}\n\n"
                f"Use [bold]Preview[/bold] to see allocation, then [bold]Apply[/bold] to activate."
            )
        except Exception as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to save config: {exc}", "Error", ok_only=True)
            )

    @work(exclusive=True)
    async def _preview_allocation(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        cfg = await loop.run_in_executor(None, _cfg_read)
        interfaces = await loop.run_in_executor(None, _detect_interfaces)

        if not interfaces:
            view.set_content(
                "No high-speed interfaces detected.\n\n"
                "Looking for: InfiniBand (type=32) or mlx5_core driver.\n"
                "Ensure DOCA-OFED is installed and interfaces are present."
            )
            return

        allocations, err = _allocate_ips(cfg, interfaces)
        if err:
            view.set_content(f"[bold red]Allocation Error[/bold red]\n\n{err}")
            return

        GRN, CYN, BLD, DIM, NC = "\033[32m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        W = 68
        lines = [
            f"{BLD}{CYN}IP POOL ALLOCATION PREVIEW{NC}",
            f"{DIM}{'=' * W}{NC}",
            "",
            f"  {DIM}Pool:{NC}   {cfg['pool_start']} — {cfg['pool_end']}",
            f"  {DIM}Prefix:{NC} /{cfg['pool_prefix']}",
            f"  {DIM}Interfaces detected:{NC} {len(interfaces)}",
            "",
            f"{DIM}{'-' * W}{NC}",
            "",
        ]

        for alloc, iface in zip(allocations, interfaces):
            state_color = GRN if iface["state"] == "up" else "\033[33m"
            lines.append(
                f"  {BLD}{alloc['name']}{NC}  "
                f"{DIM}({alloc['iface_type']}){NC}"
            )
            lines.append(
                f"      {DIM}Assign:{NC}  {GRN}{alloc['ip']}/{alloc['prefix']}{NC}"
            )
            lines.append(
                f"      {DIM}MTU:{NC}     {alloc['mtu']}"
            )
            if iface["ip4"]:
                lines.append(
                    f"      {DIM}Current:{NC} {iface['ip4']}"
                )
            lines.append(
                f"      {DIM}State:{NC}   {state_color}{iface['state']}{NC}  "
                f"{DIM}MAC:{NC} {iface['mac']}"
            )
            lines.append("")

        lines.append(f"{DIM}{'-' * W}{NC}")
        lines.append("")

        netplan = _generate_netplan(allocations)
        lines.append(f"  {BLD}{CYN}GENERATED NETPLAN{NC}")
        lines.append(f"{DIM}{'-' * W}{NC}")
        lines.append("")
        for nl in netplan.splitlines():
            lines.append(f"  {nl}")
        lines.append("")
        lines.append(f"{DIM}{'=' * W}{NC}")
        lines.append(f"  Use {BLD}[3] Apply Configuration{NC} to write and activate.")

        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _apply_configuration(self) -> None:
        loop = asyncio.get_running_loop()

        cfg = await loop.run_in_executor(None, _cfg_read)
        interfaces = await loop.run_in_executor(None, _detect_interfaces)

        if not interfaces:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No high-speed interfaces detected.\nCannot apply pool configuration.",
                    "Error",
                    ok_only=True,
                )
            )
            return

        allocations, err = _allocate_ips(cfg, interfaces)
        if err:
            await self.app.push_screen_wait(ConfirmDialog(f"Allocation error:\n{err}", "Error", ok_only=True))
            return

        summary = "\n".join(
            f"  {a['name']}: {a['ip']}/{a['prefix']} (MTU {a['mtu']})"
            for a in allocations
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Apply IP Pool configuration?\n\n{summary}\n\n"
                f"This writes {_NETPLAN_PATH} and runs 'netplan apply'.\n"
                f"Active connections may be briefly interrupted.",
                "Apply Network Configuration",
            )
        )
        if not confirmed:
            return

        netplan = _generate_netplan(allocations)
        ok, msg = await loop.run_in_executor(
            None, _write_and_apply_netplan, netplan,
        )
        if ok:
            self.app.audit.log(
                "network.pool_apply",
                f"{len(allocations)} interfaces configured",
                "OK",
            )
            await self.app.snapshots.record(
                "network_modify",
                diff_summary=f"Applied IP pool: {len(allocations)} interfaces configured",
            )
            await self.app.push_screen_wait(ConfirmDialog(msg, "Success", ok_only=True))
        else:
            self.app.audit.log("network.pool_apply", msg[:200], "FAIL")
            await self.app.push_screen_wait(ConfirmDialog(msg, "Error", ok_only=True))

    @work(exclusive=True)
    async def _show_current_settings(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)

        GRN, CYN, BLD, DIM, NC = "\033[32m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        W = 68
        lines = [
            f"{BLD}{CYN}IP POOL SETTINGS{NC}",
            f"{DIM}{'=' * W}{NC}",
            "",
            f"  {DIM}Enabled:{NC} {'Yes' if cfg.get('pool_enabled') else 'No'}",
            f"  {DIM}Start:{NC}   {cfg['pool_start']}",
            f"  {DIM}End:{NC}     {cfg['pool_end']}",
            f"  {DIM}Prefix:{NC}  /{cfg['pool_prefix']}",
            "",
            f"  {DIM}Config file:{NC} {_CFG_PATH}",
            "",
        ]

        # Show current netplan if exists
        if _NETPLAN_PATH.exists():
            try:
                content = _NETPLAN_PATH.read_text()
                lines.append(f"{DIM}{'-' * W}{NC}")
                lines.append(f"  {BLD}{CYN}APPLIED NETPLAN{NC}  ({_NETPLAN_PATH})")
                lines.append(f"{DIM}{'-' * W}{NC}")
                lines.append("")
                for nl in content.splitlines():
                    lines.append(f"  {nl}")
                lines.append("")
            except Exception:
                pass
        else:
            lines.append(f"  {DIM}No pool netplan file applied yet.{NC}")
            lines.append("")

        lines.append(f"{DIM}{'=' * W}{NC}")
        view.set_content("\n".join(lines))
