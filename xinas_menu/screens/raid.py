"""RAIDScreen — show RAID arrays, physical drives, spare pools."""
from __future__ import annotations

import asyncio
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label
from textual.widgets import Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Show RAID Arrays"),
    MenuItem("2", "Physical Drives"),
    MenuItem("3", "Spare Pools"),
    MenuItem("0", "Back"),
]


class RAIDScreen(Screen):
    """RAID management — read-only views."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── RAID Management ──", id="screen-title")
        yield NavigableMenu(_MENU, id="raid-nav")
        yield ScrollableTextView(id="raid-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._load_summary())

    async def _load_summary(self) -> None:
        ok, data, err = await self.app.grpc.raid_show()
        view = self.query_one("#raid-content", ScrollableTextView)
        if ok:
            view.set_content(_format_raid_show(data))
        else:
            view.set_content(f"[red]Could not load RAID info: {err}[/red]")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_arrays())
        elif key == "2":
            asyncio.create_task(self._show_drives())
        elif key == "3":
            asyncio.create_task(self._show_pools())

    async def _show_arrays(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("[dim]Loading RAID arrays…[/dim]")
        ok, data, err = await self.app.grpc.raid_show()
        if ok:
            view.set_content(_format_raid_show(data))
        else:
            view.set_content(f"[red]{err}[/red]")

    async def _show_drives(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("[dim]Loading drive list…[/dim]")
        ok, data, err = await self.app.grpc.disk_list()
        if ok:
            view.set_content(_format_disk_list(data))
        else:
            view.set_content(f"[red]{err}[/red]")

    async def _show_pools(self) -> None:
        view = self.query_one("#raid-content", ScrollableTextView)
        view.set_content("[dim]Loading spare pools…[/dim]")
        ok, data, err = await self.app.grpc.pool_list()
        if ok:
            view.set_content(_format_pool_list(data))
        else:
            view.set_content(f"[red]{err}[/red]")


def _format_raid_show(data: Any) -> str:
    """Format raid_show JSON response (list of array dicts)."""
    lines = ["[bold]RAID Arrays[/bold]\n"]
    try:
        arrays = data if isinstance(data, list) else []
        if not arrays:
            lines.append("  (no RAID arrays configured)")
            return "\n".join(lines)
        for arr in arrays:
            name = arr.get("name", "?") if isinstance(arr, dict) else getattr(arr, "name", "?")
            level = arr.get("level", "?") if isinstance(arr, dict) else getattr(arr, "level", "?")
            state = arr.get("state", "?") if isinstance(arr, dict) else getattr(arr, "state", "?")
            size = (arr.get("size_gb") or arr.get("capacity_gb") or arr.get("size", "?")
                    if isinstance(arr, dict) else getattr(arr, "size_gb", "?"))
            color = "green" if state in ("active", "normal", "healthy", "online") else "yellow"
            lines.append(
                f"  [{color}]●[/{color}] [bold]{name}[/bold]  "
                f"RAID-{level}  [{color}]{state}[/{color}]  {size} GB"
            )
            members = arr.get("members", []) if isinstance(arr, dict) else []
            for m in members:
                mpath = m.get("path", m.get("name", "?")) if isinstance(m, dict) else str(m)
                mstate = m.get("state", "") if isinstance(m, dict) else ""
                mcolor = "green" if mstate in ("active", "normal", "ok") else "dim"
                lines.append(f"    [{mcolor}]{mpath}[/{mcolor}]  {mstate}")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)


def _format_disk_list(data: Any) -> str:
    """Format disk_list response (list of OS-level drive dicts)."""
    lines = ["[bold]Physical Drives[/bold]\n"]
    try:
        disks = data if isinstance(data, list) else []
        if not disks:
            lines.append("  (no drives found)")
            return "\n".join(lines)
        for d in disks:
            name = d.get("name", "?") if isinstance(d, dict) else getattr(d, "name", "?")
            model = (d.get("model", "") if isinstance(d, dict) else getattr(d, "model", "")).strip()
            size = d.get("size", "?") if isinstance(d, dict) else getattr(d, "size", "?")
            raid_name = d.get("raid_name", "") if isinstance(d, dict) else ""
            member_state = d.get("member_state", "") if isinstance(d, dict) else ""
            transport = d.get("transport", "") if isinstance(d, dict) else ""
            suffix = f"  [{raid_name}] {member_state}" if raid_name else "  unassigned"
            lines.append(f"  [cyan]{name}[/cyan]  {model}  {size}  {transport}{suffix}")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)


def _format_pool_list(data: Any) -> str:
    """Format pool_show JSON response (list of pool dicts or single dict)."""
    lines = ["[bold]Spare Pools[/bold]\n"]
    try:
        # pool_show may return a list or a single dict
        if isinstance(data, list):
            pools = data
        elif isinstance(data, dict):
            pools = [data] if data else []
        else:
            pools = []
        if not pools:
            lines.append("  (no spare pools configured)")
            return "\n".join(lines)
        for p in pools:
            name = p.get("name", "?") if isinstance(p, dict) else str(p)
            size = (p.get("size_gb") or p.get("size", "?")) if isinstance(p, dict) else "?"
            drives = p.get("drives", []) if isinstance(p, dict) else []
            lines.append(f"  [bold]{name}[/bold]  {size} GB  ({len(drives)} drives)")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)
