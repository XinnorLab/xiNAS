"""PhysicalDrivesScreen — read-only drive inventory with SMART and LED locate."""
from __future__ import annotations

import logging
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Label, Static
from textual import work

from xinas_menu.widgets.drive_picker import _fmt_size

_log = logging.getLogger(__name__)


class PhysicalDrivesScreen(Screen):
    """Full-featured physical drives browser (read-only).

    Shows all drives in a sortable/filterable DataTable with actions
    for LED locate, SMART summary, and SMART full detail.
    """

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
        Binding("s", "cycle_sort", "Sort", show=True),
        Binding("r", "reverse_sort", "Rev", show=True),
        Binding("f", "filter_prompt", "Filter", show=True),
        Binding("n", "filter_numa", "NUMA", show=True),
        Binding("l", "locate_drive", "Blink LED", show=True),
        Binding("enter", "show_detail", "Detail", show=True),
        Binding("d", "show_detail", "Detail", show=False),
        Binding("m", "smart_summary", "SMART", show=True),
        Binding("shift+m", "smart_full", "SMART Full", show=False),
    ]

    DEFAULT_CSS = """
    PhysicalDrivesScreen {
        layout: vertical;
    }
    #drives-title {
        text-style: bold;
        color: #4d8bff;
        padding: 0 1;
        height: 1;
    }
    #drives-status {
        color: #9aa0b0;
        height: 1;
        padding: 0 1;
    }
    #drives-filter-bar {
        height: 1;
        color: #d0d4e0;
        padding: 0 1;
    }
    #drives-table {
        height: 1fr;
        margin: 0 1;
    }
    """

    _SORT_KEYS = [None, "name", "size", "model", "numa"]
    _SORT_LABELS = ["default", "name", "size", "model", "NUMA"]

    def __init__(self) -> None:
        super().__init__()
        self._all_drives: list[dict[str, Any]] = []
        self._sort_idx = 0
        self._sort_reverse = False
        self._filter_text = ""
        self._filter_numa: int | None = None

    def compose(self) -> ComposeResult:
        yield Label("  Physical Drives", id="drives-title")
        yield Static("  Loading...", id="drives-status")
        yield Static("", id="drives-filter-bar")
        yield DataTable(id="drives-table")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#drives-table", DataTable)
        table.cursor_type = "row"
        table.zebra_stripes = True
        table.add_columns("Name", "Size", "Model", "Serial", "NUMA", "Transport", "Role")
        self._load_drives()

    @work(exclusive=True)
    async def _load_drives(self) -> None:
        """Fetch drive inventory from gRPC and populate the table."""
        ok, data, err = await self.app.grpc.disk_list()
        if not ok:
            self.query_one("#drives-status", Static).update(f"  Error: {err}")
            return
        self._all_drives = data if isinstance(data, list) else []
        self._refresh_table()

    # ── Filtering & Sorting ───────────────────────────────────────────────

    def _get_filtered_drives(self) -> list[dict]:
        """Apply current filters and sorting."""
        result = []
        for d in self._all_drives:
            if self._filter_text:
                haystack = (d.get("name", "") + " " + d.get("model", "")).lower()
                if self._filter_text.lower() not in haystack:
                    continue
            if self._filter_numa is not None:
                numa = d.get("numa_node", d.get("numa", -1))
                if numa != self._filter_numa:
                    continue
            result.append(d)

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
        table = self.query_one("#drives-table", DataTable)
        table.clear()

        drives = self._get_filtered_drives()
        for d in drives:
            name = d.get("name", "?")
            size = _fmt_size(d.get("size_bytes") or d.get("size_raw") or 0)
            model = d.get("model") or "N/A"
            serial = d.get("serial") or "N/A"
            numa = str(d.get("numa_node", d.get("numa", "?")))
            tran = d.get("transport") or "N/A"
            role = self._drive_role(d)
            table.add_row(name, size, model, serial, numa, tran, role, key=name)

        self._update_status()

    @staticmethod
    def _drive_role(d: dict) -> str:
        """Determine drive role string."""
        name = d.get("name", "")
        if d.get("system"):
            return "OS Drive"
        # xiRAID virtual block devices (e.g. xi_data, xi_log)
        if name.startswith("xi_"):
            return "xiRAID Array"
        raid = d.get("raid_name", "")
        if raid:
            state = d.get("member_state", "?")
            return f"RAID: {raid} ({state})"
        return "Available"

    def _update_status(self) -> None:
        total = len(self._all_drives)
        filtered = len(self._get_filtered_drives())

        sort_label = self._SORT_LABELS[self._sort_idx]
        sort_dir = " ↓" if self._sort_reverse else " ↑" if self._sort_idx > 0 else ""

        status = f"  {filtered}/{total} drives shown  |  Sort: {sort_label}{sort_dir}"
        self.query_one("#drives-status", Static).update(status)

        filters: list[str] = []
        if self._filter_text:
            filters.append(f"text='{self._filter_text}'")
        if self._filter_numa is not None:
            filters.append(f"NUMA={self._filter_numa}")

        hint = "  f=filter  n=NUMA  s=sort  r=reverse  l=LED  m=SMART  Enter=detail"
        filter_bar = ("  Filters: " + ", ".join(filters) + "  |" + hint) if filters else hint
        self.query_one("#drives-filter-bar", Static).update(filter_bar)

    def _get_current_drive(self) -> dict | None:
        """Get drive dict at the current cursor row."""
        table = self.query_one("#drives-table", DataTable)
        try:
            cursor = table.cursor_row
            keys = list(table.rows.keys())
            if 0 <= cursor < len(keys):
                name = str(keys[cursor].value)
                return next((d for d in self._all_drives if d.get("name") == name), None)
        except Exception:
            _log.debug("Could not get current drive", exc_info=True)
        return None

    # ── Sort/Filter Actions ───────────────────────────────────────────────

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
        from xinas_menu.widgets.select_dialog import SelectDialog
        numa_nodes = sorted({
            d.get("numa_node", d.get("numa", 0))
            for d in self._all_drives
        })
        _CLEAR = "(clear filter)"
        choices = [_CLEAR] + [str(n) for n in numa_nodes]
        val = await self.app.push_screen_wait(
            SelectDialog(choices, title="NUMA Filter",
                         prompt="Select NUMA node to filter by:")
        )
        if val is None:
            return
        if val == _CLEAR:
            self._filter_numa = None
        else:
            self._filter_numa = int(val)
        self._refresh_table()

    # ── Drive Actions ─────────────────────────────────────────────────────

    @work(exclusive=True)
    async def action_show_detail(self) -> None:
        """Show full detail for the drive under cursor."""
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        drive = self._get_current_drive()
        if not drive:
            return

        name = drive.get("name", "?")
        size = drive.get("size_bytes") or drive.get("size_raw") or 0
        lines = [
            f"Name:       {name}",
            f"Size:       {_fmt_size(size)} ({size:,} bytes)",
            f"Model:      {drive.get('model') or 'N/A'}",
            f"Serial:     {drive.get('serial') or 'N/A'}",
            f"Transport:  {drive.get('transport') or 'N/A'}",
            f"NUMA Node:  {drive.get('numa_node', drive.get('numa', '?'))}",
            f"Role:       {self._drive_role(drive)}",
        ]
        if drive.get("raid_name"):
            lines.append(f"RAID:       {drive['raid_name']} ({drive.get('member_state', '?')})")

        await self.app.push_screen_wait(
            ConfirmDialog("\n".join(lines), f"Drive Detail — {name}")
        )

    @work(exclusive=True)
    async def action_locate_drive(self) -> None:
        """Blink the LED on the drive under cursor."""
        drive = self._get_current_drive()
        if not drive:
            return
        name = drive.get("name", "")
        if not name:
            return

        self.app.notify(f"Blinking LED on {name}...", severity="information", timeout=3)
        ok, _, err = await self.app.grpc.drive_locate([name])
        if ok:
            self.app.audit.log("drive.locate", name, "OK")
            self.app.notify(f"LED locate started for {name}", severity="information")
        else:
            from xinas_menu.utils.formatting import grpc_short_error
            self.app.notify(f"Locate failed: {grpc_short_error(err)}", severity="error")

    @work(exclusive=True)
    async def action_smart_summary(self) -> None:
        """Show SMART summary (temperature, wear, critical) for the drive under cursor."""
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        drive = self._get_current_drive()
        if not drive:
            return

        name = drive.get("name", "")
        tran = (drive.get("transport") or "").lower()
        if "nvme" not in tran and not name.startswith("nvme"):
            self.app.notify("SMART via nvme-cli is only available for NVMe drives.", severity="warning")
            return

        from xinas_menu.utils.nvme_smart import smart_summary
        self.app.notify(f"Reading SMART for {name}...", severity="information", timeout=2)
        result = await smart_summary(name)
        if not result.get("ok"):
            await self.app.push_screen_wait(
                ConfirmDialog(f"SMART read failed:\n{result.get('error', '?')}", "Error")
            )
            return

        temp = result["temperature"]
        wear = result["wear_level"]
        crit = result["critical_warning"]

        # Color code temperature
        if temp >= 70:
            temp_status = f"🔴 {temp}°C (CRITICAL)"
        elif temp >= 60:
            temp_status = f"🟡 {temp}°C (Warning)"
        else:
            temp_status = f"🟢 {temp}°C"

        # Color code wear
        if wear >= 80:
            wear_status = f"🔴 {wear}% used (END OF LIFE)"
        elif wear >= 50:
            wear_status = f"🟡 {wear}% used"
        else:
            wear_status = f"🟢 {wear}% used"

        # Critical warning
        crit_status = f"🔴 Warning code: {crit}" if crit else "🟢 No warnings"

        lines = [
            f"Temperature:      {temp_status}",
            f"Wear Level:       {wear_status}",
            f"Critical Warning: {crit_status}",
        ]
        await self.app.push_screen_wait(
            ConfirmDialog("\n".join(lines), f"SMART Summary — {name}")
        )

    @work(exclusive=True)
    async def action_smart_full(self) -> None:
        """Show full SMART log for the drive under cursor."""
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        drive = self._get_current_drive()
        if not drive:
            return

        name = drive.get("name", "")
        tran = (drive.get("transport") or "").lower()
        if "nvme" not in tran and not name.startswith("nvme"):
            self.app.notify("SMART via nvme-cli is only available for NVMe drives.", severity="warning")
            return

        from xinas_menu.utils.nvme_smart import smart_full
        self.app.notify(f"Reading full SMART log for {name}...", severity="information", timeout=2)
        result = await smart_full(name)
        if not result.get("ok"):
            await self.app.push_screen_wait(
                ConfirmDialog(f"SMART read failed:\n{result.get('error', '?')}", "Error")
            )
            return

        # Format all key-value pairs
        lines = []
        for key, val in sorted(result.items()):
            if key in ("ok", "error"):
                continue
            lines.append(f"  {key}: {val}")

        await self.app.push_screen_wait(
            ConfirmDialog("\n".join(lines), f"Full SMART Log — {name}")
        )
