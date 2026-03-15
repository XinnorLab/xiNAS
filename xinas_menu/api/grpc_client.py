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
from pathlib import Path
from typing import Any

__all__ = ["XiRAIDClient"]

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


def _get_os_drives() -> set[str]:
    """Detect drives that host OS partitions (root, boot, EFI, swap)."""
    os_drives: set[str] = set()
    try:
        r = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,MOUNTPOINT,TYPE"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(r.stdout)
        _OS_MOUNTS = ("/", "/boot", "/boot/efi", "[SWAP]")
        for dev in data.get("blockdevices", []):
            # Check children (partitions) for OS mount points
            for child in dev.get("children") or []:
                mp = child.get("mountpoint") or ""
                if mp in _OS_MOUNTS:
                    os_drives.add(dev.get("name", ""))
                    break
            # Also check the device itself (rare: whole-disk root)
            mp = dev.get("mountpoint") or ""
            if mp in _OS_MOUNTS:
                os_drives.add(dev.get("name", ""))
    except Exception:
        pass
    return os_drives


def _collect_disk_info_sync() -> list:
    """Enumerate block drives via lsblk (no gRPC — xiRAID has no disk_list RPC)."""
    os_drives = _get_os_drives()
    try:
        r = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,SIZE,MODEL,SERIAL,TYPE,TRAN"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(r.stdout)
        disks = []
        for d in data.get("blockdevices", []):
            if d.get("type") != "disk":
                continue
            name = d.get("name", "")
            size_raw = 0
            try:
                sz_path = f"/sys/class/block/{name}/size"
                if os.path.isfile(sz_path):
                    with open(sz_path) as f:
                        size_raw = int(f.read().strip()) * 512
            except Exception:
                pass
            # NUMA node detection (NVMe via parent controller, others via block device)
            numa_node = -1
            try:
                # For NVMe: /sys/class/block/nvme0n1 -> ../../nvme0 -> ../../../<pci>/numa_node
                numa_path = f"/sys/class/block/{name}/device/numa_node"
                if os.path.isfile(numa_path):
                    with open(numa_path) as f:
                        numa_node = int(f.read().strip())
                elif name.startswith("nvme"):
                    # Try parent controller: nvme0n1 -> nvme0
                    ctrl = name.split("n")[0]
                    ctrl_numa = f"/sys/class/nvme/{ctrl}/device/numa_node"
                    if os.path.isfile(ctrl_numa):
                        with open(ctrl_numa) as f:
                            numa_node = int(f.read().strip())
            except Exception:
                pass

            disks.append({
                "name": name,
                "size": d.get("size", ""),
                "size_bytes": size_raw,
                "size_raw": size_raw,
                "model": (d.get("model") or "").strip(),
                "serial": (d.get("serial") or "").strip(),
                "transport": d.get("tran") or "",
                "numa_node": numa_node if numa_node >= 0 else 0,
                "system": name in os_drives,
            })
        return disks
    except Exception:
        # Fallback: scan /sys/class/block for nvme controllers
        disks = []
        try:
            for name in sorted(os.listdir("/sys/class/block")):
                if name.startswith("nvme") and "p" not in name and "n" in name:
                    numa = 0
                    try:
                        ctrl = name.split("n")[0]
                        np = f"/sys/class/nvme/{ctrl}/device/numa_node"
                        if os.path.isfile(np):
                            with open(np) as f:
                                numa = max(0, int(f.read().strip()))
                    except Exception:
                        pass
                    disks.append({
                        "name": name, "size": "", "size_bytes": 0, "size_raw": 0,
                        "model": "", "serial": "", "transport": "nvme",
                        "numa_node": numa, "system": name in os_drives,
                    })
        except Exception:
            pass
        return disks


class XiRAIDClient:
    """Async gRPC client for xiRAID using grpc.aio.

    All RPCs are snake_case (e.g. raid_show, pool_show, license_show).
    Request types come from message_*_pb2 modules (not service_xraid_pb2).
    All responses are ResponseMessage.message parsed as JSON.
    """

    def __init__(self, address: str = _GRPC_ADDRESS) -> None:
        self._address = address
        self._channel = None
        self._stub = None
        self._msg_raid = None
        self._msg_drive = None
        self._msg_pool = None
        self._msg_license = None
        self._msg_settings = None

    def _ensure_channel(self):
        if self._stub is not None:
            return True
        stubs = _import_stubs()
        pb2_grpc, grpc = stubs[0], stubs[1]
        if pb2_grpc is None:
            return False
        self._msg_raid = stubs[2]
        self._msg_drive = stubs[3]
        self._msg_pool = stubs[4]
        self._msg_license = stubs[5]
        self._msg_settings = stubs[6]
        creds = _load_channel_credentials()
        opts = [
            ("grpc.initial_reconnect_backoff_ms", 500),
            ("grpc.max_reconnect_backoff_ms", 2000),
            ("grpc.enable_retries", 0),
        ]
        if creds is not None:
            self._channel = grpc.aio.secure_channel(self._address, creds, options=opts)
        else:
            self._channel = grpc.aio.insecure_channel(self._address, options=opts)
        # XRAIDServiceStub — note XRAID (not XiRAID)
        self._stub = pb2_grpc.XRAIDServiceStub(self._channel)
        return True

    async def _call(self, method_name: str, request, timeout: int = 5) -> tuple[bool, Any, str]:
        try:
            if not self._ensure_channel():
                return _no_stubs_error()
            method = getattr(self._stub, method_name)
            resp = await method(request, timeout=timeout)
            data = _parse_response(resp)
            return True, data, ""
        except Exception as exc:
            return False, None, str(exc)

    # ── RAID ────────────────────────────────────────────────────────────────

    async def raid_show(self, units: str = "g", name: str = "",
                        extended: bool = False) -> tuple[bool, Any, str]:
        """Show RAID arrays. Returns parsed JSON list of array dicts."""
        if not self._ensure_channel():
            return _no_stubs_error()
        kwargs: dict = {"units": units}
        if name:
            kwargs["name"] = name
        if extended:
            kwargs["extended"] = extended
        return await self._call("raid_show", self._msg_raid.RaidShow(**kwargs))

    async def raid_create(self, name: str, level: str, drives: list,
                          **kwargs) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_create", self._msg_raid.RaidCreate(
            name=name, level=level, drives=drives, **kwargs))

    async def raid_destroy(self, name: str, force: bool = False) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_destroy", self._msg_raid.RaidDestroy(
            name=name, force=force))

    async def raid_unload(self, name: str) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_unload", self._msg_raid.RaidUnload(name=name))

    async def raid_modify(self, name: str, **kwargs) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_modify", self._msg_raid.RaidModify(name=name, **kwargs))

    async def raid_init_start(self, name: str) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_init_start", self._msg_raid.RaidInitStart(name=name))

    async def raid_init_stop(self, name: str) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_init_stop", self._msg_raid.RaidInitStop(name=name))

    async def raid_recon_start(self, name: str) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_recon_start", self._msg_raid.RaidReconStart(name=name))

    async def raid_recon_stop(self, name: str) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("raid_recon_stop", self._msg_raid.RaidReconStop(name=name))

    # ── Drives ─────────────────────────────────────────────────────────────
    # xiRAID gRPC has no generic disk_list RPC. Drive enumeration uses lsblk
    # enriched with RAID membership from raid_show(extended=True).

    async def disk_list(self) -> tuple[bool, Any, str]:
        """List block drives (OS-level lsblk + RAID membership from raid_show)."""
        loop = asyncio.get_running_loop()
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
        if not self._ensure_channel():
            return _no_stubs_error()
        kwargs: dict = {}
        if drives:
            kwargs["drives"] = drives
        if name:
            kwargs["name"] = name
        return await self._call("drive_faulty_count_show",
                                self._msg_drive.DriveFaultyCountShow(**kwargs))

    async def drive_locate(self, drives: list) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("drive_locate", self._msg_drive.DriveLocate(drives=drives))

    # ── Pools ──────────────────────────────────────────────────────────────

    async def pool_show(self, name: str = "", units: str = "g") -> tuple[bool, Any, str]:
        """List/show spare pools."""
        if not self._ensure_channel():
            return _no_stubs_error()
        kwargs: dict = {"units": units}
        if name:
            kwargs["name"] = name
        return await self._call("pool_show", self._msg_pool.PoolShow(**kwargs))

    # backward-compat alias used by raid.py
    async def pool_list(self) -> tuple[bool, Any, str]:
        return await self.pool_show()

    # ── License ────────────────────────────────────────────────────────────

    async def license_show(self) -> tuple[bool, Any, str]:
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("license_show", self._msg_license.LicenseShow())

    async def set_license(self, path: str) -> tuple[bool, Any, str]:
        """Install license from file path."""
        if not self._ensure_channel():
            return _no_stubs_error()
        return await self._call("license_update", self._msg_license.LicenseUpdate(path=path))

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

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
