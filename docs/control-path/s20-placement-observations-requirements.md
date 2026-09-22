# xiNAS S20 — Placement observations for pNFS data-server placement (requirements)

**Status:** translated requirements, 2026-09-22. Source: "Lattice ↔ xiNAS
Connector — MVP Requirements" (Russian, 2026-09-22, the agreed v4 package
that replaces v2/v3). This file carries the xiNAS-side requirements
(`API-nn`) plus the connector/Lattice decisions xiNAS must know about
(`DEC-nn`, and the `XMOD-nn` / `CON-nn` rows that constrain what the
source API has to publish). The connector itself and the Lattice MDS
integration live in `XinnorLab/pNFS`; they are cited, not restated. The
design that implements this is
[`s20-placement-observations-spec.md`](s20-placement-observations-spec.md);
the decision record is ADR-0019.

Requirement IDs are the source's. Where the prototype scopes a
requirement down, the spec says so inline and `docs/TODO.md` carries the
deferral.

## 1. Purpose

A pNFS metadata server (PEAK:AIO Lattice) places new files on NFS data
servers. When those data servers are xiNAS shares, Lattice should not put
new data on a share whose backing array is reconstructing, whose XFS is
read-only, or whose export has vanished — and it should prefer healthy
shares over degraded ones. xiNAS does not decide any of that. It
publishes **provable facts** about its shares and the resources they
depend on; a connector module on each MDS turns those facts into a
per-data-server permission and weight.

The source-of-truth boundary (DEC-18, API-01): xiNAS gives
**observations per share**; the connector gives **decisions per DS**.
xiNAS never learns Lattice's numeric DS ids, never computes a weight and
never says "allowed".

## 2. Decisions fixed by the MVP package that bind xiNAS

| ID | Decision | What it means for xiNAS |
|---|---|---|
| DEC-01 | One registered NFS export/share = one DS; one xiNAS = several DS | Observations are keyed by share; shared resources (filesystem, arrays, nfsd) appear once and are referenced |
| DEC-07 | Arrays + members + external log/realtime dependencies + basic mount/rw/export/service checks are mandatory | All of these must be in the snapshot, with typed collection status each |
| DEC-08 | Extended FS diagnostics, network scoring, latency/IOPS/load/quotas are future inputs; coverage must show this | `coverage[]` lists them as `NOT_IMPLEMENTED` with a reason |
| DEC-13 | Source poll 5 s; source evidence TTL 20 s | The agent must observe on a 5 s cycle; a 30/60 s cadence is not acceptable (SRC-11) |
| DEC-14 | degraded = 0.25; reconstruction/init/restripe/pending faults deny; scan alone is not penalised | xiNAS publishes raw state words, not a verdict; the table lives in the connector profile |
| DEC-16 | Unknown/stale deny; no neutral fallback | The API must say UNKNOWN/ERROR honestly rather than emit a healthy-looking default |
| DEC-18 | xiNAS API = observations per share; connector API = decisions per DS | No `allowed`, `multiplier` or `ds_id` in the xiNAS response |

## 3. What the source code establishes (SRC-11..16)

Re-verified on `origin/release/3.14` @ `4a47fadf` while writing the spec:

- **SRC-11** — collectors poll xiRAID every 30 s, filesystems every 60 s,
  NFS exports every 30 s; the production filesystem watch adapter is a
  no-op. A 20 s evidence TTL is incompatible with those cadences; a new
  bounded observation cycle is required.
- **SRC-12** — `health.context` links share → filesystem → one backing
  array by `volume_path`; the external log device is not part of the
  projection. A full topology projection (data/log/realtime) is new.
- **SRC-13** — the RAID parser keeps `raw_states` but `normalizeStates`
  silently drops non-string words and the compressed `state` folds
  init/recon/restripe together. Placement needs the raw words plus an
  explicit shape validity.
- **SRC-14** — the filesystem probe swallows a mountinfo read failure and
  then derives `mounted=false` from the empty list; effective options are
  the VFS options only. `mounted` must distinguish "absent" from "could
  not read", and super options (`logdev=`, `rtdev=`) must be published.
- **SRC-15** — the api listens on a Unix socket by default, over
  `node:http`; a remote HTTPS endpoint is not one new route. TLS ingress,
  a viewer credential and deployment config are separate deliverables.
- **SRC-16** — RBAC is catalog-driven and an unmatched route requires
  admin. The new read route must be registered for viewer rank.

## 4. Requirements for the xiNAS API and agent (API-01..24)

### 4.1. API boundary

- **API-01.** Add a read-only endpoint `GET /api/v1/placement/observations`.
  It publishes provable facts and topology for xiNAS shares. It returns no
  Lattice `ds_id`, `allowed` or multiplier; placement is the connector's
  job.
- **API-02.** The response keeps the existing envelope (`request_id`,
  `correlation_id`, `state_revision`, `warnings`, `errors`, `links`,
  `result`). `result` is the source schema v1 (Appendix Д of the source
  package). The envelope's `state_revision` is not a global snapshot
  generation; a separate monotonic `source_generation` is.
- **API-03.** The endpoint returns the full snapshot of every managed
  share of the node, no pagination: up to 256 shares, 16 MiB. Shared
  resources appear once in `resources[]`. Over the limit → HTTP 503 with a
  typed `SNAPSHOT_TOO_LARGE` error, never a truncated "COMPLETE".
  Unsupported topology is shown as UNKNOWN per share, not omitted.

### 4.2. Identities and graph

- **API-04.** `controller_id` is the stable xiNAS identity; `server_epoch`
  is the publisher's incarnation; `source_generation` is a monotonic
  publication sequence. Every share has a stable `share_id`, an
  `incarnation` (changes on delete/recreate even with the same id/path),
  `export_path`, `filesystem_ref`, `export_ref`, `service_ref`.
  Generations are not derived from the current time.
- **API-05.** Filesystem identity is a controller-scoped UUID plus a
  persistent incarnation on recreate, not just the mount unit name. The
  resource carries mountpoint, source device identity, mounted/writable,
  fs type and the required data/log/rt references. One share → one
  filesystem in the MVP; exports crossing nested filesystems, bind mounts
  with ambiguous backing, unresolvable symlinks and crossmnt topologies
  get `UNSUPPORTED_TOPOLOGY` / UNKNOWN.
- **API-06.** The share → filesystem mapping is built from the host mount
  namespace and the real mount table: longest valid containing
  mountpoint, path-segment match, exact device identity, VFS and super
  options considered. A `/dev/xi_` prefix, a textual source match or the
  desired mount options are not sufficient. Desired/live conflict →
  UNKNOWN until reconciled.
- **API-07.** The resource graph holds `ARRAY`, `FILESYSTEM`, `EXPORT`,
  `NFS_SERVICE` (optional `NETWORK` later). Each required resource has
  `collection_status` SUCCESS/ERROR/UNKNOWN, `observed_at`,
  `evidence_age_ms`, `reason_codes` and typed `details`. A reference to a
  missing required resource makes that share UNKNOWN without touching
  independent shares. SUCCESS requires complete typed details and an
  observation time; ERROR/UNKNOWN may carry details with only `kind`,
  null times, and a non-empty `reason_codes`. Known ids are kept; a
  missing observation is not filled with invented UUIDs or states.
- **API-08.** `ARRAY` details: stable id/incarnation, name, `volume_path`,
  xiRAID edition/version/build, `raid_level`, normalized lower-case
  `raw_states[]`, original payload shape validity, member records with
  group/index/path/identity/states/validity, separate init/recon/restripe/
  sdc progress where available. Progress 100 does not prove completion.
  The legacy compressed optimal/degraded/rebuilding is not the source of
  the placement decision.
- **API-09.** `FILESYSTEM` details: UUID/incarnation, mountpoint,
  mounted, writable, fs_type, source identity, observed mount options and
  super options, external-device resolution status and references. An
  unknown boolean is `null` with a reason; "not mounted" differs from
  "mountinfo unreadable". Desired values never stand in for the actual rw.
- **API-10.** `EXPORT` details: effective path, present, normalized
  effective access rules (clients, rw/ro, security), incarnation, source
  timestamp. If the collector reads only `/etc/exports`, it must be
  complemented by the effectively applied rules; desired config must not
  be called effective. `NFS_SERVICE`: confirmed kernel nfsd runtime and
  supported protocol configuration; enabled ≠ running, `active (exited)`
  interpreted correctly.

### 4.3. Collection, consistency and freshness

- **API-11.** An opt-in passive placement observation cycle in the agent
  with period 5 s and deadline 2 s. Existing probes may be reused, but all
  API consumers read one published result; a GET never triggers a heavy
  re-probe. Changing only the connector's polling while keeping RAID 30 s /
  FS 60 s is not acceptable.
- **API-12.** Collection is bounded and coalesced: one cycle per node at a
  time; the same raw command runs once for many shares. No SMART, full
  disk inventory, statfs capacity or active probes in the fast cycle.
  Timeouts must terminate the subprocess, not just the Promise.
- **API-13.** A snapshot uses a coherent local topology/config generation.
  If topology changes during collection, re-read (bounded) or publish the
  affected shares UNKNOWN/PARTIAL. Per-resource times are kept. A fully
  successful cycle proves presence/absence; a failed enumeration proves no
  deletion.
- **API-14.** `evidence_age_ms` is computed server-side from a monotonic
  observation clock. After a restart the old monotonic base is invalid:
  until a fresh collection, persisted observations are UNKNOWN. Repeated
  GETs show a growing age. `generated_at`/HTTP time does not replace
  `observed_at`.
- **API-15.** `snapshot_status` COMPLETE/PARTIAL/FAILED describes
  enumeration completeness, separate from health. COMPLETE may contain an
  offline array. A collector error never becomes an empty successful
  array.
- **API-16.** The parser preserves invalid-shape evidence: `[online, 42]`
  must not read as healthy — `state_valid=false` with a reason; unknown
  state words are kept and reach the module; a member without a readable
  path/id is not dropped silently from completeness.
- **API-17.** The source API is passive/read-only: no reconstruction,
  init, `exportfs` apply, mount/unmount, test-file writes or LLM prompts.
  Not the deep health endpoint every 5 s. A monitoring failure never
  drives the NFS service.

### 4.4. Remote access, RBAC, errors

- **API-18.** A dedicated REST viewer credential, the route registered in
  the canonical RBAC catalog; viewer allowed, unauthenticated 401,
  unauthorized 403, mutations denied. The bootstrap admin token is not
  used for polling. No MCP apply/confirmation.
- **API-19.** HTTPS ingress in front of the existing Unix API socket with
  certificate hostname verification and bearer auth. The current
  `node:http` TCP listener is not "HTTPS". Ingress allows only GET of this
  endpoint for the connector credential, preserves Authorization, does
  not bypass auth via the trusted-UDS shortcut. TLS listener/port/address,
  MDS firewall allowlist and token rotation are Ansible deliverables.
- **API-20.** Status codes: 200 with COMPLETE/PARTIAL and resource
  errors; 401/403 auth; 429 bounded rate limit; 503 source not ready /
  global FAILED / oversize (result may be null, `errors` carries a typed
  code). Clients treat non-JSON proxy errors as transport failures. HTTP
  200 by itself never permits placement.
- **API-21.** Contract major = 1; `capabilities` name the checks and
  source versions. New optional diagnostics are allowed; changed meaning
  of required fields needs a version negotiation. `api-v1.yaml` carries
  the exact schema, route, errors and examples; contract CI checks
  equivalence with the shipped JSON Schema.

### 4.5. Deployment and operations

- **API-22.** Route, agent collector, publisher/ingest, schemas, RBAC,
  role templates, generated JS and service wiring ship as one compatible
  version. `dist/` rebuild and restart of both consumers are mandatory:
  the change carries `Requires-Rebuild: xinas_node_build` plus the role
  tags it touches. A route without a working collector is not a delivery.
- **API-23.** Cached endpoint latency p99 ≤ 100 ms at the declared maximum
  response; collector cycle ≤ 2 s or explicit timeout/PARTIAL. Rate
  limiting admits two MDS at 5 s each plus diagnostic fetches; CPU
  overhead and audit-DB growth are measured under soak.
- **API-24.** Readiness reports the supported contract, actual enabled
  coverage, collector period and the last successful generation. Failure
  details carry per-resource timestamps and error codes, no secrets, no
  arbitrary command output. Readiness never says HEALTHY/allowed.

## 5. Connector-side constraints that shape the payload (XMOD/CON)

- **XMOD-02** — one HTTP poll returns the shared observations for every
  share of the node; a separate `raid_show` per share is not acceptable.
- **XMOD-03** — the module validates graph completeness: share → export,
  service, filesystem; filesystem → data/log/rt arrays; every mandatory
  reference resolves in the same snapshot.
- **XMOD-06** — raw state is an array of words considered independently
  of order; empty/missing/null/mixed-type payload or unknown word →
  UNKNOWN; no silent removal of non-strings.
- **XMOD-07** — allow needs `online` and, where the level requires it,
  proven initialization; RAID 0 has no `initialized`; the API passes the
  level.
- **XMOD-11** — unmounted / read-only / service stopped → VALID deny;
  unreadable mountinfo / collector error → UNKNOWN deny. A vanished nested
  mount never falls back to the parent filesystem.
- **XMOD-12** — external logdev/rtdev are mandatory when present in the
  actual FS configuration; internal log is N/A only with proof.
- **XMOD-13** — export existence is proven by an effective export
  observation; supported client rules are IP/CIDR/`*`; netgroup/hostname
  rules → UNKNOWN.
- **XMOD-14** — a removed share under a successful COMPLETE enumeration
  is a VALID deny `SHARE_ABSENT`; under a collection failure it is
  UNKNOWN; a recreated share does not inherit trust.
- **CON-10/11** — the connector uses conservative source age plus the
  full request duration; the API's UTC timestamps are for audit, the ages
  are what count.
- **CON-21** — source API limits are separate from the connector's
  (≤ 256 DS per MDS, 4 MiB local batch).

## 6. Acceptance rows that exercise xiNAS (from the T-01..35 matrix)

| Test | Requirements | Scenario |
|---|---|---|
| T-04 | API-04..09, XMOD-10..12 | A/B use data1+log1, C uses data2+log2; a log1 fault blocks A/B, C stays eligible |
| T-05 | API-06, XMOD-11 | Missing nested mount, wrong device/source, mountinfo error, symlink/bind ambiguity → UNKNOWN, no parent-FS fallback |
| T-08 | API-09/10, XMOD-11/13 | Healthy RAID + RO/unmounted FS or missing/RO export/nfsd stopped → deny; unreadable data → UNKNOWN |
| T-09 | XMOD-13 | CIDR/wildcard coverage; netgroup/security/conflicts excluded |
| T-18 | CON-10..14, API-11..16 | Frozen source behind HTTP 200, aging TTL, repeated snapshot, cached replay; `generated_at` does not refresh data |
| T-27 | API-18..21, CON-20 | TLS hostname/CA failures, viewer auth, 401/403/429/503, token rotation, redirect/header safety |
| T-28 | API-22/23 | Real installed agent/API/ingress chain; cadence confirmed; a disabled service is not masked by stubs |
| T-30 | API-15, CON-15 | Optional network NOT_IMPLEMENTED visible; required unsupported coverage rejects the profile |
| T-33 | CON-21, API-03/23 | 256 DS, oversize rejected, no truncated COMPLETE; 24 h soak |

## 7. Explicitly out of the MVP (source §1 "Границы")

Production ZFS connector, HA failover storage control, automatic
migration/evacuation, layout recall on connector health, blocking writes
on existing layouts, a new capacity API, a latency-aware scheduler,
network failure-domain mirroring. Several shares of one node are not
independent failure domains; with the connector enabled `mirror_count=1`.

## 8. Sources

- The Russian MVP package (2026-09-22), sections 1, 2, 5, 6, 7 and
  Appendices В/Д (the example response and the JSON Schema this spec
  implements verbatim).
- xiRAID Classic 4.4 state vocabulary:
  <https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html>.
- `XinnorLab/pNFS` (the connector and the Lattice integration patches).
