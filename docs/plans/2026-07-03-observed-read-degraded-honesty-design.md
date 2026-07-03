# Observed-read degraded honesty — design

**Date:** 2026-07-03
**Status:** design approved, pre-implementation
**Owning specs (durable):**
[docs/control-path/s8-clients-spec.md](../control-path/s8-clients-spec.md) §5.1,
[docs/Storage/raid-management-spec.md](../Storage/raid-management-spec.md) §3,
[docs/Storage/fs-shares-management-spec.md](../Storage/fs-shares-management-spec.md) §3.2

## Problem

`GET /api/v1/arrays`, `/disks`, and `/filesystems` are pure reads of the
observed-state store (`listByPrefix('/xinas/v1/observed/<Kind>/')` in
`src/api/routes/storage.ts`). When the backing collector has errored —
e.g. the `XiraidArray` collector reports `error: XIRAID_DAEMON_UNAVAILABLE`
because the xiRAID daemon is unreachable — no rows are flushed and the route
returns `[]` **with HTTP 200 and no warning**.

Every control-path consumer then cannot distinguish "genuinely zero" from
"backend down": the RAID and Filesystem TUI screens render
"(no … configured)", and MCP `*.list` / `xinasctl … list` return an empty
list. This is the exact confusion behind the "TUI shows no arrays even
though `xicli raid show` lists them" report (PR #243 fixed the parser that
made arrays *never* observable; this change makes the *unobservable* case
honest).

## Mechanism — reuse existing collector-health tracking

The API already tracks per-collector health. `HeartbeatTracker`
(`src/api/heartbeat.ts`) captures a `collectors: Record<string, string>`
map on every successful agent heartbeat, where an errored collector's
value is the string `error: <reason>` (produced by
`CollectorRegistry.healthSnapshot`). The tracker already consults it
(`#hasCollectorError`) to degrade node state, and `currentSnapshot()`
exposes it (surfaced today at `GET /api/v1/system` →
`node.status.agent.collectors`). No new plumbing is required — the read
routes just consult the same map.

`error: <reason>` is the only value that denotes a fault. `running` and
`stubbed` do NOT degrade (a stubbed/deferred collector is an expected
state, mirroring `#hasCollectorError`).

## API change (TypeScript — `xiNAS-MCP/src`)

New pure helper (co-located with the read handlers):

```ts
// returns [] when there is no tracker (read-only test contexts) or the
// collector is healthy/stubbed; one warning when it is errored.
export function degradedCollectorWarnings(ctx: ApiContext, kind: string): Warning[] {
  const health = ctx.tracker?.currentSnapshot().collectors[kind];
  if (typeof health === 'string' && health.startsWith('error')) {
    return [{
      code: 'DEGRADED_BACKEND_UNAVAILABLE',
      message: `${kind} observation is degraded (${health}); the list may be empty or stale.`,
    }];
  }
  return [];
}
```

Wire it into the three list routes in `src/api/routes/storage.ts`, passed as
`sendOk`'s `warnings` argument:

| Route | Collector kind |
|---|---|
| `GET /api/v1/arrays` | `XiraidArray` |
| `GET /api/v1/disks` | `Disk` |
| `GET /api/v1/filesystems` | `Filesystem` |

Properties:

- `DEGRADED_BACKEND_UNAVAILABLE` is the **existing** code the deprecated
  promoted-read routes already emit (`src/api/routes/promoted-reads.ts`) —
  this extends an established pattern, not a new one.
- The `result` payload is unchanged (the observed list, possibly stale). The
  warning is purely additive, so **no `api-v1.yaml` schema change** —
  `warnings[]` is already part of every envelope, and warnings already
  propagate to MCP results and `xinasctl` (s8-clients-spec §1 T4).

## TUI change (Python — `xinas_menu`, runs from source)

Shared helper:

```python
# xinas_menu/api/control_client.py (or a small util module)
def degraded_banner(envelope: dict) -> str | None:
    for w in envelope.get("warnings") or []:
        if w.get("code") == "DEGRADED_BACKEND_UNAVAILABLE":
            return w.get("message") or "Backend unavailable"
    return None
```

The **RAID** screen (`_show_quick` / `_show_extended`) and the **Filesystem**
screen (`_show_filesystems`) switch from `control.result(path)` to
`control.get(path)` so they can read both `result` and `warnings`:

- **Degraded** → render a distinct banner above any rows, e.g.
  `⚠ xiRAID backend unavailable — array list may be empty or stale`; and when
  the list is empty, **replace** the "(no RAID arrays configured)" /
  "No XFS filesystems found." empty-state with that unavailable message so it
  can never be mistaken for "genuinely none".
- **Healthy** → unchanged.

## Out of scope (explicit)

- **Physical Drives** TUI screen (`screens/drives.py`) rides the legacy gRPC
  `disk_list()` seam, which already has an `(ok, data, err)` error channel and
  shows "Error: …" on failure; it is not a `/api/v1/disks` consumer, so it is
  neither affected by the silent-empty ambiguity nor a recipient of the new
  warning. The API-side `/disks` warning still benefits MCP `disks.list` and
  `xinasctl disks list`.
- Single-item `GET /…/:id` (returns `NOT_FOUND` — different semantics).
- The create/modify/delete wizards' operational array fetches.
- The pre-S8 staleness in the two Storage specs (they still reference
  `grpc.raid_show()` / `findmnt`); this change adds the degraded-honesty note
  against the actual control-path source but does not rewrite that prose.

## Testing (TDD)

- **API:** unit tests for `degradedCollectorWarnings` (errored / running /
  stubbed / no-tracker). Extend `src/__tests__/api/routes-storage.test.ts` so
  each of the three list routes carries the warning when its collector is
  errored and omits it when healthy.
- **TUI:** unit tests for `degraded_banner`; render tests that the RAID and
  Filesystem screens show the banner and the replaced empty-state when the
  envelope carries the warning.

## Delivery

The API change is TypeScript compiled into `dist/` and served by
`xinas-api.service`, so the shipping commit needs
`Requires-Rebuild: xinas_node_build, xinas_api`
(see [[ts-changes-need-rebuild-trailer]]). The TUI change is Python and runs
from source — it needs no trailer.
