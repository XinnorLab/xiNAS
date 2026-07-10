# Restrict NFS shares to xiRAID-backed filesystems — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NFS shares may be created only from a filesystem mounted on a xiRAID volume (`/dev/xi_*`), at the mount root or a subfolder — enforced in the TUI Add Share wizard and in the control-path `share.create` executor preflight.

**Architecture:** Detection is a prefix match on the backing device path (`/dev/xi_*`). The TUI filters `findmnt` candidates to xiRAID mounts, aborts with guidance when none exist, and validates custom subfolder paths against a shared `is_path_under` helper. The server adds a live, fail-closed preflight in `buildShareCreate` using the existing `readMounts()` seam. No plan-side blocker (avoids false-blocks on stale observed state).

**Tech Stack:** Python 3 / Textual (TUI, `xinas_menu/`), TypeScript / Node (control-path, `xiNAS-MCP/`), pytest, vitest.

**Design doc:** [docs/plans/2026-07-10-xiraid-only-shares-design.md](2026-07-10-xiraid-only-shares-design.md)

**Commit note:** This repo requires explicit user go-ahead before committing. Commit steps are written out below; batch or gate them per the operator's preference. The **server-side commit (Task 6) MUST carry the `Requires-Rebuild: xinas_node_build` trailer** — the TS change ships in `dist/` and needs the host rebuild role to re-run. The Python-only commits (Tasks 1–4) MUST NOT carry a rebuild trailer.

**Pre-existing working-tree state:** `docs/Management/user-management-spec.md` and `tests/test_users_screen.py` were already modified by another session. Never `git add -A`; stage only the files each task names.

---

## Task 1: Specs first (spec-first rule)

**Files:**
- Modify: `docs/Storage/fs-shares-management-spec.md` (§4.5 Step 1)
- Modify: `docs/control-path/s3-nfs-executor-spec.md` (§3.1 `share.create`)

- [ ] **Step 1: Update the Storage spec, §4.5 Step 1**

Replace the "Step 1 — pick an export path." paragraph (currently at
`docs/Storage/fs-shares-management-spec.md:302-304`) with:

```markdown
**Step 1 — pick an export path.**

The wizard scans `findmnt -t xfs -n -o TARGET,SOURCE` and keeps only mounts whose
SOURCE is a xiRAID volume (`/dev/xi_*`) — an NFS export is allowed **only** from a
filesystem on a xiRAID array. If no such mount exists, the wizard aborts **before
it starts** with an OK-only dialog directing the operator to *Storage →
Filesystems → Create Filesystem* (the former free-form `/mnt/data/` fallback is
gone). Otherwise the xiRAID mount roots are offered in a `SelectDialog`, prepended
with `Custom path…` so an operator can export a subdirectory (e.g.
`/mnt/data/share1`). A directly picked mount root is valid as-is; a custom path is
accepted only when it is at-or-under one of the xiRAID mount roots (segment-aware
`is_path_under`, [xfs_helpers.py](../../xinas_menu/utils/xfs_helpers.py)), otherwise
the step re-prompts with an error. Either choice must be an absolute path (rejects
anything that doesn't start with `/`). This is the wizard's first step, so its
dialogs never render a Back button (`allow_back` is `False` here); every step after
it does.
```

- [ ] **Step 2: Update the control-path spec, §3.1 `share.create` Executor bullet**

In `docs/control-path/s3-nfs-executor-spec.md`, replace the `- **Executor:**` line
under §3.1 (currently at lines 131-133) with:

```markdown
- **Executor:** `snapshot_before` → `preflight` (**xiRAID-backing gate** — read live
  mounts via the injected `readMounts()` seam; the export path must be at-or-under a
  mount whose source is `/dev/xi_*` (longest-match wins so a nested xiRAID mount beats
  `/`), else fail `EXPORT_PATH_NOT_ON_XIRAID`; **fail-closed** — an unreadable mount
  table throws and refuses the create. Then: helper reachable; `list_exports`, fail
  `EXPORT_PATH_IN_USE` if appeared) → `apply` (`add_export(compile(spec),
  create_path:true)`) → `verify` (`list_exports` contains it) → `snapshot_after`.
  Compile via lib/nfs-exports. The gate is **executor-side only** — there is no
  plan-phase blocker, because the plan would read *observed* Filesystem state and a
  degraded/stale collector could falsely block a legitimate create.
```

- [ ] **Step 3: Commit (on user go-ahead — no rebuild trailer)**

```bash
git add docs/Storage/fs-shares-management-spec.md docs/control-path/s3-nfs-executor-spec.md docs/plans/2026-07-10-xiraid-only-shares-design.md docs/plans/2026-07-10-xiraid-only-shares-plan.md
git commit -m "docs(shares): spec xiRAID-only NFS export gate (TUI + executor)"
```

---

## Task 2: Shared `is_path_under` helper

**Files:**
- Modify: `xinas_menu/utils/xfs_helpers.py` (add `is_path_under`)
- Modify: `xinas_menu/screens/raid.py` (replace private `_is_under` with the shared helper)
- Test: `tests/test_xfs_path_helpers.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_xfs_path_helpers.py`:

```python
from __future__ import annotations

from xinas_menu.utils.xfs_helpers import is_path_under


def test_exact_match():
    assert is_path_under("/mnt/data", "/mnt/data") is True


def test_subfolder():
    assert is_path_under("/mnt/data/share1", "/mnt/data") is True


def test_root_with_trailing_slash():
    assert is_path_under("/mnt/data/share1", "/mnt/data/") is True


def test_sibling_is_not_under():
    assert is_path_under("/mnt/data2", "/mnt/data") is False


def test_prefix_but_not_segment_boundary():
    # "/mnt/database" must NOT count as under "/mnt/data".
    assert is_path_under("/mnt/database", "/mnt/data") is False


def test_unrelated_path():
    assert is_path_under("/srv/foo", "/mnt/data") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_xfs_path_helpers.py -q`
Expected: FAIL — `ImportError: cannot import name 'is_path_under'`.

- [ ] **Step 3: Add the helper**

In `xinas_menu/utils/xfs_helpers.py`, add near the top of the module (after the
imports, before `run_async_cmd`):

```python
def is_path_under(path: str, root: str) -> bool:
    """True when *path* is at or under *root* (path-segment aware).

    ``/mnt/data`` is under ``/mnt/data``; ``/mnt/data/share1`` is under
    ``/mnt/data``; ``/mnt/database`` is NOT (segment boundary enforced).
    """
    if path == root:
        return True
    prefix = root if root.endswith("/") else root + "/"
    return path.startswith(prefix)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_xfs_path_helpers.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Switch `raid.py` to the shared helper**

In `xinas_menu/screens/raid.py`, delete the private `_is_under` definition (lines
250-255):

```python
def _is_under(path: str, root: str) -> bool:
    """True when ``path`` is at or under ``root`` (path-segment aware)."""
    if path == root:
        return True
    prefix = root if root.endswith("/") else root + "/"
    return path.startswith(prefix)
```

Add the import to the module-level imports at the top of `raid.py` (the file
already imports from `xinas_menu.utils.xfs_helpers` locally at line 952; add a
top-level import alongside the other `xinas_menu` imports):

```python
from xinas_menu.utils.xfs_helpers import is_path_under
```

Update the sole call site (line 1004) from `_is_under(...)` to `is_path_under(...)`:

```python
                if any(is_path_under(str(path), mp) for mp in mountpoints):
```

- [ ] **Step 6: Run the raid-screen tests + import check**

Run: `python -m pytest tests/ -q -k "raid" && python -c "import xinas_menu.screens.raid"`
Expected: PASS / no import error. (If `textual` is unavailable in the venv, the
import-heavy screen tests are skipped in local runs and covered by CI — see the
project test-env note; the `python -c import` still validates the edit.)

- [ ] **Step 7: Commit (on user go-ahead — no rebuild trailer)**

```bash
git add xinas_menu/utils/xfs_helpers.py xinas_menu/screens/raid.py tests/test_xfs_path_helpers.py
git commit -m "refactor(xfs_helpers): shared is_path_under, adopt in raid screen"
```

---

## Task 3: TUI xiRAID-mount filter helper

**Files:**
- Modify: `xinas_menu/screens/nfs.py` (add pure helper `_xiraid_mount_points`)
- Test: `tests/test_nfs_wizard_helpers.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_nfs_wizard_helpers.py`:

```python
from xinas_menu.screens.nfs import _xiraid_mount_points


def test_xiraid_mount_points_keeps_only_xi_sources():
    out = "/mnt/data      /dev/xi_data\n/boot          /dev/sda1\n/              /dev/sda2\n"
    assert _xiraid_mount_points(out) == ["/mnt/data"]


def test_xiraid_mount_points_multiple():
    out = "/mnt/data   /dev/xi_data\n/mnt/logs   /dev/xi_logs\n"
    assert _xiraid_mount_points(out) == ["/mnt/data", "/mnt/logs"]


def test_xiraid_mount_points_none():
    out = "/           /dev/sda2\n/boot       /dev/sda1\n"
    assert _xiraid_mount_points(out) == []


def test_xiraid_mount_points_empty_string():
    assert _xiraid_mount_points("") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_nfs_wizard_helpers.py -q -k xiraid_mount_points`
Expected: FAIL — `ImportError: cannot import name '_xiraid_mount_points'`.

- [ ] **Step 3: Add the helper**

In `xinas_menu/screens/nfs.py`, add a module-level function next to `_path_prefill`
(near line 45):

```python
def _xiraid_mount_points(findmnt_output: str) -> list[str]:
    """Return the TARGET mountpoints backed by a xiRAID volume (``/dev/xi_*``).

    *findmnt_output* is the raw text of ``findmnt -t xfs -n -o TARGET,SOURCE``
    (one ``<target> <source>`` row per line). Only rows whose SOURCE begins with
    ``/dev/xi_`` are kept — that is xiNAS's block-device namespace for xiRAID
    arrays.
    """
    mounts: list[str] = []
    for line in findmnt_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.rsplit(None, 1)
        if len(parts) == 2 and parts[1].startswith("/dev/xi_"):
            mounts.append(parts[0])
    return mounts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_nfs_wizard_helpers.py -q -k xiraid_mount_points`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit (on user go-ahead — no rebuild trailer)**

```bash
git add xinas_menu/screens/nfs.py tests/test_nfs_wizard_helpers.py
git commit -m "feat(nfs): _xiraid_mount_points helper filters findmnt to xiRAID mounts"
```

---

## Task 4: Wire the xiRAID gate into the Add Share wizard

**Files:**
- Modify: `xinas_menu/screens/nfs.py` (`_add_share_wizard`, candidate gathering + `path_step`)

No new automated test — the wizard's logic units (`_xiraid_mount_points`,
`is_path_under`) are unit-tested in Tasks 2–3; the wiring is verified by the
manual TUI check in Step 4.

- [ ] **Step 1: Filter candidates to xiRAID mounts and abort when none**

In `xinas_menu/screens/nfs.py`, add the shared import to the module-level imports
(top of file):

```python
from xinas_menu.utils.xfs_helpers import is_path_under
```

In `_add_share_wizard`, replace the candidate-gathering block (currently lines
395-400):

```python
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd("findmnt", "-t", "xfs", "-n", "-o", "TARGET", timeout=10)
        if ok and out:
            mount_points = [line.strip() for line in out.splitlines() if line.strip()]
```

with:

```python
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd(
            "findmnt", "-t", "xfs", "-n", "-o", "TARGET,SOURCE", timeout=10
        )
        if ok and out:
            mount_points = _xiraid_mount_points(out)

        if not mount_points:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No xiRAID-backed filesystem found.\n\n"
                    "NFS shares can only be exported from a filesystem on a "
                    "xiRAID array. Create one first:\n"
                    "Storage → Filesystems → Create Filesystem.",
                    "Add Share",
                    ok_only=True,
                )
            )
            return
```

- [ ] **Step 2: Simplify `path_step` — xiRAID-only select + custom-path containment**

`mount_points` is now always non-empty when `path_step` runs, so the
no-mount-points `else` branch is dead code. Replace the entire `path_step` body
(currently lines 402-456) with:

```python
        async def path_step(answers, allow_back, step_no):
            stored = answers.get("path", "")
            title = f"Add Share — Step {step_no}/7"
            while True:
                selected, custom_default = _path_prefill(stored, mount_points)
                choice = await self.app.push_screen_wait(
                    SelectDialog(
                        mount_points + [_CUSTOM_PATH],
                        title=title,
                        prompt="Select filesystem to export (or choose custom for a subfolder):",
                        selected=selected,
                        allow_back=allow_back,
                    )
                )
                if choice is None:
                    return CANCEL
                if choice is BACK:
                    return BACK
                if choice == _CUSTOM_PATH:
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Export path:",
                            title,
                            default=custom_default,
                            placeholder="/mnt/data/share1",
                            allow_back=True,
                        )
                    )
                    if sub is None:
                        return CANCEL
                    if sub is BACK:
                        continue
                    path = sub
                else:
                    path = choice
                if not path.startswith("/"):
                    self.app.notify("Export path must start with '/'.", severity="error")
                    continue
                path = path.rstrip("/") or "/"
                if not any(is_path_under(path, mp) for mp in mount_points):
                    self.app.notify(
                        "Export path must be inside a xiRAID filesystem "
                        f"({', '.join(mount_points)}).",
                        severity="error",
                    )
                    continue
                return path
```

- [ ] **Step 3: Byte-compile and lint**

Run: `python -m py_compile xinas_menu/screens/nfs.py && ruff check xinas_menu/screens/nfs.py`
Expected: no output / no errors.

- [ ] **Step 4: Manual TUI verification (record evidence)**

Drive the real screen and confirm behavior end-to-end:

1. With **no** xiRAID-backed XFS mount present, open NFS Access Rights → Add
   Share. Expected: the "No xiRAID-backed filesystem found." dialog appears and the
   wizard does **not** proceed to the export-path input. (This is the reported bug.)
2. With a xiRAID mount present (e.g. `/mnt/data` on `/dev/xi_data`), open Add
   Share. Expected: `/mnt/data` is offered in the select list; `Custom path…` →
   `/mnt/data/share1` is accepted; `Custom path…` → `/srv/foo` is rejected with the
   "must be inside a xiRAID filesystem" notification.

Capture the outcome (screenshots or a note of observed dialogs) in the PR.

- [ ] **Step 5: Commit (on user go-ahead — no rebuild trailer)**

```bash
git add xinas_menu/screens/nfs.py
git commit -m "feat(nfs): Add Share allows only xiRAID-backed filesystems and their subfolders"
```

---

## Task 5: Server executor preflight — xiRAID-backing gate

**Files:**
- Modify: `xiNAS-MCP/src/agent/task/nfs-executor.ts` (`NfsExecutorDeps`, `containingMount`/`pathIsUnder` helpers, `buildShareCreate` preflight)
- Modify: `xiNAS-MCP/src/agent/task/wiring.ts` (`buildNfsExecutorDeps` gets `readMounts`; DRY the resolved reader)
- Test: `xiNAS-MCP/src/__tests__/agent/task/nfs-executor.test.ts` (extend `makeDeps` + new cases)
- Create: `xiNAS-MCP/src/__tests__/e2e/__fixtures__/mounts.json`

- [ ] **Step 1: Write the failing tests**

In `xiNAS-MCP/src/__tests__/agent/task/nfs-executor.test.ts`, extend `makeDeps`
(currently lines 125-131) to inject a default xiRAID mount reader:

```typescript
/** Deps with a no-op readIdmapDomain and a default xiRAID mount at /mnt/data. */
function makeDeps(
  helper: NfsHelperClient,
  readIdmapDomain: () => Promise<string | undefined> = async () => undefined,
  readMounts: () => Promise<Array<{ source: string; mountpoint: string }>> = async () => [
    { source: '/dev/xi_data', mountpoint: '/mnt/data' },
  ],
): NfsExecutorDeps {
  return { helper, readIdmapDomain, readMounts };
}
```

Add these cases inside `describe('share.create', ...)` (the shared `spec` there has
`path: '/mnt/data'`):

```typescript
  it('preflight throws EXPORT_PATH_NOT_ON_XIRAID when no mount contains the path', async () => {
    const helper = makeFakeHelper([]);
    const deps = makeDeps(helper, undefined, async () => [
      { source: '/dev/sda2', mountpoint: '/' },
    ]);
    const ex = getExecutor(deps, 'share.create');
    await expect(stage(ex, 'preflight').run(makeCtx(spec))).rejects.toThrow(
      'EXPORT_PATH_NOT_ON_XIRAID',
    );
  });

  it('preflight throws EXPORT_PATH_NOT_ON_XIRAID when the containing mount is not xiRAID', async () => {
    const helper = makeFakeHelper([]);
    const deps = makeDeps(helper, undefined, async () => [
      { source: '/dev/sda2', mountpoint: '/' },
      { source: '/dev/sdb1', mountpoint: '/mnt/data' },
    ]);
    const ex = getExecutor(deps, 'share.create');
    await expect(stage(ex, 'preflight').run(makeCtx(spec))).rejects.toThrow(
      'EXPORT_PATH_NOT_ON_XIRAID',
    );
  });

  it('preflight accepts a subfolder under a xiRAID mount (longest-match beats /)', async () => {
    const helper = makeFakeHelper([]);
    const deps = makeDeps(helper, undefined, async () => [
      { source: '/dev/sda2', mountpoint: '/' },
      { source: '/dev/xi_data', mountpoint: '/mnt/data' },
    ]);
    const ex = getExecutor(deps, 'share.create');
    await expect(
      stage(ex, 'preflight').run(makeCtx({ ...spec, path: '/mnt/data/share1' })),
    ).resolves.toBeUndefined();
  });

  it('preflight fails closed when readMounts throws', async () => {
    const helper = makeFakeHelper([]);
    const deps = makeDeps(helper, undefined, async () => {
      throw new Error('proc unreadable');
    });
    const ex = getExecutor(deps, 'share.create');
    await expect(stage(ex, 'preflight').run(makeCtx(spec))).rejects.toThrow();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/nfs-executor.test.ts`
Expected: the four new tests FAIL (gate not implemented; a TS error on the extra
`readMounts` arg to `makeDeps` is also acceptable as the red state).

- [ ] **Step 3: Add the `readMounts` dep and the containment helpers**

In `xiNAS-MCP/src/agent/task/nfs-executor.ts`, extend `NfsExecutorDeps` (lines
37-43):

```typescript
/** Injected deps so the executors are test-hermetic (fake helper + fake reader). */
export interface NfsExecutorDeps {
  /** Typed nfs-helper write/read client the executors drive. */
  helper: NfsHelperClient;
  /** Read the current /etc/idmapd.conf Domain (undefined if unset). Injected so tests fake it. */
  readIdmapDomain: () => Promise<string | undefined>;
  /**
   * Read live mounts for the share.create xiRAID-backing gate. FAIL-CLOSED: a
   * throw refuses the create (better no export than one on the wrong device).
   * Injected so tests fake it; wired to the same reader as the delete guard.
   */
  readMounts: () => Promise<Array<{ source: string; mountpoint: string }>>;
}
```

Add these module-private helpers (e.g. just above `buildShareCreate`, near line
177):

```typescript
/** True when `path` is at or under `root` (path-segment aware). */
function pathIsUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix);
}

/**
 * The most specific mount containing `path` — the longest mountpoint that is a
 * path-prefix of `path` — or null if none contains it. Longest-match ensures a
 * nested xiRAID mount (e.g. /mnt/data) wins over the root `/`.
 */
function containingMount(
  mounts: Array<{ source: string; mountpoint: string }>,
  path: string,
): { source: string; mountpoint: string } | null {
  let best: { source: string; mountpoint: string } | null = null;
  for (const m of mounts) {
    if (pathIsUnder(path, m.mountpoint)) {
      if (best === null || m.mountpoint.length > best.mountpoint.length) best = m;
    }
  }
  return best;
}
```

- [ ] **Step 4: Add the gate at the head of the `share.create` preflight**

In `buildShareCreate`, replace the `preflight` stage `run` body (lines 184-191)
with:

```typescript
        async run(ctx: ExecutorContext): Promise<void> {
          const spec = readShareSpec(ctx.spec);
          ctx.emitOutput(`share.create: preflight — checking export path ${spec.path}`);
          // xiRAID-backing gate: the path must live on a /dev/xi_* filesystem.
          // Live + fail-closed — an unreadable mount table throws and refuses.
          const mounts = await deps.readMounts();
          const backing = containingMount(mounts, spec.path);
          if (backing === null || !backing.source.startsWith('/dev/xi_')) {
            const where =
              backing === null
                ? 'no filesystem is mounted at or above it'
                : `it is on ${backing.source} (${backing.mountpoint})`;
            ctx.emitOutput(
              `share.create: ${spec.path} is not on a xiRAID filesystem — ${where}`,
            );
            throw new Error(
              `EXPORT_PATH_NOT_ON_XIRAID: ${spec.path} is not on a xiRAID-backed filesystem`,
            );
          }
          const existing = await deps.helper.listExports();
          if (findEntry(existing, spec.path) !== null) {
            ctx.emitOutput(`share.create: path ${spec.path} is already exported`);
            throw new Error(`EXPORT_PATH_IN_USE: ${spec.path} is already exported`);
          }
        },
```

- [ ] **Step 5: Thread `readMounts` through wiring (DRY the resolved reader)**

In `xiNAS-MCP/src/agent/task/wiring.ts`, change `buildNfsExecutorDeps` (lines
117-131) to accept the reader:

```typescript
function buildNfsExecutorDeps(
  config: AgentConfig,
  readMounts: () => Promise<Array<{ source: string; mountpoint: string }>>,
): NfsExecutorDeps {
  const helper = createNfsHelperClientFromProbe({
    helperSocket: config.nfs_helper_socket ?? DEFAULT_NFS_HELPER_SOCKET,
    timeoutMs: DEFAULT_NFS_HELPER_TIMEOUT_MS,
  });
  const readIdmapDomain = async (): Promise<string | undefined> => {
    try {
      const raw = await readFile(IDMAPD_CONF_PATH, 'utf8');
      return parseIdmapConf(raw).domain;
    } catch {
      return undefined;
    }
  };
  return { helper, readIdmapDomain, readMounts };
}
```

At the registration site, compute the resolved reader once and reuse it for both
the NFS deps and the xiRAID delete executor. Replace lines 202-217:

```typescript
  const resolvedReadMounts =
    opts.readMounts ?? (fdir !== null ? makeFixtureMounts(fdir) : readProcMounts);
  const nfsDeps = opts.nfsDeps ?? buildNfsExecutorDeps(config, resolvedReadMounts);
  for (const ex of buildNfsExecutors(nfsDeps)) {
    registry.register(ex);
  }
  // S3-xiraid T9: the create executor shares the convergence-built xiRAID
  // client with the observe collector (one daemon connection for both).
  if (opts.xiraidClient) {
    registry.register(makeXiraidArrayCreateExecutor({ client: opts.xiraidClient }));
    registry.register(makeXiraidArrayModifyExecutor({ client: opts.xiraidClient }));
    registry.register(makeXiraidArrayImportExecutor({ client: opts.xiraidClient }));
    registry.register(
      makeXiraidArrayDeleteExecutor({
        client: opts.xiraidClient,
        readMounts: resolvedReadMounts,
      }),
    );
  }
```

- [ ] **Step 6: Add the e2e mounts fixture**

Create `xiNAS-MCP/src/__tests__/e2e/__fixtures__/mounts.json` so the fixture-mode
executor sees a xiRAID mount covering the e2e export paths (`/srv/e2e-share`,
`/srv/e2e-fail`):

```json
[
  { "source": "/dev/xi_e2e", "mountpoint": "/srv" }
]
```

- [ ] **Step 7: Run the executor + e2e tests to verify green**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/nfs-executor.test.ts src/__tests__/e2e/nfs-roundtrip.test.ts`
Expected: PASS — the four new gate tests pass, the existing share.create tests
still pass (default `/dev/xi_data`@`/mnt/data` reader), and the e2e roundtrip
passes (mounts.json covers `/srv/*`).

- [ ] **Step 8: Typecheck**

Run: `cd xiNAS-MCP && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit (on user go-ahead — WITH rebuild trailer)**

```bash
git add xiNAS-MCP/src/agent/task/nfs-executor.ts xiNAS-MCP/src/agent/task/wiring.ts \
        xiNAS-MCP/src/__tests__/agent/task/nfs-executor.test.ts \
        xiNAS-MCP/src/__tests__/e2e/__fixtures__/mounts.json
git commit -m "feat(control-path): share.create preflight gates exports to xiRAID filesystems

Live, fail-closed check in buildShareCreate — the export path must be at-or-under
a /dev/xi_* mount, else EXPORT_PATH_NOT_ON_XIRAID. Threads the readMounts seam
(shared with the delete guard) through buildNfsExecutorDeps.

Requires-Rebuild: xinas_node_build"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Python suite + lint**

Run: `python -m pytest tests/test_xfs_path_helpers.py tests/test_nfs_wizard_helpers.py -q && ruff check xinas_menu/ && ruff format --check xinas_menu/utils/xfs_helpers.py xinas_menu/screens/nfs.py`
Expected: PASS / no lint errors. (The full `tests/` run needs `textual`; the
targeted files above do not.)

- [ ] **Step 2: TypeScript suite + typecheck**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/agent/task/nfs-executor.test.ts src/__tests__/e2e/nfs-roundtrip.test.ts && npx tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 3: Confirm the rebuild trailer is present exactly once (server commit only)**

Run: `git log --format='%H %s%n%b' feat/xiraid-only-shares | grep -c 'Requires-Rebuild: xinas_node_build'`
Expected: `1` — exactly the Task 5 commit carries it; the Python/doc commits do not.

- [ ] **Step 4: Confirm no stray files were staged**

Run: `git diff --stat main...feat/xiraid-only-shares -- docs/Management/user-management-spec.md tests/test_users_screen.py`
Expected: empty output — the other session's files were never committed on this branch.

---

## Self-review notes

- **Spec coverage:** design §"Surface 1" → Tasks 3–4; §"Surface 2" → Task 5;
  §"Small consolidation" → Task 2; §"Rebuild marker" → Task 5 Step 9 + Task 6
  Step 3; §"Testing" → Tasks 2,3,5. Spec-first (§owning specs) → Task 1.
- **Detection consistency:** `/dev/xi_` prefix used identically in
  `_xiraid_mount_points` (Task 3) and `containingMount` (Task 5). Containment uses
  `is_path_under` (Py) / `pathIsUnder` (TS) with the same segment-boundary rule.
- **No plan-side blocker:** deliberately omitted per the approved design; only the
  executor preflight enforces server-side.
- **Error strings:** `EXPORT_PATH_NOT_ON_XIRAID` (server), TUI notifications
  fixed-string — matched between plan, tests, and spec.
