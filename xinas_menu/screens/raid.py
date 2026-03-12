"""RAIDScreen — show RAID arrays, physical drives, spare pools."""
from __future__ import annotations

import asyncio
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

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
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── RAID Management ──", id="screen-title")
        yield NavigableMenu(_MENU, id="raid-nav")
        yield ScrollableTextView(id="raid-content")

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
    lines = ["[bold]RAID Arrays[/bold]\n"]
    try:
        arrays = data.arrays if hasattr(data, "arrays") else (data or [])
        for arr in arrays:
            name = getattr(arr, "name", "?")
            level = getattr(arr, "level", "?")
            state = getattr(arr, "state", "?")
            capacity = getattr(arr, "capacity_gb", "?")
            color = "green" if state in ("normal", "healthy", "online") else "yellow"
            lines.append(f"  [{color}]●[/{color}] [bold]{name}[/bold]  RAID-{level}  {state}  {capacity} GB")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)


def _format_disk_list(data: Any) -> str:
    lines = ["[bold]Physical Drives[/bold]\n"]
    try:
        disks = data.disks if hasattr(data, "disks") else (data or [])
        for d in disks:
            name = getattr(d, "name", "?")
            model = getattr(d, "model", "")
            size = getattr(d, "size_gb", "?")
            state = getattr(d, "state", "?")
            color = "green" if state in ("healthy", "ok", "normal") else "yellow"
            lines.append(f"  [{color}]{name}[/{color}]  {model}  {size} GB  {state}")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)


def _format_pool_list(data: Any) -> str:
    lines = ["[bold]Spare Pools[/bold]\n"]
    try:
        pools = data.pools if hasattr(data, "pools") else (data or [])
        for p in pools:
            name = getattr(p, "name", "?")
            size = getattr(p, "size", "?")
            lines.append(f"  {name}  {size}")
        if not pools:
            lines.append("  (no spare pools configured)")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)
