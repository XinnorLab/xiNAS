# xiNAS S17 — MCP subscriptions and operational event feeds (design spec)

**Status:** implemented 2026-09-07 (Phase 1; design validated 2026-09-04).
Deviations found while implementing are recorded inline where they
apply — §5.4 (`Connection: close` on the listen response), §13 (`/events`
access stays the RBAC admin default), and the agent spec's S17 amendment
item 4 (test-only poll-cadence overrides). Product-client smoke rows
(§16) are pending. Extends **ADR-0010** /
`s8-clients-spec.md` (the `/mcp` transport inside `xinas-api.service`),
**S14** (`s14-mcp-modern-era-spec.md`, the MCP `2026-07-28` modern era),
**S15** (`s15-mcp-mrtr-confirmation-spec.md`), the **S16** requirements
(`s16-mcp-tasks-requirements.md`), **S3/S4** (xiRAID observation and
mutation), **S5** (filesystems), **S6** (network), **S7** (health and drift)
and the **S0/S1 agent** specification.

**Requirements source:**
[`s17-mcp-subscriptions-requirements.md`](s17-mcp-subscriptions-requirements.md)
(unmodified incoming text; its Appendix D is the validation record this spec
cites as `V-nn`, Appendix E the decisions `D-13`…`D-25`). Where this spec
deviates from that document it says so inline and points at the row that
forced it.

**Protocol sources (normative, verified 2026-09-04):** the released MCP
`2026-07-28` [`schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts),
[Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions),
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources),
[Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching).
**Product sources:** xiRAID Classic 4.4
[Showing RAID State](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html),
[Setting up email notifications](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/setting_up_email_notifications.html).

**Goal.** A modern MCP client learns that something operationally
significant happened to a RAID array, a filesystem, the NFS service or the
node — without polling every object — through the standard MCP `2026-07-28`
`subscriptions/listen` request and `notifications/resources/updated`. The
notification is a wake-up only; every event is first committed to a durable,
retained, cursor-addressable journal that the client reads through MCP
Resources. Events are derived from committed observed-state transitions and
trusted xiNAS state; a failed or stale source never produces a removal, an
outage or a recovery.

---

## 1. Scope

### In scope (Phase 1)

- **T0 contracts:** this spec; ADR-0010, S14, S16-requirements, S3, S4, S5,
  S6, S7, agent-spec and notification-spec amendments; additive
  `api-v1.yaml` changes (§13).
- **T1 journal:** SQLite table `operational_events` + `operational_event_meta`
  (migration `007`), the `EventJournal` store, cursors, bounded retention
  (§7).
- **T2 envelope:** the event schema, bounds, redaction and the closed
  vocabularies (§6).
- **T3 xiRAID observation correction:** raw state words and the four
  separate progress values on `XiraidArray.status` (§8.1).
- **T4 transition engine:** the per-kind producers that run *inside* the
  observation-ingest transaction, the batch-level rules (baseline, source
  failure, debounce), the heartbeat and reboot producers (§8).
- **T5 MCP Resources:** `resources/list`, `resources/templates/list`,
  `resources/read` for the six feeds on the modern path (§4).
- **T6 `subscriptions/listen`:** over Streamable HTTP (SSE) and through the
  `xinas-mcp-stdio` adapter; limits, coalescing, keep-alive, graceful close,
  slow-consumer handling (§5).
- **T7 discovery:** `resources: { subscribe: true, listChanged: false }`
  advertised only when the whole surface is installed (§3).
- **T8 authorization, audit, metrics, configuration** (§9–§12).
- **T9 REST projection:** `GET /events` served from the journal (§13).
- **T10 tests:** unit transition tables, contract (vendored MCP schema +
  OpenAPI fixtures), api (raw JSON-RPC over HTTP), interop (the v2 client),
  e2e (fixture-mode agent + fake xiRAID) (§15).

### Out of scope

- Everything in requirement §3 (non-goals) and §22–§25 (Phase 2), including
  restripe/SDC/maintenance events, NFSv4 grace, nfsd counters, inode/quota,
  SLO and HA events.
- `nfs.configuration.drift_*` (requirement SUBS-NFS-005 is a MAY; deferred,
  `docs/TODO.md`).
- Producers for the **source-gated families** (D-16): `raid.device.*`,
  `raid.license.*`, `raid.spare.replacement.failed`, `storage.disk.*`. Their
  types, severities and envelopes are fixed here; a producer lands together
  with the collector that gives it a validated periodic source.
- `MCP-Protocol-Version` header validation (D-25, an S14 gap).
- Migrating the server onto the v2 `@modelcontextprotocol/server` package
  (S14 §2 consequence paragraph stands).
- TUI alert management, outbound email/webhook delivery.

---

## 2. Verified facts this design rests on

The validation record (requirements Appendix D) is the source; the rows
that shape the design are:

| Fact | Row |
|---|---|
| Listen/ack/update/result wire shapes and the stdio/HTTP cancellation rules are as the requirement states; teardown is the `subscriptions/listen` result | V-01…V-12, D-13 |
| A `resources/read` may legally be an MRTR; feeds reject that | V-13, D-15 |
| Observation ingest already runs previous-vs-current in one SQLite transaction | V-40 |
| A failed collector sweep sends no complete snapshot, so the api never sees a false deletion | V-35 |
| The stdio adapter is a serial per-message bridge and must change | V-42, D-19 |
| No periodic license / media / disk-health source exists | V-23, V-38, D-16 |
| No S15 metrics registry exists on this branch | V-39, D-17 |
| No boot id, no per-kind freshness, `xinas-mcp.service` retired | V-51, V-50, V-25 |
| The v2 client implements `listen()` and can be the interop harness | V-27 |

---

## 3. Discovery and capability truthfulness

`server/discover` (S14 §4) gains:

```jsonc
"capabilities": { "tools": {}, "resources": { "subscribe": true, "listChanged": false } }
```

**Only** when `ApiContext.events` is present — i.e. the journal opened, the
migration ran, the retention sweeper started and the resource + listen
handlers are wired (`server.ts`). `buildCapabilities(ctx)` therefore takes
the context; the S14 unit context without a journal keeps advertising
`tools` only, and the S14 test that pins "`resources` absent" moves to
"absent without a journal, present with one".

S16 (`s16-mcp-tasks-spec.md` §3.2, 2026-09-04) adds
`extensions: { "io.modelcontextprotocol/tasks": {} }` to the same object,
gated on its own readiness; the two advertisements are independent.

`listChanged` is `false` and stays `false` in Phase 1: the six resources
are constant for the process lifetime, so `resourcesListChanged` in a listen
filter is never honored (§5.2). `prompts` stays absent.

**Composition with other resource owners (V-73, D-26).** S18 (MCP Apps,
`s18-mcp-raid-create-app-spec.md`, in flight on a sibling branch) also
serves resources on the modern path (`ui://xinas/raid-create`). The
`resources` capability object is the union: `subscribe` is `true` iff the
S17 feeds are installed, `listChanged` is `false`, and the object is present
when any provider has resources. `resources/list` returns the six feeds
first, in the §4.1 order, followed by other providers' resources;
`resources/read` dispatches on the URI scheme (`xinas://events/` → feeds;
anything else → the other providers, else `-32602`); `subscriptions/listen`
honors only feed URIs (a `ui://` entry is "unknown", §5.2). The provider
seam is `api/mcp/resources.ts` (`ResourceProvider { list, templates, read,
subscribable }`); S17 registers the feed provider, S18 registers its app
provider at merge time. There is **no**
configuration switch that advertises a partial capability (requirement
SUBS-CONFIG-001): `mcp.subscriptions.enabled: false` removes
the feeds: `resources` stays advertised for the S18 view with
`subscribe: false` (S18 merged 2026-09-07), `resources/list` and
`resources/read` serve only the view, `resources/templates/list` is empty,
`subscriptions/listen` is refused with `-32601`, and the journal keeps
recording (the REST projection still works).

The legacy era (`initialize` + `Mcp-Session-Id`) never sees the feeds: the
SDK server answers `subscriptions/listen` and feed URIs as before (method
not found / unknown resource); since S18 it advertises `resources: {}` and
serves only the MCP Apps view there. Era classification is S14's (`isModernRequest`), and
`Mcp-Session-Id` is still ignored on the modern path (SUBS-PROTO-004).

---

## 4. Resources

### 4.1 Catalog (`resources/list`)

Six feed resources, in this order, always present, independent of
collector health (SUBS-RES-001), listed before any other provider's
resources (§3):

| `uri` | `name` | `description` |
|---|---|---|
| `xinas://events/raid` | `RAID events` | xiRAID array, operation, member, spare, restore, media and license transitions |
| `xinas://events/raid/progress` | `RAID progress` | Bucketed initialization and reconstruction progress (high-frequency; opt-in) |
| `xinas://events/storage` | `Storage events` | Filesystem mount, read-only, capacity and disk-health transitions |
| `xinas://events/nfs` | `NFS events` | NFS service, export, backing-filesystem and NFS-over-RDMA readiness transitions |
| `xinas://events/nfs/sessions` | `NFS session events` | Client session connect/disconnect, protocol and lock-threshold transitions (high-frequency; opt-in; carries client addresses) |
| `xinas://events/system` | `System events` | xiNAS service, agent, collector, network/RDMA link and reboot transitions |

Every entry: `mimeType: "application/vnd.xinas.events+json"`, no
`annotations`, no `size`, no `_meta`, no icons. The result:

```jsonc
{ "resultType": "complete", "resources": [ …6… ], "ttlMs": 0, "cacheScope": "private" }
```

`nextCursor` is never emitted. A `params.cursor` (the pagination cursor —
unrelated to feed cursors) is `-32602`: the server never issued one (V-17).

### 4.2 Templates (`resources/templates/list`)

One template per feed, same order, `uriTemplate` = `<base>{?after,limit}`
(RFC 6570 form-style query expansion), same `name`/`mimeType` as the base
resource, description suffixed with the words `(cursor read)`. Same result meta as
§4.1. Templates are readable, never subscribable (§5.2).

### 4.3 URI grammar and parsing

Accepted URIs are parsed by an allow-list, never by the platform URL
parser's permissive rules:

```text
uri        = "xinas://events/" feed [ "?" query ]
feed       = "raid" | "raid/progress" | "storage" | "nfs" | "nfs/sessions" | "system"
query      = param *( "&" param )
param      = "after=" cursor | "limit=" 1*3DIGIT
```

Rules (SUBS-RES-007): scheme exactly `xinas`, host exactly `events`, path
exactly one of the six; no fragment; no empty query pairs; no unknown key;
`after` and `limit` at most once each; `limit` an integer 1–500; `after` a
syntactically valid cursor (§7.4). Percent-encoding is accepted only for
`after` (cursors are base64url and never need it). Anything else is
`-32602 invalid params` with a fixed message (`invalid resource uri`) that
names no journal content. Nothing here is ever resolved against a path, a
URL fetcher or a command.

### 4.4 Read (`resources/read`)

Request checks in order: modern `_meta` (S14); `params.uri` is a string;
`inputResponses`/`requestState` absent (D-15, else `-32602`); URI grammar
(§4.3); authorization (§9). The result:

```jsonc
{
  "resultType": "complete",
  "contents": [ { "uri": "<exactly the requested uri>", "mimeType": "application/vnd.xinas.events+json", "text": "<envelope JSON>" } ],
  "ttlMs": 0,
  "cacheScope": "private"
}
```

The feed read envelope (the `text` JSON), fields fixed by SUBS-RES-004 plus
one optional addition:

```jsonc
{
  "schemaVersion": "1",
  "feed": "raid",                       // the feed id without the xinas://events/ prefix
  "events": [ …EventEnvelope… ],        // ascending sequence
  "nextCursor": "…",                    // last returned event, or the supplied cursor / current head when none
  "oldestAvailableCursor": "…",         // position just before the oldest retained row
  "headCursor": "…",                    // position at the newest committed row (any feed)
  "hasMore": false,
  "gap": false,
  "generatedAt": "2026-09-04T12:00:00.000Z",
  "producers": {                        // optional (V-58): event families of this feed and their state
    "active": ["raid.operation", "raid.state", "raid.member", "raid.spare", "raid.restore"],
    "inactive": [ { "family": "raid.device", "reason": "no periodic error-count or wear source" },
                  { "family": "raid.license", "reason": "no periodic license source" } ]
  }
}
```

Ordering, paging and cursor semantics (SUBS-RES-005/006), with `S` the
sequence a cursor denotes ("everything in this feed up to and including
`S` has been seen"), `oldest` the smallest retained sequence in the whole
table, `last` the last allocated sequence (`sqlite_sequence`):

| Read | Rows returned | `nextCursor` | `gap` |
|---|---|---|---|
| no `after` | the newest `limit` rows of the feed, returned ascending | last returned row, or `headCursor` when the feed is empty | `false` |
| `after` with `S ≥ oldest − 1` | rows of the feed with `sequence > S`, ascending, at most `limit` | last returned row, or the supplied cursor when none | `false` |
| `after` with `S < oldest − 1` (or the table is empty and `S < last`) | rows of the feed with `sequence ≥ oldest`, ascending, at most `limit` | as above | `true` |
| `after` with `S > last`, a different controller id, a different feed, a bad tag or version | — | — | `-32602` |

`hasMore` is true when another retained row of the feed exists after the
last returned one. `oldestAvailableCursor` denotes `oldest − 1` (reading
after it yields the oldest row); when the table is empty it equals
`headCursor`. `headCursor` denotes `last`. A gap is not an error and never
maps to `-32603`. Clients that want only future events read once with
`limit=1`, keep `headCursor`, then subscribe (SUBS-RES-005).

Reads are not audited individually (SUBS-AUD-001); they count in
`xinas_mcp_event_reads_total`.

---

## 5. `subscriptions/listen`

### 5.1 Request validation (SUBS-LISTEN-001)

A modern request (S14 `_meta`) with method `subscriptions/listen`, a
JSON-RPC `id` (string or number — echoed with its original type, V-28), and
`params.notifications` an object whose keys are a subset of
`{toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions}`
with the schema's types. Any other key anywhere in `params` (other than
`_meta`) is `-32602`. `resourceSubscriptions` entries must be strings; more
than `max_uris_per_listen` (default 6) entries **after** deduplication is
`-32602` with message `too many resource subscriptions`. A missing `id` is a
notification and gets the S14 empty `202`.

Pre-acknowledgment failures (validation, limits, authorization) are
ordinary JSON responses (`application/json`, one JSON-RPC error object); the
SSE stream is opened only after every check passed, so a rejected listen
never leaves a partial listener (SUBS-LIMIT-001). The v2 client treats a
JSON error for the listen id as the pre-ack rejection (V-27).

### 5.2 Filter acceptance (SUBS-LISTEN-002)

| Requested | Acknowledged |
|---|---|
| `toolsListChanged: true` | omitted (S14 has no tool-list change source) |
| `promptsListChanged: true` | omitted (no prompts) |
| `resourcesListChanged: true` | omitted (static list, §3) |
| `resourceSubscriptions: [...]` | the subset of entries that are one of the six **base** URIs (no query, no fragment, byte-exact) and that the principal may read (§9), deduplicated, first occurrence order |

An unknown URI and an unauthorized URI are both silently omitted — the
acknowledgment cannot distinguish them (SUBS-LISTEN-002). A template or a
cursor-bearing URI is "unknown" here. If the accepted set is empty, the
acknowledgment carries `notifications: {}` and the server immediately ends
the subscription gracefully (§5.6) — it never holds an idle listener
(SUBS-LISTEN-007). This still counts as one `opened` (outcome
`empty_filter`) in metrics and audit.

### 5.3 Messages on the stream

Every message carries `_meta["io.modelcontextprotocol/subscriptionId"]` =
the listen request `id` (original JSON type). In order:

1. `notifications/subscriptions/acknowledged` with
   `params.notifications` = the accepted filter (only `resourceSubscriptions`
   can be present in Phase 1) — always the first message for that id
   (SUBS-LISTEN-003).
2. Zero or more `notifications/resources/updated` with `params.uri` = the
   base feed URI exactly as accepted (D-14) and nothing else — no event body,
   no principal, no cursor.
3. On graceful teardown only: the JSON-RPC **result**
   `{ "resultType": "complete", "_meta": { "io.modelcontextprotocol/subscriptionId": <id> } }`
   for the listen `id`, then the stream closes (D-13). An abrupt close sends
   nothing.

No `notifications/progress`, `notifications/message`, requests or any
other method ever appears on the stream.

### 5.4 Streamable HTTP transport (SUBS-LISTEN-005)

`POST /mcp` (primary listener, the optional `config.mcp.http` listener, or
the UNIX socket). After the §5.1 checks the handler answers
`200` with headers `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `Connection: close`,
`X-Accel-Buffering: no` (V-09), `X-Correlation-ID: <server-minted>`, flushes
the headers, and writes each message as

```text
event: message
data: <one-line JSON>

```

`Connection: close` (found during implementation, Task 10): the stream owns
its TCP connection, so a keep-alive client must not reuse the socket after
the stream ends — a server that half-closes a reusable socket after the
graceful result races the client's next request into a reset.

The `Accept` header must list `text/event-stream` (the transport spec makes
it mandatory for every POST); if it does not, the request is `406` with a
JSON-RPC `-32600` body. While idle the server writes the SSE comment
`: keep-alive` every `keepalive_ms` (default 15 000); comments are not MCP
messages, do not touch the journal, cursors, audit or notification quota
(SUBS-LIMIT-004). The client cancels by closing the response; `res.on('close')`
removes the listener, nothing else (SUBS-PROTO-003, ADR-0010 amendment item
6). `Last-Event-ID` and `id:` SSE fields are never used. `GET /mcp` stays
`405`; the legacy SDK transport stays in JSON-response mode.

One HTTP request holds exactly one subscription. A client with several
subscriptions opens several requests (the v2 client does).

### 5.5 stdio transport (SUBS-LISTEN-006, D-19)

`xinas-mcp-stdio` (`src/mcp-stdio.ts`) changes from a strictly serial
bridge to one that keeps its ordering guarantee **per subscription** while
letting listens run concurrently:

- A line whose `method` is `subscriptions/listen` is dispatched **off** the
  serial chain: the adapter POSTs it (same headers as today plus
  `accept: application/json, text/event-stream`), and
  - if the response is `application/json`, writes the body as one line
    (the pre-ack rejection), or
  - if the response is `text/event-stream`, parses SSE incrementally and
    writes every `data:` payload to stdout as its own line, in stream order;
    `event:` names other than `message` and comment lines are ignored.
    The listen id is recorded as live until the stream ends.
- A line `notifications/cancelled` whose `params.requestId` names a live
  listen id destroys that HTTP request (the transport-level close is the
  cancel, §5.4) and is **not** forwarded. Any other notification is forwarded
  as today.
- Every other message stays on the serial chain, unchanged.
- The graceful result (§5.3 item 3) arrives as the stream's last `data:`
  line and is written like any other; the id is then no longer live.
- On stdin close the adapter destroys every live listen request and exits
  after the serial chain drains. After a process restart nothing is
  remembered: the client re-sends `subscriptions/listen` and catches up by
  cursor.
- Lines are never merged: a `data:` payload is one JSON-RPC message per the
  server's framing, so one payload becomes exactly one stdout line.

Two concurrent subscriptions therefore interleave on stdout only at message
boundaries, each carrying its own id (SUBS-LISTEN-003 stdio rule).

### 5.6 Lifecycle, limits and teardown

**Registry.** `SubscriptionRegistry` (`api/events/subscriptions.ts`) holds
the live listeners: `{ id, principal, role, bearer|uds, transport, feeds:
Set<feed>, queue: feed→pending, correlationId, openedAt }`. Limits, checked
before the ack (SUBS-LIMIT-001): `max_listeners_per_principal` (default 4,
1–64), `max_listeners_per_process` (default 32, 1–1024). Exceeding either
is `-32000` (implementation-defined range, S15 V-18) with message
`subscription limit reached` and `data: { limit: "principal" | "process" }`;
audit `mcp.subscription.denied`.

**Notification path.** After a journal transaction commits with events for
feeds `F`, the writer calls `registry.notify(F)`. For each listener whose
`feeds ∩ F ≠ ∅` and for each such feed: mark the feed pending; if no timer
is armed for that (listener, feed), arm one for `coalesce_ms` (default 250,
0–5000); when it fires, re-check authorization (§9.3), write **one**
`notifications/resources/updated` for the feed, clear pending, count
`coalesced` for every additional mark that arrived meanwhile. Coalescing
never touches the journal (SUBS-LIMIT-002).

**Slow consumer (SUBS-LIMIT-003).** Writes go through the HTTP response's
write buffer. The registry tracks unsent bytes via `res.writableLength`; when
a listener's pending message count (after coalescing, across feeds) plus
the transport's buffered messages exceeds `max_pending_per_stream`
(default 256, 16–4096) — or `res.write` has returned `false` for longer than
`keepalive_ms` × 2 — the server increments
`xinas_mcp_subscriptions_closed_total{reason="overflow"}`, audits
`mcp.subscription.overflow`, and closes the response **without** the
graceful result (an abrupt close is the honest signal). Journal rows are
untouched; the client reconnects and catches up by cursor. No path from a
listener back-pressures the observation handler: `notify()` is synchronous
bookkeeping only and never awaits a socket.

**Graceful teardown.** On `ServerHandle.close()` the registry writes the
§5.3 result to every listener whose response is still writable, then ends
the responses, then the HTTP servers close. Audit `mcp.subscription.closed`
with reason `shutdown`.

**Close reasons** (audit + metric label): `client` (transport closed),
`empty_filter`, `overflow`, `unauthorized` (revoked on re-check),
`shutdown`, `error` (write failure).

---

## 6. Event envelope

### 6.1 Shape

Every journal row is one `EventEnvelope`, serialized canonically (the
`payload` column) and returned verbatim inside `events[]`:

```jsonc
{
  "schemaVersion": "1",
  "eventId": "e6d2…-uuid",
  "sequence": 123,
  "controllerId": "<controller uuid>",
  "feed": "raid",
  "type": "raid.operation.started",
  "severity": "info",
  "detectedAt": "2026-09-04T12:00:00.000Z",
  "timeAccuracy": "observed",                   // source | observed | task
  "source": { "kind": "observed_transition", "component": "XiraidArray" },
  "subject": { "kind": "XiraidArray", "id": "data" },
  "summary": "RAID array data: initialization started",
  // optional groups — only these keys may appear
  "occurredAt": "…",
  "previous": { … }, "current": { … },
  "operation": { "kind": "initialization", "generation": 1, "progressPct": 10, "bucket": 10 },
  "threshold": { "metric": "used_pct", "value": 81.2, "unit": "percent", "enter": 80, "clear": 75 },
  "reasonCode": "baseline",
  "relatedResources": [ { "kind": "Disk", "id": "…" } ],
  "cause": { "taskId": "…", "operationId": "…" },
  "details": { … }                              // per-type closed schema
}
```

`source.kind` ∈ `observed_transition | observed_snapshot | heartbeat |
inventory | task`; `source.component` is the observed kind, `heartbeat`,
`inventory` or the executor name. `subject.kind` ∈ `XiraidArray | Disk |
Pool | Filesystem | ExportRule | NfsSession | SystemdUnit | Agent |
Collector | NetworkInterface | Node`. `relatedResources[]` reuses the
`api-v1.yaml` `ResourceRef` identity (`kind`, `id`).

### 6.2 Bounds and redaction (SUBS-EVENT-006)

`summary` ≤ 256 characters, built from fixed English templates and
identifiers only — never a raw vendor string; `reasonCode` from the closed
list in §6.5; `details` validated against the per-type JSON schema
(`api/events/schema.ts`) with `additionalProperties: false`; every string
in `details` ≤ 1024 characters; every array ≤ 64 entries; `previous`/`current`
are projections listed per producer in §8, never the raw observed row. The
canonical payload must be ≤ 65 536 bytes; a producer that would exceed it
is a programming error caught by the unit tests (the writer refuses the
row and logs, rather than truncating). No field ever carries a bearer,
password, key, confirmation secret, environment, command line, stdout,
journal text, a path outside `Filesystem.status.mountpoint` /
`ExportRule.spec.export_path` / `Disk.status.device_path`, a plan document,
a task spec, or a mail recipient. NFS client addresses appear **only** in
the `nfs/sessions` feed.

### 6.3 Time accuracy (SUBS-EVENT-003)

| `timeAccuracy` | `detectedAt` | `occurredAt` |
|---|---|---|
| `observed` (every poll/snapshot-derived event) | the api's commit time (`Date.now()` inside the transaction) | absent — the row's `status.observed_at` is the *collector's* sample time and is copied to `details.observedAt`, not promoted to `occurredAt` |
| `task` (task-correlated events whose task has reached a terminal state) | commit time | the task's terminal transition time (`tasks.terminal_at`) |
| `source` (a vendor timestamp — none in Phase 1) | commit time | the vendor's |

A correlation with a task that is still `running` names the task in
`cause` but keeps `timeAccuracy: observed` and carries no `occurredAt`:
the row's `updated_at` moves with every progress patch and is not a
transition time, and the api never promotes its own clock to
`occurredAt`. `TaskLookup` therefore returns `occurredAtMs` only from
`terminal_at`; `correlationFields()` (`api/events/engine.ts`) is the one
place that turns a `Cause` into envelope fields, and `buildEvent` refuses
`timeAccuracy: task | source` without `occurredAtMs` (a producer bug is
logged and the event skipped, never downgraded silently).

### 6.4 Severity table (SUBS-EVENT-004)

Recovery/clear events are `info` and carry `previous.severity` (the severity
of the condition being cleared). Vendor email levels differ and are not
copied.

| Type | Severity | Feed |
|---|---|---|
| `raid.array.created`, `raid.array.removed` | info | raid |
| `raid.operation.started`, `raid.operation.observed_running`, `raid.operation.completed` | info | raid |
| `raid.operation.failed` | warning; `error` when the final state contains `offline` or `unrecovered` | raid |
| `raid.state.degraded`, `raid.state.read_only` | error | raid |
| `raid.state.offline`, `raid.state.unrecovered` | critical | raid |
| `raid.state.recovered` | info | raid |
| `raid.source.unknown_state` | warning | raid |
| `raid.member.offline` | error | raid |
| `raid.member.returned` | info | raid |
| `raid.spare.disconnected`, `raid.spare_pool.exhausted` | warning | raid |
| `raid.spare.returned`, `raid.spare_pool.replenished`, `raid.spare.replacement.completed` | info | raid |
| `raid.spare.replacement.failed` (gated) | warning | raid |
| `raid.device.error_count_increased` (gated) | warning | raid |
| `raid.device.fault_threshold_reached`, `raid.device.critical_wear` (gated) | error | raid |
| `raid.license.expired`, `raid.license.drive_limit_exceeded` (gated) | error | raid |
| `raid.restore.completed` | info (`healthy`, `running`), warning (`read_only`, `unknown`), error (`degraded`, `unhealthy`, `offline`), critical (`unrecovered`) | raid |
| `raid.restore.failed` | error | raid |
| `raid.operation.progress` | info | raid/progress |
| `filesystem.definition.added`, `filesystem.definition.removed` | info | storage |
| `filesystem.mount.lost`, `filesystem.mount.failed`, `filesystem.read_only.entered` | error | storage |
| `filesystem.mount.restored`, `filesystem.read_only.cleared`, `filesystem.capacity.cleared` | info | storage |
| `filesystem.capacity.warning` | warning | storage |
| `filesystem.capacity.critical` | critical | storage |
| `storage.disk.health_degraded`, `storage.disk.wear_critical` (gated) | error | storage |
| `storage.disk.temperature_high` (gated) | warning | storage |
| `storage.disk.health_recovered`, `storage.disk.temperature_cleared` (gated) | info | storage |
| `nfs.service.unavailable`, `nfs.export.backing_unavailable`, `nfs.rdma.unavailable` | error | nfs |
| `nfs.service.recovered`, `nfs.export.backing_recovered`, `nfs.rdma.recovered` | info | nfs |
| `nfs.export.added`, `nfs.export.changed`, `nfs.export.removed` | info | nfs |
| `nfs.session.connected`, `nfs.session.disconnected`, `nfs.session.protocol_changed`, `nfs.session.lock_threshold_cleared` | info | nfs/sessions |
| `nfs.session.lock_threshold_crossed` | warning | nfs/sessions |
| `system.service.unavailable` | error | system |
| `system.service.recovered`, `system.agent.recovered`, `system.collector.recovered`, `system.network.link_up`, `system.rdma.link_up` | info | system |
| `system.agent.degraded`, `system.collector.failed`, `system.collector.stale`, `system.network.link_down`, `system.rdma.link_down`, `system.reboot.detected` | warning | system |
| `system.agent.offline` | error | system |

`raid.array.created/removed` and `filesystem.definition.added/removed` are
spec additions (not in the requirement's lists): the requirement names
`nfs.export.added/removed` and says an approved deletion of a mount
definition is "a configuration/domain change, not an unexpected mount-loss
alarm" (SUBS-STORAGE-001); these four types are that change, for arrays and
filesystems.

### 6.5 Closed vocabularies

`reasonCode` ∈ `baseline | state_none | reconcile_absent | unit_failed |
unit_inactive | unmounted | ro_option | hysteresis | task | reboot |
connect_refused | heartbeat_timeout | collector_error | no_valid_update |
helper_absent | not_configured | unknown_word`.

`operation.kind` ∈ `initialization | reconstruction` (Phase 1; Phase 2 adds
`restripe | sdc_scan`). Event type names are lower-case dot-separated nouns
with a past-tense final segment and are never repurposed (SUBS-EVENT-005).

---

## 7. Journal, cursors, retention

### 7.1 Schema (migration `007-operational-events.sql`)

```sql
CREATE TABLE IF NOT EXISTS operational_events (
  sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          TEXT    NOT NULL UNIQUE,
  controller_id     TEXT    NOT NULL,
  feed              TEXT    NOT NULL CHECK (feed IN ('raid','raid/progress','storage','nfs','nfs/sessions','system')),
  type              TEXT    NOT NULL,
  severity          TEXT    NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  detected_at       INTEGER NOT NULL,          -- epoch ms
  occurred_at       INTEGER,                   -- epoch ms, optional
  subject_kind      TEXT    NOT NULL,
  subject_id        TEXT    NOT NULL,
  dedupe_key        TEXT,
  cause_task_id     TEXT,
  cause_operation_id TEXT,
  payload           TEXT    NOT NULL           -- canonical JSON EventEnvelope
);
CREATE INDEX IF NOT EXISTS operational_events_feed_seq_idx ON operational_events(feed, sequence);
CREATE INDEX IF NOT EXISTS operational_events_detected_idx ON operational_events(detected_at);
CREATE INDEX IF NOT EXISTS operational_events_subject_idx ON operational_events(subject_kind, subject_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS operational_events_dedupe_idx ON operational_events(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_event_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                    -- JSON
  updated_at INTEGER NOT NULL
);
```

`AUTOINCREMENT` guarantees a strictly increasing, never-reused `sequence`
across feeds and restarts (V-69). `operational_event_meta` holds the small
producer state that a previous-vs-current row compare cannot carry (§8.0).

### 7.2 Write path (SUBS-JOURNAL-002/003/006)

`EventJournal.insert(envelopeWithoutSequence, { dedupeKey? })` runs on the
same better-sqlite3 handle the KV uses, so a call made inside
`kv.transaction(...)` is part of that transaction (V-40). It returns the
allocated `sequence` and the completed envelope, or — when `dedupeKey`
already exists — the existing row without allocating a sequence. The
caller collects the touched feeds and calls `registry.notify(feeds)` **after**
the transaction has returned; a throw inside rolls back events and state
together, so no notification can ever point at state that rolled back.
Dedupe keys are scoped to one transition instance (e.g.
`raid.member.offline:<array>:<disk>:<previous row revision>`), never to a
condition, so a later repeat after a recovery allocates a new event.

### 7.3 Retention (SUBS-JOURNAL-005)

`RetentionSweeper` (timer, `unref`, started in `server.ts`, stopped on
close) runs every `cleanup_interval_s` (default 3600, 60–86 400) and on
start. Each run deletes, in batches of 500 rows per statement inside
their own short transactions, rows with `detected_at < now − retention_days`
and then the oldest rows beyond `max_rows`, until both bounds hold or a
per-run budget of 50 batches is spent (the rest waits for the next run).
Bounds: `retention_days` 7 (1–30), `max_rows` 100 000 (10 000–1 000 000).
Reducing the bounds by configuration takes effect on the next run, never
retroactively inside a read (SUBS-CONFIG-002).

### 7.4 Cursor codec (SUBS-JOURNAL-004, D-21)

```text
cursor  = base64url( "1" 0x1F controllerId 0x1F feed 0x1F decimal(S) 0x1F tag8 )
tag8    = first 8 bytes of SHA-256( "1" 0x1F controllerId 0x1F feed 0x1F decimal(S) )
```

Decoding checks, in order: base64url alphabet and length ≤ 256; exactly
five fields; version `1`; `controllerId` equal to this api's; `feed` equal
to the feed being read; `S` a non-negative integer ≤ `last`; `tag8`
byte-equal. Any failure → `-32602`, message `invalid cursor`, no other data.
The cursor is not an authorization capability (§9.4).

---

## 8. Event generation

### 8.0 Engine

`TransitionEngine` (`api/events/engine.ts`) is invoked by the observation
handler (`api/internal/observed.ts`) **inside** its `kv.transaction`:

```ts
engine.begin(batch: { observedAt: string; completeSnapshots: Kind[] })      // once per batch
engine.onChange({ kind, id, previous: row | null, current: value | null, currentRevision })  // per applied delta / reconcile delete
engine.onSnapshot(kind, presentIds: Set<string>)                            // per kind in complete_snapshots, after reconcile
engine.commit(): { feeds: Set<Feed> }                                       // inserts collected events; returns touched feeds
```

Unchanged upserts (the handler's canonical-compare skip) never reach
`onChange`; a reconcile delete reaches it with `current: null`. Producer
state that a row compare cannot carry lives in `operational_event_meta`
under namespaced keys and is read/written inside the same transaction:

| Key | Holds |
|---|---|
| `boot_id` | last observed boot id |
| `restore_pending` | `{ bootId, knownArrays: [...] }` between a reboot detection and the first complete `XiraidArray` snapshot |
| `collector_last_accepted:<Kind>` | epoch ms of the last accepted batch carrying that kind |
| `collector_state:<Kind>` | `running` / `failed` / `stale` |
| `session_candidates` | `{ <sessionId>: { kind, epoch, seq, view } }` (D-20) — `epoch` is the engine instance id, `seq` its batch counter |
| `progress:<array>:<kind>` | `{ generation, lastPct, lastBucket, lastEmitAt }` |
| `capacity:<fsId>` | `none` / `warning` / `critical` |
| `unknown_state_warned:<array>` | `[ word… ]` |
| `lock_threshold:<sessionId>` | `crossed` |
| `raid_op:<array>:<kind>` | `{ generation, active }` |

Two batch-level rules apply everywhere:

- **Baseline (SUBS-GEN-001).** `previous === null` emits no transition event.
  Exceptions: `raid.operation.observed_running` for an active operation,
  `raid.state.offline` / `raid.state.unrecovered` (reason `baseline`) for an
  array first seen in that state, `filesystem.capacity.warning|critical`
  when the first valid sample is already above the enter threshold, and
  `system.reboot.detected` when a previous boot id exists. A fresh database
  therefore produces at most these.
- **Failed source is not state (SUBS-GEN-002).** The engine only ever sees
  batches the agent produced from a successful sweep (V-35). Collector
  failure and staleness are reported from the heartbeat's collector map and
  the per-kind last-accepted timestamps (§8.6) and never as a domain event.

### 8.1 xiRAID observation correction (S3 amendment)

`lib/parse/raid.ts` publishes, additively, on `XiraidArray.status`:

| Field | Source | Notes |
|---|---|---|
| `raw_states: string[]` | the normalized (lower-cased, de-duplicated, order-preserving) state words | every word, known or not |
| `init_progress_pct`, `recon_progress_pct`, `restripe_progress_pct`, `sdc_progress_pct` | `init_progress`, `recon_progress`, `restripe_progress`, `sdc_progress` | integer or finite number 0–100, else `null`; never merged |
| `rebuild_progress_pct` | unchanged (`recon ?? init`) | kept for compatibility (SUBS-SPEC-005) |

Unknown words stay in `raw_states`, still map to `status.state: unknown`
(S3 §5.3), and produce one `raid.source.unknown_state` per (array, word)
(meta `unknown_state_warned`), never a crash (SUBS-RAID-001). The
`XiraidArray.json` contract fixture and `api-v1.yaml` gain the fields.

### 8.2 RAID feed (`raid`)

Projections used in `previous`/`current`: `{ state, raw_states,
member_states: [{device, states}], spare_pool, spare_disk_ids }`.

**Health predicates** over `raw_states` (`W`):

- `active(kind)`: `initing ∈ W` (initialization) / `reconstructing ∈ W`
  (reconstruction).
- `unhealthy`: `W ∩ {degraded, need_recon, need_init, inconsistent,
  read_only, offline, unrecovered, none} ≠ ∅`, or one of the parser's
  alternate failure spellings (`broken`, `unusable`, `faulty`, `failed` —
  `lib/parse/raid.ts`), or any member whose states contain `offline`,
  `reconstructing` or `need_recon`, or `active(*)`.
- `unknown`: not `unhealthy`, and one of: a word of `W` outside the
  vocabulary; a member word outside the vocabulary; a member with no
  state; no member states for an array whose spec lists members;
  `online ∉ W`.
- `healthy`: neither of the above (`online ∈ W`, every member proven
  `online`, no active operation).

Member states are the four device states xiRAID documents for `raid
show` (`online`, `offline`, `reconstructing`, `need_recon` — xiRAID
Classic 4.4 AG, *Showing RAID State*, Table 2, `devices`:
<https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html>);
the agent's fixture transport emits the same `[index, path, [states]]`
tuples the daemon does, so a source that reports no member state at all
is a fixture defect, not a production shape.

`unknown` is a source problem, not a state: it is reported once per
(array, word) as `raid.source.unknown_state` (member words included) and
never completes, fails, recovers or restores anything.

A structural gap — a member with no state words, or no member states at
all for an array whose spec lists members — is logged as
`event_source_incomplete` `{ kind: 'XiraidArray', id, missing }` (not
journaled; `docs/TODO.md`).

**Array lifecycle.** `previous === null ∧ current ≠ null` in a complete
snapshot after the baseline of the kind → `raid.array.created` (details:
level, member count; `cause.taskId` when a `success`/`running` xiNAS task
of kind `xiraid.array.create` for that name exists in `tasks`; `timeAccuracy: task`
only for a `success` one (§6.3)). `current === null`
(reconcile delete) → `raid.array.removed` (details: `operationInProgress`
when an operation was active; `cause.taskId` from a matching
`xiraid.array.delete` task) — unless `restore_pending` is set (§8.2 restore).
Neither is a completion, failure or recovery (SUBS-RAID-002).

**Operation lifecycle** (per `kind ∈ {initialization, reconstruction}`,
SUBS-RAID-002/003), with `A = active(kind)`:

| previous | current | Event |
|---|---|---|
| `null` | `A` | `raid.operation.observed_running` (generation 1) |
| `¬A` | `A` | `raid.operation.started` (generation +1) |
| `A` (word, or `raid_op` still active) | `¬A ∧ healthy` | `raid.operation.completed` |
| `A` (word, or `raid_op` still active) | `¬A ∧ unhealthy` | `raid.operation.failed`; `details.finalStates = raw_states`; severity per §6.4 |
| `A` (word, or `raid_op` still active) | `¬A ∧ unknown` | nothing: `raid_op` stays active with the same generation, progress state is kept, `event_operation_end_undecided` is logged; the first later `healthy`/`unhealthy` observation emits the terminal event above |
| `raid_op` active after an undecided end | `A` again | nothing (no new generation) |
| `A` | row deleted | no operation event (`raid.array.removed` carries `operationInProgress`) |

A `reconstructing` that ends in `need_recon`, `degraded`, `offline` or
`unrecovered` is a failure; member states must all be `online` for
`healthy` to hold when the array-level word is `online` but a member still
reads `reconstructing`/`need_recon` (the array is then not yet healthy —
"member states participate in validation"). Completion is never inferred
from absence.

**Array state** (SUBS-RAID-004). Conditions `C(W)`: `degraded` (`degraded ∨
need_recon`), `read_only`, `offline` (`offline ∨ none`; reason
`state_none` for `none`), `unrecovered`. For each condition entered
(`c ∉ C(prev) ∧ c ∈ C(cur)`): `raid.state.<c>`. When `C(cur) = ∅ ∧
healthy(cur) ∧ C(prev) ≠ ∅`: `raid.state.recovered` with
`previous.severity` = the highest severity among `C(prev)`. `sdc_scanning`,
`need_restripe`, `need_resize`, `restriping`, `need_init`, `inconsistent`
and `initialized` never enter this table; they remain visible in
`raw_states` for Phase 2.

**Members** (SUBS-RAID-005). Members are matched by `device` (control-path
Disk id when resolvable; `details.devicePath` carries the raw path). For a
member present in both rows: `offline ∉ prev.states ∧ offline ∈ cur.states`
→ `raid.member.offline` (subject `Disk`, related `XiraidArray`);
`offline ∈ prev.states ∧ offline ∉ cur.states` → `raid.member.returned`.
A member that appears in `cur` replacing one that vanished, where the new
device was in the array's pool drives in the **previous** `Pool` row →
`raid.spare.replacement.completed` (details `replaced`, `replacement`,
`pool`). `raid.spare.replacement.failed` has no source (D-16).

**Spare pools** (subject `Pool`, from `Pool` row changes): a drive removed
from `drives` → `raid.spare.disconnected` (one per drive; suppressed for
the drive that appears as a replacement in the same batch); a drive added
→ `raid.spare.returned`; `drives` becoming empty while some observed array
references the pool → `raid.spare_pool.exhausted`; non-empty again →
`raid.spare_pool.replenished`.

**Restore after reboot** (SUBS-RAID-007). When `system.reboot.detected`
fires (§8.6) the engine stores `restore_pending = { bootId, knownArrays }`
(the current observed array ids). On the first complete `XiraidArray`
snapshot afterwards, per known array, the worst proven fact wins: absent or
`none ∈ W` → `raid.restore.failed` `{ result: "not_restored" }`; `offline`
→ `offline`; `unrecovered` → `unrecovered`; `read_only` → `read_only`;
`degraded ∨ need_recon` → `degraded`; another unhealthy word → `unhealthy`;
an active operation → `running`; a member-proven fault → `unhealthy`;
`unknown` per the predicates → `unknown`; only a proven `healthy` →
`healthy` (all but the first are `raid.restore.completed` with that
`result`, severities in §6.4). Ordinary
transitions for that snapshot are emitted as well (they are different
facts). Until that snapshot arrives (daemon still starting: the collector
reports `error`, no snapshot is sent) nothing is emitted (V-35).

**Source-gated families** (D-16): `raid.device.*`, `raid.license.*` —
listed under `producers.inactive` with the reasons from §4.4 until a
periodic collector exists.

### 8.3 RAID progress feed (`raid/progress`)

For each active operation with a finite `*_progress_pct` `p` in `[0,100]`
(others: ignored plus one `raid.source.unknown_state`-style warning is
**not** used; invalid progress is logged and counted in
`xinas_operational_event_detection_delay_seconds` nowhere — it is simply
skipped): `bucket = floor(p / bucket_pct) × bucket_pct` (default 10). Emit
`raid.operation.progress` `{ operation: { kind, generation, progressPct: p,
bucket } }` when `bucket ≠ lastBucket` and `now − lastEmitAt ≥ min_interval_s`
(default 30), or when `p ≠ lastPct ∧ now − lastEmitAt ≥ max_silence_s`
(default 600). A jump across several buckets emits one event with the
latest values (SUBS-PROGRESS-002). A drop `p < lastPct − 1` while the
operation stays active starts a new **generation** (`generation + 1`,
`details.reasonCode: "regression"`) rather than being rewritten; the same
generation counter is carried by the `raid` feed's operation events
(SUBS-PROGRESS-003). Reaching 100 may emit a final progress event; the
authoritative completion is `raid.operation.completed` in `raid`.

### 8.4 Storage feed (`storage`)

Projection: `{ mounted, mount_unit_state, read_only, size_bytes, free_bytes,
mountpoint }` where `read_only = "ro" ∈ effective_mount_options`.

| Transition (prev → cur) | Event |
|---|---|
| row created (after baseline) | `filesystem.definition.added` |
| row deleted | `filesystem.definition.removed` (`cause.taskId` from a matching `fs.unmanage` task when present) |
| `mounted: true` → `mounted: false` or `mount_unit_state` → `failed` | `filesystem.mount.lost` (reason `unmounted` / `unit_failed`) |
| `mount_unit_state: failed` while `mounted` was already `false` and a `fs.mount` task for the unit is `failed` | `filesystem.mount.failed` (`cause.taskId`) |
| `mounted: false` → `mounted: true` | `filesystem.mount.restored` |
| `read_only: false` → `true` (both mounted) | `filesystem.read_only.entered` |
| `read_only: true` → `false` | `filesystem.read_only.cleared` |

**Capacity** (SUBS-STORAGE-002): `used_pct = 100 × (size − free) / size`
when both are finite and `size > 0`, else no evaluation. Levels with
hysteresis (meta `capacity:<id>`): `none → warning` at `≥ warning_enter`
(80), `warning → none` at `< warning_clear` (75), `→ critical` at
`≥ critical_enter` (90), `critical → warning` at `< critical_clear` (85)
(then the warning rule applies). Each level change emits
`filesystem.capacity.<warning|critical|cleared>` with the `threshold`
group; `cleared` carries `previous.severity`. Configuration validation
enforces `clear < enter` per level and `critical_enter > warning_enter`.
Per-filesystem overrides are keyed by unit name.

Disk families are source-gated (D-16); the temperature family is inactive
until a validated device/platform threshold exists (D-10).

### 8.5 NFS feed (`nfs`) and NFS sessions feed (`nfs/sessions`)

**Services** (subject `SystemdUnit`): for `nfs-server.service`,
`nfs-idmapd.service`, `nfs-mountd.service` with `load_state = loaded`:
`active_state: active → {failed, inactive, deactivating}` →
`nfs.service.unavailable` (reason `unit_failed` / `unit_inactive`);
`{failed, inactive, activating} → active` → `nfs.service.recovered`.
A `not-found`/`masked` unit produces nothing (D-18). Aliases cannot
duplicate: the subject is the observed unit id, which the agent probe
resolves once.

**Exports** (SUBS-NFS-002): per `ExportRule` row (subject `ExportRule`, id
= the decoded absolute path), rules are keyed by `host_pattern`; a rule's
comparison value is `{ squash_mode, anon_uid, anon_gid, options: sorted,
de-duplicated }`. Row created → one `nfs.export.added` per rule; row
deleted → one `nfs.export.removed` per previous rule; key added/removed
inside a row → `added`/`removed`; same key, different comparison value →
`nfs.export.changed` (`previous`/`current` = the two comparison values).
The row's `host_pattern` is `details.hostPattern`. Ordering-only option
differences produce nothing.

**Backing readiness** (SUBS-NFS-003): for every export path `p` and every
`Filesystem` row with `mountpoint m` such that `p === m ∨ p.startsWith(m + "/")`
(the longest such `m` wins; `/srv/data2` never matches `/srv/data`),
the backing is **unavailable** when `mount_unit_state = failed ∨ mounted =
false ∨ (mounted = true ∧ "ro" ∈ effective_mount_options)`, **available**
when `mounted = true ∧ effective_mount_options` is present without `ro`,
and **unknown** when the row lacks `mounted` or (while mounted) lacks
`effective_mount_options`. Only a proven change → `nfs.export.backing_unavailable` /
`nfs.export.backing_recovered` (subject `ExportRule`, related `Filesystem`).
Evaluated on both `Filesystem` and `ExportRule` changes.

An `unknown` evaluation keeps the last proven state (meta
`backing_unavailable:<export>`), emits nothing, and logs
`event_source_incomplete` `{ kind, id, exportPath, missing, kept }` — the
rule can neither report the fault nor clear it from a row that does not
carry the field.

**NFS over RDMA** (SUBS-NFS-004): only when the desired `NfsProfile`
(`/xinas/v1/desired/NfsProfile/default`) has `spec.rdma.enabled: true`.
Ready ⇔ observed `NfsProfile.status.rdma_listening = true ∧` at least one
managed (`desired` row exists) observed `NetworkInterface` with
`rdma_capable ∧ rdma_link_state = up`. Unavailable ⇔ `rdma_listening =
false`, or `rdma_listening = true` and every managed RDMA interface has
`rdma_link_state = down`. Anything else — the listener flag absent, or no
proven-up path while some path reads `unknown` — is undecided: the last
proven state is kept and `event_source_incomplete` is logged. One proven
working path is enough for ready; "no proven path" and "every path proven
down" are different facts. A proven change → `nfs.rdma.unavailable` /
`nfs.rdma.recovered` (subject `SystemdUnit nfs-server.service`, related:
the interfaces; details: `listening`, `interfaces`). Not configured → no
event, reason `not_configured` in `producers.inactive`.

**Sessions** (D-20, SUBS-SESSION-001/002/003/004): subject `NfsSession`
(`<client_addr>:<export_path>`), details `{ clientAddr, exportPath,
protoVersion, lockedFiles }` — no hostnames, users, file names or
payloads. Row created after baseline → candidate `connected`; confirmed
`nfs.session.connected` by the next complete `NfsSession` snapshot that
still contains it (two consecutive observations) — a snapshot of a *later*
batch: a later `seq` of the same engine instance, or the first complete
snapshot after an api restart (the in-process counter restarts with the
process, so a persisted candidate is never compared against it). Reconcile
delete → candidate `disconnected`; confirmed by the next complete snapshot
without it; cancelled by one with it. Candidates are stored in
`session_candidates`; a batch without a `NfsSession` complete snapshot
touches no candidate. `proto_version` change → `nfs.session.protocol_changed`.
Lock threshold: disabled unless `lock_threshold.enter > 0`; `locked_files ≥
enter` → `nfs.session.lock_threshold_crossed`, `< clear` →
`…_cleared`, per session (meta `lock_threshold:<id>`).

### 8.6 System feed (`system`)

**Services** (D-18): `xinas-agent.service`, `xinas-nfs-helper.service`,
`xiraid-server.service` use the §8.5 unit rules with types
`system.service.unavailable` / `system.service.recovered`.
`xinas-api.service` emits `recovered` only (V-72). The agent's systemd
probe allow-list gains the two missing units (agent-spec amendment).

**Agent** (SUBS-SYSTEM-002): `HeartbeatTracker.#emitStateChange` now calls
`journal.insert` (source `heartbeat`, subject `Agent xinas-agent`) instead
of writing the KV row: `→ degraded` = `system.agent.degraded`, `→ offline` =
`system.agent.offline` (reason `connect_refused` / `heartbeat_timeout`),
`→ healthy` = `system.agent.recovered`. Thresholds and the first-appearance
suppression are unchanged. The KV writer is removed, so no transition
produces both an old and a new event.

**Collectors** (SUBS-SYSTEM-003, D-24): on every accepted observation batch
the handler stores `collector_last_accepted:<Kind>` for every kind in the
batch. On every heartbeat the tracker hands the collector map to the
engine: `error:` → `system.collector.failed` once per `running → failed`
edge (details `reason` ≤ 256 chars, from the health string);
`running`/`stubbed` after `failed`/`stale` → `system.collector.recovered`
**only if** `collector_last_accepted` moved since the failure. Staleness:
a kind whose last accepted batch is older than `3 × pollIntervalMs` of its
collector (the agent spec's table; 300 s for the backstop kinds) while the
agent is `healthy` → `system.collector.stale` once (reason
`no_valid_update`); a newer accepted batch → `recovered`. Subject
`Collector <Kind>`.

**Links** (SUBS-SYSTEM-004): `NetworkInterface` rows with a desired row
(managed) or `rdma_capable`: `link_state: up → down` →
`system.network.link_down`, `down → up` → `link_up`; `rdma_link_state`
likewise → `system.rdma.link_down` / `link_up`. `unknown` in either side
produces nothing. The `ip monitor` event path may deliver partial attribute
records; the collector already re-snapshots on poll, and the engine only
compares fields present in **both** rows, so a partial record cannot fake a
down.

**Reboot** (SUBS-SYSTEM-005, D-23): the agent's inventory probe reads
`/proc/sys/kernel/random/boot_id` into `inventory.status.boot_id`. On an
`inventory` upsert whose `boot_id` differs from meta `boot_id`: store the
new one; if a previous existed, `system.reboot.detected` (subject `Node
<controller_id>`, `timeAccuracy: observed`, details `{ previousBootId,
bootId }`) and set `restore_pending` (§8.2). A process restart within the
same boot changes nothing.

---

## 9. Authorization and security

### 9.1 Principal (SUBS-AUTH-001)

`resources/*` and `subscriptions/listen` resolve identity with S14's
`resolveIdentity` (bearer → `config.tokens`; UDS without bearer →
`mcp:local_admin`). The bearer (or the UDS marker) is retained on the
listener for re-checks and never logged, audited or echoed. No identity is
read from params, cursors or events.

### 9.2 Read parity (SUBS-AUTH-002, D-09)

Minimum role for every feed is `viewer`. Every Phase 1 subject kind is
readable by `viewer` on the corresponding REST surface (`GET /arrays`,
`/filesystems`, `/nfs/sessions`, `/system`, `/network/interfaces`,
`/disks`), so no per-event filtering removes anything in Phase 1; the
filter hook (`authorizeEvent(identity, envelope)`) exists and is the single
place a future higher-role subject is dropped without acknowledgment.

### 9.3 Re-check and revocation (SUBS-AUTH-003)

Before every `resources/read` and before every delivery on a stream the
listener's bearer is re-resolved against `ctx.config.tokens`; a bearer that
no longer resolves, or resolves to a role below `viewer`, closes the
listener (reason `unauthorized`) without the graceful result. With today's
static configuration this path is exercised by tests through an injected
token table (V-44).

### 9.4 Cursors and injection (SUBS-AUTH-004/005)

A cursor grants nothing: reads always apply the current principal's policy
and cursors are validated only for integrity and scope. Every `summary` is a
fixed template with identifiers interpolated after control-character
stripping and length capping; vendor words, hostnames, paths and client
addresses are data fields. Events are untrusted input for an LLM and the
`instructions` text (S14 §4) says so.

---

## 10. Configuration (`mcp.subscriptions`)

```jsonc
"mcp": {
  "subscriptions": {
    "enabled": true,                 // false → no resources capability, methods -32601, journal still records
    "retention_days": 7,             // 1–30
    "max_rows": 100000,              // 10000–1000000
    "cleanup_interval_s": 3600,      // 60–86400
    "read_limit_default": 100,       // 1–500
    "read_limit_max": 500,           // read_limit_default–500
    "max_uris_per_listen": 6,        // 1–6
    "max_listeners_per_principal": 4,// 1–64
    "max_listeners_per_process": 32, // 1–1024
    "max_pending_per_stream": 256,   // 16–4096
    "keepalive_ms": 15000,           // 1000–60000
    "coalesce_ms": 250,              // 0–5000
    "progress": { "bucket_pct": 10, "min_interval_s": 30, "max_silence_s": 600 },   // 1–50 / 1–3600 / min_interval_s–86400
    "capacity": { "warning_enter": 80, "warning_clear": 75, "critical_enter": 90, "critical_clear": 85,
                  "per_filesystem": { "srv-data.mount": { "warning_enter": 90, "warning_clear": 85, "critical_enter": 95, "critical_clear": 92 } } },
    "nfs_lock_threshold": { "enter": 0, "clear": 0 },   // 0 = disabled; clear < enter when enabled
    "disk_temperature_c": null       // a validated platform threshold; null = family inactive
  }
}
```

`validateSubscriptionsSection` (in `api/config.ts`, the `validateMcpSection`
pattern) rejects out-of-range integers, `clear ≥ enter`, `critical_enter ≤
warning_enter`, and unknown per-filesystem keys with the same error style
as S15; the api refuses to start on an invalid section
(SUBS-CONFIG-002). There is no live reload today; when one exists, reducing
listener limits closes the newest excess listeners deterministically and
retention changes apply on the next sweep.

---

## 11. Audit (SUBS-AUD-001)

`api/events/audit.ts` queues, through `AuditAppender.queue()`, one row per
lifecycle condition with `kind`:

| Kind | When | Payload |
|---|---|---|
| `mcp.subscription.opened` | after the ack (also for `empty_filter`) | `subscription_correlation_id`, `transport`, `feeds` (names), `principal`, `outcome` |
| `mcp.subscription.closed` | listener removed | + `reason`, `notifications_sent`, `coalesced`, `duration_ms` |
| `mcp.subscription.denied` | limit or authorization refusal before the ack | `reason`, `limit` |
| `mcp.subscription.overflow` | slow-consumer close | `pending`, `feeds` |
| `mcp.event_cursor.gap_observed` | a read returned `gap: true` | `feed`, `requested_sequence`, `oldest_sequence` |

`principal` is the resolved principal; `client_type: mcp`; `request_id` is
the server-minted correlation id; never a bearer, a cursor string, a client
address or an event payload. Individual notifications and feed reads write
no audit row.

---

## 12. Metrics (SUBS-METRIC-001, D-17)

`api/events/metrics.ts` defines `SubscriptionMetrics` with the eleven
instruments the requirement lists (labels exactly as listed; no principal,
id, array, disk, address, path or task labels) and two implementations:
`noopMetrics` and `InMemoryMetrics` (asserted by tests). When S15's
`lib/metrics.ts` registry lands, a `RegistryMetrics` adapter registers the
same names there and `GET /api/v1/metrics` renders them; the names are fixed
here so the two slices cannot drift:

```text
xinas_mcp_subscriptions_active{transport}
xinas_mcp_subscriptions_opened_total{transport,outcome}
xinas_mcp_subscriptions_closed_total{transport,reason}
xinas_mcp_resource_notifications_total{feed,outcome}
xinas_mcp_resource_notifications_coalesced_total{feed}
xinas_mcp_event_reads_total{feed,outcome}
xinas_mcp_event_cursor_gaps_total{feed}
xinas_operational_events_created_total{feed,severity}
xinas_operational_event_journal_rows
xinas_operational_event_journal_oldest_age_seconds
xinas_operational_event_detection_delay_seconds{source}
```

`detection_delay_seconds` = `detectedAt − status.observed_at` of the row
that produced an observed event (source = the kind).

---

## 13. REST projection and `api-v1.yaml`

`GET /events` (`routes/events.ts`) reads the journal instead of the retired
KV prefix. Existing parameters keep working (`since` filters
`detected_at`, `severity` filters exactly); new optional parameters
`feed`, `after` (a feed cursor; requires `feed`), `limit` (1–500, default
100). The result is still an array of `Event` rows, most recent first when
no `after` is given and ascending when paging with `after`; each row is the
legacy shape (`event_id`, `ts` = `detectedAt`, `kind` = `type`, `severity`,
`message` = `summary`, `related_resources`) plus the additive optional
fields `feed`, `sequence`, `type`, `subject`, `detected_at`, `occurred_at`,
`time_accuracy`, `source`, `cursor` (the row's own feed cursor, for paging),
`previous`, `current`, `operation`, `threshold`, `reason_code`, `cause`,
`details`. Access is unchanged: the route has no catalog entry, so the RBAC
deny-by-default applies (admin; corrected during implementation, Task 12 —
the requirement's viewer parity is for the MCP feeds). `agent_state_changed`
rows written
before this release remain readable under the old prefix for one release
through the same route (merged, oldest first) and are dropped in the next.

`api-v1.yaml` changes are additive only: the `Event` fields above, the
three `/events` parameters, and the `XiraidArray.status` fields of §8.1.
`ApplyRequest` and every task payload are untouched (SUBS-SPEC-008); no
JSON-RPC shape enters the OpenAPI document.

---

## 14. Restart, failure and consistency (requirement §19)

| Situation | Behavior |
|---|---|
| api restart | listeners gone (clients see an abrupt close); journal, sequence and meta intact; clients re-listen and read after their cursor; session candidates are confirmed or cancelled by the first complete `NfsSession` snapshot after the restart |
| agent restart | the boot sweep's complete snapshots are compared with the stored rows: real transitions emit, identical rows are skipped by the handler's dedupe, nothing is a baseline again |
| xiRAID unavailable | the collector reports `error`, no `XiraidArray` snapshot is sent (V-35); `system.collector.failed` once; stored arrays stay; the next valid snapshot resumes comparison |
| helper unavailable | same for `NfsSession`/`ExportRule`; session candidates untouched |
| clock step | ordering is `sequence`; `detectedAt` may be non-monotonic and is never used to order or page |
| journal insert fails | the observation transaction fails with it (the batch is retried by the agent, `pendingReconcile`); no notification; `system.collector.*` is unaffected. A persistent failure (disk full) surfaces through the api's existing error logging — there is no write loop because the retry is the agent's existing bounded one |
| notify after commit fails (listener write error) | that listener closes (`error`); rows stay |
| observation row lacks a field a rule needs (`mounted`, `effective_mount_options`, `rdma_listening`, a link state of `unknown`) | the rule keeps its last proven state and logs `event_source_incomplete`; no domain event (§8.5) |

---

## 15. Tests (requirement §27)

- **Unit** (`__tests__/api/events/*.test.ts`): cursor codec; journal
  insert/dedupe/list/gap/retention batches; envelope bounds and redaction;
  every producer as a table over `(previous, current)` including the 16
  state words, malformed/missing/null/scalar/mixed/unknown payloads,
  operation lifecycle, members, spares, restore, progress buckets and
  regression, mount/read-only/capacity hysteresis, exports canonicalization,
  backing-path boundary, RDMA readiness, session debounce, lock threshold,
  services, agent, collector failed/stale/recovered, links, reboot;
  fault-then-recovery-then-fault produces three distinct events.
- **Contract** (`__tests__/contracts/`): the vendored MCP `2026-07-28`
  `schema.json` validates every listen/ack/updated/result/list/templates/
  read message the server emits; OpenAPI fixtures for `Event` and the
  extended `XiraidArray`; `server/discover` truthfulness with and without a
  journal.
- **api** (`__tests__/api/mcp-resources.test.ts`,
  `mcp-listen.test.ts`): raw JSON-RPC over HTTP — list/templates/read,
  every `-32602` case, cursor paging and gap, ack-first, update after a
  committed event, unrequested feeds silent, limits, coalescing,
  slow-consumer close, keep-alive comments, unauthorized/unknown URIs
  indistinguishable, revocation (injected token table), graceful close on
  server shutdown, stdio adapter demux (two subscriptions through the
  adapter against a real api).
- **Interop** (`__tests__/api/mcp-client-v2.test.ts`, devDependency
  `@modelcontextprotocol/client` 2.0.0): the ten SUBS-CLIENT-001 items.
- **e2e** (`__tests__/e2e/subscriptions.test.ts`): fixture-mode agent +
  fake xiRAID (`xiraid-state.json` edits drive `initing`/`init_progress`
  → `online`), the twelve SUBS-TEST-004 scenarios.
- **Gates:** the S17 verification list is CLAUDE.md's TypeScript block
  plus markdownlint and spectral.

---

## 16. Client interoperability (requirement §21)

**Polling fallback (SUBS-CLIENT-003).** A client that does not open
`subscriptions/listen` reads `xinas://events/<feed>{?after,limit}` on its
own schedule; the envelope, cursors and authorization are identical. The
S14 `instructions` text gains one sentence that says so.

**Smoke-test protocol (SUBS-CLIENT-002).** `docs/control-path/hardware-smoke-runbook.md`
gains a section that records, per product client, the client version,
transport, whether it issued `subscriptions/listen` (api audit
`mcp.subscription.opened`), whether `notifications/resources/updated`
reached it (client log or UI), whether it re-read the resource or surfaced
the notification to the model, reconnect behavior, and the configuration
used. The rows for Claude Code and Codex are recorded as **pending** by this
spec (V-29); until they are filled the release notes state the limitation
and point at the polling fallback.

---

## 17. Acceptance criteria coverage (requirement §28)

| # | Criterion | Where |
|---|---|---|
| 1 | contracts approved before code | T0 (this spec + amendments) |
| 2 | truthful discovery, legacy unchanged | §3; `mcp-discover.test.ts` |
| 3 | six resources list/template/read, private, `ttlMs: 0` | §4; `mcp-resources.test.ts` |
| 4 | listen on HTTP and stdio, ack first | §5; `mcp-listen.test.ts` |
| 5 | only requested + authorized feeds wake | §5.2, §5.6 |
| 6 | commit before notify; survives restarts | §7.2, §14 |
| 7 | cursor catch-up, visible gap | §4.4, §7.4 |
| 8–9 | init/recon lifecycle distinguishable; progress separate | §8.1–§8.3 |
| 10 | array/member/spare/restore transition tests; media/license typed and gated | §8.2, D-16 |
| 11 | mount/read-only/capacity | §8.4 |
| 12 | NFS service/export/backing/RDMA/sessions | §8.5 |
| 13 | missing data never becomes state | §8.0, §8.2 (unknown), §8.5 (incomplete rows), §8.6, §14 |
| 14 | limits/coalescing/overflow lose no rows | §5.6 |
| 15 | revocation, redaction | §9, §6.2 |
| 16 | audit bounded, metric labels bounded | §11, §12 |
| 17 | v2 client tests pass; product-client rows honest | §15, §16 |
| 18 | REST/CLI/TUI, S15, S16 unchanged | §13; existing suites |

---

## 18. Phase 2 boundary

Phase 2 (requirement §22–§25) adds event types and optional fields on the
same six feeds, the same envelope and the same cursors; the `raw_states`
and four progress fields already give it its xiRAID source. Nothing in
Phase 2 may rename a feed, type, envelope field or cursor version; a new
envelope field is optional; a new `reasonCode` or `operation.kind` value is
appended. The source-gated Phase 1 families become active the moment their
collector lands, without a wire change.
