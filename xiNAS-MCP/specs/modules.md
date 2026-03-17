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
                                │    config.ts            │
                                └───────┬─────────────────┘
                                        │
                   ┌────────────────────┼─────────────────┐
                   ▼                    ▼                   ▼
      ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐
      │   src/grpc/       │  │   src/os/         │  │  nfs-helper/    │
      │   client.ts       │  │   systemInfo.ts   │  │  (Python daemon)│
      │   raid.ts         │  │   networkInfo.ts  │  │  nfs_helper.py  │
      │   drive.ts        │  │   diskInfo.ts     │  │  nfs_exports.py │
      │   pool.ts         │  │   prometheusClient│  │  nfs_sessions.py│
      │   settings.ts     │  │   nfsClient.ts    │  │  nfs_quota.py   │
      │   license.ts      │  │   configHistory.ts│  └────────┬────────┘
      │   config.ts       │  └─────────┬────────┘           │
      │   log.ts          │            │           /run/xinas-nfs-helper.sock
      │   responseParser.ts│   python3 -m xinas_history
      └────────┬──────────┘            │
               │ TLS gRPC :6066  ┌─────▼─────────────┐
      ┌────────▼──────────┐      │  xinas_history    │
      │  xiRAID Daemon    │      │  (Python package)  │
      │  XRAIDService     │      └───────────────────┘
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
   b. For apply mode: preflight() + execute() + recordSnapshot()
   c. grpc ops: getClient() → withRetry(grpcFn) → parseResponse()
   d. OS ops: direct sysfs/procfs reads
   e. NFS ops: nfsClient.send() → Unix socket → nfs-helper daemon
   f. Config-history ops: configHistory → subprocess → python3 -m xinas_history
   g. Health engine ops: healthEngine → subprocess → python3 -m xinas_menu.health
8. [apply mode] recordSnapshot(operation, description) — best-effort, never blocks
9. [optional] idempotencyStore.store(key, result)
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
| `tools/config` → `os/configHistory` | function call | `listSnapshots()`, `showSnapshot()` etc |
| `tools/health` → `os/healthEngine` | function call | `runEngineCheck(profile)` |
| `middleware/planApply` → `os/configHistory` | function call | `recordSnapshot()` (best-effort) |
| `os/configHistory` → `xinas_history` | subprocess | `python3 -m xinas_history <cmd> --format json` |
| `os/healthEngine` → `xinas_menu.health` | subprocess | `python3 -m xinas_menu.health <profile> /tmp --json --no-save` |
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
| `src/os/` | 7 | 610 |
| `src/middleware/` | 5 | 240 |
| `src/tools/` | 9 | 1180 |
| `src/registry/` | 1 | 160 |
| `src/server/` | 2 | 80 |
| `nfs-helper/` | 4 | 350 |
| **Total** | **40** | **~3120** |
