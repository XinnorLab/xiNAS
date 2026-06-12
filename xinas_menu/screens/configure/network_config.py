"""NetworkConfigScreen — netplan editor over the control-path API.

Formerly this screen wrote /etc/netplan/*.yaml directly and ran
``netplan apply|try``. Under ADR-0010 the control-path API owns the
canonical netplan render and apply, so the editor now translates the
edited ``network.ethernets`` stanzas into per-interface
``PATCH /api/v1/network/interfaces/{id}`` plan/apply operations
(addresses + MTU). The file itself is never written from the TUI: the
API executor rewrites 99-xinas.yaml (full render), does the surgical
flush, and applies netplan server-side (ADR-0008).

Stanza fields the API derives or owns itself (routes, routing-policy,
dhcp4, gateways, PBR tables) are ignored; non-mlx interfaces are
skipped (only RDMA-capable interfaces are API-managed).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Label, TextArea

from xinas_menu.api.control_client import ControlPathError, PlanBlocked
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog

_NETPLAN_DIR = Path("/etc/netplan")


def _find_netplan_file() -> Path | None:
    xinas_cfg = _NETPLAN_DIR / "99-xinas.yaml"
    if xinas_cfg.exists():
        return xinas_cfg
    files = sorted(_NETPLAN_DIR.glob("*.yaml")) + sorted(_NETPLAN_DIR.glob("*.yml"))
    return files[0] if files else None


class NetworkConfigScreen(XiNASAppMixin, Screen[bool]):
    """Edit netplan YAML; changes apply via the control-path API."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=True)]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._cfg_path = _find_netplan_file()

    def compose(self) -> ComposeResult:
        title = str(self._cfg_path) if self._cfg_path else "(no netplan file found)"
        yield Label(f"  ── Network Config — {title} ──")
        content = ""
        if self._cfg_path and self._cfg_path.exists():
            content = self._cfg_path.read_text()
        yield TextArea(content, id="netplan-editor", language="yaml")
        yield Button("Apply via API", id="btn-save", variant="primary")
        yield Button("Validate Only", id="btn-validate")
        yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            self._apply_via_api()
        elif event.button.id == "btn-validate":
            self._validate()
        else:
            self.dismiss(False)

    def _task_progress(self, label: str):
        """on_progress callback for ``plan_apply_wait`` (worker thread →
        UI-thread toast)."""

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    @work(exclusive=True)
    async def _apply_via_api(self) -> None:
        content = self.query_one("#netplan-editor", TextArea).text
        specs, err = _extract_iface_specs(content)
        if err:
            self.app.notify(f"Validation failed: {err}", severity="error")
            return
        if not specs:
            self.app.notify(
                "No interface stanzas with addresses/mtu found — nothing to apply.",
                severity="warning",
            )
            return

        # Only mlx/RDMA interfaces are API-managed; PATCHing others would
        # 422 (iface_not_managed), so they are skipped up front.
        try:
            rows = await asyncio.to_thread(self.app.control.result, "/api/v1/network/interfaces")
        except ControlPathError as exc:
            self.app.notify(f"Control API: {exc}", severity="error")
            return
        managed: set[str] = set()
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            status = row.get("status") or {}
            if status.get("rdma_capable") is True or "mlx" in str(status.get("driver", "")):
                managed.add(str(row.get("id", "")))

        targets = {name: spec for name, spec in specs.items() if name in managed}
        skipped = sorted(set(specs) - set(targets))
        if not targets:
            self.app.notify(
                "No xiNAS-managed (mlx) interfaces among the edited stanzas; "
                "nothing the API can apply.",
                severity="warning",
            )
            return

        summary_lines = [
            f"  {name}: {', '.join(spec.get('addresses', ['(keep addresses)']))}"
            + (f"  mtu={spec['mtu']}" if "mtu" in spec else "")
            for name, spec in sorted(targets.items())
        ]
        message = (
            "Apply these interface settings via the control-path API?\n\n"
            + "\n".join(summary_lines)
            + ("\n\nSkipped (not API-managed): " + ", ".join(skipped) if skipped else "")
            + "\n\nOnly addresses/MTU are applied; routes, PBR and the netplan\n"
            "file render are owned by the API executor."
        )
        confirmed = await self.app.push_screen_wait(ConfirmDialog(message, "Apply Network Config"))
        if not confirmed:
            return

        applied: list[str] = []
        for name, spec in sorted(targets.items()):
            if not await self._patch_interface(name, spec):
                break
            applied.append(name)
        if not applied:
            return

        self.app.audit.log("network.netplan_save", ", ".join(applied), "OK")
        await self.app.snapshots.record(
            "network_modify",
            diff_summary=f"Applied netplan stanzas via API: {', '.join(applied)}",
        )
        self.dismiss(True)

    async def _patch_interface(self, iface: str, spec: dict[str, Any]) -> bool:
        """plan/apply one PATCH; offer the cleanup re-plan on duplicate
        blockers. Returns ``True`` on success."""
        path = f"/api/v1/network/interfaces/{iface}"
        label = f"Apply {iface}"
        try:
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "PATCH",
                    path,
                    spec,
                    on_progress=self._task_progress(label),
                )
            except PlanBlocked as exc:
                if not _all_duplicate_blockers(exc.blockers):
                    raise
                cleanup = await self.app.push_screen_wait(
                    ConfirmDialog(
                        "Plan blocked by duplicate netplan definitions:\n\n"
                        + "\n".join(
                            f"  {b.get('message', b.get('code', '?'))}" for b in exc.blockers
                        )
                        + "\n\nRemove the duplicate stanza(s) and retry?\n"
                        "(audited netplan repair via the API)",
                        "Duplicate Netplan Definition",
                    )
                )
                if not cleanup:
                    return False
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "PATCH",
                    path,
                    {**spec, "cleanup": True},
                    on_progress=self._task_progress(label),
                )
        except ControlPathError as exc:
            self.app.notify(f"Failed ({iface}): {exc}", severity="error")
            return False
        return True

    @work(exclusive=True)
    async def _validate(self) -> None:
        content = self.query_one("#netplan-editor", TextArea).text
        specs, err = _extract_iface_specs(content)
        if err:
            self.app.notify(f"Validation failed: {err}", severity="error")
        else:
            self.app.notify(
                f"Netplan YAML is valid — {len(specs)} interface stanza(s) with addresses/MTU.",
                severity="information",
            )

    def action_cancel(self) -> None:
        self.dismiss(False)


def _all_duplicate_blockers(blockers: list[dict[str, Any]]) -> bool:
    """True when EVERY blocker is duplicate_netplan_definition — the only
    mix a ``cleanup: true`` re-plan can repair."""
    return bool(blockers) and all(
        str(b.get("code")) == "duplicate_netplan_definition" for b in blockers
    )


def _extract_iface_specs(content: str) -> tuple[dict[str, dict[str, Any]], str]:
    """Parse netplan YAML → {iface: {addresses?, mtu?}} API PATCH specs.

    Returns ``(specs, error)``; ``error`` is non-empty on parse/shape
    failures. Stanza keys outside addresses/mtu are intentionally
    ignored (the API derives routes/PBR itself, ADR-0008).
    """
    import yaml

    try:
        data = yaml.safe_load(content) or {}
    except Exception as exc:
        return {}, f"YAML parse error: {exc}"
    if not isinstance(data, dict):
        return {}, "top level must be a mapping"
    network = data.get("network")
    if not isinstance(network, dict):
        return {}, "missing 'network:' mapping"
    ethernets = network.get("ethernets")
    if ethernets is None:
        return {}, ""
    if not isinstance(ethernets, dict):
        return {}, "'network.ethernets' must be a mapping"

    specs: dict[str, dict[str, Any]] = {}
    for name, stanza in ethernets.items():
        if not isinstance(stanza, dict):
            continue
        spec: dict[str, Any] = {}
        addrs = stanza.get("addresses")
        if isinstance(addrs, list) and addrs and all(isinstance(a, str) for a in addrs):
            spec["addresses"] = addrs
        mtu = stanza.get("mtu")
        if isinstance(mtu, int):
            spec["mtu"] = mtu
        if spec:
            specs[str(name)] = spec
    return specs, ""
