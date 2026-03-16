# xiRAID gRPC API Reference for Configuration History

This document covers the subset of the xiRAID gRPC API surface relevant to the
xiNAS Configuration History feature. The information was derived from the xiRAID
source tree and the xiNAS-MCP proto definitions.

---

## 1. Service Overview

| Property | Value |
|----------|-------|
| **Service** | `xraid.v2.XRAIDService` |
| **Transport** | gRPC with TLS (client certificate authentication) |
| **Default endpoint** | `localhost:6066` |
| **Total RPCs** | 52 (this document covers the config-history subset) |

### TLS Certificate Paths

| Certificate | Path |
|-------------|------|
| Client / CA cert | `/etc/xraid/crt/ca-cert.pem` (or `.crt`) |
| Server cert | `/etc/xraid/crt/server-cert.pem` |
| Server key | `/etc/xraid/crt/server-key.pem` |

### Response Pattern

Every RPC returns a single message type:

```protobuf
message ResponseMessage {
  optional string message = 1;
}
```

The `message` field contains a **JSON-encoded string**. Callers must
`json.loads()` (Python) or `JSON.parse()` (TypeScript) the value to obtain the
structured response.

---

## 2. RAID Operations

### raid_show

Query RAID array topology and status.

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | No | Filter by array name |
| `units` | `string` | No | Size units: `"g"`, `"t"`, `"m"` |
| `extended` | `bool` | No | Include device health and advanced parameters |
| `active` | `bool` | No | Return only active arrays |

**Response JSON:**

```json
{
  "<array_name>": {
    "name": "data",
    "level": "5",
    "size": "1.2T",
    "state": ["active", "initialized"],
    "devices": [
      {
        "path": "/dev/nvme0n2",
        "serial": "...",
        "state": "active",
        "size": "..."
      }
    ],
    "uuid": "...",
    "sparepool": "pool0",
    "group_size": 4,
    "strip_size": "128K",
    "synd_cnt": 1
  }
}
```

When `extended` is `true`, the response additionally includes `devices_health`
(SMART data), `cpu_allowed`, `memory_limit`, and all performance parameters.

**Config-history usage:** Runtime state capture (`collector.py`).

---

### raid_create

Create a new RAID array.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |
| `level` | `string` | RAID level: `"0"`, `"1"`, `"5"`, `"6"`, `"10"`, `"50"`, `"60"` |
| `drives` | `repeated string` | Device paths (e.g., `/dev/nvme0n2`) |

**Optional fields (32+):**

| Field | Type | Description |
|-------|------|-------------|
| `group_size` | `uint32` | Devices per RAID group |
| `synd_cnt` | `uint32` | Syndrome (parity) count |
| `strip_size` | `string` | Strip size (e.g., `"128K"`) |
| `block_size` | `string` | Block size |
| `sparepool` | `string` | Associated spare pool name |
| `init_prio` | `string` | Initialization priority |
| `recon_prio` | `string` | Reconstruction priority |
| `restripe_prio` | `string` | Restriping priority |
| `sched_enabled` | `bool` | I/O scheduler |
| `merge_read_enabled` | `bool` | Read merging |
| `merge_write_enabled` | `bool` | Write merging |
| `memory_limit` | `string` | Memory limit |
| `memory_prealloc` | `bool` | Pre-allocate memory |
| `request_limit` | `string` | Request queue limit |
| `force_metadata` | `bool` | Force metadata write |
| `cpu_allowed` | `string` | CPU affinity mask |
| `adaptive_merge` | `bool` | Adaptive merge algorithm |
| `merge_read_max` | `string` | Max read merge size |
| `merge_read_wait` | `string` | Read merge wait time |
| `merge_write_max` | `string` | Max write merge size |
| `merge_write_wait` | `string` | Write merge wait time |
| `discard` | `bool` | TRIM/discard support |
| `drive_trim` | `bool` | Drive-level TRIM |
| `force` | `bool` | Force creation |

**Config-history usage:** Transactional runner for rollback rebuild.

---

### raid_destroy

Delete a RAID array. **This operation is irreversible.**

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `force` | `bool` | Force destruction even with errors |

**Config-history usage:** Transactional runner for rollback teardown.

---

### raid_modify

Modify RAID parameters after creation.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |

**Optional fields:** All `raid_create` optional fields except `drives` and
`level`, plus the following additional fields:

| Field | Type | Description |
|-------|------|-------------|
| `force_online` | `bool` | Force online parameter change |
| `force_resync` | `bool` | Force resynchronization |
| `discard_ignore` | `bool` | Ignore discard requests |
| `discard_verify` | `bool` | Verify discard operations |
| `drive_write_through` | `bool` | Drive write-through mode |

**Config-history usage:** Transactional runner for non-disruptive changes.

---

### raid_unload

Unload a RAID array while preserving data on the underlying drives.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |

**Config-history usage:** Graceful teardown before rollback.

---

### raid_restore

Restore a RAID array from a configuration file.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |
| `path` | `string` | Path to configuration file |

**Config-history usage:** Potential rollback mechanism.

---

### raid_import_show / raid_import_apply

Import RAID arrays from existing drives.

**raid_import_show fields:**

| Field | Type | Description |
|-------|------|-------------|
| `drives` | `repeated string` | Device paths to scan |

**raid_import_apply fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Array name |
| `path` | `string` | Configuration path |

**Config-history usage:** Recovery scenarios.

---

### raid_init_start / raid_init_stop

Control the RAID initialization process.

| Field | Type | RPC | Description |
|-------|------|-----|-------------|
| `name` | `string` | Both | Array name |
| `prio` | `string` | `start` only | Initialization priority |

**Config-history usage:** Post-apply validation (check initialization state).

---

### raid_recon_start / raid_recon_stop

Control RAID reconstruction.

| Field | Type | RPC | Description |
|-------|------|-----|-------------|
| `name` | `string` | Both | Array name |
| `prio` | `string` | `start` only | Reconstruction priority |

**Config-history usage:** Post-apply validation (check reconstruction state).

---

### raid_restripe_start / raid_restripe_continue / raid_restripe_stop

Online restriping operations.

**raid_restripe_start fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Array name |
| `drives` | `repeated string` | Yes | New drive list |
| `level` | `string` | No | New RAID level |
| `group_size` | `uint32` | No | New group size |
| `strip_size` | `string` | No | New strip size |

**Config-history usage:** Non-disruptive RAID changes.

---

### raid_defaults_show (PRIVATE)

Show default RAID configuration values.

> **Note:** This RPC is for internal and debugging use only.

---

## 3. Pool Operations

### pool_show

Display spare pool information.

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | No | Filter by pool name |
| `units` | `string` | No | Size units |

**Response JSON:**

```json
{
  "<pool_name>": {
    "name": "pool0",
    "drive_type": "NVMe",
    "drives": {
      "<serial>": "<size>"
    }
  }
}
```

**Config-history usage:** Runtime state capture.

---

### pool_create

Create a spare pool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Pool name |
| `drives` | `repeated string` | No | Initial drives |

---

### pool_delete

Delete a spare pool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Pool name |

---

### pool_add / pool_remove

Add or remove drives from a spare pool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Pool name |
| `drives` | `repeated string` | Yes | Device paths |

---

### pool_activate / pool_deactivate

Activate or deactivate a spare pool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Pool name |

---

## 4. Configuration Operations

### config_show

Display configurations stored on drives.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `drives` | `repeated string` | No | Device paths (empty = show all) |

**Response:** JSON dump of stored configurations.

**Config-history usage:** Capture xiRAID stored config in runtime state.

---

### config_backup

Save the current RAID configuration to a backup file (`backup_raid.conf`).

**Request fields:** None.

**Response:** JSON dump of the full configuration.

**Config-history usage:** Trigger xiRAID-level backup before snapshot creation.

---

### config_restore

Restore configuration from a backup file or drives.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `drives` | `repeated string` | No | Source drives |
| `raid_file` | `string` | No | RAID backup file path |
| `main_file` | `string` | No | Main config file path |

**Config-history usage:** Potential rollback mechanism for RAID-level config.

---

### config_apply

Apply configuration to restoring RAIDs.

**Config-history usage:** Post-restore configuration application.

---

## 5. Drive Operations

### drive_clean

Delete metadata and reset error counters on drives.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `drives` | `repeated string` | Yes | Device paths |

**Config-history usage:** Pre-RAID creation cleanup during rollback.

---

### drive_faulty_count_show

Display I/O error counts for drives.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `drives` | `repeated string` | No | Device paths |
| `name` | `string` | No | Filter by RAID array name |

**Config-history usage:** Pre-apply health validation.

---

### drive_locate

Manage LED indication on drives.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `drives` | `repeated string` | Yes | Device paths |

---

## 6. License Operations

### license_show

Display current license information.

**Request fields:** None.

**Response:** License details JSON.

**Config-history usage:** Server connectivity check, hardware ID retrieval.

---

### license_update

Load a license from a file.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | Yes | File path to the license |

---

## 7. Settings Operations

### settings_cluster_show / settings_cluster_modify

**Modify fields:**

| Field | Type | Description |
|-------|------|-------------|
| `raid_autostart` | `bool` | Auto-start RAIDs on boot |
| `pool_autoactivate` | `bool` | Auto-activate pools on boot |

**Config-history usage:** Verify autostart settings during validation.

---

### settings_scanner_show / settings_scanner_modify

**Modify fields:**

| Field | Type | Description |
|-------|------|-------------|
| `smart_polling_interval` | `string` | SMART polling interval |
| `led_enabled` | `bool` | LED indication |
| `scanner_polling_interval` | `string` | Scanner polling interval |
| `progress_polling_interval` | `string` | Progress polling interval |

---

### settings_auth_show / settings_auth_modify

**Modify fields:**

| Field | Type | Description |
|-------|------|-------------|
| `host` | `string` | Auth server host |
| `port` | `uint32` | Auth server port |

---

### settings_faulty_count_show / settings_faulty_count_modify

**Modify fields:**

| Field | Type | Description |
|-------|------|-------------|
| `faulty_count_threshold` | `uint32` | Error count before marking drive faulty |

---

### settings_pool_show / settings_pool_modify

**Modify fields:**

| Field | Type | Description |
|-------|------|-------------|
| `replace_delay` | `string` | Delay before spare replacement |

---

## 8. Error Handling

### gRPC Status Codes

| Status Code | Meaning | When Raised |
|-------------|---------|-------------|
| `INVALID_ARGUMENT` | Bad request parameters | `ArgumentError` in validation |
| `INTERNAL` | Server-side error | All other `ServerException` subclasses |
| `UNAVAILABLE` | Service not reachable | Connection failure |

### Error Response Format

The xiRAID gRPC server sets error information on the response context:

- `context.set_code(StatusCode)` -- gRPC status code
- `context.set_details(error_message)` -- Human-readable error string
- **Trailing metadata:**
  - `error_name` (`string`) -- Exception class name
  - `values` (`string`) -- JSON-serialized error arguments

### Exception Hierarchy

```
ServerException (base)
+-- BaseCommonError
|   +-- CommonMessageError (custom message + code)
|   +-- DKMSError
|   +-- KernelSpaceOperationError
|   +-- LogsCollectionError
+-- ConfigClientException
+-- RAIDException
+-- DriveException
+-- ... (domain-specific)
```

### Recommended Error Handling for Config-History

```python
try:
    response = await grpc_stub.raid_show(request)
    data = json.loads(response.message) if response.message else {}
    return True, data, ""
except grpc.RpcError as e:
    code = e.code()
    detail = e.details()
    if code == grpc.StatusCode.UNAVAILABLE:
        return False, None, "xiRAID service unavailable"
    elif code == grpc.StatusCode.INVALID_ARGUMENT:
        return False, None, f"Invalid request: {detail}"
    else:
        return False, None, f"gRPC error: {detail}"
```

---

## 9. Connection Configuration

### Python Client (xinas_menu pattern)

```python
# From xinas_menu/api/grpc_client.py
grpc_address = "localhost:6066"
cert_paths = [
    "/etc/xraid/crt/ca-cert.pem",
    "/etc/xraid/crt/ca-cert.crt",
    "/etc/xiraid/server.crt",
    "/etc/xinas-mcp/server.crt",
]
# TLS channel created with the first available cert
```

### TypeScript Client (xiNAS-MCP pattern)

```typescript
// From xiNAS-MCP/src/grpc/client.ts
// Reads config from /etc/xraid/net.conf (JSON: {host, port})
// Client pool per controller_id
// Retry: 5 attempts, 1s backoff on UNAVAILABLE
```

### Timeout Recommendations

| Operation | Timeout | Reason |
|-----------|---------|--------|
| `raid_show` | 10 s | May be slow with many arrays |
| `pool_show` | 5 s | Usually fast |
| `config_show` | 10 s | Reads from drives |
| `config_backup` | 15 s | Writes backup file |
| `raid_create` | 30 s | Initialization overhead |
| `raid_destroy` | 15 s | Cleanup operations |
| Read-only queries (default) | 10 s | General inspection |

---

## 10. Proto File Locations

### xiNAS repo (xiNAS-MCP)

```
xiNAS-MCP/proto/xraid/gRPC/protobuf/
├── service_xraid.proto        # XRAIDService definition (52 RPCs)
├── message_raid.proto         # RAID request/response messages
├── message_pool.proto         # Pool request/response messages
├── message_drive.proto        # Drive request/response messages
├── message_config.proto       # Config request/response messages
├── message_license.proto      # License request/response messages
├── message_settings.proto     # Settings request/response messages
├── message_mail.proto         # Mail notification messages
├── message_log.proto          # Event log messages
├── message_sdc.proto          # SDC scanning messages
└── message_cluster.proto      # Cluster operation messages
```

### xiRAID source

```
src/usr/lib/xraid/gRPC/protobuf/
├── (same proto files as above)
```

### Generated Python stubs (at deploy time)

```
xinas_menu/api/proto/
├── service_xraid_pb2.py
├── service_xraid_pb2_grpc.py
├── message_raid_pb2.py
├── message_pool_pb2.py
├── message_drive_pb2.py
├── message_config_pb2.py
├── message_license_pb2.py
├── message_settings_pb2.py
└── ... (all message types)
```
