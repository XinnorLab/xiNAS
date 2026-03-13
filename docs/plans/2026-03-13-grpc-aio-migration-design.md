# Design: Migrate gRPC Client to Native Async (`grpc.aio`)

**Date:** 2026-03-13
**Status:** Proposed
**Scope:** `xinas_menu/api/grpc_client.py` + 2 close() call sites

## Problem

`XiRAIDClient` currently uses synchronous `grpc.insecure_channel`/`grpc.secure_channel` wrapped in a `ThreadPoolExecutor(max_workers=4)` via `asyncio.run_in_executor()`. This adds unnecessary thread overhead and complexity — every gRPC call spins up a thread just to block on I/O.

## Solution

Switch to `grpc.aio` — gRPC's native asyncio API. This eliminates the thread pool entirely and lets gRPC calls participate directly in the Textual event loop.

## Changes

### 1. `grpc_client.py` — Channel Creation

**Before:**
```python
self._channel = grpc.insecure_channel(self._address, options=opts)
# or
self._channel = grpc.secure_channel(self._address, creds, options=opts)
```

**After:**
```python
self._channel = grpc.aio.insecure_channel(self._address, options=opts)
# or
self._channel = grpc.aio.secure_channel(self._address, creds, options=opts)
```

### 2. `grpc_client.py` — `_call()` Method

**Before:**
```python
async def _call(self, method_name, request, timeout=5):
    loop = asyncio.get_running_loop()
    def _sync():
        method = getattr(stub, method_name)
        return method(request, timeout=timeout)
    resp = await loop.run_in_executor(self._executor, _sync)
```

**After:**
```python
async def _call(self, method_name, request, timeout=5):
    method = getattr(self._stub, method_name)
    resp = await method(request, timeout=timeout)
```

### 3. `grpc_client.py` — Remove ThreadPoolExecutor

Remove `from concurrent.futures import ThreadPoolExecutor` and `self._executor` from `__init__`.

### 4. `grpc_client.py` — `close()` Becomes Async

**Before:**
```python
def close(self):
    if self._channel is not None:
        self._channel.close()
    self._executor.shutdown(wait=False)
```

**After:**
```python
async def close(self):
    if self._channel is not None:
        await self._channel.close()
```

### 5. `grpc_client.py` — `disk_list()` Keeps Executor

`disk_list()` calls `lsblk` via `subprocess.run()` — this is not gRPC, so it keeps using `run_in_executor(None, ...)` (the default executor). No change needed.

### 6. Close() Call Sites (2 files)

Both are already `async def on_unmount()`, just add `await`:

- `xinas_menu/app.py:151` — `self.grpc.close()` → `await self.grpc.close()`
- `xinas_menu/screens/startup/startup_menu.py:62` — `self.grpc.close()` → `await self.grpc.close()`

## What Does NOT Change

- All public method signatures remain identical (`async def raid_show(...)` etc.)
- Return type `tuple[bool, Any, str]` unchanged
- TLS certificate loading (`_load_channel_credentials`) — sync, runs before channel creation
- Stub import logic (`_import_stubs`) — unchanged
- All caller code in screens — already uses `await self.app.grpc.method()`
- Error handling pattern in `_call` — same try/except structure

## Risk Assessment

**Low risk:**
- `grpc.aio` is stable since gRPC Python 1.32 (2020)
- All callers already use async/await — no API change
- Channel options are identical between sync and async APIs
- Fallback to insecure channel works the same way

**Testing:** Verify on target system that xiRAID gRPC server responds correctly through `grpc.aio` channel. The `grpc.aio` API handles the same protobuf stubs.
