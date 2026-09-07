# S18 — MCP RAID Create App

Status: implementation specification  
Date: 2026-09-04  
Depends on: S3 xiRAID array create, S8 MCP catalog/dispatcher, S14 modern MCP,
S15 MRTR confirmation

## 1. Objective

Provide an interactive MCP App for preparing and starting creation of a
xiRAID array. The App is a progressive enhancement over the existing
`arrays.create` tool; it does not add another array-creation executor or bypass
the existing plan/apply, RBAC, audit, lease, idempotency, or MRTR paths.

The operator can:

1. enter an array name;
2. choose a RAID level, strip size, block size, and optional spare pool;
3. select member disks from the observed inventory;
4. review client-side topology checks and estimated usable capacity;
5. request the authoritative xiNAS plan;
6. review blockers, warnings, and the server-rendered diff;
7. hand the reviewed plan to the host for secure MRTR-confirmed apply.

## 2. Standards contract

The App implements the stable MCP Apps extension
`io.modelcontextprotocol/ui` (`2026-01-26`):

- the launch tool declares `_meta.ui.resourceUri`;
- the UI is a `ui://` resource;
- `resources/list` and `resources/read` expose it;
- resource content uses `text/html;profile=mcp-app`;
- the View communicates with the host through
  `@modelcontextprotocol/ext-apps`;
- the bundled HTML is self-contained and requests no network, media, camera,
  microphone, geolocation, or clipboard permission.

Text-only clients retain all existing tools and behavior. A client that does
not implement MCP Apps may still call `arrays.create` directly.

## 3. MCP surface

### 3.1 Launch tool

Add `mcp_apps.raid_create`:

- mutability: `read`;
- minimum role: `admin`;
- inputs: none;
- UI resource: `ui://xinas/raid-create`;
- result: server-owned UI configuration derived from the same constants as
  array validation.

The launch call MUST NOT create a plan, task, confirmation, lease, desired
state, or xiRAID request.

### 3.2 UI resource

`resources/list` contains exactly one `ui://` entry, served through the S17
resource provider seam (`api/mcp/resources.ts`; `appsProvider()` in
`api/mcp/apps.ts`) next to the `xinas://events/…` feeds whenever those are
installed:

```json
{
  "uri": "ui://xinas/raid-create",
  "name": "xiNAS RAID Create",
  "description": "Interactive xiRAID array creation wizard",
  "mimeType": "text/html;profile=mcp-app"
}
```

`resources/read` for that URI returns one complete HTML5 document as a
`CacheableResult` (`ttlMs: 0`, `cacheScope: private`, like every S17 read).
An unknown `ui://` URI is `-32602` (`invalid resource uri`) and never falls
through to a file path. The view is never subscribable: a
`subscriptions/listen` filter naming it is dropped from the honored filter
silently (S17 §5.3), and `resources/templates/list` carries no template for
it.

The resource metadata sets an empty external CSP allowlist and requests a
visible host border. No secrets, bearer tokens, loopback tokens, or local file
paths may appear in the document.

### 3.3 Discovery

Modern `server/discover` advertises `resources` as the union the S17 seam
computes — `{ "subscribe": <true iff the S17 feeds are installed>,
"listChanged": false }` — plus:

```json
{
  "extensions": {
    "io.modelcontextprotocol/ui": {
      "mimeTypes": ["text/html;profile=mcp-app"]
    }
  }
}
```

Legacy `initialize` advertises `resources: {}` and the same extension; the
SDK server lists and reads only the view there (the S17 feeds are
modern-only).

The tool remains listed for non-App clients; `_meta` is an ignorable
progressive-enhancement field.

## 4. Configuration source

`GET /api/v1/mcp/apps/raid-create` backs the launch tool and returns:

- all writable RAID levels;
- per-level minimum members, even-member requirement, and whether
  `group_size` or `synd_cnt` is required;
- allowed strip sizes and block sizes;
- name length/character guidance;
- the existing inventory, plan, apply, and task tool names.

The handler MUST derive levels and constraints from
`lib/xiraid/schema.ts`; it must not maintain a second hand-written RAID rule
table.

## 5. Inventory behavior

After connecting, the View calls `disks.list`, `arrays.list`, and `pools.list`.
It normalizes standard xiNAS envelope results from the text content returned by
the tools.

Every observed disk remains visible. A disk is selectable only when all of the
following hold:

- `status.safe_for_use === true`;
- `status.system_disk !== true`;
- `status.mounted !== true`;
- `status.xiraid_membership` is absent or null;
- its device path does not begin `/dev/xi_`;
- it is not a drive in an observed spare pool.

Disabled disks show a reason. The View MUST NOT manufacture missing identity,
capacity, health, or eligibility facts. A refresh clears any selected disk that
became ineligible and invalidates the current plan.

The UI displays stable Disk `id` as the selection identity and may display
device path, model, serial, capacity, NUMA node, temperature, wear, and health
as operator aids. Only IDs are sent as `member_disk_ids`.

## 6. Form rules

### 6.1 Name

The name is 1–28 Latin letters, digits, or underscores. `power` and `uevent`
are rejected. This client-side check is advisory; the server plan is
authoritative.

### 6.2 RAID topology

The initial level is `raid6`; the initial strip size is `128` KiB; the initial
block size is `4096` bytes.

The View applies the server-provided topology rules:

- `raid10` needs an even number of members;
- `raid50`, `raid60`, and `raid70` expose `group_size`; member count must split
  evenly into at least two groups;
- `n+m` exposes `synd_cnt`;
- controls irrelevant to the selected level are omitted from the submitted
  spec rather than sent as null.

The View may calculate estimated usable capacity from the smallest selected
disk. The estimate MUST be labelled as an estimate and MUST NOT replace the
server plan or observed post-create capacity.

### 6.3 Optional fields

The operator may select an existing spare pool. The App never creates a pool
or accepts spare disk IDs in an array request.

Advanced tuning and `force_metadata` are out of scope for S18. In particular,
the UI never presents a control that can overwrite stale xiRAID metadata.

## 7. Plan and apply workflow

### 7.1 Plan

`Review plan` calls:

```json
{
  "name": "arrays.create",
  "arguments": {
    "mode": "plan",
    "spec": {
      "name": "data",
      "level": "raid6",
      "member_disk_ids": ["..."],
      "strip_size_kib": 128,
      "block_size": 4096
    }
  }
}
```

The View shows the returned `plan_id`, risk, rollback model, affected
resources, diff, blockers, and warnings. `Create array` is disabled whenever
the plan has a blocker.

Any form or inventory change after planning marks the plan stale and requires
a new plan.

### 7.2 Secure apply handoff

The App MUST NOT call an alternative write endpoint or mark an MRTR response
as accepted by itself. Clicking `Request secure creation` sends a user message
to the host containing the exact reviewed `arrays.create` apply arguments:

- `mode: apply`;
- `plan_id` from the displayed plan;
- `expected_revision` from `state_revision_expected` (zero for create when
  omitted by an older response);
- a newly generated UUID `idempotency_key`.

The message instructs the host to execute the existing tool and continue
through S15 MRTR. The host owns the confirmation UI and the follow-up
`tools/call`; the View cannot self-confirm. A host that cannot send messages
leaves the plan usable through the ordinary conversation or `xinasctl`.

This boundary is intentional: MCP Apps' standard `tools/call` result is a
`CallToolResult`, while S15's modern apply may return an
`InputRequiredResult`. Routing apply to the host preserves the single MRTR
implementation and makes the human confirmation visible in the host rather
than hiding it inside the iframe.

## 8. Task progress

S18 does not add a second task monitor. After a successful apply, the existing
result returns `task_id` and the `tasks.wait` next hint. The host follows that
hint. S17 is implemented, but MCP Apps hosts relay tool calls and results to
a view, not `subscriptions/listen` streams, so the view keeps following the
hint; recorded in `docs/TODO.md`.

## 9. Accessibility and layout

- All controls have visible labels and keyboard focus states.
- Disk cards use native checkboxes and are operable without a pointer.
- Validation is conveyed in text as well as color.
- The layout supports 360 px through desktop widths.
- The View follows the host light/dark preference and does not depend on
  external fonts or images.

## 10. Failure behavior

- Inventory failures leave the form non-submittable and show the tool error.
- Malformed tool content is treated as an error, not as an empty inventory.
- Transport failures never clear a previously displayed server error.
- A plan with blockers is reviewable but not applicable.
- A stale or rejected apply is reported by the host; the App never retries an
  apply automatically.
- The View never preselects disks.

## 11. Acceptance criteria

1. `mcp_apps.raid_create` appears in `tools/list` with the UI resource link.
2. Legacy and modern resource list/read return the same resource descriptor
   and HTML.
3. The launch endpoint and tool require the `admin` role.
4. The configuration values equal the canonical xiRAID schema constants.
5. The View loads inventory and disables every ineligible disk with a reason.
6. Level-dependent fields and member-count rules update immediately.
7. The View sends exactly one plan request per `Review plan` click.
8. Form edits invalidate the plan.
9. A blocked plan cannot start an apply handoff.
10. Apply handoff contains the exact reviewed plan ID/revision and a fresh
    idempotency key, and no bearer or confirmation answer.
11. The bundle loads no external script, style, image, font, or network data
    and declares no optional sandbox permission.
12. Typecheck, lint, formatting, unit/contract tests, production build, and
    OpenAPI validation pass.

## 12. Non-goals

- array import, modify, delete, restore, resize, or restripe;
- creating or editing spare pools;
- choosing raw device paths instead of stable Disk IDs;
- advanced xiRAID tuning or metadata overwrite;
- bypassing plan/apply or MRTR;
- embedding credentials in the View;
- replacing the existing CLI, REST API, task engine, or subscription roadmap.
