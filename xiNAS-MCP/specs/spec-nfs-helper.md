# NFS Helper Daemon Specification

## Overview

Python 3 Unix socket daemon at `/run/xinas-nfs-helper.sock`.
Manages `/etc/exports` and NFS sessions. Calls `exportfs -r` when exports change.

**Design constraint:** The MCP server (Node.js) MUST NOT call `exportfs` directly.
This daemon is the only component allowed to invoke NFS management subprocesses.

---

## Wire Protocol

**Transport:** Unix domain socket (SOCK_STREAM)
**Framing:** Newline-delimited JSON (`\n` terminated)
**Pattern:** One request → one response per connection

### Request Format
```json
{ "op": "<operation>", "request_id": "<uuid>", [op-specific fields] }
```

### Success Response
```json
{ "ok": true, "result": <result>, "request_id": "<uuid>" }
```

### Error Response
```json
{ "ok": false, "error": "<message>", "code": "<ErrorCode>", "request_id": "<uuid>" }
```

Error codes: `INVALID_ARGUMENT | NOT_FOUND | INTERNAL | UNSUPPORTED`

---

## Operations

### `list_exports`
**Input:** none
**Output:** `ExportEntry[]`

Parses `/etc/exports`. Returns empty array if file absent.

```json
[
  {
    "path": "/data",
    "clients": [
      { "host": "192.168.1.0/24", "options": ["rw", "sync", "no_root_squash"] }
    ]
  }
]
```

### `add_export`
**Input:** `{ "entry": ExportEntry }`
**Output:** null

Idempotent: removes existing entry with same path before adding.
Calls `exportfs -r` after write.

### `remove_export`
**Input:** `{ "path": string }`
**Output:** null

Error `NOT_FOUND` if path not in `/etc/exports`.
Calls `exportfs -r` after write.

### `update_export`
**Input:** `{ "path": string, "patch": Partial<ExportEntry> }`
**Output:** null

Merge-patches the existing entry.
Error `NOT_FOUND` if path not found.
Calls `exportfs -r` after write.

### `list_sessions`
**Input:** none
**Output:** `SessionInfo[]`

Reads from `/proc/fs/nfsd/clients/` (one directory per connected client).
Falls back to `/proc/net/rpc/auth.unix.ip`.

```json
[
  { "client_ip": "10.0.0.5", "nfs_version": "4.2", "export_path": "unknown", "active_locks": 0 }
]
```

### `get_sessions`
**Input:** `{ "path": string }`
**Output:** `SessionInfo[]`

Filters sessions to those matching the export path.

### `set_quota`
**Input:** `{ "quota": { "path": string, "soft_limit_kb": int, "hard_limit_kb": int, "project_id?": int } }`
**Output:** null

Calls `xfs_quota -x -c "project -s <id>" <mountpoint>` and `xfs_quota -x -c "limit -p bsoft=Xk bhard=Yk <id>" <mountpoint>`.
Project ID auto-assigned from `abs(hash(path)) % 65535 + 1` if not specified.

### `reload`
**Input:** none
**Output:** null

Calls `exportfs -r`. Returns error if `exportfs` is not installed.

---

## File Locking

`/etc/exports` modifications use `fcntl.flock(LOCK_EX)` via `/run/xinas-exports.lock`.
This prevents concurrent writes from multiple daemon threads.

---

## Systemd Unit

```ini
[Unit]
Description=xiNAS NFS Helper Daemon
After=network.target nfs-kernel-server.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/lib/xinas-mcp/nfs-helper/nfs_helper.py
Restart=on-failure
RestartSec=5s
RuntimeDirectory=xinas-nfs-helper
User=root
Environment=NFS_HELPER_SOCKET=/run/xinas-nfs-helper.sock

[Install]
WantedBy=multi-user.target
```

## Installation

```bash
cp -r nfs-helper/ /usr/lib/xinas-mcp/nfs-helper/
cp nfs-helper/xinas-nfs-helper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now xinas-nfs-helper
```

## Verification

```bash
echo '{"op":"list_exports","request_id":"test-1"}' | nc -U /run/xinas-nfs-helper.sock
```

Expected:
```json
{"ok": true, "result": [], "request_id": "test-1"}
```
