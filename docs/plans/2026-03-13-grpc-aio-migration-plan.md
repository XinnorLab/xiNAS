# gRPC Async Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace synchronous gRPC + ThreadPoolExecutor with native `grpc.aio` async in `XiRAIDClient`.

**Architecture:** Switch `grpc.insecure_channel`/`grpc.secure_channel` to `grpc.aio` equivalents, remove executor wrapping in `_call()`, make `close()` async.

**Tech Stack:** grpcio (grpc.aio), Python asyncio, Textual TUI

**Design doc:** `docs/plans/2026-03-13-grpc-aio-migration-design.md`

---

### Task 1: Migrate `grpc_client.py` to `grpc.aio`

**Files:**
- Modify: `xinas_menu/api/grpc_client.py`

**Step 1: Remove ThreadPoolExecutor import and instance**

In `xinas_menu/api/grpc_client.py`:
- Remove line 23: `from concurrent.futures import ThreadPoolExecutor`
- Remove line 162: `self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="grpc")`

**Step 2: Update class docstring**

Replace lines 149-158:
```python
class XiRAIDClient:
    """Async gRPC client for xiRAID using grpc.aio.

    All RPCs are snake_case (e.g. raid_show, pool_show, license_show).
    Request types come from message_*_pb2 modules (not service_xraid_pb2).
    All responses are ResponseMessage.message parsed as JSON.
    """
```

**Step 3: Simplify `__init__`**

Replace lines 160-164:
```python
    def __init__(self, address: str = _GRPC_ADDRESS) -> None:
        self._address = address
        self._channel = None
        self._stub = None
```

**Step 4: Switch `_ensure_channel` to `grpc.aio`**

Replace lines 166-185:
```python
    def _ensure_channel(self):
        if self._stub is not None:
            return True
        stubs = _import_stubs()
        pb2_grpc, grpc = stubs[0], stubs[1]
        if pb2_grpc is None:
            return False
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
        self._stub = pb2_grpc.XRAIDServiceStub(self._channel)
        return True
```

**Step 5: Simplify `_call` to native async**

Replace lines 187-202:
```python
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
```

**Step 6: Make `close()` async**

Replace lines 374-377:
```python
    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
```

**Step 7: Remove unused `asyncio` import if no longer needed**

Check: `disk_list()` still uses `asyncio.get_running_loop()` on line 285, so keep the `asyncio` import.

**Step 8: Verify no other `run_in_executor` or `self._executor` references remain**

Search the file for `_executor` and `run_in_executor`. Only `disk_list()` should have `run_in_executor(None, ...)` — that's correct (it wraps `lsblk`, not gRPC).

---

### Task 2: Update `close()` call sites

**Files:**
- Modify: `xinas_menu/app.py:151`
- Modify: `xinas_menu/screens/startup/startup_menu.py:62`

**Step 1: Update `app.py`**

At line 151, change:
```python
        self.grpc.close()
```
to:
```python
        await self.grpc.close()
```

**Step 2: Update `startup_menu.py`**

At line 62, change:
```python
        self.grpc.close()
```
to:
```python
        await self.grpc.close()
```

---

### Task 3: Bump version and commit

**Files:**
- Modify: `xinas_menu/version.py`

**Step 1: Bump version**

Change `XINAS_MENU_VERSION` from `"2.3.0"` to `"2.4.0"`.

**Step 2: Commit all changes**

```bash
git add xinas_menu/api/grpc_client.py xinas_menu/app.py xinas_menu/screens/startup/startup_menu.py xinas_menu/version.py
git commit -m "refactor(grpc): switch XiRAIDClient from sync gRPC + ThreadPoolExecutor to native grpc.aio

Replaces grpc.insecure_channel/secure_channel with grpc.aio equivalents.
Removes ThreadPoolExecutor — gRPC calls now participate directly in the
asyncio event loop. close() is now async. disk_list() still uses
run_in_executor for lsblk subprocess.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
