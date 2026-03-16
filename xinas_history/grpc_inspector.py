"""Query xiRAID runtime state via gRPC for snapshot capture."""
from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any, Optional, Tuple


class GrpcInspector:
    """Queries xiRAID storage state for configuration snapshots.

    Uses the existing XiRAIDClient when available (in-process),
    or falls back to CLI subprocess calls.

    The inspector provides read-only queries used for:
    - Runtime state capture during snapshot creation
    - Post-apply validation
    - Dependency inspection before rollback
    """

    # CLI timeout for read-only operations (seconds)
    _CLI_READ_TIMEOUT = 10
    # CLI timeout for mutation operations (seconds)
    _CLI_MUTATE_TIMEOUT = 30

    def __init__(self, grpc_address: str = "localhost:6066", grpc_client=None):
        """
        Args:
            grpc_address: gRPC server address
            grpc_client: Optional pre-initialized XiRAIDClient instance.
                         If None, falls back to CLI subprocess calls.
        """
        self._address = grpc_address
        self._client = grpc_client

    # ------------------------------------------------------------------
    # Public query methods
    # ------------------------------------------------------------------

    async def raid_show(self, extended: bool = True) -> Tuple[bool, Optional[dict], str]:
        """Get RAID array topology.

        Returns (ok, data, error) tuple. data is a dict keyed by array name.
        """
        if self._client is not None:
            try:
                ok, data, err = await self._client.raid_show(
                    units="g", extended=extended,
                )
                return ok, data, err
            except Exception as exc:
                return False, None, f"gRPC client error: {exc}"

        # CLI fallback
        ok, stdout, err = await self._run_cli_async(
            ["xicli", "raid", "show", "-f", "json"],
        )
        if not ok:
            return False, None, err
        return self._parse_json(stdout)

    async def pool_show(self) -> Tuple[bool, Optional[dict], str]:
        """Get spare pool information."""
        if self._client is not None:
            try:
                ok, data, err = await self._client.pool_show()
                return ok, data, err
            except Exception as exc:
                return False, None, f"gRPC client error: {exc}"

        ok, stdout, err = await self._run_cli_async(
            ["xicli", "pool", "show", "-f", "json"],
        )
        if not ok:
            return False, None, err
        return self._parse_json(stdout)

    async def config_show(self) -> Tuple[bool, Optional[dict], str]:
        """Get xiRAID stored configuration from drives."""
        if self._client is not None:
            # XiRAIDClient does not have a config_show method;
            # fall through to CLI.
            pass

        ok, stdout, err = await self._run_cli_async(
            ["xicli", "config", "show", "-f", "json"],
        )
        if not ok:
            return False, None, err
        return self._parse_json(stdout)

    async def config_backup(self) -> Tuple[bool, Optional[dict], str]:
        """Trigger xiRAID config backup.

        This is a mutation — uses a longer timeout.
        """
        ok, stdout, err = await self._run_cli_async(
            ["xicli", "config", "backup", "-f", "json"],
            timeout=self._CLI_MUTATE_TIMEOUT,
        )
        if not ok:
            return False, None, err
        return self._parse_json(stdout)

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    async def get_raid_arrays(self) -> list[dict]:
        """Convenience: get list of RAID array info dicts."""
        ok, data, _ = await self.raid_show(extended=True)
        if not ok or data is None:
            return []
        # data may be a dict keyed by array name or a list
        if isinstance(data, dict):
            return list(data.values()) if data else []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    async def get_pools(self) -> list[dict]:
        """Convenience: get list of pool info dicts."""
        ok, data, _ = await self.pool_show()
        if not ok or data is None:
            return []
        if isinstance(data, dict):
            return list(data.values()) if data else []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    # ------------------------------------------------------------------
    # CLI fallback
    # ------------------------------------------------------------------

    def _run_cli(
        self, args: list[str], timeout: int | None = None,
    ) -> Tuple[bool, Optional[str], str]:
        """Fallback: run xicli command and return (ok, stdout, error).

        Uses subprocess with timeout handling.
        CLI fallback requirements from spec:
        - Command timeout: 10s for read-only, 30s for mutations
        - Schema validation of parsed JSON
        - Explicit mapping of transport errors vs semantic errors
        - Retry only for safe read-only calls
        """
        if timeout is None:
            timeout = self._CLI_READ_TIMEOUT
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            if result.returncode != 0:
                stderr = (result.stderr or "").strip()
                return False, None, f"CLI error (rc={result.returncode}): {stderr}"
            return True, result.stdout, ""
        except subprocess.TimeoutExpired:
            return False, None, f"CLI timeout after {timeout}s: {' '.join(args)}"
        except FileNotFoundError:
            return False, None, "xicli not found in PATH"
        except OSError as exc:
            return False, None, f"CLI transport error: {exc}"

    async def _run_cli_async(
        self, args: list[str], timeout: int | None = None,
    ) -> Tuple[bool, Optional[str], str]:
        """Run CLI command in a thread to avoid blocking the event loop."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._run_cli, args, timeout,
        )

    # ------------------------------------------------------------------
    # JSON parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_json(raw: Optional[str]) -> Tuple[bool, Optional[Any], str]:
        """Parse a JSON string, returning (ok, data, error)."""
        if not raw or not raw.strip():
            return True, None, ""
        try:
            data = json.loads(raw)
            return True, data, ""
        except (json.JSONDecodeError, ValueError) as exc:
            return False, None, f"JSON parse error: {exc}"
