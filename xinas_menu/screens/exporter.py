"""ExporterScreen — xiraid-exporter install / update / uninstall."""
from __future__ import annotations

import asyncio
import re
import subprocess
import urllib.request
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_GITHUB_RELEASES_API = "https://api.github.com/repos/xinnor/xiraid-exporter/releases/latest"
_DEB_PATTERN = re.compile(r"xiraid.exporter.*\.deb", re.I)

_MENU = [
    MenuItem("1", "Show Status"),
    MenuItem("2", "Install / Update"),
    MenuItem("3", "Uninstall"),
    MenuItem("0", "Back"),
]


class ExporterScreen(Screen):
    """xiRAID Prometheus exporter management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── xiRAID Exporter ──", id="screen-title")
        yield NavigableMenu(_MENU, id="exp-nav")
        yield ScrollableTextView(id="exp-content")

    def on_mount(self) -> None:
        asyncio.create_task(self._show_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_status())
        elif key == "2":
            asyncio.create_task(self._install_or_update())
        elif key == "3":
            asyncio.create_task(self._uninstall())

    async def _show_status(self) -> None:
        loop = asyncio.get_event_loop()
        lines = ["[bold]xiRAID Exporter Status[/bold]\n"]

        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        state = await loop.run_in_executor(None, lambda: ctl.state("xiraid-exporter"))
        color = "green" if state.is_active else "red"
        lines.append(f"  Service:  [{color}]{state.active}[/{color}]")

        installed_ver = await loop.run_in_executor(None, _get_installed_version)
        lines.append(f"  Installed: {installed_ver or '(not installed)'}")

        view = self.query_one("#exp-content", ScrollableTextView)
        view.set_content("\n".join(lines))

        # Background: fetch latest version
        asyncio.create_task(self._append_latest_version(lines, view))

    async def _append_latest_version(self, lines: list, view: ScrollableTextView) -> None:
        loop = asyncio.get_event_loop()
        latest = await loop.run_in_executor(None, _get_latest_version)
        lines.append(f"  Latest:   {latest or '(could not fetch)'}")
        view.set_content("\n".join(lines))

    async def _install_or_update(self) -> None:
        loop = asyncio.get_event_loop()
        latest = await loop.run_in_executor(None, _get_latest_version)
        installed = await loop.run_in_executor(None, _get_installed_version)

        if installed and installed == latest:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Already at latest version ({installed}).", "Up to Date")
            )
            return

        msg = f"Install xiraid-exporter {latest}?" if not installed else \
              f"Update from {installed} to {latest}?"
        confirmed = await self.app.push_screen_wait(ConfirmDialog(msg, "Confirm"))
        if not confirmed:
            return

        view = self.query_one("#exp-content", ScrollableTextView)
        view.set_content("[dim]Downloading…[/dim]")

        ok, err = await loop.run_in_executor(None, lambda: _install_exporter(latest))
        if ok:
            self.app.audit.log("exporter.install", latest or "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Exporter installed.", "Done"))
            await self._show_status()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _uninstall(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Uninstall xiraid-exporter?", "Confirm")
        )
        if not confirmed:
            return
        loop = asyncio.get_event_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["apt-get", "remove", "-y", "xiraid-exporter"],
                capture_output=True, text=True,
            )
        )
        if r.returncode == 0:
            self.app.audit.log("exporter.uninstall", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Exporter uninstalled.", "Done"))
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed:\n{r.stderr[:200]}", "Error")
            )
        await self._show_status()


def _get_installed_version() -> str | None:
    r = subprocess.run(
        ["dpkg-query", "-W", "-f=${Version}", "xiraid-exporter"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def _get_latest_version() -> str | None:
    try:
        req = urllib.request.Request(
            _GITHUB_RELEASES_API,
            headers={"User-Agent": "xiNAS-menu"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            import json
            data = json.loads(resp.read())
            return data.get("tag_name", "").lstrip("v") or None
    except Exception:
        return None


def _install_exporter(version: str | None) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(
            _GITHUB_RELEASES_API,
            headers={"User-Agent": "xiNAS-menu"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            import json
            data = json.loads(resp.read())
            assets = data.get("assets", [])
            deb_url = next(
                (a["browser_download_url"] for a in assets
                 if _DEB_PATTERN.search(a.get("name", ""))),
                None
            )
        if not deb_url:
            return False, "no .deb asset found in GitHub release"

        tmp = Path("/tmp/xiraid-exporter.deb")
        urllib.request.urlretrieve(deb_url, tmp)
        r = subprocess.run(["dpkg", "-i", str(tmp)], capture_output=True, text=True)
        tmp.unlink(missing_ok=True)
        if r.returncode != 0:
            return False, r.stderr[:300]
        return True, ""
    except Exception as exc:
        return False, str(exc)
