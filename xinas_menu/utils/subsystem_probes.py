"""Shared subsystem health probes.

Used by both the splash screen (full status lines) and the main menu
(banner shown only when something is wrong).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass
class ProbeResult:
    name: str
    ok: bool
    detail: str  # connected message on ok; error string on failure


async def probe_grpc(grpc_client, timeout: float = 5.0) -> ProbeResult:
    try:
        ok, _data, err = await asyncio.wait_for(
            grpc_client.get_server_info(), timeout=timeout,
        )
    except asyncio.TimeoutError:
        return ProbeResult("xiRAID gRPC", False, "timed out")
    except Exception as exc:
        return ProbeResult("xiRAID gRPC", False, str(exc))
    if ok:
        return ProbeResult("xiRAID gRPC", True, "connected")
    return ProbeResult("xiRAID gRPC", False, err or "unavailable")


async def probe_nfs_helper(nfs_client) -> ProbeResult:
    loop = asyncio.get_running_loop()
    try:
        ok, _data, err = await loop.run_in_executor(None, nfs_client.list_exports)
    except Exception as exc:
        return ProbeResult("NFS helper", False, str(exc))
    if ok:
        return ProbeResult("NFS helper", True, "connected")
    return ProbeResult("NFS helper", False, err or "unavailable")


async def probe_all(grpc_client, nfs_client) -> list[ProbeResult]:
    """Run all subsystem probes in parallel."""
    return list(await asyncio.gather(
        probe_grpc(grpc_client),
        probe_nfs_helper(nfs_client),
    ))
