"""Subprocess helpers: run_cmd (sync) and run_cmd_stream (async generator)."""
from __future__ import annotations

import asyncio
import subprocess
from typing import AsyncIterator


def run_cmd(
    *args: str,
    input: str | None = None,
    timeout: int = 30,
) -> tuple[bool, str, str]:
    """Run a command synchronously.

    Returns:
        (ok, stdout, stderr)
    """
    try:
        r = subprocess.run(
            list(args),
            input=input,
            stdin=subprocess.DEVNULL if input is None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return r.returncode == 0, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return False, "", "command timed out"
    except FileNotFoundError:
        return False, "", f"command not found: {args[0]}"
    except Exception as exc:
        return False, "", str(exc)


async def run_cmd_stream(
    *args: str,
    env: dict[str, str] | None = None,
) -> AsyncIterator[str]:
    """Run a command asynchronously, yielding stdout lines as they arrive.

    Merges stderr into stdout.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    assert proc.stdout is not None
    async for raw in proc.stdout:
        yield raw.decode(errors="replace").rstrip()
    await proc.wait()
