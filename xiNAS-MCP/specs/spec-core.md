# Core Layer Specification

## `src/types/common.ts`

Shared primitives. No external deps.

### `ErrorCode`
Stable enum: `INVALID_ARGUMENT | NOT_FOUND | PRECONDITION_FAILED | PERMISSION_DENIED | CONFLICT | TIMEOUT | UNSUPPORTED | INTERNAL | RESOURCE_EXHAUSTION`

### `McpToolError extends Error`
```typescript
constructor(code: ErrorCode, message: string, details?: unknown)
```
Serialized to MCP response as `{ error: code, message, details }`.

### `Role`
`'viewer' | 'operator' | 'admin'`

### `Mode`
`'plan' | 'apply'`

### `PlanResult`
```typescript
{
  mode: 'plan';
  description: string;          // Human-readable action description
  changes: PlanChange[];         // What would happen
  warnings: string[];            // Non-blocking concerns
  preflight_passed: boolean;
  blocking_resources?: string[]; // Set when preflight_passed=false
}
```

### `PlanChange`
```typescript
{
  action: 'create' | 'modify' | 'delete' | 'no-op';
  resource_type: string;
  resource_id: string;
  before?: unknown;
  after?: unknown;
}
```

### `JobRecord`
```typescript
{
  job_id: string;            // UUID v4
  controller_id: string;
  tool_name: string;
  started_at: string;        // ISO 8601
  state: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  progress_pct?: number;
  result?: unknown;
  error?: string;
}
```

### `CallContext`
```typescript
{
  request_id: string;    // UUID v4 per call
  principal: string;     // Token identifier or 'local'
  role: Role;
  timestamp: string;     // ISO 8601
}
```

---

## `src/config/serverConfig.ts`

Config path: `/etc/xinas-mcp/config.json`

Auto-created on first run. Generates UUID v4 `controller_id` and persists.

### Config Schema
```json
{
  "controller_id": "uuid-v4",
  "nfs_helper_socket": "/run/xinas-nfs-helper.sock",
  "prometheus_url": "http://localhost:9827/metrics",
  "audit_log_path": "/var/log/xinas/mcp-audit.jsonl",
  "tokens": { "token-string": "viewer|operator|admin" },
  "sse_enabled": false,
  "sse_port": 8080
}
```

### Key Functions
- `loadConfig(): ServerConfig` — cached singleton
- `resolveTokenRole(token): Role | null` — lookup token in `tokens` map
- `ensureAuditLogDir(): void` — creates dir if absent

---

## `src/grpc/client.ts`

### Connection
- Reads host/port from `/etc/xraid/net.conf`
- Reads CA cert from `/etc/xraid/crt/ca-cert.{pem,crt}`
- One-way TLS (server-authenticates only)
- Default: `localhost:6066`

### Client Pool
`getClient(controllerId?)` — returns cached gRPC stub per controller ID. v1 supports single controller.

### Retry Logic
`withRetry(fn, toolName)` — 5 attempts, 1s delay on `UNAVAILABLE`. Maps gRPC status codes to `McpToolError`:

| gRPC Status | ErrorCode |
|---|---|
| `INVALID_ARGUMENT` | `INVALID_ARGUMENT` |
| `NOT_FOUND` | `NOT_FOUND` |
| `ALREADY_EXISTS` | `CONFLICT` |
| `FAILED_PRECONDITION` | `PRECONDITION_FAILED` |
| `PERMISSION_DENIED/UNAUTHENTICATED` | `PERMISSION_DENIED` |
| `DEADLINE_EXCEEDED` | `TIMEOUT` |
| `RESOURCE_EXHAUSTED` | `RESOURCE_EXHAUSTION` |
| `UNIMPLEMENTED` | `UNSUPPORTED` |
| other | `INTERNAL` |

### Proto Loading
Dynamic via `@grpc/proto-loader` — no static codegen. Root: `proto/xraid/gRPC/protobuf/`. Service: `xraid.v2.XRAIDService`.

---

## gRPC Wrapper Files

All follow the same pattern: typed request interfaces + wrapper functions calling `callRpc()`.

### `src/grpc/raid.ts`
Wraps: `raidShow, raidCreate, raidDestroy, raidModify, raidUnload, raidRestore, raidInitStart, raidInitStop, raidReconStart, raidReconStop, raidRestripeStart/Continue/Stop, raidReplace, raidResize, raidImportShow/Apply`

### `src/grpc/drive.ts`
Wraps: `driveFaultyCountShow, driveFaultyCountReset, driveLocate, driveClean`

### `src/grpc/pool.ts`
Wraps: `poolCreate, poolDelete, poolAdd, poolRemove, poolShow, poolActivate, poolDeactivate`

### `src/grpc/settings.ts`
Read-only wrappers: `settingsAuthShow, settingsFaultyCountShow, settingsLogShow, settingsMailShow, settingsPoolShow, settingsScannerShow, settingsClusterShow`

### `src/grpc/license.ts`
Wraps: `licenseShow, licenseUpdate, licenseDelete`

### `src/grpc/config.ts`
Wraps: `configBackup, configRestore, configShow, configApply`

### `src/grpc/log.ts`
Wraps: `logShow, logCollect`

### `src/grpc/responseParser.ts`
- `parseResponse(response)` — handles JSON string, plain text, and empty message
- `callRpc(method, request)` — promisify any gRPC unary call + parseResponse
