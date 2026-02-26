# MCP Server Specification

## Entry Point: `src/index.ts`

```typescript
import { startMcpServer } from './server/mcpServer.js';
startMcpServer().catch(err => { process.stderr.write(err); process.exit(1); });
```

## `src/server/mcpServer.ts`

### Initialization Sequence
1. `loadConfig()` — reads/creates `/etc/xinas-mcp/config.json`
2. `new Server({ name: 'xinas-mcp', version: '0.1.0' }, { capabilities: { tools: {} } })`
3. `registerAllTools(server)` — sets `ListTools` + `CallTool` handlers
4. Connect transport:
   - `sse_enabled=false` (default): `StdioServerTransport`
   - `sse_enabled=true`: `SSEServerTransport` on `config.sse_port ?? 8080`

### Transports
| Transport | Config | Usage |
|---|---|---|
| stdio | default | Claude Code integration (`mcpServers` in config) |
| SSE | `sse_enabled: true` | Remote/web clients |

## `src/server/controllerResolver.ts`

### `resolveController(controllerId?)`
- Accepts: the local `controller_id` from config, or `undefined` (default to local)
- Rejects: any other value with `McpToolError(NOT_FOUND)`
- Returns: `ControllerInfo { controller_id, hostname, grpc_endpoint, nfs_socket }`

v1 is single-node. Multi-node federation is out of scope.

## `src/registry/toolRegistry.ts`

### Registration
`registerAllTools(server)` sets two MCP request handlers:

#### `ListTools`
Returns array of `{ name, description, inputSchema }` for all 33 tools.
`inputSchema` is JSON Schema 7 derived from Zod schema via `zod-to-json-schema`.

#### `CallTool`
Per-call flow:
1. Look up tool by name (404 if unknown)
2. Build `CallContext` (UUID request_id, resolve role from token or 'admin' for stdio)
3. `checkPermission(name, ctx)` — RBAC
4. `tool.schema.parse(args)` — Zod validation
5. `await tool.handler(parsed)` — execute
6. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
7. On error: return `{ content: [...error JSON...], isError: true }`
8. `finally`: `AuditLogger.log(...)` — always runs

### Error Response Format
```json
{ "error": "ERROR_CODE", "message": "Human-readable message", "details": {} }
```

## Claude Code Integration

Add to `~/.claude/mcp_servers.json`:
```json
{
  "xinas": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/xiNAS-MCP/dist/index.js"]
  }
}
```

Or using `tsx` for development:
```json
{
  "xinas": {
    "type": "stdio",
    "command": "tsx",
    "args": ["/path/to/xiNAS-MCP/src/index.ts"]
  }
}
```

## Development Workflow

```bash
# Type-check only (fast)
npm run typecheck

# Run without build (tsx)
npm run dev

# Build to dist/
npm run build

# Run built server
npm start

# Test tools/list
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```
