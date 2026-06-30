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

### `set_idmapd_domain`
**Input:** `{ "op": "set_idmapd_domain", "request_id": string, "domain": string }`
**Output:** null

Sets the `Domain = <domain>` line under the `[General]` section of
`/etc/idmapd.conf`. The rest of the file (comments, other keys, other sections)
is preserved verbatim:

* an existing `Domain` line under `[General]` is rewritten in place (its
  indentation and key spelling are kept);
* if `[General]` exists without a `Domain` key, the line is appended to that
  section;
* if `[General]` is absent, the section is created at the top of the file.

Atomic + locked (`fcntl.LOCK_EX` on `/run/xinas-nfs-idmap.lock`, write via
`mkstemp` + `os.replace`). **No service restart** — `nfs-idmapd` re-reads the
file on demand.

Error `INVALID_ARGUMENT` if `domain` is missing, empty, not a string, or does
not contain a `.`.

```json
{"ok": true, "result": null, "request_id": "set-idmap-1"}
```

### `render_nfs_profile`
**Input:** `{ "op": "render_nfs_profile", "request_id": string, "spec": object, "restart?": bool }`
**Output:** `{ "effective_files": { "<abs path>": "sha256:<hex>", ... }, "restarted": bool, "reloaded": bool }`

Renders the **four ADR-0005 effective NFS service-config files** on Ubuntu
22.04/24.04 from a full `NfsProfile` spec (`docs/control-path/adr/0005-nfs-profile.md`,
s3-nfs-executor-spec §6.2). This op — not the legacy `fix_nfs_conf` /
`/etc/nfs.conf` path — owns the NFS profile rendering:

| File | Contents |
|------|----------|
| `/etc/nfs/nfsd.conf` | `[nfsd]`: `vers3`, `vers4` (y iff any v4_* enabled), `vers4.0/4.1/4.2`, `rdma` (+ `rdma-port` when enabled), `threads` |
| `/etc/default/nfs-kernel-server` | `RPCNFSDCOUNT=<threads.count>`, `RPCMOUNTDOPTS="--manage-gids"` |
| `/etc/modprobe.d/lockd.conf` | `options lockd nlm_udpport=<n> nlm_tcpport=<n>` when `v3_locking.enabled` AND `versions.v3.enabled`; otherwise a managed comment-only form |
| `/etc/default/nfs-common` | `NEED_STATD=yes\|no` per `versions.v3.enabled`, `STATDOPTS=""` (fixed statd ports are Phase 1+) |

Rendering is **deterministic** (same spec → byte-identical files); every file
starts with a `# Managed by xiNAS (render_nfs_profile) — do not edit` header,
is written atomically (`mkstemp` + `os.replace`, mode 0644) under one
`fcntl.LOCK_EX` on `/run/xinas-nfs-profile.lock`, and is checksummed —
`effective_files` keys are the absolute paths, values `sha256:<hex>` (feeds
`NfsProfile.status.effective_files`).

Service action after a successful render: `restart: true` → `systemctl restart
nfs-server`; `restart: false` (default) → `systemctl reload nfs-server`
(ADR-0005 apply stage `reload_or_restart`). A systemctl failure returns
`INTERNAL` — the files were already rendered at that point and the error says
so.

A mid-render write failure can leave a PARTIAL set (earlier files already
replaced, later ones untouched; each individual write is atomic). Accepted:
the S3 executor's rollback re-renders all four files from the prior spec,
restoring a coherent set.

Error `INVALID_ARGUMENT` if `spec` is missing/not an object, `threads.count`
is not an integer in `[8, 1024]`, or `rdma.port` is not a valid port when
RDMA is enabled.

```json
{"ok": true, "result": {"effective_files": {"/etc/nfs/nfsd.conf": "sha256:ab12..."}, "restarted": false, "reloaded": true}, "request_id": "render-1"}
```

---

## File Locking

`/etc/exports` modifications use `fcntl.flock(LOCK_EX)` via `/run/xinas-exports.lock`.
`/etc/nfs.conf` edits (`fix_nfs_conf`) lock `/run/xinas-nfs-conf.lock`,
`/etc/idmapd.conf` edits (`set_idmapd_domain`) lock `/run/xinas-nfs-idmap.lock`,
and the ADR-0005 profile files (`render_nfs_profile`) lock
`/run/xinas-nfs-profile.lock`.
Each file has its own lock, preventing concurrent writes from multiple daemon
threads.

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

In production the daemon is deployed by the **`xinas_nfs_helper` Ansible role**
(`collection/roles/xinas_nfs_helper/`), which performs the steps below. The role
is wired into `playbooks/site.yml` and **both shipping presets**
(`presets/default/playbook.yml`, `presets/xinnorVM/playbook.yml`), ordered
*before* `xinas_mcp` — the helper must be up before the daemon that calls it
(ADR-0010 §deployment). Its lifecycle is intentionally separate from the
retiring `xinas_mcp` role so the helper survives the legacy daemon's removal.

> Finding #14 (InstallationFeedback-2026-05-28): the role existed but no preset
> invoked it, so preset installs had no `xinas-nfs-helper.service`. The wiring
> above is the fix.

Equivalent manual steps:

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
