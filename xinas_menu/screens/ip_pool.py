"""IPPoolScreen — IP Pool configuration for high-speed interfaces.

S8/ADR-0010 control-path retarget: this screen no longer detects
interfaces, allocates IPs, renders netplan, flushes PBR, or runs
``netplan apply`` itself. The agent owns all of that through
``net.pool.apply`` (ADR-0008): the screen collects the pool inputs
(``start`` + ``prefix`` + optional ``mtu``), previews via a plan, and
applies via ``POST /api/v1/network/ip-pool`` plan/apply. The local
``/etc/xinas/network-pool.json`` is kept ONLY as a prefill cache for the
input dialogs (the API contract has no end bound and no persisted pool).
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.api.control_client import ControlPathError, PlanBlocked, TaskCancelled
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.task_wait_dialog import TaskWaitDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_RED = "\033[31m"
_GRN = "\033[32m"
_YLW = "\033[33m"
_CYN = "\033[36m"
_BLD = "\033[1m"
_DIM = "\033[2m"
_NC = "\033[0m"

_CFG_PATH = Path("/etc/xinas/network-pool.json")
_POOL_PATH = "/api/v1/network/ip-pool"

# Prefill defaults (no `pool_end` — net.pool.apply derives the range from
# start + prefix + the live interface count).
_DEFAULTS = {
    "pool_start": "10.10.1.1",
    "pool_prefix": 24,
    "pool_mtu": "",  # optional; blank → omit from the spec
}

_MENU = [
    MenuItem("1", "Configure Pool"),
    MenuItem("2", "Preview Allocation"),
    MenuItem("3", "Apply Configuration"),
    MenuItem("4", "Show Current Settings"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]


# ── Config prefill cache ──────────────────────────────────────────────────────


def _cfg_read() -> dict:
    """Read the prefill cache, returning defaults if missing."""
    try:
        data = json.loads(_CFG_PATH.read_text())
        merged = dict(_DEFAULTS)
        merged.update(data)
        merged.pop("pool_end", None)  # migrate away the removed field
        return merged
    except Exception:
        return dict(_DEFAULTS)


def _cfg_write(cfg: dict) -> None:
    """Atomic write of the prefill cache with 0600 permissions."""
    cfg = {k: v for k, v in cfg.items() if k != "pool_end"}
    _CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(_CFG_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, str(_CFG_PATH))
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ── Validation (matches the server's validatePool) ────────────────────────────


def _validate_ipv4(ip: str) -> str | None:
    """Return error message or None if valid IPv4."""
    try:
        ipaddress.IPv4Address(ip)
        return None
    except Exception:
        return f"Invalid IPv4 address: {ip}"


def _validate_prefix(prefix_str: str) -> tuple[int | None, str | None]:
    """Return (prefix_int, error). Server bound is [8, 30] (ADR-0008)."""
    try:
        p = int(prefix_str)
    except ValueError:
        return None, f"Invalid prefix: {prefix_str}"
    if not 8 <= p <= 30:
        return None, "Prefix must be between 8 and 30"
    return p, None


def _validate_mtu(mtu_str: str) -> tuple[int | None, str | None]:
    """Return (mtu_or_None, error). Empty → (None, None) [optional].
    Server bound is [1280, 65520]."""
    s = mtu_str.strip()
    if not s:
        return None, None
    try:
        m = int(s)
    except ValueError:
        return None, f"Invalid MTU: {mtu_str}"
    if not 1280 <= m <= 65520:
        return None, "MTU must be between 1280 and 65520"
    return m, None


def _pool_spec(start: str, prefix: int, mtu: int | None = None) -> dict[str, Any]:
    """Build the net.pool.apply spec (ADR-0008): {start, prefix, mtu?}."""
    spec: dict[str, Any] = {"start": start, "prefix": prefix}
    if mtu is not None:
        spec["mtu"] = mtu
    return spec


def _cleanup_repairable(blockers: list[dict[str, Any]]) -> list[str]:
    """Blocker messages when EVERY blocker is a duplicate-netplan one — the
    only case a ``cleanup: true`` re-plan can fix (mirrors network.py)."""
    if blockers and all(str(b.get("code")) == "duplicate_netplan_definition" for b in blockers):
        return [str(b.get("message", b.get("code", "?"))) for b in blockers]
    return []


def apply_pool(
    control,
    spec: dict[str, Any],
    *,
    on_progress=None,
    cancel_check=None,
    confirm_cleanup=None,
) -> dict[str, Any]:
    """plan/apply the pool spec through the control API, mirroring network.py's
    duplicate-netplan ``cleanup: true`` retry.

    ``confirm_cleanup(messages)`` is called when the plan is blocked ONLY by
    duplicate-netplan definitions; returning truthy re-applies with
    ``cleanup: True``. Raises PlanBlocked for any other blocker mix,
    TaskCancelled if the wait is cancelled, ApiError/TransportError on
    transport failure. Returns the terminal task result.
    """
    try:
        return control.plan_apply_wait(
            "POST", _POOL_PATH, spec, on_progress=on_progress, cancel_check=cancel_check
        )
    except PlanBlocked as exc:
        dup_msgs = _cleanup_repairable(exc.blockers)
        if not dup_msgs or confirm_cleanup is None or not confirm_cleanup(dup_msgs):
            raise
        return control.plan_apply_wait(
            "POST",
            _POOL_PATH,
            {**spec, "cleanup": True},
            on_progress=on_progress,
            cancel_check=cancel_check,
        )


# ── Screen ────────────────────────────────────────────────────────────────────


class IPPoolScreen(XiNASAppMixin, Screen):
    """IP Pool configuration over the control-path API (net.pool.apply)."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  IP Pool Configuration", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="pool-nav")
            yield ScrollableTextView(
                f"{_BLD}{_CYN}IP Pool Configuration{_NC}\n"
                "\n"
                f"  {_BLD}1{_NC}  {_CYN}Configure Pool{_NC}      {_DIM}Set base IP, prefix, MTU{_NC}\n"
                f"  {_BLD}2{_NC}  {_CYN}Preview Allocation{_NC}  {_DIM}Plan the per-interface assignment{_NC}\n"
                f"  {_BLD}3{_NC}  {_CYN}Apply Configuration{_NC} {_DIM}Reallocate via the control API{_NC}\n"
                f"  {_BLD}4{_NC}  {_CYN}Show Current Settings{_NC} {_DIM}View observed interface addresses{_NC}\n",
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

    async def _prompt_pool_inputs(self) -> dict | None:
        """Collect start + prefix + optional MTU (prefilled). None on cancel."""
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)

        while True:
            start = await self.app.push_screen_wait(
                InputDialog(
                    "Pool base IP address:",
                    "Configure IP Pool",
                    default=cfg["pool_start"],
                    placeholder="10.10.1.1",
                )
            )
            if start is None:
                return None
            err = _validate_ipv4(start)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        while True:
            prefix_str = await self.app.push_screen_wait(
                InputDialog(
                    "Subnet prefix (CIDR, 8–30):",
                    "Configure IP Pool",
                    default=str(cfg["pool_prefix"]),
                    placeholder="24",
                )
            )
            if prefix_str is None:
                return None
            prefix, err = _validate_prefix(prefix_str)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        while True:
            mtu_str = await self.app.push_screen_wait(
                InputDialog(
                    "MTU (optional, 1280–65520; blank to leave unchanged):",
                    "Configure IP Pool",
                    default=str(cfg.get("pool_mtu", "")),
                    placeholder="9000",
                )
            )
            if mtu_str is None:
                return None
            mtu, err = _validate_mtu(mtu_str)
            if err:
                self.app.notify(err, severity="error")
                continue
            break

        cfg["pool_start"] = start
        cfg["pool_prefix"] = prefix
        cfg["pool_mtu"] = "" if mtu is None else str(mtu)
        with contextlib.suppress(Exception):
            await loop.run_in_executor(None, _cfg_write, cfg)
        return {"start": start, "prefix": prefix, "mtu": mtu}

    @work(exclusive=True)
    async def _configure_pool(self) -> None:
        inputs = await self._prompt_pool_inputs()
        if inputs is None:
            return
        view = self.query_one("#pool-content", ScrollableTextView)
        mtu_line = f"\n  MTU:    {inputs['mtu']}" if inputs["mtu"] is not None else ""
        view.set_content(
            "Pool inputs saved.\n\n"
            f"  Base:   {inputs['start']}\n"
            f"  Prefix: /{inputs['prefix']}"
            f"{mtu_line}\n\n"
            "Use [bold]Preview[/bold] to plan the allocation, then [bold]Apply[/bold]."
        )

    @work(exclusive=True)
    async def _preview_allocation(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        inputs = await self._prompt_pool_inputs()
        if inputs is None:
            return
        spec = _pool_spec(inputs["start"], inputs["prefix"], inputs["mtu"])
        view.set_content(f"{_DIM}Planning allocation…{_NC}")
        try:
            result = await asyncio.to_thread(self.app.control.plan, "POST", _POOL_PATH, spec)
        except PlanBlocked as exc:
            view.set_content(
                f"{_RED}Plan blocked:{_NC}\n\n"
                + "\n".join(f"  - {b.get('message', b.get('code'))}" for b in exc.blockers)
            )
            return
        except ControlPathError as exc:
            view.set_content(f"{_RED}Preview failed.{_NC}\n\n  {exc}")
            return

        diff = result.get("diff") if isinstance(result, dict) else None
        lines = [
            f"{_BLD}{_CYN}IP POOL ALLOCATION PREVIEW{_NC}",
            f"{_DIM}{'=' * 68}{_NC}",
            "",
            f"  {_DIM}Base:{_NC}   {inputs['start']}",
            f"  {_DIM}Prefix:{_NC} /{inputs['prefix']}",
        ]
        if inputs["mtu"] is not None:
            lines.append(f"  {_DIM}MTU:{_NC}    {inputs['mtu']}")
        lines.append("")
        lines.append(f"{_DIM}{'-' * 68}{_NC}")
        lines.append("")
        lines.append(json.dumps(diff, indent=2) if diff is not None else "  (no diff returned)")
        lines.append("")
        lines.append(f"{_DIM}{'=' * 68}{_NC}")
        lines.append(f"  Use {_BLD}[3] Apply Configuration{_NC} to activate.")
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _apply_configuration(self) -> None:
        inputs = await self._prompt_pool_inputs()
        if inputs is None:
            return
        spec = _pool_spec(inputs["start"], inputs["prefix"], inputs["mtu"])

        mtu_line = f"\n  MTU:    {inputs['mtu']}" if inputs["mtu"] is not None else ""
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Apply IP Pool configuration?\n\n"
                f"  Base:   {inputs['start']}\n"
                f"  Prefix: /{inputs['prefix']}"
                f"{mtu_line}\n\n"
                "The agent re-addresses every high-speed interface (flushing\n"
                "stale IPs/PBR and running netplan apply). Active connections\n"
                "may be briefly interrupted.",
                "Apply Network Configuration",
            )
        )
        if not confirmed:
            return

        # Attempt 1. The duplicate-netplan cleanup retry mirrors network.py:
        # only when EVERY blocker is a duplicate definition do we offer the
        # audited cleanup re-apply.
        try:
            await self._plan_apply_with_dialog(spec, "Applying IP pool…")
        except TaskCancelled:
            self.app.notify("IP pool apply cancelled.", severity="warning")
            return
        except PlanBlocked as exc:
            dup = _cleanup_repairable(exc.blockers)
            if not dup:
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Apply blocked.\n{exc}", "Error", ok_only=True)
                )
                return
            retry_ok = await self.app.push_screen_wait(
                ConfirmDialog(
                    "Plan blocked by duplicate netplan definitions:\n\n"
                    + "\n".join(f"  {m}" for m in dup)
                    + "\n\nRemove the duplicate stanza(s) and retry?\n"
                    "(audited netplan repair via the API)",
                    "Duplicate Netplan Definition",
                )
            )
            if not retry_ok:
                return
            try:
                await self._plan_apply_with_dialog(
                    {**spec, "cleanup": True}, "Applying IP pool (cleanup)…"
                )
            except TaskCancelled:
                self.app.notify("IP pool apply cancelled.", severity="warning")
                return
            except ControlPathError as exc2:
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Apply failed.\n{exc2}", "Error", ok_only=True)
                )
                return
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Apply failed.\n{exc}", "Error", ok_only=True)
            )
            return

        self.app.notify("IP pool applied.", severity="information")
        self._show_current_settings()

    async def _plan_apply_with_dialog(self, spec: dict, label: str):
        """One plan/apply attempt behind a cancellable TaskWaitDialog. The
        dialog is dismissed on every exit; PlanBlocked / TaskCancelled /
        ControlPathError propagate to the caller for orchestration."""
        dialog = TaskWaitDialog(label, "Apply IP Pool")
        self.app.push_screen(dialog)
        try:
            return await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                _POOL_PATH,
                spec,
                on_progress=dialog.progress_from_thread(self.app),
                cancel_check=dialog.cancel_requested,
            )
        finally:
            dialog.dismiss(None)

    @work(exclusive=True)
    async def _show_current_settings(self) -> None:
        view = self.query_one("#pool-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)

        lines = [
            f"{_BLD}{_CYN}IP POOL SETTINGS{_NC}",
            f"{_DIM}{'=' * 68}{_NC}",
            "",
            f"  {_DIM}Base (saved):{_NC}   {cfg['pool_start']}",
            f"  {_DIM}Prefix (saved):{_NC} /{cfg['pool_prefix']}",
            f"  {_DIM}MTU (saved):{_NC}    {cfg.get('pool_mtu') or '(unchanged)'}",
            f"  {_DIM}Prefill cache:{_NC}  {_CFG_PATH}",
            "",
            f"{_DIM}{'-' * 68}{_NC}",
            f"  {_BLD}{_CYN}OBSERVED INTERFACE ADDRESSES{_NC}",
            f"{_DIM}{'-' * 68}{_NC}",
            "",
        ]
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/network/interfaces")
        except ControlPathError as exc:
            lines.append(f"  {_RED}Could not read interfaces: {exc}{_NC}")
            view.set_content("\n".join(lines))
            return

        for row in rows or []:
            name = row.get("id") or (row.get("spec") or {}).get("name") or "?"
            status = row.get("status") or {}
            spec = row.get("spec") or {}
            addrs = spec.get("addresses") or status.get("addresses") or []
            state = status.get("operstate") or status.get("state") or "?"
            lines.append(f"  {_BLD}{name}{_NC}  {_DIM}({state}){_NC}")
            lines.append(f"      {_DIM}Addresses:{_NC} {', '.join(addrs) if addrs else '(none)'}")
            lines.append("")

        lines.append(f"{_DIM}{'=' * 68}{_NC}")
        view.set_content("\n".join(lines))
