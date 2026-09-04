# xiNAS S17 — MCP subscriptions and operational event feeds requirements

> **Status:** draft requirements, 2026-09-04.
>
> **Protocol target:** MCP `2026-07-28`, core `subscriptions/listen` and MCP
> Resources.
>
> **Normative protocol sources:**
> [MCP `2026-07-28` schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
> and
> [SEP-2575 stateless MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2575-stateless-mcp.md).
>
> **Product sources:**
> [xiRAID 4.4 email notifications](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/setting_up_email_notifications.html),
> [xiRAID 4.4 RAID states](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html),
> [xiRAID 4.4 system log](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/system_log.html),
> [BeeGFS target states](https://doc.beegfs.io/7.4.1/reference/target_states.html),
> [NFSv4.1 crash recovery](https://datatracker.ietf.org/doc/html/rfc8881#section-8.4.2),
> and
> [Linux host/NFS collectors](https://github.com/prometheus/node_exporter#collectors).
>
> **Extends:** ADR-0010, S3 xiRAID observations, S4 xiRAID mutations, S5
> filesystems, S6 network, S7 health and drift, S8 clients, S14 modern MCP,
> S16 MCP Tasks, the S0/S1 agent specification, and the xiNAS notification
> specification.
>
> The binding behavior contract for this work MUST be written as
> `s17-mcp-subscriptions-spec.md` and approved before implementation. This file
> records the product, protocol, reliability and safety requirements that the
> specification must satisfy.

---

## 1. Goal

Implement the MCP `2026-07-28` `subscriptions/listen` request so an authorized
modern MCP client can subscribe to operational changes in xiNAS without
polling every managed object.

The first release MUST provide six MCP resource feeds:

1. `xinas://events/raid`;
2. `xinas://events/raid/progress`;
3. `xinas://events/storage`;
4. `xinas://events/nfs`;
5. `xinas://events/nfs/sessions`;
6. `xinas://events/system`.

The first four are the normal operational feeds. RAID progress and NFS session
churn are separate opt-in feeds because they may be high-frequency.

The implementation MUST:

- use the standard `resourceSubscriptions` filter and
  `notifications/resources/updated` notification;
- implement the MCP Resources methods needed to discover and read the feeds;
- persist every event before announcing that its feed changed;
- let a client catch up from a durable cursor after disconnect or restart;
- derive events from committed observed-state transitions, trusted task state,
  or a specifically validated telemetry source;
- preserve source uncertainty instead of inventing an exact occurrence time;
- avoid treating a failed or stale collector as proof that a resource was
  removed, stopped or recovered;
- preserve the current REST, CLI, TUI, plan/apply, S15 confirmation and S16
  task contracts;
- expose no credential, secret, raw command output or unrestricted journal
  text in an event;
- work over both Streamable HTTP and stdio in the modern protocol era.

## 2. Delivery phases

### 2.1 Phase 1 — MVP

Phase 1 MUST deliver:

- MCP resource discovery and reading;
- `subscriptions/listen` over Streamable HTTP and stdio;
- a durable operational-event journal and cursor reads;
- the six approved feeds;
- the event envelope in this document;
- transition events that can be produced from current xiNAS observations plus
  the small xiRAID projection corrections explicitly required below;
- bounded progress and NFS-session event volume;
- authorization, redaction, rate control, audit and metrics;
- official MCP client-library interoperability tests;
- explicit Claude Code and Codex smoke-test results, without assuming either
  client supports or surfaces subscriptions merely from its version string.

### 2.2 Phase 2 — extended storage and NFS observability

Phase 2 MUST be additive over the Phase 1 wire contract. It adds:

- xiRAID restripe, SDC scan and pending-maintenance states;
- NFSv4 grace, reclaim and recovery events;
- NFS server RPC, authentication, stale-handle and thread-pressure events;
- capacity inode and quota events;
- sustained storage and NFS performance/SLO events;
- HA, path and failover events when xiNAS has a supported source of truth.

Phase 2 MUST NOT rename a Phase 1 feed, event type, envelope field or cursor.
New event types and optional fields are allowed.

## 3. Non-goals

S17 does not:

- create a custom `notifications/xinas/event` protocol extension;
- put an event payload inside `notifications/resources/updated`;
- restore the removed legacy `resources/subscribe` or
  `resources/unsubscribe` methods;
- use an MCP subscription as an execution channel for server-to-client
  requests, elicitation, MRTR or approvals;
- replace S16 MCP Tasks or `tasks/get` with domain events;
- promise exactly-once notification delivery;
- resume an HTTP SSE response with `Last-Event-ID`;
- retain a disconnected client's in-memory subscription;
- send one notification for every collector poll, NFS RPC, byte transferred,
  percentage point or raw log line;
- infer a performance fault merely because throughput is low while the system
  is idle;
- expose all system journal records as an MCP resource;
- change public `ApplyRequest` or task payloads;
- add TUI alert management in Phase 1;
- add outbound email, webhook, SNMP or message-bus delivery.

## 4. Protocol truths and local decisions

### SUBS-PROTO-001 — Core filter only

For MCP `2026-07-28`, the core subscription filter contains only:

- `toolsListChanged`;
- `promptsListChanged`;
- `resourcesListChanged`;
- `resourceSubscriptions`.

S17 MUST NOT add `eventTypes`, `severity`, `arrayIds` or another xiNAS field to
that core object. Event selection is performed by subscribing to one or more
of the six stable feed URIs.

### SUBS-PROTO-002 — Resource-update signal

The server MUST send `notifications/resources/updated` as a change signal.
The notification contains the subscribed feed URI and standard `_meta`; it
does not contain an xiNAS event body.

The client reads the feed through `resources/read`, optionally with its last
durable cursor in the URI, to obtain one or more event envelopes.

### SUBS-PROTO-003 — Notifications are not the journal

`subscriptions/listen` is an at-most-once wake-up path. The durable event
journal is the source of truth.

The server MAY coalesce repeated pending updates for the same feed. It MUST
NOT discard the corresponding journal rows. A client that misses a
notification MUST be able to obtain the events from its last cursor until
retention removes them.

### SUBS-PROTO-004 — Modern era only

S17 is available only to MCP `2026-07-28` modern requests. A legacy-era
request for `subscriptions/listen`, `resources/list`,
`resources/templates/list` or `resources/read` continues through the legacy
path and MUST NOT select modern behavior accidentally.

The presence of `Mcp-Session-Id` does not turn a modern request into a legacy
request; S14 era classification remains authoritative.

### SUBS-PROTO-005 — No extension advertisement

Subscriptions and Resources are core MCP capabilities. S17 MUST NOT advertise
an `io.xinnor.xinas/events` extension.

`server/discover` MUST advertise:

```json
{
  "resources": {
    "subscribe": true,
    "listChanged": false
  }
}
```

only after all Phase 1 resource handlers, the listen path, authorization and
the journal are installed and healthy. Partial support MUST NOT be
advertised.

## 5. Required specification updates

All changes in this section MUST land before S17 implementation code.

### SUBS-SPEC-001 — Create S17

Create `docs/control-path/s17-mcp-subscriptions-spec.md` as the authoritative
contract for:

- Resources capability discovery;
- feed and resource-template discovery;
- resource reads and cursor paging;
- `subscriptions/listen` over HTTP and stdio;
- event envelope, taxonomy and severity;
- journal storage, retention and recovery;
- event generation from observations;
- authorization and redaction;
- backpressure and limits;
- audit, metrics, tests and rollout;
- the Phase 1/Phase 2 boundary.

### SUBS-SPEC-002 — Amend ADR-0010

ADR-0010 MUST record that:

1. the modern MCP path now supports Resources and resource subscriptions;
2. Resources remain absent from the legacy MCP era;
3. standard resource-update notifications are used instead of a custom xiNAS
   notification method;
4. the journal, not the transport stream, provides catch-up;
5. a subscription is bound to the authenticated principal that opened it;
6. an HTTP disconnect or stdio cancellation removes only the listener, not
   monitoring, journal rows or a running task;
7. task-status notification work remains owned by S16 and is not silently
   implemented as an S17 domain event.

### SUBS-SPEC-003 — Amend S14 modern MCP

S14 MUST:

- remove MCP Resources from its out-of-scope list for the S17-enabled build;
- add modern handlers for `resources/list`, `resources/templates/list`,
  `resources/read` and `subscriptions/listen` ahead of the legacy SDK path;
- add `resources: {subscribe: true, listChanged: false}` to the generated
  discovery capability only when complete;
- define the resource result shapes, `resultType`, cache scope and TTL;
- define per-request client metadata validation on all four methods;
- define HTTP SSE and stdio multiplexing behavior;
- keep prompts absent and keep resource-list change notifications disabled.

### SUBS-SPEC-004 — Amend S16 Tasks

S16 MUST replace its generic `subscriptions/listen` deferral with a precise
boundary:

- S17 implements the core listen transport and operational resource feeds;
- Phase 1 S17 does not emit `notifications/tasks` and does not turn Task state
  into a domain-event replacement for `tasks/get`;
- a future task-status notification may reuse the S17 transport only after
  the S16 notification contract defines task authorization, complete task
  projection and reconnect behavior.

### SUBS-SPEC-005 — Amend S3 and S4 xiRAID contracts

The xiRAID observation contract MUST retain, without replacing existing
backward-compatible fields:

- the complete raw xiRAID state-word set;
- `init_progress` separately from `recon_progress`;
- the member state words separately for every member;
- SparePool membership and replacement outcomes when observable;
- an observation timestamp and collector health.

The current projection that maps `recon_progress ?? init_progress` into one
`rebuild_progress_pct` is insufficient for S17. The existing field MAY remain
for compatibility, but event generation MUST use separate operation identity
and progress values.

S4 MUST define how a xiNAS task-created array or member operation supplies an
optional trusted `task_id`/`operation_id` correlation to the resulting domain
event. Timing proximity alone MUST NOT create that correlation.

### SUBS-SPEC-006 — Amend S5, S6, S7 and the agent specification

The owning contracts MUST define the exact fields used to detect:

- mount loss, restoration, failure and read-only transitions;
- capacity threshold crossings;
- disk health, wear and temperature threshold crossings;
- Ethernet and RDMA link transitions;
- service and collector failure/recovery;
- agent heartbeat state transitions;
- observed-state transition atomicity and baseline behavior.

### SUBS-SPEC-007 — Amend notification documentation

`docs/Notifications/spec-email-notifications.md` MUST distinguish three
independent mechanisms:

1. scheduled xiNAS health email;
2. xiRAID daemon email notifications;
3. S17 MCP operational resource feeds.

It MUST use the official xiRAID 4.4 event list rather than imply that the
short existing table is exhaustive. It MUST state that xiRAID email is not an
event stream consumed directly by xiNAS.

### SUBS-SPEC-008 — API and repository guidance

The existing REST `/events` endpoint and OpenAPI `Event` schema MUST be
extended additively if they expose the S17 journal. Existing fields MUST
remain valid.

MCP JSON-RPC schemas MUST NOT be inserted into `ApplyRequest` or represented
as REST request bodies.

After implementation:

- add S17 to the live MCP contract list in `CLAUDE.md`;
- remove the Resources deferral in `docs/TODO.md` only when the complete
  capability is live;
- retain explicit TODO entries for Phase 2 event producers not yet shipped.

## 6. Resource catalog

### SUBS-RES-001 — Concrete resources

`resources/list` MUST return exactly the six Phase 1 base resources in stable
URI order.

Each resource MUST have:

- stable `uri`;
- stable English `name`;
- concise `description` that names the event scope;
- MIME type `application/vnd.xinas.events+json`;
- annotations that do not claim mutability;
- no embedded credential, node-specific hostname or resource inventory.

The six resources are present even when their current event set is empty.
They MUST NOT appear and disappear with collector health.

### SUBS-RES-002 — Opt-in feeds

`xinas://events/raid/progress` and `xinas://events/nfs/sessions` MUST be
separate resources. An update in either MUST NOT wake a client subscribed only
to `xinas://events/raid` or `xinas://events/nfs`.

Start, completion, failure and recovery events remain in the non-progress
feed even if a related percentage is also emitted to the progress feed.

### SUBS-RES-003 — Cursor resource template

`resources/templates/list` MUST advertise one read-only URI template for each
feed:

```text
xinas://events/raid{?after,limit}
xinas://events/raid/progress{?after,limit}
xinas://events/storage{?after,limit}
xinas://events/nfs{?after,limit}
xinas://events/nfs/sessions{?after,limit}
xinas://events/system{?after,limit}
```

where:

- `after` is an opaque cursor previously returned by xiNAS;
- `limit` is an integer from 1 through 500, default 100.

Cursor-bearing/template URIs are readable but not subscribable. Only the six
base URIs are accepted in `resourceSubscriptions`.

### SUBS-RES-004 — Feed read representation

Every successful feed read MUST return one text content item whose `text` is
JSON matching:

```json
{
  "schemaVersion": "1",
  "feed": "raid",
  "events": [],
  "nextCursor": "opaque",
  "oldestAvailableCursor": "opaque",
  "headCursor": "opaque",
  "hasMore": false,
  "gap": false,
  "generatedAt": "2026-09-04T12:00:00.000Z"
}
```

The content item URI MUST equal the URI requested by the client.

The resource result MUST be a complete modern result with:

- `resultType: "complete"`;
- `ttlMs: 0`;
- `cacheScope: "private"`.

### SUBS-RES-005 — Read ordering

Events MUST be returned in ascending `sequence` order. `nextCursor` identifies
the last event returned, or the supplied cursor/current head when no event was
returned.

`hasMore` is true only when another retained event in the same authorized feed
exists after `nextCursor`.

A read without `after` returns at most the latest `limit` retained events and
a cursor at the returned high-water mark. Clients that want only future
events MAY first read with `limit=1`, retain `headCursor`, and then subscribe.

### SUBS-RES-006 — Expired cursor

An otherwise valid cursor older than retention MUST not produce a fabricated
continuous history. The read returns:

- `gap: true`;
- no event older than `oldestAvailableCursor`;
- `oldestAvailableCursor` and `headCursor`;
- retained events beginning at the oldest available row, subject to `limit`.

The client can then report the gap and resume. Cursor expiry is not a server
failure and MUST NOT be represented as a JSON-RPC internal error.

Malformed, forged, wrong-controller or wrong-version cursors MUST return
`-32602 Invalid params` and reveal no journal contents.

### SUBS-RES-007 — Unknown and unsupported resources

An unsupported resource URI passed to a modern `resources/read` MUST return
`-32602 Invalid params`; MCP `2026-07-28` retired the older `-32002` resource
not-found code. It MUST not be proxied to a filesystem path, URL fetcher or
shell command.

URI parsing MUST use an allowlist of scheme, host, path and query keys. Path
traversal, fragments, duplicate cursor parameters and unknown query keys are
invalid params.

## 7. `subscriptions/listen`

### SUBS-LISTEN-001 — Request validation

The request MUST contain:

- a JSON-RPC request ID;
- method `subscriptions/listen`;
- valid S14 modern per-request `_meta`;
- a `notifications` object;
- zero or more standard filter fields of the released schema.

Unknown xiNAS-specific fields MUST be rejected with `-32602`; they MUST NOT be
silently interpreted.

### SUBS-LISTEN-002 — Accepted filters

Phase 1 supports only `resourceSubscriptions`.

- `toolsListChanged` is omitted from the acknowledgment unless S14 separately
  implements it.
- `promptsListChanged` is always omitted because xiNAS has no prompts.
- `resourcesListChanged` is omitted because the Phase 1 resource list is
  static for the process lifetime.
- a requested base event-feed URI is acknowledged only if the principal may
  read it.
- duplicate URIs are deduplicated while preserving first-requested order.

Unknown and unauthorized URIs MUST be indistinguishable in the acknowledgment
to avoid resource-enumeration leakage.

### SUBS-LISTEN-003 — First message

The first message for a subscription ID MUST be:

```text
notifications/subscriptions/acknowledged
```

It MUST contain the accepted subset of the request's filters and
`_meta["io.modelcontextprotocol/subscriptionId"]` equal to the original
JSON-RPC request ID.

No resource notification for that subscription may precede the
acknowledgment. On stdio, messages for other subscription IDs may be
interleaved.

### SUBS-LISTEN-004 — Resource update

After at least one new authorized journal event is committed for an accepted
feed, the server sends:

```text
notifications/resources/updated
```

with:

- `params.uri` equal to the base feed URI;
- the subscription ID in notification `_meta`;
- no inline event payload;
- no principal, token or authorization metadata.

The server MUST NOT send updates for an unrequested feed.

### SUBS-LISTEN-005 — HTTP transport

For Streamable HTTP:

- the client opens the subscription with `POST /mcp`;
- the response remains an SSE stream;
- `Content-Type` is `text/event-stream`;
- acknowledgment is the first JSON-RPC message for the subscription;
- SSE comments MAY be used as keep-alives but are not MCP notifications;
- closing the HTTP response cancels only that listener;
- an abrupt close has no final JSON-RPC result;
- graceful server teardown sends `SubscriptionsListenResult` when the
  transport remains writable, then closes the response.

`Last-Event-ID` MUST NOT resume this stream. Reconnect uses a new
`subscriptions/listen` request and a feed cursor read.

### SUBS-LISTEN-006 — Stdio transport

For stdio:

- notifications share the bidirectional channel with ordinary messages;
- every subscription message carries its subscription ID;
- multiple listen requests MAY be active concurrently;
- `notifications/cancelled` referencing the listen request ID stops that
  subscription;
- server shutdown sends `notifications/cancelled` or the released graceful
  completion form required by the selected schema, then stops delivery;
- after process restart the client MUST create a new subscription and catch up
  by cursor.

The S17 spec MUST resolve any difference between the released TypeScript
schema and prose SEP in favor of the released `2026-07-28` schema and record
the exact tested framing.

### SUBS-LISTEN-007 — Empty accepted set

If no requested filter is accepted, the server MUST send an acknowledgment
with an empty `notifications` object and then end the subscription gracefully.
It MUST NOT retain an idle listener with no possible notifications.

## 8. Event envelope

### SUBS-EVENT-001 — Required fields

Every retained S17 event MUST contain:

```json
{
  "schemaVersion": "1",
  "eventId": "uuid",
  "sequence": 123,
  "controllerId": "uuid",
  "feed": "raid",
  "type": "raid.operation.started",
  "severity": "info",
  "detectedAt": "2026-09-04T12:00:00.000Z",
  "timeAccuracy": "observed",
  "source": {
    "kind": "observed_transition",
    "component": "xiraid-array-collector"
  },
  "subject": {
    "kind": "XiraidArray",
    "id": "md0"
  },
  "summary": "RAID initialization started"
}
```

`sequence` is monotonically increasing per controller across all feeds and
survives process restarts.

### SUBS-EVENT-002 — Optional fields

An event MAY contain only the following optional top-level groups:

- `occurredAt`, when the source supplies a trustworthy occurrence timestamp;
- `previous` and `current`, containing a bounded state projection;
- `operation`, containing operation kind and progress;
- `threshold`, containing metric, value, unit, threshold and clear threshold;
- `reasonCode`, from a closed S17 vocabulary;
- `relatedResources`, using existing `ResourceRef` identity;
- `cause`, containing trusted `taskId`, `operationId` or request correlation;
- `details`, from an event-type-specific closed JSON schema.

No producer may add an arbitrary raw source object to `details`.

### SUBS-EVENT-003 — Time accuracy

`timeAccuracy` is one of:

- `source` — `occurredAt` came from the source event itself;
- `observed` — xiNAS detected a state at poll/reconcile time and cannot know
  the exact transition time;
- `task` — the timestamp came from a committed xiNAS task transition.

For polling-derived events, `detectedAt` is mandatory and `occurredAt` MUST be
absent unless the vendor payload includes it. xiNAS MUST NOT relabel poll time
as exact vendor event time.

### SUBS-EVENT-004 — Severity

The public severity vocabulary remains:

- `info`;
- `warning`;
- `error`;
- `critical`.

The S17 spec MUST contain an exact event-type-to-severity table. Vendor email
levels, xiNAS health-check result and S17 operational severity are different
surfaces; a mapping MUST be explicit rather than assumed identical.

Recovery/clear events normally use `info` and carry the previous severity in
`previous`. A recovery does not delete the fault event.

### SUBS-EVENT-005 — Stable type names

Event type names use lower-case dot-separated nouns and past-tense state
transitions. Once released, a type name MUST NOT be repurposed with different
semantics.

Operation families use a stable type plus an `operation.kind` discriminator
where doing so prevents taxonomy explosion. For example:

```text
raid.operation.started       operation.kind=initialization
raid.operation.completed     operation.kind=reconstruction
```

### SUBS-EVENT-006 — Redaction and size

One encoded event MUST be no larger than 64 KiB. Strings, arrays and details
have explicit schema bounds.

Events MUST NOT contain:

- bearer tokens, passwords, private keys or confirmation secrets;
- complete environment variables or process command lines;
- unbounded stdout/stderr or journal text;
- filesystem paths outside public managed-resource identity;
- plan documents, task specs or internal desired-state payloads;
- email addresses from the xiRAID mail-recipient configuration.

## 9. Durable journal and cursors

### SUBS-JOURNAL-001 — Dedicated event store

S17 MUST introduce an operational-event store abstraction with a SQLite
implementation. The existing `/xinas/v1/events/` KV prefix may be migrated or
projected into it, but a prefix listing without a durable monotonic sequence,
retention and cursor semantics is not sufficient for S17.

The SQLite journal MUST have, at minimum:

- an autoincrementing integer sequence;
- unique event ID;
- controller ID;
- feed, type and severity;
- detected and optional occurred timestamp;
- subject kind and ID;
- canonical bounded payload JSON;
- optional deduplication key and trusted cause identifiers;
- indexes for `(feed, sequence)`, timestamp, event ID and subject lookup.

### SUBS-JOURNAL-002 — Commit before notification

A notification MUST be scheduled only after the event transaction commits.

If the process crashes:

- before commit, neither event nor notification exists;
- after commit but before notification, the event remains available by cursor;
- after notification, the same committed row remains the read authority.

A notification must never point to state that could roll back.

### SUBS-JOURNAL-003 — Atomic observed transitions

When an event is derived from an observation accepted by xinas-api, the
previous-state comparison, observed-state write and journal insert SHOULD be
one SQLite transaction. If current storage boundaries prevent this, the S17
spec MUST define a durable outbox with idempotent replay; an in-memory callback
alone is not acceptable.

### SUBS-JOURNAL-004 — Cursor format

Cursors are opaque, versioned, base64url-safe values containing or referring
to:

- cursor version;
- controller ID;
- feed ID;
- last global sequence.

Clients MUST NOT be required to decode them. The server MUST reject a cursor
issued for a different controller generation or feed rather than silently
skip or replay unrelated events.

### SUBS-JOURNAL-005 — Retention

Phase 1 defaults are:

- age retention: 7 days;
- row cap: 100,000 events;
- cleanup interval: 1 hour;
- read limit: 100 by default, 500 maximum.

Configuration MAY reduce or increase age retention within 1–30 days and MAY
set a row cap within 10,000–1,000,000. Reaching either retention boundary
removes the oldest rows first.

Cleanup MUST run in bounded batches and MUST NOT block event writes or MCP
reads for the duration of a full-table delete.

### SUBS-JOURNAL-006 — Event ID and deduplication

Event ID is generated once at the producer/journal boundary. Retrying a
durable outbox insert with the same deduplication key MUST return the existing
event rather than allocate a second sequence.

Deduplication is scoped to the exact transition or source event. It MUST NOT
collapse distinct later occurrences of the same fault after a recovery.

## 10. Common event-generation rules

### SUBS-GEN-001 — Baseline without flood

On a fresh database, the first successful observation of an object establishes
its baseline and normally emits no started, failed, removed or recovered
event.

Exceptions are:

- `system.reboot.detected` when a previous boot ID exists;
- an active long-running xiRAID operation, which emits
  `raid.operation.observed_running` rather than falsely claiming that xiNAS
  saw it start;
- an immediately critical condition for which suppressing the first observed
  fact would create an unsafe blind spot. The exact critical exceptions MUST
  be enumerated in the S17 spec.

### SUBS-GEN-002 — Failed source is not state

A failed, timed-out, malformed or stale probe MUST:

- retain the last known object as stale according to existing observation
  rules;
- emit an appropriate collector/source health event once;
- never emit resource removed, service stopped, array offline, session
  disconnected or recovery solely from missing data;
- clear the source fault only after a successful valid observation.

### SUBS-GEN-003 — Transition only

Steady identical observations produce no new domain event. State-change events
require a committed difference between valid previous and current values.

Flapping protection MUST be event-family specific. It may delay publication
but MUST retain the source evidence needed to decide the transition.

### SUBS-GEN-004 — Recovery pairing

Every threshold or fault family implemented in Phase 1 MUST define its clear
or recovery event. A condition is not considered recovered merely because its
collector stopped reporting.

### SUBS-GEN-005 — Task correlation

When an event is caused by a xiNAS task, `cause.taskId` and, when available,
`cause.operationId` SHOULD be populated from durable execution context.

The domain event remains distinct from the S16 task transition:

- task events answer whether requested work is running or complete;
- domain events answer what happened to the storage/NFS/system resource.

One MUST NOT be used to fabricate the other.

## 11. Phase 1 RAID feed

### SUBS-RAID-001 — Supported xiRAID state vocabulary

The producer MUST understand and retain the xiRAID 4.4 states:

```text
online initialized initing inconsistent degraded reconstructing offline
need_recon need_init read_only unrecovered none restriping sdc_scanning
need_resize need_restripe
```

Unknown words MUST be retained as unknown source values, must not pass as
healthy, and must produce one bounded source/taxonomy warning per distinct
array and word. They MUST NOT crash the observation batch.

### SUBS-RAID-002 — Initialization lifecycle

`xinas://events/raid` MUST support:

| Event | Required condition | Severity |
|---|---|---|
| `raid.operation.started` | valid transition into active initialization | `info` |
| `raid.operation.observed_running` | startup baseline already shows active initialization | `info` |
| `raid.operation.completed` | initialization leaves active state in a validated healthy terminal state | `info` |
| `raid.operation.failed` | initialization stops/incompletes into an unhealthy or pending-init state | `warning` or higher by final state |

Every event carries `operation.kind: "initialization"`. Completion MUST NOT be
inferred from disappearance of the array or a failed poll.

### SUBS-RAID-003 — Reconstruction lifecycle

The same four event types MUST support
`operation.kind: "reconstruction"`.

- entering `reconstructing` starts or observes the operation;
- leaving it for a validated healthy state completes it;
- leaving it for `need_recon`, `degraded`, `offline`, `unrecovered` or another
  explicitly mapped non-healthy terminal state fails/incompletes it;
- member states participate in validation;
- absence of one sample is not completion.

### SUBS-RAID-004 — Array state transitions

The RAID feed MUST publish transitions for:

| Condition | Event type | Default severity |
|---|---|---|
| array becomes degraded | `raid.state.degraded` | `error` |
| array becomes read-only | `raid.state.read_only` | `error` |
| array becomes offline | `raid.state.offline` | `critical` |
| array becomes unrecovered | `raid.state.unrecovered` | `critical` |
| array returns to validated healthy/online state | `raid.state.recovered` | `info` |

`reconstructing`, `sdc_scanning` and `need_restripe` MUST NOT be flattened into
one generic healthy/unhealthy rule. Phase 1 may retain the latter two without
domain events until Phase 2, but their raw states remain visible to the
transition engine.

### SUBS-RAID-005 — Member and SparePool events

The RAID feed MUST publish, when supported by a valid source:

- `raid.member.offline`;
- `raid.member.returned`;
- `raid.spare.disconnected`;
- `raid.spare.returned`;
- `raid.spare.replacement.completed`;
- `raid.spare.replacement.failed`;
- `raid.spare_pool.exhausted`.

Replacement failure details distinguish at least:

- no suitable SparePool member;
- attempted replacement failed;
- faulty bdev was replaced by a null placeholder.

Device identity MUST use the existing control-path Disk ID where resolvable.
Raw unstable `/dev/nvmeXnY` names are supplemental details, not the sole
subject identity.

### SUBS-RAID-006 — Media and license events

The RAID feed MUST support:

- `raid.device.error_count_increased` (`warning`, rate controlled);
- `raid.device.fault_threshold_reached` (`error`);
- `raid.device.critical_wear` (`error`);
- `raid.license.expired` (`error`);
- `raid.license.drive_limit_exceeded` (`error`).

An increasing cumulative error counter produces at most one event per device
per configured suppression interval and includes the previous/current count.
Threshold and critical-wear events are not suppressed by the ordinary
increase event.

### SUBS-RAID-007 — Reboot restore outcome

When xiNAS detects a new boot ID and then receives a valid xiRAID baseline, it
MUST publish one outcome per previously known array:

- `raid.restore.completed`, with `details.result` equal to `healthy`,
  `read_only` or `offline`;
- `raid.restore.failed`, with `details.result: "not_restored"`.

The producer MUST wait for a valid xiRAID response. Daemon startup delay is not
a failed restore.

## 12. Phase 1 RAID progress feed

### SUBS-PROGRESS-001 — Supported operations

Phase 1 publishes percentage progress only for:

- initialization;
- reconstruction.

The event type is `raid.operation.progress`; `operation.kind` distinguishes
the two operations.

`init_progress` and `recon_progress` MUST remain separate through collection,
parsing, persistence and event generation.

### SUBS-PROGRESS-002 — Bucket and time suppression

A progress event is generated when either:

- the operation crosses a new 10-percentage-point bucket; or
- the configured maximum silence interval expires while progress has changed.

Defaults:

- bucket size: 10 percentage points;
- minimum interval per array/operation: 30 seconds;
- maximum silence while changing: 10 minutes.

If progress jumps across several buckets in one poll, one event reports the
latest observed percentage and bucket. xiNAS MUST NOT fabricate intermediate
observations.

### SUBS-PROGRESS-003 — Bounds and regression

Progress values are integers or finite numbers in `[0, 100]`. Invalid values
are ignored and produce a bounded source warning.

A lower observed percentage is not silently rewritten as monotonic. It is
retained as a source anomaly or a newly identified operation generation. The
S17 spec MUST define the operation-generation rule.

Completion at 100% MAY produce a final progress event, but the authoritative
completion signal is `raid.operation.completed` in the normal RAID feed.

## 13. Phase 1 storage feed

### SUBS-STORAGE-001 — Mount lifecycle

`xinas://events/storage` MUST publish:

- `filesystem.mount.lost` when a previously valid mounted filesystem is
  validly observed unmounted or its mount unit enters a failed state;
- `filesystem.mount.restored` when it is validly mounted again;
- `filesystem.mount.failed` when a mount attempt fails with trusted task or
  systemd evidence;
- `filesystem.read_only.entered` when the effective mount changes from
  writable to read-only;
- `filesystem.read_only.cleared` when writable operation is validly restored.

Deletion of a managed mount definition by an approved task is represented as
a configuration/domain change, not an unexpected mount-loss alarm.

### SUBS-STORAGE-002 — Capacity thresholds

For each mounted managed filesystem, Phase 1 MUST calculate used percentage
from valid `size_bytes` and `free_bytes` observations.

Defaults:

- warning enters at 80% used and clears below 75%;
- critical enters at 90% used and clears below 85%.

Events are:

- `filesystem.capacity.warning`;
- `filesystem.capacity.critical`;
- `filesystem.capacity.cleared`.

Thresholds are configurable per filesystem or globally. Configuration MUST
enforce `clear < enter`, and critical enter MUST be greater than warning
enter. Missing/invalid size data emits no capacity transition.

### SUBS-STORAGE-003 — Disk health and wear

The storage feed MUST support:

- `storage.disk.health_degraded` when a trusted health source changes from
  healthy to failed/degraded;
- `storage.disk.health_recovered` after a valid clear;
- `storage.disk.wear_critical` at the xiRAID/NVMe critical wear threshold;
- `storage.disk.temperature_high` and
  `storage.disk.temperature_cleared` only when a validated device or platform
  threshold is available.

Phase 1 MUST NOT invent one universal NVMe temperature threshold. If the live
device data and platform configuration provide no validated threshold, the
temperature event family remains inactive and this fact is exposed in source
health/capability metadata.

## 14. Phase 1 NFS feed

### SUBS-NFS-001 — Service lifecycle

`xinas://events/nfs` MUST publish down/recovery transitions for:

- `nfs-server.service`;
- `nfs-idmapd.service` when enabled/required;
- `nfs-mountd.service` when enabled/required.

Event types are:

- `nfs.service.unavailable`;
- `nfs.service.recovered`.

The subject contains the resolved systemd unit name. Alias duplication MUST
not create two events for one service transition.

### SUBS-NFS-002 — Export lifecycle

The NFS feed MUST publish:

- `nfs.export.added`;
- `nfs.export.changed`;
- `nfs.export.removed`.

Identity is the canonical pair of export path and host pattern used by the
existing `ExportRule` model. Options are canonicalized before comparison so
ordering-only differences do not produce a change.

A failed `list_exports` call MUST NOT produce `removed` events.

### SUBS-NFS-003 — Backing filesystem readiness

For an export whose backing filesystem becomes unmounted, failed or read-only,
the NFS feed MUST publish:

- `nfs.export.backing_unavailable`;
- `nfs.export.backing_recovered`.

The join between export path and filesystem mountpoint MUST be path-boundary
safe. `/srv/data2` must not be treated as a child of `/srv/data`.

### SUBS-NFS-004 — NFS over RDMA readiness

When NFS over RDMA is configured, the NFS feed MUST support:

- `nfs.rdma.unavailable` when every required RDMA interface/link or the
  configured NFS-RDMA listener is unavailable;
- `nfs.rdma.recovered` when the required serving path is validly restored.

An Ethernet carrier transition and an RDMA transition may both appear in the
system feed, but the NFS event is a derived service-readiness event and names
the affected exports/interfaces.

No NFS-RDMA event is produced when NFS over RDMA is not configured.

### SUBS-NFS-005 — Desired/observed drift

When existing drift logic has authoritative desired and fresh observed NFS
state, the feed MAY publish:

- `nfs.configuration.drift_detected`;
- `nfs.configuration.drift_cleared`.

An unavailable desired source or stale observation MUST result in unknown or
skipped health, not a drift-cleared event.

## 15. Phase 1 NFS session feed

### SUBS-SESSION-001 — Session identity and transitions

`xinas://events/nfs/sessions` MUST publish:

- `nfs.session.connected`;
- `nfs.session.disconnected`;
- `nfs.session.protocol_changed`;
- `nfs.session.lock_threshold_crossed`;
- `nfs.session.lock_threshold_cleared`.

Session identity follows the existing `NfsSession` key of client address plus
export path. The NFS version and current lock count are bounded details.

### SUBS-SESSION-002 — Debounce

Connect/disconnect requires two consecutive successful session observations
showing presence/absence, unless a trusted kernel event source confirms the
transition earlier.

A helper failure, timeout or malformed response pauses the debounce state and
does not count as an absent observation.

### SUBS-SESSION-003 — Lock threshold

The lock threshold is disabled by default. An administrator may configure a
positive per-session or global threshold plus a lower clear threshold.

The server MUST NOT select an arbitrary universal lock count as unhealthy.

### SUBS-SESSION-004 — Privacy

The session feed contains client addresses and export paths because the same
data is already part of authorized `nfs_sessions.list`. It remains a separate
explicit subscription and MUST NOT include:

- DNS enrichment not already present in the observed session;
- client user identities or credentials;
- file names behind the lock count;
- RPC payloads.

## 16. Phase 1 system feed

### SUBS-SYSTEM-001 — xiNAS service state

`xinas://events/system` MUST publish unavailable/recovered transitions for:

- `xinas-api.service` where observable without self-contradiction;
- `xinas-agent.service`;
- `xinas-mcp.service` or the deployed MCP unit name;
- `xinas-nfs-helper.service`;
- `xiraid-server.service` or the deployed xiRAID unit name.

The spec MUST resolve actual installed unit aliases and prevent duplicate
events.

### SUBS-SYSTEM-002 — Agent heartbeat

Existing `agent_state_changed` events MUST migrate or project into:

- `system.agent.degraded`;
- `system.agent.offline`;
- `system.agent.recovered`.

The current heartbeat thresholds remain authoritative unless their owning
spec changes. Migration MUST not emit duplicate old/new events for one
transition.

### SUBS-SYSTEM-003 — Collector state

Each production collector MUST have a stable ID and expected refresh
interval. The system feed supports:

- `system.collector.failed`;
- `system.collector.stale`;
- `system.collector.recovered`.

One failed sweep may emit `failed`; `stale` requires that no valid update was
accepted within the exact bound defined by the owning collector specification.
Recovery requires a valid successful observation.

### SUBS-SYSTEM-004 — Network and RDMA links

The system feed MUST publish:

- `system.network.link_down` / `system.network.link_up`;
- `system.rdma.link_down` / `system.rdma.link_up`.

Only managed or service-relevant interfaces are included by default.
Transient monitor events MUST be reconciled with a snapshot before a down
event when the source can produce partial records.

### SUBS-SYSTEM-005 — Reboot

The API MUST persist the last observed Linux boot ID. A change produces one
`system.reboot.detected` event with `timeAccuracy: "observed"` unless a trusted
boot timestamp is available.

Process restart within the same boot MUST NOT produce a reboot event.

## 17. Authorization and security

### SUBS-AUTH-001 — Request principal

Every resource and listen request is authenticated through the same S8 path as
other modern MCP requests.

- HTTP bearer identity is bound at stream creation.
- stdio uses the existing local peer/credential projection.
- no identity is accepted from JSON-RPC params, cursor text or event details.

### SUBS-AUTH-002 — Read parity

An event may reveal no more about a subject than the principal could obtain
from the corresponding current xiNAS read surface.

The minimum role for a feed is `viewer`, but every event is filtered by the
underlying subject/read policy. If a future object type requires a higher
role, it is omitted for a viewer without revealing that an omitted event
exists.

### SUBS-AUTH-003 — Revocation and role changes

Authorization MUST be rechecked before each resource read and before queuing a
notification to an existing subscription.

Token revocation or a role reduction MUST stop future delivery promptly. The
server closes or re-acknowledges the affected subscription according to the
released protocol; it MUST NOT continue using stale in-memory admin rights.

### SUBS-AUTH-004 — Cursor non-capability

A cursor is not an authorization capability. Possessing another client's
cursor grants no access. Reads always apply the current principal's policy.

### SUBS-AUTH-005 — Injection resistance

Event summaries and details are untrusted data when consumed by an LLM.
Server-generated text MUST be factual and templated. Vendor strings, hostnames
and paths are data fields, never instructions. Raw source messages MUST not be
copied into `summary` without strict escaping and length bounds.

## 18. Rate limits, coalescing and backpressure

### SUBS-LIMIT-001 — Subscription limits

Phase 1 defaults are:

- at most 6 resource URIs per listen request;
- at most 4 active listen requests per principal;
- at most 32 active listen requests per xinas-api process;
- at most 256 unsent notification entries per stream before coalescing.

Limits are configurable downward or upward within hard bounds documented by
the S17 spec. Exceeding a limit returns a bounded JSON-RPC error and creates no
partial listener.

### SUBS-LIMIT-002 — URI coalescing

Because a resource notification is only a wake-up signal, multiple pending
updates for the same feed and subscription MUST coalesce to one notification.

The default minimum notification interval per feed/subscription is 250 ms.
Coalescing MUST NOT alter journal order or `headCursor`.

### SUBS-LIMIT-003 — Slow consumer

A slow consumer MUST NOT block event commits, observation ingest or other
subscriptions.

If the bounded stream queue cannot make progress after URI coalescing, the
server:

1. increments an overflow metric;
2. writes one bounded audit lifecycle event;
3. closes that listener;
4. retains journal rows for cursor catch-up.

It MUST NOT delete events or apply backpressure to the agent's state
convergence loop.

### SUBS-LIMIT-004 — Keep-alive

HTTP MAY emit an SSE comment every 15 seconds while otherwise idle. Keep-alive
comments do not consume notification quota, do not advance a cursor and are
not written to the journal or audit trail.

## 19. Restart, failure and consistency behavior

### SUBS-FAIL-001 — API restart

An xinas-api restart terminates in-memory listeners but preserves journal
rows, sequences and retention metadata. Clients reconnect, read after their
last cursor and issue a new listen request.

### SUBS-FAIL-002 — Agent restart

An agent restart MUST NOT reset the event sequence. The first successful
post-restart sweep is compared with the last committed API-side observation.
It may produce real transitions but must not replay every current object as
new.

### SUBS-FAIL-003 — xiRAID unavailable

When xiRAID cannot be queried:

- the xiRAID collector/source event is emitted to the system feed;
- known arrays are retained stale;
- no array is declared offline, removed, failed, completed or recovered;
- on the first valid response, normal transition comparison resumes.

### SUBS-FAIL-004 — Clock changes

Ordering depends on journal sequence, never wall-clock timestamp. NTP steps or
incorrect source timestamps do not reorder events or cursors.

### SUBS-FAIL-005 — Journal unavailable

If the event journal cannot commit, the server MUST NOT send a resource update
for that event. Observation/task correctness must not be falsely reported as
failed solely because optional notification publication failed; the S17 spec
must define whether a durable outbox retry or degraded source-health event is
used without creating a write loop.

## 20. Audit and metrics

### SUBS-AUD-001 — Subscription lifecycle audit

Audit at most one row for each lifecycle condition:

- `mcp.subscription.opened`;
- `mcp.subscription.closed`;
- `mcp.subscription.denied`;
- `mcp.subscription.overflow`;
- `mcp.event_cursor.gap_observed`.

The audit payload may contain principal, transport, accepted feed names,
subscription correlation ID, close reason and counts. It MUST NOT contain a
bearer token, cursor body, NFS client address or individual event payload.

Individual notifications and feed reads MUST NOT each create an audit row;
that would flood the operator trail. Existing normal request audit semantics
for an explicitly invoked resource read may be retained only if volume is
bounded and documented.

### SUBS-METRIC-001 — Required metrics

The dependency-free Prometheus endpoint introduced by S15 MUST add bounded
metrics equivalent to:

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

Metrics MUST NOT label by principal, event ID, subscription ID, controller ID,
array name, disk ID, client address, export path or task ID.

## 21. Client interoperability

### SUBS-CLIENT-001 — Official SDK client

Automated integration tests MUST use the released MCP v2 client package for
`2026-07-28` and prove:

- modern discovery advertises Resources;
- all six resources list and read;
- the cursor template lists;
- HTTP listen receives acknowledgment first;
- a committed event produces a resource update with the correct subscription
  ID;
- the client reads the event after its cursor;
- cancellation closes the listener;
- reconnect plus cursor recovers an event committed while disconnected;
- stdio multiplexes two subscriptions without crossing IDs;
- an unauthorized/unknown feed is not disclosed.

### SUBS-CLIENT-002 — Claude Code and Codex

The release evidence MUST record separate live smoke-test results for Claude
Code and Codex:

- client version/build;
- transport used;
- whether it can issue `subscriptions/listen`;
- whether it observes `notifications/resources/updated`;
- whether it automatically re-reads the resource or exposes the notification
  to the model/application;
- reconnect behavior;
- any required client configuration.

A protocol symbol in a binary, a declared MCP version or successful
`resources/list` is not proof that subscription notifications are surfaced.

If either product client lacks listen support, xiNAS still ships the standard
server capability after official SDK interop passes, but documentation MUST
state the client limitation and show `resources/read` polling as the fallback.

### SUBS-CLIENT-003 — Polling fallback

A modern client that does not open `subscriptions/listen` can poll the same
base feed resource with its cursor. The returned envelope and authorization
are identical. There is no second event API or alternate event taxonomy for
such clients.

## 22. Phase 2 xiRAID events

### SUBS-P2-RAID-001 — Restripe

Phase 2 adds to the existing RAID/progress feeds:

- start/observed-running/completed/failed for `operation.kind: "restripe"`;
- bounded `restripe_progress` events;
- `raid.maintenance.restripe_required` for `need_restripe`;
- `raid.maintenance.resize_required` for `need_resize`.

`need_restripe` is a pending/stopped condition, not proof that background work
is currently running.

### SUBS-P2-RAID-002 — SDC scan and inconsistency

Phase 2 adds:

- start/observed-running/completed/failed for
  `operation.kind: "sdc_scan"`;
- bounded `sdc_progress` events;
- `raid.consistency.inconsistent`;
- `raid.maintenance.reconstruction_required` for `need_recon`;
- `raid.maintenance.initialization_required` for `need_init`.

The state `sdc_scanning` is not normalized to healthy merely because I/O may
remain available.

## 23. Phase 2 NFS protocol events

### SUBS-P2-NFS-001 — NFSv4 grace and reclaim

Using a validated kernel, nfsd or journal source, Phase 2 adds:

- `nfs.grace.started`;
- `nfs.grace.completed`;
- `nfs.reclaim.failed`;
- `nfs.client.state_expired`;
- `nfs.backchannel.failed` and recovery where observable.

These events reflect NFSv4.1 crash-recovery semantics: during grace, lock and
some I/O requests may be rejected with `NFS4ERR_GRACE`. A process restart is
not sufficient evidence that a grace period occurred; the producer requires a
validated protocol source.

### SUBS-P2-NFS-002 — NFSd counters and rates

Phase 2 MUST collect a monotonic baseline from `/proc/net/rpc/nfsd` or an
equivalent supported kernel interface and may publish:

- `nfs.rpc.error_rate_high` / `nfs.rpc.error_rate_cleared`;
- `nfs.rpc.authentication_failures_high` and clear;
- `nfs.file_handles.stale_rate_high` and clear;
- `nfs.threads.saturated` / `nfs.threads.recovered`;
- `nfs.reply_cache_loss_high` and clear.

Events are based on rate over a defined window, not the absolute lifetime
counter. Counter reset after reboot or service restart MUST re-baseline rather
than create a spike.

### SUBS-P2-NFS-003 — Source validation

Phase 2 MUST include fixture captures for each supported Ubuntu kernel/nfsd
format. An unknown metric line degrades only that producer and emits one
bounded source warning; it does not erase NFS state or crash the agent.

## 24. Phase 2 capacity and performance events

### SUBS-P2-PERF-001 — Inodes and quotas

The storage/NFS feeds add:

- filesystem inode warning/critical/cleared events;
- user/group/project quota warning/critical/cleared events where the existing
  authorization permits the subject identity.

Thresholds require enter/clear hysteresis. Quota events MUST not expose users
or groups to a principal who cannot read the corresponding quota state.

### SUBS-P2-PERF-002 — Sustained SLO conditions

Phase 2 may publish:

- storage latency high/cleared;
- queue saturation high/cleared;
- I/O error rate high/cleared;
- NFS RPC latency high/cleared;
- NFS retransmission or timeout rate high/cleared;
- throughput below a configured SLO/cleared only while a minimum demand
  condition is proven.

Every performance event requires:

- a named metric source;
- sampling/window duration;
- minimum sample count;
- enter threshold and clear threshold;
- minimum consecutive windows;
- observed value and unit;
- explicit scope such as node, array, filesystem, export or interface.

Single samples and idle throughput MUST NOT generate an SLO violation.

### SUBS-P2-PERF-003 — No synthetic benchmark claims

S17 performance events report observed operational conditions. They MUST NOT
claim a vendor/product performance limit or benchmark regression unless the
configured SLO and workload topology are explicitly known.

## 25. Phase 2 HA and path events

### SUBS-P2-HA-001 — Supported topology only

When xiNAS supports a multi-node, mirrored, multipath or NVMe-oF topology with
a validated state source, Phase 2 may add:

- node/target reachable, probably-offline, offline and recovered;
- mirror/buddy resync required, running, failed and completed;
- primary/secondary failover and failback;
- NVMe-oF/ANA path degraded, inaccessible and recovered;
- quorum or management-service loss and recovery.

These events MUST remain absent on the current single-node topology when no
such source exists. Generic network loss MUST not be mislabeled as HA failover.

## 26. Configuration

### SUBS-CONFIG-001 — Settings

S17 configuration MUST live under one documented `mcp.subscriptions` or
equivalent section and cover only operational controls, including:

- retention age and row cap;
- read page limit;
- subscription and queue limits;
- HTTP keep-alive interval;
- notification coalescing interval;
- RAID progress bucket/minimum/maximum intervals;
- capacity enter/clear thresholds;
- optional NFS lock threshold;
- any validated platform-specific temperature threshold.

There is no configuration switch that makes the server advertise a partially
working capability. If the journal/listen subsystem is intentionally disabled,
`resources.subscribe` MUST be absent; read-only Resources MAY be advertised
only if their handlers remain complete and discovery describes the reduced
capability accurately.

### SUBS-CONFIG-002 — Validation and reload

Invalid bounds fail configuration validation before listeners start. A live
reload that reduces limits may close excess streams deterministically but
MUST NOT delete events newer than the newly validated retention policy until
the next bounded cleanup pass.

## 27. Testing requirements

### SUBS-TEST-001 — Contract tests

Contract tests MUST cover:

- released MCP request/result/notification schemas;
- all six concrete resources and the cursor template;
- event envelope schemas for every Phase 1 event type;
- stable URI/name/MIME values;
- additive OpenAPI compatibility when `/events` changes;
- `server/discover` capability truthfulness.

### SUBS-TEST-002 — Transition table tests

Table-driven tests MUST cover every supported previous/current pair for:

- all 16 xiRAID 4.4 state words;
- initialization and reconstruction lifecycle;
- member and SparePool changes;
- mount/read-only/capacity thresholds and hysteresis;
- service, collector, network and RDMA states;
- export canonicalization and backing-filesystem joins;
- NFS session debounce and lock thresholds;
- fault recovery and repeated later occurrence.

Malformed, missing, null, scalar-string, mixed and unknown state payloads MUST
be explicit cases.

### SUBS-TEST-003 — Failure injection

Tests MUST prove:

- source failure emits no false removal/offline/completion/recovery;
- event commit failure emits no notification;
- crash after commit/before notify is recovered by cursor;
- duplicate outbox replay creates one event;
- cursor expiry sets `gap`;
- restart preserves sequence;
- slow consumer is closed without blocking observation ingest;
- coalescing loses no journal rows;
- token revocation stops delivery;
- mixed authorized/unauthorized URI requests leak nothing;
- clock reversal does not break ordering.

### SUBS-TEST-004 — End-to-end tests

End-to-end fixtures MUST exercise at least:

1. subscribe to RAID;
2. valid transition into initialization;
3. acknowledgment before update;
4. feed read returning the start event;
5. progress update visible only to the progress subscriber;
6. completion event in the RAID feed;
7. disconnect, unseen event, reconnect and cursor catch-up;
8. xiRAID probe failure without false array events;
9. NFS service down/recovered;
10. export add/change/remove;
11. filesystem capacity threshold and hysteresis;
12. two stdio subscriptions with correct correlation IDs.

### SUBS-TEST-005 — Verification gates

At minimum, the implementation change MUST pass:

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:contracts
npm run build
npm run test:e2e
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint \
  --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

The PR-only OpenAPI compatibility and secret-scanning jobs remain required.

## 28. Phase 1 acceptance criteria

Phase 1 is accepted only when all statements below are true:

1. S17 and all owning-spec amendments are approved before code.
2. Modern discovery truthfully advertises complete Resource subscription
   support; legacy discovery/initialize does not.
3. All six resources list, template-list and read with private/no-cache
   semantics.
4. `subscriptions/listen` works on HTTP and stdio with acknowledgment first.
5. Only requested and authorized feeds generate updates.
6. Events commit before notification and survive API/agent restart.
7. A disconnected client catches up by cursor; an expired cursor reports a
   visible gap.
8. xiRAID initialization and reconstruction start, observed-running,
   completion and failure are distinguishable.
9. `init_progress` and `recon_progress` are not collapsed in the event path.
10. RAID degraded/offline/unrecovered/read-only/recovered, member, spare,
    media, restore and license events pass transition tests.
11. Filesystem mount/read-only/capacity and validated disk-health events pass
    transition/hysteresis tests.
12. NFS service/export/backing/RDMA and opt-in session events pass tests.
13. Agent, collector, service and link events do not convert missing data into
    false state.
14. Limits, coalescing and slow-consumer behavior lose no journal events.
15. Authorization revocation and redaction tests show no cross-principal
    leakage.
16. Audit is lifecycle-bounded and Prometheus labels have bounded cardinality.
17. Official v2 MCP client tests pass; Claude Code and Codex results are
    recorded honestly.
18. Existing REST/CLI/TUI, S15 confirmation and S16 task tests remain green.

## 29. Phase 2 acceptance criteria

Phase 2 is accepted only when:

1. every new producer has a validated source and fixture for the supported
   platform version;
2. restripe, SDC and pending-maintenance semantics preserve the exact xiRAID
   source distinction;
3. NFS grace/reclaim events are backed by protocol evidence rather than a
   service-restart guess;
4. NFSd lifetime counters are converted into restart-safe rates/windows;
5. inode/quota thresholds apply authorization and hysteresis;
6. performance alerts require sustained load-aware evidence;
7. HA/path events are enabled only on a supported topology;
8. all changes are additive to Phase 1 feeds, cursors and envelope;
9. Phase 1 acceptance remains green.

## Appendix A — Decisions carried into the S17 design

| ID | Decision | Reason |
|---|---|---|
| D-01 | Use standard resource subscriptions, not a custom xiNAS notification | Maximum MCP client interoperability and no parallel protocol |
| D-02 | Six feeds, with progress and sessions separated | Prevent noisy/identifying events from waking ordinary subscribers |
| D-03 | Notification is a wake-up; journal is the source of truth | MCP subscription streams are not resumable durable queues |
| D-04 | Coalescing is allowed only after durable commit | Backpressure control without event loss |
| D-05 | First valid observation is a baseline, not a flood | Restart must not fabricate lifecycle transitions |
| D-06 | Missing/failed observations never mean removed/offline/recovered | Fail closed on evidence quality |
| D-07 | Preserve exact xiRAID raw states and operation progress | Current normalized state/progress is lossy for event generation |
| D-08 | Keep domain events distinct from S16 task status | Requested work and resulting resource state are different facts |
| D-09 | Viewer read parity with per-subject filtering | Subscription must reveal no more than existing read APIs |
| D-10 | No universal NVMe temperature threshold | Valid temperature limits are device/platform dependent |
| D-11 | Phase 2 is additive on the same feeds/envelope | Avoid a client migration for richer telemetry |
| D-12 | Product-client support requires a live smoke test | Protocol/version presence is not proof notifications reach the user/model |

## Appendix B — Current implementation gaps the S17 spec must close

| Area | Current fact | Required consequence |
|---|---|---|
| S14 capabilities | Resources are explicitly deferred and not advertised | Add complete list/template/read/listen path before advertisement |
| S16 notifications | Generic listen/task notifications are deferred | Narrow the deferral; do not imply S17 provides task notifications |
| xiRAID source | Collector is poll-only; xiRAID exposes email notifications, not a consumed event stream | Generate observed transitions and mark time accuracy honestly |
| xiRAID progress | Parser merges reconstruction and initialization progress | Preserve separate operation identity and values |
| xiRAID states | Public projection compresses the vendor's 16 states | Retain raw state words for transition rules |
| NFS source | Sessions and exports are periodic complete snapshots | Debounce and never treat helper failure as deletion |
| Systemd source | Production refresh is polling even though collector has a subscription-shaped interface | Define detection latency from actual source, not interface shape |
| Event storage | `/xinas/v1/events/` currently holds limited KV events without the S17 cursor contract | Add a monotonic, retained operational journal |
| REST events | `/events` has a small generic shape and weak filtering/paging | Extend additively if it exposes S17 rows |
| Disk telemetry | Public types allow health/wear/temperature, but source availability is not universal | Publish only from a validated live source; expose inactive families honestly |

## Appendix C — Source-to-event map

| Source | Phase 1 use | Phase 2 use |
|---|---|---|
| xiRAID `raid_show`/member/pool observations | operation, array, member and spare transitions | restripe, SDC and pending-maintenance details |
| xiRAID drive/license observations and validated logs | media and license transitions | richer reason codes where stable |
| Filesystem/mountinfo/systemd/statfs observations | mount, read-only and capacity | inode and quota telemetry |
| ExportRule/NfsSession snapshots | export and debounced session transitions | richer client/protocol health where available |
| systemd and heartbeat state | service, agent and collector health | HA service topology where supported |
| network/RDMA observation | link and NFS-RDMA readiness | path-level performance and failover |
| `/proc/net/rpc/nfsd` or equivalent | none | RPC/auth/stale-handle/thread-rate events |
| validated performance collector | none | sustained latency, queue, errors and load-aware throughput |
| HA/NVMe-oF management source | none | target, mirror, failover and ANA path transitions |

## Appendix D — Validation record (2026-09-04)

Every normative claim above was checked against the released MCP
`2026-07-28` schema and prose, the xiRAID 4.4 documentation, the published
MCP client packages and the code on this branch (`d8bfbb1`, the S15 base).
Verdicts: **confirmed** (the claim holds as written), **corrected** (the
claim is wrong or incomplete; the S17 spec carries the correction),
**gap** (the claim assumes something the branch does not have; the spec
or plan closes it), **note** (a xiNAS-local decision that no source can
settle). Paths are relative to `xiNAS-MCP/src/` unless stated.

### D.1 MCP protocol claims

Sources: `schema/2026-07-28/schema.ts` (commit on `main`, fetched
2026-09-04), `docs/specification/2026-07-28/basic/patterns/subscriptions.mdx`,
`basic/transports/streamable-http.mdx`, `basic/transports/stdio.mdx`,
`server/resources.mdx`, `server/utilities/caching.mdx`, `changelog.mdx`,
`seps/2575-stateless-mcp.md`, and the `schema/2026-07-28/examples/*`
JSON files.

| ID | Claim | Evidence | Verdict |
|---|---|---|---|
| V-01 | The core filter has exactly `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions` (SUBS-PROTO-001) | `SubscriptionFilter` in `schema.ts`; the subscriptions page's filter table | **confirmed** |
| V-02 | A listen request carries a `notifications` object and the standard `_meta` (SUBS-LISTEN-001) | `SubscriptionsListenRequestParams { notifications: SubscriptionFilter }`; `examples/SubscriptionsListenRequest/listen-for-list-changes.json` | **confirmed** |
| V-03 | The first message per subscription is `notifications/subscriptions/acknowledged` carrying `_meta["io.modelcontextprotocol/subscriptionId"]` equal to the listen request id; on stdio ordering is per subscription id (SUBS-LISTEN-003) | `SubscriptionsAcknowledgedNotification` doc: "MUST be the first message the server sends carrying the subscription's ID … messages belonging to other subscriptions MAY be interleaved before it"; `NotificationMetaObject` | **confirmed** |
| V-04 | `notifications/resources/updated` carries `params.uri` and `_meta` only, no event body (SUBS-PROTO-002, SUBS-LISTEN-004) | `ResourceUpdatedNotificationParams { uri }`; `examples/ResourceUpdatedNotification/file-resource-updated-notification.json` | **confirmed** — the schema allows the URI to be a *sub-resource* of the subscribed one; xiNAS always sends the exact base URI (D-14) |
| V-05 | `resources/subscribe` / `resources/unsubscribe` are gone (non-goals) | `SubscriptionFilter.resourceSubscriptions` doc: "Replaces the former `resources/subscribe` RPC"; changelog item 4 | **confirmed** |
| V-06 | An unknown resource URI is `-32602`; `-32002` is retired (SUBS-RES-007) | `schema.ts` error-code partition comment ("`-32002` … replaced by `-32602`"); `resources.mdx` §Error Handling; changelog item 6 | **confirmed** |
| V-07 | `resources/list`, `resources/templates/list` and `resources/read` results must carry `resultType`, `ttlMs` and `cacheScope` (SUBS-RES-004) | `ListResourcesResult`, `ListResourceTemplatesResult`, `ReadResourceResult` all extend `CacheableResult`; `caching.mdx` "Servers MUST include caching hints on results with `resultType: "complete"` returned by … `resources/list`, `resources/templates/list`, `resources/read`" | **confirmed** |
| V-08 | The capability is `resources: { subscribe, listChanged }` (SUBS-PROTO-005) | `ServerCapabilities.resources?: { subscribe?, listChanged? }`; `resources.mdx` §Capabilities | **confirmed** |
| V-09 | Over Streamable HTTP the listen POST is answered with an SSE stream that stays open; closing it cancels; SSE comments are keep-alives; `Last-Event-ID` does not resume; a broken stream loses the request (SUBS-LISTEN-005) | `streamable-http.mdx` §Receiving Messages ("The server's response is itself an SSE stream that stays open"; "servers are encouraged to periodically emit an SSE comment line"; "Resumable SSE streams via `Last-Event-ID` are not supported"); §Cancellation; changelog item 9 | **confirmed** — the doc also asks for `X-Accel-Buffering: no` on SSE responses |
| V-10 | On stdio the client ends a subscription with `notifications/cancelled` naming the listen id; the server may send `notifications/cancelled` solely to end a listen stream; graceful teardown is a `subscriptions/listen` result (SUBS-LISTEN-006) | `CancelledNotification` doc; `subscriptions.mdx` §Cancellation and §Graceful Closure ("it **SHOULD** respond to the original `subscriptions/listen` request with a completion result before closing the stream") | **confirmed** — the requirement left the stdio teardown form open; S17 uses the result form on both transports (D-13) |
| V-11 | The graceful result body is `{ resultType: "complete", _meta: { subscriptionId } }` | `SubscriptionsListenResult`; `examples/SubscriptionsListenResult/listen-closed.json` | **confirmed** |
| V-12 | The acknowledgment may carry an empty `notifications` object and the server may then end the subscription (SUBS-LISTEN-007) | `SubscriptionsAcknowledgedNotificationParams` ("Only includes notification types the server actually supports"); nothing forbids an empty subset or an immediate graceful close | **note** — xiNAS-local rule, schema-valid |
| V-13 | `resources/read` is a plain read | `ReadResourceRequestParams extends ResourceRequestParams, InputResponseRequestParams`; `ReadResourceResultResponse.result: ReadResourceResult \| InputRequiredResult` — a read may be an MRTR | **corrected** — feeds never elicit; a read carrying `inputResponses` or `requestState` is `-32602` (D-15) |
| V-14 | Resource annotations "do not claim mutability" (SUBS-RES-001) | `Annotations` has `audience`, `priority`, `lastModified` only; there is no mutability field | **note** — satisfied by omitting `annotations`; `lastModified` would churn per event and is not sent |
| V-15 | A private `application/vnd.xinas.events+json` MIME type is acceptable | `Resource.mimeType?: string` and `ResourceContents.mimeType?: string` are free-form | **confirmed** |
| V-16 | The schema and SEP-2575 disagree somewhere on listen framing (SUBS-LISTEN-006 asks the spec to resolve it) | SEP §`subscriptions/listen` RPC, §Cancellation and the released schema describe the same request/ack/notification/result shapes and the same HTTP/stdio cancellation | **confirmed — no conflict found**; the schema remains the tie-breaker |
| V-17 | `resources/list` and `resources/templates/list` are paginated | Both requests extend `PaginatedRequest` (`cursor?`); results extend `PaginatedResult` (`nextCursor?`) | **note** — six resources fit one page; a `cursor` the server never issued is `-32602` |
| V-18 | Every POST must carry `MCP-Protocol-Version` matching `_meta` and the server must reject a mismatch | `streamable-http.mdx` §Protocol Version Header | **gap (pre-existing, S14)** — `api/mcp/modern.ts` reads `_meta` only; the header is not validated on this branch. Out of S17 scope; recorded in `docs/TODO.md` |

### D.2 Product claims (xiRAID 4.4, NFS)

| ID | Claim | Evidence | Verdict |
|---|---|---|---|
| V-19 | The 16 state words in SUBS-RAID-001 are the complete xiRAID 4.4 vocabulary | [AG / Showing RAID State](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html): `online initialized initing inconsistent degraded reconstructing offline need_recon need_init read_only unrecovered none restriping sdc_scanning need_resize need_restripe` — 16 words, spelled as in the requirement | **confirmed** |
| V-20 | Member states and progress fields | Same page: member states `online offline reconstructing need_recon`; progress fields `init_progress`, `recon_progress`, `restripe_progress`, `sdc_progress`, each 0–100 % | **confirmed** — `restripe_progress` / `sdc_progress` are Phase 2 producers but the parser retains all four from Phase 1 (SUBS-SPEC-005) |
| V-21 | xiRAID email is not an event stream xiNAS can consume (SUBS-SPEC-007, Appendix B) | [AG / Setting up email notifications](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/setting_up_email_notifications.html) configures recipients through `xicli mail` / `xicli settings mail modify` and describes no log, socket or API for the events | **confirmed** |
| V-22 | The requirement's RAID event families cover the vendor's email list | Vendor list (same page): info — init/recon started/progress/completed, "System is up after reboot/crash", healthy/online now, drive returned, SparePool drive reconnected/disconnected, automatic replacement; warning — init/recon not completed, read-only now, not restored after reboot, SparePool ran out of drives, degraded now, bdev error count increased, restored read-only/offline after reboot, drive offline now, could not replace, replaced with null, fault threshold reached, critical wear-out; error — offline now, unrecovered now, license expired, license drive limit exceeded | **confirmed** — every vendor event has a Phase 1 type. The vendor's *levels* (info/warning/error) differ from S17 severity in places (e.g. vendor "read-only now" is warning, S17 `raid.state.read_only` is error); SUBS-EVENT-004 already requires an explicit table |
| V-23 | Media, license, replacement-outcome and wear events have an observable source today (SUBS-RAID-005/006 say "MUST support") | The daemon computes these from bdev error counters, SMART wear, the license file and its own replacement logic. xiNAS observes `raid_show` (states, progress, members, sparepool name), `pool_show` (pool drives) and, on demand only, `xicli license show` through `health.probe` (`agent/rpc/methods/health-probe.ts`). No periodic license, per-bdev error-count or wear observation exists; `Disk.status.health` is in `api-v1.yaml` but no probe fills it | **corrected** — these families are **source-gated** (D-16): the wire contract and severity table define them in Phase 1, the producers activate only when a validated periodic source exists, and each feed read exposes the inactive families. Requirement D-06 ("never fabricate") outranks the "MUST support" wording |
| V-24 | `nfs-idmapd.service` / `nfs-mountd.service` are observed (SUBS-NFS-001) | `agent/probe/systemd.ts` allow-list: `nfs-server.service`, `nfs-mountd.service`, `nfs-idmapd.service` (+ S7: `xinas-api.service`, `xinas-agent.service`) | **confirmed** |
| V-25 | The xiNAS service list in SUBS-SYSTEM-001 | `xinas-mcp.service` was retired by ADR-0010 (only the uninstall role still names it, for cleanup); `xinas-nfs-helper.service` and the xiRAID daemon unit (`xiraid-server.service` per `docs/Notifications/spec-email-notifications.md`; not vendor-documented) are **not** in the allow-list | **corrected** — drop `xinas-mcp.service`; add the other two to the agent allow-list (D-18); a unit whose `load_state` is `not-found` produces no service event |
| V-26 | NFSv4.1 grace semantics (Phase 2) | RFC 8881 §8.4.2 — `NFS4ERR_GRACE` during the grace period | **confirmed** — Phase 2 only |

### D.3 Client and SDK claims

| ID | Claim | Evidence | Verdict |
|---|---|---|---|
| V-27 | A released MCP v2 client speaks `subscriptions/listen` (SUBS-CLIENT-001) | `@modelcontextprotocol/client` 2.0.0 (`dist/index.d.mts`): `Client.listen(filter: SubscriptionFilter, options?): Promise<McpSubscription>` — resolves on the ack, exposes `honoredFilter`, `close()` (aborts the HTTP request **and** sends `notifications/cancelled`), and settles a termination promise with `graceful` / dropped causes; `StreamableHTTPClientTransport` parses SSE `message` events with `eventsource-parser`, sends `Accept: application/json, text/event-stream` and the `mcp-protocol-version` header | **confirmed** — the package is not yet a devDependency on this branch (S15 §15.4 planned it; `package.json` still lists only `@modelcontextprotocol/sdk ^1.12.0`); S17 adds it |
| V-28 | The v2 client uses string listen ids | `Client._nextListenId` — `'listen:' + N`; the ack demux keys on the id verbatim | **note** — xiNAS must echo the request id with its original JSON type (string or number); tests cover both |
| V-29 | Claude Code / Codex surface subscriptions (SUBS-CLIENT-002) | Not verifiable from this environment: a protocol symbol in a binary is not proof (the requirement says so itself) | **gap (release evidence)** — the smoke-test protocol and the polling fallback are written now (spec §16); the two result rows stay "pending" until run on a node |
| V-30 | The MCP `2026-07-28` JSON schema can validate the wire messages in tests | `schema/2026-07-28/schema.json` is vendorable; `ajv` is already a devDependency (contracts test) | **confirmed** — not vendored on this branch yet (S15 planned it); S17 vendors it under `__tests__/contracts/mcp/2026-07-28/` |

### D.4 Codebase claims (Appendix B and the SUBS-* rules)

| ID | Claim | Evidence | Verdict |
|---|---|---|---|
| V-31 | S14 defers Resources and does not advertise them | `api/mcp/discover.ts` `buildCapabilities()` emits `tools` only; `s14-mcp-modern-era-spec.md` §1 "Out of scope", §4 "`resources`, `prompts` — absent" | **confirmed** |
| V-32 | S16 defers `subscriptions/listen` and task notifications | `s16-mcp-tasks-requirements.md` §14 TASKS-NOTIFY-002; no `s16-mcp-tasks-spec.md` exists yet | **confirmed** — SUBS-SPEC-004 amends the requirements document; the S16 spec inherits the wording when written |
| V-33 | The xiRAID parser merges reconstruction and initialization progress | `lib/parse/raid.ts:228` `numberOrNull(o.recon_progress) ?? numberOrNull(o.init_progress)` → `status.rebuild_progress_pct` | **confirmed** |
| V-34 | The public projection compresses the 16 vendor states | `parseRaidShowEntries` keeps `states: string[]` but `parseRaidShow` publishes only `status.state = deriveState(states)`; the raw list is dropped at the array level (member words are kept in `member_states[].states`) | **confirmed** — additive `status.raw_states` + four progress fields (spec §8.1, `api-v1.yaml`) |
| V-35 | NFS sessions and exports are periodic complete snapshots; a helper failure must not look like deletion (SUBS-NFS-002, SUBS-GEN-002) | `agent/collectors/nfs.ts` polls every 30 s, no event source; `agent/poll.ts:65-77` catches a failed `initialSweep()` and sends **no** `flushWithSnapshot`; `agent/boot.ts:38-63` likewise skips the reconcile flush for a kind whose sweep threw ("unknown, not no entities") | **confirmed** — a source failure never reaches the api as a delete; the api-side engine additionally treats a missing batch as "no observation" (D-20) |
| V-36 | The systemd source is polling although the collector keeps a subscription-shaped interface | `agent/collectors/systemd.ts` header comment: the dbus subscription was removed (ADR-0009); 30 s poll | **confirmed** — detection latency for service events is the 30 s poll |
| V-37 | Events live under the `/xinas/v1/events/` KV prefix; `/events` is a weak listing | `api/heartbeat.ts:296-312` writes `agent_state_changed` rows; `api/routes/events.ts` lists the prefix and ignores the `since` / `severity` query parameters `api-v1.yaml` declares | **confirmed** — the journal replaces the writer; `/events` reads the journal and keeps its shape (D-22) |
| V-38 | Disk health / wear / temperature have no live source | `lib/parse/disk.ts` `ObservedDisk.status` has no `health`; `agent/collectors/disk.ts` forwards none | **confirmed** — `storage.disk.*` families are source-gated (D-16) |
| V-39 | A Prometheus endpoint exists from S15 (SUBS-METRIC-001) | Only the catalog entry `system.metrics` (`GET /metrics`, `binary: true`) and the `ConfirmationMetrics` no-op interface exist; `lib/metrics.ts` and `routes/metrics.ts` are S15 Task 13, not landed at `d8bfbb1` | **gap** — S17 defines its counters behind a `SubscriptionMetrics` interface with an in-memory implementation; the text exposition attaches to the S15 registry when it lands (D-17) |
| V-40 | Observation ingest already compares previous and current values in one SQLite transaction (SUBS-JOURNAL-003) | `api/internal/observed.ts:165-222`: one `kv.transaction`, `tx.get(key)` before every upsert, canonical compare with `observed_at` stripped, reconcile deletes in the same transaction | **confirmed** — the transition engine runs inside that transaction; no outbox is needed for observation-derived events. Heartbeat-derived and reboot events are single-row inserts (their own transaction) |
| V-41 | `KvStore.watch` fires after commit | `state/store.ts` doc: "events fire after the underlying transaction commits" | **note** — not used for feeds; the journal writer returns the touched feeds and the handler notifies after the transaction returns |
| V-42 | The stdio adapter can carry a listen stream | `mcp-stdio.ts` is a per-message bridge: one POST, one JSON body, replies serialized on a promise chain (`chain = chain.then(() => bridge(line))`) | **corrected** — a listen request would block every later message and its SSE body would be emitted as one line. S17 amends S14 §7 ("`src/mcp-stdio.ts` — no change") and changes the adapter (D-19) |
| V-43 | `/mcp` is JSON-response-only | `api/mcp/transport.ts`: the modern path answers `res.json()`; `GET /mcp` is 405; the SDK transport runs `enableJsonResponse: true` | **confirmed** — the listen response is the one SSE response on the modern path; the legacy SDK path is untouched |
| V-44 | Bearer identity can be re-checked per notification (SUBS-AUTH-003) | `transport.ts` `resolveIdentity()` reads `ctx.config.tokens`, loaded once at process start; there is no config reload | **note** — the subscription retains the bearer and re-resolves it before every delivery; today "revocation" is a restart, which already terminates listeners |
| V-45 | Session identity is client address + export path; ExportRule identity is path + host pattern (SUBS-SESSION-001, SUBS-NFS-002) | `api-v1.yaml` `NfsSession.id`: `<client_addr>:<export_path>`; observed `ExportRule` rows are keyed by `encExportId(export_path)` and carry `status.rules[] { host_pattern, options, … }` (`agent/collectors/nfs.ts:142-161`) | **confirmed** — export events diff `rules[]` per path row; the rule identity is `(export_path, host_pattern)` |
| V-46 | Mount, read-only and capacity fields exist (SUBS-STORAGE-001/002) | `api-v1.yaml` `Filesystem.status`: `mounted`, `mount_unit_state` (incl. `failed`), `effective_mount_options` (carries `ro`/`rw` — S5 §"Which mount table"), `size_bytes`, `free_bytes` | **confirmed** |
| V-47 | Link and RDMA link fields exist (SUBS-SYSTEM-004) | `NetworkInterface.status.link_state` / `rdma_link_state` (`up\|down\|unknown`), `rdma_capable`; managed-ness is the desired row (`spec.managed_by_xinas`) | **confirmed** |
| V-48 | NFS-over-RDMA readiness has a source (SUBS-NFS-004) | Observed `NfsProfile.status.rdma_listening` / `rdma_port`; desired `NfsProfile.spec.rdma.enabled` | **confirmed** |
| V-49 | Agent heartbeat transitions exist and suppress the first appearance (SUBS-SYSTEM-002, SUBS-GEN-001) | `HeartbeatTracker.currentState()` emits only after `#bootstrapped`; thresholds 2×/6× interval | **confirmed** — the emitter is redirected to the journal; thresholds unchanged |
| V-50 | Collector failure is visible api-side; staleness is not (SUBS-SYSTEM-003) | The tracker captures `collectors: { <Kind>: 'running' \| 'stubbed' \| 'error: …' }` per heartbeat; the api records only a global `lastObservationPushAt`, never per kind | **gap** — the observed handler records a per-kind last-accepted timestamp (D-24) |
| V-51 | A boot id is observed (SUBS-SYSTEM-005) | Nothing reads `/proc/sys/kernel/random/boot_id`; the `inventory` collector emits hostname/kernel/cpu/mem only | **gap** — the inventory probe adds `boot_id`; the `inventory` kind has a permissive inbound validator, so the field is additive (D-23) |
| V-52 | Observed arrays persist across a reboot so "previously known arrays" is meaningful (SUBS-RAID-007) | Observed rows live in `xinas.db` and survive api/agent restarts; the agent's first post-boot `XiraidArray` sweep reconciles the set | **confirmed** — a reconcile delete or a `none` state seen after a boot-id change becomes `raid.restore.failed`, not a generic removal |
| V-53 | The e2e harness can drive xiRAID transitions (SUBS-TEST-004) | `agent/xiraid/fake-transport.ts` `raidShow()` returns the `xiraid-state.json` arrays verbatim (`state: string[]`, extra keys pass through), so a test can write `initing` + `init_progress` and then `online`/`initialized`; `XINAS_AGENT_XIRAID_POLL_MS` shortens the poll | **confirmed** |
| V-54 | Configuration validation pattern | `api/config.ts` `validateMcpSection()` — bounded integer checks with explicit error text | **confirmed** — copied for `mcp.subscriptions` |
| V-55 | Lifecycle audit rows have a pattern | `api/mcp/confirmation/audit.ts` queues `mcp.confirmation.*` rows through `AuditAppender.queue()` (in or out of a transaction) | **confirmed** — `mcp.subscription.*` rows follow it |
| V-56 | Retention needs its own sweeper | `state/gc.ts` prunes terminal tasks only; `lease-sweeper.ts` is the timer pattern | **confirmed** |
| V-57 | Spare-pool membership is observable (SUBS-RAID-005) | Observed `Pool` rows `{name, drives, active}` (`lib/parse/pool.ts`); arrays carry `spec.spare_pool` and `spec.spare_disk_ids` | **confirmed** — `spare.disconnected` / `spare.returned` / `spare_pool.exhausted` derive from pool-drive set changes; `spare.replacement.completed` derives from a member set change whose new member was a pool drive in the previous snapshot (an observed fact, not timing proximity); `replacement.failed` has no source (D-16) |
| V-73 | SUBS-RES-001 "exactly the six Phase 1 base resources" | S18 (`s18-mcp-raid-create-app-spec.md`, MCP Apps, in flight on the S15 branch at the time of writing) adds `ui://xinas/raid-create` to modern `resources/list` / `resources/read` and advertises `resources: {}` | **corrected** — the six feeds are the first six entries in a stable order; other providers follow; the capability object is the union (D-26) |

### D.5 Internal consistency of the requirement

| ID | Observation | Resolution in S17 |
|---|---|---|
| V-58 | SUBS-RES-001 requires *exactly six* resources while SUBS-STORAGE-003 wants inactive event families "exposed in source health/capability metadata" | The feed read envelope gains an optional `producers` object (`active` / `inactive` families with a reason); no seventh resource |
| V-59 | SUBS-RAID-006 says the media and license families "MUST" be supported; V-23 shows no source | Source-gated families (D-16); listed per feed in `producers.inactive` until a collector lands; recorded in `docs/TODO.md` |
| V-60 | SUBS-SYSTEM-001 names `xinas-mcp.service` | Retired unit; removed (V-25) |
| V-61 | SUBS-LISTEN-006 leaves the stdio teardown form open | The `subscriptions/listen` result on both transports (D-13) |
| V-62 | SUBS-SPEC-008 asks to "remove the Resources deferral in `docs/TODO.md`" | No such entry exists; the deferral lives in ADR-0010 §Deferred and S14 §1, which S17 amends. `docs/TODO.md` gains the Phase 2, source-gated-family, smoke-test and protocol-version-header entries instead |
| V-63 | SUBS-SPEC-004 asks to amend the S16 *spec* | Only the S16 requirements exist; §14 of that document is amended and the S16 spec inherits it |
| V-64 | SUBS-METRIC-001 assumes the S15 Prometheus endpoint | Interface now, exposition when the registry lands (D-17) |
| V-65 | SUBS-SESSION-002's "two consecutive successful observations" vs the complete-snapshot reconcile that deletes an absent session on the first sweep | Batch-based debounce (D-20): the reconcile delete makes the session a *candidate*; the next complete `NfsSession` snapshot without it confirms `disconnected`; one that re-upserts it cancels the candidate; a failed sweep sends no snapshot and counts for nothing |
| V-66 | SUBS-JOURNAL-003 asks for one transaction or an outbox | One transaction, by construction (V-40); no outbox |
| V-67 | SUBS-RES-005 "latest `limit` events" with ascending order | The newest N rows by `sequence`, returned ascending; `nextCursor` is the last returned |
| V-68 | SUBS-AUTH-003 "token revocation stops delivery promptly" | Re-resolve on every delivery (V-44); with static config the only revocation path today is a restart, which closes every listener |
| V-69 | SUBS-EVENT-001 `sequence` survives restarts | SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` never reuses a value, even after deletes |
| V-70 | SUBS-JOURNAL-004 "forged" cursors | A cursor is not a capability (SUBS-AUTH-004); the integrity tag only detects tampering/corruption and maps to `-32602` (D-21) |
| V-71 | SUBS-CLIENT-002 requires *recorded* smoke results before release | Cannot be produced on the development machine; the spec fixes the protocol and the fallback text now, the rows stay pending (V-29) |
| V-72 | SUBS-SYSTEM-001 `xinas-api.service` "where observable without self-contradiction" | The api never reports its own unavailability. Its `SystemdUnit` row is observed only while it runs, so the api emits `system.service.recovered` for itself when a previously observed `failed`/`inactive` row turns `active`, and nothing else |

## Appendix E — Decisions added by validation

| ID | Decision | Reason |
|---|---|---|
| D-13 | Graceful teardown sends the `subscriptions/listen` result on both transports; the server never sends `notifications/cancelled` | `subscriptions.mdx` makes the result the SHOULD; one code path for both transports; the v2 client reports it as `graceful` (V-27) |
| D-14 | `notifications/resources/updated` always carries the exact subscribed base URI | Clients demultiplex by URI; sub-resource URIs would force every client to normalize |
| D-15 | `resources/read` with `inputResponses` or `requestState` → `-32602` | Feeds never elicit (non-goal); silently ignoring MRTR fields would hide a client bug |
| D-16 | Source-gated event families: `raid.device.*`, `raid.license.*`, `raid.spare.replacement.failed`, `storage.disk.*` are defined in the wire contract and severity table in Phase 1; their producers activate only with a validated periodic source; each feed read lists them under `producers.inactive` | V-23, V-38; D-06 (never fabricate) outranks the "MUST support" wording |
| D-17 | Metrics are defined behind `SubscriptionMetrics` with an in-memory implementation; Prometheus exposition attaches to the S15 registry when it lands | V-39 — the endpoint does not exist on this branch |
| D-18 | Service units: `nfs-server`, `nfs-idmapd`, `nfs-mountd`, `xinas-api` (recovered only), `xinas-agent`, `xinas-nfs-helper`, `xiraid-server` (the last two added to the agent allow-list); `xinas-mcp.service` dropped | V-25, V-72 |
| D-19 | `xinas-mcp-stdio` becomes SSE-aware: a listen request runs off the serial chain, every SSE `data:` line is written to stdout as its own JSON line, an inbound `notifications/cancelled` naming a live listen id aborts that HTTP request, and the graceful result is forwarded verbatim | V-42 |
| D-20 | `NfsSession` disconnect debounce is batch-based (candidate on reconcile delete, confirmed by the next complete snapshot without the id) | V-35, V-65 |
| D-21 | Cursor = `base64url("1" ‖ controllerId ‖ feed ‖ sequence ‖ tag8)` where `tag8` is the first 8 bytes of SHA-256 over the preceding fields; any mismatch is `-32602` | V-70; opaque and versioned without a secret |
| D-22 | The journal is the SQLite table `operational_events` in `xinas.db`; the `agent_state_changed` KV writer is retired; `GET /events` serves journal rows in the legacy `Event` shape plus additive fields and cursor paging | V-37; one store, one sequence |
| D-23 | The boot id arrives as `inventory.status.boot_id` from the agent; the api persists the last one in `operational_event_meta` | V-51 |
| D-24 | The observed handler records a per-kind last-accepted timestamp for `system.collector.stale` | V-50 |
| D-25 | `MCP-Protocol-Version` header validation stays an S14 gap, recorded in `docs/TODO.md` | V-18 — pre-existing, not a subscription concern |
| D-26 | Resources compose across slices through one provider seam: feeds first in `resources/list`, scheme-dispatched `resources/read`, `resources` capability = union with `subscribe` owned by S17 | V-73 — S18 serves an app resource on the same modern path |
