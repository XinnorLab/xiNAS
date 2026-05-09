"""Async subprocess helpers for the client TUI."""
from __future__ import annotations

import asyncio
import subprocess


async def run_cmd(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run a command via executor; returns (returncode, stdout, stderr)."""
    loop = asyncio.get_running_loop()

    def _run() -> tuple[int, str, str]:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr

    return await loop.run_in_executor(None, _run)


async def stream_cmd(
    cmd: list[str],
    log_widget,
    cwd: str | None = None,
) -> int:
    """Stream command output to a RichLog/ScrollableTextView widget.

    Returns the process exit code.
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd,
    )
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode(errors="replace").rstrip()
        log_widget.append(line)
    await proc.wait()
    return proc.returncode or 0
