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
from textual.widgets import Footer

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_GITHUB_RELEASES_API = "https://api.github.com/repos/xinnor/xiraid-exporter/releases/latest"
_DEB_PATTERN = re.compile(r"xiraid.exporter.*\.deb", re.I)

_MENU = [
    MenuItem("1", "Show Status"),
    MenuItem("2", "Install / Check Update"),
    MenuItem("3", "Restart Service"),
    MenuItem("4", "Uninstall"),
    MenuItem("0", "Back"),
]


class ExporterScreen(Screen):
    """xiRAID Prometheus exporter management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── xiRAID Exporter ──", id="screen-title")
        yield NavigableMenu(_MENU, id="exp-nav")
        yield ScrollableTextView(id="exp-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._show_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_status())
        elif key == "2":
            asyncio.create_task(self._check_or_install())
        elif key == "3":
            asyncio.create_task(self._restart_service())
        elif key == "4":
            asyncio.create_task(self._uninstall())

    async def _show_status(self) -> None:
        loop = asyncio.get_event_loop()
        installed = await loop.run_in_executor(None, _get_installed_version)

        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        state = await loop.run_in_executor(None, lambda: ctl.state("xiraid-exporter"))

        lines: list[str] = ["xiRAID Exporter", "=" * 50, ""]
        if installed:
            svc_icon = "*" if state.is_active else "o"
            lines.append(f"  {svc_icon}  xiraid-exporter   v{installed}  ({state.active})")
            lines.append("     Metrics:  http://localhost:9827/metrics")
        else:
            lines.append("  o  xiraid-exporter   Not installed")
            lines.append("     Prometheus metrics exporter for xiRAID storage")
            lines.append("     Developed by E4 Computer Engineering")
        lines.append("")
        lines.append("  Fetching latest version…")

        view = self.query_one("#exp-content", ScrollableTextView)
        view.set_content("\n".join(lines))

        # Background: fetch and show latest version
        asyncio.create_task(self._append_latest(lines, view, installed))

    async def _append_latest(self, lines: list, view: ScrollableTextView,
                              installed: str | None) -> None:
        loop = asyncio.get_event_loop()
        latest = await loop.run_in_executor(None, _get_latest_version)
        lines[-1] = f"  Latest available:  {latest or '(could not fetch)'}"
        if installed and latest and installed != latest:
            lines.append(f"  Update available:  v{latest}")
        view.set_content("\n".join(lines))

    async def _check_or_install(self) -> None:
        loop = asyncio.get_event_loop()
        installed = await loop.run_in_executor(None, _get_installed_version)
        latest = await loop.run_in_executor(None, _get_latest_version)

        if not latest:
            await self.app.push_screen_wait(
                ConfirmDialog("Could not fetch latest version from GitHub.\nCheck internet connection.", "Error")
            )
            return

        if installed and installed == latest:
            await self.app.push_screen_wait(
                ConfirmDialog(f"xiraid-exporter v{installed} is the latest version.", "Up to Date")
            )
            return

        msg = (f"Install xiraid-exporter v{latest}?\n\nDownloads .deb from GitHub,\n"
               f"installs service, exposes metrics on port 9827."
               if not installed else
               f"Update xiraid-exporter?\n\nInstalled: v{installed}\nLatest:    v{latest}")
        confirmed = await self.app.push_screen_wait(ConfirmDialog(msg, "Confirm"))
        if not confirmed:
            return

        view = self.query_one("#exp-content", ScrollableTextView)
        view.set_content("Downloading and installing…")

        ok, err = await loop.run_in_executor(None, lambda: _install_exporter(latest))
        if ok:
            self.app.audit.log("exporter.install", latest or "", "OK")
            await self.app.push_screen_wait(ConfirmDialog(f"xiraid-exporter v{latest} installed.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))
        await self._show_status()

    async def _restart_service(self) -> None:
        loop = asyncio.get_event_loop()
        installed = await loop.run_in_executor(None, _get_installed_version)
        if not installed:
            await self.app.push_screen_wait(ConfirmDialog("xiraid-exporter is not installed.", "Not Installed"))
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart xiraid-exporter service?", "Confirm")
        )
        if not confirmed:
            return
        from xinas_menu.utils.service_ctl import ServiceController
        ctl = ServiceController()
        ok, err = await loop.run_in_executor(None, lambda: ctl.restart("xiraid-exporter"))
        if ok:
            self.app.audit.log("exporter.restart", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Service restarted.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))
        await self._show_status()

    async def _uninstall(self) -> None:
        loop = asyncio.get_event_loop()
        installed = await loop.run_in_executor(None, _get_installed_version)
        if not installed:
            await self.app.push_screen_wait(ConfirmDialog("xiraid-exporter is not installed.", "Not Installed"))
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Uninstall xiraid-exporter and stop the service?", "Confirm")
        )
        if not confirmed:
            return
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["apt-get", "purge", "-y", "xiraid-exporter"],
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
