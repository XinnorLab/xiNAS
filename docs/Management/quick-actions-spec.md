# Quick Actions — Day-2 Screen Specification

`xinas_menu/screens/quick_actions.py` (`QuickActionsScreen`). Reached from the
main menu; five actions plus Back.

| Key | Action | Behavior |
|---|---|---|
| 1 | Restart NFS Server | Confirm dialog, then `service_restart("nfs-server")` in an executor thread. Audits `service.restart`. |
| 2 | View System Logs | Recent `journalctl` entries rendered into the content pane. |
| 3 | Service Status | Per-unit active state for the xiNAS units. The xiRAID exporter unit name is resolved at call time — see [xiraid-exporter-spec.md](xiraid-exporter-spec.md). |
| 4 | System Monitor (btop) | Launches btop full-screen. See below. |
| 5 | View Audit Log | Merged local + control-path trail — see [audit-log-spec.md](audit-log-spec.md). |

## Launching a full-screen child program (btop)

btop takes over the terminal: alternate screen buffer, raw input, its own
signal handling. Textual owns those same resources, so the child **must** be
run inside `App.suspend()`, which stops the driver, restores the terminal, and
re-enters cleanly when the child exits.

Contract:

1. Probe with `shutil.which("btop")` — no subprocess. If absent, render the
   install hint and return without suspending.
2. Run btop **synchronously inside `with self.app.suspend():`**. Blocking the
   event loop is correct here; a suspended app is not rendering. Launching it
   in an executor thread while the app keeps running is what corrupts the
   terminal — the two programs interleave output on one tty and btop's exit
   restores a terminal state Textual is not expecting.
3. `App.suspend()` raises `SuspendNotSupported` on a driver that cannot
   suspend (headless). Catch it and tell the operator, rather than letting the
   worker die with a traceback behind the UI.
4. A non-zero btop exit is not an error worth a dialog — the operator quit it.
