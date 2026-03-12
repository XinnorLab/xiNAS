"""XiRAIDClient — all xiRAID operations via gRPC.

All public methods are async and return (ok: bool, data: Any, error: str).
They never raise into the UI layer.

gRPC stubs are generated at deploy time into api/proto/ by the xinas_menu
Ansible role. Until stubs exist, the client returns (False, None, "stubs not
installed") for every call.
"""
from __future__ import annotations

import asyncio
import json
import os
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

_GRPC_ADDRESS = "localhost:6066"
_TLS_FALLBACK_PATHS = [
    "/etc/xiraid/server.crt",
    "/etc/xinas-mcp/server.crt",
]


def _load_channel_credentials():
    """Return grpc.ChannelCredentials or None (insecure fallback)."""
    try:
        import grpc  # noqa: F401
    except ImportError:
        return None

    # Try config.json first
    cfg_path = Path("/etc/xinas-mcp/config.json")
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
            crt_path = cfg.get("tls_cert") or cfg.get("cert_path")
            if crt_path and Path(crt_path).exists():
                import grpc
                creds = grpc.ssl_channel_credentials(
                    root_certificates=Path(crt_path).read_bytes()
                )
                return creds
        except Exception:
            pass

    for path in _TLS_FALLBACK_PATHS:
        p = Path(path)
        if p.exists():
            try:
                import grpc
                return grpc.ssl_channel_credentials(
                    root_certificates=p.read_bytes()
                )
            except Exception:
                pass

    # Dev fallback: insecure channel
    warnings.warn(
        "xiRAID TLS cert not found — using insecure gRPC channel (dev mode)",
        stacklevel=2,
    )
    return None


_STUBS_ERROR: str = ""


def _import_stubs():
    """Return (pb2, pb2_grpc, grpc) or (None, None, None) on failure."""
    global _STUBS_ERROR
    try:
        import grpc
        from xinas_menu.api.proto import (  # noqa: F401 — generated at deploy time
            service_xraid_pb2 as pb2,
            service_xraid_pb2_grpc as pb2_grpc,
        )
        return pb2, pb2_grpc, grpc
    except Exception as exc:
        _STUBS_ERROR = str(exc)
        return None, None, None


def _no_stubs_error() -> tuple:
    detail = f": {_STUBS_ERROR}" if _STUBS_ERROR else ""
    return (False, None, f"gRPC stubs not available{detail}")


class XiRAIDClient:
    """Async-friendly gRPC client for xiRAID.

    Uses a thread-pool executor so synchronous gRPC calls don't block the
    Textual event loop.
    """

    def __init__(self, address: str = _GRPC_ADDRESS) -> None:
        self._address = address
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="grpc")
        self._channel = None
        self._stub = None

    def _ensure_channel(self):
        if self._stub is not None:
            return True
        pb2, pb2_grpc, grpc = _import_stubs()
        if pb2 is None:
            return False
        creds = _load_channel_credentials()
        if creds is not None:
            self._channel = grpc.secure_channel(self._address, creds)
        else:
            self._channel = grpc.insecure_channel(self._address)
        self._stub = pb2_grpc.XiRAIDServiceStub(self._channel)
        return True

    async def _call(self, method_name: str, request, timeout: int = 10) -> tuple[bool, Any, str]:
        loop = asyncio.get_event_loop()
        try:
            if not self._ensure_channel():
                return _no_stubs_error()
            stub = self._stub

            def _sync():
                method = getattr(stub, method_name)
                return method(request, timeout=timeout)

            resp = await loop.run_in_executor(self._executor, _sync)
            return True, resp, ""
        except Exception as exc:
            return False, None, str(exc)

    # ── RAID ────────────────────────────────────────────────────────────────

    async def raid_list(self) -> tuple[bool, Any, str]:
        """List all RAID arrays."""
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidList", pb2.RaidListRequest())

    async def raid_show(self, units: str = "g") -> tuple[bool, Any, str]:
        """Show RAID details (capacity in given units)."""
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidShow", pb2.RaidShowRequest(units=units))

    async def raid_get(self, raid_id: str) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidGet", pb2.RaidGetRequest(raid_id=raid_id))

    async def raid_create(self, **kwargs) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidCreate", pb2.RaidCreateRequest(**kwargs))

    async def raid_delete(self, raid_id: str, force: bool = False) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidDelete", pb2.RaidDeleteRequest(
            raid_id=raid_id, force=force))

    async def raid_lifecycle_control(self, raid_id: str, action: str) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("RaidLifecycleControl", pb2.RaidLifecycleControlRequest(
            raid_id=raid_id, action=action))

    # ── Drives ─────────────────────────────────────────────────────────────

    async def disk_list(self) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("DiskList", pb2.DiskListRequest())

    async def disk_get_smart(self, disk_id: str) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("DiskGetSmart", pb2.DiskGetSmartRequest(disk_id=disk_id))

    # ── Pools ──────────────────────────────────────────────────────────────

    async def pool_list(self) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("PoolList", pb2.PoolListRequest())

    # ── System / License ───────────────────────────────────────────────────

    async def get_server_info(self) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("GetServerInfo", pb2.GetServerInfoRequest())

    async def get_license_info(self) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("GetLicenseInfo", pb2.GetLicenseInfoRequest())

    async def set_license(self, key: str) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("SetLicense", pb2.SetLicenseRequest(key=key))

    async def get_performance(self) -> tuple[bool, Any, str]:
        pb2, _, _ = _import_stubs()
        if pb2 is None:
            return _no_stubs_error()
        return await self._call("GetPerformance", pb2.GetPerformanceRequest())

    def close(self) -> None:
        if self._channel is not None:
            self._channel.close()
        self._executor.shutdown(wait=False)
