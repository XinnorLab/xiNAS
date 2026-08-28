# Array Spare Pool By Name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An array references an **existing** spare pool by name; the array
executors never create, fill, empty or delete a pool.

**Architecture:** The write field `spec.spare_disk_ids` (Disk ids, from which
the executor derived and provisioned a pool named `xnsp_<array>`) is replaced
by `spec.spare_pool` (the name of a pool the operator already created through
the Spare Pools surface). `spare_disk_ids` survives as an observed-only join
and is rejected on write. The only pool-state change the array path still makes
is `pool_activate` on an inactive target pool — an inactive pool never arms
auto-replace — and its rollback deactivates it again.

**Tech Stack:** TypeScript (Node ≥ 20, vitest, biome) under `xiNAS-MCP/`;
Python 3 (pytest, ruff, pyright) under `xinas_menu/`; OpenAPI 3.1 linted by
Spectral and diffed by oasdiff.

**Spec:** [docs/superpowers/specs/2026-08-29-array-spare-pool-by-name-design.md](../specs/2026-08-29-array-spare-pool-by-name-design.md)

## Global Constraints

- **Branch:** `fix/array-spare-pool-by-name`. Never commit to `main`.
- **Every commit touching `xiNAS-MCP/src/` carries the trailer
  `Requires-Rebuild: xinas_node_build`** on a bare, column-0 line.
  `dist/` is not tracked; without the trailer the change never reaches a host.
- Conventional Commits: `type(scope): subject`.
- All repository artifacts in English.
- **Spec-first (CLAUDE.md):** Task 1 lands the document changes before any
  code task starts.
- TypeScript gate, run from `xiNAS-MCP/`:
  `npm run typecheck && npm run lint && npm run format:check` and
  `npm test && npm run test:contracts`.
- Python gate, run from the repo root:
  `pytest --cov=xinas_history --cov-fail-under=20`,
  `ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper`,
  `ruff format --check .`,
  `pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper` (venv active).
- Doc gate: `npx --yes markdownlint-cli2 'docs/**/*.md'` and
  `npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml`.
- **`spec.spare_disk_ids` is never removed from `XiraidArray.spec` in
  `api-v1.yaml`** — one schema serves observed rows and write bodies; deleting
  it breaks observed state and trips oasdiff.
- New blocker codes, exact strings: `spare_pool_not_found`, `spare_pool_empty`.
- Detach sentinel is unchanged: `SPAREPOOL_DETACH = 'null'`, produced by
  `toRaidModifyRequest(name, { sparepool: '' })`.

---

### Task 1: Specs and the OpenAPI contract

Spec-first: the behavior contract changes before the code does.

**Files:**
- Modify: `docs/control-path/api-v1.yaml:623-627` (`spec.spare_disk_ids`)
- Modify: `docs/control-path/adr/0006-xiraid-array.md` (§Spare pools, §Rejected alternatives)
- Modify: `docs/control-path/s4-xiraid-array-mutations-spec.md:163` (`apply_spares` row) and its §Scope bullet excluding shared pools
- Modify: `docs/control-path/s3-xiraid-array-spec.md` (create-path spare handling)
- Modify: `docs/control-path/s9-bridge-pools-spec.md` (pools own pool lifecycle)
- Modify: `docs/Storage/raid-management-spec.md` (§4 spare step, §5.2, §7.3 name-length rationale)

**Interfaces:**
- Consumes: nothing.
- Produces: the field name `spec.spare_pool`, the blocker codes
  `spare_pool_not_found` / `spare_pool_empty`, and the 422 reason
  `observed_only` — every later task quotes these verbatim.

- [ ] **Step 1: Add `spare_pool` to the array spec schema**

In `docs/control-path/api-v1.yaml`, inside `XiraidArray.spec.properties`,
immediately after the `spare_disk_ids` block:

```yaml
            spare_pool:
              type: [string, "null"]
              description: >-
                Name of an EXISTING spare pool (POST /api/v1/pools). Writable on
                create and modify; null on PATCH detaches the pool without
                deleting it. The control path never creates a pool from an array
                request — an inactive target pool is activated on attach and
                deactivated again if the operation rolls back. Mirrors
                status.spare_pool in observed rows.
```

- [ ] **Step 2: Demote `spare_disk_ids` to observed-only**

Replace its `description` in the same file with:

```yaml
              description: >-
                OBSERVED ONLY. The spare pool's member drives joined to control-path
                Disk ids (raid_show sparepool -> pool_show drives). Rejected on POST
                and PATCH: create the pool via POST /api/v1/pools, then send
                spec.spare_pool with its name.
```

- [ ] **Step 3: Run the OpenAPI gate**

```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

Expected: no errors. (oasdiff runs on the PR; the change is additive plus
description edits, so it must report no breaking change.)

- [ ] **Step 4: Rewrite ADR-0006 §Spare pools**

Replace the attach/membership/detach bullets (the `xnsp_<array>` lifecycle)
with the reference model:

```markdown
- Attach (`spare_pool` -> a pool name): `pool_activate` when the named pool is
  inactive (xiRAID arms auto-replace only for activated pools — analyst doc
  §3.8), then `raid_modify { sparepool: "<name>" }`. Rollback restores the
  previous sparepool name and deactivates the pool only if this run activated
  it.
- Detach (`spare_pool: null`): `raid_modify { sparepool: "null" }` — the
  detach sentinel. The pool is left in place and active; it may be referenced
  by other arrays.
- The control path NEVER creates, fills, empties or deletes a pool from an
  array request. Pool lifecycle belongs to the pool surface (ADR-0011 /
  S9): POST/PATCH/DELETE /api/v1/pools.
- Day-1 Ansible pools are ordinary pools and are attachable like any other.
  The `xnsp_<array>` derived name and the foreign-pool guard are retired.
```

Add to §Rejected alternatives:

```markdown
- **Executor-owned `xnsp_<array>` pools (the S4 model, retired 2026-08-29).**
  It made every operator-created pool unattachable: the TUI resolved the chosen
  pool to its drives, and the executor then tried to build `xnsp_<array>` from
  drives the daemon already accounted to that pool, failing with
  `13 INTERNAL: Drive '/dev/nvme5n2' is already a part of the 'sp01' spare
  pool`. Two owners for one pool lifecycle is the defect; S9 already made the
  pool surface the owner.
```

- [ ] **Step 5: Update the S4 `apply_spares` contract row**

Replace the `apply_spares` row of the stage table with:

```markdown
| `apply_spares` | Only when `spare_pool` is present. Attach: `pool_activate <name>` (skipped when already active) -> `raid_modify { sparepool: <name> }`. Detach (`null`): `raid_modify { sparepool: 'null' }` (the detach sentinel — *not* the empty string); the pool is left alone. No `pool_create` / `pool_add` / `pool_remove` / `pool_delete` / `pool_deactivate` ever runs here. Preflight fails when the named pool is absent or empty. |
```

In the same file, the scope bullet excluding "shared pools across arrays (one
`xnsp_<array>` pool per array)" is deleted — shared pools are now supported.

- [ ] **Step 6: Update s3, s9 and the TUI spec**

- `s3-xiraid-array-spec.md`: the create path takes `spare_pool` (a name) and
  performs no `pool_create`.
- `s9-bridge-pools-spec.md`: state that pool lifecycle has exactly one owner
  (the pool surface); arrays only reference pools by name, and an array attach
  leases `Pool/<name>`.
- `docs/Storage/raid-management-spec.md`:
  - §4 "Step — spare pool": the step is unconditional; options are `(none)` +
    pool names; with no pools the operator sees `(none)` and a hint pointing at
    Storage → Spare Pools; a missing pool never blocks array creation.
  - §5.2: the chosen pool name goes straight into `spec.spare_pool`; the
    `GET /api/v1/disks` join is gone; with no pools the operator gets a modal
    telling them to create one.
  - §7.3: rewrite the `POOL_NAME_MAX_LEN` rationale — the `xnsp_<array>`
    derived name no longer exists, so the 64-char bound stands as a deliberate
    xiNAS choice in the absence of a vendor-documented limit, not as a
    consequence of `len("xnsp_") + 28`.

- [ ] **Step 7: Run the docs gate**

```bash
npx --yes markdownlint-cli2 'docs/**/*.md'
```

Expected: 0 issues.

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "docs(control-path): arrays reference an existing spare pool by name

Retires the executor-owned xnsp_<array> pool: spec.spare_pool names an
existing pool, spec.spare_disk_ids becomes observed-only."
```

---

### Task 2: Schema, observed parse, and translation

**Files:**
- Modify: `xiNAS-MCP/src/lib/xiraid/schema.ts:53-64` (`XiraidArraySpec`)
- Modify: `xiNAS-MCP/src/lib/parse/raid.ts:238-247` (observed spec assembly)
- Modify: `xiNAS-MCP/src/lib/xiraid/translate.ts:40-43` (`toRaidCreateRequest`)
- Test: `xiNAS-MCP/src/__tests__/lib/parse/raid.test.ts`
- Test: `xiNAS-MCP/src/__tests__/lib/xiraid/translate.test.ts`

**Interfaces:**
- Consumes: the field name from Task 1.
- Produces: `XiraidArraySpec.spare_pool?: string | null`;
  `toRaidCreateRequest` emits `sparepool` from `spec.spare_pool`;
  observed rows carry `spec.spare_pool`. Tasks 3-5 rely on all three.

- [ ] **Step 1: Write the failing tests**

In `xiNAS-MCP/src/__tests__/lib/xiraid/translate.test.ts`:

```ts
it('passes spec.spare_pool through as the create sparepool', () => {
  const req = toRaidCreateRequest(
    {
      name: 'data',
      level: 'raid5',
      member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
      spare_pool: 'sp01',
    },
    new Map([
      ['d1', '/dev/nvme1n1'],
      ['d2', '/dev/nvme2n1'],
      ['d3', '/dev/nvme3n1'],
      ['d4', '/dev/nvme4n1'],
    ]),
  );
  expect(req.sparepool).toBe('sp01');
});

it('omits sparepool when no spare pool is named', () => {
  const req = toRaidCreateRequest(
    { name: 'data', level: 'raid5', member_disk_ids: ['d1'] },
    new Map([['d1', '/dev/nvme1n1']]),
  );
  expect(req.sparepool).toBeUndefined();
});
```

In `xiNAS-MCP/src/__tests__/lib/parse/raid.test.ts`:

```ts
it('reports the array sparepool name in spec.spare_pool', () => {
  const rows = parseRaidShow(
    { data: { name: 'data', level: '5', devices: [], sparepool: 'sp01' } },
    new Map(),
    [{ name: 'sp01', drives: ['/dev/nvme5n2'], active: true }],
  );
  expect(rows[0].spec.spare_pool).toBe('sp01');
  expect(rows[0].status.spare_pool).toBe('sp01');
});

it('omits spec.spare_pool when the array has no pool', () => {
  const rows = parseRaidShow(
    { data: { name: 'data', level: '5', devices: [], sparepool: '-' } },
    new Map(),
    [],
  );
  expect(rows[0].spec.spare_pool).toBeUndefined();
});
```

Match the existing `parseRaidShow` call signature used elsewhere in that file
(payload, `diskIdByPath`, pools) rather than the shape above if they differ.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/xiraid/translate.test.ts src/__tests__/lib/parse/raid.test.ts
```

Expected: FAIL — `spare_pool` is not a property of `XiraidArraySpec`
(typecheck) and `req.sparepool` is `undefined`.

- [ ] **Step 3: Add the field to the schema**

In `xiNAS-MCP/src/lib/xiraid/schema.ts`, inside `XiraidArraySpec`, replace the
`spare_disk_ids` line with:

```ts
  /** OBSERVED ONLY — the spare pool's drives as Disk ids. Rejected on write. */
  spare_disk_ids?: string[];
  /** Name of an EXISTING spare pool; null on modify detaches. */
  spare_pool?: string | null;
```

- [ ] **Step 4: Emit `spec.spare_pool` from the collector parse**

In `xiNAS-MCP/src/lib/parse/raid.ts`, in the `spec` object literal, after the
`spare_disk_ids` line:

```ts
        ...(sparepool !== '' ? { spare_pool: sparepool } : {}),
```

- [ ] **Step 5: Translate from the pool name**

In `xiNAS-MCP/src/lib/xiraid/translate.ts`, replace the `sparepool` spread and
its comment with:

```ts
    // The pool is the operator's, created through the pool surface; the array
    // path only references it by name (design 2026-08-29).
    ...(spec.spare_pool ? { sparepool: spec.spare_pool } : {}),
```

Then delete the now-unused `derivedPoolName` import from this file.

- [ ] **Step 6: Run the tests**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/xiraid/translate.test.ts src/__tests__/lib/parse/raid.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/lib xiNAS-MCP/src/__tests__/lib
git commit -m "feat(xiraid): carry the spare pool by name in the array spec

Requires-Rebuild: xinas_node_build"
```

---

### Task 3: Spec parsing and plan validation

**Files:**
- Modify: `xiNAS-MCP/src/lib/xiraid/validate.ts` — `CreateFacts` (:50-59),
  `parseCreateSpec` (:67-88), `validateCreateSpec` spares block (:173-180),
  `XiraidArrayModifySpec` (:189-192), `ModifyFacts` (:194-203),
  `parseModifySpec` (:211-231), `validateModifySpec` (:234-250),
  `checkDerivedPoolName` (:352-360)
- Test: `xiNAS-MCP/src/__tests__/lib/xiraid/validate.test.ts`

**Interfaces:**
- Consumes: `XiraidArraySpec.spare_pool` (Task 2).
- Produces:
  - `interface PoolFacts { drives: string[]; active: boolean }` (exported)
  - `CreateFacts.poolsByName: Map<string, PoolFacts>`
  - `ModifyFacts { poolsByName: Map<string, PoolFacts> }` — `arrayName`,
    `disks`, `existingMemberDiskIds` and `ownSpareDiskIds` are removed
  - `XiraidArrayModifySpec { spare_pool?: string | null; tuning?: Tuning }`
  - blockers `spare_pool_not_found`, `spare_pool_empty`

  Task 5 constructs both fact objects.

- [ ] **Step 1: Write the failing tests**

```ts
describe('spare pool references', () => {
  const facts = (pools: Record<string, { drives: string[]; active: boolean }>) => ({
    poolsByName: new Map(Object.entries(pools)),
  });

  it('rejects spare_disk_ids on create as observed-only', () => {
    expect(() =>
      parseCreateSpec({
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1'],
        spare_disk_ids: ['d5'],
      }),
    ).toThrow(/observed-only/);
  });

  it('blocks a create naming a pool that does not exist', () => {
    const blockers = validateCreateSpec(
      { name: 'data', level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3', 'd4'], spare_pool: 'sp01' },
      { disks: [], existingArrayNames: [], existingMemberDiskIds: new Set(), ...facts({}) },
    );
    expect(blockers.map((b) => b.code)).toContain('spare_pool_not_found');
  });

  it('blocks a create naming an empty pool', () => {
    const blockers = validateCreateSpec(
      { name: 'data', level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3', 'd4'], spare_pool: 'sp01' },
      {
        disks: [],
        existingArrayNames: [],
        existingMemberDiskIds: new Set(),
        ...facts({ sp01: { drives: [], active: true } }),
      },
    );
    expect(blockers.map((b) => b.code)).toContain('spare_pool_empty');
  });

  it('accepts a modify naming a populated pool', () => {
    const blockers = validateModifySpec(
      { spare_pool: 'sp01' },
      facts({ sp01: { drives: ['/dev/nvme5n2'], active: false } }),
    );
    expect(blockers).toEqual([]);
  });

  it('accepts a detach with no pool blockers', () => {
    expect(validateModifySpec({ spare_pool: null }, facts({}))).toEqual([]);
  });

  it('distinguishes an absent spare_pool from an explicit null', () => {
    expect(parseModifySpec({ tuning: {} }).spare_pool).toBeUndefined();
    expect(parseModifySpec({ spare_pool: null }).spare_pool).toBeNull();
  });
});
```

Delete the existing tests that assert `spare_disk_ids` validation and
`checkDerivedPoolName` behavior in this file.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/xiraid/validate.test.ts
```

Expected: FAIL — `parseCreateSpec` accepts `spare_disk_ids`, and `poolsByName`
is not part of the fact types.

- [ ] **Step 3: Change the fact types and the parsers**

```ts
/** One observed pool, as the array validators need it. */
export interface PoolFacts {
  drives: string[];
  active: boolean;
}
```

Add `poolsByName: Map<string, PoolFacts>;` to `CreateFacts`.

Replace `ModifyFacts` entirely with:

```ts
export interface ModifyFacts {
  /** Observed pools by name — an array may only reference one that exists. */
  poolsByName: Map<string, PoolFacts>;
}
```

In `parseCreateSpec`, replace the `spare_disk_ids` type check with:

```ts
  if (o.spare_disk_ids !== undefined) {
    throw new TypeError(
      'spec.spare_disk_ids is observed-only; create the pool via POST /api/v1/pools and send spec.spare_pool with its name',
    );
  }
  if (o.spare_pool !== undefined && o.spare_pool !== null && typeof o.spare_pool !== 'string') {
    throw new TypeError('spec.spare_pool must be a pool name string or null');
  }
```

In `parseModifySpec`, replace the `spare_disk_ids` check and the returned
object with:

```ts
  const hasSparePool = 'spare_pool' in o && o.spare_pool !== undefined;
  if (hasSparePool && o.spare_pool !== null && typeof o.spare_pool !== 'string') {
    throw new TypeError('spec.spare_pool must be a pool name string or null');
  }
  if (o.tuning !== undefined && (typeof o.tuning !== 'object' || o.tuning === null)) {
    throw new TypeError('spec.tuning must be an object');
  }
  return {
    ...(hasSparePool ? { spare_pool: o.spare_pool as string | null } : {}),
    ...(o.tuning !== undefined ? { tuning: o.tuning as Tuning } : {}),
  };
```

`parseModifySpec` stays tolerant of a stray `spare_disk_ids` key — the PATCH
route rejects it against the raw body (Task 5), and this parser must keep
accepting the api's own enriched spec at apply time.

Update `XiraidArrayModifySpec` to `{ spare_pool?: string | null; tuning?: Tuning }`.

- [ ] **Step 4: Replace both validators' spare blocks**

Add a shared helper next to the other rule helpers:

```ts
/** An array may only reference a pool that exists and has drives. */
function checkSparePool(
  name: string | null | undefined,
  poolsByName: Map<string, PoolFacts>,
  push: Push,
): void {
  if (name === undefined || name === null || name === '') return;
  const pool = poolsByName.get(name);
  if (pool === undefined) {
    push(
      'spare_pool_not_found',
      `spare pool '${name}' does not exist — create it via POST /api/v1/pools (TUI: Storage > Spare Pools) first`,
    );
  } else if (pool.drives.length === 0) {
    push('spare_pool_empty', `spare pool '${name}' has no drives`);
  }
}
```

In `validateCreateSpec`, replace the whole `--- spares ---` block with:

```ts
  checkSparePool(spec.spare_pool, facts.poolsByName, push);
```

In `validateModifySpec`, replace its `spare_disk_ids` block with:

```ts
  checkSparePool(spec.spare_pool, facts.poolsByName, push);
```

Delete `checkDerivedPoolName`. Keep `derivedPoolName` for now — Task 4 removes
its last caller and deletes it there.

- [ ] **Step 5: Run the tests**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/xiraid/validate.test.ts
```

Expected: PASS. `npm run typecheck` will still fail in the provider and
executor — those are Tasks 4 and 5.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/xiraid/validate.ts xiNAS-MCP/src/__tests__/lib/xiraid/validate.test.ts
git commit -m "feat(control-path): validate the array spare pool by name

Requires-Rebuild: xinas_node_build"
```

---

### Task 4: Executors stop owning a pool

**Files:**
- Modify: `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts` — create
  `preflight`/`create`/`rollback` (:91-236), `ModifyExecSpec` (:245-251),
  `ModifyPreState` (:257-262), `narrowModifySpec` (:264-283),
  modify `preflight` (:322-352), `applySpares` (:357-397),
  `verify` (:417-432), modify `rollback` (:439-486)
- Modify: `xiNAS-MCP/src/lib/xiraid/validate.ts` — delete `derivedPoolName`
- Modify: `xiNAS-MCP/src/agent/xiraid/fake-transport.ts:21` (comment referencing `xnsp_`)
- Test: `xiNAS-MCP/src/__tests__/agent/task/xiraid-array-executor.test.ts`

**Interfaces:**
- Consumes: `spec.spare_pool` (Task 2), `PoolFacts` semantics (Task 3).
- Produces: the enriched-spec contract Task 5 must emit —
  create: `{ ...createSpec, device_by_id }` where `device_by_id` covers
  **members only**; modify: `{ id, spare_pool?, tuning?, device_by_id: {} }`.
  `ctx.stash.pool_activated` holds the pool name when this run activated it.

- [ ] **Step 1: Write the failing tests**

Add to the existing describe blocks (the file's `makeFake()` already tracks
`pools` and an `ops` log — seed pools through it):

```ts
it('attaches an existing pool without creating one', async () => {
  const fake = makeFake();
  fake.pools.push({ name: 'sp01', drives: ['/dev/nvme5n2'], active: true });
  fake.arrays.push({ name: 'data', level: '5', devices: ['/dev/nvme1n1'], state: ['online'] });

  const events = await runModify({ id: 'data', spare_pool: 'sp01', device_by_id: {} });

  expect(terminal(events)).toBe('success');
  expect(fake.ops.filter((o) => o.startsWith('pool'))).toEqual([]);
  expect(fake.arrays[0].sparepool).toBe('sp01');
});

it('activates an inactive pool on attach and deactivates it on rollback', async () => {
  const fake = makeFake({ failTuningModify: true });
  fake.pools.push({ name: 'sp01', drives: ['/dev/nvme5n2'], active: false });
  fake.arrays.push({ name: 'arr-fail-tuning', level: '5', devices: [], state: ['online'] });

  const events = await runModify({
    id: 'arr-fail-tuning',
    spare_pool: 'sp01',
    tuning: { init_prio: 55 },
    device_by_id: {},
  });

  expect(terminal(events)).toBe('failed');
  expect(fake.pools[0].active).toBe(false);
  expect(fake.pools[0].drives).toEqual(['/dev/nvme5n2']);
  expect(fake.ops).not.toContain('poolDelete:sp01');
});

it('detaches without deleting or deactivating the pool', async () => {
  const fake = makeFake();
  fake.pools.push({ name: 'sp01', drives: ['/dev/nvme5n2'], active: true });
  fake.arrays.push({ name: 'data', level: '5', devices: [], state: ['online'], sparepool: 'sp01' });

  const events = await runModify({ id: 'data', spare_pool: null, device_by_id: {} });

  expect(terminal(events)).toBe('success');
  expect(fake.arrays[0].sparepool).toBe(SPAREPOOL_DETACH);
  expect(fake.pools).toEqual([{ name: 'sp01', drives: ['/dev/nvme5n2'], active: true }]);
});

it('fails preflight when the named pool does not exist', async () => {
  const fake = makeFake();
  fake.arrays.push({ name: 'data', level: '5', devices: [], state: ['online'] });

  const events = await runModify({ id: 'data', spare_pool: 'ghost', device_by_id: {} });

  expect(terminal(events)).toBe('failed');
  expect(JSON.stringify(events)).toMatch(/spare pool 'ghost' does not exist/);
});

it('creates an array against an existing pool without pool_create', async () => {
  const fake = makeFake();
  fake.pools.push({ name: 'sp01', drives: ['/dev/nvme5n2'], active: true });

  const events = await runCreate({
    name: 'data',
    level: 'raid5',
    member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
    spare_pool: 'sp01',
    device_by_id: {
      d1: '/dev/nvme1n1',
      d2: '/dev/nvme2n1',
      d3: '/dev/nvme3n1',
      d4: '/dev/nvme4n1',
    },
  });

  expect(terminal(events)).toBe('success');
  expect(fake.ops).not.toContain('poolCreate:xnsp_data');
  expect(fake.arrays[0].sparepool).toBe('sp01');
});
```

Use the file's existing helpers for `runModify` / `runCreate` / `terminal`
(the current tests drive `TaskRunner` directly — follow whatever shape they
already use, and add thin local helpers if none exist). Delete the existing
tests that assert `xnsp_` pool creation, membership deltas via
`pool_add`/`pool_remove`, and pool deletion on detach.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/xiraid-array-executor.test.ts
```

Expected: FAIL — the executor still calls `poolCreate`/`poolDelete` and rejects
`spare_pool` as an unknown key.

- [ ] **Step 3: Rewrite the create executor's pool handling**

In `preflight`, after the member-device loop:

```ts
      if (spec.spare_pool) {
        const pool = readPoolEntry(await client.poolShow(), spec.spare_pool);
        if (!pool) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' does not exist on the daemon`);
        }
        if (pool.drives.length === 0) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' has no drives`);
        }
        ctx.stash.pool_was_active = pool.active;
      }
```

In the `create` stage, replace the whole `const spares = …` block (its
`pool_create` plus `pool_activate` pair) with:

```ts
      // The pool is the operator's. We only arm it: an unactivated pool never
      // auto-replaces (analyst doc §3.8). Nothing here creates or fills one.
      if (spec.spare_pool && ctx.stash.pool_was_active === false) {
        await client.poolActivate({ name: spec.spare_pool });
        ctx.stash.pool_activated = spec.spare_pool;
        ctx.emitOutput(`pool_activate ${spec.spare_pool}`);
      }
```

In `rollback`, replace the trailing pool-cleanup block with:

```ts
      // Undo the ONE pool change this path can make. The pool itself is the
      // operator's and is never deleted here.
      const activated = ctx.stash.pool_activated;
      if (typeof activated === 'string') {
        await client.poolDeactivate({ name: activated });
        ctx.emitOutput(`rollback: spare pool '${activated}' deactivated`);
      }
```

Move that block ABOVE the `create_attempted` early return, so an activation
performed before a failed `raid_create` is still undone.

- [ ] **Step 4: Rewrite the modify executor**

`ModifyExecSpec`: replace `spare_disk_ids?: string[]` with
`spare_pool?: string | null`.

`ModifyPreState`:

```ts
interface ModifyPreState {
  /** The array's sparepool name before this run ('' when it had none). */
  arraySparepool: string;
  /** The TARGET pool's active flag, or null when no pool is being attached. */
  targetPoolActive: boolean | null;
}
```

`narrowModifySpec`: replace the `spare_disk_ids` spread with:

```ts
    ...('spare_pool' in o && o.spare_pool !== undefined
      ? { spare_pool: o.spare_pool as string | null }
      : {}),
```

`preflight`: delete the foreign-pool guard and the `derivedPoolName` call;
replace the pre-state capture with:

```ts
      let targetPoolActive: boolean | null = null;
      if (typeof spec.spare_pool === 'string' && spec.spare_pool !== '') {
        const pool = readPoolEntry(await client.poolShow(), spec.spare_pool);
        if (!pool) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' does not exist on the daemon`);
        }
        if (pool.drives.length === 0) {
          throw new Error(`preflight: spare pool '${spec.spare_pool}' has no drives`);
        }
        targetPoolActive = pool.active;
      }
      preStates.set(ctx.spec as object, { arraySparepool: liveSparepool, targetPoolActive });
      ctx.emitOutput(
        `preflight ok: '${spec.id}' sparepool='${liveSparepool}' target='${spec.spare_pool ?? '(unchanged)'}'`,
      );
```

`applySpares`, in full:

```ts
  const applySpares: ExecutorStage = {
    name: 'apply_spares',
    async run(ctx: ExecutorContext): Promise<void> {
      checkCancelled(ctx, 'apply_spares');
      const spec = narrowModifySpec(ctx);
      if (spec.spare_pool === undefined) {
        ctx.emitOutput('skipped (no spare_pool change)');
        return;
      }
      const pre = preStates.get(ctx.spec as object);
      const target = spec.spare_pool;

      if (typeof target === 'string' && target !== '') {
        if (pre?.targetPoolActive === false) {
          await client.poolActivate({ name: target });
          ctx.stash.pool_activated = target;
          ctx.emitOutput(`pool_activate ${target}`);
        }
        if (pre?.arraySparepool !== target) {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: target }));
        }
        ctx.emitOutput(`spare pool '${target}' attached`);
      } else {
        if (pre?.arraySparepool !== '') {
          await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: '' }));
        }
        ctx.emitOutput('spare pool detached (the pool itself is left in place)');
      }
    },
  };
```

`verify`: replace the expected-name computation with:

```ts
      if (spec.spare_pool !== undefined) {
        const expected = spec.spare_pool ?? '';
        if (live !== expected) {
          throw new Error(`verify: sparepool is '${live}', expected '${expected}'`);
        }
      }
```

`rollback`, in full (after the `pre` guard and `narrowModifySpec`):

```ts
      const liveSparepool = readSparepool(await client.raidShow(), spec.id) ?? '';
      if (liveSparepool !== pre.arraySparepool) {
        await client.raidModify(toRaidModifyRequest(spec.id, { sparepool: pre.arraySparepool }));
      }
      const activated = ctx.stash.pool_activated;
      if (typeof activated === 'string') {
        await client.poolDeactivate({ name: activated });
      }
      ctx.emitOutput('rollback: sparepool linkage restored to the preflight capture');
```

The `derivedPoolName` import and every `poolName` local in this file go away.

- [ ] **Step 5: Delete the derived-name helper**

In `xiNAS-MCP/src/lib/xiraid/validate.ts`, delete `derivedPoolName` and its
doc comment. Then confirm nothing references it:

```bash
cd xiNAS-MCP && grep -rn "derivedPoolName\|xnsp_" src/ | grep -v __tests__
```

Expected: no output. Update the stale `xnsp_` comment in
`src/agent/xiraid/fake-transport.ts:21` if the grep surfaces it.

- [ ] **Step 6: Run the executor tests**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/xiraid-array-executor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/agent xiNAS-MCP/src/lib/xiraid/validate.ts xiNAS-MCP/src/__tests__/agent
git commit -m "fix(xiraid): stop provisioning a spare pool from the array executors

The executors created xnsp_<array> from the drives of a pool the operator had
already made, so attaching any existing pool failed with 'Drive ... is already
a part of the <pool> spare pool'. Arrays now reference a pool by name and only
activate it.

Requires-Rebuild: xinas_node_build"
```

---

### Task 5: Plan providers, route rejection, and the end-to-end regression

**Files:**
- Modify: `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts` —
  `ObservedArrayRow` (:50-52), `GatheredFacts` (:54-62), `gatherFacts` (:64-101),
  create provider (:103-156), modify provider (:171-256)
- Modify: `xiNAS-MCP/src/api/routes/arrays.ts:42-90` (`rejectTopologyKeys`)
- Test: `xiNAS-MCP/src/__tests__/api/plan/xiraid-array-provider.test.ts`
- Test: `xiNAS-MCP/src/__tests__/api/routes-arrays.test.ts`
- Test: `xiNAS-MCP/src/__tests__/e2e/xiraid-array-mutations.test.ts`

**Interfaces:**
- Consumes: `PoolFacts`, `CreateFacts.poolsByName`, `ModifyFacts` (Task 3);
  the enriched-spec shape (Task 4).
- Produces: the HTTP contract the TUI calls in Tasks 6-7 —
  `POST /api/v1/arrays` with `spec.spare_pool`, `PATCH /api/v1/arrays/{id}`
  with `spec.spare_pool` (`null` detaches), and `422 UNSUPPORTED`
  `reason: 'observed_only'` for `spec.spare_disk_ids`.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/api/routes-arrays.test.ts`:

```ts
it('rejects spec.spare_disk_ids on PATCH as observed-only', async () => {
  const res = await patchArray('data', { spare_disk_ids: ['d5'] });
  expect(res.status).toBe(422);
  expect(res.body.error.details).toMatchObject({
    field: 'spec.spare_disk_ids',
    reason: 'observed_only',
  });
});
```

In `src/__tests__/api/plan/xiraid-array-provider.test.ts`:

```ts
it('leases the referenced pool instead of its drives', async () => {
  seedPool('sp01', { drives: ['/dev/nvme5n2'], active: true });
  seedArray('data', { member_disk_ids: ['d1'] });

  const result = await xiraidArrayModifyProvider.preflight(ctx, {
    id: 'data',
    spare_pool: 'sp01',
  });

  expect(result.affected_resources).toContainEqual({ kind: 'Pool', id: 'sp01' });
  expect(result.affected_resources.some((r) => r.kind === 'Disk')).toBe(false);
  expect(result.blockers).toEqual([]);
  expect(result.diff.after).toMatchObject({ spare_pool: 'sp01' });
});

it('blocks a modify naming an unknown pool', async () => {
  seedArray('data', { member_disk_ids: ['d1'] });
  const result = await xiraidArrayModifyProvider.preflight(ctx, {
    id: 'data',
    spare_pool: 'ghost',
  });
  expect(result.blockers.map((b) => b.code)).toContain('spare_pool_not_found');
});
```

In `src/__tests__/e2e/xiraid-array-mutations.test.ts`, the reported failure as
a regression test:

```ts
it('attaches an operator-created pool whose drives it already owns', async () => {
  // The 2026-08-29 field failure: apply_spares tried to build xnsp_<array>
  // from /dev/nvme5n2 + /dev/nvme6n2, which sp01 already held.
  await createPool('sp01', ['/dev/nvme5n2', '/dev/nvme6n2']);
  await createArray('data', ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1']);

  const task = await patchArrayAndWait('data', { spare_pool: 'sp01' });

  expect(task.state).toBe('success');
  expect(await arraySparepool('data')).toBe('sp01');
  expect(await poolNames()).toEqual(['sp01']);
});
```

Adapt each to the helpers already present in the respective file.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api src/__tests__/e2e/xiraid-array-mutations.test.ts
```

Expected: FAIL — no pool facts are gathered, the PATCH is accepted, and the
apply still tries `pool_create`.

- [ ] **Step 3: Gather pool facts**

In `xiraid-array.ts`, add `PoolFacts` to the existing
`../../lib/xiraid/validate.js` type import, add the prefix constant, and extend
`gatherFacts`:

```ts
const OBSERVED_POOL_PREFIX = '/xinas/v1/observed/Pool/';
```

```ts
  const poolsByName = new Map<string, PoolFacts>();
  for (const row of ctx.kv.list<{
    id?: string;
    status?: { drives?: string[]; active?: boolean };
  }>({ prefix: OBSERVED_POOL_PREFIX })) {
    const name = row.value.id;
    if (typeof name !== 'string') continue;
    poolsByName.set(name, {
      drives: row.value.status?.drives ?? [],
      active: row.value.status?.active === true,
    });
  }
```

Return `poolsByName` from `gatherFacts` and add it to `GatheredFacts`. Drop
`sparesByArray` and the `spare_disk_ids` contribution to
`existingMemberDiskIds` — spare drives are pool members, and the pool surface
already keeps them out of free-drive pickers. `ObservedArrayRow.spec` loses
`spare_disk_ids` and gains `spare_pool?: string | null`.

- [ ] **Step 4: Rework the create provider**

```ts
    const facts: CreateFacts = { disks, existingArrayNames, existingMemberDiskIds, poolsByName };
    const blockers = validateCreateSpec(spec, facts);

    // Members only — spares live in the pool, which we reference by name.
    const deviceById: Record<string, string> = {};
    for (const id of spec.member_disk_ids) {
      const path = byId.get(id);
      if (path !== undefined) deviceById[id] = path;
    }
    const fullyResolved = spec.member_disk_ids.every((id) => deviceById[id] !== undefined);

    const affected: ResourceRef[] = [
      { kind: 'XiraidArray', id: spec.name },
      ...spec.member_disk_ids.map((id): ResourceRef => ({ kind: 'Disk', id })),
      ...(spec.spare_pool ? [{ kind: 'Pool', id: spec.spare_pool } as ResourceRef] : []),
    ];
```

- [ ] **Step 5: Rework the modify provider**

```ts
    const blockers = validateModifySpec(change, { poolsByName: facts.poolsByName });

    const currentPool = observedSparePool(ctx, id); // status.spare_pool ?? ''
    const affected: ResourceRef[] = [
      { kind: 'XiraidArray', id },
      ...(typeof change.spare_pool === 'string' && change.spare_pool !== ''
        ? [{ kind: 'Pool', id: change.spare_pool } as ResourceRef]
        : []),
      ...(currentPool !== '' && currentPool !== change.spare_pool
        ? [{ kind: 'Pool', id: currentPool } as ResourceRef]
        : []),
    ];
```

with the small local reader:

```ts
/** The array's currently referenced pool name, '' when it has none. */
function observedSparePool(ctx: PlanContext, id: string): string {
  const row = ctx.kv.get<{ status?: { spare_pool?: string } }>(
    `/xinas/v1/observed/XiraidArray/${id}`,
  );
  return row?.value.status?.spare_pool ?? '';
}
```

Both the target and the currently-attached pool are leased, so a detach
serializes against pool mutations too. The `diff` becomes:

```ts
      diff: {
        before: { spare_pool: currentPool === '' ? null : currentPool, tuning: null },
        after: {
          ...(change.spare_pool !== undefined ? { spare_pool: change.spare_pool } : {}),
          ...(change.tuning !== undefined ? { tuning: change.tuning } : {}),
        },
        raid_modify_request: toRaidModifyRequest(id, {
          ...(change.tuning !== undefined ? { tuning: change.tuning } : {}),
        }),
      },
      enriched_spec: { id, ...change, device_by_id: {} },
```

Update the two `ApiException` remediation strings in this provider from
`{ spare_disk_ids?, tuning? }` to `{ spare_pool?, tuning? }`.

- [ ] **Step 6: Reject the retired key on PATCH**

In `xiNAS-MCP/src/api/routes/arrays.ts`, inside `rejectTopologyKeys`, before
the topology loop:

```ts
  if ('spare_disk_ids' in (spec as Record<string, unknown>)) {
    throw new ApiException(
      'UNSUPPORTED',
      'spec.spare_disk_ids is observed-only',
      { field: 'spec.spare_disk_ids', reason: 'observed_only' },
      'Create the pool via POST /api/v1/pools, then send spec.spare_pool with its name.',
    );
  }
```

Widen the function's doc comment to say it rejects every non-writable key, not
only topology.

- [ ] **Step 7: Run the api and e2e tests**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api src/__tests__/e2e
```

Expected: PASS.

- [ ] **Step 8: Run the full TypeScript gate**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:contracts
```

Expected: all green. Fix anything the contract tests surface before committing.

- [ ] **Step 9: Commit**

```bash
git add xiNAS-MCP/src/api xiNAS-MCP/src/__tests__
git commit -m "feat(api): plan array spare pools by name and lease the pool

Requires-Rebuild: xinas_node_build"
```

---

### Task 6: TUI — Edit Array attaches a pool by name

**Files:**
- Modify: `xinas_menu/screens/raid.py:522` (hoist `_NONE_POOL` to module level),
  `:944-976` (the `sparepool` branch), `:1025-1026` (patch spec),
  `:306-315` (delete `_pool_drive_paths`)
- Test: `tests/test_raid_edit_spare_pool.py` (create)

**Interfaces:**
- Consumes: `PATCH /api/v1/arrays/{id}` with `spec.spare_pool` (Task 5).
- Produces: module-level `_NONE_POOL = "(none)"`, reused by Task 7.

- [ ] **Step 1: Write the failing test**

Create `tests/test_raid_edit_spare_pool.py`:

```python
"""Edit Array -> Spare Pool sends a pool NAME, and says where to make one.

The executor used to build its own pool from the chosen pool's drives, which
the daemon refused with "Drive '/dev/nvme5n2' is already a part of the 'sp01'
spare pool" (design 2026-08-29). The screen now sends spec.spare_pool.
"""

from __future__ import annotations

from xinas_menu.screens.raid import _NONE_POOL, _pools_by_name


def test_none_pool_is_module_level() -> None:
    assert _NONE_POOL == "(none)"


def test_pools_by_name_accepts_api_rows() -> None:
    rows = [{"name": "sp01", "drives": ["/dev/nvme5n2"], "active": True}]
    assert _pools_by_name(rows)["sp01"]["drives"] == ["/dev/nvme5n2"]


def test_patch_spec_maps_the_pool_name() -> None:
    from xinas_menu.screens.raid import _spare_pool_patch

    assert _spare_pool_patch("sp01") == {"spare_pool": "sp01"}
    assert _spare_pool_patch(_NONE_POOL) == {"spare_pool": None}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pytest tests/test_raid_edit_spare_pool.py -v
```

Expected: FAIL — `_NONE_POOL` and `_spare_pool_patch` are not importable from
the module.

- [ ] **Step 3: Hoist the constant and add the mapper**

Near `_pools_by_name` in `xinas_menu/screens/raid.py`:

```python
_NONE_POOL = "(none)"


def _spare_pool_patch(choice: str) -> dict[str, Any]:
    """Edit Array's pool choice -> the PATCH spec. `(none)` detaches."""
    return {"spare_pool": None if choice == _NONE_POOL else choice}
```

Delete the local `_NONE_POOL = "(none)"` assignment inside the create wizard so
both surfaces share one constant.

- [ ] **Step 4: Rewrite the `sparepool` edit branch**

Replace the whole `elif key == "sparepool":` block with:

```python
        elif key == "sparepool":
            # The operator picks an EXISTING pool; the control path only
            # references it (design 2026-08-29). Pool lifecycle is Spare Pools'.
            try:
                p_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/pools")
            except ControlPathError:
                p_rows = []
            pools = _pools_by_name(p_rows)
            if not pools:
                await self.app.push_screen_wait(
                    ConfirmDialog(
                        "No spare pools exist.\n\n"
                        "Create one in Storage > Spare Pools > Create Pool, "
                        "then run Edit Array again.",
                        "No Spare Pools",
                        ok_only=True,
                    )
                )
                return
            value = await self.app.push_screen_wait(
                SelectDialog(
                    [_NONE_POOL] + sorted(pools.keys()),
                    title=f"Set {label}",
                    prompt=f"Select spare pool for {arr_name} ({_NONE_POOL} detaches):",
                )
            )
```

The `_list_api_disks` / `path_to_id` / `spare_ids` block is deleted with it, as
is the `spare_ids: list[str] = []` initialiser near `:883`.

- [ ] **Step 5: Map the choice onto the PATCH spec**

```python
        if key == "sparepool":
            patch_spec = _spare_pool_patch(value)
```

- [ ] **Step 6: Delete the now-dead drive-path helper**

```bash
grep -rn "_pool_drive_paths" xinas_menu tests
```

Expected after Task 7: no hits outside its own definition — delete
`_pool_drive_paths` then. If Task 7 has not run yet, leave it and delete it
there.

- [ ] **Step 7: Run the test and the Python gate**

```bash
pytest tests/test_raid_edit_spare_pool.py -v
ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper && ruff format --check .
```

Expected: PASS, no lint findings.

- [ ] **Step 8: Commit**

```bash
git add xinas_menu/screens/raid.py tests/test_raid_edit_spare_pool.py
git commit -m "fix(tui): Edit Array attaches a spare pool by name"
```

---

### Task 7: TUI — the create wizard always offers the spare step

**Files:**
- Modify: `xinas_menu/screens/raid.py:721-735` (`spare_step`),
  `:769` (the `WizardStep` predicate), `:786-799` (spec assembly),
  `:306-315` (`_pool_drive_paths`, now dead)
- Test: `tests/test_raid_create_spare_step.py` (create)

**Interfaces:**
- Consumes: `_NONE_POOL` (Task 6), `POST /api/v1/arrays` with
  `spec.spare_pool` (Task 5).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `tests/test_raid_create_spare_step.py`:

```python
"""The Create Array wizard always shows the spare step.

Silently skipping it when no pool existed left the operator with an array and
no idea why it had no spares (design 2026-08-29 §6).
"""

from __future__ import annotations

from xinas_menu.screens.raid import _NONE_POOL, _spare_prompt, _spare_spec_fragment


def test_prompt_points_at_spare_pools_when_none_exist() -> None:
    assert "Spare Pools" in _spare_prompt({})


def test_prompt_is_plain_when_pools_exist() -> None:
    assert "Spare Pools" not in _spare_prompt({"sp01": {}})


def test_spec_fragment_carries_the_pool_name() -> None:
    assert _spare_spec_fragment("sp01") == {"spare_pool": "sp01"}
    assert _spare_spec_fragment(_NONE_POOL) == {}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pytest tests/test_raid_create_spare_step.py -v
```

Expected: FAIL — neither helper exists.

- [ ] **Step 3: Add the two helpers**

Next to `_spare_pool_patch` in `xinas_menu/screens/raid.py`:

```python
def _spare_prompt(pools: dict[str, dict]) -> str:
    """Create-wizard spare step prompt; names where pools come from when none do."""
    if pools:
        return "Select spare pool (or none):"
    return (
        "No spare pools exist.\n"
        "Create one in Storage > Spare Pools, then attach it via Edit Array."
    )


def _spare_spec_fragment(choice: str) -> dict[str, Any]:
    """Create-wizard pool choice -> the POST spec fragment."""
    return {} if choice == _NONE_POOL else {"spare_pool": choice}
```

- [ ] **Step 4: Use them in the wizard**

In `spare_step`, replace the `SelectDialog` prompt argument with
`prompt=_spare_prompt(pools)`. Remove the step's predicate:

```python
            WizardStep(key="spare", run=spare_step),
```

Replace the spec-assembly block with:

```python
        spec.update(_spare_spec_fragment(answers.get("spare", _NONE_POOL)))
```

- [ ] **Step 5: Delete `_pool_drive_paths`**

```bash
grep -rn "_pool_drive_paths" xinas_menu tests
```

Expected: only its own definition. Delete the function.

- [ ] **Step 6: Run the tests and the Python gate**

```bash
pytest tests/test_raid_create_spare_step.py tests/test_raid_edit_spare_pool.py -v
ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper && ruff format --check .
pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper
```

Expected: PASS, no findings. (`pyright` needs the venv on PATH, or pass
`--pythonpath .venv/bin/python`.)

- [ ] **Step 7: Commit**

```bash
git add xinas_menu/screens/raid.py tests/test_raid_create_spare_step.py
git commit -m "feat(tui): always offer the spare-pool step in the Create Array wizard"
```

---

### Task 8: Retire the derived-pool-name rule and run the full gate

**Files:**
- Modify: `tests/test_xiraid_name_rules.py:118-124`
- Test: the same file

**Interfaces:**
- Consumes: the §7.3 rewrite from Task 1.
- Produces: nothing.

- [ ] **Step 1: Rewrite the `xnsp_` length case**

The test asserts `validate_pool_name("xnsp_" + "a" * ARRAY_NAME_MAX_LEN)`
because the executor used to derive that name. Nothing derives it now, so the
test states the plain rule instead:

```python
    def test_admits_a_64_character_pool_name(self) -> None:
        # xiRAID documents no pool-name length limit; xiNAS caps at 64 as a
        # deliberate choice (raid-management-spec §7.3). The old case pinned
        # this to the retired `xnsp_<array>` derived name.
        assert validate_pool_name("a" * 64) is None

    def test_rejects_a_65_character_pool_name(self) -> None:
        assert validate_pool_name("a" * 65) is not None
```

Remove the now-unused `ARRAY_NAME_MAX_LEN` import if this was its only use in
the file.

- [ ] **Step 2: Run the test**

```bash
pytest tests/test_xiraid_name_rules.py -v
```

Expected: PASS.

- [ ] **Step 3: Run every gate, verbatim from CLAUDE.md**

```bash
pytest --cov=xinas_history --cov-fail-under=20
ruff check          xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check .
pyright             xinas_menu xinas_history xiNAS-MCP/nfs-helper
yamllint -c .yamllint.yml .
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint \
  --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:contracts
```

Expected: all green. Paste the actual output — do not claim a pass you have
not read.

- [ ] **Step 4: Verify the retired model is really gone**

```bash
grep -rn "xnsp_\|derivedPoolName" xiNAS-MCP/src xinas_menu docs/control-path docs/Storage
```

Expected: no hits outside `CHANGELOG.md` history and the ADR's
"rejected alternatives" note.

- [ ] **Step 5: Commit**

```bash
git add tests/test_xiraid_name_rules.py
git commit -m "test(xiraid): pool-name length rule no longer derives from xnsp_<array>"
```

- [ ] **Step 6: Add the CHANGELOG entry and open the PR**

Add an `### Fixed` bullet under Unreleased in `CHANGELOG.md` naming the field
failure and the new contract, then:

```bash
git push -u origin fix/array-spare-pool-by-name
gh pr create --title "fix(xiraid): attach an existing spare pool by name" --body "$(cat <<'BODY'
## Problem

Attaching any operator-created spare pool failed on a real node:
`apply_spares: 13 INTERNAL: Drive '/dev/nvme5n2' is already a part of the
'sp01' spare pool`. The array executors provisioned their own
`xnsp_<array>` pool from the chosen pool's drives, so every pool the Spare
Pools screen makes was unattachable, in both Edit Array and the Create
wizard.

## Change

Arrays reference an existing pool by name (`spec.spare_pool`).
`spec.spare_disk_ids` becomes observed-only and is rejected on write. The
array path creates, fills and deletes nothing; it only activates an inactive
target pool (an unactivated pool never arms auto-replace) and deactivates it
again on rollback. Plans now lease `Pool/<name>` instead of the spare disks,
so an attach serializes against Spare Pools mutations.

Design: `docs/superpowers/specs/2026-08-29-array-spare-pool-by-name-design.md`

Requires-Rebuild: xinas_node_build

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

The `Requires-Rebuild: xinas_node_build` line must start at column 0 in the
body — the release notes aggregate the trailer from there, and a trailer that
fails to parse is indistinguishable from no trailer at all.
