"""Shared update-apply orchestration for XiNASApp and StartupApp.

Both apps' `_apply_update()` carried an independently maintained copy of this
sequence. Factored here so there is exactly one place implementing
docs/Installer/update-spec.md "Update apply": fetch and checkout, then (if a
rebuild is required) run it and STOP on failure with no refresh and no
restart, then refresh the NFS helper, then restart — a refresh failure is a
partial success (the checkout/rebuild already succeeded) and must not block
the restart.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

from xinas_menu.utils.update_check import (
    CheckResult,
    UpdateChecker,
    build_rebuild_cmd,
    refresh_nfs_helper,
)

if TYPE_CHECKING:
    from textual.notifications import SeverityLevel
    from textual.screen import Screen

    from xinas_menu.utils.audit import AuditLogger


class _UpdateApp(Protocol):
    """The subset of App state apply_update_flow needs from its caller."""

    _update_checker: UpdateChecker
    audit: AuditLogger

    def notify(
        self,
        message: str,
        *,
        severity: SeverityLevel = "information",
        timeout: float | None = None,
    ) -> None: ...

    async def push_screen_wait(self, screen: Screen) -> object: ...


async def apply_update_flow(app: _UpdateApp, result: CheckResult | None) -> None:
    tag = result.latest_version if result else ""
    if not tag:
        app.notify("No release selected to apply.", severity="error")
        return

    loop = asyncio.get_running_loop()
    ok, msg = await loop.run_in_executor(None, app._update_checker.apply_update, tag)
    if not ok:
        app.notify(f"Update failed: {msg}", severity="error")
        return
    app.audit.log("system.update", f"checked out release {tag}")

    rebuilds = result.required_rebuilds if result else ()
    cmd = build_rebuild_cmd(rebuilds)
    if cmd:
        from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

        app.audit.log("system.update", f"rebuild required: {' '.join(cmd)}")
        rc = await app.push_screen_wait(
            PlaybookRunScreen(cmd=cmd, title="Applying update — Ansible rebuild")
        )
        if rc != 0:
            app.notify(
                "Update applied but Ansible failed — not restarting. "
                "Review the log and re-run the role manually.",
                severity="error",
                timeout=15,
            )
            return

    refresh = await loop.run_in_executor(
        None, refresh_nfs_helper, app._update_checker.repo_path, rebuilds
    )
    if not refresh.ok:
        app.audit.log("system.update", f"nfs-helper refresh failed: {refresh.detail}")
        app.notify(
            "Update applied, but the NFS-helper refresh failed — the helper "
            f"may be stale. Run: {refresh.remediation}",
            severity="warning",
            timeout=20,
        )
        # Partial success per update-spec.md outcome (d): checkout (and any
        # rebuild) already succeeded — still restart into the new code.

    app.audit.log("system.update", "complete — restarting")
    app._update_checker.restart_self()
