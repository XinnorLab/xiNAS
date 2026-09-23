# xiNAS S20 — Placement observations for pNFS data-server placement (design spec)

**Status:** first prototype implemented 2026-09-22 (this document is the
contract the code was written to; "Prototype" notes inline say where the
prototype stops short of the requirement and `docs/TODO.md` carries each
deferral). Extends the **S0/S1 agent** specification (collectors,
publisher, observed KV), **ADR-0003** (the state store), **ADR-0009** /
**S7** (the health engine — reused for facts, not for verdicts),
**ADR-0010** / `s8-clients-spec.md` (the catalog-driven RBAC and the
`/mcp` gate) and **S17** (typed collection status). Its decisions are
recorded in **ADR-0019** (`adr/0019-placement-observations.md`).

**Requirements source:**
[`s20-placement-observations-requirements.md`](s20-placement-observations-requirements.md)
(`API-nn`, `DEC-nn`, `XMOD-nn`, `CON-nn`, `T-nn` are cited throughout).
The consumer — the `lattice-ds-connector` and its `xinas` module — lives
in `XinnorLab/pNFS` and reads only what §5 defines.

## 1. Scope

### In scope

- One new read route, `GET /api/v1/placement/observations` (API-01), in
  the RBAC catalog at viewer rank (API-18), documented in `api-v1.yaml`
  with the JSON Schema of the source package embedded as the response
  schema (API-21).
- One new agent collector, `PlacementObservationCollector`, on its own
  5 s / 2 s cycle (API-11, API-12), publishing **one** observed singleton
  `PlacementObservations` through the existing `/internal/v1/observed`
  path (API-22: same ingest, same schema validation, same audit).
- Parser hardening for placement: `state_valid` and preserved invalid
  words on arrays and members (API-16, SRC-13); super options and the
  mount-table source identity on filesystems (API-09, SRC-14).
- The share → filesystem → data/log/rt arrays → export → nfsd projection
  (API-04..07, SRC-12), computed inside the agent at collection time so
  every reader sees one coherent snapshot (API-13).
- Freshness: monotonic `evidence_age_ms` per record, recomputed on every
  GET; UNKNOWN after an api restart until the next successful push
  (API-14); `snapshot_status` separate from health (API-15).
- Limits and typed errors: 256 shares / 16 MiB → `SNAPSHOT_TOO_LARGE`
  503, source not ready → 503 (API-03, API-20).

### Out of scope (deferred, see `docs/TODO.md`)

- HTTPS ingress, the dedicated viewer credential and its rotation, the
  MDS firewall allowlist (API-19, API-18 second half). The prototype is
  reachable over the api's Unix socket and over the existing TCP listener
  when one is configured; both are plain HTTP. The Ansible deliverable is
  a separate change.
- Effective export rules from the kernel (`/var/lib/nfs/etab` /
  `exportfs -v`). The nfs-helper reads `/etc/exports`; the prototype
  publishes those rules and says so in `coverage` (`export.effective_access`
  = `EVALUATED` with `source: /etc/exports` in the details) — a
  documented gap against API-10, not a silent one.
- Nested-mount / bind-mount / symlink topology (API-05, T-05). The
  prototype resolves a share to the longest containing mountpoint of a
  **managed** filesystem with an exact device match and marks anything
  else `UNSUPPORTED_TOPOLOGY`.
- Rate limiting (429) and the soak/latency measurements of API-23.
- A readiness endpoint (API-24); readiness facts are carried in the
  observations result (`collection_period_ms`, `coverage`,
  `source_generation`).

## 2. Component map

```
agent                                          api
─────────────────────────────────────────      ────────────────────────────────
PlacementObservationCollector (5 s, 2 s)  ──▶  POST /internal/v1/observed
  ├─ xiraid client   raidShow()                  kind PlacementObservations
  ├─ filesystem probe snapshotForPlacement()     id   'default'
  ├─ nfs probe        listExports()              (audited; permissive ingest
  ├─ systemd probe    nfs-server.service          validator, receipt stamped)
  ├─ nfsd             /proc/fs/nfsd/versions             │
  ├─ xiraid-version   dpkg-query, once per process       ▼
  ├─ identity caches  disk ids, XFS UUIDs         KV /xinas/v1/observed/
  ├─ lib/placement-graph (pure) ── graph rules       PlacementObservations/default
  └─ desired shares   (api → agent? no: see §4.4)       │   + ObservedReceipts
                                                          ▼     (api mono clock)
                                            GET /api/v1/placement/observations
                                              api/placement/read.ts: ages, desired-
                                              share reconciliation, limits, 503s (§5)
```

The collector is **passive** (API-17): it runs the same read-only probes
the existing collectors run, never `exportfs`, never a mount, never a
test write, never the health engine. The GET never reaches the agent
(API-11); it reads one KV row.

## 3. Parser changes (`src/lib/parse/`)

### 3.1. `raid.ts` — shape validity (API-16, XMOD-06)

`RaidShowEntry` and `RaidShowMember` gain:

- `state_valid: boolean` — `true` iff the daemon's `state` field was a
  non-empty array (or a single non-empty string, the 4.3 formatter) whose
  every element is a non-empty string. Any null/undefined/empty, any
  non-string element (`[online, 42]`), any object → `false`.
- `states` keeps **every** string word lower-cased; when `state_valid` is
  false the string words that were present are still kept (so the
  evidence is not destroyed), and the connector sees `state_valid=false`
  and treats the array as UNKNOWN regardless.
- Members: the same pair; a member entry whose path cannot be read is
  **no longer dropped** from `members` — it becomes
  `{ device: null, state_valid: false, states: [] }` so the completeness
  of the member list is preserved (API-16 last sentence). `devices[]`
  (the aligned path list consumed by `member_disk_ids`) still excludes it,
  which keeps every existing consumer's behaviour unchanged.

`ObservedXiraidArray.status` gains `state_valid` and per-member
`state_valid`, `device_present`. Additive; `api-v1.yaml` `XiraidArray`
schema gains the optional fields.

### 3.2. `filesystem.ts` / the probe — mount-table facts (API-06, API-09)

The filesystem probe already reads `/proc/self/mountinfo` once per sweep.
It now publishes on `status`:

- `super_options: string[]` — the last mountinfo field (`rw`, `logdev=…`,
  `rtdev=…`), which is where XFS names its external devices.
- `mount_source: string` — the mount table's `source` for the matched
  entry (exact device identity as mounted, not the unit's `What`).
- `mountinfo_readable: boolean` — `false` when the read failed; in that
  case `mounted` is **absent** (not `false`) so "unknown" is
  distinguishable from "not mounted" (SRC-14).

The cross-reference becomes exact: an entry matches only when
`mountpoint === Where` **and** `source === What` (a mountpoint served by a
different device, or the device mounted elsewhere, is not a match). When
the mountpoint is in the table but served by another device, the probe
publishes `mounted: false` together with
`mount_source_mismatch: <that device>` so the consumer (§4.5) can name
the conflict (`MOUNT_SOURCE_MISMATCH`) instead of inferring it from the
absence of a match. `super_options` and `mount_source` are present only
on a match; `mountinfo_readable` is always present.

## 4. The collector (`src/agent/collectors/placement.ts`)

### 4.1. Cadence and bounds (API-11, API-12)

- `pollIntervalMs = 5_000` (override `XINAS_AGENT_PLACEMENT_POLL_MS`,
  tests only); the PollDriver runs `initialSweep()` on that interval like
  every other poll-only collector.
- `deadline = 2_000 ms`, enforced with an `AbortController` around the
  whole cycle and per-probe `Promise.race`; on deadline the cycle
  publishes what it has with the late resources `ERROR/COLLECTION_TIMEOUT`
  and `snapshot_status: PARTIAL`. Subprocess-backed probes are the existing
  ones and keep their own timeouts; the collector does not spawn anything
  new.
- Re-entrancy guard: a cycle that is still running when the next tick
  fires is skipped (counted, logged once per minute), never stacked.
- One `raidShow()`, one filesystem `snapshot()`, one `listExports()`, one
  `systemctl show nfs-server.service`, one read of
  `/proc/fs/nfsd/versions` per cycle, shared by every share (XMOD-02).
  No `pool_show`, no `blkid`, no `statfs`, no disk inventory, no
  `systemctl is-enabled`/`is-active` per unit in this cycle (API-12) — the
  probe's enrichment hooks are bypassed by a lean `snapshotForPlacement()`
  that reads unit files + mountinfo only and returns the managed rows
  together with the node's whole mount table (`mountpoint`, `source`,
  `fstype`) for the nested-mount rule of §4.5. One `fs.realpath` per
  export path (an lstat chain, no subprocess) proves the path canonical.
- The only subprocess the collector ever causes is **outside** the cycle:
  the xiRAID package version (`dpkg-query -W -f='${Version}' xiraid-core`,
  `src/agent/probe/xiraid-version.ts`) is read once per agent process and
  cached; a failed read is retried at most once a minute. The daemon's
  `raid_show` payload carries no version, and the connector's
  compatibility manifest keys on `version`/`build`. The cached read is
  awaited inside the same deadline guard as every other source (audit
  F-09); a late answer reads as `XIRAID_VERSION_UNAVAILABLE`.
- The cycle is **opt-in** (API-11, audit F-09): `placement.enabled` in
  the agent config (`xinas_agent_placement_enabled`, default `false`).
  Off, the collector is not registered and the route answers
  `503 SOURCE_NOT_READY`.
- The graph itself is a pure function (`src/lib/placement-graph.ts`,
  `buildPlacementGraph`): the collector only gathers inputs and stamps
  times, so every rule in §4.5 is unit-testable without a probe.

### 4.2. Inputs

| Source | Call | Used for |
|---|---|---|
| xiRAID daemon | `raidShow()` → `parseRaidShowEntries` | `ARRAY` resources: raw states, members, level, progress |
| systemd `.mount` units + mountinfo | filesystem probe (lean path) | `FILESYSTEM` resources: mountpoint, source, options, super options, mounted |
| `/var/lib/nfs/etab` | `parseEtab` — the kernel-effective export table exportfs(8) maintains ("maintains the table of exports in /var/lib/nfs/etab", nfs-utils 2.6; rpc.mountd answers clients from it). Not `/etc/exports`: a configured-but-unapplied line must not read as an export (API-10, audit F-03). Unreadable → `EXPORTS_UNAVAILABLE`, no fallback | `EXPORT` resources, `details.source: etab` |
| systemd | `nfs-server.service` ActiveState/SubState (`systemctl show`, bounded 5 s) | `NFS_SERVICE.unit_active_state` |
| `/proc/fs/nfsd/threads` | `parseNfsdThreads` | `NFS_SERVICE.running` — true only when the unit is active AND threads > 0 (`active (exited)` with zero threads is not a server; audit F-06) |
| `/proc/fs/nfsd/versions` | `parseNfsdVersions` | `NFS_SERVICE.protocols` |
| `fs.realpath` per export path | node fs, no subprocess | `PATH_NOT_CANONICAL` / `PATH_UNRESOLVABLE` (T-05 symlink rule) |
| dpkg (once per process) | `dpkg-query -W -f='${Version}' xiraid-core` | `ARRAY.version` (upstream part, `4.4.0`) and `.build` (full package version, `4.4.0-43861`); unknown → `unknown` + `XIRAID_VERSION_UNAVAILABLE` |
| identity caches | the disk sweep's `device_path → Disk id` map and the 60 s filesystem sweep's `unit → XFS UUID` map, filled in `convergence.ts` as those sweeps run | member `id`s, filesystem `uuid` — without re-running lsblk/blkid in the fast cycle |
| desired shares | the agent's config-snapshot of `/xinas/v1/desired/Share/*` is **not** available agent-side; see §4.4 | `shares[]` |

### 4.3. Identities (API-04, API-05)

- `controller_id`: the agent's configured controller id.
- `server_epoch`: `"<controller_id>:<agent boot time ISO>:<pid>"`,
  minted once per agent process; changes on every agent restart. (The
  publisher incarnation is the agent, not the api — the api only stores.)
- `source_generation`: a per-process monotonic counter incremented on
  every published cycle, persisted in the KV row; after an agent restart
  the counter restarts at 1 under a new `server_epoch`, which is why
  consumers compare `(server_epoch, source_generation)` as a pair.
- Share `share_id`: the desired Share id (`encExportId(path)`);
  `incarnation`: `"<share_id>:<fsid>"` — the per-share stable FSID the
  exports role allocates is the one value that changes on delete/recreate
  of the same path in xiNAS today. **Prototype:** a recreate that reuses
  the same fsid is indistinguishable; a durable incarnation counter in the
  desired Share row is the deferred fix.
- Filesystem `uuid`: the XFS UUID when the existing 60 s Filesystem row
  has it (blkid is not re-run in the fast cycle); otherwise the mount
  unit name, with `reason_codes: [FS_UUID_UNAVAILABLE]` on the resource.
  `incarnation`: `"<uuid>:<mount_source>"`.
- Filesystem resource `id`: `"fs:<mount unit name>"` (the Filesystem row
  id — stable across reboots, unlike a device path); `details.uuid` is the
  identity the connector compares.
- Array `id`: `"array:<name>"`, `incarnation`: `"<name>:<volume_path>:<level>:<member count>"`;
  member `id`: the Disk id from the identity cache, else the device path,
  else `"member:<index>"` (a path-less member also marks the array
  `UNKNOWN`, §4.5).
- Export `id`: `"export:<encExportId(path)>"`, `incarnation`:
  `"<id>:<fsid option or none>"`; NFS service id `"nfs:nfs-server"`.
- Source failures publish a placeholder so the failure is visible as a
  resource: `array:unavailable`, `fs:unavailable`, `export:unavailable`
  (`ERROR`, `incarnation: "-"`, `details: { kind }` only).

### 4.4. Shares — where the desired list comes from

The agent has no read path into the api's desired KV (ADR-0002: the
agent only pushes). The prototype takes the share list from the **exports
the node actually serves**: every path in the kernel-effective export
table (`/var/lib/nfs/etab`) becomes an `EXPORT` resource, and every such
path that lies on a managed filesystem is a share. This matches DEC-01 (one export = one DS) and is provable from the
node itself. An export off every managed filesystem is a resource but
not a share (the api names it `FILESYSTEM_UNRESOLVED` if a desired Share
points at it, §5.3). Reconciling with the api's desired `Share` rows
(and reporting a desired-but-unexported share as `EXPORT_ABSENT`) is done
**api-side at read time** in §5.3, so the response still lists every
desired share.

### 4.5. Graph rules (API-06, API-07, XMOD-03, XMOD-12)

For each share path:

1. `FILESYSTEM`: the managed filesystem with the **longest** mountpoint
   that contains the path by path segment. None → share
   `UNKNOWN` / `FILESYSTEM_UNRESOLVED`. If the mountinfo entry for that
   mountpoint has a different `source` than the unit's `What` → resource
   `UNKNOWN` / `MOUNT_SOURCE_MISMATCH` (T-05: no fallback to the parent).
2. `ARRAY` refs: `DATA` = the array whose `volume_path` equals the mount
   source; `LOG` = the array whose `volume_path` equals `logdev=` in
   `super_options`; `REALTIME` likewise for `rtdev=`. A `logdev=`/`rtdev=`
   that names a device no array owns → the filesystem is **`UNKNOWN`** /
   `EXTERNAL_DEVICE_UNRESOLVED` with `external_dependencies_resolved:
   false` (XMOD-12, audit F-05: a mandatory dependency that cannot be
   proven is not a filesystem with a flag) — and every share on it
   inherits `UNKNOWN`, while a filesystem with its own arrays is untouched
   (T-04). No `logdev=` in `super_options` **and** the filesystem is
   mounted → `log_mode: INTERNAL` (proven from the live super options);
   not mounted → `log_mode: UNKNOWN`.
3. `EXPORT`: the etab entry for exactly that path (present) or a resource
   with `present: false`.
4. `NFS_SERVICE`: the singleton. `running` is `true` only when the unit is
   active **and** `/proc/fs/nfsd/threads` is above zero; `false` when the
   unit is inactive/failed or has zero threads (`NFSD_NO_THREADS`); `null`
   (resource `UNKNOWN`) when the unit state or the threads file could not
   be read.
5. Nested mounts (T-05, API-05, audit F-04): any mount-table entry at or
   under the share path, or between the filesystem's mountpoint and the
   share path — a foreign device, a tmpfs, a bind mount of the same
   device — makes the share `UNKNOWN` / `NESTED_MOUNT` with the offending
   mountpoints in `nested_mountpoints`. There is no fallback to the
   parent filesystem's arrays.
6. Canonical path (T-05 symlink rule): the export path's `realpath` must
   equal the path (`PATH_NOT_CANONICAL` otherwise, `PATH_UNRESOLVABLE`
   when it cannot be resolved) — both `UNKNOWN`.

Any resource whose collection failed is emitted with `ERROR`, null
times, `details: { kind }` only and a non-empty `reason_codes`; the
shares that reference it get `collection_status: UNKNOWN` with
`reason_codes: [DEPENDENCY_<KIND>_UNAVAILABLE]` while unrelated shares
stay `SUCCESS` (API-07, T-04). A share also inherits `UNKNOWN` /
`DEPENDENCY_ARRAY_UNAVAILABLE` from any array its filesystem references
that is not `SUCCESS`. A share's `observed_at` is the **oldest** evidence
among its filesystem, export, service and arrays (the conservative side).

`snapshot_status`: `COMPLETE` iff all five sources succeeded; `FAILED`
iff the four primary sources (arrays, filesystems, exports, nfs service)
all failed; `PARTIAL` otherwise.

#### Reason codes (the closed set the prototype emits)

| Code | Record | Status | Meaning |
|---|---|---|---|
| `COLLECTION_TIMEOUT` | placeholder resource, share (via §5.3) | `ERROR` | the source did not answer within the 2 s deadline |
| `XIRAID_DAEMON_UNAVAILABLE`, `FILESYSTEMS_UNAVAILABLE`, `EXPORTS_UNAVAILABLE`, `NFS_SERVICE_STATE_UNAVAILABLE` | placeholder / service resource | `ERROR` | the source call failed (the error text is logged, never published) |
| `MEMBER_DEVICE_UNRESOLVED` | ARRAY | `UNKNOWN` | a daemon member entry carried no readable path (`device_path: "-"`, member kept) |
| `ARRAY_STATE_INVALID` | ARRAY | `SUCCESS` | `state_valid: false` (§3.1); the consumer treats the array as UNKNOWN |
| `XIRAID_VERSION_UNAVAILABLE` | ARRAY | `SUCCESS` | package version unknown; `version`/`build` are the literal `unknown` |
| `FS_UUID_UNAVAILABLE` | FILESYSTEM | `SUCCESS` | no blkid UUID cached yet; `uuid` is the mount unit name |
| `MOUNTINFO_UNREADABLE` | FILESYSTEM | `UNKNOWN` | `mounted: null`, `writable: null` (SRC-14) |
| `MOUNT_SOURCE_MISMATCH` | FILESYSTEM | `UNKNOWN` | the mountpoint is served by another device (`details.mount_source_mismatch`) — T-05 |
| `FS_TYPE_UNSUPPORTED` | FILESYSTEM | `UNKNOWN` | the unit's `Type=` is not `xfs` |
| `DATA_ARRAY_UNRESOLVED` | FILESYSTEM | `UNKNOWN` | no array's `volume_path` equals the mount source |
| `DEPENDENCY_ARRAY_UNAVAILABLE` | FILESYSTEM, share | `UNKNOWN` | arrays failed this cycle / a referenced array is not `SUCCESS` |
| `EXTERNAL_DEVICE_UNRESOLVED` | FILESYSTEM (and its shares) | `UNKNOWN` | `logdev=`/`rtdev=` names a device no array owns; `external_dependencies_resolved: false` |
| `NESTED_MOUNT` | share | `UNKNOWN` | a foreign mount at/under the share path or between it and its filesystem (`nested_mountpoints`) |
| `PATH_NOT_CANONICAL`, `PATH_UNRESOLVABLE` | share | `UNKNOWN` | the export path is a symlink / could not be resolved |
| `NFSD_NO_THREADS` | NFS_SERVICE | `SUCCESS` (`running: false`) | the unit is active but kernel nfsd has no threads |
| `NFSD_THREADS_UNAVAILABLE` | NFS_SERVICE | `UNKNOWN` | the unit is active but `/proc/fs/nfsd/threads` is unreadable or junk |
| `EXPORT_PATH_INVALID` | EXPORT (`export:invalid:<n>`) | `ERROR` | `encExportId` rejected the path (e.g. `/`) |
| `NFSD_VERSIONS_UNAVAILABLE` | NFS_SERVICE | `UNKNOWN` when running, `SUCCESS` with `protocols: []` when stopped | `/proc/fs/nfsd/versions` unreadable |
| `DEPENDENCY_FILESYSTEM_UNAVAILABLE`, `DEPENDENCY_NFS_SERVICE_UNAVAILABLE` | share | `UNKNOWN` | the referenced resource is not `SUCCESS` |
| `EXPORT_ABSENT`, `FILESYSTEM_UNRESOLVED`, `DEPENDENCY_EXPORT_UNAVAILABLE`, `DESIRED_CHANGED_SINCE_OBSERVATION`, `SHARE_UNMANAGED` | share (api-side, §5.3) | `UNKNOWN` (`SHARE_UNMANAGED`: unchanged) | reconciliation outcomes |

#### Field derivations worth pinning

- FILESYSTEM `mounted`: `true`/`false` from the exact cross-reference,
  `null` only when mountinfo was unreadable. `writable` (audit F-12):
  needs BOTH option lists — `ro` in the per-mount VFS options **or** in
  the XFS super options → `false`; `rw` in the VFS options with no `ro`
  anywhere (and `rw` or nothing in the super options) → `true`; anything
  else, and not mounted → `null` (unproven, never RW by assumption).
- ARRAY `progress` (API-08, audit F-11): the daemon's four separate
  values `init_pct` / `recon_pct` / `restripe_pct` / `sdc_pct`, a finite
  0–100 or `null` each. A number is never a proof of a finished state;
  the state words are. `mount_options`: the effective (mount-table) options when
  mounted, else the unit's `Options=`. `source_device`: the mount-table
  source when mounted, else the unit's `What=`.
- EXPORT rules come from etab, where exportfs has already expanded every
  option (so `rw`/`ro` and `sec=` are always explicit): `client` = the
  host pattern; `writable` = `rw` present → true, otherwise false — `ro`
  is the exportfs default when neither is given (exports(5), nfs-utils 2.6,
  <https://man7.org/linux/man-pages/man5/exports.5.html>, "ro: Allow only
  read requests … This is the default"); `security` = the `sec=` list
  split on `:`, default `["sys"]` (same page, "sec=… The default is
  sys"); `options` = the raw option list; `source: "/etc/exports"`
  labels the gap of §6.
- NFS_SERVICE `running`: ActiveState `active` → true; `inactive`/`failed`
  /… → false; `unknown` or unreadable → `null`. `protocols`:
  `parseNfsdVersions` output prefixed `NFSv` (`NFSv3`, `NFSv4.0`,
  `NFSv4.1`, `NFSv4.2`).

### 4.6. Published row

`/xinas/v1/observed/PlacementObservations/default`, value:

```
{ kind: 'PlacementObservations', id: 'default',
  status: { ...result fields of §5.2 except the ages...,
            shares[].observed_mono_ms, resources[].observed_mono_ms,
            sources: { arrays | filesystems | exports | nfs_service | nfsd_versions | nfsd_threads:
                       { status: ok | failed | timeout, observed_at?, mono_ms? } },
            published_mono_ms: <agent monotonic stamp when the row was built>,
            collector: { cycle_ms, deadline_hit, skipped_ticks },
            observed_at } }
```

`evidence_age_ms` is **not** stored; the api computes it (§5.2). The
agent stores, per record, `observed_at` (UTC, audit) and the agent's
monotonic stamp, plus the row's own publication stamp and `generated_at`
(the wall clock at publication — agent and api share the node's clock);
the api computes ages from the **api's** receipt of the push, plus the
transfer delay it measures at ingest, plus the agent-reported intra-cycle
offset (CON-10: the transfer delay counts against freshness, never for
it). `sources` lets the api
tell "no export line" (proof of absence) from "exports could not be
read" at reconciliation time (§5.3). The kind is registered in
`OBSERVED_KINDS` with the permissive ingest validator
(`FLAT_SCHEMA_KINDS`): the OpenAPI `PlacementObservations` component
describes the route result, not the stored row.

## 5. The route (`src/api/routes/placement.ts`)

### 5.1. Registration

- Express: `GET /api/v1/placement/observations`, mounted before the
  `NOT_FOUND` catch-all.
- Catalog: `placement.observations` (`read`, viewer, `mcp_exposed:
  true` — a read tool is harmless over MCP and useful for diagnostics).
- OpenAPI: path + `PlacementObservations` component (the source
  package's Appendix Д schema, expressed in OpenAPI 3.0 form), tag
  `placement`.

### 5.2. Response

The envelope's `result` is the schema-v1 object; `state_revision` is the
KV row's revision (API-02: not a snapshot generation — that is
`source_generation`).

`evidence_age_ms` per share/resource =
`(now_mono − row_received_mono) + transfer_delay_ms + max(0, published_mono − resource_mono)`:
the time since **this api process** stored the push, plus how old the row
already was when it arrived (`transfer_delay_ms` = the ingest's wall
clock at receipt − the row's `generated_at`, clamped at 0; audit F-02),
plus how much older than the row's publication the record's evidence
already was. Every term can only make evidence older (CON-10).
`row_received_mono` comes from the api's own monotonic clock at the
moment the ingest transaction committed (`ObservedReceipts`,
`src/api/placement/receipts.ts`, hung on `ctx.observed_receipts`; keyed
by `(kind, id)` with the KV revision it belongs to). It is in-memory on
purpose: after an api restart there is no receipt for the row, and the
route answers `SOURCE_NOT_READY` until the agent pushes again — HTTP
time or the row's `modified_at` are never used as a substitute. A row
whose `generated_at` does not parse is stored but never served
(`SOURCE_NOT_READY`, `details.reason: generated_at_unparsable`).
Repeated GETs therefore show growing ages (API-14). The per-record
`observed_mono_ms` and the row's `published_mono_ms` are stripped from
the response; `transfer_delay_ms` is reported.

**Ordering at ingest (audit F-01).** The placement singleton is ordered
by `(server_epoch, source_generation)`. `POST /internal/v1/observed`
stores a push only when, within the same `server_epoch`, its
`source_generation` is strictly greater than the stored row's; a delayed
retry or a reordered flush of an older generation is dropped
(`skipped_regressed` in the ingest result, a `placement_push_regressed`
log line) and a re-delivery of the same content is deduplicated —
neither refreshes the receipt, so old evidence can never read as new. A
new `server_epoch` (agent restart) is accepted whatever its generation.

### 5.3. Read-time reconciliation with desired shares

The api merges the agent's export-derived share list with
`/xinas/v1/desired/Share/*`:

- desired **and** observed (same `spec.path`) → as published, with the
  desired row's id as `share_id` and
  `incarnation: "<id>:<spec.fsid>:<spec.placement_incarnation>"` — the
  connector-facing identity is the desired Share (§4.3), and
  `placement_incarnation` is a UUID minted when the share is created,
  kept by updates, deleted with the share and backfilled on boot for
  older shares, so a delete-and-recreate of the same path and fsid is a
  new incarnation (API-04, XMOD-14, audit F-08). It lives in its own
  desired row, `/xinas/v1/desired/SharePlacement/<id>` (the fsid-marker
  pattern), so the backfill never bumps a Share row's revision — plans
  and pending MCP confirmations pin those. The create plan declares the
  marker with a `mint_uuid` desired mutation and the task engine fills
  the id at **apply** time, so the plan itself stays deterministic
  (the same spec plans to the same `plan_hash` over REST, MCP and the
  CLI);
- a desired row whose KV `modified_at` is later than the receipt of the
  observation it would be joined with → `UNKNOWN` /
  `DESIRED_CHANGED_SINCE_OBSERVATION` — an observation can never be
  joined with a desired Share that changed after it was collected (audit
  F-13); the next accepted push joins again;
- desired, not observed, no `EXPORT` resource for the path, and the
  agent's exports source is `ok` → `collection_status: UNKNOWN`,
  `reason_codes: [EXPORT_ABSENT]`, `filesystem_ref: null`; this is proof
  of absence for XMOD-14 and the record says so with `export_ref`
  pointing at a synthesized `EXPORT` resource `present: false` (stamped
  with the exports source's evidence time);
- desired, not observed, but an `EXPORT` resource exists for the path →
  `UNKNOWN` / `FILESYSTEM_UNRESOLVED` with that `export_ref` (exported,
  but not on a managed filesystem);
- desired, not observed, exports source `failed`/`timeout` → `UNKNOWN` /
  `DEPENDENCY_EXPORT_UNAVAILABLE` (or `COLLECTION_TIMEOUT`), `export_ref:
  null`, null times — no proof of absence is claimed;
- observed, not desired → listed with `reason_codes: [SHARE_UNMANAGED]`
  (an export xiNAS did not create); the connector may bind it, but the
  reason is visible.

`service_ref` of a reconciled record is the NFS service resource when
the row has one. The projection lives in `src/api/placement/read.ts`
(`projectPlacement`, `assertServable`, `evidenceAgeMs`) so it is tested
as a function; the route is a thin wrapper.

### 5.4. Status codes (API-03, API-20)

| Condition | Status | Envelope |
|---|---|---|
| Row present, ≤ 256 shares, ≤ 16 MiB serialized | 200 | `result` per §5.2; `snapshot_status` as published (COMPLETE/PARTIAL) |
| Row present, cycle failed entirely (`snapshot_status: FAILED`) | 503 | `result: null`, `errors: [{ code: 'SOURCE_FAILED', details: { sources } }]` — API-20: a global failure is a source failure, not an answer (audit F-10) |
| No row yet / api restarted and no push since (`row_received_mono` unknown) | 503 | `result: null`, `errors: [{ code: 'SOURCE_NOT_READY' }]` |
| Row older than `2 × collection_period_ms + 2 s` (age = time since receipt + measured transfer delay) | 503 | `result: null`, `errors: [{ code: 'SOURCE_STALE', details: { age_ms, transfer_delay_ms } }]` — the agent has stopped publishing, or the push arrived too late to be trusted |
| > 256 shares or > 16 MiB | 503 | `result: null`, `errors: [{ code: 'SNAPSHOT_TOO_LARGE', details: { shares, bytes } }]` |
| No/invalid token | 401 | existing auth |
| Rank below viewer | 403 | existing RBAC (`PERMISSION_DENIED` maps to 401 in this api today — see ADR-0001; the connector treats both as auth failure) |

`SOURCE_NOT_READY`, `SOURCE_STALE`, `SOURCE_FAILED` and
`SNAPSHOT_TOO_LARGE` are `ErrorCode` values of their own (HTTP 503,
`result: null`) so the connector reads the typed code from
`errors[0].code` (API-03, API-20) — distinct from `EXECUTOR_UNAVAILABLE`,
which means "the agent RPC is down" and is not what a stale source is.
The conditions are checked in that order: readiness, then staleness,
then a failed snapshot, then size (shares first, then serialized
bytes).

## 6. Coverage and capabilities (DEC-08, API-21, XMOD-05)

`capabilities`: `raid.array_states`, `raid.member_states`,
`topology.data_log_realtime`, `identity`, `filesystem.mounted_rw`,
`export.effective_access`, `nfs.service`, `source.freshness`.

`coverage` rows: the eight above `EVALUATED` (required: true), plus
`filesystem.integrity`, `network.path`, `network.performance`
`NOT_IMPLEMENTED` / `OUT_OF_MVP` (required: false).

`export.effective_access` is `EVALUATED` with `details.source: "etab"`:
the rules are the kernel-effective table exportfs(8) maintains, not the
configuration file (audit F-03). In fixture mode the source reads
`fixture`; the connector's xinas module refuses any source its profile
does not accept (`export_source_required`).

`schema_version: "1.0"`; `collection_period_ms: 5000`.

## 7. Agent readiness surface (API-24, prototype)

`agent.health` (existing RPC) gains a `PlacementObservations` row like
every collector — when the cycle is enabled (`placement.enabled`). The route's result carries `collection_period_ms`,
`coverage`, `source_generation`, `server_epoch`, `generated_at`; a
separate readiness endpoint is deferred.

## 8. Security (API-17, API-18)

- Read-only; no MCP apply, no confirmation; the catalog entry is
  `mutability: 'read'`.
- The collector runs under the agent's existing privilege (it needs
  `/etc/systemd/system/*.mount`, mountinfo, the xiRAID socket,
  `/var/lib/nfs/etab`, `/proc/fs/nfsd/*`) and adds no new capability.
- Remote access (API-18/19, audit F-07): the api's dedicated listener
  (`mcp.http`) serves HTTPS when `mcp.http.tls` names a certificate and
  key (an optional `ca_file` turns on mutual TLS); a plain-http listener
  on a routable address is refused at startup unless
  `mcp.http.allow_insecure_http: true` names an isolated lab network,
  and then warns. The connector's credential is a `viewer` token scoped
  `surface: "rest"` (S15 §3.5) — it cannot be replayed over `/mcp`;
  rotation is the existing token-file edit + api restart. The bootstrap
  admin token is never the polling credential.
- Nothing in the response is secret: no license text, no tokens, no
  command output — `reason_codes` are enums, `details` are typed.

## 9. Tests

- `lib/parse/raid`: valid array, `[online, 42]` → `state_valid: false`
  with `online` kept, null/empty/object → false, member without path
  kept with `device: null`.
- `lib/parse/filesystem` + probe: super options published, source
  mismatch → no match, unreadable mountinfo → `mounted` absent.
- `lib/placement-graph` (pure): the T-04 topology — two shares on one
  fs with data+log arrays, one share on a second fs; a failing
  `raidShow` → arrays ERROR, filesystems and shares UNKNOWN, `PARTIAL`;
  a `logdev=` naming an unknown device → `external_dependencies_resolved:
  false`; `rtdev=` → REALTIME ref; mount-source mismatch, unreadable
  mountinfo, not-mounted, unresolved DATA array, read-only mount; the
  path-less member, the invalid state shape, the unknown version; the
  NFS service states; export normalization and the invalid path; all
  sources failed → `FAILED`; a timed-out source → `COLLECTION_TIMEOUT`.
- `agent/collectors/placement`: one call per source per cycle, the row
  shape, `source_generation`/`server_epoch`, a failing `raidShow` →
  `PARTIAL` with health `running`, all sources failing → `FAILED` with
  health `error`, deadline → `PARTIAL` + `COLLECTION_TIMEOUT` +
  `deadline_hit`, re-entrancy skip (counted, next tick runs), a throwing
  version source.
- `api/placement-read` (pure): the age formula (grows, never negative,
  never fresher), `SOURCE_NOT_READY` (no row / no receipt / stale
  receipt revision), `SOURCE_STALE` at exactly `2 × period + 2 s`,
  every reconciliation outcome of §5.3, `SNAPSHOT_TOO_LARGE` at 257
  shares.
- `api/placement-route` (supertest): 401 without token, 503
  `SOURCE_NOT_READY` with no row and with a row but no receipt, viewer /
  operator / admin 200 with the projected ages, ages grow between two
  GETs, 503 `SOURCE_STALE`, reconciliation end to end (`EXPORT_ABSENT`
  with the synthesized resource, `SHARE_UNMANAGED`), 503
  `SNAPSHOT_TOO_LARGE`, a `FAILED` snapshot is still 200, the result
  validates against the `PlacementObservations` component, the catalog
  entry, and a push through `/internal/v1/observed` stamping the receipt.
- `contracts`: `PlacementObservations.json` fixture = Appendix В example
  (identities adapted) validated against `api-v1.yaml`.
- Audit remediation (2026-09-23): `lib/parse/etab`; the graph's
  nested-mount, canonical-path, writable-from-both-lists, unresolved
  external device → UNKNOWN, nfsd-threads and progress rules; the ingest's
  ordering guard and transfer delay (route tests push through
  `/internal/v1/observed`); `SOURCE_FAILED`; `DESIRED_CHANGED_SINCE_OBSERVATION`;
  the placement-incarnation backfill; `mcp.http` transport validation;
  the agent's `placement.enabled`.

## 10. Rollout

Ships with `Requires-Rebuild: xinas_node_build` (the api and the agent
both change). The cycle is opt-in: `xinas_agent_placement_enabled: true`
(agent role) registers the collector; `xinas_api_mcp_http_host` /
`_port` / `_tls_cert` / `_tls_key` (api role) expose the HTTPS listener
the connector polls. The route is viewer-rank; give the connector its own
`viewer` token with `surface: "rest"`.

## 11. Revision history

- 2026-09-22 — first prototype.
- 2026-09-23 — audit remediation (Codex audit of e5828f30, findings
  F-01…F-13): ingest ordering guard and transfer delay (F-01, F-02),
  etab as the export source (F-03), nested-mount and canonical-path
  rules (F-04), unresolved external device → UNKNOWN (F-05), nfsd threads
  behind `running` (F-06), HTTPS on the dedicated listener and the
  `surface: rest` credential (F-07), durable `placement_incarnation`
  (F-08), opt-in cycle + version inside the deadline + bounded systemctl
  (F-09), `SOURCE_FAILED` (F-10), array progress (F-11), `writable` from
  both option lists (F-12), `DESIRED_CHANGED_SINCE_OBSERVATION` (F-13).
