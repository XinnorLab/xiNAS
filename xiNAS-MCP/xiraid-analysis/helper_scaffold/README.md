# xiRAID gRPC Client — TypeScript Scaffold for xiNAS-MCP

## Key Finding: No Helper Daemon Required

The REQUIREMENTS.md §8.1 assumed a helper daemon would be needed because xiNAS only uses `xicli`. The source analysis reveals that **xiRAID already ships a full gRPC management API**. xiNAS-MCP connects directly — no intermediate process required.

## Architecture

```
xiNAS-MCP (TypeScript MCP Server)
  │
  │  TLS gRPC (one-way TLS, port 6066 default)
  │
  ▼
xiRAID daemon (xraid-server.service)
  │  reads/writes
  ▼
/etc/xraid/*.conf  +  kernel module (/sys/module/xraid/)
```

## Prerequisites

```bash
npm install @grpc/grpc-js @grpc/proto-loader
```

For static code generation (optional, recommended for type safety):
```bash
npm install -D grpc-tools grpc_tools_node_protoc_ts
```

## Proto Files

Copy from the xiRAID source tree (read-only — do not modify xiRAID):

```
src/usr/lib/xraid/gRPC/protobuf/
  service_xraid.proto      ← service definition
  message_raid.proto       ← RAID messages
  message_drive.proto      ← drive messages
  message_pool.proto       ← spare pool messages
  message_settings.proto   ← settings messages
  message_config.proto     ← config messages
  message_license.proto    ← license messages
  message_cluster.proto    ← cluster messages
  message_log.proto        ← log messages
  message_mail.proto       ← mail messages
  message_sdc.proto        ← SDC scanner messages
```

Place copies under `src/proto/xraid/gRPC/protobuf/` in this project.
The import paths inside the protos use `xraid/gRPC/protobuf/` as the root.

## Connection Configuration

| Parameter | Source | Default |
|---|---|---|
| host | `/etc/xraid/net.conf` → `host` key | `localhost` |
| port | `/etc/xraid/net.conf` → `port` key | `6066` |
| CA cert | `/etc/xraid/crt/ca-cert.pem` or `ca-cert.crt` | — |

The config file is managed by the `FileUnifiedConfigurationKeeper` internal server.
Read it directly as JSON at startup and cache it. Re-read on SIGHUP if hot-reload is needed.

## Files in This Scaffold

| File | Purpose |
|---|---|
| `src/xraidClient.ts` | gRPC client factory and connection management |
| `src/xraidRaid.ts` | Typed wrappers for all `raid_*` RPCs |
| `src/xraidDrive.ts` | Typed wrappers for all `drive_*` RPCs |
| `src/xraidPool.ts` | Typed wrappers for all `pool_*` RPCs |
| `src/responseParser.ts` | Safe JSON parsing for `ResponseMessage.message` |

## Security Notes

- The MCP server process must run as **root** (UID 0) to call any mutating RPC.
  Read-only RPCs (`raid_show`, `pool_show`, etc.) may work as non-root.
- The CA cert at `/etc/xraid/crt/ca-cert.{pem,crt}` is root-readable only by default.
  Ensure the MCP server service account has read access.
- Do **not** expose the Config Server (`localhost:14088`) — it uses a session-scoped
  random token and is not designed for external clients.

## Usage Pattern

```typescript
import { createXRaidClient } from './xraidClient';
import { raidShow, raidCreate } from './xraidRaid';

const client = await createXRaidClient();

// List all RAIDs
const raids = await raidShow(client, {});

// Create a RAID
await raidCreate(client, {
  name: 'data',
  level: '5',
  drives: ['/dev/nvme1n2', '/dev/nvme2n2', '/dev/nvme3n2'],
  strip_size: 16,
  block_size: 4096,
});
```
