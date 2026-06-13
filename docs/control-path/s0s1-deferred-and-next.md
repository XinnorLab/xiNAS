# xinas-agent S0+S1 — deferred items & next steps

Forward-map for the Phase 0 control-path foundation after the squash landing
(#217, squashing #204–#216). Captures everything intentionally deferred so it
isn't lost, plus the candidate next work packages. The two independent reviews
that shaped this are:

- **`docs/plans/2026-06-02-xinas-agent-s0s1-independent-review.md`** — the
  24-agent review (1 P0 + 12 P1 confirmed, all fixed; 38 P2s catalogued there).
- **The PR #215 review** (7 findings; #1/#2/#5 already fixed pre-review, #3/#4/#6/#7
  fixed in #216). No separate report file — findings are in the #216 commit log.

All P0/P1 findings from both reviews are **fixed and landed in #217**. What
remains below is deferred-by-design or backlog.

---

## 1. Deferred by design (specced; lands in a later work package)

| Item | Where | Notes |
|------|-------|-------|
| **On-demand RPC reads** (`inventory.collect`, `disks.list`, `filesystems.list`, `mounts.list`, `network.snapshot`, `systemd.units_status`, `exports.list`, `nfs.sessions.list`) | `xiNAS-MCP/src/agent/rpc/methods/stubs.ts`; spec RPC table | Enumerated as stubs returning `EXECUTOR_UNSUPPORTED` (not `-32601`). The LIVE S0/S1 data path is the push model (Flow A). **WS12** wires these to the collectors' last-computed snapshots. |
| **`tasks` read metadata** | `xiNAS-MCP/src/api/routes/tasks.ts` | Tasks reads are left raw (no synthesized `metadata`). Moot in S0/S1 — mutating ops are stubbed so `/tasks` returns `[]`. Fold into the read-resource path when **S2** lands the task envelope. |
| **Legacy MCP-tool convergence** | `xiNAS-MCP/src/tools/` | Existing MCP server keeps its own privileged calls in S0/S1. Convergence onto the api/agent split is **WS12** (per ADR-0001 'Migration scope'). |
| **Lift `xinas_api` / `xinas_agent` into `site.yml` + uninstall** | `docs/Installer/xinas-api-role-spec.md` §Out of scope | Both roles are opt-in for Phase 0; wiring into `playbooks/site.yml` and `xinas_uninstall` is deferred to when xinas-api becomes the primary control surface. |

## 2. Debt to pay down (P2-class; no behavior change)

| Item | Where | Notes |
|------|-------|-------|
| **Collector↔probe shape map** | `xiNAS-MCP/src/agent/convergence.ts` (8 documented adapters) | The 24-agent review recommended a single doc mapping `observed-shape ↔ public-schema field names` per kind. This is the breeding ground for the `export_path`-vs-`path` bug class (PR215 #5). Cheapest high-value debt item. |
| **`last_publish_error` + structured drop log** | `xiNAS-MCP/src/agent/publisher.ts` (`// omitted for test simplicity`) | Retry-exhaustion discards `lastStatus`. For a root daemon the drop-log is the operator's only window into silent batch loss. |
| **38 P2s** | the 24-agent review report | Minor/defensive items, catalogued. Triage before a hardening pass. |
| **Repo-wide warn-only CI backlog** | `python-lint`, `python-format`, `python-typecheck`, `yamllint`, `markdown` | Red across the WHOLE repo (incl. unrelated PRs), all non-blocking. A deliberate cleanup pass (with agreed formatter configs) would green every PR's CI. Not started — touches many files outside the agent stack. |

## 3. Confirmed leave-as-is (reviewed, intentional)

- **`ProtectSystem=strict`** on the agent unit — documented deviation, justified vs ADR-0002.
- **Heartbeat bootstrap-event suppression** (`#bootstrapped`) — the first `offline→live` transition is intentionally not broadcast.
- **`observed_at` required on non-agent-emitted kinds** (Share/NfsProfile/XiraidArray) — safe while inbound validation is type-only and the api stamps the field. Standing assumption; revisit only if validation tightens.
- **I6 Share↔ExportRule join is O(shares×rules)** — acceptable at S0/S1 cardinalities.

---

## 4. Candidate next work packages

- **WS12 — convergence:** wire the 8 on-demand RPC reads to collector snapshots; migrate `src/tools/` MCP calls onto the api/agent split; make xinas-api the primary control surface (lift into `site.yml` + uninstall).
- **S2 / WS4 — task envelope + plan/apply:** `task.begin` / `task.stage_report` / `task.cancel` / `task.list_inflight`; the mutating plan/apply path the stub methods reserve. Unblocks the `tasks` metadata fold-in.
- ~~**dbus collector:** wire the systemd dbus subscription so the node leaves the permanent `degraded` state.~~ **Resolved + dropped:** S7 T1b promoted the systemd collector to a `systemctl show` poll (node reads healthy), and the prototype dbus probe + `dbus-native` dependency were removed in the 2026-06 cleanup — sub-30 s unit-state latency is the only thing dbus would have added, not worth the dependency (ADR-0009 §Systemd).
- **Hardening / cleanup pass:** the warn-only CI backlog + P2 triage + the collector↔probe shape-map doc.

Pick by priority; each is spec-first (brainstorm → spec under the owning `docs/` area → TDD).
