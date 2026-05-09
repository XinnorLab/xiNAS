"""SystemStatusScreen -- comprehensive client status dashboard."""
from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
import socket
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

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Refresh"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


class SystemStatusScreen(Screen):
    """Full-page system status display for the NFS client."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  System Status", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="status-nav")
            yield ScrollableTextView("  Loading\u2026", id="status-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._refresh_status()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    @work(exclusive=True)
    async def _refresh_status(self) -> None:
        view = self.query_one("#status-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_full_status)
        except Exception:
            _log.debug("status build failed", exc_info=True)
            text = f"  {_RED}Error building status{_NC}"
        view.set_content(text)


# ── Helpers ───────────────────────────────────────────────────────────

def _progress_bar(pct: int, width: int = 25) -> str:
    filled = round(pct / 100 * width)
    color = _GRN if pct < 70 else (_YLW if pct < 90 else _RED)
    return f"{color}{'█' * filled}{'░' * (width - filled)}{_NC}"


def _section(title: str) -> str:
    rule = f"  {_CYN}{'─' * 60}{_NC}"
    return f"\n{rule}\n  {_BLD}{title}{_NC}\n{rule}"


def _human_bytes(kb: int) -> str:
    """Convert kB to human-readable string."""
    if kb >= 1_048_576:
        return f"{kb / 1_048_576:.1f} GB"
    if kb >= 1024:
        return f"{kb / 1024:.1f} MB"
    return f"{kb} kB"


def _human_uptime(seconds: float) -> str:
    total = int(seconds)
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


# ── Status builder ────────────────────────────────────────────────────

def _build_full_status() -> str:  # noqa: C901 — intentionally large
    """Build the comprehensive status string.  Runs in a worker thread."""
    lines: list[str] = []

    timestamp = ""
    try:
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass

    # ── SYSTEM ────────────────────────────────────────────────────────
    lines.append(_section("SYSTEM"))

    try:
        lines.append(f"  {_DIM}Hostname:{_NC}  {_GRN}{socket.gethostname()}{_NC}")
    except Exception:
        lines.append(f"  {_DIM}Hostname:{_NC}  unknown")

    try:
        lines.append(f"  {_DIM}Kernel:{_NC}    {platform.release()}")
    except Exception:
        pass

    # Uptime
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        lines.append(f"  {_DIM}Uptime:{_NC}    {_YLW}{_human_uptime(secs)}{_NC}")
    except Exception:
        pass

    lines.append("")

    # CPU usage from /proc/stat (snapshot-based idle %)
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
        # user nice system idle iowait irq softirq steal
        vals = [int(v) for v in parts[1:9]]
        idle = vals[3] + vals[4]  # idle + iowait
        total = sum(vals)
        cpu_pct = max(0, min(100, 100 - int(idle * 100 / total))) if total else 0
        ncpu = os.cpu_count() or "?"
        bar = _progress_bar(cpu_pct)
        lines.append(f"  {_DIM}CPU:{_NC}  [{bar}] {cpu_pct}%  {_DIM}({ncpu} cores){_NC}")
    except Exception:
        pass

    # Memory
    try:
        meminfo: dict[str, int] = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                try:
                    meminfo[k.strip()] = int(v.strip().split()[0])
                except (ValueError, IndexError):
                    pass
        total_kb = meminfo.get("MemTotal", 0)
        avail_kb = meminfo.get("MemAvailable", 0)
        used_kb = total_kb - avail_kb
        pct = (used_kb * 100 // total_kb) if total_kb else 0
        bar = _progress_bar(pct)
        lines.append(
            f"  {_DIM}MEM:{_NC}  [{bar}] {pct}%  "
            f"{_DIM}({_human_bytes(used_kb)} / {_human_bytes(total_kb)}){_NC}"
        )
    except Exception:
        pass

    # ── NFS TOOLS ─────────────────────────────────────────────────────
    lines.append(_section("NFS TOOLS"))

    nfs4_path = shutil.which("mount.nfs4")
    if nfs4_path:
        lines.append(f"  {_GRN}\u25cf{_NC} NFS client tools {_GRN}installed{_NC}")
        # Detect active NFS version from /proc/mounts
        nfs_ver = ""
        try:
            with open("/proc/mounts") as f:
                for mline in f:
                    fields = mline.split()
                    if len(fields) >= 4 and fields[2] in ("nfs", "nfs4"):
                        for opt in fields[3].split(","):
                            if opt.startswith("vers="):
                                nfs_ver = opt.split("=", 1)[1]
                                break
                    if nfs_ver:
                        break
        except Exception:
            pass
        if nfs_ver:
            lines.append(f"    {_DIM}Protocol version: NFSv{nfs_ver}{_NC}")
        else:
            lines.append(f"    {_DIM}Protocol version: N/A (no active mounts){_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} NFS client tools {_RED}NOT installed{_NC}")
        lines.append(f"    {_DIM}Install: apt-get install nfs-common{_NC}")

    # ── RDMA / DOCA OFED ──────────────────────────────────────────────
    lines.append(_section("RDMA / DOCA OFED"))

    ib_dir = Path("/sys/class/infiniband")
    if ib_dir.is_dir():
        devices = sorted([d.name for d in ib_dir.iterdir() if d.is_dir()])
        if devices:
            lines.append(f"  {_GRN}\u25cf{_NC} RDMA {_GRN}available{_NC}")
            for dev in devices:
                ports_dir = ib_dir / dev / "ports"
                if not ports_dir.is_dir():
                    continue
                for port_path in sorted(ports_dir.iterdir()):
                    state_file = port_path / "state"
                    if not state_file.is_file():
                        continue
                    try:
                        raw = state_file.read_text().strip()
                        # Format: "4: ACTIVE" or just "ACTIVE"
                        state = raw.split(":")[-1].strip() if ":" in raw else raw
                    except Exception:
                        state = "unknown"
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
        else:
            lines.append(f"  {_YLW}\u25cf{_NC} RDMA module loaded, {_YLW}no devices{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} RDMA {_RED}not available{_NC}")
        lines.append(f"    {_DIM}Install DOCA OFED for RDMA support{_NC}")

    # ── GPUDirect Storage ─────────────────────────────────────────────
    lines.append(_section("GPUDirect Storage (GDS)"))

    nvidia_fs_loaded = False
    try:
        with open("/proc/modules") as f:
            for mline in f:
                if mline.startswith("nvidia_fs "):
                    nvidia_fs_loaded = True
                    break
    except Exception:
        pass

    if nvidia_fs_loaded:
        lines.append(f"  {_GRN}\u25cf{_NC} nvidia-fs module {_GRN}loaded{_NC}")
        if Path("/etc/cufile.json").is_file():
            lines.append(f"  {_GRN}\u25cf{_NC} cuFile configured")
        else:
            lines.append(f"  {_YLW}\u25cf{_NC} cuFile {_YLW}not configured{_NC}")
    else:
        lines.append(f"  {_DIM}\u25cf{_NC} GDS {_DIM}not installed{_NC} (optional)")

    has_nvidia_smi = shutil.which("nvidia-smi") is not None
    if has_nvidia_smi:
        lines.append(f"  {_GRN}\u25cf{_NC} nvidia-smi {_GRN}available{_NC}")
    else:
        lines.append(f"  {_DIM}\u25cf{_NC} nvidia-smi {_DIM}not found{_NC}")

    # ── ACTIVE NFS MOUNTS ─────────────────────────────────────────────
    lines.append(_section("ACTIVE NFS MOUNTS"))

    try:
        r = subprocess.run(
            ["mount", "-t", "nfs,nfs4"],
            capture_output=True, text=True, timeout=5,
        )
        mount_lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
    except Exception:
        mount_lines = []

    if mount_lines:
        for ml in mount_lines:
            # Format: server:/path on /mount/point type nfs4 (opts)
            parts = ml.split()
            if len(parts) < 3:
                continue
            source = parts[0]
            mountpoint = parts[2]

            # Extract options from parentheses
            opts_match = re.search(r"\(([^)]+)\)", ml)
            opts = opts_match.group(1) if opts_match else ""

            # Protocol badge
            if "rdma" in opts:
                proto = f"{_GRN}RDMA{_NC}"
            else:
                proto = f"{_YLW}TCP{_NC}"

            # Disk usage
            usage_str = ""
            try:
                df_r = subprocess.run(
                    ["df", "-h", mountpoint],
                    capture_output=True, text=True, timeout=3,
                )
                df_lines = df_r.stdout.strip().splitlines()
                if len(df_lines) >= 2:
                    df_parts = df_lines[1].split()
                    if len(df_parts) >= 5:
                        usage_str = (
                            f" {_DIM}{df_parts[2]}/{df_parts[1]} ({df_parts[4]}){_NC}"
                        )
            except Exception:
                pass

            lines.append(f"  {_GRN}\u25cf{_NC} {_BLD}{mountpoint}{_NC}{usage_str}")
            lines.append(f"    {_DIM}{source}{_NC} [{proto}]")
    else:
        lines.append(f"  {_DIM}(none){_NC}")

    # ── FSTAB ENTRIES ─────────────────────────────────────────────────
    lines.append(_section("CONFIGURED MOUNTS (fstab)"))

    fstab_entries: list[tuple[str, str]] = []
    try:
        with open("/etc/fstab") as f:
            for fline in f:
                stripped = fline.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                fparts = stripped.split()
                if len(fparts) >= 3 and fparts[2] in ("nfs", "nfs4"):
                    fstab_entries.append((fparts[0], fparts[1]))
    except Exception:
        pass

    if fstab_entries:
        # Get current mounts for comparison
        current_mounts: set[str] = set()
        try:
            r = subprocess.run(
                ["mount"], capture_output=True, text=True, timeout=3,
            )
            for ml in r.stdout.splitlines():
                parts = ml.split()
                if len(parts) >= 3:
                    current_mounts.add(parts[2])
        except Exception:
            pass

        for source, mpoint in fstab_entries:
            if mpoint in current_mounts:
                badge = f"{_GRN}[mounted]{_NC}"
            else:
                badge = f"{_DIM}[not mounted]{_NC}"
            lines.append(
                f"  {_CYN}\u25cf{_NC} {source} {_DIM}\u2192{_NC} "
                f"{_BLD}{mpoint}{_NC} {badge}"
            )
    else:
        lines.append(f"  {_DIM}No NFS entries in /etc/fstab{_NC}")

    # ── NETWORK INTERFACES ────────────────────────────────────────────
    lines.append(_section("NETWORK INTERFACES"))

    net_dir = Path("/sys/class/net")
    iface_count = 0
    try:
        for iface in sorted(net_dir.iterdir()):
            name = iface.name
            if name == "lo":
                continue

            # Read operstate
            try:
                state = (iface / "operstate").read_text().strip()
            except Exception:
                state = "unknown"
            if state == "up":
                icon = f"{_GRN}\u25b2{_NC}"
            else:
                icon = f"{_RED}\u25bc{_NC}"

            # Speed
            try:
                raw_speed = int((iface / "speed").read_text().strip())
                if raw_speed >= 1000:
                    speed_str = f"{_GRN}{raw_speed // 1000}Gb/s{_NC}"
                elif raw_speed > 0:
                    speed_str = f"{_YLW}{raw_speed}Mb/s{_NC}"
                else:
                    speed_str = f"{_DIM}---{_NC}"
            except Exception:
                speed_str = f"{_DIM}---{_NC}"

            # IP address
            try:
                r = subprocess.run(
                    ["ip", "-4", "-o", "addr", "show", name],
                    capture_output=True, text=True, timeout=2,
                )
                m = re.search(r"inet\s+(\S+)", r.stdout)
                ip_str = m.group(1) if m else f"{_DIM}no IP{_NC}"
            except Exception:
                ip_str = f"{_DIM}no IP{_NC}"

            # Driver badge
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

            lines.append(
                f"  {icon} {name:<16} {_DIM}{badge:<4}{_NC}  "
                f"{ip_str:<20} {speed_str}"
            )
            iface_count += 1
    except Exception:
        pass

    if iface_count == 0:
        lines.append(f"  {_DIM}No network interfaces detected{_NC}")

    # ── Footer ────────────────────────────────────────────────────────
    lines.append("")
    if timestamp:
        lines.append(f"  {_DIM}Last updated: {_NC}{timestamp}")
    lines.append("")

    return "\n".join(lines)
