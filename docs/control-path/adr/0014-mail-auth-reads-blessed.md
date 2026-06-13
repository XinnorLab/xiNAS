# ADR-0014: Mail/auth-modes reads blessed as live xiRAID read-throughs

- **Status:** accepted
- **Date:** 2026-06-13
- **Stream:** S9 follow-up (closes the last ADR-0011 deferral)
- **Supersedes / amends:** resolves the "mail/auth-modes read promotion to
  agent-observed data" deferral in ADR-0011 §Deferred and the S9 spec; amends
  the "deprecated-until-agent-coverage" rows for `/mail/*` and `/auth/modes`
  in ADR-0010 §read-route promotion.

## Context

S8 (ADR-0010) promoted the carried legacy reads to real `/api/v1` routes but
marked three as **deprecated-until-agent-coverage**: `GET /mail/recipients`,
`GET /mail/settings`, `GET /auth/modes`. Each is served live from the
localhost xiRAID gRPC client on every request (`api/handlers/read-seams.ts`),
not from observed KV. S9 retired the equivalent `GET /pools` passthrough by
giving pools an agent collector + `Pool` Kind, leaving mail/auth-modes as "the
only deprecated reads" with a deferred item: *promotion to agent-observed
data*.

Revisiting that deferral against the code, promotion is **not worth its
cost**:

- **No consumer of observed state.** Nothing in xiNAS reads mail or
  auth-modes from KV — no TUI screen, not in config-history snapshots, not in
  drift. A collector + `Kind` + observed-schema + fixtures would feed nothing.
- **xiRAID-owned, no xiNAS mutation surface.** These are xiRAID settings; the
  control-path has no mail/auth write path (the legacy mutating mail/auth
  tools return `NOT_IMPLEMENTED`, ADR-0010). xiNAS is a pure reader here.
- **`auth.modes` cannot drift.** `settingsAuthShow` returns the supported NFS
  security flavors (`sys`, `krb5`, …) — a near-static capability list, not
  mutable state. Observing it is churn for zero drift value.
- **The live contract is already safe.** `read-seams.ts` returns `null` when
  the gRPC backend is unreachable, so the routes degrade with a
  `DEGRADED_BACKEND_UNAVAILABLE` warning and HTTP 200, never a 5xx. The
  existing `__tests__/api/promoted-reads.test.ts` pins both the viewer happy
  path and this degrade-not-5xx contract for all three.

## Decision

`mail.recipients`, `mail.settings`, and `auth.modes` are **permanent,
intentional live xiRAID gRPC read-throughs** (viewer reads), NOT promoted to
observed KV. The "deprecated-until-agent-coverage" framing is dropped:

- Catalog descriptions (`api/mcp/catalog.ts`) and OpenAPI summaries
  (`api-v1.yaml`) reword "deprecated read-only gRPC path" → "live xiRAID gRPC
  read-through". Their `status` stays `live`, `min_role` stays `viewer` — no
  runtime change.
- **Contract (unchanged behavior, now blessed):** served live per request; on
  xiRAID-gRPC-unavailable they return HTTP 200 with a
  `DEGRADED_BACKEND_UNAVAILABLE` warning. Staleness is request-time (there is
  no observed copy and so no poll interval).

No collector, `Kind`, observed-schema, route, or test changes — the routes and
their tests already encode the blessed behavior. This is a decision + wording
change only.

## Alternatives considered

- **Promote to agent-observed (mirror S9 pools)** — rejected for this slice: a
  collector + `Kind` + schema + fixtures that nothing consumes, and
  `auth.modes` is a static capability that cannot drift. If mail config later
  needs to join config-history/drift, observing **mail** specifically becomes
  worthwhile and is a clean additive follow-on; this ADR does not preclude it.
- **Leave them marked "deprecated"** — rejected: "deprecated" implies a
  removal/replacement that is not coming; the marker misrepresents a stable,
  supported read.

## Consequences

- The ADR-0011 deferral set is now fully closed; mail/auth-modes are no longer
  "the only deprecated reads" — they are blessed live reads.
- These three reads have request-time freshness and no observed history; an
  operator wanting point-in-time mail/auth state reads them live.
- If a future need to track mail config in snapshots/drift arises, promoting
  **mail** to observed reopens as an additive change against this baseline;
  `auth.modes` remains a live capability read.
