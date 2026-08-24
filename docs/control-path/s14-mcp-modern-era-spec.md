# xiNAS S14 — MCP modern protocol era (`server/discover`) design spec

**Status:** design (2026-08-24). Extends **ADR-0010** / `s8-clients-spec.md`
(the `/mcp` transport hosted inside `xinas-api.service`) with the MCP
**modern protocol era** introduced by MCP `2026-07-28`.

**Requirements source:** [`docs/MCP/server-discover-requirements.md`](../MCP/server-discover-requirements.md)
(unmodified incoming text). Where this spec deviates from that document it
says so explicitly in §2 and §4; the deviations are all cases where the
requirement's *illustrative example* contradicts its own *normative rule*.

**Goal.** `xinas-api`'s `/mcp` endpoint serves two MCP protocol eras from one
process and one catalog: the existing **legacy** era (`initialize` +
`Mcp-Session-Id`, unchanged) and a new **modern** era (`server/discover`,
per-request `_meta`, no session). Neither era's negotiation state is visible
to the other.

---

## 1. Scope

### In scope

- **T1** `server/discover` on the `/mcp` Streamable HTTP endpoint, on the
  dedicated `config.mcp.http` listener, and through the `xinas-mcp-stdio`
  adapter — stateless, no `Mcp-Session-Id`, no state mutation.
- **T2** Stateless modern-era `tools/list` and `tools/call`: a modern client
  MAY execute an operational request directly, with no preceding
  `server/discover` and no session (requirement §2.5.6).
- **T3** Era isolation: `initialize` never selects or returns a modern
  version; `server/discover` never opens a legacy session; the two eras share
  no negotiation state.
- **T4** Capability generation from the same `CATALOG` the operational
  handlers use — one authority, no second table.
- **T5** Tests covering acceptance criteria 1–9 and 13–15.

### Out of scope

- MCP resources and prompts (still deferred by ADR-0010) — and therefore
  **not advertised** in `capabilities`.
- The MCP `tasks` extension (`io.modelcontextprotocol/tasks`). xiNAS has its
  own asynchronous task envelope over REST (`s2-task-envelope-spec.md`) plus
  the `next` hint in tool results; that is *not* the MCP tasks extension and
  advertising it would be a false claim.
- Acceptance criteria 10, 11, 12 (official TypeScript SDK era selection) —
  not implementable against any published SDK; see §8 and `docs/TODO.md`.

---

## 2. Verified third-party facts

Checked 2026-08-24 against vendor sources, per `CLAUDE.md` §spec-first rule 5.

| Claim | Source | Verdict |
|---|---|---|
| `server/discover` exists in MCP `2026-07-28`; params carry only the standard `_meta`; `_meta` keys are `io.modelcontextprotocol/protocolVersion`, `…/clientInfo`, `…/clientCapabilities` | [`docs/specification/2026-07-28/server/discover.mdx`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/discover.mdx) | **Confirmed** |
| `DiscoverResult` required fields are `resultType`, `supportedVersions`, `capabilities`, `cacheScope`, `ttlMs`; `cacheScope` is the enum `["private","public"]`; `ttlMs` is an integer with minimum 0 | [`schema/2026-07-28/schema.json`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.json) — `DiscoverResult.required = ["cacheScope","capabilities","resultType","supportedVersions","ttlMs"]` | **Confirmed** |
| `instructions` and `_meta["io.modelcontextprotocol/serverInfo"]` are **OPTIONAL** upstream (`instructions` optional; `serverInfo` a SHOULD) | same schema + discover.mdx | **Deviation, deliberate.** The requirement document makes both MUST. A response that always carries them is schema-valid, so xiNAS follows the stricter local rule. |
| Discovery is optional for clients; inline invocation with error handling is a supported alternative | discover.mdx | **Confirmed** — this is requirement §2.5.6, and it is why §5 exists. |
| Two eras: legacy `2024-10-07`…`2025-11-25` via `initialize`; modern from `2026-07-28` via `server/discover` + `_meta` envelope. SDK modes: default/legacy, `auto` (probe then fall back), pinned (never falls back, rejects with `SdkError(EraNegotiationFailed)`) | [typescript-sdk `docs/protocol-versions.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) | **Confirmed** |
| **The published `@modelcontextprotocol/sdk` does not implement the modern era.** `1.30.0` (latest on npm, 2026-08-24) has `LATEST_PROTOCOL_VERSION = '2025-11-25'`, `SUPPORTED_PROTOCOL_VERSIONS` topping out there, and **zero** occurrences of `server/discover`, `2026-07-28`, or `versionNegotiation` in its published `dist/`. The repo installs `^1.12.0` and resolves `1.27.1`, which is likewise legacy-only. | `npm pack @modelcontextprotocol/sdk@1.30.0` + grep of the published tarball | **Confirmed absent.** Drives §5 (hand-rolled handling, not SDK handling) and §8. |

**Consequence of the last row.** The modern era cannot be implemented *through*
the SDK `Server` class: it has no `DiscoverRequestSchema`, and
`StreamableHTTPServerTransport` rejects any non-`initialize` POST that carries
no `Mcp-Session-Id`. Modern-era requests are therefore handled **ahead of** the
SDK transport, by xiNAS code, against the same catalog (§5). The SDK keeps
serving the legacy era untouched — which is exactly what requirement §2.5.1
asks for.

---

## 3. Era model

| Era | Versions | Entry point | Session | Handled by |
|---|---|---|---|---|
| `legacy` | ≤ `2025-11-25` | `initialize` / `initialized` | `Mcp-Session-Id`, required on every later request | SDK `Server` + `StreamableHTTPServerTransport` (unchanged) |
| `modern` | `2026-07-28` | `server/discover` (optional) | none, ever | `src/api/mcp/modern.ts`, ahead of the SDK transport |

**Era classification of an inbound `/mcp` POST**, evaluated in this order:

1. `method === 'server/discover'` → **modern**, always. The method does not
   exist in any legacy revision, so there is no ambiguity.
2. `params._meta['io.modelcontextprotocol/protocolVersion']` is present and is
   a member of `MODERN_PROTOCOL_VERSIONS` → **modern**.
3. otherwise → **legacy**; the request goes to the SDK transport exactly as
   before, including the `Mcp-Session-Id` path.

A modern request is never routed into the SDK transport, and a legacy request
never reaches the modern handler. Requirement §2.5.5 ("requests from different
protocol eras MUST NOT share version-negotiation state") holds structurally:
the modern path keeps no per-connection state at all, so there is nothing to
share.

An `Mcp-Session-Id` header present on a modern request is **ignored** — not an
error, and not a reason to route legacy. The stdio adapter caches a session id
once a legacy session exists and replays it on every later POST; a modern
`server/discover` through the same adapter must still be answered statelessly.

`initialize` MUST NOT return a modern version (requirement §2.5.3). This holds
by construction — the SDK negotiates only from its own
`SUPPORTED_PROTOCOL_VERSIONS`, which ends at `2025-11-25` — and is pinned by a
test so a future SDK bump cannot silently change it.

---

## 4. `server/discover` response

```jsonc
{
  "resultType": "complete",
  "supportedVersions": ["2026-07-28"],
  "capabilities": { "tools": {} },
  "_meta": {
    "io.modelcontextprotocol/serverInfo": { "name": "xinas-api-mcp", "version": "<pkg>" }
  },
  "instructions": "…",
  "ttlMs": 0,
  "cacheScope": "private"
}
```

**`supportedVersions`** — `MODERN_PROTOCOL_VERSIONS`, in the server's order of
preference. Contains `2026-07-28` and nothing else today. It carries **no**
legacy version: requirement §2.4 forbids mixing eras in this field, and legacy
versions remain reachable only through `initialize`.

**`capabilities`** — derived from `CATALOG`, the same table the operational
`tools/list` and `tools/call` handlers read.

- `tools: {}` — present whenever the catalog exposes at least one
  MCP-visible entry (`binary !== true`), which it always does.
- `resources`, `prompts` — **absent.** No handler exists (ADR-0010 defers
  them), and requirement §2.4 forbids advertising a capability whose methods
  are unavailable.
- `extensions` — **absent** while no MCP extension is implemented. When one
  lands it goes under `capabilities.extensions`; there is never a top-level
  `result.extensions`.

> **Deviation from the requirement document's example.** Requirement §2.3's
> sample response advertises `resources: {}` and
> `extensions: {"io.modelcontextprotocol/tasks": {}}`. xiNAS implements
> neither, so emitting them would violate the requirement's own normative
> rule in §2.4 ("MUST NOT advertise a capability if the corresponding methods
> are unavailable"). The normative rule wins; the example is treated as
> illustrative.

**`_meta["io.modelcontextprotocol/serverInfo"]`** — `{name, version}`, the
**same constant** the legacy `initialize` reports. One server, one identity
across both eras; a single exported `SERVER_INFO` makes drift impossible.

**`instructions`** — concise LLM-facing guidance covering the four points
required by §2.4: what xiNAS-MCP is for, the permitted scope, the requirement
to respect the current principal's permissions, and the rule for
state-changing operations (plan/apply, and that `apply` is refused unless
`mcp.allow_apply` is set). It does not restate individual tool descriptions —
`tools/list` owns those.

**`ttlMs: 0`** — the response is not cacheable. `capabilities` depends on the
live catalog and `instructions` mentions the runtime `mcp.allow_apply` gate,
which an operator can change under a running api; a non-zero TTL would let a
client act on a stale gate.

**`cacheScope: "private"`** — mandatory here per requirement §2.4: the endpoint
authenticates the caller and resolves a role, so the response is produced
inside an authorization context. `public` would be a claim that the answer is
identical for every principal, which xiNAS cannot make.

**Determinism.** Two consecutive calls with unchanged configuration return
deeply equal results, and the handler performs no writes: it reads `CATALOG`
(a module constant) and config, and touches neither the state store nor the
agent (acceptance criterion 8).

---

## 5. Stateless modern operational requests

Requirement §2.5.6 makes discovery optional, so `tools/list` and `tools/call`
must work with a modern `_meta` envelope and **no** session. Because the SDK
cannot serve that path (§2), the tool logic is lifted out of the SDK request
handlers into two plain functions:

```ts
listTools(): Tool[]
callTool(name: string, args: Record<string, unknown>, opts: DispatcherOptions): Promise<ToolResult>
```

`buildMcpServer` wires exactly these two into `ListToolsRequestSchema` /
`CallToolRequestSchema` (legacy era), and the modern handler calls them
directly. **There is one implementation of tool listing and one of tool
dispatch**, so the apply gate, the legacy-tool-name pointers, the RBAC
forwarding, the loopback token and the audit row behave identically in both
eras — which is what makes acceptance criterion 7 ("advertised capabilities
match the handlers that are actually available") true rather than asserted.

Unknown modern methods return JSON-RPC `-32601` **Method not found**, per
JSON-RPC 2.0.

A modern **notification** (a message with no `id`) is answered with an empty
HTTP `202` and no response object, matching what the SDK transport does for
the legacy era. The stdio adapter independently drops responses to id-less
messages, so both transports behave the same.

---

## 6. Authentication and authorization

`server/discover` and stateless modern calls resolve identity with the same
`resolveIdentity` the legacy path uses (bearer → `config.tokens`; no bearer
over the UNIX socket → `mcp:local_admin` admin per ADR-0001; no bearer over
TCP → refused). Statelessness changes nothing here — identity is resolved per
request instead of once per session.

Failure returns **HTTP 401** with a JSON-RPC error, exactly as the legacy path
already does for an unopened session.

**It must not return `-32601`.** Requirement §2.5.7–8 makes `Method not found`
on `server/discover` the *one* reliable signal that a server is legacy-only,
and 401/403 explicitly not such a signal. Answering an unauthenticated
discover with `-32601` would tell every client with a bad token that this
server has no modern support, and they would silently downgrade. The
authentication check therefore runs **before** method routing on the modern
path, and the tests pin it.

Authorization of the *work itself* is unchanged: a modern `tools/call` replays
through the loopback under the caller's real principal and role, and
`rbacMiddleware` enforces `min_role` there.

---

## 7. Wiring

- `src/api/mcp/discover.ts` — `MODERN_PROTOCOL_VERSIONS`, `SERVER_INFO`,
  `INSTRUCTIONS`, `buildDiscoverResult()`, `buildCapabilities()`.
- `src/api/mcp/modern.ts` — era classification, notification detection, and
  the stateless JSON-RPC handler for `server/discover`, `tools/list`,
  `tools/call`.
- `src/api/mcp/dispatch.ts` — `listTools()` / `callTool()` extracted;
  `buildMcpServer` becomes a thin wiring of the two.
- `src/api/mcp/transport.ts` — a `/mcp`-scoped `express.json()` parser (the
  endpoint is mounted ahead of the global one, so the modern handler needs its
  own), then: era classify → modern handler, or fall through to the existing
  session/SDK path. The parser's limit is the SDK's own 4 MB
  `MAXIMUM_MESSAGE_SIZE`, not the api-wide 1 MB: `StreamableHTTPServerTransport`
  applies no limit of its own, so a tighter cap would change legacy behavior
  (AC13).
- `src/mcp-stdio.ts` — **no change.** It is a per-message bridge; a
  `server/discover` line is forwarded and its answer returned verbatim. The
  cached `mcp-session-id` it may attach is ignored by the modern path (§3).

The `/mcp` audit skip and the "exactly one audit row per operation" rule
(s8 §T2b) are unaffected: `server/discover` performs no loopback call and so
writes no audit row, and a modern `tools/call` writes exactly the one row its
loopback request produces.

---

## 8. Acceptance criteria coverage

| # | Criterion | Covered by |
|---|---|---|
| 1 | `server/discover` before `initialize` | `mcp-discover.test.ts` |
| 2 | no session, no `Mcp-Session-Id` | `mcp-discover.test.ts` (response header absent; later legacy `initialize` still mints a fresh session) |
| 3 | validates against the `2026-07-28` schema | `mcp-discover.test.ts` — required-field and enum/type assertions taken from §2's schema row |
| 4 | all of `resultType`, `supportedVersions`, `capabilities`, `ttlMs`, `cacheScope`, `serverInfo`, `instructions` | `mcp-discover.test.ts` |
| 5 | `supportedVersions` contains `2026-07-28` | `mcp-discover.test.ts` (and asserts no legacy version leaks in) |
| 6 | extensions under `capabilities.extensions`, never top-level | `mcp-discover.test.ts` |
| 7 | advertised capabilities match available handlers | `mcp-discover.test.ts` — `resources`/`prompts` absent, `tools` present iff the catalog has MCP-visible entries |
| 8 | two calls: no state change, semantically equal | `mcp-discover.test.ts` |
| 9 | direct modern operational request without discovery | `mcp-discover.test.ts` — stateless `tools/list` + `tools/call` |
| 10 | official SDK selects modern in `auto` mode | **Not implementable** — see below |
| 11 | official SDK pinned to `2026-07-28` connects | **Not implementable** — see below |
| 12 | official SDK in `legacy` mode uses `initialize` | `mcp-integration.test.ts` (existing, real SDK client) |
| 13 | legacy `2025-11-25` client keeps existing behavior | `mcp-transport.test.ts` + `mcp-integration.test.ts` (existing), plus a new assertion that `initialize` never returns a modern version |
| 14 | RBAC-dependent capabilities ⇒ `cacheScope: "private"` | `mcp-discover.test.ts` |
| 15 | 401/403 handled as access errors, not legacy signals | `mcp-discover.test.ts` — unauthenticated discover returns HTTP 401 and **not** `-32601` |

**10 and 11 are blocked on the ecosystem, not on xiNAS.** No published
`@modelcontextprotocol/sdk` (≤ 1.30.0) implements the modern era, so there is
no `versionNegotiation: 'auto'` to exercise and no way to pin a client to
`2026-07-28`. The server side of both criteria is covered by hand-rolled
JSON-RPC clients in `mcp-discover.test.ts`, which speak the exact wire format
those SDK modes will produce. Recorded in `docs/TODO.md`; the work is to bump
the SDK and add the two client-side tests once it ships modern support.
