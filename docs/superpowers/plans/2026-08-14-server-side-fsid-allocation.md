# Server-side NFS `fsid` allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `POST /api/v1/shares` omit `spec.fsid` and have the control path allocate a collision-free one, so no client has to guess a filesystem id.

**Architecture:** Allocation moves into the `share.create` plan provider, sharing one helper with `seed-shares.ts`. The plan→apply race is closed with a per-number marker row at `/xinas/v1/desired/ShareFsid/{n}` that each create writes and pins absent in `affected_resources` — two applies that allocated the same number see the second fail `PRECONDITION_FAILED` and re-plan onto the next. No plan/apply contract change; the absence-pin machinery already exists.

**Tech Stack:** TypeScript (Node ≥20, vitest, biome) for the control path; Python (pytest, ruff, pyright) for the TUI; OpenAPI 3.1 gated by Spectral + oasdiff.

**Spec:** [docs/superpowers/specs/2026-08-14-server-side-fsid-allocation-design.md](../specs/2026-08-14-server-side-fsid-allocation-design.md)

## Global Constraints

- **Allocator is `max + 1`, never "lowest free".** On `{0, 1, 4}` it yields `5`, not `2`. A deleted share's number is never reused (design §4, §12).
- **`fsid` 0 is reserved.** The installer writes `fsid=0` for the root export; the allocator never returns it.
- **`api-v1.yaml` must not narrow.** `Share.spec.required` keeps `fsid`. Only `description` prose is added — `oasdiff --fail-on ERR` gates every PR against the base branch.
- **Every commit touching `xiNAS-MCP/src/` carries a `Requires-Rebuild: xinas_node_build` trailer**, on its own line at column 0. `xinas-api` runs compiled JS from an untracked `dist/`; without the trailer the change never reaches the host.
- **`Share` stays first in `affected_resources`.** The legacy `observed_revision_expected` path checks `affected_resources[0]` ([tasks/engine.ts:443](../../../xiNAS-MCP/src/api/tasks/engine.ts)).
- **All repository artifacts are in English.** Conventional Commits: `type(scope): subject`.
- **Marker row value shape is `{ fsid: number, share_id: string }`** everywhere it is written (provider, seed, backfill).

**Verification commands** (from repo root unless noted):

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test
pytest tests/test_nfs_wizard_helpers.py
ruff check xinas_menu && ruff format --check xinas_menu && pyright xinas_menu
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

---

### Task 1: Shared allocator helper

The one place `fsid` allocation logic lives. Pure functions, no state store, no I/O — so both the plan provider (Task 2) and the seed path (Task 5) can call it and cannot drift.

**Files:**

- Create: `xiNAS-MCP/src/lib/nfs-fsid.ts`
- Test: `xiNAS-MCP/src/__tests__/lib/nfs-fsid.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `SHARE_FSID_PREFIX: string` — `'/xinas/v1/desired/ShareFsid/'`
  - `SHARE_FSID_KIND: string` — `'ShareFsid'`
  - `shareFsidKey(fsid: number): string`
  - `interface ShareDocRow { value: { id?: unknown; spec?: { fsid?: unknown } } }`
  - `collectUsedFsids(rows: readonly ShareDocRow[]): Map<number, string>` — fsid → owning share id
  - `allocateFsid(used: Iterable<number>): number`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/nfs-fsid.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  allocateFsid,
  collectUsedFsids,
  SHARE_FSID_KIND,
  SHARE_FSID_PREFIX,
  shareFsidKey,
} from '../../lib/nfs-fsid.js';

describe('shareFsidKey', () => {
  it('builds a desired-space key under the marker prefix', () => {
    expect(shareFsidKey(4)).toBe('/xinas/v1/desired/ShareFsid/4');
  });

  it('does not collide with the desired Share list prefix', () => {
    // GET /shares lists '/xinas/v1/desired/Share/' — the trailing slash is what
    // keeps 'ShareFsid' out of it. If either constant loses its slash, marker
    // rows start rendering as shares.
    expect(shareFsidKey(4).startsWith('/xinas/v1/desired/Share/')).toBe(false);
    expect(SHARE_FSID_PREFIX).toBe('/xinas/v1/desired/ShareFsid/');
    expect(SHARE_FSID_KIND).toBe('ShareFsid');
  });
});

describe('collectUsedFsids', () => {
  it('maps each integer fsid to its owning share id', () => {
    const used = collectUsedFsids([
      { value: { id: 'mnt/data', spec: { fsid: 0 } } },
      { value: { id: 'mnt/logs', spec: { fsid: 3 } } },
    ]);
    expect([...used.entries()]).toEqual([
      [0, 'mnt/data'],
      [3, 'mnt/logs'],
    ]);
  });

  it('accepts an integer-valued string, matching the provider validator', () => {
    const used = collectUsedFsids([{ value: { id: 'mnt/data', spec: { fsid: '7' } } }]);
    expect(used.has(7)).toBe(true);
  });

  it('ignores rows with a missing, non-integer, or unparseable fsid', () => {
    const used = collectUsedFsids([
      { value: { id: 'a', spec: {} } },
      { value: { id: 'b', spec: { fsid: 1.5 } } },
      { value: { id: 'c', spec: { fsid: 'abc' } } },
      { value: { id: 'd' } },
    ]);
    expect(used.size).toBe(0);
  });
});

describe('allocateFsid', () => {
  it('starts at 1 on an empty store — never 0, which the installer reserves', () => {
    expect(allocateFsid([])).toBe(1);
  });

  it('returns one above the highest in use', () => {
    expect(allocateFsid([0, 1, 2])).toBe(3);
  });

  it('does NOT fill gaps left by deleted shares', () => {
    // {0,1,4} -> 5, not 2. Reusing a departed share's number is out of scope
    // (design §12); this asserts the choice so it cannot regress silently.
    expect(allocateFsid([0, 1, 4])).toBe(5);
  });

  it('accepts the key iterator of collectUsedFsids', () => {
    const used = collectUsedFsids([{ value: { id: 'a', spec: { fsid: 9 } } }]);
    expect(allocateFsid(used.keys())).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/lib/nfs-fsid.test.ts`

Expected: FAIL — `Failed to resolve import "../../lib/nfs-fsid.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `xiNAS-MCP/src/lib/nfs-fsid.ts`:

```typescript
/**
 * NFS share `fsid` allocation (design:
 * docs/superpowers/specs/2026-08-14-server-side-fsid-allocation-design.md).
 *
 * `Share.spec.fsid` is required by the API and nothing used to assign it, so
 * every client allocated its own and two concurrent creates could pick the same
 * number — an fsid collision breaks NFSv4 client mounts. Allocation now happens
 * server-side, and these pure helpers are the single definition of "which
 * number is next" shared by the create plan provider and the seed path, so the
 * two cannot drift.
 */

/** Desired-space prefix for the per-number allocation marker rows. */
export const SHARE_FSID_PREFIX = '/xinas/v1/desired/ShareFsid/';

/**
 * Resource kind for the marker's absence pin in `affected_resources`. The task
 * engine resolves a pin to `/xinas/v1/{space}/{kind}/{id}`, so this must match
 * the prefix's final segment.
 */
export const SHARE_FSID_KIND = 'ShareFsid';

/** KV key of the marker row for `fsid`. */
export function shareFsidKey(fsid: number): string {
  return `${SHARE_FSID_PREFIX}${fsid}`;
}

/** A desired `Share` row as `KvStore.list` returns it. */
export interface ShareDocRow {
  value: { id?: unknown; spec?: { fsid?: unknown } };
}

/**
 * Every integer `fsid` on the given desired Share rows, mapped to the id of the
 * share holding it (so a collision can name its owner). Integer-valued strings
 * are accepted, matching the provider's own `fsid` validator.
 */
export function collectUsedFsids(rows: readonly ShareDocRow[]): Map<number, string> {
  const used = new Map<number, string>();
  for (const row of rows) {
    const raw = row.value?.spec?.fsid;
    let n = Number.NaN;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim().length > 0) n = Number(raw);
    if (!Number.isInteger(n)) continue;
    const id = typeof row.value?.id === 'string' ? row.value.id : '<unknown>';
    if (!used.has(n)) used.set(n, id);
  }
  return used;
}

/**
 * The next `fsid`: one above the highest in use.
 *
 * NOT the lowest free integer — a gap left by a deleted share is deliberately
 * not reused (design §12). Iterating rather than spreading into `Math.max`
 * keeps this safe for any share count.
 */
export function allocateFsid(used: Iterable<number>): number {
  let max = 0;
  for (const fsid of used) if (fsid > max) max = fsid;
  return max + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/lib/nfs-fsid.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Check the whole TS suite still passes**

Run: `cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test`

Expected: all green. Nothing imports the new module yet, so only the new file's own checks are exercised.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/nfs-fsid.ts xiNAS-MCP/src/__tests__/lib/nfs-fsid.test.ts
git commit -m "feat(api): shared NFS fsid allocation helpers

Single definition of the next-fsid rule (max + 1, never 0, no gap reuse)
so the create plan provider and the seed path cannot drift. Pure; no
caller yet.

Requires-Rebuild: xinas_node_build"
```

---

### Task 2: Allocate on create; block an explicit collision

Makes `spec.fsid` optional for `share.create`, allocates when omitted, and turns an explicit-but-taken `fsid` into a plan blocker. Marker rows come in Task 3 — after this task the race is narrowed but not closed, which is why Task 3 is not optional.

**Files:**

- Modify: `xiNAS-MCP/src/api/plan/providers/nfs.ts` (`RawShareSpec`, `validateShareSpec`, `shareCreateProvider`)
- Modify: `docs/control-path/api-v1.yaml` (`POST /shares`, around line 1927)
- Test: `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts`

**Interfaces:**

- Consumes: `collectUsedFsids`, `allocateFsid` from Task 1.
- Produces: `share.create` accepts a spec without `fsid`; the desired doc it writes always carries a resolved integer `fsid`. New blocker code `FSID_IN_USE`.

- [ ] **Step 1: Write the failing tests**

Append to `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts`. The file already has `makeHarness()`, `providerFor()`, and `makeShareSpec()` — reuse them; `makeShareSpec` defaults to `fsid: 42`, so pass `{ fsid: undefined }` to omit it.

```typescript
describe('share.create — fsid allocation', () => {
  const DESIRED = '/xinas/v1/desired/Share/';

  /** Put a desired Share row holding `fsid`. */
  function seedShare(kv: SqliteKvStore, id: string, path: string, fsid: number): void {
    kv.put(`${DESIRED}${id}`, { kind: 'Share', id, spec: { path, clients: [], fsid } });
  }

  it('allocates fsid 1 when the spec omits it and no shares exist', async () => {
    const { ctx } = makeHarness();
    const result = await providerFor('share.create').preflight(
      ctx,
      makeShareSpec({ fsid: undefined }),
    );
    const doc = result.desired_mutations?.find((m) => 'value' in m) as {
      value: { spec: { fsid: number } };
    };
    expect(doc.value.spec.fsid).toBe(1);
  });

  it('allocates above the highest fsid in use, not into a gap', async () => {
    const { ctx, kv } = makeHarness();
    seedShare(kv, 'mnt/a', '/mnt/a', 0);
    seedShare(kv, 'mnt/b', '/mnt/b', 4);
    const result = await providerFor('share.create').preflight(
      ctx,
      makeShareSpec({ fsid: undefined }),
    );
    const doc = result.desired_mutations?.find((m) => 'value' in m) as {
      value: { spec: { fsid: number } };
    };
    expect(doc.value.spec.fsid).toBe(5);
  });

  it('passes an explicit free fsid through unchanged', async () => {
    const { ctx } = makeHarness();
    const result = await providerFor('share.create').preflight(ctx, makeShareSpec({ fsid: 9 }));
    const doc = result.desired_mutations?.find((m) => 'value' in m) as {
      value: { spec: { fsid: number } };
    };
    expect(doc.value.spec.fsid).toBe(9);
    expect(result.blockers).toEqual([]);
  });

  it('blocks — not throws — when an explicit fsid is already held', async () => {
    const { ctx, kv } = makeHarness();
    seedShare(kv, 'mnt/a', '/mnt/a', 7);
    const result = await providerFor('share.create').preflight(ctx, makeShareSpec({ fsid: 7 }));
    // The plan still renders, like EXPORT_PATH_IN_USE, so the operator sees the
    // whole picture rather than a bare 400.
    const codes = result.blockers.map((b) => b.code);
    expect(codes).toContain('FSID_IN_USE');
    expect(result.blockers.find((b) => b.code === 'FSID_IN_USE')?.message).toContain('mnt/a');
  });

  it('still rejects a non-integer fsid', async () => {
    const { ctx } = makeHarness();
    await expect(
      providerFor('share.create').preflight(ctx, makeShareSpec({ fsid: 4.5 })),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('still requires fsid on share.update — an absent one would erase it', async () => {
    const { ctx, kv } = makeHarness();
    seedShare(kv, 's1', '/mnt/data', 3);
    await expect(
      providerFor('share.update').preflight(ctx, makeShareSpec({ fsid: undefined })),
    ).rejects.toBeInstanceOf(ApiException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts -t 'fsid allocation'`

Expected: FAIL — the omitted-`fsid` cases reject with `spec.fsid must be an integer (or integer string)`, and `FSID_IN_USE` is never pushed.

- [ ] **Step 3: Make `fsid` optional in the validator**

In `xiNAS-MCP/src/api/plan/providers/nfs.ts`, widen the interface field:

```typescript
interface RawShareSpec {
  id: string;
  path: string;
  clients: Array<{ pattern: string; options: string[] }>;
  /** Absent only on `share.create`, where the provider allocates one. */
  fsid?: number | string;
  sync?: 'sync' | 'async';
  security_mode?: string;
}
```

Replace the doc comment and signature of `validateShareSpec`, and its `fsid` block:

```typescript
/**
 * Validate a full Share spec (create/update): id, absolute path, non-empty
 * `clients[]` of `{ pattern, options[] }` with non-empty string options, and —
 * unless `allowMissingFsid` — a present `fsid` (integer per OpenAPI; a numeric
 * string is tolerated). `share.create` passes `allowMissingFsid` and allocates;
 * `share.update` does not, because an absent fsid there would erase the value
 * already on the desired doc.
 */
function validateShareSpec(
  op: string,
  spec: unknown,
  { allowMissingFsid = false }: { allowMissingFsid?: boolean } = {},
): RawShareSpec {
```

and, in place of the existing `const fsid = rec.fsid;` block:

```typescript
  const fsid = rec.fsid;
  if (fsid === undefined) {
    if (!allowMissingFsid) {
      throw invalid(op, 'spec.fsid must be an integer (or integer string)');
    }
  } else {
    // OpenAPI declares fsid as an integer; an integer-valued string is tolerated
    // (Number.isInteger rejects 42.5, NaN, and ±Infinity in either form).
    const fsidNum =
      typeof fsid === 'number'
        ? fsid
        : typeof fsid === 'string' && fsid.trim().length > 0
          ? Number(fsid)
          : Number.NaN;
    if (!Number.isInteger(fsidNum)) {
      throw invalid(op, 'spec.fsid must be an integer (or integer string)');
    }
  }
```

- [ ] **Step 4: Allocate in the create provider**

Add the import at the top of the same file, beside the other `lib/` imports:

```typescript
import { allocateFsid, collectUsedFsids } from '../../../lib/nfs-fsid.js';
```

In `shareCreateProvider.preflight`, replace the body from the `validateShareSpec` call through the `return` with:

```typescript
    const share = validateShareSpec('share.create', spec, { allowMissingFsid: true });
    const exportId = encodeExportIdOrThrow('share.create', share.path);

    // fsid: allocate when the caller omitted it; an explicit one that another
    // share already holds is a BLOCKER, not a silent substitution — quietly
    // changing the number yields a share that looks right and breaks on the
    // client (design §6).
    const usedFsids = collectUsedFsids(
      ctx.kv.list<{ id?: unknown; spec?: { fsid?: unknown } }>({ prefix: DESIRED_SHARE_PREFIX }),
    );
    const explicitFsid = share.fsid === undefined ? undefined : Number(share.fsid);
    const fsid = explicitFsid ?? allocateFsid(usedFsids.keys());

    const freshness = exportRuleFreshnessRef(ctx, exportId);
    const blockers: PlanResult['blockers'] = [];
    if (freshness.revision > 0) {
      blockers.push({
        code: 'EXPORT_PATH_IN_USE',
        message: `${share.path} is already exported; cannot create a second share on it`,
      });
    }
    if (explicitFsid !== undefined && usedFsids.has(explicitFsid)) {
      blockers.push({
        code: 'FSID_IN_USE',
        message:
          `fsid ${explicitFsid} is already held by share ${usedFsids.get(explicitFsid)}; ` +
          'omit spec.fsid to allocate a free one',
      });
    }

    // The desired doc always carries a resolved integer fsid, whether the
    // caller supplied it or we allocated it.
    const resolvedSpec = { ...(spec as Record<string, unknown>), fsid };

    return {
      // ABSENCE pin: revision 0 asserts the desired row does NOT exist yet.
      // The apply txn's desired-revision check reads an absent row as 0, so a
      // Share/{id} that appeared between plan and apply (duplicate id) reads
      // >= 1 and fails PRECONDITION_FAILED instead of silently overwriting.
      affected_resources: [{ kind: 'Share', id: share.id, revision: 0 }],
      blockers,
      warnings: [],
      // Unchanged: shareSpecToCompileInput takes only
      // { path, clients, sync?, security_mode? } — fsid is deliberately not
      // rendered into the export entry today, so an optional fsid on
      // RawShareSpec does not affect this call.
      diff: {
        action: 'create',
        export_entry: compileShareToExportEntry(shareSpecToCompileInput(share)),
      },
      risk_level: 'non_disruptive',
      rollback_model: 'reversible',
      observed_freshness_ref: freshness,
      desired_mutations: [
        {
          key: `${DESIRED_SHARE_PREFIX}${share.id}`,
          value: toDesiredShareDoc(resolvedSpec),
        },
      ],
    };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts`

Expected: PASS, including the pre-existing provider tests.

- [ ] **Step 6: Document the contract in `api-v1.yaml`**

The `Share` schema is NOT touched — `required: [path, clients, fsid]` stays, because `Share` is referenced only from responses and removing a required property there is what oasdiff flags. Add prose to the `POST /shares` operation only (currently at line 1927):

```yaml
    post:
      tags: [nfs]
      operationId: createShare
      summary: Create a share (plan/apply).
      description: |
        `spec.fsid` may be omitted; the server assigns the next integer above
        the highest currently in use (0 is reserved for the installer's root
        export, and a gap left by a deleted share is not reused). Supplying an
        `fsid` another share already holds returns an `FSID_IN_USE` blocker on
        the plan rather than an error, so the operator sees the whole plan.
        `fsid` is always present on read, which is why `Share.spec` still
        requires it.
      requestBody: { $ref: '#/components/requestBodies/Mutating' }
```

- [ ] **Step 7: Verify both API gates**

```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
git stash && cp docs/control-path/api-v1.yaml /tmp/base-api.yaml; git stash pop
npx --yes oasdiff breaking /tmp/base-api.yaml docs/control-path/api-v1.yaml
```

Expected: Spectral clean; oasdiff reports **no breaking changes** (a `description` addition is not breaking). If oasdiff flags anything, the schema was narrowed by mistake — revisit before continuing.

- [ ] **Step 8: Commit**

```bash
git add xiNAS-MCP/src/api/plan/providers/nfs.ts \
        xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts \
        docs/control-path/api-v1.yaml
git commit -m "feat(api): allocate share fsid when the create spec omits it

spec.fsid becomes optional on share.create and is allocated as max+1 over
the desired Share rows. An explicit fsid another share holds is an
FSID_IN_USE blocker rather than a silent substitution. share.update still
requires fsid, where an absent one would erase the stored value.

The OpenAPI Share schema is unchanged: it is referenced only from
responses, where fsid is always present, and dropping it from required
would be a breaking response change. The contract change is prose on
POST /shares.

Requires-Rebuild: xinas_node_build"
```

---

### Task 3: Close the race with marker rows

Task 2 narrowed the collision window to "between plan and apply". This closes it. The race test is the reason the whole design exists — it must drive the real plan and apply engines, not a stub.

**Files:**

- Modify: `xiNAS-MCP/src/api/plan/providers/nfs.ts` (`shareCreateProvider` only)
- Modify: `docs/control-path/s3-nfs-executor-spec.md` (the `fsid` note in §4, currently line 247)
- Test: `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts`, `xiNAS-MCP/src/__tests__/api/fsid-allocation-race.test.ts` (create)

**Interfaces:**

- Consumes: `shareFsidKey`, `SHARE_FSID_KIND` from Task 1; the allocation from Task 2.
- Produces: every `share.create` plan carries a second affected resource `{ kind: 'ShareFsid', id: String(fsid), revision: 0 }` and a second desired mutation writing `{ fsid, share_id }` at `shareFsidKey(fsid)`.

- [ ] **Step 1: Write the failing provider tests**

Append to the `describe('share.create — fsid allocation', ...)` block in `providers-nfs.test.ts`:

```typescript
  it('writes a marker row and pins it absent, for allocated fsids', async () => {
    const { ctx } = makeHarness();
    const result = await providerFor('share.create').preflight(
      ctx,
      makeShareSpec({ fsid: undefined }),
    );
    expect(result.desired_mutations).toContainEqual({
      key: '/xinas/v1/desired/ShareFsid/1',
      value: { fsid: 1, share_id: 's1' },
    });
    expect(result.affected_resources).toContainEqual({
      kind: 'ShareFsid',
      id: '1',
      revision: 0,
    });
  });

  it('pins the marker for an EXPLICIT fsid too', async () => {
    // Load-bearing: an explicit fsid=5 racing an allocation that computes 5
    // would otherwise slip through, because only the allocating side pinned.
    const { ctx } = makeHarness();
    const result = await providerFor('share.create').preflight(ctx, makeShareSpec({ fsid: 5 }));
    expect(result.affected_resources).toContainEqual({
      kind: 'ShareFsid',
      id: '5',
      revision: 0,
    });
  });

  it('keeps Share first in affected_resources', async () => {
    // tasks/engine.ts checks the legacy observed_revision_expected against
    // affected_resources[0]; the marker must not displace the Share.
    const { ctx } = makeHarness();
    const result = await providerFor('share.create').preflight(
      ctx,
      makeShareSpec({ fsid: undefined }),
    );
    expect(result.affected_resources[0]?.kind).toBe('Share');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts -t 'marker'`

Expected: FAIL — only one mutation and one affected resource are produced.

- [ ] **Step 3: Emit the marker mutation and pin**

In `xiNAS-MCP/src/api/plan/providers/nfs.ts`, extend the Task 1 import:

```typescript
import {
  allocateFsid,
  collectUsedFsids,
  SHARE_FSID_KIND,
  shareFsidKey,
} from '../../../lib/nfs-fsid.js';
```

In `shareCreateProvider.preflight`'s return, replace `affected_resources` and `desired_mutations`:

```typescript
      affected_resources: [
        { kind: 'Share', id: share.id, revision: 0 },
        // Absence pin on the fsid marker: two creates that allocated the same
        // number both pin it at 0; the first apply writes it, the second reads
        // 1 and fails PRECONDITION_FAILED, whose remediation is "re-run plan".
        // Share stays FIRST — engine.ts checks affected_resources[0].
        { kind: SHARE_FSID_KIND, id: String(fsid), revision: 0 },
      ],
```

```typescript
      desired_mutations: [
        {
          key: `${DESIRED_SHARE_PREFIX}${share.id}`,
          value: toDesiredShareDoc(resolvedSpec),
        },
        { key: shareFsidKey(fsid), value: { fsid, share_id: share.id } },
      ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts`

Expected: PASS.

- [ ] **Step 5: Update the existing plan_binding assertion**

Task 3 adds a second desired mutation, which breaks a pre-existing test. In
`providers-nfs.test.ts`, the test **"share.create through PlanEngine.plan
persists the plan_binding fields"** (around line 584) asserts
`plan_binding.desired_mutations` with `toEqual` against a one-element array. Add
the marker mutation to that expectation:

```typescript
      desired_mutations: [
        {
          key: '/xinas/v1/desired/Share/s1',
          value: {
            kind: 'Share',
            id: 's1',
            spec: {
              path: '/mnt/data',
              clients: [{ pattern: '10.0.0.0/8', options: ['rw'] }],
              fsid: 42,
            },
          },
        },
        { key: '/xinas/v1/desired/ShareFsid/42', value: { fsid: 42, share_id: 's1' } },
      ],
```

(`makeShareSpec()` defaults to `fsid: 42`, so this is the explicit-fsid path.)
Run the file and fix any other `toEqual` on `desired_mutations` or
`affected_resources` the same way — `toEqual` is exact, so every such assertion
must gain the marker.

- [ ] **Step 6: Write the failing race test**

Create `xiNAS-MCP/src/__tests__/api/fsid-allocation-race.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../api/errors.js';
import { PlanEngine } from '../../api/plan/engine.js';
import type { PlanContext } from '../../api/plan/engine.js';
import { buildNfsPlanProviders } from '../../api/plan/providers/nfs.js';
import { toApplyPlan } from '../../api/routes/apply-helpers.js';
import { TaskEngine } from '../../api/tasks/engine.js';
import type { ApplyRequest } from '../../api/tasks/engine.js';
import { TaskStore } from '../../api/tasks/store.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import { LeaseManager } from '../../state/leases.js';
import { runMigrations } from '../../state/migrations.js';

/**
 * The race the whole design exists for: two share.create plans computed against
 * the same state allocate the SAME fsid, and both applies used to succeed —
 * their only pin was the Share id, which differs. The marker's absence pin is
 * what makes the second one fail.
 *
 * Drives the real PlanEngine, the real toApplyPlan bridge, and the real
 * TaskEngine.apply transaction. A stub would prove nothing.
 */

function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);

  let idCounter = 0;
  const store = new TaskStore({
    db,
    now: () => 1_000,
    newId: () => {
      idCounter += 1;
      return `task-${String(idCounter).padStart(4, '0')}`;
    },
  });

  const ctx: PlanContext = { kv };
  const planEngine = new PlanEngine({ store, ctx });
  for (const p of buildNfsPlanProviders()) planEngine.register(p);
  const taskEngine = new TaskEngine({ db, store, leases, kv });

  return { db, kv, store, planEngine, taskEngine };
}

function shareSpec(id: string, path: string): Record<string, unknown> {
  return { id, path, clients: [{ pattern: '*', options: ['rw'] }], sync: 'sync' };
}

function planArgs(spec: unknown) {
  return {
    operation_kind: 'share.create',
    spec,
    principal: 'admin:test',
    client_type: 'rest' as const,
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

describe('concurrent share.create — fsid collision', () => {
  let h: ReturnType<typeof makeHarness>;
  let applyCounter = 0;

  beforeEach(() => {
    h = makeHarness();
    applyCounter = 0;
  });

  function applyReq(): ApplyRequest {
    applyCounter += 1;
    return {
      input_hash: `ihash-${applyCounter}`,
      idempotency_key: `idem-${applyCounter}`,
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '22222222-2222-2222-2222-222222222222',
      correlation_id: `corr-${applyCounter}`,
    };
  }

  /** The stored plan task, or a hard failure — no non-null assertions. */
  function planTask(taskId: string) {
    const t = h.store.get(taskId);
    if (!t) throw new Error(`no stored plan task ${taskId}`);
    return t;
  }

  /** The fsid a plan resolved, read off its persisted desired mutation. */
  function plannedFsid(taskId: string): number | undefined {
    const binding = planTask(taskId).plan_binding as {
      desired_mutations?: Array<{ key: string; value?: { spec?: { fsid?: number } } }>;
    };
    const shareMut = binding.desired_mutations?.find((m) =>
      m.key.startsWith('/xinas/v1/desired/Share/'),
    );
    return shareMut?.value?.spec?.fsid;
  }

  it('lets the first apply win and fails the second with PRECONDITION_FAILED', async () => {
    const { task: planA } = await h.planEngine.plan(planArgs(shareSpec('mnt/alpha', '/mnt/alpha')));
    const { task: planB } = await h.planEngine.plan(planArgs(shareSpec('mnt/beta', '/mnt/beta')));

    // Both planned against the same empty state, so both resolved the SAME
    // number. Without this the test could pass for an unrelated reason.
    expect(plannedFsid(planA.task_id)).toBe(1);
    expect(plannedFsid(planB.task_id)).toBe(1);

    const first = h.taskEngine.apply({
      plan: toApplyPlan(planTask(planA.task_id)),
      applyReq: applyReq(),
    });
    expect(first.state).toBe('queued');
    expect(h.kv.get('/xinas/v1/desired/ShareFsid/1')).not.toBeNull();

    // The marker's absence pin now mismatches. The desired-revision check runs
    // BEFORE lease acquisition inside apply(), so this is PRECONDITION_FAILED
    // and not a lease CONFLICT, even though the first apply still holds its
    // leases in this test (no task runner drains them).
    let thrown: unknown;
    try {
      h.taskEngine.apply({
        plan: toApplyPlan(planTask(planB.task_id)),
        applyReq: applyReq(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    expect(JSON.stringify((thrown as ApiException).details)).toContain('ShareFsid');
  });

  it('re-planning after the winner lands allocates the next number', async () => {
    const { task: planA } = await h.planEngine.plan(planArgs(shareSpec('mnt/alpha', '/mnt/alpha')));
    h.taskEngine.apply({ plan: toApplyPlan(planTask(planA.task_id)), applyReq: applyReq() });

    const { task: planB } = await h.planEngine.plan(planArgs(shareSpec('mnt/beta', '/mnt/beta')));
    expect(plannedFsid(planB.task_id)).toBe(2);

    const second = h.taskEngine.apply({
      plan: toApplyPlan(planTask(planB.task_id)),
      applyReq: applyReq(),
    });
    expect(second.state).toBe('queued');
  });
});
```

If `PlanEngine.plan`'s return shape or `TaskEngine`'s constructor differ from
this, mirror `src/__tests__/api/tasks/apply.test.ts` and
`src/__tests__/api/plan/providers-nfs.test.ts` — those are the live references
this was written against.

- [ ] **Step 7: Run the race test to verify it passes**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/fsid-allocation-race.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 8: Prove the race test actually detects the race**

Temporarily comment out the `{ kind: SHARE_FSID_KIND, ... }` entry in
`shareCreateProvider`'s `affected_resources` and re-run:

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/fsid-allocation-race.test.ts`

Expected: FAIL — the second apply *succeeds*, which is exactly the bug this
design exists to fix. **Restore the pin and re-run to green before continuing.**
If removing the pin does not fail the test, the test is not exercising the race:
stop and fix the test, because a green test that would also pass without the
feature is worse than no test.

- [ ] **Step 9: Correct the NFS executor spec**

`docs/control-path/s3-nfs-executor-spec.md` line 247 currently claims `fsid` is *"validated (integer) and uniqueness-enforced at plan time"*. The uniqueness half was not true. Replace that sentence:

```markdown
Note: `fsid` is validated (integer), allocated server-side when the create spec
omits it, and uniqueness-enforced at plan time — an explicit collision is an
`FSID_IN_USE` blocker, and concurrent creates that allocate the same number are
serialised by an absence pin on `ShareFsid/{n}` (design:
docs/superpowers/specs/2026-08-14-server-side-fsid-allocation-design.md). It is
still **not rendered** into the compiled export entry — deferred, because
emitting `fsid=` would change host behavior vs the installer baseline; revisit
with Phase-1 HA (see §11).
```

Then update the deferred-item list: the `fsid` half of **N5** (lines ~357 and ~462) is now done. Leave server-assigned `id` deferred and say so explicitly.

- [ ] **Step 10: Full verification**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test
cd .. && npx --yes markdownlint-cli2 'docs/**/*.md'
```

Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add xiNAS-MCP/src/api/plan/providers/nfs.ts \
        xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts \
        xiNAS-MCP/src/__tests__/api/fsid-allocation-race.test.ts \
        docs/control-path/s3-nfs-executor-spec.md
git commit -m "fix(api): serialise concurrent share creates on the fsid

Allocating in the provider narrowed the collision window to plan->apply
but did not close it: two plans computed against the same state allocate
the same number, and each apply's Share-id pin is satisfied. Each create
now writes a marker at /xinas/v1/desired/ShareFsid/{n} and pins it absent,
so the second apply fails PRECONDITION_FAILED and re-plans onto the next
number. Explicit fsids are pinned too, or an explicit 5 racing an
allocated 5 would slip through.

Reuses the absence-pin machinery share.create already relies on for
duplicate ids -- no plan/apply contract change.

Also corrects s3-nfs-executor-spec, which claimed fsid uniqueness was
enforced at plan time when only integer-ness was checked.

Requires-Rebuild: xinas_node_build"
```

---

### Task 4: Release the marker on delete

Without this, every deleted share permanently burns its number and the plan for a subsequent create pins a marker that is already present, failing every apply.

**Files:**

- Modify: `xiNAS-MCP/src/api/plan/providers/nfs.ts` (`shareDeleteProvider`)
- Test: `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts`

**Interfaces:**

- Consumes: `shareFsidKey` from Task 1.
- Produces: `share.delete` emits a second mutation deleting the marker.

- [ ] **Step 1: Write the failing tests**

Append to `providers-nfs.test.ts`:

```typescript
describe('share.delete — fsid marker release', () => {
  const DESIRED = '/xinas/v1/desired/Share/';

  it('deletes the marker alongside the share', async () => {
    const { ctx, kv } = makeHarness();
    kv.put(`${DESIRED}mnt/data`, {
      kind: 'Share',
      id: 'mnt/data',
      spec: { path: '/mnt/data', clients: [], fsid: 3 },
    });
    const result = await providerFor('share.delete').preflight(ctx, {
      id: 'mnt/data',
      path: '/mnt/data',
    });
    expect(result.desired_mutations).toContainEqual({
      key: '/xinas/v1/desired/ShareFsid/3',
      delete: true,
    });
  });

  it('still deletes the share when the desired doc carries no fsid', async () => {
    // Not reachable through the API, but a hand-edited store must not wedge
    // the delete path.
    const { ctx, kv } = makeHarness();
    kv.put(`${DESIRED}mnt/data`, {
      kind: 'Share',
      id: 'mnt/data',
      spec: { path: '/mnt/data', clients: [] },
    });
    const result = await providerFor('share.delete').preflight(ctx, {
      id: 'mnt/data',
      path: '/mnt/data',
    });
    expect(result.desired_mutations).toEqual([{ key: `${DESIRED}mnt/data`, delete: true }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts -t 'marker release'`

Expected: FAIL on the first test — only the Share mutation is emitted.

- [ ] **Step 3: Emit the marker delete**

In `shareDeleteProvider.preflight`, after the existing `if (!desired) { throw ... }` guard, add:

```typescript
    // Release the fsid marker so the number is not burned forever. A desired
    // doc with no fsid is not reachable through the API but must not wedge the
    // delete on a hand-edited store.
    const desiredFsid = (desired.value as { spec?: { fsid?: unknown } })?.spec?.fsid;
    const desiredFsidNum =
      typeof desiredFsid === 'number'
        ? desiredFsid
        : typeof desiredFsid === 'string' && desiredFsid.trim().length > 0
          ? Number(desiredFsid)
          : Number.NaN;
```

and replace the provider's `desired_mutations` with:

```typescript
      desired_mutations: [
        { key: `${DESIRED_SHARE_PREFIX}${id}`, delete: true },
        ...(Number.isInteger(desiredFsidNum)
          ? [{ key: shareFsidKey(desiredFsidNum), delete: true }]
          : []),
      ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/plan/providers-nfs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/plan/providers/nfs.ts \
        xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts
git commit -m "fix(api): release the fsid marker when a share is deleted

Without this every deleted share burns its number permanently, and the
next create's absence pin on an already-present marker fails every apply.
The task engine captures the marker's prior value with the share doc, so
a failed delete reverts both atomically.

Requires-Rebuild: xinas_node_build"
```

---

### Task 5: Seed path shares the allocator and writes markers

`seed-shares.ts` has its own copy of the allocation rule and writes no markers, so an adopted share's number is invisible to the pin.

**Files:**

- Modify: `xiNAS-MCP/src/api/seed-shares.ts`
- Test: `xiNAS-MCP/src/__tests__/api/seed-shares.test.ts`

**Interfaces:**

- Consumes: `allocateFsid`, `collectUsedFsids`, `shareFsidKey` from Task 1.
- Produces: seeded shares each have a marker row.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/api/seed-shares.test.ts` (inside the existing `describe`):

```typescript
  it('writes an fsid marker for each seeded share', () => {
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);
    seedShares(setup.state, cfg());
    const marker = setup.state.kv.get('/xinas/v1/desired/ShareFsid/0');
    expect(marker?.value).toEqual({ fsid: 0, share_id: 'mnt/data' });
  });

  it('marks the allocated number when the manifest entry has no fsid', () => {
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw'] }]);
    seedShares(setup.state, cfg());
    const row = setup.state.kv.get<ShareRow>('/xinas/v1/desired/Share/mnt/data');
    const fsid = row?.value.spec.fsid;
    expect(fsid).toBe(1);
    expect(setup.state.kv.get(`/xinas/v1/desired/ShareFsid/${fsid}`)).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/seed-shares.test.ts -t 'marker'`

Expected: FAIL — `kv.get(...)` returns `null`.

- [ ] **Step 3: Use the shared allocator and write markers**

In `xiNAS-MCP/src/api/seed-shares.ts`, add the import:

```typescript
import { allocateFsid, collectUsedFsids, shareFsidKey } from '../lib/nfs-fsid.js';
```

Replace the block that builds `existingPaths` / `usedFsids` from the listed rows:

```typescript
  const rows = state.kv.list<{ id?: unknown; spec?: { path?: unknown; fsid?: unknown } }>({
    prefix: DESIRED_SHARE_PREFIX,
  });
  const existingPaths = new Set<string>();
  for (const r of rows) {
    const p = r.value.spec?.path;
    if (typeof p === 'string') existingPaths.add(p);
  }
  // Same allocation rule as the create plan provider — one definition.
  const usedFsids = new Set(collectUsedFsids(rows).keys());
```

Replace the per-entry allocation:

```typescript
    const { fsid: parsedFsid, options } = extractFsid(rawOpts);
    let fsid = parsedFsid;
    if (fsid === undefined || usedFsids.has(fsid)) {
      fsid = allocateFsid(usedFsids); // 0 reserved; next free integer
    }
    usedFsids.add(fsid);
```

and, immediately after the existing `state.kv.put(`${DESIRED_SHARE_PREFIX}${id}`, ...)` call, add:

```typescript
    // Marker so the create provider's absence pin sees this number as taken.
    state.kv.put(shareFsidKey(fsid), { fsid, share_id: id }, PUT_SOURCE);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/seed-shares.test.ts`

Expected: PASS, including the pre-existing seed tests.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/seed-shares.ts xiNAS-MCP/src/__tests__/api/seed-shares.test.ts
git commit -m "refactor(api): seed shares through the shared fsid allocator

Adopted shares now get a marker row, so their numbers are visible to the
create provider's absence pin, and the duplicated max+1 expression is
replaced by the shared helper.

Requires-Rebuild: xinas_node_build"
```

---

### Task 6: Backfill markers at boot

Installs predating this work have shares but no markers, so their numbers look free. The backfill runs on every boot rather than once, so it also self-heals a marker lost to a rolled-back task or a restored snapshot.

**Files:**

- Create: `xiNAS-MCP/src/api/backfill-fsid-markers.ts`
- Modify: `xiNAS-MCP/src/api/server.ts` (beside the `seedShares(state, config)` call)
- Test: `xiNAS-MCP/src/__tests__/api/backfill-fsid-markers.test.ts`

**Interfaces:**

- Consumes: `collectUsedFsids`, `shareFsidKey` from Task 1.
- Produces: `backfillShareFsidMarkers(state: OpenedStateStore): void`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/backfill-fsid-markers.test.ts`. Use `buildTestApp` from `./_helpers.js`, as `seed-shares.test.ts` does.

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillShareFsidMarkers } from '../../api/backfill-fsid-markers.js';
import { buildTestApp } from './_helpers.js';

const SHARE = '/xinas/v1/desired/Share/';
const MARKER = '/xinas/v1/desired/ShareFsid/';

describe('backfillShareFsidMarkers', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const putShare = (id: string, fsid: number): void => {
    setup.state.kv.put(`${SHARE}${id}`, {
      kind: 'Share',
      id,
      spec: { path: `/${id}`, clients: [], fsid },
    });
  };

  it('creates a marker for a pre-existing share that has none', () => {
    putShare('mnt/data', 3);
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get(`${MARKER}3`)?.value).toEqual({ fsid: 3, share_id: 'mnt/data' });
  });

  it('leaves an existing marker untouched — no revision churn on every boot', () => {
    putShare('mnt/data', 3);
    backfillShareFsidMarkers(setup.state);
    const first = setup.state.kv.get(`${MARKER}3`)?.revision;
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get(`${MARKER}3`)?.revision).toBe(first);
  });

  it('is a no-op with no shares', () => {
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.list({ prefix: MARKER })).toEqual([]);
  });

  it('does not touch unrelated desired rows', () => {
    putShare('mnt/data', 3);
    setup.state.kv.put('/xinas/v1/desired/Filesystem/mnt-data.mount', { kind: 'Filesystem' });
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get('/xinas/v1/desired/Filesystem/mnt-data.mount')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/backfill-fsid-markers.test.ts`

Expected: FAIL — `Failed to resolve import "../../api/backfill-fsid-markers.js"`.

- [ ] **Step 3: Write the implementation**

Create `xiNAS-MCP/src/api/backfill-fsid-markers.ts`:

```typescript
import { collectUsedFsids, shareFsidKey } from '../lib/nfs-fsid.js';
import type { OpenedStateStore } from '../state/index.js';

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** Origin tag on every bootstrap write (mirrors seed-shares.ts). */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

/**
 * Ensure every desired Share's `fsid` has a marker row (design §7).
 *
 * Shares created before server-side allocation have no marker, so their numbers
 * look free to the create provider's absence pin. This runs on EVERY boot, not
 * once: that also self-heals a marker lost to a rolled-back task or a restored
 * snapshot. It writes only missing rows, so a healthy store sees no revision
 * churn.
 *
 * Runs in the bootstrap window alongside seedShares, before any listener binds,
 * so plain put() with no CAS is safe — the api is the sole writer.
 */
export function backfillShareFsidMarkers(state: OpenedStateStore): void {
  const rows = state.kv.list<{ id?: unknown; spec?: { fsid?: unknown } }>({
    prefix: DESIRED_SHARE_PREFIX,
  });
  for (const [fsid, shareId] of collectUsedFsids(rows)) {
    const key = shareFsidKey(fsid);
    if (state.kv.get(key) === null) {
      state.kv.put(key, { fsid, share_id: shareId }, PUT_SOURCE);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/backfill-fsid-markers.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into boot**

In `xiNAS-MCP/src/api/server.ts`, add the import beside the `seedShares` import:

```typescript
import { backfillShareFsidMarkers } from './backfill-fsid-markers.js';
```

and call it immediately after `seedShares(state, config);`:

```typescript
  // Install-time NFS share adoption (one-time; leaves operator deletes permanent).
  seedShares(state, config);

  // Ensure every desired Share's fsid has a marker row. Every boot, not once:
  // it backfills installs predating server-side allocation AND self-heals a
  // marker lost to a rolled-back task or a restored snapshot.
  backfillShareFsidMarkers(state);
```

Ordering matters: `seedShares` may create shares, and the backfill must see them.

- [ ] **Step 6: Full verification**

Run: `cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test`

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/api/backfill-fsid-markers.ts \
        xiNAS-MCP/src/api/server.ts \
        xiNAS-MCP/src/__tests__/api/backfill-fsid-markers.test.ts
git commit -m "feat(api): backfill share fsid markers at boot

Installs predating server-side allocation have shares but no marker rows,
so their numbers look free to the create provider's absence pin. Runs on
every boot rather than once, which also self-heals a marker lost to a
rolled-back task or a restored snapshot; only missing rows are written.

Requires-Rebuild: xinas_node_build"
```

---

### Task 7: TUI stops allocating

Removes the client-side allocator and the fail-closed read that existed only to make it safe.

**Files:**

- Modify: `xinas_menu/screens/nfs.py` (`_add_share_wizard`, around lines 552–580)
- Modify: `docs/Storage/fs-shares-management-spec.md` (§4.5 submission bullets, §7 rows)
- Test: `tests/test_nfs_wizard_helpers.py`

**Interfaces:**

- Consumes: server-side allocation from Tasks 2–3.
- Produces: the create spec no longer carries an `fsid` key.

- [ ] **Step 1: Update the tests first**

In `tests/test_nfs_wizard_helpers.py`:

**Delete** `test_add_share_aborts_when_the_existing_shares_cannot_be_read` outright — the behavior it pins is being removed.

**Add**:

```python
def test_add_share_does_not_allocate_an_fsid():
    # Share.spec.fsid is allocated server-side; a client-side max+1 over a list
    # it may not have read completely is exactly the collision this removed.
    src = inspect.getsource(NFSScreen._add_share_wizard)
    assert '"fsid"' not in src
    assert "max(used" not in src


def test_add_share_no_longer_reads_the_share_list():
    # The read existed only to allocate. Edit and Remove still call _get_exports.
    src = inspect.getsource(NFSScreen._add_share_wizard)
    assert "_get_exports" not in src
    assert "Could not read existing shares" not in src
```

Leave `test_get_exports_propagates_a_control_path_error` and
`test_edit_and_remove_distinguish_unreadable_from_empty` alone — Edit and Remove
still need both behaviors.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_nfs_wizard_helpers.py -k 'allocate or no_longer_reads' -v`

Expected: FAIL — both assertions find the strings still present.

- [ ] **Step 3: Remove the client-side allocation**

In `xinas_menu/screens/nfs.py`, delete the whole block from the comment
`# fsid is REQUIRED by the API and allocated here...` through the
`for row in existing: ... used.add(int(fsid))` loop, and drop the `"fsid"` entry
from the spec. The result is:

```python
        # fsid is allocated server-side (POST /api/v1/shares); omitting it is
        # what asks the api to pick a free one.
        spec: dict[str, Any] = {
            "path": path,
            "clients": [{"pattern": host, "options": [access, root_squash, "no_subtree_check"]}],
            "sync": sync_mode,
        }
        if sec != "sys":
            spec["security_mode"] = sec
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_nfs_wizard_helpers.py -v`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Update the Storage spec**

In `docs/Storage/fs-shares-management-spec.md` §4.5, replace the `fsid` bullet
(the one beginning **"`fsid` is allocated client-side, and the allocation fails
closed"**) and its follow-up paragraph with:

```markdown
- **`fsid` is allocated server-side.** The wizard omits `spec.fsid` entirely;
  `POST /api/v1/shares` assigns the next integer above the highest in use, and
  concurrent creates that compute the same number are serialised by the plan's
  absence pin on the fsid marker — the loser gets `PRECONDITION_FAILED` and
  re-plans. A caller that wants a specific number may still send one, and an
  `FSID_IN_USE` blocker says so if it is taken. See
  [docs/control-path/s3-nfs-executor-spec.md](../control-path/s3-nfs-executor-spec.md) §4.
```

Also update the JSON example above it to drop the `"fsid": 3` line.

In §7, delete the two rows **"Add Share cannot read the existing shares"** and
**"Two concurrent Add Shares allocate the same `fsid`"**, and replace them with:

```markdown
| Explicit `fsid` already held by another share | create plan blocker | `FSID_IN_USE` on the returned plan, naming the share that holds it; surfaces through `_show_control_error` like any blocker. |
| Two concurrent creates allocate the same `fsid` | fsid marker absence pin | The second apply fails `PRECONDITION_FAILED`; re-planning allocates the next number. |
```

Finally, in §4.1's **Shared share read** paragraph, drop the clause about Add
failing its `fsid` allocation closed — Add no longer reads the list at all — and
keep the Edit/Remove distinction.

- [ ] **Step 6: Full verification**

```bash
pytest tests/test_nfs_wizard_helpers.py
ruff check xinas_menu && ruff format --check xinas_menu && pyright xinas_menu
npx --yes markdownlint-cli2 'docs/**/*.md'
```

Expected: all green.

- [ ] **Step 7: Commit**

No `Requires-Rebuild:` trailer — this commit touches Python and docs only.

```bash
git add xinas_menu/screens/nfs.py \
        tests/test_nfs_wizard_helpers.py \
        docs/Storage/fs-shares-management-spec.md
git commit -m "fix(nfs): stop allocating share fsids in the TUI

The api assigns fsid now, so the wizard omits it. That removes the
client-side max+1 over a list the screen may not have read completely,
and with it the fail-closed read and its 'Could not read existing shares'
dialog, which existed only to make the client-side allocation safe.

_get_exports still propagates ControlPathError for Edit and Remove."
```

---

### Task 8: End-to-end check on a running api

The unit and race tests cover the logic; this confirms the wiring — routes, executor, and the TUI's actual request — on a real server.

**Files:** none modified. This is a verification task.

- [ ] **Step 1: Run the full suite in both languages**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:contracts
cd .. && pytest
ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

Expected: all green. `npm run test:contracts` matters here — it is the suite most likely to notice a response that changed shape.

- [ ] **Step 2: Confirm the e2e NFS round-trip still passes**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/e2e/nfs-roundtrip.test.ts`

Expected: PASS. If this test builds a share spec with an explicit `fsid`, it
still works (explicit is supported); if it asserts on the desired doc's exact
shape, confirm the resolved `fsid` is present rather than removing the assertion.

- [ ] **Step 3: Verify the created share carries an allocated fsid**

Against a dev api (or the e2e harness), create a share with no `fsid` and read it
back:

```bash
curl -sS -X POST localhost:8080/api/v1/shares \
  -H 'content-type: application/json' \
  -d '{"mode":"plan","spec":{"id":"mnt/plantest","path":"/mnt/plantest","clients":[{"pattern":"*","options":["rw"]}],"sync":"sync"}}' | jq '.result.blockers'
```

Expected: `[]` (no blockers), and applying the returned plan yields a share whose
`GET /api/v1/shares` row carries an integer `spec.fsid`.

- [ ] **Step 4: Confirm no stray marker rows leak into the shares list**

```bash
curl -sS localhost:8080/api/v1/shares | jq '[.result[].kind] | unique'
```

Expected: `["Share"]` — no `ShareFsid`. If a `ShareFsid` appears, the list prefix
lost its trailing slash.

---

## Notes for the executor

**Order matters.** Task 3 depends on Task 2; Task 4 must land before anyone
deletes a share on a build carrying Task 3, or the number is burned. Tasks 5–7
are independent of each other but all depend on Task 1.

**The race test is the point.** If Task 3's step 6 (deliberately breaking the pin
and watching the test fail) does not fail, the test is not exercising the race —
stop and fix the test before continuing. A green test that would also be green
without the feature is worse than no test.

**Do not "fix" the allocator to fill gaps.** `{0,1,4}` → `5` is deliberate and
asserted in Task 1. Reuse is out of scope (design §12).
