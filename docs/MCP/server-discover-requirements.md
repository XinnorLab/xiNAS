# xiNAS-MCP `server/discover` Support Requirements

> **Status:** incoming requirements, received 2026-08-24. Filed here
> because this folder is where MCP requirement documents live; note that
> the rest of `docs/MCP/` describes the **retired** standalone MCP server
> (ADR-0010) and is reference-only.
>
> **The binding design and behavior contract for this work is
> [`docs/control-path/s14-mcp-modern-era-spec.md`](../control-path/s14-mcp-modern-era-spec.md).**
> This file is the unmodified requirement text, kept so the spec can be
> audited against what was actually asked for.
>
> **Verification of third-party claims** (per `CLAUDE.md` §spec-first, rule 5)
> was performed on 2026-08-24 and is recorded in the s14 spec §2. Summary:
> the upstream `server/discover` specification and the `2026-07-28` schema
> confirm the request/response shapes below, with two documented deviations
> (§2.3's example advertises capabilities xiNAS does not implement; the
> upstream schema makes `instructions` and `serverInfo` OPTIONAL where this
> document makes them MUST — xiNAS honors the stricter local rule). The
> official TypeScript SDK has **no** modern-era support in any published
> version up to and including 1.30.0, which makes acceptance criteria 10–12
> untestable today; see s14 §8 and `docs/TODO.md`.

---

## 2. `server/discover` Support

### 2.1. General Requirements

xiNAS-MCP MUST support the `server/discover` method on every MCP endpoint and transport that advertises support for MCP `2026-07-28` or a later protocol version.

The method provides stateless discovery of:

- supported modern MCP protocol versions;
- server capabilities;
- supported MCP extensions;
- xiNAS-MCP implementation identity;
- server usage instructions.

A client MAY call `server/discover` before `initialize`, `tools/list`, `tools/call`, or any other operational MCP request.

A `server/discover` call:

- MUST NOT require a preceding `initialize` request;
- MUST NOT create a stateful MCP session;
- MUST NOT return or require an `Mcp-Session-Id`;
- MUST NOT modify xiNAS state;
- MUST be safe to execute repeatedly;
- MUST be subject to the normal authentication and authorization policies of the MCP endpoint.

The absence of a stateful session MUST NOT weaken authentication or authorization enforcement.

### 2.2. Request Format

The server MUST accept the following JSON-RPC 2.0 request shape:

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The method MUST NOT accept xiNAS-specific application parameters. Apart from the standard MCP `_meta` envelope, `params` MAY contain only metadata compatible with the MCP specification.

### 2.3. Response Format

A successful response MUST conform to `DiscoverResult` from MCP `2026-07-28` and contain:

- `resultType: "complete"`;
- `supportedVersions`;
- `capabilities`;
- `ttlMs`;
- `cacheScope`;
- server identity in `result._meta["io.modelcontextprotocol/serverInfo"]`;
- `instructions`.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "result": {
    "resultType": "complete",
    "supportedVersions": [
      "2026-07-28"
    ],
    "capabilities": {
      "tools": {},
      "resources": {},
      "extensions": {
        "io.modelcontextprotocol/tasks": {}
      }
    },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "xiNAS-MCP",
        "version": "1.0.0"
      }
    },
    "instructions": "Use xiNAS-MCP tools to inspect and manage xiNAS systems according to the permissions of the authenticated principal.",
    "ttlMs": 0,
    "cacheScope": "private"
  }
}
```

### 2.4. Response Content

#### Supported Protocol Versions

`supportedVersions` MUST:

- be a non-empty array;
- contain `2026-07-28`;
- contain only modern protocol versions that the server actually supports;
- list versions in the server's order of preference.

Legacy protocol versions, including `2025-11-25`, MUST be served through `initialize` and MUST NOT be mixed with modern version negotiation through `server/discover`.

#### Server Capabilities

`capabilities` MUST be generated from the same authoritative capability catalog used by the operational MCP handlers.

The server MUST NOT advertise a capability if the corresponding methods are unavailable on the current endpoint or within the current authorization context.

Supported extensions MUST be advertised under:

```json
capabilities.extensions
```

The server MUST NOT use a separate top-level `extensions` field in `result`.

#### Server Identity

The xiNAS-MCP implementation identity MUST be provided at:

```text
result._meta["io.modelcontextprotocol/serverInfo"]
```

The field MUST contain at least:

- `name`;
- `version`.

`serverInfo` is self-reported information. Clients MUST NOT use it as the basis for security or authorization decisions.

#### Instructions

`instructions` MUST provide concise and current guidance for an LLM client, including:

- the purpose of xiNAS-MCP;
- the permitted scope of use;
- the requirement to respect the permissions of the current principal;
- rules for operations that may modify system state.

The instructions MUST NOT duplicate individual tool descriptions or claim capabilities that the server does not provide.

#### Caching

The response MUST contain:

- `ttlMs`, as an integer greater than or equal to zero;
- `cacheScope`, set to either `public` or `private`.

If the discovery response depends on a user, role, tenant, access token, or RBAC filtering, the server MUST return:

```json
"cacheScope": "private"
```

`public` MAY be used only when the response is identical across all authorization contexts and contains no user-specific information.

### 2.5. Protocol-Era Compatibility

xiNAS-MCP MUST support the following two independent MCP protocol eras concurrently:

| Era | Protocol versions | Negotiation mechanism |
|---|---|---|
| `legacy` | Up to and including `2025-11-25` | `initialize` / `initialized` and a stateful session |
| `modern` | `2026-07-28` and later | `server/discover`, per-request `_meta`, and no mandatory MCP session |

The following compatibility requirements apply:

1. A legacy client MUST continue to connect through `initialize` without changes to the existing wire behavior.
2. A modern client MUST be able to discover `2026-07-28` through `server/discover` and execute subsequent requests without `initialize`.
3. `initialize` MUST NOT select or return a modern protocol version.
4. `server/discover` MUST NOT place the endpoint or connection into the legacy stateful mode.
5. Requests from different protocol eras MUST NOT share version-negotiation state.
6. A modern client MUST be able to execute an operational request directly, with a valid per-request `_meta` envelope, without first calling `server/discover`. Discovery is optional for clients.
7. An authentication error (`401`) or authorization error (`403`) MUST NOT be interpreted as evidence that the server does not support the modern protocol.
8. Legacy fallback MAY occur only when there is reliable evidence that modern protocol support is absent, such as a JSON-RPC `Method not found` response for `server/discover` from a legacy-only server.

### 2.6. Acceptance Criteria

Support is considered complete when automated tests demonstrate all of the following:

1. `server/discover` can be called successfully before `initialize`.
2. The call does not create an MCP session or return an `Mcp-Session-Id`.
3. The response validates against the official MCP `2026-07-28` schema.
4. The response includes `resultType`, `supportedVersions`, `capabilities`, `ttlMs`, `cacheScope`, `serverInfo`, and `instructions`.
5. `supportedVersions` contains `2026-07-28`.
6. Extensions are returned through `capabilities.extensions`.
7. Advertised capabilities match the handlers that are actually available.
8. Two consecutive calls do not modify xiNAS state and return semantically equivalent results when the configuration has not changed.
9. A direct modern operational request succeeds without a preceding discovery call.
10. The official TypeScript SDK selects the modern era when configured in `auto` mode.
11. The TypeScript SDK connects successfully without legacy fallback when pinned to `2026-07-28`.
12. The TypeScript SDK continues to connect through `initialize` when configured in `legacy` mode.
13. A legacy `2025-11-25` client retains its existing behavior.
14. A response containing RBAC-dependent capabilities uses `cacheScope: "private"`.
15. `401` and `403` responses are handled as access errors rather than signals to fall back to the legacy protocol.

## References

- [MCP `server/discover` specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/discover.mdx)
- [Official MCP `2026-07-28` schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.json)
- [Protocol versions and eras in the official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
