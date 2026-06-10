"""PlaybookRunScreen — live ansible-playbook output streamer."""
from __future__ import annotations

import asyncio
import contextlib
import datetime
import os
import re
import shlex
import time
from pathlib import Path

from rich.markup import escape as _rich_escape
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.screen import Screen
from textual.widgets import Button, Label, RichLog

_INSTALL_LOG_PRIMARY = "/var/log/xinas/install.log"
_INSTALL_LOG_FALLBACK = "/tmp/xinas-install.log"


def _open_install_log(cmd: list[str], workdir: str):
    """Open the install-log file in append mode. Try primary, fall back to /tmp.

    Returns (file_handle, path_used) or (None, None) if both paths fail.
    """
    for path in (_INSTALL_LOG_PRIMARY, _INSTALL_LOG_FALLBACK):
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, mode=0o755, exist_ok=True)
            # The handle is intentionally long-lived: it is returned to the
            # caller, written to for the duration of the playbook run, and
            # closed in _run_playbook's finally block.
            fh = open(path, "ab")  # noqa: SIM115
            header = (
                f"\n=== {datetime.datetime.now().isoformat(timespec='seconds')} "
                f"| argv: {shlex.join(cmd)} | cwd: {workdir} ===\n"
            )
            fh.write(header.encode())
            fh.flush()
            return fh, path
        except OSError:
            continue
    return None, None


_SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
_STALL_THRESHOLD_SEC = 30

_TASK_RE = re.compile(r"^\s*TASK \[(.+?)\]\s*\*+\s*$")
_PLAY_RE = re.compile(r"^\s*PLAY \[(.+?)\]\s*\*+\s*$")


class _PlaybookStatusBar(Label):
    """Single-line live status: spinner + current task + elapsed timer.

    States: 'running' (animated spinner), 'success' (green ✓), 'failure' (red ✗).
    """

    def __init__(self, **kwargs) -> None:
        super().__init__("", id="pb-statusbar", **kwargs)
        self._frame = 0
        self._task_name = "Starting…"
        self._started_at: float = 0.0
        self._state = "running"  # 'running' | 'success' | 'failure'
        self._spin_timer = None
        self._tick_timer = None
        self._task_seen: bool = False
        self._task_set_at: float = 0.0

    def on_mount(self) -> None:
        self._started_at = time.monotonic()
        self._task_set_at = self._started_at
        self._spin_timer = self.set_interval(0.1, self._advance_spinner)
        self._tick_timer = self.set_interval(1.0, self._refresh)
        self._refresh()

    def set_task(self, name: str) -> None:
        self._task_name = name
        self._task_seen = True
        self._task_set_at = time.monotonic()
        self._refresh()

    def mark_success(self) -> None:
        self._state = "success"
        self._stop_timers()
        self._refresh()

    def mark_failure(self, task_name: str | None = None) -> None:
        self._state = "failure"
        if task_name:
            self._task_name = task_name
        self._stop_timers()
        self._refresh()

    def _stop_timers(self) -> None:
        if self._spin_timer is not None:
            self._spin_timer.stop()
            self._spin_timer = None
        if self._tick_timer is not None:
            self._tick_timer.stop()
            self._tick_timer = None

    def _advance_spinner(self) -> None:
        self._frame = (self._frame + 1) % len(_SPINNER_FRAMES)
        self._refresh()

    def _refresh(self) -> None:
        elapsed = max(0, int(time.monotonic() - self._started_at))
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        clock = f"{h:02d}:{m:02d}:{s:02d}"
        stall_suffix = ""
        if self._state == "running":
            stall = time.monotonic() - self._task_set_at
            if stall > _STALL_THRESHOLD_SEC:
                stall_suffix = "  [dim]· still running[/dim]"
        if self._state == "success":
            self.update(f"  [green]✓[/green]  Completed                              {clock}")
        elif self._state == "failure":
            self.update(f"  [red]✗[/red]  FAILED: TASK [{_rich_escape(self._task_name)}]    {clock}")
        else:
            spin = _SPINNER_FRAMES[self._frame]
            label = "Starting…" if not self._task_seen else f"TASK [{_rich_escape(self._task_name)}]"
            self.update(f"  [cyan]{spin}[/cyan]  {label}{stall_suffix}    {clock}")


class PlaybookRunScreen(Screen[int]):
    """Streams ansible-playbook output in real-time.

    Returns the playbook exit code when closed.
    """

    BINDINGS = [
        Binding("escape", "dismiss_zero", "Close (when done)", show=True),
        Binding("l", "toggle_log", "Toggle Log", show=True),
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
        self._current_task: str = ""
        self._current_play: str = ""
        self._failure_seen: bool = False
        self._run_task: asyncio.Task | None = None

    def compose(self) -> ComposeResult:
        yield Label(f"  ── {self._title} ──", id="pb-title")
        yield Label(f"  $ {' '.join(self._cmd)}", id="pb-cmd")
        with Container(id="pb-log-panel"):
            yield RichLog(highlight=True, markup=True, id="playbook-log")
        yield _PlaybookStatusBar()
        yield Button("View Log", id="pb-toggle-log")
        yield Button("Close [Esc]", id="pb-close", disabled=True)

    async def on_mount(self) -> None:
        self._running = True
        self._run_task = asyncio.create_task(self._run_playbook())

    def _parse_status_line(self, line: str) -> None:
        """Inspect a stdout line and update the StatusBar if it's a PLAY/TASK header."""
        m = _TASK_RE.match(line)
        if m:
            self._current_task = m.group(1).strip()
            self.query_one(_PlaybookStatusBar).set_task(self._current_task)
            return
        m = _PLAY_RE.match(line)
        if m:
            self._current_play = m.group(1).strip()
            return
        is_failure_line = (
            line.startswith("fatal:")
            or line.startswith("failed:")
            or line.startswith("unreachable:")
            or "ERROR!" in line
        )
        if is_failure_line and not self._failure_seen:
            self._failure_seen = True
            self._auto_expand_log_on_failure()

    async def _run_playbook(self) -> None:
        log = self.query_one("#playbook-log", RichLog)
        close_btn = self.query_one("#pb-close", Button)

        env = os.environ.copy()
        env.setdefault("ANSIBLE_FORCE_COLOR", "1")
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["ANSIBLE_STDOUT_CALLBACK"] = "default"

        log_fh, log_path = _open_install_log(self._cmd, self._workdir)
        if log_path is None:
            log.write(
                "[yellow]⚠ Could not open install log; "
                "output will not be saved to disk.[/yellow]"
            )
        else:
            log.write(f"[dim]Saving output to {log_path}[/dim]")

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
                if log_fh is not None:
                    try:
                        log_fh.write(raw)
                        log_fh.flush()
                    except OSError:
                        pass
                line = raw.decode(errors="replace").rstrip()
                self._parse_status_line(line)
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
            if log_fh is not None:
                with contextlib.suppress(OSError):
                    log_fh.close()
            self._running = False
            statusbar = self.query_one(_PlaybookStatusBar)
            if self._exit_code == 0:
                statusbar.mark_success()
            else:
                statusbar.mark_failure(task_name=self._current_task or "(unknown)")
                # Ensure the log panel is open even if the failure marker
                # was not in the stream (e.g. process killed externally).
                # If the parser already auto-expanded once, respect any
                # subsequent manual close by the operator.
                if not self._failure_seen:
                    self._auto_expand_log_on_failure()
            close_btn.disabled = False
            self.app.audit.log(
                "playbook.run",
                " ".join(self._cmd[:4]),
                "OK" if self._exit_code == 0 else "FAIL",
            )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "pb-close" and not self._running:
            self.dismiss(self._exit_code)
        elif event.button.id == "pb-toggle-log":
            self.action_toggle_log()

    def action_dismiss_zero(self) -> None:
        if not self._running:
            self.dismiss(self._exit_code)

    def action_toggle_log(self) -> None:
        panel = self.query_one("#pb-log-panel", Container)
        btn = self.query_one("#pb-toggle-log", Button)
        if panel.has_class("visible"):
            panel.remove_class("visible")
            btn.label = "View Log"
        else:
            panel.add_class("visible")
            btn.label = "Hide Log"

    def _auto_expand_log_on_failure(self) -> None:
        """When a failure is first detected, open the log panel so the error is visible."""
        panel = self.query_one("#pb-log-panel", Container)
        btn = self.query_one("#pb-toggle-log", Button)
        if not panel.has_class("visible"):
            panel.add_class("visible")
            btn.label = "Hide Log"


def _find_repo_root() -> str:
    candidates = ["/opt/xiNAS", "/home/xinnor/xiNAS"]
    for c in candidates:
        if Path(c).exists():
            return c
    return "/opt/xiNAS"
