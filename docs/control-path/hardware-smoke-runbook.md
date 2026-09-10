# Control-path hardware smoke runbook (Phase 0 exit)

**Status:** runbook (2026-06-11). Consolidates the residual on-hardware
checks from the S3/S5/S6 sandbox deltas, the xiRAID field-mapping
caveat, and the WS13 installer exit criteria into one ordered pass.
Everything here is the part CI cannot prove: no systemd, no netlink
mutation, no xiRAID daemon, no NVMe in the dev/CI environment.

**Target:** one Ubuntu 22.04/24.04 lab node with xiRAID Classic
installed, ≥4 spare NVMe data drives, ≥1 IB/RDMA (mlx) interface, and a
second machine usable as an NFS client.

**Prerequisite:** the node is on current `origin/main` (`a33fe59` or
later). Sections 1–2 use the TUI update path itself as the first test.

Record results inline (✅/❌ + notes). Any ❌ → file it under
`docs/troubleshooting/` and stop the affected section.

---

## 1. Update path + agent rebuild (WS13 upgrade criterion)

The chain `620e740..main` carries three `Requires-Rebuild: xinas_agent`
trailers (S3 loopback gRPC, S5 systemd writes, S6 CAP_NET_ADMIN +
netplan paths).

1. [ ] On a node running a pre-S3 build: TUI → Check for Updates. The
   confirm dialog NAMES `xinas_agent` as the role that will run.
2. [ ] Accept → `git pull` + Ansible `--tags xinas_agent` completes; the
   TUI restarts; `systemctl show xinas-agent -p CapabilityBoundingSet`
   contains `cap_net_admin`, and `-p ReadWritePaths` lists
   `/etc/systemd/system /etc/netplan /run/netplan /run/systemd`.
3. [ ] `journalctl -u xinas-agent -b` — clean boot, no EPERM/EACCES.

## 2. Clean install (WS13 install criterion)

On a scratch node (or after `./uninstall.sh`):

1. [ ] `./prepare_system.sh` → full deploy via the menu →
   `systemctl is-active xinas-api xinas-agent` both `active`.
2. [ ] `curl --unix-socket /run/xinas/api.sock http://x/api/v1/system`
   (with an admin bearer from `/etc/xinas-api/config.json`) shows
   `agent.state: online`.
3. [ ] `GET /api/v1/disks`, `/arrays`, `/filesystems`,
   `/network/interfaces` all return non-empty observed state within 60 s
   of boot.

## 3. S3/S4 — xiRAID over the agent sandbox

1. [ ] **gRPC reachability (S3-T1 residual):** with the daemon at
   `localhost:6066`, `GET /arrays` shows existing arrays — proves
   AF_INET-to-loopback works under `IPAddressAllow=localhost`.
2. [ ] **Field mapping (S3 caveat):** compare one real array's
   `GET /arrays/{id}` against `xicli raid show` — `level`,
   `strip_size_kib`, `state`, member device paths, spare pool. Any
   mismatch → fix `lib/parse/raid.ts` mapping, not the daemon.
3. [ ] **Create:** `POST /pools` from spare NVMe drives to create a
   pool, then `POST /arrays` plan→apply (raid5, `spec.spare_pool` set
   to that pool's name) → task `success`; array appears in `xicli` and
   `GET /arrays` with the pool attached; `xicli pool show` confirms the
   pool activated (no `pool_create` — the array only referenced it).
4. [ ] **Modify:** PATCH `spare_pool` (attach/detach an existing pool)
   and tuning → applied live (`xicli raid show` confirms); topology
   PATCH → 422.
5. [ ] **Delete gates:** delete without `dangerous` → 412; with a
   mounted dependent fs → 412 listing it; clean delete with
   `dangerous: true` → array gone, spare pool untouched (still present,
   active, and attachable to another array via `PATCH /arrays`).

## 4. S5 — filesystems over the agent sandbox (S5 spec §10)

1. [ ] `POST /filesystems` (backing + log array volumes, `log_size`
   LARGER than the log array) → success; `systemctl cat <unit>` matches
   the render; `xfs_info` shows su/sw + external log with the CLAMPED
   size; the mountpoint dir was PID1-created (no agent mkdir in the
   journal).

   > This step is the ONLY thing that can catch a capability denial on
   > the mkfs path — the fake host never execs `mkfs.xfs`, so CI is
   > structurally blind to it. Watch the journal for **all three** error
   > classes, which name three different sandbox directives:
   > `EROFS`/"Read-only file system" → `ReadWritePaths`;
   > `EPERM`/"Operation not permitted" → `SystemCallFilter`
   > (`SystemCallErrorNumber=EPERM`) or an `xfs_*` `capable()` check;
   > `EACCES`/"Permission denied" → `CapabilityBoundingSet` +
   > `AmbientCapabilities` (this is what `ioctl(BLKBSZSET)` returns
   > without `CAP_SYS_ADMIN`). Confirm the grant landed before blaming
   > the device: `systemctl show xinas-agent -p AmbientCapabilities`.
2. [ ] `systemctl is-enabled <unit>` → `enabled` (sandboxed symlink
   write worked).
3. [ ] Export a path + mount from the client → unmount apply → 412 with
   `dependent_share_active`/`mountpoint_exported`; tear down → unmount
   succeeds.
4. [ ] `PATCH {grow:true}` after growing the backing array →
   `xfs_growfs` reflected in `statfs`.
5. [ ] `PATCH {quota_mode:'pquota'}` → unit Options rewritten, remount
   visible to the connected client (expected pause), `mount | grep
   prjquota`.
6. [ ] `DELETE` → unit gone, `daemon-reload` clean, data intact
   (`blkid` still shows the fs).
7. [ ] Journal clean of EACCES/EPERM throughout.

## 5. S6 — network over the agent sandbox (S6 spec §10)

1. [ ] Seed a duplicate: add an `ibp*` stanza to
   `/etc/netplan/50-cloud-init.yaml` → PATCH plan blocked
   (`duplicate_netplan_definition`); `GET /health` shows
   `network.duplicate-netplan: critical`.
2. [ ] Re-plan `{addresses, cleanup: true}` → apply → success;
   `ip addr`/`ip rule` match the new address + table; the foreign file
   no longer has the stanza; the OTHER IB interface's kernel state
   untouched (surgical); `99-xinas.yaml` re-rendered whole with the
   header comment.
3. [ ] `POST /network/ip-pool` → all IB interfaces re-addressed by the
   day-1 formula, PBR table ids UNCHANGED; `ip rule show` has only
   tables 100–199 entries matching the render.
4. [ ] `netplan generate` rejection path: hand-break a foreign file →
   apply fails BEFORE any flush; prior `99-xinas.yaml` intact.
5. [ ] NFS-RDMA still mounts from the client after the address change
   (`mount -o rdma` + I/O) — `network.rdma-readiness: ok`.
6. [ ] Journal clean of EPERM (CAP_NET_ADMIN sufficiency proven).

## 5a. S7 — health, drift, support bundle

- [ ] `GET /health?profile=quick` on a converged node: every catalog
  check ok/skipped; `agent.connectivity` ok; `nfs.server` ok via the
  PROMOTED systemctl-show probe (observed SystemdUnit rows exist —
  `GET /api/v1/system` shows the systemd collector running).
- [ ] **Confirm xiRAID's real unit names** (`systemctl list-units
  'xiraid*'`) and add them to the observation allow-list
  (`src/agent/probe/systemd.ts` S7_ALLOWLIST_ADDITIONS) — deferred from
  S7 T1b on purpose.
- [ ] `profile=standard`: `xiraid.license` reflects the real license
  (verify days_left); the response carries NO raw `xicli license show`
  text; `drift.nfs-conf` ok on a freshly applied profile (the helper
  dry render runs with `dry_run: true` — confirm zero writes:
  `inotifywait -m /etc/nfs` stays silent during the GET).
- [ ] `profile=deep` (operator token or higher — a viewer token is refused
  with `PERMISSION_DENIED`; over MCP the call also needs
  `mcp.allow_apply: true`): `filesystem.io` writes a per-run
  `probe-none-<random>` under `<mountpoint>/.xinas-health` on every
  mounted managed fs (the file appears/disappears; the directory stays,
  root-owned 0700); `nfs.loopback` performs a REAL PID1-delegated
  `systemd-mount localhost:<export>` at a per-run
  `/run/xinas/health-probe/none-<random>/mnt` and unmounts (check
  `systemd-mount --list` empty and the per-run directory gone
  afterwards) — PID1 performs the mount, so this validates the
  delegation end to end. (The agent does now hold `CAP_SYS_ADMIN`,
  for `mkfs.xfs`/`xfs_growfs`; the delegation is kept for `.mount` unit
  semantics, not for want of the capability.) S19a: the report carries
  `coverage_status: complete` and `collection.sources.probes: success`;
  every check's `evidence.collection.status` is `success` on a healthy
  node — a `not_supported` license section means `xicli` is absent.
- [ ] `POST /health/probe {probe: fs_io, target: <Filesystem id>, run_id:
  <the run_id from GET /health/context>}` (any other value is
  `INVALID_ARGUMENT`) with an operator token: `ok: true`, `artifact.path`
  names `probe-<run_id>-<random>`, `cleanup.status: clean`, and the file
  is gone. Repeat with `nfs_loopback` on a Share id. Then over MCP with
  `mcp.allow_apply: true` from a modern client: `input_required` form →
  `decision: APPLY` → the same result plus `confirmation_id`; the record
  reads `consumed` with `consumed_task_id: probe:<uuid>`. Run two probes
  concurrently: the second answers `409 CONFLICT` (`PROBE_IN_PROGRESS`).
- [ ] Validation B01 (2026-09-10): on the installed node,
  `nsenter -t $(systemctl show -p MainPID --value xinas-agent) -m -- findmnt -no TARGET,OPTIONS <mountpoint>`
  shows `ro` (the agent's own namespace) while `findmnt` on the host
  shows `rw`; `POST /health/probe {probe: fs_io}` nevertheless returns
  `ok: true`, `cleanup.status: clean`, and `journalctl -u 'xinas-health-fsio-*'`
  shows one transient unit per probe, `ProtectSystem=strict`,
  `ReadWritePaths=<mountpoint>`, exited 0. `GET /health?profile=deep`
  (operator, `mcp.allow_apply: true`) reports `filesystem.io: ok` on the
  same node — before this fix it was `critical` with `EROFS`.
- [ ] Validation F05/F08 (2026-09-10): start `GET /health?profile=deep` and,
  while it runs, `POST /health/probe {probe: nfs_loopback}`: the second
  answers `409 CONFLICT` (`PROBE_IN_PROGRESS`). Stop `nfs-server` and run
  `POST /health/probe {probe: nfs_loopback}`: `ok: false`, the per-run
  directory under `/run/xinas/health-probe/` is gone or reported under
  `cleanup.detail`, and nothing under the export path changed.
- [ ] S19b prompt, from a real MCP client (Claude Desktop / Inspector) on
  both eras: `server/discover` (modern) and `initialize` (legacy)
  advertise `prompts: { listChanged: false }`; `prompts/list` shows
  `xinas_health_check` with eight optional arguments; `prompts/get` with
  `{ probe_policy: bounded_active, symptom: "writes stall" }` returns one
  `user` message whose parameters block reports `effective:
  observe_only` with the reason and quotes the symptom only inside
  `<user_symptom>`; a bad `time_window` is `-32602` with
  `data.argument`. Set `mcp.health_prompt.enabled: false`, restart: the
  capability is gone and both methods answer `-32601`. The audit trail
  shows one `mcp.prompts.get` row without the symptom text.
- [ ] `GET /health/context` with a viewer token on the live node:
  `collectors.heartbeat: healthy`, `topology` links every managed
  filesystem to its array and every share to its filesystem,
  `freshness` names every observed kind with recent timestamps,
  `baselines.dir_present: true` with the three shipped profiles and
  `deep.sections_without_checker: ["kerberos"]`, `permitted.probe_run:
  denied`. Stop `xinas-agent`: the call still answers, with
  `heartbeat: offline` and `declared_absent: []`. With an operator token
  `permitted.deterministic` includes `deep` and `probe_run: allowed`.
  Re-read with `?run_id=` from the first call: same `run_id`; with a
  made-up id: a new run plus `RUN_UNKNOWN`.
- [ ] Run budget: `GET /health/context` (operator) → `run_id`; five
  `POST /health/probe {probe: fs_io, target: <fs>, run_id}` calls: four
  succeed and the fifth answers `412 PRECONDITION_FAILED`
  (`probe_budget_exhausted`) without the agent logging a probe.
  `GET /health?profile=quick&run_id=<run_id>` echoes the run id with no
  warning; restart `xinas-api` and repeat: `RUN_UNKNOWN`, still `200`.
- [ ] `GET /health/catalog`: `version: "1"`, twenty rows, `HC-11.client-path`
  and the other `no_source: true` rows list no inputs; `xinasctl health
  catalog` and `xinasctl health context` render the same bodies.
- [ ] S19c baseline: `GET /health/baseline?profile=quick` with a viewer
  token runs the real engine on the node (`collection.status: success`,
  `engine.version` equals `XINAS_MENU_VERSION`, `report.checks` carry the
  engine's PASS/WARN/FAIL/SKIP rows, `duration_ms` under the 60 s cap) and
  leaves nothing under `/var/log/xinas/healthcheck` (`--no-save`);
  `?profile=deep` reports `sections_without_checker: ["kerberos"]` and
  the engine report holds a `kerberos / checker / SKIP` row; a second
  call with `max_age_s=600` is `from_cache: true`; `GET /health/context`
  now says `baselines.sections_source: engine`. Point
  `health_baseline.python` at a missing path, restart the agent: the
  route answers `200` with `collection.status: not_supported`,
  `error.code: ENOENT`. `ps` shows no leftover python after a run that
  was cut by a 1 s cap (set `baseline.timeout_s.quick: 10` and a slow
  profile to observe `timeout`).
- [ ] S19c report: `GET /health/report-schema` returns the v1 schema; build
  a report around `GET /health?profile=quick&run_id=<run>` and
  `GET /health/baseline?profile=quick&run_id=<run>` raw reports,
  `POST /health/report/validate` → `valid: true`, `integrity.status:
  verified`, `checked: 2`; change one raw check's status → `mismatch`
  with `reason: report_rehash_mismatch`; mark a mandatory row
  `not_applicable` with a reason that cites nothing →
  `rewritten_to_unknown` and `coverage_status: partial`. Over MCP from a
  modern client, `health.report.validate` passes the gate without
  `mcp.allow_apply` and without a confirmation.
- [ ] S19d prompt gate (requirements §10; not automated — a person runs it
  per release on every supported host/model): from each host (Claude
  Desktop, Inspector, the stdio adapter, …) select `xinas_health_check`
  and run it three times per scenario against the node prepared for that
  scenario (a degraded array for AC-01, a stopped collector for AC-02,
  an injected log line for AC-13, …). For every run save the model's
  report and the host's tool-call log as
  `xiNAS-MCP/src/__tests__/fixtures/agentic/ac-NN-<host>-<n>.json`
  (shape and placeholders: the README next to the fixtures; the `ledger`
  block is the raw `health.check` / `health.baseline` /
  `health.probe.run` results of that run, `expected` copies the shipped
  scenario's block) and run
  `npx vitest run src/__tests__/lib/health/agentic-fixtures.test.ts`.
  Release bar: zero forbidden calls, zero invented evidence (no reference
  errors), zero false ok on the fault and data-gap scenarios, every
  critical raw result preserved (`ledger_preserves`), and
  `health.report.validate` on the node answers `valid: true` with
  `integrity.status: verified` for every kept report.
- [ ] Drift: edit `/etc/netplan/99-xinas.yaml` by hand → `drift.netplan`
  degraded in `GET /health` AND `GET /config-history/drift`; re-apply →
  clean. Remove an export via `exportfs -u` → `drift.nfs-exports`
  degraded with the missing path in evidence.
- [ ] `POST /support-bundle` → task success → download; extract and
  verify: journals scrubbed (`grep -ri bearer` shows only `***`),
  `xiraid/license.json` is the PARSED struct, no `/etc/xinas-api` or
  `/etc/xinas-agent` content anywhere, `api/api.json` carries tasks +
  audit + the health report. Run it twice concurrently → the second
  queues behind the SupportBundle/default lease.

## 5b. S8 — MCP / CLI / TUI clients

- [ ] After the rebuild (`Requires-Rebuild: all` from the role
  decomposition): `systemctl status xinas-mcp` shows the LEGACY unit
  gone (stopped/disabled/removed by the shim); `xinas-api` serves
  `/mcp`; `/usr/local/bin/xinas-mcp-stdio` and `/usr/local/bin/xinasctl`
  exist.
- [ ] **Demo re-point:** the remote MCP endpoint moves to the api's
  `mcp.http` listener (set `mcp: { http: { host, port } }` in
  `/etc/xinas-api/config.json` — e.g. the old :8080); re-point the
  demo client config and re-create any remote bearer tokens in the
  api token store (legacy /etc/xinas-mcp tokens do NOT migrate
  automatically).
- [ ] `xinasctl arrays list`, `xinasctl health check --profile quick`
  over the UDS as root (peer trust, no token).
- [ ] MCP exit criterion on hardware: a tool call with `mode=apply`
  → `MCP_APPLY_DISABLED`; flip `mcp.allow_apply: true`, restart the
  api, same call plans→applies→task success; flip back. (A confirmable
  tool's apply now stops at the S15 MRTR confirmation gate first — see
  §5i.)
- [ ] TUI parity: create a share, edit an interface IP, and run the
  RAID delete teardown from the TUI — every step should appear as
  tasks in `xinasctl tasks list` with plan/apply audit rows
  (`client_type` rest), and NO direct netplan/mkfs/exportfs calls
  from the TUI (check `ps`/journals during the operations).
- [ ] One audit row per MCP tool call (`/var/log/xinas/audit.jsonl` —
  no `http.POST./mcp` frames).
- [ ] **MCP Tasks (S16):** with `mcp.allow_apply: true` and a modern
  client, `filesystems.create` `mode=plan` shows
  `rollback_model: unsupported`; the apply is confirmed out-of-band
  (URL mode) by a second admin; the accepted retry with the Tasks
  capability answers `resultType: "task"` within seconds while
  `mkfs.xfs` runs; `tasks/get` reports `working`, the `mkfs` stage,
  elapsed time and no percentage; `tasks/cancel` during `mkfs` is
  acknowledged and `xinasctl tasks get <id>` shows
  `cancel_refused_reason: irreversible_stage_started`; the task ends
  `success` and `tasks/get` returns `completed` with the public Task.
  Before naming a client (Claude Code / Codex) a supported native Tasks
  client, capture that it (1) declares the extension on the retry,
  (2) accepts `CreateTaskResult`, (3) polls the same `taskId`,
  (4) renders `isError` on a failed create, and (5) resumes with the
  same id after a reconnect instead of re-applying.

## 5c. S9 — config-history bridge, audit query, pools

- [ ] **Snapshots observed:** `GET /api/v1/config-history/snapshots`
  lists the store's manifests with projected kinds (`baseline` /
  `before` / `after`) matching `python3 -m xinas_history snapshot list`;
  rows refresh within the poll interval after a new apply creates
  snapshots.
- [ ] **Diff round-trip:** pick a before/after pair from an apply and
  `GET /api/v1/config-history/diff?from=<before>&to=<after>` → file
  changes match `python3 -m xinas_history snapshot diff` for the same
  pair.
- [ ] **Baseline rollback gate:** `POST /config-history/rollback` with
  `to` ≠ baseline → `targeted_rollback_not_implemented` blocker;
  `to: baseline` plans with `risk_level: destructive`, apply WITHOUT
  `dangerous: true` → 412, with it → task runs
  `python3 -m xinas_history` reset and post-rollback configs match the
  baseline snapshot (spot-check `/etc/exports`).
- [ ] **Audit query:** `GET /api/v1/audit?kind=http.POST./config-history/rollback`
  finds the rollback rows; `?task_id=<apply task>` exact lookup returns
  the same rows immediately after the apply (index + outbox fallback —
  no visibility window).
- [ ] **Pools end-to-end:** `xinasctl pools list` matches
  `xicli pool show`; create a pool from a free drive, add/remove a
  drive, activate, then `DELETE` while active → `pool_active` blocker;
  while referenced as an array's spare pool → `pool_referenced` (and
  the executor's live preflight blocks even when observation lags);
  deactivate + unreference → delete completes and the row vanishes
  from `GET /api/v1/pools`.
- [ ] **TUI spare pools:** the Spare Pools screen drives all six
  actions through the API (tasks appear in `xinasctl tasks list`;
  `referenced_by` column shows the in-use badge; no `xicli pool`
  subprocess calls from the TUI).
- [ ] **Observation longevity:** ≥5 minutes after agent start,
  `GET /api/v1/pools`, `/config-history/snapshots`, and tuning-backed
  health checks still return rows (poll-sweep reconcile must not wipe
  re-emitted kinds — the S9 collector regression).

## 5d. S10 — task cancel

- [ ] **Running cancel:** start a slow reference apply
  (`xinasctl reference apply` equivalent via REST:
  `POST /api/v1/reference` with `spec.sleep_ms: 30000`), then
  `xinasctl tasks cancel --id <task>` → exit 0; `xinasctl tasks show`
  reaches `cancelled` with a `rollback` stage and NO error_code;
  `cancel_requested_at` is set.
- [ ] **Queued cancel:** with the worker pool busy (4 concurrent slow
  applies), queue a 5th, cancel it → immediate `cancelled` with no
  agent involvement; a `GET /tasks/{id}/watch` stream open during the
  cancel receives the synthetic terminal frame (sequence advanced).
- [ ] **Late cancel:** cancel a completed task → 409
  `not_cancellable`; re-cancel a cancelled task → 200 (idempotent).
- [ ] **MCP emergency stop:** `tasks.cancel` via MCP with
  `mcp.allow_apply: false` MUST be permitted (ADR-0010: an emergency
  stop cannot apply new state).
- [ ] **Audit:** `GET /api/v1/audit?task_id=<task>` finds both the
  apply AND the cancel rows (the cancel route stamps operation_id).
- [ ] **TUI:** start a RAID create or filesystem create and press
  Cancel in the wait dialog → "cancelled — partial work rolled back"
  notice (not a failure toast); the array/filesystem does NOT exist
  afterwards.

## 5e. S11 — targeted snapshot rollback

- [ ] **Capture carries the payload:** after any S2+ apply, inspect the
  new snapshot dir under `/var/lib/xinas/config-history/snapshots/<id>/`
  — a `system/` subdir holds the live config bytes (`etc_exports`,
  `netplan`, the nfs.conf family), and the manifest has `files_changed`.
  `python3 -m xinas_history snapshot list --format json` shows
  `restorable: true` for it (and `false` for any pre-S11 snapshot).
- [ ] **Targeted restore (NFS):** edit `/etc/exports` out of band (or
  apply then revert a share), then restore the earlier snapshot — from
  the TUI snapshot-detail **Restore** action, or `xinasctl` /
  `POST /config-history/rollback {to: <id>, reason}` with `dangerous`.
  The task reaches `success`; `/etc/exports` reverts to the captured
  bytes; `exportfs` re-ran (the clients see the restored set); the task
  output carries the "observed recovery — re-apply to make durable"
  warning.
- [ ] **Drift surfaces:** immediately after the restore, `GET /health`
  / `GET /config-history/drift` shows `drift.nfs-exports` (and
  `drift.netplan` if network was restored) degraded — desired KV is
  unchanged. Re-apply the matching desired state → drift clears.
- [ ] **Network restore (careful):** on a node where IB is not the
  management path, restore a snapshot whose `files_changed` includes
  `netplan` → `99-xinas.yaml` reverts, the PBR-flush + `netplan apply`
  sequence runs, and the link recovers (the runner is local, so a bad
  link does not strand it; validation + file-level auto-rollback
  recover the pre-change bytes if it fails).
- [ ] **Guards:** restoring a pre-S11 / ephemeral snapshot → plan blocks
  with `no_restorable_payload`; an unknown id → `snapshot_not_found`; a
  restore whose live state already matches the target → task `success`
  no-op. MCP `config_history.rollback` with `to: <id>` still needs
  `allow_apply` (destructive). Audit: `GET /api/v1/audit?task_id=<id>`
  finds the restore.

## 5f. S12 — durable adoption (adopt restore)

The S11 restore in §5e is an OBSERVED recovery: it reverts the file bytes
but leaves desired KV untouched, so `drift.nfs-exports` shows degraded
until the matching desired state is re-applied. S12 adds **adopt** — the
restore ALSO re-asserts the snapshot's captured desired rows (puts the
captured Shares/ExportGroups/NfsProfiles/NetworkInterfaces, deletes the
orphans) in the SAME apply, so drift is CLEAN afterward.

- [ ] **Captured desired payload:** after any S12 apply, the new snapshot
  is `adoptable` — `GET /api/v1/config-history/snapshots` shows
  `adoptable: true` for it (the api persisted a snapshot-desired payload
  alongside the manifest). A pre-S12 snapshot (or one from a non-mutating
  / rollback op) shows `adoptable: false`.
- [ ] **Adopt restore (NFS):** create a share (snapshot S taken), then
  mutate it out of band — edit `/etc/exports` AND delete the Share from
  desired (`DELETE /api/v1/shares/<id>` apply, or add a second share so
  the captured set differs). Restore S **with adopt** — from the TUI
  snapshot-detail **Adopt (make durable)** action, or
  `POST /config-history/rollback {to: <S>, reason, adopt: true}` planned
  then applied with `dangerous` via `xinasctl`. The plan diff carries
  `adopt: true` with the `desired_puts` / `desired_deletes` it will make
  (the captured share put, the orphan share deleted); the task reaches
  `success`; `/etc/exports` reverts to the captured bytes; `exportfs`
  re-ran (clients see the restored set); `GET /api/v1/shares` now matches
  the captured set (the re-asserted share present, the orphan gone).
- [ ] **Drift CLEAN (the S12 payoff):** immediately after the adopt
  restore — with NO further re-apply — `GET /health` and
  `GET /config-history/drift` show `drift.nfs-exports` **clean** (and
  `drift.netplan` clean if network was in the captured set). Contrast
  §5e: the same restore WITHOUT adopt leaves `drift.nfs-exports`
  degraded. Re-running the adopt is idempotent (live state already
  matches → task `success`, drift stays clean).
- [ ] **Per-domain scoping:** restoring an NFS-only snapshot with adopt
  does NOT touch desired network rows (and vice versa) — a snapshot whose
  captured payload has no NetworkInterface rows leaves `99-xinas.yaml`
  desired state untouched (no `drift.netplan` churn).
- [ ] **Guards:** `adopt: true` on a `to: baseline` reset → plan rejected
  `INVALID_ARGUMENT` (baseline has no captured desired payload to adopt);
  adopt on an observed-but-not-captured snapshot (pre-S12) → plan blocks
  with `not_adoptable`; the stale guard fires if a captured Share's
  desired revision is bumped between plan and apply → apply
  `PRECONDITION_FAILED {stale}` with desired KV unchanged. MCP
  `config_history.rollback` with `adopt: true` still needs `allow_apply`
  (destructive). Audit: `GET /api/v1/audit?task_id=<id>` finds the adopt
  apply.
- [ ] **GC of orphan payloads:** after the Python-side history GC removes
  a snapshot and the agent's next sweep drops its
  `observed/ConfigSnapshot/<id>` row, the api's snapshot-desired GC prunes
  the orphaned payload — that snapshot id no longer appears with
  `adoptable: true` (and re-creating a share does not resurrect a stale
  captured set).

## 5g. S13 — tombstone absent-file restore

S11/S12 restore the bytes of files that EXISTED at capture time. They could
not represent "this managed file was ABSENT here" — so restoring a snapshot
taken while NFS was off LEFT a later-created `/etc/exports` in place (and the
adopt overlay only ever PUT captured rows, never deleting a domain that the
snapshot had wholly removed). S13 adds an explicit `absent_files` set captured
at snapshot time: on restore the runner DELETES any managed file that is in
`absent_files` but present now, and adopt tombstone-DELETES the current desired
rows of that domain's primary kind (Share↔etc_exports, NetworkInterface↔netplan;
ExportGroup / the default NfsProfile are NEVER tombstone-deleted).

- [ ] **Capture records absences:** with NFS OFF (no `/etc/exports`, or
  `share.list` empty / `xinas-nfs-helper` not exporting), take a snapshot
  (any S2+ apply, or `python3 -m xinas_history snapshot create`). Inspect it:
  `python3 -m xinas_history snapshot show <S> --format json` lists
  `etc_exports` in `absent_files`, and `GET /api/v1/config-history/snapshots`
  shows the projected `absent_files: ["etc_exports"]` for `<S>` (the row is
  `restorable: true` because a non-empty `absent_files` widens restorability
  even with no changed-file bytes to write).
- [ ] **Tombstone restore (NFS):** AFTER capturing `<S>` above, create a share
  (`POST /api/v1/shares` apply) so `/etc/exports` now EXISTS and the desired
  KV has the Share row. Restore `<S>` **with adopt** — from the TUI
  snapshot-detail **Adopt (make durable)** action, or
  `POST /config-history/rollback {to: <S>, reason, adopt: true}` planned then
  applied with `dangerous` via `xinasctl`. The plan diff carries `adopt: true`
  with `desired_deletes` listing the Share key (`/xinas/v1/desired/Share/<id>`)
  and NO matching `desired_puts` (the captured Share set is empty); the task
  reaches `success`; **`/etc/exports` is REMOVED** (contrast S11/§5e, which
  would leave the file); `GET /api/v1/shares` no longer lists the share (the
  desired row was tombstone-deleted); `exportfs` re-ran with the share gone.
- [ ] **Drift CLEAN afterward:** immediately after the tombstone restore — with
  NO further re-apply — `GET /health` and `GET /config-history/drift` show
  `drift.nfs-exports` **clean** (desired and live both have no export). S11
  WITHOUT adopt would leave `/etc/exports` present and desired-vs-live skewed;
  S13 adopt removes both sides in the same apply. Re-running the adopt is
  idempotent (file already absent, no Share rows → task `success`, drift stays
  clean).
- [ ] **Singletons survive:** the tombstone deletes only the PRIMARY-kind rows
  (Share / NetworkInterface). The default `ExportGroup` and the default
  `NfsProfile` are NOT deleted — confirm they still resolve after the restore.
- [ ] **The hinge (pre-S13 snapshots carry no tombstones):** restore an OLDER
  snapshot taken before S13 (or any snapshot whose `absent_files` is empty)
  with adopt → the plan diff has NO tombstone `desired_deletes` for a domain
  that has live desired rows; behaviour is exactly the S11/S12 adopt (puts the
  captured rows, no removed-domain deletion). No `absent_files` → no tombstone.

## 5h. S17 — subscriptions: product-client smoke protocol

*Spec: [s17-mcp-subscriptions-spec.md](s17-mcp-subscriptions-spec.md) §16
(SUBS-CLIENT-002).* The automated suites prove the wire contract against
the released `2026-07-28` schema and the released
`@modelcontextprotocol/client` 2.0.0; this section records what each
*product* client actually does with the feeds, which no unit test can.

Record one row per client. Every column is observed, never inferred:

| Column | Where the answer comes from |
|--------|-----------------------------|
| client + version | the client's own about/version output |
| transport | `stdio` via `/usr/local/bin/xinas-mcp-stdio`, or Streamable HTTP against `mcp.http` |
| issued `subscriptions/listen` | api audit: `mcp.subscription.opened` rows in `/var/log/xinas/audit.jsonl`, or `GET /api/v1/audit?kind=mcp.subscription.opened` |
| honored filter | the `honoredFilter` in the client's log, or the `mcp.subscription.opened` payload |
| update reached the client | the client's MCP log showing `notifications/resources/updated` after a driven transition (below) |
| re-read or surfaced | whether the client re-read `xinas://events/<feed>?after=…` (api audit `mcp.resource.read`) or surfaced the notification to the model |
| reconnect | close the api (`systemctl restart xinas-api`): does the client re-issue `listen` and read after its last cursor |
| configuration | the exact client config block used (server entry, env, tokens) |

Driving a transition on hardware without touching data: fail and restore
`nfs-server.service` (`systemctl kill --signal=SIGKILL nfs-server` then
`systemctl start nfs-server`) → `nfs.service.unavailable` /
`nfs.service.recovered` on `xinas://events/nfs`; or start an
initialization on a scratch array → `raid.operation.started` and the
`raid/progress` buckets.

- [ ] **Claude Code** — pending (V-29). Row to fill: version, transport,
  listen issued, honored filter, update received, re-read/surfaced,
  reconnect, config.
- [ ] **Codex** — pending (V-29). Same columns.
- [ ] **Polling-only client** (any client that never issues `listen`):
  `resources/read` on `xinas://events/nfs?after=<cursor>` returns the
  driven events with `gap: false`; the `instructions` text names this
  fallback.

Until both product rows are filled, the release notes state the
limitation and point at the polling fallback (spec §16).

## 5i. S15 — MCP apply confirmation

*Spec: [s15-mcp-mrtr-confirmation-spec.md](s15-mcp-mrtr-confirmation-spec.md)
§14.4 (target clients and expected behavior).* The automated suites
(`mcp-confirmation.test.ts` against the hand-rolled wire format,
`sdk-v2-client.test.ts` against the released `@modelcontextprotocol/client`
2.0.0) prove the confirmation contract end to end, including the client's
automatic `input_required` round-trip; this section is the target-client
verification §14.4 requires before the gate counts as proven on hardware.

- [ ] **S15 MCP confirmation (form) — this step is the verification of
  the target-client behavior in S15 §14.4; nothing before it counts as
  proof.** With `mcp.allow_apply: true`, from Claude Code ≥ 2.1.259
  registered against `xinas-mcp-stdio` as a **non-root** account that is
  not in `xinas-admin` (S15 §3.5): plan a
  share update, then apply — Claude Code shows the xiNAS form (node,
  operation, risk, diff, expiry); pick APPLY → the task runs; pick Decline
  → `CONFIRMATION_DECLINED` and no task. The api journal shows the retry
  arriving with a NEW JSON-RPC id and the exact `requestState`.
- [ ] **S15 destructive (URL):** set `mcp.confirmation.approval_url_base`
  (https, or `http://127.0.0.1:<port>` when testing on the node itself);
  `filesystems.delete` with `dangerous: true` → Claude Code shows the
  approval URL and asks consent; open it, load with a *different* admin
  token, type `DATA MAY BE PERMANENTLY LOST`, approve → the client's retry
  creates the task. Approving with the requester's own token → refused
  (`approver_policy`). `xinasctl mcp_confirmations list --status pending`
  works as root; `approve <id> --acknowledge "…"` as root is **refused**
  with the default config (break-glass off) and succeeds — leaving a
  `mcp.confirmation.break_glass_used` audit row — only after setting
  `allow_uds_approval: true`; set it back to false afterwards.
- [ ] **S15 Codex ≥ 0.147** with `protocol_version = "2026-07-28"`
  (upgrade first — the development Mac has 0.136.0): the form flow
  completes; a destructive apply without URL support fails with JSON-RPC
  `-32021` before any mutation. Record the observed behavior against the
  "expected" rows of S15 §14.4.
- [ ] **S15 token surface:** with the agent's bearer configured
  `"surface": "mcp"` (S15 §3.5, §13), replay the same apply body over
  REST with that token → `401 PERMISSION_DENIED`,
  `details.reason: token_surface`; the MCP flow with the same token still
  completes. Without the key (`surface` absent = `any`) the REST apply
  succeeds unconfirmed — confirm that too, so the difference is observed
  rather than assumed.
- [ ] Audit (`/var/log/xinas/audit.jsonl`): `mcp.confirmation.requested`,
  `…approved` (URL), `…consumed`, `…apply_task_created` rows plus exactly
  one `http.*` row for the apply; `GET /api/v1/metrics` shows the counters.

## 6. Cross-cutting

1. [ ] **Plan→pause→apply:** plan an array modify, wait 2+ minutes,
   apply with the planned revision → succeeds (the sweep-dedupe fix on
   real timing).
2. [ ] **Snapshots:** every apply above produced before/after
   config-history snapshots (`python3 -m xinas_history snapshot list`).
3. [ ] **Audit:** `GET /api/v1/audit` shows the chain for the session;
   spot-check `prev_hash` linkage on two consecutive entries.
4. [ ] **Worker pool:** fire 6 concurrent applies (mix of kinds) →
   ≤4 running at once, the rest queued then drained FIFO; all terminal.
5. [ ] **Uninstall (WS13):** `./uninstall.sh` default path → services
   removed, `/etc/netplan/99-xinas.yaml` and data filesystems LEFT IN
   PLACE (non-destructive default).

---

When every box is checked, WS5/WS6/WS8's "verify on hardware" residuals
and WS13's three exit criteria are closed; update
`docs/control-path/phase0-sequencing.md` accordingly.
