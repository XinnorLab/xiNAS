"""PlaybookRunScreen — live ansible-playbook output streamer."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Sequence

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Label, RichLog


class PlaybookRunScreen(Screen[int]):
    """Streams ansible-playbook output in real-time.

    Returns the playbook exit code when closed.
    """

    BINDINGS = [
        Binding("escape", "dismiss_zero", "Close (when done)", show=True),
    ]

    def __init__(
        self,
        cmd: list[str],
        title: str = "Running Ansible Playbook",
        workdir: str | Path | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._cmd = cmd
        self._title = title
        self._workdir = str(workdir) if workdir else _find_repo_root()
        self._exit_code: int = -1
        self._running = False

    def compose(self) -> ComposeResult:
        yield Label(f"  ── {self._title} ──", id="pb-title")
        yield Label(f"  $ {' '.join(self._cmd)}", id="pb-cmd")
        yield RichLog(highlight=True, markup=True, id="playbook-log")
        yield Label("  Running…", id="pb-status")
        yield Button("Close [Esc]", id="pb-close", disabled=True)

    async def on_mount(self) -> None:
        self._running = True
        asyncio.create_task(self._run_playbook())

    async def _run_playbook(self) -> None:
        log = self.query_one("#playbook-log", RichLog)
        status = self.query_one("#pb-status", Label)
        close_btn = self.query_one("#pb-close", Button)

        env = os.environ.copy()
        env.setdefault("ANSIBLE_FORCE_COLOR", "1")
        env.setdefault("PYTHONUNBUFFERED", "1")

        try:
            proc = await asyncio.create_subprocess_exec(
                *self._cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=self._workdir,
                env=env,
            )
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode(errors="replace").rstrip()
                # Color-code Ansible output
                if "PLAY RECAP" in line or "ok=" in line:
                    log.write(f"[bold]{line}[/bold]")
                elif "FAILED" in line or "ERROR" in line or "error" in line.lower():
                    log.write(f"[red]{line}[/red]")
                elif "changed" in line.lower() or "CHANGED" in line:
                    log.write(f"[yellow]{line}[/yellow]")
                elif line.startswith("ok:") or "SUCCESS" in line:
                    log.write(f"[green]{line}[/green]")
                else:
                    log.write(line)
            await proc.wait()
            self._exit_code = proc.returncode
        except Exception as exc:
            log.write(f"[red]Failed to run playbook: {exc}[/red]")
            self._exit_code = 255
        finally:
            self._running = False
            if self._exit_code == 0:
                status.update("  [green]✓ Playbook completed successfully.[/green]")
            else:
                status.update(f"  [red]✗ Playbook failed (exit {self._exit_code}).[/red]")
            close_btn.disabled = False
            self.app.audit.log(
                "playbook.run",
                " ".join(self._cmd[:4]),
                "OK" if self._exit_code == 0 else "FAIL",
            )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "pb-close" and not self._running:
            self.dismiss(self._exit_code)

    def action_dismiss_zero(self) -> None:
        if not self._running:
            self.dismiss(self._exit_code)


def _find_repo_root() -> str:
    candidates = ["/opt/xiNAS", "/home/xinnor/xiNAS"]
    for c in candidates:
        if Path(c).exists():
            return c
    return "/opt/xiNAS"
