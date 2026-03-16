"""Collect configuration and runtime state for snapshot creation."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from .grpc_inspector import GrpcInspector
from .models import Checksums


# Source paths for configuration files to collect (relative to repo root)
CONFIG_SOURCES: dict[str, str] = {
    "common.defaults.yml": "collection/roles/common/defaults/main.yml",
    "network.defaults.yml": "collection/roles/net_controllers/defaults/main.yml",
    "netplan.template.j2": "collection/roles/net_controllers/templates/netplan.yaml.j2",
    "nvme_namespace.defaults.yml": "collection/roles/nvme_namespace/defaults/main.yml",
    "raid_fs.defaults.yml": "collection/roles/raid_fs/defaults/main.yml",
    "exports.defaults.yml": "collection/roles/exports/defaults/main.yml",
    "nfs_server.defaults.yml": "collection/roles/nfs_server/defaults/main.yml",
    "playbook.site.yml": "playbooks/site.yml",
}

# System files to checksum
CHECKSUM_TARGETS: dict[str, str] = {
    "etc_exports": "/etc/exports",
    "nfs_conf": "/etc/nfs.conf",
    "netplan": "/etc/netplan/99-xinas.yaml",
}


class ConfigCollector:
    """Collects desired configuration files from the xiNAS repo."""

    def __init__(self, repo_root: str = "/opt/xiNAS"):
        self._repo_root = Path(repo_root)

    def collect(self) -> dict[str, bytes]:
        """Collect all managed configuration files.

        Returns dict of {snapshot_filename: file_content}.
        Missing source files are silently skipped.
        """
        collected: dict[str, bytes] = {}
        for snapshot_name, rel_path in CONFIG_SOURCES.items():
            full_path = self._repo_root / rel_path
            try:
                collected[snapshot_name] = full_path.read_bytes()
            except (OSError, IOError):
                # Missing files are silently skipped
                continue
        return collected

    def get_repo_commit(self) -> str:
        """Get current git commit hash of the repo."""
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                timeout=5,
                cwd=str(self._repo_root),
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (subprocess.TimeoutExpired, OSError):
            pass
        return ""


class RuntimeCollector:
    """Collects runtime state from gRPC and system inspection."""

    def __init__(self, inspector: GrpcInspector):
        self._inspector = inspector

    async def collect(self) -> dict[str, bytes]:
        """Collect all runtime state files.

        Returns dict of {filename: json_content} for:
        - raid-show.json (from gRPC)
        - pool-show.json (from gRPC)
        - config-show.json (from gRPC)
        - mounts.json (from systemd)
        - exports.json (parsed /etc/exports + checksum)
        - services.json (service states)
        """
        collected: dict[str, bytes] = {}

        # Run gRPC queries and system inspections concurrently
        raid_task = self._inspector.raid_show(extended=True)
        pool_task = self._inspector.pool_show()
        config_task = self._inspector.config_show()
        mounts_task = self._collect_mounts()
        exports_task = self._collect_exports()
        services_task = self._collect_services()

        results = await asyncio.gather(
            raid_task, pool_task, config_task,
            mounts_task, exports_task, services_task,
            return_exceptions=True,
        )

        # gRPC results: (ok, data, error) tuples
        grpc_mapping = [
            ("raid-show.json", results[0]),
            ("pool-show.json", results[1]),
            ("config-show.json", results[2]),
        ]
        for filename, result in grpc_mapping:
            if isinstance(result, BaseException):
                collected[filename] = json.dumps(
                    {"error": str(result)}, indent=2,
                ).encode()
            else:
                ok, data, err = result
                if ok and data is not None:
                    collected[filename] = json.dumps(data, indent=2).encode()
                else:
                    collected[filename] = json.dumps(
                        {"error": err or "no data"}, indent=2,
                    ).encode()

        # System inspection results: plain dicts
        system_mapping = [
            ("mounts.json", results[3]),
            ("exports.json", results[4]),
            ("services.json", results[5]),
        ]
        for filename, result in system_mapping:
            if isinstance(result, BaseException):
                collected[filename] = json.dumps(
                    {"error": str(result)}, indent=2,
                ).encode()
            elif isinstance(result, dict):
                collected[filename] = json.dumps(result, indent=2).encode()
            else:
                collected[filename] = json.dumps(
                    {"error": "unexpected result type"}, indent=2,
                ).encode()

        return collected

    async def collect_checksums(self) -> Checksums:
        """Compute checksums for managed system files."""
        loop = asyncio.get_running_loop()

        async def _checksum(path: str) -> str:
            return await loop.run_in_executor(None, self._sha256_file, path)

        tasks = {
            name: _checksum(path)
            for name, path in CHECKSUM_TARGETS.items()
        }
        results: dict[str, str] = {}
        for name, task in tasks.items():
            results[name] = await task

        return Checksums(
            etc_exports=results.get("etc_exports", ""),
            nfs_conf=results.get("nfs_conf", ""),
            netplan=results.get("netplan", ""),
        )

    async def _collect_mounts(self) -> dict:
        """Inspect xiNAS-managed systemd mount units."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._collect_mounts_sync)

    @staticmethod
    def _collect_mounts_sync() -> dict:
        """Synchronous mount unit collection."""
        try:
            result = subprocess.run(
                [
                    "systemctl", "list-units", "*.mount",
                    "--output=json", "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return {"error": f"systemctl rc={result.returncode}", "units": []}

            all_units = json.loads(result.stdout) if result.stdout.strip() else []

            # Filter for xiNAS-managed mount units:
            # those backed by unit files in /etc/systemd/system/
            xinas_mounts = []
            for unit in all_units:
                unit_name = unit.get("unit", "")
                if not unit_name.endswith(".mount"):
                    continue
                # Check if unit file is in /etc/systemd/system/ (xiNAS-managed)
                unit_file_path = f"/etc/systemd/system/{unit_name}"
                if os.path.isfile(unit_file_path):
                    xinas_mounts.append({
                        "unit": unit_name,
                        "active": unit.get("active", ""),
                        "sub": unit.get("sub", ""),
                        "description": unit.get("description", ""),
                    })

            return {"units": xinas_mounts}
        except subprocess.TimeoutExpired:
            return {"error": "systemctl timeout", "units": []}
        except (json.JSONDecodeError, OSError) as exc:
            return {"error": str(exc), "units": []}

    async def _collect_exports(self) -> dict:
        """Parse /etc/exports into structured data + checksum."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._collect_exports_sync)

    @staticmethod
    def _collect_exports_sync() -> dict:
        """Synchronous exports collection."""
        exports_path = "/etc/exports"
        try:
            content = Path(exports_path).read_text()
        except (OSError, IOError):
            return {"checksum": "", "exports": []}

        checksum = RuntimeCollector._sha256_file(exports_path)
        parsed = RuntimeCollector._parse_exports(content)
        return {"checksum": checksum, "exports": parsed}

    async def _collect_services(self) -> dict:
        """Get service states for nfs-server and xiraid-server."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._collect_services_sync)

    @staticmethod
    def _collect_services_sync() -> dict:
        """Synchronous service state collection."""
        services = {}
        target_services = ["nfs-server", "xiraid-server"]

        for svc in target_services:
            try:
                result = subprocess.run(
                    [
                        "systemctl", "show", svc,
                        "--property=ActiveState,SubState,LoadState",
                        "--no-pager",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0 and result.stdout.strip():
                    props: dict[str, str] = {}
                    for line in result.stdout.strip().splitlines():
                        if "=" in line:
                            key, _, value = line.partition("=")
                            props[key.strip()] = value.strip()
                    services[svc] = {
                        "active_state": props.get("ActiveState", "unknown"),
                        "sub_state": props.get("SubState", "unknown"),
                        "load_state": props.get("LoadState", "unknown"),
                    }
                else:
                    services[svc] = {
                        "active_state": "unknown",
                        "sub_state": "unknown",
                        "load_state": "unknown",
                    }
            except (subprocess.TimeoutExpired, OSError):
                services[svc] = {
                    "active_state": "unknown",
                    "sub_state": "unknown",
                    "load_state": "unknown",
                }

        return services

    @staticmethod
    def _sha256_file(path: str) -> str:
        """Compute sha256 checksum of a file. Returns 'sha256:<hex>' or empty string."""
        try:
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            return f"sha256:{h.hexdigest()}"
        except (OSError, IOError):
            return ""

    @staticmethod
    def _parse_exports(content: str) -> list[dict]:
        """Parse /etc/exports content into list of {path, clients, options}.

        Handles lines like:
            /mnt/data *(rw,sync,no_subtree_check)
            /mnt/data 10.0.0.0/24(rw,sync) 192.168.1.0/24(ro)
        """
        exports: list[dict] = []
        for line in content.splitlines():
            line = line.strip()
            # Skip empty lines and comments
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            if len(parts) < 2:
                continue

            export_path = parts[0]
            clients: list[dict] = []

            for part in parts[1:]:
                # Match patterns like: *(rw,sync), 10.0.0.0/24(rw,sync), hostname(opts)
                match = re.match(r'^([^\(]+)\(([^)]*)\)$', part)
                if match:
                    clients.append({
                        "host": match.group(1),
                        "options": match.group(2),
                    })
                else:
                    # Client spec without explicit options
                    clients.append({
                        "host": part,
                        "options": "",
                    })

            exports.append({
                "path": export_path,
                "clients": clients,
            })

        return exports
