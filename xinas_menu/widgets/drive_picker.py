"""DrivePickerScreen — interactive NVMe drive selection with filters and sorting.

Inspired by xiTools/block-info interactive TUI. Provides:
- Filter by NUMA node, size range, name/model text search
- Sort by name, size, model, NUMA (with reverse toggle)
- Multi-select with Space, select-all with 'a', detail view with Enter
- Status bar showing selected count and active filters
"""
from __future__ import annotations

import logging
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, DataTable, Footer, Input, Label, Static
from textual import work

_log = logging.getLogger(__name__)


def _fmt_size(size_bytes: int) -> str:
    """Format byte count as human-readable (IEC units)."""
    if size_bytes <= 0:
        return "N/A"
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}" if unit != "B" else f"{size_bytes} B"
        size_bytes /= 1024
    return f"{size_bytes:.1f} EB"


class DrivePickerScreen(ModalScreen[list[str] | None]):
    """Full-featured drive picker with filtering, sorting, and multi-select.

    Returns list of selected drive names, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=True, key_display="Esc"),
        Binding("space", "toggle_select", "Toggle", show=True),
        Binding("a", "toggle_all", "All", show=True),
        Binding("s", "cycle_sort", "Sort", show=True),
        Binding("r", "reverse_sort", "Reverse", show=True),
        Binding("f", "filter_prompt", "Filter", show=True),
        Binding("n", "filter_numa", "NUMA", show=True),
        Binding("d", "show_detail", "Detail", show=True),
        Binding("enter", "confirm", "OK", show=True),
    ]

    DEFAULT_CSS = """
    DrivePickerScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.6);
    }
    #picker-container {
        background: #1c1c1c;
        border: round #3a3a3a;
        width: 110;
        max-width: 98%;
        height: 85%;
        padding: 1 2;
    }
    #picker-title {
        text-style: bold;
        color: #e0e0e0;
        text-align: left;
        margin-bottom: 1;
    }
    #picker-status {
        color: #999999;
        height: 1;
        margin-bottom: 0;
    }
    #picker-filter-bar {
        height: 1;
        color: #d0d4e0;
        margin-bottom: 0;
    }
    #picker-table {
        height: 1fr;
        margin-bottom: 1;
    }
    #picker-buttons {
        layout: horizontal;
        align: center middle;
        height: 3;
    }
    #picker-buttons Button.-primary {
        background: #d4a574;
        color: #1c1c1c;
        text-style: bold;
        border: none;
        min-width: 12;
        margin: 0 1;
    }
    #picker-buttons Button.-primary:hover,
    #picker-buttons Button.-primary:focus {
        background: #e0b88a;
    }
    #picker-buttons Button.-default {
        background: #2a2a2a;
        border: none;
        color: #999999;
        min-width: 12;
        margin: 0 1;
    }
    #picker-buttons Button.-default:hover,
    #picker-buttons Button.-default:focus {
        background: #3a3a3a;
        color: #e0e0e0;
    }
    #picker-detail {
        display: none;
        background: #1c1c1c;
        border: round #3a3a3a;
        padding: 1 2;
        height: auto;
        max-height: 60%;
    }
    """

    _SORT_KEYS = [None, "name", "size", "model", "numa"]
    _SORT_LABELS = ["default", "name", "size", "model", "NUMA"]

    def __init__(
        self,
        drives: list[dict[str, Any]],
        title: str = "Select Drives",
        preselected: set[str] | list[str] | None = None,
    ) -> None:
        super().__init__()
        self._all_drives = list(drives)
        self._title = title
        self._selected: set[str] = set(preselected) if preselected else set()
        self._sort_idx = 0
        self._sort_reverse = False
        self._filter_text = ""
        self._filter_numa: int | None = None
        self._filter_size_min: int = 0
        self._filter_size_max: int = 0

    def compose(self) -> ComposeResult:
        with Vertical(id="picker-container"):
            yield Label(self._title, id="picker-title")
            yield Static("", id="picker-status")
            yield Static("", id="picker-filter-bar")
            yield DataTable(id="picker-table")
            with Horizontal(id="picker-buttons"):
                yield Button("OK [Enter]", variant="primary", id="btn-ok")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")
        yield Static("", id="picker-detail")

    def on_mount(self) -> None:
        table = self.query_one("#picker-table", DataTable)
        table.cursor_type = "row"
        table.zebra_stripes = True
        table.add_columns("", "Name", "Size", "Model", "Serial", "NUMA", "Transport")
        self._refresh_table()

    def _get_filtered_drives(self) -> list[dict]:
        """Apply current filters and sorting to drive list."""
        result = []
        for d in self._all_drives:
            # Text filter (name + model)
            if self._filter_text:
                haystack = (d.get("name", "") + " " + d.get("model", "")).lower()
                if self._filter_text.lower() not in haystack:
                    continue
            # NUMA filter
            if self._filter_numa is not None:
                numa = d.get("numa_node", d.get("numa", -1))
                if numa != self._filter_numa:
                    continue
            # Size range filters
            size = d.get("size_bytes") or d.get("size_raw") or 0
            if self._filter_size_min and size < self._filter_size_min:
                continue
            if self._filter_size_max and size > self._filter_size_max:
                continue
            result.append(d)

        # Sort
        sort_key = self._SORT_KEYS[self._sort_idx]
        if sort_key == "name":
            result.sort(key=lambda d: d.get("name", ""), reverse=self._sort_reverse)
        elif sort_key == "size":
            result.sort(key=lambda d: d.get("size_bytes") or d.get("size_raw") or 0,
                        reverse=self._sort_reverse)
        elif sort_key == "model":
            result.sort(key=lambda d: d.get("model", ""), reverse=self._sort_reverse)
        elif sort_key == "numa":
            result.sort(key=lambda d: d.get("numa_node", d.get("numa", -1)),
                        reverse=self._sort_reverse)
        elif self._sort_reverse:
            result.reverse()

        return result

    def _refresh_table(self) -> None:
        table = self.query_one("#picker-table", DataTable)
        table.clear()

        drives = self._get_filtered_drives()
        for d in drives:
            name = d.get("name", "?")
            mark = "✔" if name in self._selected else " "
            size = _fmt_size(d.get("size_bytes") or d.get("size_raw") or 0)
            model = d.get("model") or "N/A"
            serial = d.get("serial") or "N/A"
            numa = str(d.get("numa_node", d.get("numa", "?")))
            tran = d.get("transport") or "N/A"
            table.add_row(mark, name, size, model, serial, numa, tran, key=name)

        self._update_status()

    def _update_status(self) -> None:
        total = len(self._all_drives)
        filtered = len(self._get_filtered_drives())
        selected = len(self._selected)

        sort_label = self._SORT_LABELS[self._sort_idx]
        sort_dir = " ↓" if self._sort_reverse else " ↑" if self._sort_idx > 0 else ""

        status = f"  {selected}/{total} selected  |  {filtered}/{total} shown  |  Sort: {sort_label}{sort_dir}"
        self.query_one("#picker-status", Static).update(status)

        filters: list[str] = []
        if self._filter_text:
            filters.append(f"text='{self._filter_text}'")
        if self._filter_numa is not None:
            filters.append(f"NUMA={self._filter_numa}")
        if self._filter_size_min:
            filters.append(f"min={_fmt_size(self._filter_size_min)}")
        if self._filter_size_max:
            filters.append(f"max={_fmt_size(self._filter_size_max)}")

        filter_bar = "  Filters: " + ", ".join(filters) if filters else "  Filters: none  (f=text  n=NUMA  s=sort  a=all  Space=toggle  d=detail)"
        self.query_one("#picker-filter-bar", Static).update(filter_bar)

    def _current_drive_name(self) -> str | None:
        """Get the drive name at the current cursor row."""
        table = self.query_one("#picker-table", DataTable)
        try:
            row_key = table.get_row_at(table.cursor_row)
            # row_key is the tuple of cell values; the key is the drive name
            return str(table.get_row_key(table.cursor_row))
        except Exception:
            return None

    def get_row_key(self, table: DataTable) -> str | None:
        """Get the key of the row at cursor."""
        try:
            cursor = table.cursor_row
            keys = list(table.rows.keys())
            if 0 <= cursor < len(keys):
                return str(keys[cursor].value)
        except Exception:
            pass
        return None

    # ── Actions ───────────────────────────────────────────────────────────

    def action_toggle_select(self) -> None:
        table = self.query_one("#picker-table", DataTable)
        name = self.get_row_key(table)
        if not name:
            return
        if name in self._selected:
            self._selected.discard(name)
        else:
            self._selected.add(name)
        self._refresh_table()
        # Re-focus on same row
        try:
            keys = list(table.rows.keys())
            for i, k in enumerate(keys):
                if str(k.value) == name:
                    table.move_cursor(row=i)
                    break
        except Exception:
            pass

    def action_toggle_all(self) -> None:
        drives = self._get_filtered_drives()
        visible_names = {d["name"] for d in drives}
        # If all visible are selected, deselect all visible; otherwise select all visible
        if visible_names <= self._selected:
            self._selected -= visible_names
        else:
            self._selected |= visible_names
        self._refresh_table()

    def action_cycle_sort(self) -> None:
        self._sort_idx = (self._sort_idx + 1) % len(self._SORT_KEYS)
        self._refresh_table()

    def action_reverse_sort(self) -> None:
        self._sort_reverse = not self._sort_reverse
        self._refresh_table()

    @work(exclusive=True)
    async def action_filter_prompt(self) -> None:
        from xinas_menu.widgets.input_dialog import InputDialog
        text = await self.app.push_screen_wait(
            InputDialog(
                "Filter by name/model (empty to clear):",
                "Text Filter",
                default=self._filter_text,
                placeholder="e.g. Samsung, nvme1",
            )
        )
        if text is None:
            return
        self._filter_text = text.strip()
        self._refresh_table()

    @work(exclusive=True)
    async def action_filter_numa(self) -> None:
        from xinas_menu.widgets.input_dialog import InputDialog
        # Detect available NUMA nodes
        numa_nodes = sorted({
            d.get("numa_node", d.get("numa", 0))
            for d in self._all_drives
        })
        current = str(self._filter_numa) if self._filter_numa is not None else ""
        val = await self.app.push_screen_wait(
            InputDialog(
                f"NUMA node filter (available: {', '.join(str(n) for n in numa_nodes)}, empty to clear):",
                "NUMA Filter",
                default=current,
                placeholder="0, 1, ...",
            )
        )
        if val is None:
            return
        val = val.strip()
        if not val:
            self._filter_numa = None
        else:
            try:
                self._filter_numa = int(val)
            except ValueError:
                self.app.notify("Invalid NUMA node number.", severity="error")
                return
        self._refresh_table()

    @work(exclusive=True)
    async def action_show_detail(self) -> None:
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        table = self.query_one("#picker-table", DataTable)
        name = self.get_row_key(table)
        if not name:
            return
        # Find full drive info
        drive = next((d for d in self._all_drives if d.get("name") == name), None)
        if not drive:
            return

        size = drive.get("size_bytes") or drive.get("size_raw") or 0
        lines = [
            f"Name:       {drive.get('name', '?')}",
            f"Size:       {_fmt_size(size)} ({size:,} bytes)",
            f"Model:      {drive.get('model') or 'N/A'}",
            f"Serial:     {drive.get('serial') or 'N/A'}",
            f"Transport:  {drive.get('transport') or 'N/A'}",
            f"NUMA Node:  {drive.get('numa_node', drive.get('numa', '?'))}",
        ]
        if drive.get("raid_name"):
            lines.append(f"RAID:       {drive['raid_name']} ({drive.get('member_state', '?')})")
        if drive.get("system"):
            lines.append("Role:       OS Drive (system)")

        await self.app.push_screen_wait(
            ConfirmDialog("\n".join(lines), f"Drive Detail — {name}")
        )

    def action_confirm(self) -> None:
        if not self._selected:
            self.app.notify("No drives selected.", severity="warning")
            return
        self.dismiss(sorted(self._selected))

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            self.action_confirm()
        else:
            self.action_cancel()
