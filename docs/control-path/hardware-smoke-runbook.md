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
3. [ ] **Create:** `POST /arrays` plan→apply (4 spare NVMe drives,
   raid5) → task `success`; array appears in `xicli` and `GET /arrays`;
   PBR of the pool: `xnsp_<name>` created+activated when spares given.
4. [ ] **Modify:** PATCH spares + tuning → applied live (`xicli raid
   show` confirms); topology PATCH → 422.
5. [ ] **Delete gates:** delete without `dangerous` → 412; with a
   mounted dependent fs → 412 listing it; clean delete with
   `dangerous: true` → array gone, pool cleaned.

## 4. S5 — filesystems over the agent sandbox (S5 spec §10)

1. [ ] `POST /filesystems` (backing + log array volumes, `log_size`
   LARGER than the log array) → success; `systemctl cat <unit>` matches
   the render; `xfs_info` shows su/sw + external log with the CLAMPED
   size; the mountpoint dir was PID1-created (no agent mkdir in the
   journal).
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
- [ ] `profile=deep`: `filesystem.io` touches every mounted managed fs
  (probe file appears/disappears); `nfs.loopback` performs a REAL
  PID1-delegated `systemd-mount localhost:<export>` at
  `/run/xinas/health-probe/mnt` and unmounts (check `systemd-mount
  --list` empty afterwards) — the agent has no CAP_SYS_ADMIN, so this
  validates the delegation end to end.
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
  api, same call plans→applies→task success; flip back.
- [ ] TUI parity: create a share, edit an interface IP, and run the
  RAID delete teardown from the TUI — every step should appear as
  tasks in `xinasctl tasks list` with plan/apply audit rows
  (`client_type` rest), and NO direct netplan/mkfs/exportfs calls
  from the TUI (check `ps`/journals during the operations).
- [ ] One audit row per MCP tool call (`/var/log/xinas/audit.jsonl` —
  no `http.POST./mcp` frames).

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
