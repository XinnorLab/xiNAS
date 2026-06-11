# xiNAS S7 — health profiles, drift, support bundle (design spec)

**Status:** design (2026-06-11; conforms to **ADR-0009**). Closes WS9
("drift visible in health and API") and WS10 (real profiles + support
bundle). Implementation plan:
`docs/plans/2026-06-11-s7-health-drift-plan.md`.

**Goal.** `GET /health?profile=quick|standard|deep` returns a real,
deterministic report over the full check catalog (ADR-0009 tables);
three desired-vs-observed drift checks fire when managed config
diverges from intent; `POST /support-bundle` produces a redacted,
downloadable archive through the task envelope.

**Verified integration facts (truth-checked this session).**
- `effective_files` = the four ADR-0005 paths only (`probe/nfs-profile.ts`)
  — `/etc/exports` drift is therefore the SEMANTIC ExportRule compare.
- No TS renderer for profile files; the helper's renderer is the drift
  oracle — but today's `render_nfs_profile` ALWAYS writes + restarts
  (verified `nfs-helper/nfs_profile.py`): **S7 adds `dry_run: true` to
  the helper op** (python + tests: dry call touches nothing) before
  `health.probe` may call it. The probe carries the desired spec from
  the api — the agent reads no KV.
- The live convergence wires a deliberately-failing systemd probe —
  observed SystemdUnit rows exist on NO host today. **S7 promotes it to
  a `systemctl show` subprocess probe** (seam + fixture) and extends
  the allow-list with the xinas units; without this, `nfs.server` and
  `systemd.units` would be hollow.
- `GET /config-history/drift` is an empty placeholder — S7 wires the
  same drift engine into it (ADR-0009 §drift API surface).
- `xicli license show` output is recoverable license material
  (`simple_menu.sh:129`) — parsed-only in bundles and probe results.
- Task creation/idempotency/leases live in `TaskEngine.apply`;
  `admitAndDispatch` only dispatches an existing queued task — the
  bundle route composes plan→apply→admit internally.
- `ResourceRef.kind` is a closed public enum; `lease_resources` is
  internal (N0.5) → `SupportBundle/default` leases internally,
  `affected_resources: []` publicly.
- `perf_tuning` sysctls are drop-in-file based and overrideable
  (`sunrpc.tcp_max_slot_table_entries`, not `tcp_slot_…`) — expected
  values are parsed from the installed drop-ins, never hardcoded.
- Agent sandbox: no deltas needed (ADR-0009 §Sandbox).

---

## 1. Scope

### In scope
- **T0 contracts:** ADR-0009 (this commit); s0s1 RPC table gains
  `health.probe` (enumerated, Real); `Tuning` in both Kind registries;
  api-v1: `HealthReport`/`HealthCheck` untouched (already adequate),
  `/support-bundle` untouched (already contracted), a note on
  `GET /health` profile semantics.
- **T1:** Tuning probe (drop-in parse + /proc/sys reads) + collector
  emission (singleton, compare-and-skip) + fixture passthrough.
- **T1b:** systemd observation promotion — `systemctl show` subprocess
  probe (seam + `systemd-units.json` fixture), allow-list +xinas units,
  convergence wiring; the S0/S1 collector consumes it unchanged.
- **T1c:** helper `dry_run` — `render_nfs_profile(dry_run=true)` renders
  checksums with NO writes and NO service action; python tests assert
  an untouched tree + no systemctl calls.
- **T2:** `lib/health/` check engine — types, registry, `overall`
  fold; the thirteen quick checks as pure functions over injected facts.
- **T3:** `lib/health/drift.ts` — the ExportRule semantic compare and
  the netplan hash compare (+ their checks); nfs-conf drift check shell
  (consumes probe results).
- **T4:** agent `health.probe` RPC — standard facts (license parse via
  a subprocess seam, fresh rdma, collector health, helper dry-render
  checksums for the carried desired profile spec); s0s1 dispatcher
  enumeration.
- **T5:** deep probes — `ProbeHost` seam (`touchProbe(mountpoint)`,
  `loopbackMount(exportPath)` via systemd-mount/umount, both with
  file-backed fakes + `-fail` hooks); wired into `health.probe
  level=deep`.
- **T6:** `GET /health` integration — profile dispatch, facts
  gathering, probe call with timeouts, agent-down degradation — AND
  `GET /config-history/drift` wired to the same drift engine
  (`{drift: [...]}`, nfs-conf reported `not_evaluated` pointing at
  standard health).
- **T7:** support bundle — `support.bundle` plan provider (lease
  override, empty public affected), the route composite
  (api-side staging file with task history/audit/state/deep-report →
  plan → apply → admit), the agent executor (`BundleHost` seam:
  journals, config copies, snapshot index, xicli parsed license +
  raid/pool JSON, redaction, tar, chgrp 0640, retention prune), and
  `GET /support-bundle/{task_id}` streaming.
- **T8:** e2e + full gate.

### Out of scope (ADR-0009 deferrals)
Snapshot-axis drift, bandwidth tests, metrics exposure, auto-remediate,
bundle upload.

---

## 2. Component map

```
   api (unprivileged)                            agent (root)
   ┌────────────────────────────────────────┐    ┌─────────────────────────────────┐
   │ routes/health.ts (engine integration)  │RPC │ rpc health.probe                │
   │ lib/health/{engine,checks,drift}.ts    │───▶│   standard: license/rdma/       │
   │ routes/support.ts (composite + stream) │    │     collectors/profile dry-rndr │
   │ plan/providers/support.ts              │task│   deep: ProbeHost (touch,       │
   │   (lease override, [] affected)        │───▶│     PID1 loopback mount)        │
   └────────────────────────────────────────┘    │ task/support-executor.ts        │
                                                 │   (BundleHost: journal/config/  │
              api stages bundles/<id>.api.json   │    xicli/tar/redact/prune)      │
              under /var/log/xinas before apply  │ probe/tuning.ts + collector     │
                                                 └─────────────────────────────────┘
```

## 3. Facts + engine contracts (T2)

```ts
// lib/health/engine.ts
export interface HealthCheckResult {
  id: string;
  category: 'api'|'agent'|'state_store'|'xiraid'|'filesystem'|'nfs'|'network'|'drift'|'systemd'|'tuning';
  status: 'ok'|'warning'|'degraded'|'critical'|'skipped';
  symptom: string;
  impact: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
}
export type QuickCheck = (facts: HealthFacts) => HealthCheckResult;
export function overallOf(checks: HealthCheckResult[]): 'ok'|'warning'|'degraded'|'critical';
```

`HealthFacts` is gathered once per GET from KV (observed arrays,
filesystems, systemd units, sessions/exports, desired shares/profile/
network rows, NetworkConfig, Tuning) plus the heartbeat tracker state.
Checks are pure and individually unit-tested against fact fixtures.

## 4. `health.probe` RPC (T4)

```
→ { "method": "health.probe",
    "params": { "level": "standard"|"deep",
                "desired_nfs_profile": { ...spec }|null } }
← { "result": {
      "license": { "status": "active"|"expired"|"absent", "days_left": n|null,
                   "features": [..] } | null,          // PARSED ONLY
      "rdma_links": [ {netdev, state, physical_state} ],
      "collectors": { "<name>": "running"|"stubbed"|"error: …" },
      "nfs_profile_render": { "<path>": "sha256:…"} | null,  // helper dry render
      "probes": {                                      // level=deep only
        "fs_io": [ {mountpoint, ok, error?} ],
        "nfs_loopback": {attempted, export?, ok, error?} | null } } }
```

Each section independently try/caught on the agent; a section failure
returns `null`/partial with the error folded into the consuming check's
evidence. The RPC mutates nothing beyond the probe artifacts
(`.xinas-health-probe` files are deleted in the same call;
`/run/xinas/health-probe/mnt` is unmounted in a `finally`).

## 5. Drift details (T3)

- **nfs-exports (quick):** desired Shares → `compileShareToExportEntry`
  list; observed ExportRule rows → entries. Compare path-by-path:
  missing (desired w/o observed), extra (observed w/o desired), changed
  (option sets differ after canonicalization — sort options, normalize
  host patterns). Any difference → `degraded` with the three lists as
  evidence; no desired Shares → `skipped`.
- **nfs-conf (standard):** probe's `nfs_profile_render` vs observed
  `NfsProfile.effective_files` per path. Missing render (helper down) →
  `degraded` with the helper error. No desired profile row →
  `skipped`. In `quick`: `skipped (requires standard)`.
- **netplan (quick):** rebuild desired rows exactly as the S6 provider
  does (`gatherNetFacts` reuse), `sha256(renderNetplan(rows))` vs
  `NetworkConfig.xinas_file_hash`. No desired rows → `skipped`; absent
  NetworkConfig row (old agent) → `skipped` with a note.

## 6. Support bundle layout (T7)

```
bundle-<task_id>.tar.gz
├── meta.json            # schema 1, controller_id, versions, created_at, task_id
├── api/                 # staged by the API before dispatch
│   ├── tasks.json       # last 200 task rows
│   ├── audit.json       # last 1000 audit entries + chain head
│   ├── state-observed.json
│   ├── state-desired.json
│   └── health-deep.json
├── journal/{xinas-api,xinas-agent,nfs-server,xiraid}.log   # 2000 lines, scrubbed
├── configs/{exports,nfsd.conf,nfs-kernel-server,lockd.conf,nfs-common,netplan/*}
├── snapshots.json       # xinas_history index (bridge subprocess)
└── xiraid/{license.json (PARSED), raid-show.json, pool-show.json}
```

Redaction rules (tested with seeded secrets): no `/etc/xinas-api` or
`/etc/xinas-agent` content anywhere; journal scrub
`s/(Bearer|Authorization:?)\s+\S+/\1 ***/`; license parsed-only.
Executor stages: `preflight` (api staging file present; bundles dir) →
`collect` (journals/configs/xicli/snapshots into a workdir, redacting
inline) → `archive` (tar.gz + chgrp 0640 root:xinas-api) → `verify`
(archive readable, contains meta.json, NO match for seeded-secret
patterns) → prune to 3. Rollback: delete the workdir + partial archive.

## 7. e2e (T8)

Fixture-mode api+agent (fake NetHost/FsHost/xiraid + fixture probes):
1. Healthy baseline: `quick` → all ok/skipped, `overall: ok`;
   `GET /config-history/drift` → `{drift: []}`; observed SystemdUnit
   rows present from the fixture (`systemd-units.json`).
2. Drift trio: mutate the fake netplan file out-of-band, remove an
   ExportRule fixture row vs a desired Share, and feed a divergent
   profile checksum → all three drift checks `degraded` in the right
   profiles AND the two KV ones in `/config-history/drift`; fix → ok.
3. `standard`: fake xicli seam returns a 10-days license → warning;
   collector error surfaces.
4. `deep`: fake ProbeHost happy path; `-fail` touch hook → critical for
   that fs only.
5. Agent down (SIGSTOP/kill): `quick` still answers; `standard` probe
   checks degraded with EXECUTOR_UNAVAILABLE.
6. Bundle: POST → 202 → task success → GET streams a tar.gz whose
   listing matches §6, seeded secrets absent, second POST while running
   → lease-serialized (409/queued), retention prunes to 3.

## 8. Risks & residuals

- Helper dry-render requires the nfs-helper socket up; degraded
  evidence covers it.
- `systemd-mount` loopback probe is hardware/systemd-only → fake-host
  covered in CI; appended to the hardware runbook (§5a) for the lab
  pass.
- Journal access: the agent runs as root — `journalctl -u` works; the
  bundle executor caps line counts to bound size.
