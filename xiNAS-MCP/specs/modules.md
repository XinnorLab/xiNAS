# xiNAS-MCP — Module Map & Dependency Graph

## Module Layers

```
┌─────────────────────────────────────────────────┐
│                  MCP Client (Claude Code)         │
└────────────────────────┬────────────────────────┘
                         │ stdio / SSE
┌────────────────────────▼────────────────────────┐
│              src/server/mcpServer.ts              │
│   StdioServerTransport | SSEServerTransport       │
└────────────────────────┬────────────────────────┘
                         │
┌────────────────────────▼────────────────────────┐
│           src/registry/toolRegistry.ts            │
│   ListTools + CallTool request handlers           │
│   RBAC check → audit → dispatch → audit          │
└──────┬─────────────────────────────────────┬─────┘
       │                                     │
       ▼                                     ▼
┌─────────────────────┐         ┌────────────────────────┐
│  src/middleware/     │         │    src/tools/           │
│  rbac.ts            │         │    system.ts            │
│  audit.ts           │         │    network.ts           │
│  locking.ts         │         │    health.ts            │
│  idempotency.ts     │         │    disk.ts              │
│  planApply.ts       │         │    raid.ts              │
└─────────────────────┘         │    share.ts             │
                                │    auth.ts              │
                                │    job.ts               │
                                └───────┬─────────────────┘
                                        │
                   ┌────────────────────┼─────────────────┐
                   ▼                    ▼                   ▼
      ┌──────────────────┐  ┌────────────────┐  ┌─────────────────┐
      │   src/grpc/       │  │   src/os/       │  │  nfs-helper/    │
      │   client.ts       │  │   systemInfo.ts │  │  (Python daemon)│
      │   raid.ts         │  │   networkInfo.ts│  │  nfs_helper.py  │
      │   drive.ts        │  │   diskInfo.ts   │  │  nfs_exports.py │
      │   pool.ts         │  │   prometheusClient│  nfs_sessions.py│
      │   settings.ts     │  │   nfsClient.ts  │  │  nfs_quota.py   │
      │   license.ts      │  └────────────────┘  └────────┬────────┘
      │   config.ts       │                               │
      │   log.ts          │                      /run/xinas-nfs-helper.sock
      │   responseParser.ts│
      └────────┬──────────┘
               │ TLS gRPC :6066
      ┌────────▼──────────┐
      │  xiRAID Daemon    │
      │  XRAIDService     │
      │  (localhost:6066) │
      └───────────────────┘
```

## Data Flow: Tool Call

```
1. MCP client sends CallTool request
2. toolRegistry dispatches to handler
3. rbac.checkPermission(toolName, ctx) — throws PERMISSION_DENIED if insufficient
4. Zod schema.parse(params) — throws INVALID_ARGUMENT if malformed
5. [optional] idempotencyStore.check(key) — return cached result if hit
6. [optional] arrayLocks.withLock(arrayId, ...) — serialize conflicting ops
7. Handler executes:
   a. For plan mode: preflight() → return PlanResult
   b. For apply mode: preflight() + execute()
   c. grpc ops: getClient() → withRetry(grpcFn) → parseResponse()
   d. OS ops: direct sysfs/procfs reads
   e. NFS ops: nfsClient.send() → Unix socket → nfs-helper daemon
8. [optional] idempotencyStore.store(key, result)
9. audit.log(entry) — append to /var/log/xinas/mcp-audit.jsonl + syslog
10. Return result as MCP text content
```

## Key Interfaces Between Layers

| From | To | Interface |
|---|---|---|
| `toolRegistry` → `tools/*` | function call | Zod-parsed params, typed return |
| `tools/*` → `grpc/*` | function call | `getClient()` + typed request objects |
| `grpc/*` → xiRAID | gRPC/TLS | `XRAIDService` proto |
| `tools/share` → `os/nfsClient` | function call | `listExports()`, `addExport()` etc |
| `os/nfsClient` → `nfs-helper` | Unix socket | Newline-delimited JSON |
| `nfs-helper` → kernel NFS | `exportfs -r` | subprocess (daemon only) |
| `os/prometheusClient` → exporter | HTTP GET | Prometheus text format |
| `middleware/audit` → filesystem | `fs.appendFileSync` | JSONL log |
| `middleware/audit` → syslog | Unix socket `/dev/log` | Syslog RFC 3164 |

## File Count Summary

| Layer | Files | Lines (approx) |
|---|---|---|
| `src/types/` | 3 | 120 |
| `src/config/` | 1 | 80 |
| `src/grpc/` | 8 | 350 |
| `src/os/` | 5 | 400 |
| `src/middleware/` | 5 | 200 |
| `src/tools/` | 8 | 900 |
| `src/registry/` | 1 | 150 |
| `src/server/` | 2 | 80 |
| `nfs-helper/` | 4 | 350 |
| **Total** | **37** | **~2630** |
