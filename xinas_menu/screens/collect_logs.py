"""CollectLogsScreen — gather system info, audit log, and journal into a .tgz archive."""
from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
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
    MenuItem("1", "Collect All"),
    MenuItem("2", "Upload Archive"),
    MenuItem("3", "View Last Archive"),
    MenuItem("0", "Back"),
]

_ARCHIVE_GLOB = "*-logs-*.tgz"


class CollectLogsScreen(Screen):
    """Collect system data, audit log, and journal into a .tgz archive."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._last_archive: str | None = None

    def compose(self) -> ComposeResult:
        yield Label("  Collect Logs", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="cl-nav")
            yield ScrollableTextView(id="cl-content")
        yield Footer()

    def on_mount(self) -> None:
        view = self.query_one("#cl-content", ScrollableTextView)
        view.set_content(
            f"{_BLD}{_CYN}Collect Logs{_NC}\n"
            f"\n"
            f"  {_BLD}1{_NC}  {_CYN}Collect All{_NC}        {_DIM}Gather system data into archive{_NC}\n"
            f"  {_BLD}2{_NC}  {_CYN}Upload Archive{_NC}     {_DIM}Upload archive to transfer server{_NC}\n"
            f"  {_BLD}3{_NC}  {_CYN}View Last Archive{_NC}  {_DIM}List contents of most recent archive{_NC}\n"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._collect_all()
        elif key == "2":
            self._upload_archive()
        elif key == "3":
            self._view_last()

    # ── Collect All ──────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _collect_all(self) -> None:
        config_name = await self.app.push_screen_wait(
            InputDialog(
                "Config name for this collection:",
                title="Collect Logs",
                default=socket.gethostname(),
            )
        )
        if config_name is None:
            return
        email = await self.app.push_screen_wait(
            InputDialog(
                "Email address:",
                title="Collect Logs",
                default="user@example.com",
            )
        )
        if email is None:
            return

        view = self.query_one("#cl-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        tmp = await loop.run_in_executor(None, tempfile.mkdtemp)

        steps: list[tuple[str, object]] = [
            ("System info", lambda: _collect_sysinfo(tmp, config_name, email)),
            ("Block devices (lsblk)", lambda: _collect_cmd(tmp, "lsblk.txt", "lsblk", "-o", "NAME,SIZE,TYPE,MOUNTPOINT")),
            ("RAID status (/proc/mdstat)", lambda: _collect_file(tmp, "mdstat.txt", "/proc/mdstat")),
            ("LVM (pvs)", lambda: _collect_cmd(tmp, "pvs.txt", "pvs")),
            ("NVMe devices", lambda: _collect_cmd(tmp, "nvme_list.txt", "nvme", "list")),
            ("PCI devices", lambda: _collect_cmd(tmp, "lspci.txt", "lspci")),
            ("Hardware key", lambda: _collect_hwkey(tmp)),
            ("NUMA topology", lambda: _collect_numa(tmp)),
            ("Audit log", lambda: _collect_file(tmp, "audit.log", "/var/log/xinas/audit.log")),
            ("System journal (last 1000)", lambda: _collect_cmd(tmp, "journalctl.txt", "journalctl", "-n", "1000", "--no-pager")),
            ("Kernel messages (dmesg)", lambda: _collect_cmd(tmp, "dmesg.txt", "dmesg", "--time-format", "iso")),
        ]

        lines = [f"{_BLD}{_CYN}Collecting Logs{_NC}", ""]
        total = len(steps)
        for i, (label, fn) in enumerate(steps, 1):
            lines.append(f"  [{i}/{total}] {label}...")
            view.set_content("\n".join(lines))
            await loop.run_in_executor(None, fn)
            lines[-1] = f"  {_GRN}*{_NC} [{i}/{total}] {label}"

        lines.append(f"\n  Creating archive...")
        view.set_content("\n".join(lines))

        hostname = socket.gethostname()
        archive_path = await loop.run_in_executor(
            None, lambda: _create_archive(tmp, hostname)
        )

        size = os.path.getsize(archive_path)
        size_str = _human_size(size)
        lines[-1] = f"  {_GRN}*{_NC} Archive created"
        lines.append("")
        lines.append(f"  {_BLD}Archive:{_NC} {archive_path}")
        lines.append(f"  {_BLD}Size:{_NC}    {size_str}")
        lines.append("")
        lines.append(f"  {_DIM}Use 'Upload Archive' to send to transfer server.{_NC}")
        view.set_content("\n".join(lines))

        self._last_archive = archive_path
        self.app.audit.log("collect_logs.collect", archive_path, "OK")

    # ── Upload Archive ───────────────────────────────────────────────────

    @work(exclusive=True)
    async def _upload_archive(self) -> None:
        view = self.query_one("#cl-content", ScrollableTextView)
        archive = self._last_archive or _find_latest_archive()
        if not archive or not Path(archive).exists():
            view.set_content(
                f"  {_YLW}No archive found.{_NC}\n\n"
                f"  Run {_BLD}Collect All{_NC} first to create an archive."
            )
            return

        size_str = _human_size(os.path.getsize(archive))
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Upload {Path(archive).name} ({size_str}) to transfer server?",
                "Upload Archive",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  Uploading {Path(archive).name}...")
        loop = asyncio.get_running_loop()
        ok, msg = await loop.run_in_executor(None, lambda: _upload(archive))

        if ok:
            view.set_content(
                f"  {_GRN}Upload successful.{_NC}\n\n"
                f"  {_DIM}{msg}{_NC}"
            )
            self.app.audit.log("collect_logs.upload", archive, "OK")
        else:
            view.set_content(f"  {_RED}Upload failed:{_NC} {msg}")
            self.app.audit.log("collect_logs.upload", archive, "FAIL", msg)

    # ── View Last Archive ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _view_last(self) -> None:
        view = self.query_one("#cl-content", ScrollableTextView)
        archive = self._last_archive or _find_latest_archive()
        if not archive or not Path(archive).exists():
            view.set_content(
                f"  {_YLW}No archive found.{_NC}\n\n"
                f"  Run {_BLD}Collect All{_NC} first to create an archive."
            )
            return

        view.set_content("  Reading archive...")
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, lambda: _list_archive(archive))
        view.set_content(text)


# ── Helper functions (synchronous, run in executor) ──────────────────────


def _collect_sysinfo(tmp: str, config_name: str, email: str) -> None:
    import platform

    lines = [
        f"Config name: {config_name}",
        f"Email: {email}",
        f"Hostname: {socket.gethostname()}",
        f"Kernel: {platform.release()}",
        f"OS: {platform.platform()}",
    ]
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        days, rem = divmod(int(secs), 86400)
        hours, rem = divmod(rem, 3600)
        lines.append(f"Uptime: {days}d {hours}h {rem // 60}m")
    except Exception:
        pass
    Path(tmp, "info.txt").write_text("\n".join(lines) + "\n")


def _collect_cmd(tmp: str, filename: str, *args: str) -> None:
    try:
        r = subprocess.run(
            list(args), capture_output=True, text=True, timeout=30,
        )
        Path(tmp, filename).write_text(r.stdout or r.stderr or "(no output)\n")
    except Exception as exc:
        Path(tmp, filename).write_text(f"Error: {exc}\n")


def _collect_file(tmp: str, filename: str, src: str) -> None:
    try:
        shutil.copy2(src, Path(tmp, filename))
    except FileNotFoundError:
        Path(tmp, filename).write_text("(file not found)\n")
    except Exception as exc:
        Path(tmp, filename).write_text(f"Error: {exc}\n")


def _collect_hwkey(tmp: str) -> None:
    for candidate in ("/opt/xiNAS/hwkey", "./hwkey"):
        p = Path(candidate)
        if p.is_file():
            try:
                r = subprocess.run(
                    [str(p)], capture_output=True, text=True, timeout=10,
                )
                Path(tmp, "hwkey.txt").write_text(r.stdout or r.stderr or "(no output)\n")
                return
            except Exception as exc:
                Path(tmp, "hwkey.txt").write_text(f"Error: {exc}\n")
                return
    Path(tmp, "hwkey.txt").write_text("(hwkey binary not found)\n")


def _collect_numa(tmp: str) -> None:
    lines: list[str] = []
    try:
        for dev in sorted(Path("/sys/block").iterdir()):
            node_file = dev / "device" / "numa_node"
            if node_file.exists():
                node = node_file.read_text().strip()
                lines.append(f"{dev.name} {node}")
            else:
                lines.append(f"{dev.name} unknown")
    except Exception as exc:
        lines.append(f"Error: {exc}")
    Path(tmp, "numa_nodes.txt").write_text("\n".join(lines) + "\n")


def _create_archive(tmp: str, hostname: str) -> str:
    ts = time.strftime("%Y%m%d-%H%M%S")
    archive_path = f"/tmp/{hostname}-logs-{ts}.tgz"
    with tarfile.open(archive_path, "w:gz") as tar:
        for item in Path(tmp).iterdir():
            tar.add(str(item), arcname=item.name)
    shutil.rmtree(tmp, ignore_errors=True)
    return archive_path


def _upload(archive_path: str) -> tuple[bool, str]:
    server = os.environ.get("TRANSFER_SERVER", "http://178.253.23.152:8080")
    basename = Path(archive_path).name
    try:
        r = subprocess.run(
            ["curl", "--fail", "--upload-file", archive_path, f"{server}/{basename}"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode == 0:
            return True, r.stdout.strip() or "Upload complete."
        return False, r.stderr.strip() or f"curl exited with code {r.returncode}"
    except Exception as exc:
        return False, str(exc)


def _find_latest_archive() -> str | None:
    archives = sorted(
        Path("/tmp").glob(_ARCHIVE_GLOB),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return str(archives[0]) if archives else None


def _list_archive(archive_path: str) -> str:
    lines = [
        f"{_BLD}{_CYN}Archive Contents{_NC}",
        f"  {_DIM}{archive_path}{_NC}",
        f"  {_DIM}Size: {_human_size(os.path.getsize(archive_path))}{_NC}",
        "",
    ]
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            for member in tar.getmembers():
                if member.isfile():
                    lines.append(f"  {member.name:<30} {_human_size(member.size)}")
    except Exception as exc:
        lines.append(f"  {_RED}Error reading archive: {exc}{_NC}")
    return "\n".join(lines)


def _human_size(nbytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024:
            return f"{nbytes:.1f} {unit}" if unit != "B" else f"{nbytes} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"
