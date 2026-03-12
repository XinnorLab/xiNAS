"""XiRAIDClient — all xiRAID operations via gRPC.

All public methods are async and return (ok: bool, data: Any, error: str).
They never raise into the UI layer.

Proto reference (xiNAS-MCP/proto/xraid/gRPC/protobuf/):
  service_xraid.proto   — XRAIDService, all RPCs are snake_case
  message_*.proto       — request message types (NOT in service_xraid_pb2)
  All RPCs return:  ResponseMessage { optional string message = 1; }
  where message is a JSON-encoded string.

gRPC stubs are generated at deploy time into api/proto/ by the xinas_menu
Ansible role. Until stubs exist, every call returns (False, None, "stubs not
installed").
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

_GRPC_ADDRESS = "localhost:6066"
# Cert paths in priority order — must match xiNAS-MCP/src/grpc/client.ts
_TLS_FALLBACK_PATHS = [
    "/etc/xraid/crt/ca-cert.pem",   # primary (matches MCP TS client)
    "/etc/xraid/crt/ca-cert.crt",   # alternate extension
    "/etc/xiraid/server.crt",        # legacy fallback
    "/etc/xinas-mcp/server.crt",
]


def _load_channel_credentials():
    """Return grpc.ChannelCredentials or None (insecure fallback)."""
    try:
        import grpc  # noqa: F401
    except ImportError:
        return None

    cfg_path = Path("/etc/xinas-mcp/config.json")
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
            crt_path = cfg.get("tls_cert") or cfg.get("cert_path")
            if crt_path and Path(crt_path).exists():
                import grpc
                return grpc.ssl_channel_credentials(
                    root_certificates=Path(crt_path).read_bytes()
                )
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

    warnings.warn(
        "xiRAID TLS cert not found — using insecure gRPC channel (dev mode)",
        stacklevel=2,
    )
    return None


_STUBS_ERROR: str = ""


def _import_stubs():
    """Return (pb2_grpc, grpc, msg_raid, msg_drive, msg_pool, msg_license, msg_settings)
    or all-None tuple on failure.

    Request types live in message_*_pb2, NOT in service_xraid_pb2.
    The stub class is XRAIDServiceStub (note: XRAID not XiRAID).
    """
    global _STUBS_ERROR
    try:
        import grpc
        from xinas_menu.api.proto import service_xraid_pb2_grpc as pb2_grpc
        from xinas_menu.api.proto import message_raid_pb2 as msg_raid
        from xinas_menu.api.proto import message_drive_pb2 as msg_drive
        from xinas_menu.api.proto import message_pool_pb2 as msg_pool
        from xinas_menu.api.proto import message_license_pb2 as msg_license
        from xinas_menu.api.proto import message_settings_pb2 as msg_settings
        _STUBS_ERROR = ""
        return pb2_grpc, grpc, msg_raid, msg_drive, msg_pool, msg_license, msg_settings
    except Exception as exc:
        _STUBS_ERROR = str(exc)
        return None, None, None, None, None, None, None


def _no_stubs_error() -> tuple:
    detail = f": {_STUBS_ERROR}" if _STUBS_ERROR else ""
    return (False, None, f"gRPC stubs not available{detail}")


def _parse_response(resp) -> Any:
    """All xiRAID RPCs return ResponseMessage { optional string message = 1; }.
    Parse message as JSON; return raw string if not valid JSON."""
    try:
        raw = getattr(resp, "message", "") or ""
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return getattr(resp, "message", None)


def _collect_disk_info_sync() -> list:
    """Enumerate block drives via lsblk (no gRPC — xiRAID has no disk_list RPC)."""
    try:
        r = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,SIZE,MODEL,SERIAL,TYPE,TRAN"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(r.stdout)
        return [
            {
                "name": d.get("name", ""),
                "size": d.get("size", ""),
                "model": (d.get("model") or "").strip(),
                "serial": (d.get("serial") or "").strip(),
                "transport": d.get("tran") or "",
            }
            for d in data.get("blockdevices", [])
            if d.get("type") == "disk"
        ]
    except Exception:
        # Fallback: scan /sys/class/block for nvme controllers
        disks = []
        try:
            for name in sorted(os.listdir("/sys/class/block")):
                if name.startswith("nvme") and "p" not in name and "n" in name:
                    disks.append({"name": name, "size": "", "model": "", "serial": "", "transport": "nvme"})
        except Exception:
            pass
        return disks


class XiRAIDClient:
    """Async-friendly gRPC client for xiRAID.

    Uses a thread-pool executor so synchronous gRPC calls don't block the
    Textual event loop.

    All RPCs are snake_case (e.g. raid_show, pool_show, license_show).
    Request types come from message_*_pb2 modules (not service_xraid_pb2).
    All responses are ResponseMessage.message parsed as JSON.
    """

    def __init__(self, address: str = _GRPC_ADDRESS) -> None:
        self._address = address
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="grpc")
        self._channel = None
        self._stub = None

    def _ensure_channel(self):
        if self._stub is not None:
            return True
        stubs = _import_stubs()
        pb2_grpc, grpc = stubs[0], stubs[1]
        if pb2_grpc is None:
            return False
        creds = _load_channel_credentials()
        if creds is not None:
            self._channel = grpc.secure_channel(self._address, creds)
        else:
            self._channel = grpc.insecure_channel(self._address)
        # XRAIDServiceStub — note XRAID (not XiRAID)
        self._stub = pb2_grpc.XRAIDServiceStub(self._channel)
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
            data = _parse_response(resp)
            return True, data, ""
        except Exception as exc:
            return False, None, str(exc)

    # ── RAID ────────────────────────────────────────────────────────────────

    async def raid_show(self, units: str = "g", name: str = "",
                        extended: bool = False) -> tuple[bool, Any, str]:
        """Show RAID arrays. Returns parsed JSON list of array dicts."""
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        kwargs: dict = {"units": units}
        if name:
            kwargs["name"] = name
        if extended:
            kwargs["extended"] = extended
        return await self._call("raid_show", msg_raid.RaidShow(**kwargs))

    async def raid_create(self, name: str, level: str, drives: list,
                          **kwargs) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_create", msg_raid.RaidCreate(
            name=name, level=level, drives=drives, **kwargs))

    async def raid_destroy(self, name: str, force: bool = False) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_destroy", msg_raid.RaidDestroy(
            name=name, force=force))

    async def raid_unload(self, name: str) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_unload", msg_raid.RaidUnload(name=name))

    async def raid_modify(self, name: str, **kwargs) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_modify", msg_raid.RaidModify(name=name, **kwargs))

    async def raid_init_start(self, name: str) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_init_start", msg_raid.RaidInitStart(name=name))

    async def raid_init_stop(self, name: str) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_init_stop", msg_raid.RaidInitStop(name=name))

    async def raid_recon_start(self, name: str) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_recon_start", msg_raid.RaidReconStart(name=name))

    async def raid_recon_stop(self, name: str) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_raid = stubs[2]
        return await self._call("raid_recon_stop", msg_raid.RaidReconStop(name=name))

    # ── Drives ─────────────────────────────────────────────────────────────
    # xiRAID gRPC has no generic disk_list RPC. Drive enumeration uses lsblk
    # enriched with RAID membership from raid_show(extended=True).

    async def disk_list(self) -> tuple[bool, Any, str]:
        """List block drives (OS-level lsblk + RAID membership from raid_show)."""
        loop = asyncio.get_event_loop()
        try:
            disks = await loop.run_in_executor(None, _collect_disk_info_sync)
            # Enrich with RAID membership
            ok, raids, _ = await self.raid_show(extended=True)
            if ok and isinstance(raids, list):
                for raid in raids:
                    for member in (raid.get("members") or []):
                        path = member.get("path", "")
                        for d in disks:
                            if d["name"] and d["name"] in path:
                                d["raid_name"] = raid.get("name", "")
                                d["member_state"] = member.get("state", "")
            return True, disks, ""
        except Exception as exc:
            return False, None, str(exc)

    async def drive_faulty_count_show(self, drives: list | None = None,
                                      name: str = "") -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_drive = stubs[3]
        kwargs: dict = {}
        if drives:
            kwargs["drives"] = drives
        if name:
            kwargs["name"] = name
        return await self._call("drive_faulty_count_show",
                                msg_drive.DriveFaultyCountShow(**kwargs))

    async def drive_locate(self, drives: list) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_drive = stubs[3]
        return await self._call("drive_locate", msg_drive.DriveLocate(drives=drives))

    # ── Pools ──────────────────────────────────────────────────────────────

    async def pool_show(self, name: str = "", units: str = "g") -> tuple[bool, Any, str]:
        """List/show spare pools."""
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_pool = stubs[4]
        kwargs: dict = {"units": units}
        if name:
            kwargs["name"] = name
        return await self._call("pool_show", msg_pool.PoolShow(**kwargs))

    # backward-compat alias used by raid.py
    async def pool_list(self) -> tuple[bool, Any, str]:
        return await self.pool_show()

    # ── License ────────────────────────────────────────────────────────────

    async def license_show(self) -> tuple[bool, Any, str]:
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_license = stubs[5]
        return await self._call("license_show", msg_license.LicenseShow())

    async def set_license(self, path: str) -> tuple[bool, Any, str]:
        """Install license from file path."""
        stubs = _import_stubs()
        if stubs[0] is None:
            return _no_stubs_error()
        msg_license = stubs[5]
        return await self._call("license_update", msg_license.LicenseUpdate(path=path))

    # backward-compat alias
    async def get_license_info(self) -> tuple[bool, Any, str]:
        return await self.license_show()

    # ── Server info / performance (no direct gRPC RPC) ────────────────────

    async def get_server_info(self) -> tuple[bool, Any, str]:
        """Probe gRPC connectivity via license_show; returns license data."""
        ok, data, err = await self.license_show()
        if not ok:
            return False, None, err
        return True, {"license": data}, ""

    async def get_performance(self) -> tuple[bool, Any, str]:
        """No gRPC performance RPC — returns empty dict."""
        return True, {}, ""

    def close(self) -> None:
        if self._channel is not None:
            self._channel.close()
        self._executor.shutdown(wait=False)
