# ADR-0009: Health profiles, drift detection, support bundle (S7, WS9+WS10)

**Status:** accepted (2026-06-11). Extends ADR-0002 (one new enumerated
agent method), ADR-0004 (one new internal task kind), ADR-0005 (the
profile renderer becomes the drift oracle for its own files).

## Context

WS9's open half is "drift visible in health and API"; WS10 needs real
health profiles (`quick`/`standard`/`deep`, each check returning
status/symptom/impact/evidence/recommended_action) and the support
bundle. Verified facts this ADR is designed against:

- Desired-side anchors exist for shares (`lib/nfs-exports.ts` compile),
  network (`lib/net/render.ts` + observed
  `NetworkConfig.xinas_file_hash`), and the NFS profile (the helper's
  `render_nfs_profile`, reachable from the agent only).
- Observed `NfsProfile.effective_files` covers exactly the four
  ADR-0005 files — **not** `/etc/exports` (review P1).
- There is **no TypeScript renderer** for the profile files; rendering
  lives behind the nfs-helper RPC (review P1).
- `xicli license show` output is **recoverable license material** (the
  TUI writes it back as the license file — `simple_menu.sh:129`); it
  must never appear raw in a bundle (review P0).
- `admitAndDispatch` dispatches an EXISTING queued task; creation,
  idempotency, and leases happen in `TaskEngine.apply` against a plan
  row (review P0). `ResourceRef.kind` in api-v1 is a closed enum;
  `lease_resources` is internal-only (N0.5 strips `plan_binding` from
  REST), so internal lease kinds need no enum change but PUBLIC
  `affected_resources` entries do.
- `perf_tuning` writes sysctls via drop-ins with overrideable values
  (`/etc/sysctl.d/90-perf-*.conf`; the SunRPC key is
  `sunrpc.tcp_max_slot_table_entries`) — hardcoded expected values
  would false-warn on customized installs (review P1).
- The agent deliberately lacks `CAP_SYS_ADMIN`; mounts are delegated to
  PID1 (the S5 pattern). The bundle path `/var/log/xinas` is already
  agent-writable; `CAP_CHOWN` is held for the chgrp pattern. **S7 needs
  no sandbox delta.**

## Decision — architecture

`GET /health?profile=` runs an **api-side check engine**: pure check
functions over KV facts for everything `quick`; one **enumerated agent
RPC `health.probe { level, desired_nfs_profile? }`** supplies live
facts for `standard` and active probes for `deep`. The probe RPC is a
read-style diagnostic (idempotent, no host mutation except the probe
artifacts below) — it joins the ADR-0002 allow-list and the s0s1 RPC
table. Profiles nest: `standard` ⊇ `quick`, `deep` ⊇ `standard`.

Per-section degradation everywhere: a failing fact source degrades ITS
check (`degraded` + evidence naming the failure); the agent being
unreachable degrades all probe-backed checks with
`EXECUTOR_UNAVAILABLE` evidence while KV checks still answer. Timeouts:
probe call 5 s (`standard`) / 20 s (`deep`); the GET never hangs past
that.

## Decision — check catalog

Statuses use the api enum `[ok, warning, degraded, critical, skipped]`;
`overall` = worst (critical > degraded > warning > ok; skipped
ignored). Category values come from the existing HealthCheck enum.

**quick (KV only, instant):**

| id | category | logic |
|---|---|---|
| `xinas-api.alive` | api | constant ok (exists) |
| `agent.connectivity` | agent | heartbeat tracker state: healthy→ok, degraded→degraded, offline→critical (the tracker's actual vocabulary) |
| `xiraid.arrays` | xiraid | any observed array: initializing/rebuilding→degraded; degraded/failed/offline→critical; none→skipped |
| `disk.health` | xiraid | observed Disk.status.health: `ok === false`→critical; `wear_pct > 90`→warning; disks without a health block→skipped individually (review P1: the reqs' disks/NVMe coverage) |
| `filesystem.mounts` | filesystem | observed Filesystem with `mount_unit_enabled && !mounted` → degraded |
| `nfs.server` | nfs | observed SystemdUnit `nfs-server.service` not active → critical (depends on §Systemd promotion below) |
| `nfs.exports` | nfs | desired Share whose `spec.path` has no observed ExportRule (`spec.export_path` match) → degraded |
| `network.duplicate-netplan` | network | (exists, S6) critical |
| `network.rdma-readiness` | network | (exists, S6) |
| `drift.nfs-exports` | drift | §Drift below |
| `drift.netplan` | drift | §Drift below |
| `systemd.units` | systemd | any allow-listed observed SystemdUnit `failed` → critical |
| `tuning.sysctl` | tuning | §Tuning below |

**standard adds (via `health.probe level=standard`):**

| id | category | logic |
|---|---|---|
| `xiraid.license` | xiraid | parsed license: expired→critical, <30 days→warning; xicli absent→skipped |
| `xiraid.service` | xiraid | the agent's xiraid collector reporting `error` (daemon unreachable) → critical (review P1: explicit service/API coverage, distinct from `agent.collectors`) |
| `network.rdma-live` | network | fresh `rdma link show` vs observed (a link that went down since the sweep) |
| `agent.collectors` | agent | any collector reporting `error` → degraded with reasons |
| `drift.nfs-conf` | drift | §Drift below (helper dry-render — standard-only by construction) |

**deep adds (`level=deep`):**

| id | category | logic |
|---|---|---|
| `filesystem.io` | filesystem | write/read/delete `/<mountpoint>/.xinas-health-probe` per mounted managed fs; failure → critical for that fs |
| `nfs.loopback` | nfs | PID1-delegated `systemd-mount localhost:<first export>` at `/run/xinas/health-probe/mnt`, list, `systemd-umount`; no exports → skipped |

## Decision — systemd observation promotion (review P1)

The live agent wiring registers a DELIBERATELY-FAILING systemd probe
(dbus integration-only), so observed `SystemdUnit` rows exist on no
host — `nfs.server` and `systemd.units` would be permanently empty. S7
promotes the probe to a **subprocess implementation**: per allow-listed
unit, `systemctl show -p ActiveState,SubState,UnitFileState <unit>`
behind an injectable execFile seam (CI-fakeable; fixture passthrough
`systemd-units.json`), polled on the collector's existing backstop. The
allow-list grows by `xinas-api.service` and `xinas-agent.service`;
xiRAID's unit names are confirmed on hardware (runbook item) before
being added. The dbus event subscription remains future work — the poll
backstop is the only refresh path for now, documented.

> **Superseded (cleanup, 2026-06):** the prototype dbus-shaped probe and
> its `dbus-native` dependency were **removed**. The 30 s `systemctl show`
> poll already keeps the node healthy, so the dbus path was only a latency
> optimization carrying an unmaintained native-ish dependency into the
> root agent — not worth the attack surface. `subscribeAllowListed` is a
> permanent no-op; poll is the model. If sub-30 s unit-state latency is
> ever needed, prefer an `sd_notify`/journal reader or a
> `systemctl --wait`-style subprocess over re-adding a dbus client.

## Decision — drift (review P1 locks)

Three desired-vs-observed comparisons, each `degraded` + category
`drift`, evidence carrying both sides, remediation naming the re-apply
operation; absent desired state → `skipped` (fresh installs are not
"drifted").

1. **`drift.nfs-exports` — semantic, not byte-hash.** Compare the
   compiled desired Shares (entry-level, via `lib/nfs-exports.ts`)
   against the OBSERVED ExportRule rows (paths + canonicalized rule
   options). Rationale: `/etc/exports` bytes are written by the python
   helper; a TS byte-render would couple two writers, and
   `effective_files` does not cover `/etc/exports` anyway. Evidence
   lists missing/extra/changed entries.
2. **`drift.nfs-conf` — same-renderer checksums, standard profile.**
   The api passes the desired NfsProfile spec inside `health.probe`;
   the agent asks the helper for a **dry render** and returns the
   rendered checksums; the check compares them against observed
   `effective_files`. Both sides come from the ONE renderer — no
   duplication, no byte coupling. **Helper contract change (review
   P0):** today's `render_nfs_profile` ALWAYS writes the four files and
   reload/restarts nfs-server — S7 adds a `dry_run: true` parameter
   (render → checksums, NO file writes, NO service action) to the
   helper op, with python-side tests proving a dry call leaves the
   filesystem and the service untouched, BEFORE `health.probe` may call
   it. In `quick` this check is `skipped (requires standard)`.
3. **`drift.netplan` — pure KV.** `sha256(renderNetplan(desired
   NetworkInterface rows))` vs `NetworkConfig.xinas_file_hash` (the S6
   anchor; both sides from the same TS renderer).

## Decision — drift API surface (review P1)

WS9 reads "drift visible in health AND API". The existing API surface
is `GET /config-history/drift` (today an empty placeholder). S7 wires
the SAME drift engine into it: the route runs the KV drift checks
(`nfs-exports`, `netplan`) and reports `drift.nfs-conf` as
`not_evaluated` with a pointer to `GET /health?profile=standard`
(its oracle needs the agent round-trip). Response shape:
`{ drift: [{ artifact, status, evidence, recommended_action }] }` —
one entry per non-ok drift check, empty when clean.

## Decision — tuning (review P1 lock)

The new internal observed singleton **`Tuning/default`** (both Kind
registries, no public schema — the NetworkConfig precedent) carries
`{entries: [{key, expected, actual}]}`. The agent probe derives
`expected` by parsing the INSTALLED drop-ins (`/etc/sysctl.d/*.conf`,
xiNAS-written ones first) and `actual` from `/proc/sys` — so customized
`perf_tuning` variables are honored and key names can never desync from
the role. No drop-ins → the `tuning.sysctl` check is `skipped`.

## Decision — support bundle (review P0 locks)

`POST /support-bundle` (contracted: bare 202 task) is an internal
**plan→apply→admit composite** in the route — `PlanEngine.plan`
(provider `support.bundle`) → `toApplyPlan` → `TaskEngine.apply`
(idempotency key = `request_id`; the txn acquires the lease) →
`admitAndDispatch`. NOT a bare `admitAndDispatch` call: creation,
idempotency, and leases only exist in the apply txn.

- `affected_resources: []` (public; the closed `ResourceRef.kind` enum
  stays untouched); `lease_resources: [{kind: 'SupportBundle', id:
  'default'}]` (internal-only — serializes concurrent bundle builds).
- Risk `non_disruptive`, rollback `non_disruptive` (a failed build
  deletes its partial file).
- **Two-sided contents** (review P1: task history + audit are
  DB-owned, and the agent has no DB access by design): before
  dispatch, the api stages `bundles/<task_id>.api.json` under
  `/var/log/xinas` containing the task history (last 200 tasks), the
  audit tail (last 1000 entries + chain head hashes), full
  observed+desired state dumps, and a fresh `deep` health report. The
  agent executor folds that file in and contributes journal tails
  (xinas-api, xinas-agent, nfs-server, xiraid units; 2000 lines each),
  the managed config files (`/etc/exports`, the four ADR-0005 files,
  `/etc/netplan/*`), the xinas_history snapshot index, and xiRAID
  diagnostics — then writes `bundles/<task_id>.tar.gz`, mode 0640
  root:xinas-api (the socket-chgrp pattern) for the api's download
  route to stream.
- **Redaction (review P0):** `xicli license show` output NEVER appears
  raw — the bundle carries only the PARSED status/expiry/features/days
  (the same struct the `xiraid.license` check uses). `/etc/xinas-api`
  and `/etc/xinas-agent` are excluded outright (token material).
  Journal lines are scrubbed (`Bearer <…>` / `Authorization:` values →
  `***`). A redaction test seeds secrets through every channel and
  asserts zero leakage in the produced archive.
- Retention: the executor prunes `/var/log/xinas/bundles` to the newest
  3 archives.

## Decision — sandbox

No deltas. Bundle dir and probe mountpoint live under already-writable
paths; the loopback mount is PID1-delegated; `xicli`, `journalctl`,
`tar`, drop-in reads are plain exec/reads; the chgrp uses the held
`CAP_CHOWN`. First slice since S2 with no `Requires-Rebuild` trailer.

## Deferred

The changed-since-last-snapshot drift axis (xinas_history subprocess in
health), deep I/O bandwidth tests, metrics/telemetry exposure (reqs
§"performance" — the exporter path), drift auto-remediation, bundle
upload/offsite.
