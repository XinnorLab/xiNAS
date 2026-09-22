# ADR-0019: Placement observations for pNFS data-server placement (S20)

- **Status:** accepted — first prototype implemented 2026-09-22
- **Date:** 2026-09-22
- **Stream:** S20
- **Supersedes / amends:** extends ADR-0002 (one new poll-only collector, no
  new agent privilege), ADR-0003 (one new observed singleton kind),
  ADR-0010 (one new viewer-rank read route in the catalog). Does not change
  any mutation path.

## Context

PEAK:AIO Lattice (a pNFS Flex Files metadata server) can use xiNAS shares
as its data servers. Its community-edition placement is round-robin or,
with the XinnorLab `wrr` module, weighted by capacity or by static
weights — none of which knows that a share's backing RAID is
reconstructing or that its XFS went read-only. The agreed MVP package
(2026-09-22) puts a small connector on each MDS that turns **storage
facts** into a per-data-server permission and multiplier, and asks xiNAS
for those facts through a read-only API (`s20-placement-observations-
requirements.md`).

Facts that shaped the decision (re-verified on `release/3.14` @
`4a47fadf`):

- The existing collectors observe xiRAID every 30 s, filesystems every
  60 s, exports every 30 s. The connector's evidence TTL is 20 s
  (DEC-13). Speeding up the existing collectors would also speed up their
  `blkid`/`statfs`/`pool_show`/disk-inventory work for every consumer.
- `health.context` already projects share → filesystem → array, but by
  `/dev/xi_` prefix and without the external log device (SRC-12).
- The RAID parser drops non-string state words and folds
  init/recon/restripe into one bucket (SRC-13); the filesystem probe
  cannot tell "not mounted" from "mountinfo unreadable" (SRC-14).
- The api has no HTTPS listener; RBAC is catalog-driven and deny-by-
  default for unknown routes (SRC-15, SRC-16).

## Decision

1. **A separate, lean, 5-second collector** (`PlacementObservationCollector`)
   publishes one observed singleton, `PlacementObservations/default`,
   through the existing agent → api push. It reuses the existing probe
   objects but calls only their cheap read paths (raid_show, unit files +
   mountinfo, list_exports, one `systemctl show`, `/proc/fs/nfsd/versions`).
   The 30/60 s collectors are untouched.
2. **The graph is computed in the agent, at collection time**, so one push
   is one coherent snapshot; the api only recomputes ages, reconciles
   with desired shares and enforces limits. The GET never calls the agent.
3. **Facts, not verdicts.** The response carries raw state words with a
   validity flag, mount-table facts, export rules and nfsd state, plus
   typed per-resource collection status. It never carries `allowed`, a
   multiplier or a Lattice DS id (DEC-18).
4. **Freshness is the api's arithmetic**, from its own monotonic clock at
   push receipt plus the agent's intra-cycle offsets, and a restarted api
   answers 503 `SOURCE_NOT_READY` until the next push. HTTP time never
   refreshes evidence (API-14).
5. **Parser changes are additive**: `state_valid` and preserved invalid
   words on arrays/members; `super_options`, `mount_source`,
   `mountinfo_readable` on filesystems. Existing consumers keep their
   fields and semantics.
6. **The shares the agent publishes are the exports it serves** on managed
   filesystems (the agent cannot read desired state, ADR-0002); the api
   reconciles with desired `Share` rows at read time and names the gap
   (`EXPORT_ABSENT`, `SHARE_UNMANAGED`).

## Consequences

- One new observed kind in `OBSERVED_KINDS`, `Kind`, and `api-v1.yaml`;
  one new route, catalog entry and tag; three new `ErrorCode` values
  (`SOURCE_NOT_READY` / `SOURCE_STALE` / `SNAPSHOT_TOO_LARGE`, all 503),
  an in-memory receipt clock on the api context, and one out-of-cycle
  subprocess in the agent (the xiRAID package version, once per process).
- Both daemons change → `Requires-Rebuild: xinas_node_build`.
- Deferred to later changes (recorded in `docs/TODO.md`): HTTPS ingress
  and the dedicated connector credential (API-19), kernel-effective
  export rules (API-10), nested/bind-mount topology (API-05), a durable
  share incarnation counter, rate limiting and the soak measurements
  (API-23), a readiness endpoint (API-24).
- The prototype has been exercised in unit tests against fixtures only;
  the acceptance rows T-04..T-09, T-18, T-27, T-28, T-30, T-33 are **NOT
  RUN** on hardware.
