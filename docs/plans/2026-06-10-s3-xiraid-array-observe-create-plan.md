# S3 xiRAID Array Adapter (observe + create) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make xiRAID arrays visible (real observe collector) and creatable (first real plan/apply provider + executor on the S2 task engine), per `docs/control-path/s3-xiraid-array-spec.md` and ADR-0006.

**Architecture:** api (unprivileged) gains the `xiraid.array.create` PlanProvider + `POST /arrays` route on the existing S2 engine; agent (root) gains a gRPC client adapter to the xiRAID daemon (TLS-TCP `localhost:6066`, sandbox widened via the unit file), a real `XiraidArray` collector, and the create executor. One shared `src/lib/xiraid/` module owns validation + translation (no api/agent duplication).

**Tech Stack:** TypeScript (`module:Node16`, `exactOptionalPropertyTypes`), Express 5, better-sqlite3 (S2 engine, unchanged), `@grpc/grpc-js` via the existing `src/grpc/` wrappers, vitest + supertest, biome.

**Conventions (S2 house rules):** `.js` ESM imports; conditional spread for optionals; inject `now()`/deps; no bare `Date.now()` in engine modules; HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never `git add -A`; per-task two-stage review. Unit = `npm test`; e2e = `npm run test:e2e`; contracts = `npm run test:contracts`. **Only T1 carries `Requires-Rebuild: xinas_agent`** (unit-file change); all other tasks are code/docs-only.

---

## Reuse-not-rebuild (read before starting)

- `xiNAS-MCP/src/api/plan/{engine.ts,providers/reference.ts}`, `src/api/tasks/engine.ts`, `src/api/routes/reference.ts` — the S2 plan/apply pipeline; the arrays provider/route copy these patterns. Do **not** touch the engine.
- `xiNAS-MCP/src/agent/task/{types.ts,registry.ts,runner.ts,reference-executor.ts}` — the executor surface; the create executor registers alongside the reference one.
- `xiNAS-MCP/src/grpc/{client.ts,raid.ts,responseParser.ts}` — existing typed xiRAID gRPC wrappers (`raidShow`/`raidCreate`/`raidDestroy`, `RaidCreateRequest`). Wrap, don't rewrite.
- `xiNAS-MCP/src/agent/convergence.ts` — collector construction (`DiskCollector` at ~:118; stub registration to replace at :314; fixture probe mode at :106).
- `xiNAS-MCP/src/agent/probe/disk.ts` — lsblk probe (`--json --output NAME,SIZE,TYPE,MODEL,SERIAL,TRAN,WWN`); T2 extends args + parser.
- ADR-0006 §Preflight blockers — the canonical blocker codes; §Per-operation contracts — stage names + enums.

## File structure (locked)

| File | Responsibility |
|------|----------------|
| `src/lib/xiraid/schema.ts` | `XiraidArraySpec` + `Tuning` types, `LEVELS`, level→constraints table (min drives, group/synd requirements). |
| `src/lib/xiraid/validate.ts` | `validateCreateSpec(spec, facts) → Blocker[]` — pure; facts passed in. |
| `src/lib/xiraid/translate.ts` | `toRaidCreateRequest(spec, deviceById)` — never emits `force`. |
| `src/lib/parse/raid.ts` | Pure `raid_show` JSON → `ObservedXiraidArray` mapping. |
| `src/lib/parse/disk.ts` (modify) | Enriched lsblk parse: `device_path`, `size_bytes`, `system_disk`, `mounted`, `safe_for_use`. |
| `src/agent/xiraid/client.ts` | `XiraidClient` over an injectable `XiraidTransport`; availability state. |
| `src/agent/xiraid/fake-transport.ts` | File-backed fake transport (fixture mode + e2e). |
| `src/agent/collectors/xiraid.ts` | Real `XiraidArrayCollector` (replaces stub). |
| `src/agent/task/xiraid-array-executor.ts` | `xiraid.array.create` executor (preflight/create/wait_online/verify + rollback). |
| `src/api/plan/providers/xiraid-array.ts` | Create PlanProvider (resolution + validation + `device_by_id` embedding). |
| `src/api/routes/arrays.ts` | `POST /arrays` plan/apply route. |
| Modified | `docs/control-path/api-v1.yaml`, `docs/control-path/xinas-agent-s0s1-spec.md`, `xinas-agent.service`, `src/agent/rpc/methods/stubs.ts` (+ test), `src/api/plan/providers/reference.ts` (+ tests), `src/api/app.ts`, `src/agent/convergence.ts`, `src/agent-server.ts`, contracts fixture dir. |

---

## Task T0: Contract revisions + stub supersession + enum normalization

**Files:** Modify `docs/control-path/api-v1.yaml`, `docs/control-path/xinas-agent-s0s1-spec.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts`, `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts`, `xiNAS-MCP/src/api/plan/providers/reference.ts` (+ any test asserting `rollback_model:'reversible'`). Create `xiNAS-MCP/src/__tests__/contracts/fixtures/XiraidArray.json`.

- [ ] **Step 1: Failing test — superseded methods are not stubs.** In `stubs.test.ts`, mirror the S2 `task.*` block:
```ts
describe('arrays mutation methods are not enumerated stubs (superseded by task envelope, S3)', () => {
  it.each(['arrays.create', 'arrays.delete', 'arrays.import', 'spare.set'])(
    '%s is NOT in STUB_METHODS (mutations dispatch via task.begin)',
    (m) => { expect(STUB_METHODS).not.toHaveProperty(m); },
  );
});
```
- [ ] **Step 2: Run — fails** (all four present). `cd xiNAS-MCP && npx vitest run src/__tests__/agent/rpc/methods/stubs.test.ts`
- [ ] **Step 3: Remove** `'arrays.create'`, `'arrays.delete'`, `'arrays.import'`, `'spare.set'` from `STUB_METHOD_NAMES` (`stubs.ts`) **and** from `REQUIRED_STUB_METHODS` (`stubs.test.ts`). **Keep `'arrays.list'`** in both. Run — passes.
- [ ] **Step 4: s0s1 spec supersession.** In `xinas-agent-s0s1-spec.md` §"Agent's RPC surface in S0+S1": split the `arrays.*` row — `arrays.list` stays Stub; add for the other four: *"`arrays.create`, `arrays.delete`, `arrays.import`, `spare.set` — **superseded by the task envelope (S3, ADR-0006)**: mutations dispatch via `task.begin` + the executor registry; these names left the enumerated RPC surface and now return `-32601` like any unknown method."*
- [ ] **Step 5: api-v1.yaml.** (a) `XiraidArray.spec`: add `raid7`/`raid70` to the `level` enum; add `spare_disk_ids` (exists), `group_size: {type:[integer,"null"]}`, `synd_cnt`, `block_size`, `force_metadata: {type:boolean}`, and the `tuning` object with the 21 nullable fields from ADR-0006 §Schema (init_prio, recon_prio, restripe_prio, resync_enabled, sched_enabled, merge_read_enabled, merge_write_enabled, merge_read_max, merge_read_wait, merge_write_max, merge_write_wait, memory_limit, request_limit, memory_prealloc, adaptive_merge, cpu_allowed, max_sectors_kb, sdc_prio, single_run, discard, drive_trim). (b) `status`: add `member_states: {type: array}`. (c) `Disk.status`: add `device_path`, `size_bytes`, `system_disk`, `mounted`, `safe_for_use`. (d) Wire `POST /arrays` (`createOrImportArray`) request body to `MutatingRequest` and document the create-shaped spec + `expected_revision: 0` convention in its description.
- [ ] **Step 6: Contract fixture.** `XiraidArray.json` = the ADR-0006 §Schema canonical example verbatim.
- [ ] **Step 7: Enum normalization.** In `reference.ts`, change `rollback_model: 'reversible'` → `'non_disruptive'`; update any test asserting `'reversible'` (`grep -rn "reversible" src/`).
- [ ] **Step 8: Validate.** `npm run test:contracts` + `npm test` — PASS. **Commit:** `feat(control-path): T0 — S3 contract revisions (XiraidArray full surface, POST /arrays, stub supersession, enum normalization)`

---

## Task T1: Agent unit — allow loopback TCP to the xiRAID daemon

**Files:** Modify `xiNAS-MCP/xinas-agent.service` (line ~94).

- [ ] **Step 1: Edit.**
```ini
RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6
IPAddressAllow=localhost
IPAddressDeny=any
```
- [ ] **Step 2: Sanity.** `grep -n "RestrictAddressFamilies\|IPAddress" xiNAS-MCP/xinas-agent.service` shows exactly the three lines above.
- [ ] **Step 3: Commit (with the rebuild trailer — the role must reinstall the unit):**
```bash
git add xiNAS-MCP/xinas-agent.service
git commit -m "$(cat <<'EOF'
feat(agent): T1 — allow loopback TCP in xinas-agent sandbox (xiRAID gRPC)

ADR-0006 §Agent sandbox prerequisite: the xiRAID daemon speaks TLS-TCP on
localhost:6066; AF_INET/AF_INET6 added, pinned to localhost via IPAddress*.

Requires-Rebuild: xinas_agent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task T2: Disk enrichment (parser + probe + collector passthrough)

**Files:** Modify `xiNAS-MCP/src/lib/parse/disk.ts`, `xiNAS-MCP/src/agent/probe/disk.ts` (lsblk args), `xiNAS-MCP/src/agent/collectors/disk.ts` (status passthrough). Test `xiNAS-MCP/src/__tests__/lib/parse/disk.test.ts` (extend).

- [ ] **Step 1: Failing tests.** Fixture: lsblk `--json --bytes` output with `MOUNTPOINTS`, a system disk (`nvme0n1` with children mounted at `/`, `/boot/efi`), a free data disk (`nvme1n1`, no children), and a mounted data disk (`nvme2n1`, child mounted at `/data`):
```ts
it('derives device_path, size_bytes, system_disk, mounted, safe_for_use', () => {
  const disks = parseLsblkOutput(FIXTURE);
  const sys = disks.find((d) => d.id === 'nvme0n1')!;
  expect(sys.status).toMatchObject({ device_path: '/dev/nvme0n1', system_disk: true, mounted: true, safe_for_use: false });
  expect(sys.status.size_bytes).toBeGreaterThan(0);
  const free = disks.find((d) => d.id === 'nvme1n1')!;
  expect(free.status).toMatchObject({ system_disk: false, mounted: false, safe_for_use: true });
  const data = disks.find((d) => d.id === 'nvme2n1')!;
  expect(data.status).toMatchObject({ system_disk: false, mounted: true, safe_for_use: false });
});
```
- [ ] **Step 2: Run — fails.** `npx vitest run src/__tests__/lib/parse/disk.test.ts`
- [ ] **Step 3: Implement.** `RawBlockDevice` gains `mountpoints?: (string | null)[]`, `size?: number | string`, recursive `children`. New status fields: `device_path: '/dev/' + name`; `size_bytes: Number(size)`; `system_disk` = any descendant `mountpoints` entry ∈ {`/`, `/boot`, `/boot/efi`}; `mounted` = any non-null descendant mountpoint (self included); `safe_for_use = !system_disk && !mounted`. `size_text` = binary-units formatter from `size_bytes` (`476.9G` style) to preserve the existing field. Probe args → `['--json', '--bytes', '--output', 'NAME,SIZE,TYPE,MODEL,SERIAL,TRAN,WWN,MOUNTPOINTS']`. Collector `DiskStatus` interface mirrors the new fields (passthrough — collector copies `status` as-is).
- [ ] **Step 4: Run — disk parse + collector + storage-route + query-contract tests all pass** (`npx vitest run src/__tests__/lib/parse/disk.test.ts src/__tests__/agent/collectors src/__tests__/api/routes-storage.test.ts src/__tests__/api/query-contracts.test.ts`). **Commit:** `feat(agent): T2 — disk enrichment (device_path/size_bytes/system_disk/mounted/safe_for_use)`

---

## Task T3: `lib/xiraid` schema + validate

**Files:** Create `xiNAS-MCP/src/lib/xiraid/schema.ts`, `xiNAS-MCP/src/lib/xiraid/validate.ts`. Test `xiNAS-MCP/src/__tests__/lib/xiraid/validate.test.ts`.

- [ ] **Step 1: Extract the real constraint constants.** `grep -n -i "minimum\|min_drives\|MIN_DEVICES" xiNAS-MCP/xiraid-analysis/api_behavior_doc.md` — use the doc's per-level minimum drive counts. Baseline table if the doc states nothing different: raid0:2, raid1:2, raid5:3, raid6:4, raid7:5, raid10:4, raid50:6, raid60:8, raid70:10, n+m: `synd_cnt + 1`. Adjust the table in `schema.ts` to the doc's values where they differ.
- [ ] **Step 2: Types (`schema.ts`).**
```ts
export const LEVELS = ['raid0','raid1','raid5','raid6','raid7','raid10','raid50','raid60','raid70','n+m'] as const;
export type Level = (typeof LEVELS)[number];
export interface Tuning { init_prio?: number|null; recon_prio?: number|null; restripe_prio?: number|null;
  resync_enabled?: boolean|null; sched_enabled?: boolean|null; merge_read_enabled?: boolean|null;
  merge_write_enabled?: boolean|null; merge_read_max?: number|null; merge_read_wait?: number|null;
  merge_write_max?: number|null; merge_write_wait?: number|null; memory_limit?: number|null;
  request_limit?: number|null; memory_prealloc?: number|null; adaptive_merge?: boolean|null;
  cpu_allowed?: string|null; max_sectors_kb?: number|null; sdc_prio?: number|null;
  single_run?: boolean|null; discard?: boolean|null; drive_trim?: boolean|null; }
export interface XiraidArraySpec { name: string; level: Level; member_disk_ids: string[];
  spare_disk_ids?: string[]; group_size?: number|null; synd_cnt?: number|null;
  strip_size_kib?: number|null; block_size?: number|null; force_metadata?: boolean; tuning?: Tuning; }
export interface LevelConstraints { minDrives: number; needsGroupSize: boolean; needsSyndCnt: boolean; }
export const LEVEL_CONSTRAINTS: Record<Level, LevelConstraints> = { /* table from Step 1; needsGroupSize for raid50/60/70; needsSyndCnt for n+m */ };
export const STRIP_SIZES_KIB = [16, 32, 64, 128, 256];
export const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
```
- [ ] **Step 3: Failing tests.** `validateCreateSpec(spec, facts)` with `facts = { disks: ResolvedDisk[], existingArrayNames: string[] }`, `ResolvedDisk = { id, device_path, safe_for_use, system_disk, mounted }`, returning `Blocker[] = { code, message }[]`. Table-driven cases asserting exactly the ADR-0006 codes: valid raid6/4-disk spec → `[]`; raid6/3 disks → `min_drives`; raid50 w/o `group_size` → `group_size_required`; raid50 group_size 7 with 6 members → `members_not_divisible_by_group` (and range cases → `group_size_range`); n+m w/o `synd_cnt` → `synd_cnt_required`; strip 48 → `strip_size_invalid`; block 1024 → `block_size_invalid`; `init_prio: 0` → `param_out_of_range`; bad name → `name_invalid`; name in `existingArrayNames` → `name_taken`; unknown disk id → `disk_not_found`; `safe_for_use:false` → `disk_not_safe`; `system_disk:true` → `disk_is_system`; disk id listed in facts as member of another array → `disk_in_use` (pass via `existingMemberDiskIds: Set<string>` in facts); `spare_disk_ids:['x']` → `spare_pool_deferred`.
- [ ] **Step 4: Run — fails. Implement `validate.ts`** as straight-line rule checks over the tables; one blocker per offending disk; `memory_limit` `0 | [1024,1048576]`; priorities `[1,100]`; timings ≥ 0.
- [ ] **Step 5: Run — passes.** **Commit:** `feat(lib): T3 — xiraid schema + create-spec validation (ADR-0006 blocker codes)`

---

## Task T4: `lib/xiraid` translate

**Files:** Create `xiNAS-MCP/src/lib/xiraid/translate.ts`. Test `xiNAS-MCP/src/__tests__/lib/xiraid/translate.test.ts`.

- [ ] **Step 1: Failing golden tests.**
```ts
it('maps a full-tuning spec to RaidCreateRequest', () => {
  const req = toRaidCreateRequest(FULL_SPEC, new Map([['d1','/dev/nvme1n1'],['d2','/dev/nvme2n1'],['d3','/dev/nvme3n1'],['d4','/dev/nvme4n1']]));
  expect(req).toEqual({ name: 'data', level: '6', drives: ['/dev/nvme1n1','/dev/nvme2n1','/dev/nvme3n1','/dev/nvme4n1'],
    strip_size: 64, block_size: 4096, force_metadata: true, init_prio: 50, sched_enabled: 1, adaptive_merge: 0,
    max_sectors_kb: 512, sdc_prio: 10, single_run: true, discard: 1, drive_trim: 0, memory_limit: 2048, cpu_allowed: '0-7' });
});
it('n+m carries synd_cnt; null tuning fields are omitted; force is never set', () => { /* level "n+m", synd_cnt 4; expect 'force' not in req for ANY input */ });
```
- [ ] **Step 2: Run — fails. Implement:** `level` strips the `raid` prefix (`raid6 → '6'`, `n+m` stays); `strip_size_kib → strip_size`; booleans → `0/1` for the uint fields (`resync_enabled`, `sched_enabled`, `merge_*_enabled`, `adaptive_merge`, `discard`, `drive_trim`) and stay boolean for `single_run`/`force_metadata` (match `RaidCreateRequest` in `src/grpc/raid.ts`); `null`/`undefined` tuning omitted via conditional spread; throw if a `member_disk_id` is missing from `deviceById` (provider guarantees it). Type the return as `RaidCreateRequest` imported from `../../grpc/raid.js` so drift fails compilation.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(lib): T4 — xiraid spec→RaidCreateRequest translation (no force passthrough)`

---

## Task T5: Agent gRPC client adapter (injectable transport)

**Files:** Create `xiNAS-MCP/src/agent/xiraid/client.ts`, `xiNAS-MCP/src/agent/xiraid/fake-transport.ts`. Test `xiNAS-MCP/src/__tests__/agent/xiraid/client.test.ts`.

- [ ] **Step 1: Interface + failing tests.**
```ts
export interface XiraidTransport {
  raidShow(): Promise<unknown>;          // parsed raid_show payload (array)
  raidCreate(req: RaidCreateRequest): Promise<void>;
  raidDestroy(req: { name: string; force?: boolean }): Promise<void>;
}
export type XiraidAvailability = 'unknown' | 'available' | 'unavailable';
export class XiraidClient { constructor(transport: XiraidTransport) {...}
  availability(): XiraidAvailability; lastError(): string | undefined;
  raidShow(): Promise<unknown>; raidCreate(...): Promise<void>; raidDestroy(...): Promise<void>; }
```
Tests: a fake transport that succeeds → `availability() === 'available'` after a call; one that rejects (`ECONNREFUSED`) → `'unavailable'` + `lastError()` set + the error rethrown; recovery flips back to `'available'`.
- [ ] **Step 2: Run — fails. Implement** `client.ts`: thin wrapper, every call try/catch → update availability + rethrow. Add `createGrpcTransport(): XiraidTransport` that lazily `getClient()`s from `../../grpc/client.js` and delegates to `raidShow`/`raidCreate`/`raidDestroy` in `../../grpc/raid.js` (TLS + `/etc/xraid/net.conf` come along for free).
- [ ] **Step 3: `fake-transport.ts`** (used by fixture mode + e2e, like `probe/fixture.ts`): file-backed state at `<dir>/xiraid-state.json` (`{ "arrays": [...] }`); `raidShow` returns the array; `raidCreate` appends `{ name, level, devices: req.drives, strip_size, state: ['online'] }` — but **rejects** when `req.name` ends with `-fail` (deterministic failure-path hook); `raidDestroy` removes by name. Unit-test create/show/destroy round-trip + the `-fail` hook.
- [ ] **Step 4: Run — passes.** **Commit:** `feat(agent): T5 — xiraid client adapter (injectable transport, availability) + fake transport`

---

## Task T6: `parse/raid` + real observe collector

**Files:** Create `xiNAS-MCP/src/lib/parse/raid.ts`, `xiNAS-MCP/src/agent/collectors/xiraid.ts`. Modify `xiNAS-MCP/src/agent/convergence.ts` (replace stub registration :314; construct the shared `XiraidClient` honoring fixture mode :106). Tests `xiNAS-MCP/src/__tests__/lib/parse/raid.test.ts`, `xiNAS-MCP/src/__tests__/agent/collectors/xiraid.test.ts`.

- [ ] **Step 1: Pin the raid_show shape.** Read `proto/xraid/gRPC/protobuf/message_raid.proto` (`RaidShow`/response) + `xiraid-analysis/api_behavior_doc.md` §raid_show and write the test fixture with the **actual** field names found there (expect per-array: `name`, `level`, `state`/`states`, `devices[]`, `strip_size`, `block_size`, `group_size`, `sparepool`, `size`, init/recon progress). Adjust the mapping table below to the confirmed names before writing code.
- [ ] **Step 2: Failing parser tests.** `parseRaidShow(payload, diskIdByPath: Map<string,string>) → ObservedXiraidArray[]` where `ObservedXiraidArray = { kind:'XiraidArray', id, spec: { name, level, member_disk_ids, spare_disk_ids, strip_size_kib?, block_size?, group_size? }, status: { state, volume_path, chunk_size_kib?, rebuild_progress_pct, check_progress_pct, usable_capacity_bytes, member_states } }`. Cases: online array → `state:'optimal'`, `volume_path:'/dev/xi_data'`, devices mapped to disk ids (unknown path → the raw path as fallback id); degraded states → `'degraded'`; init/recon in progress → `'rebuilding'` + progress pct; unrecognized → `'unknown'`; level `"6"` → `'raid6'` (inverse of T4's mapping).
- [ ] **Step 3: Run — fails. Implement** the pure mapping.
- [ ] **Step 4: Failing collector tests.** `XiraidArrayCollector` (model on `DiskCollector`'s `Collector<'XiraidArray'>` contract — read `collectors/base.ts` for the poll hook): deps `{ client: XiraidClient, diskSnapshot: () => Promise<ObservedDisk[]> }` (reuse the **same disk probe instance** convergence already builds, for path→id mapping). `initialSweep()` → `raidShow` + `parseRaidShow` → one upsert delta per array; client throwing → collector `health` = `{ state: 'error', reason: 'XIRAID_DAEMON_UNAVAILABLE' }` and the error propagates (degraded node, systemd-collector precedent); poll re-sweep emits upserts + deletes for vanished arrays.
- [ ] **Step 5: Run — fails. Implement** the collector; in `convergence.ts` build `const xiraidClient = new XiraidClient(probeMode.kind === 'fixture' ? createFakeXiraidTransport(probeMode.dir) : createGrpcTransport())`, register `new XiraidArrayCollector({...})` replacing the stub at :314, and **export the client** in the convergence result so `agent-server.ts` can hand it to the executor (T9). Delete `XiraidArrayStubCollector` from `collectors/stubs.ts` + its test expectations.
- [ ] **Step 6: Run — full unit suite passes** (`npm test`). **Commit:** `feat(agent): T6 — real XiraidArray collector over raid_show (replaces stub; daemon-down → degraded)`

---

## Task T7: Create plan provider (api)

**Files:** Create `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts`. Modify the plan-engine wiring where `referencePlanProvider` is registered (`grep -rn "referencePlanProvider" src/api/ --include="*.ts" | grep -v __tests__` — register the new provider alongside). Test `xiNAS-MCP/src/__tests__/api/plan/xiraid-array-provider.test.ts`.

- [ ] **Step 1: Failing tests.** Seed a KV (the `buildTestApp` harness pattern from the reference-provider tests) with observed `Disk`s (safe + system + mounted) and one observed `XiraidArray` (`taken`). Cases:
  - Valid spec → `blockers: []`; `affected_resources[0] === { kind:'XiraidArray', id:'data' }` followed by one `{ kind:'Disk', id }` per member; `risk_level:'non_disruptive'`; `rollback_model:'non_disruptive'`; **no** `state_revision_expected` key; `diff.raid_create_request` equals the T4 translation; the **returned plan spec carries `device_by_id`** (`{ d1:'/dev/nvme1n1', … }`).
  - `name:'taken'` → blocker `name_taken`; member = system disk → `disk_is_system`; member unknown → `disk_not_found`; member already in the observed array's `member_disk_ids` → `disk_in_use`; `spare_disk_ids` non-empty → `spare_pool_deferred`.
- [ ] **Step 2: Run — fails. Implement** `xiraidArrayCreateProvider: PlanProvider` (`operation_kind: 'xiraid.array.create'`): list observed Disks + XiraidArrays from the KV (mirror `routes/storage.ts`'s prefix-unwrap pattern, prefixes `/xinas/v1/observed/Disk/` + `/xinas/v1/observed/XiraidArray/`); build `facts` (`ResolvedDisk[]`, `existingArrayNames`, `existingMemberDiskIds`); run `validateCreateSpec`; resolve `device_by_id`; return the `PlanResult` with the enriched spec embedded (the provider returns the spec object that the engine persists — confirm against `PlanEngine.plan`'s handling of `spec` and embed `device_by_id` into it before hashing, so plan_hash covers the resolution).
- [ ] **Step 3: Run — passes.** Register the provider in the same place the reference provider is registered. **Commit:** `feat(api): T7 — xiraid.array.create plan provider (resolution + ADR-0006 blockers + device_by_id)`

---

## Task T8: `POST /arrays` route (plan/apply)

**Files:** Create `xiNAS-MCP/src/api/routes/arrays.ts`. Modify `xiNAS-MCP/src/api/app.ts` (mount before the `/arrays` mutating stubs at :84-90; remove only the **POST** stub entry — PATCH/DELETE keep `handlers/unsupported.ts`). Test `xiNAS-MCP/src/__tests__/api/routes-arrays.test.ts`.

- [ ] **Step 1: Failing tests** (the `routes-reference.test.ts` harness with mock agent):
  - `POST /api/v1/arrays {mode:'plan', spec}` → 200, `result.plan_id` + `plan_hash` + `risk_level:'non_disruptive'` + `blockers:[]`.
  - Plan with blockers (system disk) → 200 with the blockers listed; a follow-up apply of that plan → `PRECONDITION_FAILED`.
  - `{mode:'apply', plan_id, expected_revision: 0, idempotency_key}` with accepting mock agent → **202**, task `running`, leases held on the array + member disks; the forwarded `task.begin` spec contains `device_by_id`.
  - `expected_revision: 3` → `PRECONDITION_FAILED` (`details.reason:'create_expects_revision_zero'`); missing `expected_revision` → `INVALID_ARGUMENT`.
  - Duplicate `idempotency_key` + same plan → 202 same `task_id`, no second `task.begin`; agent down → 503 + task `failed (FAILED_BEFORE_CHANGE)` + leases released.
  - `PATCH /api/v1/arrays/x` still returns the unsupported-stub envelope (untouched).
- [ ] **Step 2: Run — fails. Implement** `arraysRouter(ctx)` mirroring `routes/reference.ts`: `mode:'plan'` → `planEngine.plan({ operation_kind:'xiraid.array.create', spec, … })`; `mode:'apply'` → require `plan_id`/`idempotency_key`, require integer `expected_revision`, reject ≠ 0; refuse apply when the stored plan has blockers (`PRECONDITION_FAILED`, blockers in details); then `taskEngine.apply` → `taskEngine.dispatch` with the **persisted plan spec** (which carries `device_by_id`). Mount in `app.ts` before the stub block; drop the POST stub entry.
- [ ] **Step 3: Run — route + mutating-stub suites pass** (`npx vitest run src/__tests__/api/routes-arrays.test.ts src/__tests__/api/mutating.test.ts`). **Commit:** `feat(api): T8 — POST /arrays plan/apply route (full ApplyRequest, expected_revision=0)`

---

## Task T9: Create executor (agent)

**Files:** Create `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts`. Modify `xiNAS-MCP/src/agent-server.ts` (~:85 — pass the convergence-built `XiraidClient` into the task subsystem and register the executor). Test `xiNAS-MCP/src/__tests__/agent/task/xiraid-array-executor.test.ts`.

- [ ] **Step 1: Failing tests** (fake transport from T5; drive via `TaskRunner.run` like the reference-executor tests):
  - Success: spec `{ name:'data', level:'raid6', member_disk_ids:[…], device_by_id:{…} }` → stages `preflight`/`create`/`wait_online`/`verify` all succeed; fake state contains the array; event sequence ends `terminal{success}`.
  - `preflight` failure: a `device_by_id` path already a member in fake state → `stage_failed` at `preflight`, rollback runs as **no-op** (array absent → no destroy call), terminal `failed (FAILED_PARTIAL_ROLLED_BACK)`.
  - `create` failure (name `roll-fail` triggers the T5 hook) → rollback: `raidShow` shows no array → no destroy; name present (simulate partial create by pre-seeding) → `raidDestroy` called; terminal `failed`.
  - Daemon unavailable (transport rejects) at `create` → stage fails, rollback attempts `raidShow`, also rejects → `rollback_failed` → terminal `requires_manual_recovery`.
  - `wait_online`: fake state `state:['initializing']` flips to `['online']` after N polls (inject `pollIntervalMs: 1`, `timeoutMs: 50`) → succeeds; never flips → times out → stage fails → rollback destroys.
- [ ] **Step 2: Run — fails. Implement** `makeXiraidArrayCreateExecutor({ client, now, pollIntervalMs = 2000, timeoutMs = 120_000 }): Executor` — **stateless across runs**: rollback decides by live `raidShow` (name present → `raidDestroy({ name, force: true })`, absent → no-op), so it is also crash-safe. Stages narrow `ctx.spec` to `{ … , device_by_id: Record<string,string> }`; `verify` checks the array appears in `raidShow` with `volume_path` derivable (`/dev/xi_<name>` — fake transport state implies it; do not stat the device node in unit tests, keep the device check inside `wait_online`'s state predicate). Register in `agent-server.ts`'s executor registry next to the reference executor.
- [ ] **Step 3: Run — passes** (+ `npm test`). **Commit:** `feat(agent): T9 — xiraid.array.create executor (preflight/create/wait_online/verify, raidShow-driven rollback)`

---

## Task T10: e2e + full verification gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/xiraid-array-create.test.ts` (model on `e2e/task-engine-roundtrip.test.ts`: real api + agent, `XINAS_AGENT_PROBE_MODE=fixture:<dir>`, the fake python3 shim on PATH, **plus** seeding `<dir>/xiraid-state.json` and fixture disks that satisfy preflight).

- [ ] **Step 1: Success path.** Seed fixture disks (≥4 safe data disks) + empty xiraid state. `POST /arrays mode=plan` (raid6, 4 members) → 0 blockers → `mode=apply` (`expected_revision:0`) → 202 → poll `/tasks/{id}` to `success` → `snapshot_before/after` set → `GET /api/v1/arrays` shows `data` with `status.state:'optimal'` after the collector's next sweep (poll with timeout).
- [ ] **Step 2: Failure→rollback.** Plan+apply with `name:'roll-fail'` → terminal `failed (FAILED_PARTIAL_ROLLED_BACK)`; a `rollback` stage row exists; `GET /arrays` does **not** list it.
- [ ] **Step 3: Blocked plan.** Plan with a member that is the fixture system disk → blocker `disk_is_system`; apply of that plan → 412.
- [ ] **Step 4: Run the gate.** `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` — all green.
- [ ] **Step 5: Commit:** `test(e2e): T10 — xiraid array create round-trip (success, rollback, blocked plan)`

---

## Self-review notes

- **Spec coverage:** spec §1 sandbox→T1, §1/§4 disk enrichment→T2, §3→T3/T4, §5 observe→T6, §6 plan/apply→T7/T8, §7 executor→T9, §8 client/fixture→T5, §10 contracts→T0, §11/§12 tests/gate→per-task + T10. Deferred-route behavior (§1) asserted in T8.
- **Determinism:** executor takes injected `now`/poll/timeouts; fake transport failure hook is name-based (no randomness); provider is pure over KV state.
- **Type consistency:** `Blocker`/`ResolvedDisk`/`facts` defined in T3, consumed in T7; `XiraidTransport`/`XiraidClient` defined in T5, consumed in T6/T9; `device_by_id` embedded in T7's spec, consumed in T8 assertion + T9 executor; `RaidCreateRequest` imported from `src/grpc/raid.ts` in T4.
- **Two confirm-first steps** (T3 Step 1 constants, T6 Step 1 raid_show shape) pin real-world values before code — the S2 plan's `Manifest.to_dict()` pattern.
- **Only T1 carries `Requires-Rebuild`.** Everything else is code/docs.
- **Rollout:** stacked operator-gated draft PRs; never merge without approval.
