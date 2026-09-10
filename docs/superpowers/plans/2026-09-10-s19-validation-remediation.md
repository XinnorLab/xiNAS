# S19 validation remediation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding of the 2026-09-10 external validation of S19
(F01–F10, D01, D02, B01) on `release/3.14`, so the agentic health check's
core claim — the verdict is bounded by evidence xiNAS produced, and the
active probes never touch foreign data — is true in code, spec and tests.

**Architecture:** Three lanes. Lane A (agent) makes collection failures
visible instead of empty (F04), hardens the probe host — `run_id` shape,
directory mode, inode-bound unlink, no recursive delete after an ambiguous
mount (F05–F07) — moves probe admission into the host so the legacy deep
path is serialized too (F08), and delegates the `fs_io` write to a PID1
transient unit with exactly one writable path because `ProtectSystem=strict`
makes every managed mountpoint read-only inside the agent (B01); the
baseline host gets absolute deadlines, a bounded queue and per-profile
coalescing (F09) and reports the digest of the profile bytes it actually
ran (F10). Lane B (api validator) binds a run to its principal and versions
(F03), records the proven `declared_absent` set in the ledger and computes
an **evidence floor** for every check from the raw reports the report
carries: a model outcome may never be more favourable than what
`health.check`, `health.baseline` and `health.probe.run` said, a check fed
by an omitted or tampered source cannot be `pass`, a `no_source` row cannot
claim a measurement, stale evidence cannot back a `pass` (F01, F02).
Lane C (docs) removes the contradictions (D01, D02), updates the fixtures
the floor exposes as unsafe, and adds the hardware rows that prove B01.

**Tech Stack:** TypeScript (Node ≥ 20, `xiNAS-MCP/`), vitest, biome,
JSON Schema 2020-12 (Ajv), systemd (`systemd-run`, `systemd-mount`),
markdown specs under `docs/control-path/`.

**Spec:** the validation report `~/Downloads/xinas-s19-validation.md`
(the findings; auditor's reproductions in
`/Users/sergeyplatonov/Documents/Codex/2026-09-09/df/work/xinas-s19-audit/xiNAS-MCP/src/__tests__/s19-audit.test.ts`
— every `expect` there documents the DEFECT, so each regression test below
is that test with the expectation inverted), and the live specs this plan
corrects: `docs/control-path/s19-mcp-health-prompt-spec.md` (§5.5, §6.3,
§7.1, §8.3, §8.4, §9.2, §9.3, §9.5, §11.2–§11.4, §16),
`docs/control-path/s19-mcp-health-prompt-requirements.md` (REPORT-02/03/06,
CHECK-01, G-01/02, PROBE-02/03, SAFE-04, CFG-02, AC-01..AC-20),
`docs/control-path/xinas-agent-s0s1-spec.md` (RPC table),
`docs/control-path/adr/0018-mcp-prompts-agentic-health-check.md` (§4),
`docs/control-path/api-v1.yaml`.

## Global Constraints

- Worktree `/Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/fix-s19-validation`,
  branch `fix/s19-validation-findings`, based on `origin/release/3.14` at
  `d50938d72c0147150e301cb216faa5ce6a189e7b` (the report's HEAD). The PR
  targets `release/3.14`, merged with `--merge` (never squash).
- **Every commit that changes a non-test file under `xiNAS-MCP/src/` ends
  with the trailer `Requires-Rebuild: xinas_node_build`** (CLAUDE.md
  §Update rebuild markers). Docs-only, fixture-only and test-only commits
  carry none. No task changes `xinas-agent.service`, so no `xinas_agent`
  trailer is needed.
- Commits use Conventional Commits (`fix(health): …`, `docs(control-path): …`)
  and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
  **Write the commit message to a file with the Write tool and commit with
  `git commit -F <file> -- <paths>`** — the worktree sandbox refuses
  heredocs and multi-line `-m` arguments.
- **Path-scoped commits only.** Never run a bare `git commit` or
  `git add -A`. Stage new files with `git add <file>`, then
  `git commit -F <msg> -- <every path of this task>`.
- Node: the machine's default Node 25 is what the auditor and the baseline
  run used (2530/2530 green); use it. `node_modules` and `dist/` are
  already present in the worktree (copied from the auditor's build of the
  same commit); do not run `npm ci`.
- Run every npm/npx command from `xiNAS-MCP/` with an absolute `cd`:
  `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/fix-s19-validation/xiNAS-MCP && …`
  (a relative `cd xiNAS-MCP` fails silently when the cwd already is
  `xiNAS-MCP`). Keep Bash commands plain — one command, absolute paths,
  no heredocs; write files with the Write/Edit tools.
- Spec-first rule (CLAUDE.md): each task edits the owning spec **before**
  the code, in the same commit. English only in every repository artifact.
- Lint/format: `biome` — single quotes, semicolons, trailing commas, width
  100. Run `npm run lint && npm run format:check` before each commit; fix
  formatting with `npm run format:write`.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on: use
  conditional spreads for optional keys, never `key: undefined`; index
  results are `T | undefined`.
- Vitest single-file runs: `npx vitest run src/__tests__/<path>.test.ts`.
  Full unit gate: `npx vitest run --maxWorkers=2 --minWorkers=1`.
- `docs/control-path/api-v1.yaml` is CI-gated by oasdiff: **only additive
  changes** (new optional response properties, description text). Never
  add enum values to an existing response enum, never add `pattern` /
  `format` to an existing request property — tighten in code and say so
  in the description.
- `lib/` imports nothing from `api/` or `agent/`; `api/` never imports
  `agent/` (structural copies of agent result shapes live in `api/`).
- Regression tests: every auditor reproduction (F01…F10) becomes a test in
  the module's own test file with the SAFE expectation; name each test
  with its finding id (`'F05: …'`) so the report can be traced.

## Lanes and ordering

| Lane | Tasks (in order) | Files owned |
|---|---|---|
| A — agent | 1 → 2 → 3 → 4 → 5 | `src/agent/net/host.ts`, `src/agent/rpc/methods/health-probe*.ts`, `src/agent/health/**`, `src/agent/rpc/methods/health-baseline.ts`, `src/api/health/baseline.ts`, `src/api/health/profiles.ts`, the matching tests, spec §7/§8/§9, agent spec RPC table, ADR-0018 §4, runbook |
| B — validator | 6 → 7 | `src/api/health/run-ledger.ts`, `report-integrity.ts`, `context.ts`, `src/api/routes/health.ts`, `src/lib/health/report-validate.ts`, new `src/lib/health/report-floor.ts`, fixtures, spec §5.5/§6.3/§11, `api-v1.yaml` |
| C — closure | 8 | `docs/TODO.md`, `hardware-smoke-runbook.md`, this plan |

Tasks 1–5 and 6–7 touch disjoint files and may be executed by different
subagents in that order; Task 8 runs last.

---

### Task 1: Collection failures stay visible (F04)

**Files:**
- Modify: `xiNAS-MCP/src/agent/net/host.ts` (`rdmaLinkShow`, ~line 131)
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` (`parseRdmaLinks` ~line 85, `makeDeepProbeRunner` ~line 268, `HealthProbeDeps.rdmaLinkShow` doc)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §7.1 (after the status table)
- Modify: `docs/control-path/xinas-agent-s0s1-spec.md` (`health.probe` row: "fresh rdma links")
- Test: `xiNAS-MCP/src/__tests__/agent/rpc/health-probe.test.ts`, `xiNAS-MCP/src/__tests__/agent/net/host.test.ts`

**Interfaces:**
- Produces: `rdmaLinkShow()` REJECTS on any non-zero exit (an `Error` with `code: 'ENOENT'` for exit 127, `code: 'EPERM'` when the output says "Operation not permitted"/"Permission denied", else `code: 'EXIT_<n>'`); `parseRdmaLinks()` throws `ProbeCollectionError('error', 'PARSE', …)` for a non-array; `makeDeepProbeRunner` rethrows an inventory failure as `ProbeCollectionError('error', 'INVENTORY_UNAVAILABLE', …)` so the whole `probes` section is `status: 'error'`.

- [ ] **Step 1: Amend the spec first.** In
  `docs/control-path/s19-mcp-health-prompt-spec.md` §7.1, right after the
  status-assignment table, add:

```markdown
> **Implemented (2026-09-10, validation F04).** Three production paths
> had collapsed failures into an empty success: `rdma link show -j`
> returned `''` on ANY non-zero exit (a permission refusal became "no
> links"), a JSON payload that was not an array became `[]`, and a failed
> managed-filesystem inventory became `fs_io: []`. Now: only exit 127 /
> `ENOENT` is `not_supported`; "Operation not permitted" / "Permission
> denied" in the tool output is `permission_denied` (`EPERM`); any other
> non-zero exit is `error` (`EXIT_<n>`); a payload that is not a JSON
> array is `error` (`PARSE`); and an inventory failure rejects the whole
> `probes` section with `error` (`INVENTORY_UNAVAILABLE`) — both deep
> checks then report "collection failed" instead of "no filesystems".
> A `success` + `[]` section still means "asked and found none".
```

  In `docs/control-path/xinas-agent-s0s1-spec.md`, in the `health.probe`
  row, change "fresh rdma links" to "fresh rdma links (a refused or
  failed `rdma` call is a typed failure, never an empty list)".

- [ ] **Step 2: Write the failing tests** (append to
  `src/__tests__/agent/rpc/health-probe.test.ts`; the file already imports
  `makeHealthProbeHandler`, `makeDeepProbeRunner` and `rdmaLiveCheck` /
  `filesystemIoCheck` may need adding from `../../../lib/health/standard.js`):

```ts
import { createRealNetHost } from '../../../agent/net/host.js';
import { filesystemIoCheck, rdmaLiveCheck } from '../../../lib/health/standard.js';

describe('F04: collection failures never become an empty success', () => {
  const base = {
    readLicenseText: async () => null,
    getCollectorHealth: () => ({}),
    dryRenderNfsProfile: async () => null,
  };

  it('F04: a non-array RDMA payload is a PARSE error, not an empty list', async () => {
    const run = makeHealthProbeHandler({ ...base, rdmaLinkShow: async () => '{"unexpected":"shape"}' });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({ status: 'error', error: { code: 'PARSE' } });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('degraded');
  });

  it('F04b: a failed managed-filesystem inventory fails the probes section', async () => {
    const runner = makeDeepProbeRunner({
      probeHost: {} as never,
      listMountedManaged: async () => {
        throw new Error('inventory unavailable');
      },
    });
    await expect(runner(null)).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE', status: 'error' });
    const run = makeHealthProbeHandler({
      ...base,
      rdmaLinkShow: async () => '[]',
      runDeepProbes: runner,
    });
    const result = await run({ level: 'deep' });
    expect(result.sections.probes).toMatchObject({ status: 'error', error: { code: 'INVENTORY_UNAVAILABLE' } });
    expect(filesystemIoCheck(result.sections.probes!).status).toBe('degraded');
  });

  it('F04c: the production RDMA adapter surfaces a permission refusal', async () => {
    const net = createRealNetHost({
      runCommand: async () => ({ stdout: 'Operation not permitted', code: 1 }),
    });
    const run = makeHealthProbeHandler({ ...base, rdmaLinkShow: () => net.rdmaLinkShow() });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({ status: 'permission_denied', error: { code: 'EPERM' } });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('degraded');
  });

  it('F04c: exit 127 (tool absent) is still not_supported and skipped', async () => {
    const net = createRealNetHost({ runCommand: async () => ({ stdout: '', code: 127 }) });
    const run = makeHealthProbeHandler({ ...base, rdmaLinkShow: () => net.rdmaLinkShow() });
    const result = await run({ level: 'standard' });
    expect(result.sections.rdma_links).toMatchObject({ status: 'not_supported' });
    expect(rdmaLiveCheck(result.sections.rdma_links).status).toBe('skipped');
  });
});
```

  Also add to `src/__tests__/agent/net/host.test.ts` (find the existing
  `rdmaLinkShow` case and replace its "returns '' on failure" expectation):

```ts
it('rdmaLinkShow rejects on a non-zero exit that is not 127', async () => {
  const host = createRealNetHost({ runCommand: async () => ({ stdout: 'boom', code: 2 }) });
  await expect(host.rdmaLinkShow()).rejects.toMatchObject({ code: 'EXIT_2' });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/agent/rpc/health-probe.test.ts src/__tests__/agent/net/host.test.ts`
Expected: the four F04 cases FAIL (`status: 'success'` where a failure is expected), the rest pass.

- [ ] **Step 4: Implement.** In `src/agent/net/host.ts` replace `rdmaLinkShow`:

```ts
    async rdmaLinkShow(): Promise<string> {
      const res = await run('rdma', ['link', 'show', '-j']);
      if (res.code === 0) return res.stdout;
      const text = res.stdout.trim();
      // 127 = the rdma tool is absent (no MOFED): a not_supported section, never an error.
      if (res.code === 127) {
        throw Object.assign(new Error('rdma: tool not found'), { code: 'ENOENT' });
      }
      if (/operation not permitted|permission denied/i.test(text)) {
        throw Object.assign(new Error(`rdma link show: ${text}`), { code: 'EPERM' });
      }
      throw Object.assign(new Error(`rdma link show exited ${res.code}: ${text}`), {
        code: `EXIT_${res.code}`,
      });
    },
```

  Update the interface comment: `/** \`rdma link show -j\` JSON text; rejects on failure (ENOENT = absent, EPERM = refused, EXIT_<n> otherwise). */`.

  In `src/agent/rpc/methods/health-probe.ts`:

```ts
/** `rdma link show -j` text → rows; '' is an empty list; anything that is not a JSON array is PARSE. */
export function parseRdmaLinks(raw: string): RdmaLink[] {
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProbeCollectionError('error', 'PARSE', `rdma link show: ${errMessage(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ProbeCollectionError('error', 'PARSE', 'rdma link show: payload is not a JSON array');
  }
  return parsed.filter((e): e is RdmaLink => typeof e === 'object' && e !== null);
}
```

  (`const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));` near the top.)
  In `makeDeepProbeRunner` replace the `try { … } catch { mountpoints = []; }` with:

```ts
    let mountpoints: string[];
    try {
      mountpoints = await opts.listMountedManaged();
    } catch (err) {
      throw new ProbeCollectionError(
        'error',
        'INVENTORY_UNAVAILABLE',
        `managed filesystem inventory failed: ${errMessage(err)}`,
      );
    }
```

  Update the `HealthProbeDeps.rdmaLinkShow` doc comment to "Rejects on failure; '' = no links".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/agent/rpc/health-probe.test.ts src/__tests__/agent/net/host.test.ts src/__tests__/lib/health/standard.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, then commit** (message file via Write):

```
fix(health): typed collection never hides a failed source (F04)

rdma link show: only exit 127 is "tool absent"; a permission refusal is
permission_denied and any other non-zero exit is an error. A payload that
is not a JSON array is a PARSE error. A failed managed-filesystem
inventory fails the probes section instead of reporting no filesystems.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

Run: `git commit -F <msg> -- xiNAS-MCP/src/agent/net/host.ts xiNAS-MCP/src/agent/rpc/methods/health-probe.ts xiNAS-MCP/src/__tests__/agent/rpc/health-probe.test.ts xiNAS-MCP/src/__tests__/agent/net/host.test.ts docs/control-path/s19-mcp-health-prompt-spec.md docs/control-path/xinas-agent-s0s1-spec.md`

---

### Task 2: Probe host hardening — run_id shape, directory mode, inode-bound unlink, no recursive delete (F05, F06, F07)

**Files:**
- Modify: `xiNAS-MCP/src/agent/health/probe-host.ts` (fsIo dir check ~line 225, unlink ~line 296, nfsLoopback ~lines 320–400)
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe-run.ts` (run_id validation ~line 44)
- Modify: `xiNAS-MCP/src/api/routes/health.ts` (`POST /health/probe` run_id ~line 500)
- Modify: `xiNAS-MCP/src/lib/health/probe-types.ts` (export `RUN_ID_RE`)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §9.2 (run_id), §9.3 (fs_io steps 2/4/6, loopback steps 2/3)
- Modify: `docs/control-path/api-v1.yaml` (`HealthProbeRunRequest.run_id` description only)
- Modify: `docs/control-path/hardware-smoke-runbook.md` (the `run_id: smoke-1` row)
- Test: `xiNAS-MCP/src/__tests__/agent/health/probe-host.test.ts`, `xiNAS-MCP/src/__tests__/agent/rpc/health-probe-run.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-health-probe.test.ts`

**Interfaces:**
- Produces: `RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` in `lib/health/probe-types.ts`; `health.probe.run` and `POST /health/probe` reject a non-matching `run_id` (`INVALID_PARAMS` / `INVALID_ARGUMENT`); the host itself refuses any `runId` outside `/^[A-Za-z0-9-]{1,64}$/` (`error.code: 'RUN_ID_INVALID'`, stage `lock`/`dir`); `ProbeCleanup.status` gains no new value — an unresolved state is `failed` with a `detail`.

- [ ] **Step 1: Amend the spec first.** §9.2: after "Body: …" add
  "`run_id`, when present, MUST be a run id minted by `health.context`
  (a UUID); any other string is `INVALID_ARGUMENT` on the api and
  `INVALID_PARAMS` on the agent — the id is embedded in artifact names,
  so it is validated before it reaches a path (validation F06)." §9.3
  fs_io step 2: add "and MUST NOT be group- or world-writable
  (`mode & 0o022 === 0`) — a root-owned 0777 directory is
  `probe_dir_untrusted` (validation F07)"; step 4/6: "the unlink is
  preceded by an `lstat` of the name; if the inode or device differs from
  the file this run created, nothing is unlinked and `cleanup` is
  `failed` with `detail: 'probe file was replaced; not removed'`
  (validation F07)". Loopback steps 2–3, replace the "directory is removed
  after a successful umount" sentence with: "After the mount step ends in
  ANY way other than success (timeout, error, killed client) the host
  still runs `systemd-umount <mnt>` — the client's death does not prove
  PID1 did not mount — then compares `st_dev` of `<mnt>` with its parent:
  a differing device means something is mounted and the directory is
  left in place with `cleanup: failed` (`detail: 'mountpoint still
  mounted'`); otherwise the two directories are removed with `rmdir`
  (never recursively). Nothing under a probe mountpoint is ever deleted
  (validation F05, PROBE-03)." In `api-v1.yaml`
  `HealthProbeRunRequest.run_id.description` append: "Must be the UUID
  `GET /health/context` minted; any other value is `INVALID_ARGUMENT`."
  In the runbook row, replace `run_id: smoke-1` with "`run_id: <the
  run_id from GET /health/context>` (any other value is
  `INVALID_ARGUMENT`)" and `probe-smoke-1-<random>` with
  `probe-<run_id>-<random>`.

- [ ] **Step 2: Write the failing tests.** Append to
  `src/__tests__/agent/health/probe-host.test.ts` (imports: add
  `existsSync`, `renameSync`, `statSync`, `lstatSync`, `chmodSync` from
  `node:fs`):

```ts
describe('validation F05/F06/F07 regressions', () => {
  it('F05: an ambiguous mount failure never deletes below the mountpoint and does not report clean', async () => {
    const root = fresh('f05');
    let marker = '';
    const called: string[] = [];
    const host = createRealProbeHost({
      root,
      exec: async (file, args) => {
        called.push(file);
        if (file === 'systemd-mount') {
          marker = join(args[2]!, 'FOREIGN-DATA');
          writeFileSync(marker, 'data visible at the mountpoint');
          throw new Error('mount client timed out after submission');
        }
      },
    });
    const r = await host.nfsLoopback('/export', { runId: 'run', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(called).toEqual(['systemd-mount', 'systemd-umount']);
    expect(existsSync(marker)).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/not empty|still mounted/);
  });

  it('F06: the host refuses a run id that could leave its root', async () => {
    const root = fresh('f06');
    let mounted = '';
    const host = createRealProbeHost({
      root,
      exec: async (file, args) => {
        if (file === 'systemd-mount') mounted = args[2]!;
      },
    });
    const r = await host.nfsLoopback('/export', { runId: '../outside', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('RUN_ID_INVALID');
    expect(mounted).toBe('');
    expect(readdirSync(root)).toEqual([]);
  });

  it('F07: a group/world-writable probe directory is untrusted', async () => {
    const mnt = fresh('f07-mode');
    mkdirSync(join(mnt, PROBE_DIR_NAME));
    chmodSync(join(mnt, PROBE_DIR_NAME), 0o777);
    const r = await createRealProbeHost().fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('probe_dir_untrusted');
    expect(r.cleanup.status).toBe('not_needed');
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);
  });

  it('F07: cleanup unlinks only the inode it created', async () => {
    const mnt = fresh('f07-inode');
    const dir = join(mnt, PROBE_DIR_NAME);
    let original = '';
    let replacement = '';
    const r = await createRealProbeHost().fsIo(mnt, opts, {
      beforeUnlink: () => {
        replacement = join(dir, readdirSync(dir)[0]!);
        original = `${replacement}.moved`;
        renameSync(replacement, original);
        writeFileSync(replacement, 'FOREIGN-DATA');
      },
    });
    expect(r.ok).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/replaced/);
    expect(readFileSync(replacement, 'utf8')).toBe('FOREIGN-DATA');
    expect(existsSync(original)).toBe(true);
  });
});
```

  Append to `src/__tests__/agent/rpc/health-probe-run.test.ts`:

```ts
it('F06: run_id must be a health.context UUID', async () => {
  const handler = makeHealthProbeRunHandler({ probeHost: fakeHost() });
  await expect(
    handler({ probe: 'nfs_loopback', path: '/export', run_id: '../outside', timeout_ms: 1000 }),
  ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(
    handler({ probe: 'fs_io', path: '/mnt/x', run_id: 'smoke-1', timeout_ms: 1000 }),
  ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});
```

  (Use whatever fake `ProbeHost` helper the file already defines; a
  `{ fsIo: async () => outcome, nfsLoopback: async () => outcome, busy: () => null }` literal is fine.)
  Append to `src/__tests__/api/routes-health-probe.test.ts` a case that
  POSTs `{ probe: 'fs_io', target: <the mounted fs id the file seeds>, run_id: '../outside' }`
  with the operator token and expects `400` with `error.code: 'INVALID_ARGUMENT'`
  and that the fake agent client was NOT called.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/agent/health/probe-host.test.ts src/__tests__/agent/rpc/health-probe-run.test.ts src/__tests__/api/routes-health-probe.test.ts`
Expected: the six new cases FAIL.

- [ ] **Step 4: Implement.** `src/lib/health/probe-types.ts`, add:

```ts
/** A run id `health.context` minted (UUID v4 shape); validated before it can reach a path. */
export const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What the probe host itself tolerates in an artifact name (deep passes null → 'none'). */
export const ARTIFACT_RUN_RE = /^[A-Za-z0-9-]{1,64}$/;
```

  `src/agent/health/probe-host.ts`:
  - add `import { lstat } from 'node:fs/promises'` / `stat` and `ARTIFACT_RUN_RE`;
  - a helper at the top of each verb:

```ts
const runIdInvalid = (runId: string | null, stage: ProbeStage): StageError | null =>
  runId !== null && !ARTIFACT_RUN_RE.test(runId)
    ? new StageError(stage, 'RUN_ID_INVALID', 'run id may only contain letters, digits and dashes')
    : null;
```

    In `fsIo`, before step 1: `const bad = runIdInvalid(opts.runId, 'dir'); if (bad !== null) throw bad;`
    (inside the try, so it lands in `error` with `cleanup: not_needed`).
    In `nfsLoopback`, before `if (loopbackBusy)`: the same with stage `'lock'`,
    returning the same shape `refused()` returns but with the `RUN_ID_INVALID` error.
  - dir trust (fsIo step 2), extend the condition:

```ts
        if (
          !dirStat.isDirectory() ||
          dirStat.dev !== mntStat.dev ||
          dirStat.uid !== uid ||
          (dirStat.mode & 0o022) !== 0
        ) {
          throw new StageError(
            'dir',
            'probe_dir_untrusted',
            `${PROBE_DIR_NAME} must be a directory on the mountpoint's device, owned by uid ${uid}, not group/world-writable`,
          );
        }
```

  - unlink (fsIo step 6): keep `fileIno`/`fileDev` from `fileStat` in outer scope (`let createdIno: { ino: number; dev: number } | undefined`), then:

```ts
        if (filePath !== undefined) {
          const path = filePath;
          try {
            await hooks?.beforeUnlink?.();
            const now = await lstat(path);
            if (
              createdIno === undefined ||
              !now.isFile() ||
              now.ino !== createdIno.ino ||
              now.dev !== createdIno.dev
            ) {
              cleanup = { status: 'failed', detail: 'probe file was replaced; not removed' };
            } else {
              await unlink(path);
              cleanup = { status: 'clean' };
            }
          } catch (err) {
            cleanup = { status: 'failed', detail: `${errCode(err)}: ${errMessage(err)}` };
          }
        }
```

  - loopback cleanup: replace the whole `finally { if (mounted) {…} else {…} }` block:

```ts
        } finally {
          // The client's death does not prove PID1 did not mount: always umount, then look.
          let umountError: string | null = null;
          if (mountAttempted) {
            try {
              await exec('systemd-umount', [mnt], UMOUNT_TIMEOUT_MS);
            } catch (err) {
              umountError = errMessage(err);
            }
          }
          const stillMounted = await isMountpoint(mnt);
          if (stillMounted) {
            cleanup = {
              status: 'failed',
              detail: `mountpoint still mounted${umountError !== null ? ` (systemd-umount: ${umountError})` : ''}`,
            };
          } else {
            try {
              await rmdir(mnt);
              await rmdir(dir);
              cleanup = { status: 'clean' };
            } catch (err) {
              cleanup = { status: 'failed', detail: `rmdir: ${errCode(err)}: ${errMessage(err)}` };
            }
          }
        }
```

    with `let mountAttempted = false;` set to `true` immediately before the
    `step('mount', …)` call, `mounted` removed, and:

```ts
/** A directory is a mountpoint when its device differs from its parent's. */
async function isMountpoint(path: string): Promise<boolean> {
  try {
    const [self, parent] = await Promise.all([stat(path), stat(join(path, '..'))]);
    return self.dev !== parent.dev;
  } catch {
    return false;
  }
}
```

    Note: when `systemd-umount` was never attempted (lock refused) the
    directory does not exist; keep the early-return paths as they are.
    `rmdir(mnt)` on a directory that holds foreign data fails with
    `ENOTEMPTY` → `cleanup: failed` with the errno, which is what F05 asserts.

  `src/agent/rpc/methods/health-probe-run.ts`: after computing `runId`:

```ts
    if (runId !== null && !RUN_ID_RE.test(runId)) {
      throw invalid('params.run_id must be the UUID health.context minted');
    }
```

  `src/api/routes/health.ts` (`POST /health/probe`): after computing `runId`:

```ts
      if (runId !== null && !RUN_ID_RE.test(runId)) {
        throw new ApiException('INVALID_ARGUMENT', 'run_id must be the UUID GET /health/context minted', {
          run_id: runId,
        });
      }
```

  (import `RUN_ID_RE` from `../../lib/health/probe-types.js`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/agent/health/probe-host.test.ts src/__tests__/agent/rpc/health-probe-run.test.ts src/__tests__/api/routes-health-probe.test.ts src/__tests__/api/routes-health-probe-budget.test.ts`
Expected: PASS. If `routes-health-probe-budget.test.ts` used a non-UUID run id, switch it to the id `GET /health/context` returns.

- [ ] **Step 6: Lint, then commit** with

```
fix(health): probe host never deletes foreign data (F05, F06, F07)

run_id is validated as the health.context UUID on the api and the agent
and cannot reach an artifact path; the probe directory must not be
group/world-writable; the unlink is bound to the inode this run created;
after an ambiguous mount result the host unmounts, checks the device and
removes directories with rmdir only, never recursively.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

and the paths of every file in this task's list.

---

### Task 3: One admission point for every active probe, and `fs_io` through a PID1 transient unit (F08, B01)

**Files:**
- Modify: `xiNAS-MCP/src/agent/health/probe-host.ts` (`ProbeHost` interface, `createRealProbeHost` gate + delegate)
- Create: `xiNAS-MCP/src/agent/health/fsio-child.ts` (the transient unit's entry)
- Modify: `xiNAS-MCP/src/agent/health/fake-probe-host.ts` (`busy()`)
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` (`makeProbeHost` → `fsIoMode: 'pid1'`)
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe-run.ts` (consult `probeHost.busy()`)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §9.3 (new "Execution boundary" paragraph), §9.5 (admission)
- Modify: `docs/control-path/adr/0018-mcp-prompts-agentic-health-check.md` §4 (one paragraph) and Consequences (one bullet)
- Modify: `docs/control-path/xinas-agent-s0s1-spec.md` (`health.probe.run` row: "One probe in flight per node" sentence)
- Test: `xiNAS-MCP/src/__tests__/agent/health/probe-host.test.ts`, new `xiNAS-MCP/src/__tests__/agent/health/fsio-child.test.ts`, `xiNAS-MCP/src/__tests__/agent/rpc/health-probe-run.test.ts`, new e2e `xiNAS-MCP/src/__tests__/e2e/fsio-child.test.ts`

**Interfaces:**
- Produces: `ProbeHost.busy(): { probe: ProbeKind; path: string } | null`; `RealProbeHostDeps.fsIoMode?: 'in_process' | 'pid1'` (default `in_process`) and `execCapture?: (file, args, timeoutMs) => Promise<{ stdout: string; stderr: string; code: number }>`; `export const FSIO_CHILD = new URL('./fsio-child.js', import.meta.url)`; `runFsIoChild(argv: string[]): Promise<ProbeOutcome>` exported from `fsio-child.ts`; a refused probe is `error.code: 'PROBE_IN_PROGRESS'`, `stage: 'lock'` from either verb.

- [ ] **Step 1: Amend the spec first.** §9.5 first bullet, replace the
  *Implemented (S19a)* note with: "*Implemented (S19a; amended 2026-09-10,
  validation F08):* the `ProbeHost` itself is the admission point — both
  verbs share one in-flight record, so the legacy deep path
  (`health.check profile=deep`) and `health.probe.run` can never overlap;
  the RPC handler asks `busy()` first and maps a refusal to `-32000`
  `PROBE_IN_PROGRESS`; the api maps that to `409`." §9.3, add after the
  fs_io *Implemented* note:

```markdown
> **Execution boundary (2026-09-10, validation B01).** `xinas-agent.service`
> runs under `ProtectSystem=strict`; every filesystem mounted before the
> agent started is read-only inside its mount namespace (observed on
> xinas-box: `nsenter -t <agent pid> -m findmnt /mnt/data` → `ro` while
> the host has `rw`), so an in-process `fs_io` fails with `EROFS` on every
> installed node. The write therefore runs OUTSIDE the agent's namespace,
> the way the loopback mount already does: the host spawns
> `systemd-run --wait --pipe --collect --quiet --unit xinas-health-fsio-<random>
> -p ProtectSystem=strict -p ReadWritePaths=<mountpoint> -p PrivateTmp=true
> -p ProtectHome=true -p NoNewPrivileges=true -p RuntimeMaxSec=<timeout_s + 5>
> /usr/bin/node <dist>/agent/health/fsio-child.js <mountpoint> <run_id|none> <timeout_ms>`.
> The transient unit runs the SAME hardened `fs_io` (steps 1–6 above) as
> root with exactly one writable path and prints the `ProbeOutcome` as
> JSON on stdout; the agent parses it. A helper that exits non-zero or
> prints no outcome is `ok: false`, `error.code: FSIO_HELPER_FAILED`,
> `cleanup: failed` ("artifact state unknown") — never `clean`. Tests and
> fixture mode run the in-process implementation (`fsIoMode: 'in_process'`);
> production wiring (`makeProbeHost`) selects `'pid1'`. Verified on
> systemd 255: `ReadWritePaths=<mountpoint>` under `ProtectSystem=strict`
> re-binds an existing submount read-write (`hardware-smoke-runbook.md`).
```

  ADR-0018 §4, append: "The `fs_io` write runs in a PID1 transient unit
  with `ReadWritePaths=<mountpoint>` because the agent's own
  `ProtectSystem=strict` namespace mounts every pre-existing filesystem
  read-only (2026-09-10 amendment, validation B01); the agent's unit file
  is unchanged." Consequences, add: "- The agent delegates the `fs_io`
  probe to `systemd-run`; `dist/agent/health/fsio-child.js` is a second
  entry point built by the same `tsc` run." Agent spec row: "One probe in
  flight per node (any kind, deep included; the ProbeHost is the
  admission point)".

- [ ] **Step 2: Write the failing tests.** `src/__tests__/agent/health/probe-host.test.ts`:

```ts
describe('F08: one active probe per node, any entry point', () => {
  it('refuses a loopback while an fs_io is in flight, and the reverse', async () => {
    const mnt = fresh('gate-a');
    const host = createRealProbeHost({
      root: fresh('gate-root'),
      exec: async () => undefined,
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = host.fsIo(mnt, opts, { beforeFsync: () => held });
    await new Promise((r) => setTimeout(r, 20));
    expect(host.busy()).toEqual({ probe: 'fs_io', path: mnt });
    const second = await host.nfsLoopback('/export', { runId: 'run-1', timeoutMs: 1000 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatchObject({ code: 'PROBE_IN_PROGRESS', stage: 'lock' });
    release();
    expect((await first).ok).toBe(true);
    expect(host.busy()).toBeNull();
    const third = await host.fsIo(mnt, opts);
    expect(third.ok).toBe(true);
  });
});

describe('B01: fs_io delegated to a PID1 transient unit', () => {
  const outcome = {
    ok: true,
    started_at: '2026-09-10T00:00:00.000Z',
    completed_at: '2026-09-10T00:00:01.000Z',
    artifact: { kind: 'file', path: '/mnt/data/.xinas-health/probe-none-abc' },
    cleanup: { status: 'clean' },
  };
  it('spawns systemd-run with one writable path and returns the child outcome', async () => {
    const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      random: () => 'cafebabecafebabe',
      execCapture: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs });
        return { stdout: `${JSON.stringify(outcome)}\n`, stderr: '', code: 0 };
      },
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 20_000 });
    expect(r).toEqual(outcome);
    expect(calls).toHaveLength(1);
    const { file, args, timeoutMs } = calls[0]!;
    expect(file).toBe('systemd-run');
    expect(args.slice(0, 5)).toEqual(['--wait', '--pipe', '--collect', '--quiet', '--unit']);
    expect(args[5]).toBe('xinas-health-fsio-cafebabecafebabe');
    expect(args).toContain('ReadWritePaths=/mnt/data');
    expect(args).toContain('ProtectSystem=strict');
    expect(args).toContain('RuntimeMaxSec=25');
    expect(args.at(-3)).toMatch(/agent\/health\/fsio-child\.(js|ts)$/);
    expect(args.slice(-2)).toEqual(['none', '20000']);
    expect(timeoutMs).toBe(20_000);
  });
  it('a helper that exits non-zero or prints no outcome is a failed probe with unknown cleanup', async () => {
    const host = createRealProbeHost({
      fsIoMode: 'pid1',
      execCapture: async () => ({ stdout: '', stderr: 'Failed to start transient service unit', code: 1 }),
    });
    const r = await host.fsIo('/mnt/data', { runId: null, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'FSIO_HELPER_FAILED', stage: 'open' });
    expect(r.error?.message).toContain('Failed to start');
    expect(r.cleanup).toEqual({ status: 'failed', detail: 'artifact state unknown: helper exited 1' });
  });
});
```

  New `src/__tests__/agent/health/fsio-child.test.ts`:

```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFsIoChild } from '../../../agent/health/fsio-child.js';
import { PROBE_DIR_NAME } from '../../../lib/health/probe-types.js';

const base = mkdtempSync(join(tmpdir(), 'xinas-fsio-child-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('fsio-child (B01)', () => {
  it('runs the hardened fs_io on the given mountpoint and returns the outcome', async () => {
    const r = await runFsIoChild([base, 'none', '5000']);
    expect(r.ok).toBe(true);
    expect(r.artifact?.path.startsWith(join(base, PROBE_DIR_NAME, 'probe-none-'))).toBe(true);
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(join(base, PROBE_DIR_NAME))).toEqual([]);
  });
  it('bad arguments are an outcome, not a crash', async () => {
    const r = await runFsIoChild(['relative/path', 'none', 'x']);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_ARGS');
  });
});
```

  New `src/__tests__/e2e/fsio-child.test.ts` (runs after `npm run build`, like the other e2e files — copy their `dist` resolution):

```ts
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const child = resolve(__dirname, '../../../dist/agent/health/fsio-child.js');
const base = mkdtempSync(join(tmpdir(), 'xinas-fsio-e2e-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('dist/agent/health/fsio-child.js', () => {
  it('prints one JSON ProbeOutcome and exits 0', async () => {
    const { stdout } = await run(process.execPath, [child, base, 'none', '5000']);
    const outcome = JSON.parse(stdout) as { ok: boolean; cleanup: { status: string } };
    expect(outcome.ok).toBe(true);
    expect(outcome.cleanup.status).toBe('clean');
  });
});
```

  (If the e2e config uses ESM without `__dirname`, use `fileURLToPath(new URL('../../../dist/agent/health/fsio-child.js', import.meta.url))` like the neighbouring e2e tests do.)

  `src/__tests__/agent/rpc/health-probe-run.test.ts`:

```ts
it('F08: a probe held by the host (deep path) refuses a direct probe with PROBE_IN_PROGRESS', async () => {
  const host = { ...fakeHost(), busy: () => ({ probe: 'fs_io' as const, path: '/mnt/data' }) };
  const handler = makeHealthProbeRunHandler({ probeHost: host });
  await expect(
    handler({ probe: 'nfs_loopback', path: '/export', timeout_ms: 1000 }),
  ).rejects.toMatchObject({ code: 'PROBE_IN_PROGRESS', details: { probe: 'fs_io', path: '/mnt/data' } });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/agent/health/ src/__tests__/agent/rpc/health-probe-run.test.ts`
Expected: FAIL (`busy` is not a function; `fsIoMode` unknown; module `fsio-child` missing).

- [ ] **Step 4: Implement.** `probe-host.ts`:
  - interface:

```ts
export interface ProbeHost {
  fsIo(mountpoint: string, opts: ProbeRunOptions, hooks?: FsIoHooks): Promise<ProbeOutcome>;
  nfsLoopback(exportPath: string, opts: ProbeRunOptions): Promise<ProbeOutcome>;
  /** The probe in flight on this host (any kind, any entry point), or null. */
  busy(): { probe: ProbeKind; path: string } | null;
}

export interface ExecCaptureResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RealProbeHostDeps {
  root?: string;
  uid?: number;
  random?: () => string;
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>;
  /** Captures stdout for the fs_io helper; default execFile (non-zero exit resolves with its code). */
  execCapture?: (file: string, args: string[], timeoutMs: number) => Promise<ExecCaptureResult>;
  /** `pid1` (production): fs_io runs in a systemd-run transient unit; `in_process` (default): here. */
  fsIoMode?: 'in_process' | 'pid1';
  clock?: () => number;
}

export const FSIO_CHILD = new URL('./fsio-child.js', import.meta.url);
```

  - inside `createRealProbeHost`: `let inFlight: { probe: ProbeKind; path: string } | null = null;`
    and a wrapper used by both public verbs:

```ts
  const admitted = async (
    probe: ProbeKind,
    path: string,
    startedAt: string,
    run: () => Promise<ProbeOutcome>,
  ): Promise<ProbeOutcome> => {
    if (inFlight !== null) {
      return {
        ok: false,
        started_at: startedAt,
        completed_at: new Date(clock()).toISOString(),
        artifact: null,
        error: {
          code: 'PROBE_IN_PROGRESS',
          message: `a ${inFlight.probe} probe is in flight on ${inFlight.path}`,
          stage: 'lock',
        },
        cleanup: { status: 'not_needed' },
      };
    }
    inFlight = { probe, path };
    try {
      return await run();
    } finally {
      inFlight = null;
    }
  };
```

    Rename the existing verb bodies to `fsIoInProcess(mountpoint, opts, hooks)`
    and `nfsLoopbackInner(exportPath, opts)` (module-level functions taking
    the deps they need, or closures inside `createRealProbeHost`), and
    return:

```ts
  return {
    fsIo: (mountpoint, opts, hooks) =>
      admitted('fs_io', mountpoint, new Date(clock()).toISOString(), () =>
        fsIoMode === 'pid1' ? fsIoViaPid1(mountpoint, opts) : fsIoInProcess(mountpoint, opts, hooks),
      ),
    nfsLoopback: (exportPath, opts) =>
      admitted('nfs_loopback', exportPath, new Date(clock()).toISOString(), () =>
        nfsLoopbackInner(exportPath, opts),
      ),
    busy: () => (inFlight === null ? null : { ...inFlight }),
  };
```

    The `loopbackBusy` flag becomes redundant; remove it (the lock file stays).
  - the delegate:

```ts
  async function fsIoViaPid1(mountpoint: string, opts: ProbeRunOptions): Promise<ProbeOutcome> {
    const startedAt = new Date(clock()).toISOString();
    const unit = `xinas-health-fsio-${random()}`;
    const args = [
      '--wait',
      '--pipe',
      '--collect',
      '--quiet',
      '--unit',
      unit,
      '-p',
      'ProtectSystem=strict',
      '-p',
      `ReadWritePaths=${mountpoint}`,
      '-p',
      'PrivateTmp=true',
      '-p',
      'ProtectHome=true',
      '-p',
      'NoNewPrivileges=true',
      '-p',
      `RuntimeMaxSec=${Math.ceil(opts.timeoutMs / 1000) + 5}`,
      process.execPath,
      fileURLToPath(FSIO_CHILD),
      mountpoint,
      opts.runId ?? 'none',
      String(opts.timeoutMs),
    ];
    const failed = (message: string, detail: string): ProbeOutcome => ({
      ok: false,
      started_at: startedAt,
      completed_at: new Date(clock()).toISOString(),
      artifact: null,
      error: { code: 'FSIO_HELPER_FAILED', message, stage: 'open' },
      cleanup: { status: 'failed', detail },
    });
    let res: ExecCaptureResult;
    try {
      res = await execCapture('systemd-run', args, opts.timeoutMs);
    } catch (err) {
      return failed(`systemd-run: ${errMessage(err)}`, 'artifact state unknown: helper did not run');
    }
    if (res.code !== 0) {
      return failed(
        `systemd-run exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
        `artifact state unknown: helper exited ${res.code}`,
      );
    }
    const parsed = parseOutcome(res.stdout);
    if (parsed === null) {
      return failed('the fs_io helper printed no outcome', 'artifact state unknown: no outcome');
    }
    return parsed;
  }
```

    with `parseOutcome(text)` = `JSON.parse` of the last non-empty line,
    returning the object when it has boolean `ok`, string `started_at` /
    `completed_at`, a `cleanup.status` in `clean|failed|not_needed`, else
    `null`. Default `execCapture`:

```ts
const defaultExecCapture = (file: string, args: string[], timeoutMs: number): Promise<ExecCaptureResult> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs + 5_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 127;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      },
    );
  });
```

  - `fsio-child.ts`:

```ts
/**
 * The fs_io helper the agent runs as a PID1 transient unit (S19 §9.3
 * "Execution boundary", validation B01): `node fsio-child.js <mountpoint>
 * <run_id|none> <timeout_ms>` → one JSON ProbeOutcome on stdout, exit 0.
 * Every failure, including bad arguments, is an outcome — the parent
 * treats a non-zero exit as "artifact state unknown".
 */
import { fileURLToPath } from 'node:url';
import type { ProbeOutcome } from '../../lib/health/probe-types.js';
import { createRealProbeHost } from './probe-host.js';

export async function runFsIoChild(argv: string[]): Promise<ProbeOutcome> {
  const now = new Date().toISOString();
  const [mountpoint, runArg, timeoutArg] = argv;
  const timeoutMs = Number(timeoutArg);
  if (
    mountpoint === undefined ||
    !mountpoint.startsWith('/') ||
    runArg === undefined ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000
  ) {
    return {
      ok: false,
      started_at: now,
      completed_at: now,
      artifact: null,
      error: { code: 'INVALID_ARGS', message: 'usage: fsio-child <mountpoint> <run_id|none> <timeout_ms>', stage: 'open' },
      cleanup: { status: 'not_needed' },
    };
  }
  const host = createRealProbeHost({ fsIoMode: 'in_process' });
  return host.fsIo(mountpoint, { runId: runArg === 'none' ? null : runArg, timeoutMs });
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runFsIoChild(process.argv.slice(2)).then(
    (outcome) => {
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      process.exitCode = 0;
    },
    (err) => {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          artifact: null,
          error: { code: 'ERROR', message: err instanceof Error ? err.message : String(err), stage: 'open' },
          cleanup: { status: 'failed', detail: 'helper crashed' },
        })}\n`,
      );
      process.exitCode = 0;
    },
  );
}
```

  - `fake-probe-host.ts`: add `busy: () => null,` to the returned object.
  - `health-probe.ts` `makeProbeHost`: `createRealProbeHost({ fsIoMode: 'pid1' })`.
  - `health-probe-run.ts`: replace the `inFlight` check with

```ts
    const held = deps.probeHost.busy();
    if (held !== null) {
      throw Object.assign(new Error('a health probe is already in flight on this node'), {
        code: 'PROBE_IN_PROGRESS',
        details: { ...held },
      });
    }
```

    keep the handler's own `inFlight` as a second, fast guard (unchanged),
    and after the verb returns, if `outcome.error?.code === 'PROBE_IN_PROGRESS'`
    throw the same RPC error (the host refused between `busy()` and the call).

- [ ] **Step 5: Run the tests to verify they pass; build; run the e2e file**

Run: `npx vitest run src/__tests__/agent/ src/__tests__/api/routes-health-probe.test.ts && npm run build && npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/fsio-child.test.ts src/__tests__/e2e/health-support.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, then commit** with

```
fix(health): one probe admission point; fs_io runs in a PID1 unit (F08, B01)

The ProbeHost is the admission point for every active probe, so the
legacy deep path and health.probe.run can no longer overlap. Under
ProtectSystem=strict every pre-existing mountpoint is read-only inside
the agent (verified on xinas-box), so the fs_io write now runs in a
systemd-run transient unit with ReadWritePaths=<mountpoint>, through the
same hardened steps, and reports the helper's outcome verbatim.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 4: Baseline host — absolute deadlines, a bounded queue, per-profile coalescing (F09)

**Files:**
- Modify: `xiNAS-MCP/src/agent/health/baseline-host.ts` (`makeBaselineHost` ~lines 228–377)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §8.3 (the *Implemented* note's concurrency sentences)
- Modify: `docs/control-path/xinas-agent-s0s1-spec.md` (`health.baseline` Real row: "One engine subprocess at a time; concurrent callers of the same profile share the run.")
- Test: `xiNAS-MCP/src/__tests__/agent/health/baseline-host.test.ts`

**Interfaces:**
- Produces: `BaselineHostDeps.maxQueued?: number` (default 4); a run whose deadline (`now + timeoutMs` at the moment `run()` is called) passes while queued returns `status: 'timeout'`, `error.code: 'TIMEOUT'`, `message: 'the engine queue exceeded the caller deadline'` WITHOUT spawning; a caller joining a queued/running run of the same resolved profile gets that run's result or its OWN timeout; a fifth distinct queued profile is `status: 'error'`, `error.code: 'QUEUE_FULL'`.

- [ ] **Step 1: Amend the spec first.** §8.3 *Implemented* note, replace
  "Concurrency is per profile: two callers of the same profile share one
  subprocess; a different profile waits for the running one (one engine
  subprocess per agent at any time)." with: "Concurrency (amended
  2026-09-10, validation F09): the deadline is absolute from the moment
  the RPC arrives (`now + timeout_s`), not from spawn; a queued run whose
  deadline passes before its turn is `timeout` without a spawn; callers
  are coalesced by the profile's realpath across the WHOLE queue (A, B, A
  spawns A once), each joiner keeping its own deadline; at most four
  distinct profiles wait (`QUEUE_FULL` beyond that); the `--sections`
  call queues under the same rules." Same sentence in the agent spec row.

- [ ] **Step 2: Write the failing tests** (append inside the `BaselineHost`
  describe of `baseline-host.test.ts`, using its `stub`/`host` helpers):

```ts
  it('F09: a queued caller times out on its own deadline and A-B-A spawns A once', async () => {
    const b = join(profiles, 'b.yml');
    writeFileSync(b, 'profile: b\n');
    const python = stub('slow.sh', 'echo run >> "$PWD/runs"; sleep 0.2; echo "{}"');
    const h = host({ python, module_root: dir, profiles_dir: profiles, log_dir: dir });
    const started = Date.now();
    const p1 = h.run(quick, 1000);
    const p2 = h.run(b, 50);
    const p3 = h.run(quick, 1000);
    const r2 = await p2;
    expect(Date.now() - started).toBeLessThan(180);
    expect(r2.status).toBe('timeout');
    expect(r2.error?.code).toBe('TIMEOUT');
    const [r1, r3] = await Promise.all([p1, p3]);
    expect(r1.status).toBe('success');
    expect(r3).toBe(r1);
    expect(readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('F09: a joiner keeps its own deadline', async () => {
    const python = stub('slow2.sh', 'sleep 0.3; echo "{}"');
    const h = host({ python, module_root: dir, profiles_dir: profiles, log_dir: dir });
    const p1 = h.run(quick, 1000);
    const p2 = h.run(quick, 50);
    expect((await p2).status).toBe('timeout');
    expect((await p1).status).toBe('success');
  });

  it('F09: the queue is bounded', async () => {
    const python = stub('slow3.sh', 'sleep 0.2; echo "{}"');
    const h = host({ python, module_root: dir, profiles_dir: profiles, log_dir: dir }, { maxQueued: 2 });
    const names = ['q1', 'q2', 'q3'].map((n) => {
      const p = join(profiles, `${n}.yml`);
      writeFileSync(p, `profile: ${n}\n`);
      return p;
    });
    const results = await Promise.all([h.run(names[0]!, 1000), h.run(names[1]!, 1000), h.run(names[2]!, 1000)]);
    expect(results.map((r) => r.status)).toEqual(['success', 'success', 'error']);
    expect(results[2]?.error?.code).toBe('QUEUE_FULL');
  });
```

  (`host()` in that file wraps `makeBaselineHost(config, deps)`; pass `{ maxQueued: 2 }` as the deps argument — extend the helper if it only takes the config.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/agent/health/baseline-host.test.ts`
Expected: the three F09 cases FAIL (p2 takes > 180 ms, three spawns, no QUEUE_FULL).

- [ ] **Step 4: Implement** in `makeBaselineHost` — replace `inFlight`/`chain`/`queue` with:

```ts
  const maxQueued = deps.maxQueued ?? 4;
  /** Queued or running runs by resolved profile path (coalescing key). */
  const pending = new Map<string, Promise<BaselineRunResult>>();
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const timedOut = (): BaselineRunResult =>
    failedRun(
      { code: 'TIMEOUT', message: 'the engine queue exceeded the caller deadline' },
      'timeout',
    );
  /** A joiner waits for the shared run, but never past its own deadline. */
  const withDeadline = (
    shared: Promise<BaselineRunResult>,
    deadline: number,
  ): Promise<BaselineRunResult> =>
    new Promise((resolve) => {
      const left = deadline - now();
      const timer = setTimeout(() => resolve(timedOut()), Math.max(0, left));
      shared.then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        () => {
          clearTimeout(timer);
          resolve(failedRun({ code: 'ERROR', message: 'the shared run failed' }));
        },
      );
    });
```

  and `run()`:

```ts
    run(profilePath, timeoutMs) {
      const resolved = resolveProfile(profilePath);
      if ('error' in resolved) return Promise.resolve(failedRun(resolved.error));
      const deadline = now() + timeoutMs;
      const shared = pending.get(resolved.path);
      if (shared !== undefined) return withDeadline(shared, deadline);
      if (pending.size >= maxQueued) {
        return Promise.resolve(
          failedRun({ code: 'QUEUE_FULL', message: `${maxQueued} baseline profiles are already queued` }),
        );
      }
      const promise = enqueue(async () => {
        const left = deadline - now();
        if (left <= 0) return timedOut();
        return runOnce(resolved.path, left);
      }).finally(() => {
        if (pending.get(resolved.path) === promise) pending.delete(resolved.path);
      });
      pending.set(resolved.path, promise);
      return promise;
    },
```

  `sections(timeoutMs)`: compute `deadline` at entry and inside `enqueue`
  check `left = deadline - now()`; `left <= 0` → the timeout-shaped
  `BaselineSections`; otherwise `runEngine(…, left, …)`.
  Add `maxQueued?: number` to `BaselineHostDeps` with a doc comment.
  Update the module header comment ("One engine subprocess runs at a
  time…") to describe the deadline, the bound and the coalescing key.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/agent/health/baseline-host.test.ts src/__tests__/agent/rpc/health-baseline.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, then commit** with

```
fix(health): baseline deadlines are absolute; runs coalesce by profile (F09)

The deadline starts when the RPC arrives, a queued run whose deadline
passed never spawns, a caller joining a queued or running profile keeps
its own deadline, and the queue holds at most four distinct profiles.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 5: The digest of the profile bytes that actually ran (F10, D01)

**Files:**
- Modify: `xiNAS-MCP/src/agent/health/baseline-host.ts` (`runOnce`: hash the file)
- Modify: `xiNAS-MCP/src/api/health/baseline.ts` (`AgentBaselineRun.profile_sha256`, `BaselineResponse.profile.sha256_changed`, `runBaseline`)
- Modify: `xiNAS-MCP/src/api/health/profiles.ts` (export `sha256OfFile(path): string | null`)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §8.3 (result block: `profile_sha256`), §8.4 (cache + provenance)
- Modify: `docs/control-path/xinas-agent-s0s1-spec.md` (delete the `health.baseline` **Planned** row; add `profile_sha256` to the Real row's result)
- Modify: `docs/control-path/api-v1.yaml` (`HealthBaselineResponse.profile`: add `sha256_changed`, reword `sha256` description)
- Test: `xiNAS-MCP/src/__tests__/agent/health/baseline-host.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-health-baseline.test.ts`

**Interfaces:**
- Produces: agent `BaselineRunResult.profile_sha256: string | null` (hex of the bytes read from the realpath immediately before spawn; null on a failed read); api `BaselineResponse.profile.sha256` = the executed digest (falls back to the api's own fresh hash when the agent is older), `profile.sha256_changed: boolean` (true when it differs from the catalog snapshot taken at startup — the snapshot is then refreshed so `health.context` lists the current one); the cache entry is served only when its digest equals the current file's.

- [ ] **Step 1: Amend the spec first.** §8.3 result block: add
  `"profile_sha256": "<hex>" | null,   // sha256 of the profile bytes the engine received, read just before spawn` and, in the *Implemented* note, "(amended 2026-09-10, validation F10) the agent hashes the profile immediately before it spawns the engine and returns `profile_sha256`; the api reports THAT digest as `profile.sha256`, marks `sha256_changed: true` when it differs from the catalog snapshot listed at startup and refreshes the snapshot, and serves a cached result only when the file's current digest equals the cached one — an edited profile is never served under an old hash (CFG-02, AC-07)." §8.4 gets the same cache sentence. Agent spec: delete the whole `health.baseline` **Planned (S19c, ADR-0018 — design, not yet implemented)** row (D01); in the Real row's result add `profile_sha256`. `api-v1.yaml` `profile.sha256` description: "sha256 of the profile bytes the engine actually ran (from the agent); the catalog snapshot when the agent is older." and add `sha256_changed: { type: boolean, description: True when the executed digest differs from the snapshot the api listed at startup; the snapshot is refreshed. }`.

- [ ] **Step 2: Write the failing tests.** `baseline-host.test.ts`:

```ts
  it('F10: the result carries the sha256 of the bytes the engine received', async () => {
    const python = stub('echo.sh', 'echo "{}"');
    const h = host({ python, module_root: dir, profiles_dir: profiles, log_dir: dir });
    const first = await h.run(quick, 1000);
    writeFileSync(quick, 'profile: quick\nexpectations: {net_mtu: 1500}\n');
    const second = await h.run(quick, 1000);
    expect(first.profile_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.profile_sha256).not.toBe(first.profile_sha256);
  });
```

  `routes-health-baseline.test.ts` (it already builds an app with a fake
  agent client and a temp profiles dir; follow its helpers):

```ts
  it('F10: an edited profile runs under its new digest, is flagged, and is not served from the old cache', async () => {
    // arrange: profiles dir with standard.yml = OLD; fake client echoes readFileSync(params.profile_path)
    //          as report.executed_profile and returns profile_sha256 = sha256Hex(those bytes)
    const first = await get('/api/v1/health/baseline?profile=standard&max_age_s=0');
    expect(first.body.result.profile.sha256_changed).toBe(false);
    writeFileSync(profilePath, CHANGED);
    const cached = await get('/api/v1/health/baseline?profile=standard&max_age_s=3600');
    expect(cached.body.result.collection.from_cache).toBe(false);       // digest differs → miss
    expect(cached.body.result.report.executed_profile).toBe(CHANGED);
    expect(cached.body.result.profile.sha256).toBe(sha256Hex(CHANGED));
    expect(cached.body.result.profile.sha256_changed).toBe(true);
    const ctx = await get('/api/v1/health/context');
    const listed = ctx.body.result.baselines.profiles.find((p: { name: string }) => p.name === 'standard');
    expect(listed.sha256).toBe(sha256Hex(CHANGED));
  });
```

  (`sha256Hex` is exported by `src/api/mcp/prompts/health-check.ts`.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/agent/health/baseline-host.test.ts src/__tests__/api/routes-health-baseline.test.ts`
Expected: FAIL (`profile_sha256` undefined; cache hit; `sha256_changed` undefined).

- [ ] **Step 4: Implement.** Agent `runOnce`: before `runEngine`,

```ts
    let profileSha256: string | null = null;
    try {
      profileSha256 = createHash('sha256').update(readFileSync(real)).digest('hex');
    } catch {
      profileSha256 = null;
    }
```

  and spread `profile_sha256: profileSha256` into every result branch of
  `runOnce` (the `failedRun` helper gets `profile_sha256: null`). Add the
  field to `BaselineRunResult`.
  `profiles.ts`:

```ts
/** sha256 hex of a profile file right now; null when unreadable. */
export function sha256OfFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}
```

  `api/health/baseline.ts`: `AgentBaselineRun` gains `profile_sha256?: string | null`;
  `BaselineResponse.profile` gains `sha256_changed: boolean`; `profileBlock`
  takes an extra `sha256: string | null` and `changed: boolean` and sets both
  (`profileBlock(profile, timeoutS, engine, sha256, changed)`). In `runBaseline`:

```ts
  const current = profile.path === null ? null : sha256OfFile(profile.path);
  const changedFromListed = current !== null && profile.sha256 !== null && current !== profile.sha256;
  const cached = hp.baselineCache.get(profile.name);
  if (deps.maxAgeS > 0 && cached !== undefined && cached.result.profile.sha256 === current) { …serve as before, profile block with sha256: current, sha256_changed: changedFromListed… }
  …
  const executed = typeof run.profile_sha256 === 'string' ? run.profile_sha256 : current;
  const changed = executed !== null && profile.sha256 !== null && executed !== profile.sha256;
  if (changed) profile.sha256 = executed;      // refresh the startup snapshot for health.context
  const result: BaselineResponse = { profile: profileBlock(profile, timeoutS, engine, executed, changed), … };
```

  (`profile` is the live `BaselineProfile` object from `hp.profiles.profiles`, so assigning `profile.sha256` refreshes the catalog.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/agent/health/baseline-host.test.ts src/__tests__/api/routes-health-baseline.test.ts src/__tests__/api/routes-health-context.test.ts src/__tests__/api/health-profiles.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, then commit** with

```
fix(health): baseline provenance is the digest that ran (F10, D01)

The agent hashes the profile immediately before spawning the engine and
returns profile_sha256; the api reports it, flags a change against the
startup snapshot, refreshes the snapshot and never serves a cached result
whose digest no longer matches the file. The agent spec's duplicate
"planned" health.baseline row is removed.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 6: A run belongs to its principal and keeps its versions (F03, D02)

**Files:**
- Modify: `xiNAS-MCP/src/api/health/run-ledger.ts` (`get`, `record`, `startProbe` take an optional `principal`; `RunEntry.declared_absent`; `setDeclaredAbsent`)
- Modify: `xiNAS-MCP/src/api/health/report-integrity.ts` (`runIdentityErrors`)
- Modify: `xiNAS-MCP/src/api/routes/health.ts` (every ledger call passes `rc.principal`; validate route adds identity errors; context route records `declared_absent`)
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §5.5 (last bullet), §6.3, §11.2 (`valid` definition), §11.4
- Modify: `docs/control-path/api-v1.yaml` (`versions.description` at ~line 1646; `GET /health` / `/health/baseline` / `/health/probe` descriptions: "a run another principal started is treated as unknown")
- Test: `xiNAS-MCP/src/__tests__/api/run-ledger.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-health-report.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-health.test.ts`

**Interfaces:**
- Produces: `RunLedger.get(runId, principal?: string)`, `record(runId, tool, args, result, collectedAt, principal?: string)`, `startProbe(runId, max, principal?: string)` — a principal mismatch behaves exactly like an unknown run; `RunEntry.declared_absent: string[] | null` and `setDeclaredAbsent(runId, list): boolean`; `runIdentityErrors(entry: RunEntry, run: { principal: string; versions: Record<string, unknown> }): string[]` in `report-integrity.ts` — one string per mismatch (`run.principal 'x' does not match the ledger ('y')`, `run.versions.prompt '999.0.0' does not match the ledger ('1.0.0')`), over `principal`, `prompt`, `template_sha256`, `policy`, `catalog`, `report_schema`. Task 7 consumes `entry.declared_absent`.

- [ ] **Step 1: Amend the spec first.** §5.5 last bullet becomes: "All
  five values are echoed by `health.context` and stamped into the run
  ledger. For the run's TTL the validator compares the report's
  `run.versions` (and `run.principal`) with the ledger entry — a report
  that claims other versions or another identity is invalid (AC-17,
  validation F03). The ledger is in-memory (§6.3, O-4): after an api
  restart the run is unknown and the report is `unverifiable`, never
  invalid — what survives a restart is the report the client stored,
  which carries the versions it ran with (validation D02)." §6.3: add
  "Every ledger read and write is bound to the principal that minted the
  run: `health.check`, `health.baseline`, `health.probe.run` and
  `health.report.validate` treat a run another principal started exactly
  like an unknown run (`RUN_UNKNOWN`, `unverifiable`) — no cross-principal
  append, no cross-principal integrity proof (validation F03). The entry
  also records `declared_absent`, the components the inventory proved
  absent when `health.context` last served the run (§11.3 consumes it)."
  §11.2: "`valid` is true iff there are no schema, reference, status or
  run-identity errors and `integrity.status !== 'mismatch'`"; list
  identity errors under `status_errors` in the response text. §11.4: add
  "The report's `run.principal` and `run.versions` MUST equal the ledger
  entry's (status errors otherwise)." `api-v1.yaml` line ~1646: replace
  the description with "The versions the run started with, as stamped
  into the in-memory ledger; the validator compares a report's
  `run.versions` against them for the run's TTL (AC-17). After an api
  restart the run is unknown and reports are `unverifiable`."

- [ ] **Step 2: Write the failing tests.** `run-ledger.test.ts`:

```ts
it('F03: reads and writes are bound to the minting principal', () => {
  const ledger = new RunLedger({ now: () => 0, ttlMs: 60_000 });
  const run = ledger.mint({ principal: 'op:alice', role: 'operator', versions, limits });
  expect(ledger.get(run.run_id, 'op:bob')).toBeNull();
  expect(ledger.get(run.run_id, 'op:alice')).toBe(run);
  expect(ledger.record(run.run_id, 'health.check', { profile: 'quick' }, {}, T, 'op:bob')).toBe(false);
  expect(ledger.startProbe(run.run_id, 4, 'op:bob')).toBe('unknown');
  expect(ledger.record(run.run_id, 'health.check', { profile: 'quick' }, {}, T, 'op:alice')).toBe(true);
  expect(ledger.setDeclaredAbsent(run.run_id, ['raid'])).toBe(true);
  expect(run.declared_absent).toEqual(['raid']);
});
```

  `routes-health-report.test.ts` (reuse its `buildReport` and record helpers; the report's `run.principal` and `run.versions` must now come from the `GET /health/context` result — update the helper to take them from the context body):

```ts
it('F03: another principal cannot validate against, or append to, a run it did not start', async () => {
  // mint as VIEWER, record a quick health.check under that run
  const read = await request(app).get(`/api/v1/health?profile=quick&run_id=${runId}`).set('Authorization', OPERATOR_TOKEN);
  expect(read.status).toBe(200);
  expect(read.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
  expect(ledger.get(runId)!.reports).toHaveLength(1);
  const res = await request(app).post('/api/v1/health/report/validate').set('Authorization', OPERATOR_TOKEN).send(report);
  expect(res.body.result.integrity.status).toBe('unverifiable');
  expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual(['RUN_UNKNOWN']);
});

it('F03: claimed versions and principal must match the ledger', async () => {
  const tampered = structuredClone(report);
  tampered.run.principal = 'invented:identity';
  tampered.run.versions.prompt = '999.0.0';
  tampered.run.versions.template_sha256 = '0'.repeat(64);
  const res = await request(app).post('/api/v1/health/report/validate').set('Authorization', VIEWER_TOKEN).send(tampered);
  expect(res.body.result.valid).toBe(false);
  expect(res.body.result.integrity.status).toBe('verified');
  expect(res.body.result.status_errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining("run.principal 'invented:identity'"),
      expect.stringContaining("run.versions.prompt '999.0.0'"),
      expect.stringContaining('run.versions.template_sha256'),
    ]),
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/api/run-ledger.test.ts src/__tests__/api/routes-health-report.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** `run-ledger.ts`:

```ts
  get(runId: string, principal?: string): RunEntry | null {
    const entry = this.#entries.get(runId);
    if (entry === undefined) return null;
    if (entry.expires_at <= this.#now()) {
      this.#entries.delete(runId);
      return null;
    }
    if (principal !== undefined && entry.principal !== principal) return null;
    return entry;
  }
  record(runId, tool, args, result, collectedAt, principal?: string): boolean {
    const entry = this.get(runId, principal); …
  }
  startProbe(runId: string, max: number, principal?: string): … {
    const entry = this.get(runId, principal); …
  }
  /** What the inventory proved absent when health.context last served this run. */
  setDeclaredAbsent(runId: string, list: readonly string[], principal?: string): boolean {
    const entry = this.get(runId, principal);
    if (entry === null) return false;
    entry.declared_absent = [...list];
    return true;
  }
```

  `RunEntry` gains `declared_absent: string[] | null` (mint sets `null`).
  `report-integrity.ts`:

```ts
const VERSION_KEYS = ['prompt', 'template_sha256', 'policy', 'catalog', 'report_schema'] as const;

/** §11.4 identity: the report's run block must be the ledger's (F03). */
export function runIdentityErrors(
  entry: RunEntry,
  run: { principal: string; versions: Record<string, unknown> },
): string[] {
  const errors: string[] = [];
  if (run.principal !== entry.principal) {
    errors.push(`run.principal '${run.principal}' does not match the ledger ('${entry.principal}')`);
  }
  for (const key of VERSION_KEYS) {
    const claimed = run.versions[key];
    const stamped = entry.versions[key];
    if (claimed !== stamped) {
      errors.push(`run.versions.${key} '${String(claimed)}' does not match the ledger ('${stamped}')`);
    }
  }
  return errors;
}
```

  `routes/health.ts`: `health.check` → `ledger.record(runId, 'health.check', { profile }, result, completedAt, rc.principal)`;
  baseline → `record(…, rc.principal)`; probe → `startProbe(runId, max, rc.principal)` and `record(…, rc.principal)`;
  context → `let run = requested === null ? null : hp.ledger.get(requested, rc.principal);` (drop the manual principal line) and after `buildHealthContext`:
  `hp.ledger.setDeclaredAbsent(run.run_id, (body.topology as { declared_absent: string[] }).declared_absent);`
  validate → `const entry = ctx.healthPrompt?.ledger.get(runId, rc.principal) ?? null;` and

```ts
        const identity = entry === null ? [] : runIdentityErrors(entry, report.run);
        status_errors = [...shape.status_errors, ...identity];
```

  with `valid = isReportValid({ ...shape, status_errors }, integrity.status)` and `status_errors` in the response.
  (`AgenticReport.run` in `report-validate.ts` gains `principal: string; versions: Record<string, unknown>` — it is read from a schema-valid report.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/api/ src/__tests__/lib/health/agentic-fixtures.test.ts`
Expected: PASS (fixture runner mints with `op:alice`/`VERSIONS` and resolves reports with the same values, so nothing changes there).

- [ ] **Step 6: Lint, then commit** with

```
fix(health): a run is bound to its principal and its versions (F03, D02)

Every ledger read and write carries the caller's principal: another
principal's run is an unknown run. The validator compares the report's
run.principal and run.versions with the ledger entry, and the spec now
says what survives a restart (the client's report) and what does not
(the ledger).

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 7: The evidence floor — the verdict is bounded by what xiNAS produced (F01, F02)

**Files:**
- Create: `xiNAS-MCP/src/lib/health/report-floor.ts`
- Modify: `xiNAS-MCP/src/lib/health/report-validate.ts` (`computeVerdict` signature, `validateReportShape` → `evaluateReport`, `ShapeVerdict.adjustments`)
- Modify: `xiNAS-MCP/src/api/health/report-integrity.ts` (`Integrity.omitted`, `compromisedTools`)
- Modify: `xiNAS-MCP/src/api/routes/health.ts` (validate route composes floor + integrity)
- Modify: `xiNAS-MCP/src/__tests__/lib/health/agentic-fixtures.test.ts` (evaluate through the composed function; `Expected.adjustments_include`; record `declared_absent` in the minted run)
- Modify: fixtures `ac-02-collector-missing-stale.json`, `ac-19-invented-evidence-corrected-fail.json`, `xiNAS-MCP/src/__tests__/fixtures/agentic/README.md`
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` §11.3 (steps 3, 5–8), §11.4 (omission), §16 (AC-01/02/04/08/19 rows)
- Modify: `docs/control-path/api-v1.yaml` (`AgenticReportValidation.adjustments`, `integrity.omitted`, `rewritten_to_unknown` description)
- Test: `xiNAS-MCP/src/__tests__/lib/health/report-validate.test.ts`, new `xiNAS-MCP/src/__tests__/lib/health/report-floor.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-health-report.test.ts`

**Interfaces:**
- Consumes: `RunEntry.declared_absent` and `runIdentityErrors` from Task 6; `AGENTIC_CATALOG` rows (`inputs`, `outcome_map`, `severity_map`, `no_source`, `mandatory_for`).
- Produces (all in `lib/health/report-floor.ts`, pure):

```ts
export type FloorLevel = 0 | 1 | 2 | 3 | 4; // none, unknown, warn, fail/degraded, fail/critical
export interface FloorInput {
  /** Indices into report.raw_reports the floor may trust (not tampered). */
  usableRawReports: ReadonlySet<number>;
  /** Ledger tools whose latest row the report omitted or tampered: their inputs floor to unknown. */
  compromisedTools: ReadonlySet<string>;
}
export interface Floor { level: FloorLevel; detail: string }
export function computeFloors(report: AgenticReport, catalog: AgenticCatalog, input: FloorInput): Map<string, Floor>;
export interface Adjustment {
  id: string;
  from: CheckOutcome;
  to: CheckOutcome;
  severity: CheckSeverity | null;
  reason: 'floor' | 'no_source' | 'stale_evidence' | 'not_applicable_uncited' | 'declared_absent_unproven';
  detail: string;
}
```

  and in `report-validate.ts`:

```ts
export interface VerdictInput {
  floors: ReadonlyMap<string, Floor>;
  /** null = unverifiable run (no ledger): the report's own declared_absent is taken as is. */
  provenAbsent: readonly string[] | null;
}
export function computeVerdict(checks, mandatoryIds, declaredAbsent, scopeKind, catalog, input: VerdictInput): Verdict & { adjustments: Adjustment[]; errors: string[] };
export interface ShapeVerdict { …; adjustments: Adjustment[] }
export function validateReportShape(report, catalog, input?: Partial<VerdictInput> & Partial<FloorInput>): ShapeVerdict;
```

  `report-integrity.ts`: `Integrity.omitted: Array<{ tool: string; args_digest: string; collected_at: string }>` (status is `mismatch` when non-empty), `export function floorInputFrom(integrity: Integrity, rawReports: RawReport[]): FloorInput`.

- [ ] **Step 1: Amend the spec first.** §11.3, replace step 3 and append steps 5–8:

```markdown
3. A `not_applicable` outcome on a MANDATORY row MUST cite, in `reason`,
   a component the run's ledger proved absent (`health.context.topology.
   declared_absent`, recorded in the ledger entry — §6.3); the report's own
   `scope.declared_absent` is checked against that record and a component
   it lists without proof is a status error. A scope-exclusion phrase
   satisfies a non-mandatory row only. Anything else is rewritten to
   `unknown` before step 1 (REPORT-02, AC-04; validation F02).
5. **Evidence floor** (REPORT-03, AC-01, AC-19; validation F01). For every
   check row, each catalog input that appears in a raw report the report
   carries and that integrity did not reject contributes a floor:
   `mcp:health.check` — the raw check row with that id, mapped through
   the catalog's `outcome_map`/`severity_map` (`ok` → none, `warning` →
   warn, `degraded`/`critical` → fail with the mapped severity, `skipped`
   → unknown), except that a raw row whose `evidence.collection.status`
   is `error`, `timeout` or `permission_denied` contributes `unknown`
   (AC-03: a collection failure is never a finding by itself); `baseline`
   — the engine row with that section and check (`PASS` → none, `WARN` →
   warn, `FAIL` → fail/critical, `SKIP` → unknown; a baseline whose
   `collection.status` is not `success` contributes `unknown` to every
   baseline input); `probe:health.probe.run` — the probe result of that
   kind (`ok` + clean → none, `ok` + cleanup failed → warn, not ok →
   fail/degraded). Inputs absent from every raw report contribute
   nothing. The row's floor is the most severe contribution; the row's
   effective outcome is the more severe of the model's outcome and the
   floor (ordering `pass`/`not_applicable` < `unknown` < `warn` <
   `fail`/warning < `fail`/degraded < `fail`/critical). A row raised by
   the floor is listed under `adjustments` (`reason: floor`) and is a
   status error. A validly cited `not_applicable` row (step 3) waives an
   `unknown` floor — absence explains a skipped input — but not a `warn`
   or `fail` floor.
6. **Compromised sources** (validation F01b). A ledger tool whose latest
   row is missing from `raw_reports` (`integrity.omitted`) or present but
   tampered (`mismatch`) makes every input of that tool contribute
   `unknown`: a check fed by evidence the model hid or edited cannot be
   `pass` or `not_applicable`.
7. **No source** (CHECK-01; validation F02). A catalog row with
   `no_source: true` may only be `unknown` or `not_applicable`; `pass`,
   `warn` or `fail` is rewritten to `unknown` (`reason: no_source`, a
   status error) — the release must not claim a measurement it cannot
   make.
8. **Stale evidence** (REPORT-02). A row whose `evidence_refs` cite any
   manifest entry with `stale: true` cannot be `pass`: it floors to
   `unknown` (`reason: stale_evidence`).
```

  §11.4, append: "**Completeness.** For every `(tool, args)` the ledger
  holds, its LATEST digest must appear in `raw_reports`; a missing one is
  listed under `integrity.omitted` and makes `integrity.status`
  `mismatch` — a report that hides a result xiNAS produced is invalid
  (REPORT-06; validation F01b). Earlier rows of the same `(tool, args)`
  are superseded and need not appear." §11.2 response block: add
  `"adjustments": [ { "id": "HC-03.arrays", "from": "pass", "to": "fail", "severity": "critical", "reason": "floor", "detail": "health.check xiraid.arrays: critical" } ]`
  and `"integrity": { …, "omitted": [ { "tool": "health.check", "args_digest": "sha256:…", "collected_at": "…" } ] }`.
  §16 rows: AC-01 add "the floor forces `fail`/critical on HC-03 whenever
  the raw row says critical (`report-floor.test.ts`)"; AC-02 → "collector
  degraded (collection success) → HC-01 `fail`/degraded by the floor,
  stale rows → `unknown`; `degraded`/`partial`, no false ok"; AC-04 add
  "`declared_absent` is checked against the ledger's proven set; a
  self-declared absence is a status error (`routes-health-report.test.ts`
  F02b)"; AC-08 add "`no_source` HC-11 cannot be `pass`"; AC-19 → "a
  tampered raw report is `mismatch` AND compromises every check it feeds
  (`unknown`/`partial`), the invented evidence id is a reference error".
  `api-v1.yaml` `AgenticReportValidation`: add

```yaml
        adjustments:
          type: array
          description: Rows whose outcome the validator raised or rewrote (S19 §11.3 steps 3, 5–8); each is also a status error except not_applicable_uncited.
          items:
            type: object
            properties:
              id: { type: string }
              from: { type: string, enum: [pass, warn, fail, unknown, not_applicable] }
              to: { type: string, enum: [pass, warn, fail, unknown, not_applicable] }
              severity: { type: string, nullable: true, enum: [warning, degraded, critical] }
              reason: { type: string, enum: [floor, no_source, stale_evidence, not_applicable_uncited, declared_absent_unproven] }
              detail: { type: string }
```

  and under `integrity.properties`:

```yaml
            omitted:
              type: array
              description: Ledger rows (latest per tool and arguments) the report did not carry; non-empty makes status mismatch.
              items:
                type: object
                properties:
                  tool: { type: string }
                  args_digest: { type: string }
                  collected_at: { type: string, format: date-time }
```

  (`rewritten_to_unknown` keeps its shape and now lists every row whose
  effective outcome became `unknown`, whatever the reason; say so in its
  description.)

- [ ] **Step 2: Write the failing tests.** New `src/__tests__/lib/health/report-floor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENTIC_CATALOG } from '../../../lib/health/agentic-catalog.js';
import { computeFloors } from '../../../lib/health/report-floor.js';
import type { AgenticReport } from '../../../lib/health/report-validate.js';

const T = '2026-09-10T10:00:00.000Z';
const quick = (checks: Array<Record<string, unknown>>) => ({
  tool: 'health.check',
  args: { profile: 'quick' },
  collected_at: T,
  digest: 'sha256:' + '0'.repeat(64),
  report: { profile: 'quick', overall: 'ok', checks },
});
const report = (raw: unknown[]): AgenticReport =>
  ({
    report_schema_version: '1',
    run: { run_id: 'r', principal: 'op:a', versions: {} },
    scope: { kind: 'node', declared_absent: [] },
    run_status: 'completed',
    health_status: 'ok',
    coverage_status: 'complete',
    raw_reports: raw,
    checks: [],
    findings: [],
    evidence_manifest: [],
    not_checked: [],
  }) as unknown as AgenticReport;
const all = (n: number) => new Set(Array.from({ length: n }, (_, i) => i));

describe('computeFloors (spec §11.3 steps 5–6)', () => {
  it('F01: a critical raw xiraid.arrays floors HC-03.arrays to fail/critical', () => {
    const floors = computeFloors(
      report([quick([{ id: 'xiraid.arrays', status: 'critical', evidence: { collection: { status: 'success' } } }])]),
      AGENTIC_CATALOG,
      { usableRawReports: all(1), compromisedTools: new Set() },
    );
    expect(floors.get('HC-03.arrays')).toEqual({ level: 4, detail: 'health.check xiraid.arrays: critical' });
    expect(floors.has('HC-06.nfs-service')).toBe(false);
  });
  it('AC-03: a raw degraded caused by a collection failure floors to unknown, not fail', () => {
    const floors = computeFloors(
      report([quick([{ id: 'xiraid.license', status: 'degraded', evidence: { collection: { status: 'timeout', code: 'TIMEOUT' } } }])]),
      AGENTIC_CATALOG,
      { usableRawReports: all(1), compromisedTools: new Set() },
    );
    expect(floors.get('HC-03.arrays')?.level).toBe(1);
  });
  it('a raw skipped floors to unknown; baseline FAIL floors to fail/critical; a probe failure to fail/degraded', () => {
    const baseline = {
      tool: 'health.baseline', args: { profile: 'standard', max_age_s: 0 }, collected_at: T, digest: 'sha256:' + '1'.repeat(64),
      report: { collection: { status: 'success' }, report: { checks: [{ section: 'Kernel', name: 'thp', status: 'FAIL' }] } },
    };
    const probe = {
      tool: 'health.probe.run', args: { probe: 'fs_io', target: 'fs-1', timeout_s: 20 }, collected_at: T, digest: 'sha256:' + '2'.repeat(64),
      report: { probe: 'fs_io', ok: false, cleanup: { status: 'clean' } },
    };
    const floors = computeFloors(
      report([quick([{ id: 'nfs.server', status: 'skipped', evidence: { collection: { status: 'success' } } }]), baseline, probe]),
      AGENTIC_CATALOG,
      { usableRawReports: all(3), compromisedTools: new Set() },
    );
    expect(floors.get('HC-06.nfs-service')?.level).toBe(1);
    expect(floors.get('HC-02.baseline-expectations')?.level).toBe(4);
    expect(floors.get('HC-08.host-services')?.level).toBe(4);
    expect(floors.get('HC-12.active-probe')?.level).toBe(3);
  });
  it('F01b: a compromised tool floors every check it feeds to unknown; a tampered raw report is ignored', () => {
    const floors = computeFloors(
      report([quick([{ id: 'xiraid.arrays', status: 'critical', evidence: { collection: { status: 'success' } } }])]),
      AGENTIC_CATALOG,
      { usableRawReports: new Set(), compromisedTools: new Set(['health.check']) },
    );
    expect(floors.get('HC-03.arrays')).toEqual({ level: 1, detail: 'health.check: raw report omitted or tampered' });
    expect(floors.get('HC-05.filesystems')?.level).toBe(1);
    expect(floors.has('HC-02.baseline-expectations')).toBe(false);
  });
});
```

  `report-validate.test.ts` (append; the file has helpers to build checks — reuse them):

```ts
describe('computeVerdict with floors (spec §11.3 steps 3, 5–8)', () => {
  const mandatory = new Set(AGENTIC_CATALOG.checks.filter((c) => c.mandatory_for.includes('node')).map((c) => c.id));
  const row = (id: string, outcome: CheckOutcome, over: Partial<ReportCheck> = {}): ReportCheck => ({
    id, outcome, severity: null, reason: 'r', mandatory: mandatory.has(id), evidence_refs: [], ...over,
  });
  const allPass = [...mandatory].map((id) => row(id, 'pass'));
  const noFloors = { floors: new Map(), provenAbsent: [] as string[] };

  it('F01: a pass row below a fail/critical floor is raised, listed and a status error', () => {
    const floors = new Map([['HC-03.arrays', { level: 4 as const, detail: 'health.check xiraid.arrays: critical' }]]);
    const v = computeVerdict(allPass, mandatory, [], 'node', AGENTIC_CATALOG, { floors, provenAbsent: [] });
    expect(v.health_status).toBe('critical');
    expect(v.adjustments).toEqual([
      { id: 'HC-03.arrays', from: 'pass', to: 'fail', severity: 'critical', reason: 'floor', detail: 'health.check xiraid.arrays: critical' },
    ]);
    expect(v.errors[0]).toContain("check 'HC-03.arrays' outcome 'pass' is below the evidence floor");
  });
  it('a fail row above the floor is untouched', () => {
    const floors = new Map([['HC-03.arrays', { level: 2 as const, detail: 'x' }]]);
    const checks = allPass.map((c) => (c.id === 'HC-03.arrays' ? row(c.id, 'fail', { severity: 'critical' }) : c));
    const v = computeVerdict(checks, mandatory, [], 'node', AGENTIC_CATALOG, { floors, provenAbsent: [] });
    expect(v.adjustments).toEqual([]);
    expect(v.health_status).toBe('critical');
  });
  it('F02: a no_source row cannot be pass', () => {
    const sp = new Set(AGENTIC_CATALOG.checks.filter((c) => c.mandatory_for.includes('service_path')).map((c) => c.id));
    const checks = [...sp].map((id) => ({ ...row(id, 'pass'), mandatory: true }));
    const v = computeVerdict(checks, sp, [], 'service_path', AGENTIC_CATALOG, noFloors);
    expect(v.adjustments).toContainEqual(expect.objectContaining({ id: 'HC-11.client-path', to: 'unknown', reason: 'no_source' }));
    expect(v.coverage_status).toBe('partial');
    expect(v.health_status).toBe('unknown');
  });
  it('F02b: a self-declared absence is not a citation; a scope-exclusion phrase does not excuse a mandatory row', () => {
    const checks = allPass.map((c) =>
      c.id === 'HC-03.arrays' ? row(c.id, 'not_applicable', { reason: 'raid absent' }) : row(c.id, 'not_applicable', { reason: 'scope exclusion' }),
    );
    const v = computeVerdict(checks, mandatory, ['raid'], 'node', AGENTIC_CATALOG, { floors: new Map(), provenAbsent: [] });
    expect(v.errors).toContainEqual(expect.stringContaining("scope.declared_absent 'raid' is not proven"));
    expect(v.rewritten_to_unknown).toEqual([...mandatory]);
    expect(v.health_status).toBe('unknown');
  });
  it('AC-04: a proven absence waives an unknown floor but not a warn floor', () => {
    const floors = new Map([
      ['HC-03.arrays', { level: 1 as const, detail: 'health.check xiraid.arrays: skipped' }],
      ['HC-06.nfs-service', { level: 2 as const, detail: 'health.check nfs.server: warning' }],
    ]);
    const checks = allPass.map((c) =>
      c.id === 'HC-03.arrays' ? row(c.id, 'not_applicable', { reason: 'raid is declared absent' })
      : c.id === 'HC-06.nfs-service' ? row(c.id, 'not_applicable', { reason: 'nfs declared absent' }) : c,
    );
    const v = computeVerdict(checks, mandatory, ['raid', 'nfs'], 'node', AGENTIC_CATALOG, { floors, provenAbsent: ['raid', 'nfs'] });
    expect(v.adjustments.map((a) => a.id)).toEqual(['HC-06.nfs-service']);
    expect(v.health_status).toBe('warning');
  });
  it('stale evidence cannot back a pass', () => {
    const checks = allPass.map((c) => (c.id === 'HC-05.filesystems' ? row(c.id, 'pass', { evidence_refs: ['ev-old'] }) : c));
    const v = computeVerdict(checks, mandatory, [], 'node', AGENTIC_CATALOG, { ...noFloors, staleEvidenceIds: new Set(['ev-old']) });
    expect(v.adjustments).toContainEqual(expect.objectContaining({ id: 'HC-05.filesystems', to: 'unknown', reason: 'stale_evidence' }));
  });
});
```

  (`VerdictInput` therefore also carries `staleEvidenceIds: ReadonlySet<string>`; `validateReportShape` derives it from `evidence_manifest`. Add it to the interface above.)

  `routes-health-report.test.ts` (end-to-end, the auditor's F01/F01b/F02/F02b inverted; reuse the file's helpers; the ledger gets a critical quick report):

```ts
it('F01: a verified critical raw RAID result cannot coexist with ok/complete', async () => {
  const res = await validate(reportAllPass);          // raw quick: xiraid.arrays critical, all checks pass
  expect(res.integrity).toMatchObject({ status: 'verified', checked: 1 });
  expect(res.computed).toEqual({ health_status: 'critical', coverage_status: 'complete' });
  expect(res.adjustments).toContainEqual(expect.objectContaining({ id: 'HC-03.arrays', to: 'fail', severity: 'critical', reason: 'floor' }));
  expect(res.valid).toBe(false);
});
it('F01b: dropping every raw report is an omission, and stale evidence cannot carry a pass', async () => {
  const r = structuredClone(reportAllPass);
  r.raw_reports = [];
  r.evidence_manifest[0].stale = true;
  const res = await validate(r);
  expect(res.integrity.status).toBe('mismatch');
  expect(res.integrity.omitted).toEqual([expect.objectContaining({ tool: 'health.check' })]);
  expect(res.computed.health_status).toBe('unknown');
  expect(res.valid).toBe(false);
});
it('F02: no_source HC-11 cannot be pass; service_path stays partial', async () => {
  const res = await validate(servicePathAllPass);
  expect(res.computed).toEqual({ health_status: 'critical', coverage_status: 'partial' });   // critical from the raw RAID floor
  expect(res.adjustments).toContainEqual(expect.objectContaining({ id: 'HC-11.client-path', reason: 'no_source' }));
});
it('F02b: self-declared absence and a scope-exclusion phrase do not bypass unknown', async () => {
  const r = structuredClone(reportAllPass);
  r.scope.declared_absent = ['raid'];
  for (const c of r.checks) { c.outcome = 'not_applicable'; c.reason = c.id === 'HC-03.arrays' ? 'raid absent' : 'scope exclusion'; }
  const res = await validate(r);
  expect(res.status_errors).toContainEqual(expect.stringContaining("scope.declared_absent 'raid' is not proven"));
  expect(res.computed.health_status).toBe('critical');            // the floor still applies to the RAID row
  expect(res.valid).toBe(false);
});
```

  Fixture updates (documented in the README under a new "Corrections
  (2026-09-10)" paragraph): `ac-02-collector-missing-stale.json` — the
  HC-01.agent-trust row becomes `outcome: "fail", severity: "degraded"`,
  reason "the XiraidArray collector is in error (agent.collectors
  degraded, collection success): the trust criterion fails", the report's
  `health_status` becomes `degraded`, `expected.computed.health_status`
  `degraded`, `expected.checks["HC-01.agent-trust"]` `fail`; the title
  gains "; the degraded collector is a fail, the stale rows are unknown".
  `ac-19-invented-evidence-corrected-fail.json` — `expected.computed`
  becomes `{ "health_status": "unknown", "coverage_status": "partial" }`,
  drop `expected.status_errors`, add
  `"adjustments_include": [{ "id": "HC-03.arrays", "to": "unknown", "reason": "floor" }]`,
  title gains "; the tampered source compromises every check it feeds".
  Runner: `evaluate()` calls the composed `evaluateReport` (below) after
  `ledger.setDeclaredAbsent(entry.run_id, sc.declared_absent ?? [])`;
  `Expected.adjustments_include?: Array<{ id: string; to: string; reason: string }>`
  asserted with `expect(ev.shape.adjustments).toContainEqual(expect.objectContaining(a))`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/lib/health/ src/__tests__/api/routes-health-report.test.ts`
Expected: FAIL (module `report-floor` missing; `adjustments` undefined; AC-02/AC-19 expectations differ).

- [ ] **Step 4: Implement.** `lib/health/report-floor.ts`:

```ts
import type { AgenticCatalog, AgenticCheckInput, CheckOutcome, CheckSeverity } from './agentic-catalog.js';
import type { AgenticReport, RawReport } from './report-validate.js';

export type FloorLevel = 0 | 1 | 2 | 3 | 4;
export interface Floor { level: FloorLevel; detail: string }
export interface FloorInput {
  usableRawReports: ReadonlySet<number>;
  compromisedTools: ReadonlySet<string>;
}

const FAMILY_TOOL: Record<'mcp:health.check' | 'baseline' | 'probe:health.probe.run', string> = {
  'mcp:health.check': 'health.check',
  baseline: 'health.baseline',
  'probe:health.probe.run': 'health.probe.run',
};
const FAILED_COLLECTION = new Set(['error', 'timeout', 'permission_denied']);

/** outcome + severity → floor level. */
export function levelOf(outcome: CheckOutcome, severity: CheckSeverity | null): FloorLevel {
  if (outcome === 'unknown') return 1;
  if (outcome === 'warn') return 2;
  if (outcome === 'fail') return severity === 'critical' ? 4 : severity === 'degraded' ? 3 : 2;
  return 0;
}
/** floor level → the outcome/severity it forces. */
export function outcomeAt(level: FloorLevel): { outcome: CheckOutcome; severity: CheckSeverity | null } {
  if (level === 4) return { outcome: 'fail', severity: 'critical' };
  if (level === 3) return { outcome: 'fail', severity: 'degraded' };
  if (level === 2) return { outcome: 'warn', severity: 'warning' };
  if (level === 1) return { outcome: 'unknown', severity: null };
  return { outcome: 'pass', severity: null };
}
const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');

function mapped(check: { outcome_map: Record<string, CheckOutcome>; severity_map: Record<string, CheckSeverity> }, key: string): FloorLevel | null {
  const outcome = check.outcome_map[key];
  if (outcome === undefined) return null;
  return levelOf(outcome, check.severity_map[key] ?? null);
}

interface RawIndex {
  mcp: Array<{ id: string; status: string; collection: string | null }>;
  baseline: Array<{ ok: boolean; rows: Array<{ section: string; name: string; status: string }> }>;
  probe: Array<{ probe: string; ok: boolean; cleanupFailed: boolean }>;
}

function indexRaw(raw: RawReport[], usable: ReadonlySet<number>): RawIndex {
  const out: RawIndex = { mcp: [], baseline: [], probe: [] };
  raw.forEach((r, i) => {
    if (!usable.has(i)) return;
    const body = r.report as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object') return;
    if (r.tool === 'health.check' && Array.isArray(body.checks)) {
      for (const c of body.checks as Array<Record<string, unknown>>) {
        const collection = (c.evidence as { collection?: { status?: unknown } } | undefined)?.collection?.status;
        out.mcp.push({ id: String(c.id), status: String(c.status), collection: typeof collection === 'string' ? collection : null });
      }
    } else if (r.tool === 'health.baseline') {
      const ok = (body.collection as { status?: unknown } | undefined)?.status === 'success' && body.report !== null;
      const rows = ok ? (((body.report as Record<string, unknown>).checks as Array<Record<string, unknown>> | undefined) ?? []) : [];
      out.baseline.push({ ok, rows: rows.map((x) => ({ section: norm(x.section), name: String(x.name), status: String(x.status) })) });
    } else if (r.tool === 'health.probe.run') {
      out.probe.push({
        probe: String(body.probe),
        ok: body.ok === true,
        cleanupFailed: (body.cleanup as { status?: unknown } | undefined)?.status === 'failed',
      });
    }
  });
  return out;
}

export function computeFloors(report: AgenticReport, catalog: AgenticCatalog, input: FloorInput): Map<string, Floor> {
  const idx = indexRaw(report.raw_reports, input.usableRawReports);
  const floors = new Map<string, Floor>();
  const raise = (id: string, level: FloorLevel | null, detail: string) => {
    if (level === null || level === 0) return;
    const cur = floors.get(id);
    if (cur === undefined || level > cur.level) floors.set(id, { level, detail });
  };
  for (const check of catalog.checks) {
    for (const inp of check.inputs) {
      const family = inp.source as keyof typeof FAMILY_TOOL;
      const tool = FAMILY_TOOL[family];
      if (tool === undefined) continue;                       // read:/resource: inputs never floor
      if (input.compromisedTools.has(tool)) {
        raise(check.id, 1, `${tool}: raw report omitted or tampered`);
        continue;
      }
      contribute(check, inp, idx, raise);
    }
  }
  return floors;
}

function contribute(
  check: AgenticCatalog['checks'][number],
  inp: AgenticCheckInput,
  idx: RawIndex,
  raise: (id: string, level: FloorLevel | null, detail: string) => void,
): void {
  if (inp.source === 'mcp:health.check') {
    for (const row of idx.mcp) {
      if (row.id !== inp.check_id) continue;
      if (row.collection !== null && FAILED_COLLECTION.has(row.collection)) {
        raise(check.id, 1, `health.check ${row.id}: collection ${row.collection}`);
      } else {
        raise(check.id, mapped(check, `mcp:${row.status}`), `health.check ${row.id}: ${row.status}`);
      }
    }
  } else if (inp.source === 'baseline') {
    for (const b of idx.baseline) {
      if (!b.ok) {
        raise(check.id, 1, 'health.baseline: collection failed');
        continue;
      }
      const row = b.rows.find((x) => x.section === norm(inp.section) && x.name === inp.check);
      if (row !== undefined) raise(check.id, mapped(check, `baseline:${row.status}`), `health.baseline ${inp.section}/${inp.check}: ${row.status}`);
    }
  } else if (inp.source === 'probe:health.probe.run') {
    for (const p of idx.probe) {
      if (p.probe !== inp.probe) continue;
      const key = !p.ok ? 'probe:failed' : p.cleanupFailed ? 'probe:cleanup_failed' : 'probe:ok';
      raise(check.id, mapped(check, key), `health.probe.run ${p.probe}: ${key.slice('probe:'.length)}`);
    }
  }
}
```

  `report-validate.ts` `computeVerdict(checks, mandatoryIds, declaredAbsent, scopeKind, catalog, input)`:
  1. `errors: string[]`, `adjustments: Adjustment[]`; `proven = input.provenAbsent === null ? absent : absent.filter(a => input.provenAbsent.includes(a))`; every `a` in `absent` not in `proven` → `errors.push(\`scope.declared_absent '${a}' is not proven by the run's inventory\`)`.
  2. per row: `noSource = catalog row?.no_source === true`; `mandatory = mandatoryIds.has(id)`;
     - `not_applicable`: cited iff `proven.some(a => reason.includes(a)) || (!mandatory && SCOPE_EXCLUSION_RE.test(reason))`; uncited → `unknown` (`reason: 'not_applicable_uncited'`, or `'declared_absent_unproven'` when the reason cites an unproven component; NO error for these two — the status errors come from the verdict mismatch, as today).
     - `noSource && outcome ∈ {pass,warn,fail}` → `unknown`, `reason: 'no_source'`, error `check '<id>' has no source in this release and cannot be '<outcome>'`.
     - stale: `outcome === 'pass' && evidence_refs.some(r => input.staleEvidenceIds.has(r))` → `unknown`, `reason: 'stale_evidence'`, error.
     - floor: `f = input.floors.get(id)`; `waived = f.level === 1 && effective.outcome === 'not_applicable' && cited`; if `f && !waived && f.level > levelOf(effective.outcome, effective.severity)` → `outcomeAt(f.level)`, `reason: 'floor'`, `detail: f.detail`, error `check '<id>' outcome '<from>' is below the evidence floor '<to>' (<detail>)`.
  3. verdict over the effective rows exactly as today; `rewritten_to_unknown` = ids of rows whose effective outcome is `unknown` and whose model outcome was not.
  `validateReportShape(report, catalog, input?)` computes `staleEvidenceIds` from `evidence_manifest` (`stale === true`), defaults `floors` to `computeFloors(report, catalog, { usableRawReports: all indices, compromisedTools: ∅ })` when `input.usableRawReports` is absent and `provenAbsent` to `null`, and returns `adjustments` and appends `verdict.errors` to `status_errors`.
  Add to `report-validate.ts`:

```ts
/** The api's composition: shape + integrity + floor in the right order (validation F01). */
export function evaluateReport(
  report: unknown,
  catalog: AgenticCatalog,
  integrity: { status: 'verified' | 'mismatch' | 'unverifiable'; mismatchedIndices: ReadonlySet<number>; compromisedTools: ReadonlySet<string> },
  provenAbsent: readonly string[] | null,
): ShapeVerdict {
  const schema_errors = schemaErrorsOf(report);
  if (schema_errors.length > 0) return validateReportShape(report, catalog);
  const r = report as AgenticReport;
  const usable = new Set(r.raw_reports.map((_, i) => i).filter((i) => !integrity.mismatchedIndices.has(i)));
  return validateReportShape(report, catalog, {
    usableRawReports: usable,
    compromisedTools: integrity.compromisedTools,
    provenAbsent,
  });
}
```

  `report-integrity.ts`: `checkIntegrity` additionally computes `omitted`
  (group `entry.reports` by `${tool} ${args_digest}`, take the LAST
  row of each group, keep it when no raw report has `tool === row.tool &&
  digestOf(raw.args) === row.args_digest && raw.digest === row.report_digest`)
  and sets `status: 'mismatch'` when `mismatches.length > 0 || omitted.length > 0`;
  `UNVERIFIABLE` gains `omitted: []`; add

```ts
/** What the floor may trust, from the integrity verdict (spec §11.3 steps 5–6). */
export function floorInputFrom(integrity: Integrity, rawReports: RawReport[]): FloorInput {
  const mismatchedIndices = new Set(integrity.mismatches.map((m) => m.raw_report_index));
  const compromisedTools = new Set<string>([
    ...integrity.omitted.map((o) => o.tool),
    ...integrity.mismatches.map((m) => rawReports[m.raw_report_index]?.tool ?? ''),
  ]);
  compromisedTools.delete('');
  return { mismatchedIndices, compromisedTools, usableRawReports: new Set(rawReports.map((_, i) => i).filter((i) => !mismatchedIndices.has(i))) };
}
```

  (make `FloorInput` in `report-floor.ts` carry `mismatchedIndices` too, or return an object `evaluateReport` accepts — keep ONE shape and use it in both places.)
  Route (`POST /health/report/validate`): shape first (schema gate), then
  `entry`, then `integrity = checkIntegrity(entry, raw)`, then
  `shape = evaluateReport(body, AGENTIC_CATALOG, floorInputFrom(integrity, raw) + status, entry?.declared_absent ?? null)`,
  identity errors from Task 6 appended, `adjustments` and `integrity.omitted` in the response.
  Fixture runner: same composition.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/lib/health/ src/__tests__/api/routes-health-report.test.ts src/__tests__/api/routes-health-context.test.ts && npm run test:contracts`
Expected: PASS, every fixture green with the two documented corrections.

- [ ] **Step 6: Lint, then commit** with

```
fix(health): the verdict is bounded by the evidence xiNAS produced (F01, F02)

Every check row now has an evidence floor computed from the raw
health.check, health.baseline and health.probe.run reports the report
carries: a model outcome may never be more favourable than the source.
A ledger row the report omits or tampers compromises every check it
feeds; a no_source row cannot claim a measurement; stale evidence cannot
back a pass; declared_absent is checked against the inventory the run's
ledger recorded. AC-02 and AC-19 fixtures corrected accordingly.

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 8: Closure — runbook rows, TODO, full gate

**Files:**
- Modify: `docs/control-path/hardware-smoke-runbook.md` (two new rows after the S19a probe row)
- Modify: `docs/TODO.md` (one new entry)
- Modify: this plan (tick the boxes)

- [ ] **Step 1: Runbook rows** (after the `POST /health/probe` row of the S19a block):

```markdown
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
```

- [ ] **Step 2: TODO entry** (append; same shape as the neighbours):

```markdown
## Health — the fs_io PID1 delegation is not yet proven on hardware

*Deferred 2026-09-10, from the S19 validation remediation
(`fix/s19-validation-findings`); spec §9.3 "Execution boundary", B01.*

**What is missing.** The `systemd-run` delegation of `fs_io` was designed
from the `ReadWritePaths` semantics observed on xinas-box (systemd 255) and
is covered by unit and e2e tests with a stubbed `systemd-run`; no node has
run the built code yet.

**What the code does instead.** Nothing different — the delegation is the
shipped path; a `systemd-run` failure is an honest `FSIO_HELPER_FAILED`
outcome with `cleanup: failed`, never a false `clean`.

**Why it was cut.** No installed 3.14 node existed on 2026-09-10.

**Done looks like.** The two B01 rows of `hardware-smoke-runbook.md` ticked
on a real node and this entry deleted.
```

- [ ] **Step 3: Run the full gate** from `xiNAS-MCP/`:

```
npm run typecheck && npm run lint && npm run format:check
npx vitest run --maxWorkers=2 --minWorkers=1 && npm run test:contracts
npm run build && npm run test:e2e
```

  and from the worktree root:

```
yamllint -c .yamllint.yml .
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

  (Python gates are unaffected: no file under `xinas_menu/`,
  `xinas_history/`, `tests/` or `nfs-helper/` changes in this plan.)
  Expected: all green; record the counts in the final report.

- [ ] **Step 4: Re-run the auditor's reproductions against the fixed tree**
  — copy `s19-audit.test.ts` from the auditor's worktree into
  `src/__tests__/` TEMPORARILY, run it, and confirm that every F-case now
  FAILS (each documented an unsafe outcome); then delete the copy. Do not
  commit it.

- [ ] **Step 5: Commit the docs** (`docs(control-path): S19 validation closure — runbook rows, TODO, plan`), no trailer.

---

## Self-review

- Spec coverage: F01/F01b/F02/F02b → Task 7; F03 + D02 → Task 6; F04
  (three paths) → Task 1; F05/F06/F07 → Task 2; F08 + B01 → Task 3; F09 →
  Task 4; F10 + D01 → Task 5; B02 stays the manual runbook procedure
  (already in `docs/TODO.md`, unchanged). Every task edits its spec first.
- oasdiff: only additive fields and descriptions (`sha256_changed`,
  `adjustments`, `integrity.omitted`, descriptions); no enum value added
  to an existing enum; no request constraint added to the schema.
- Names used across tasks: `busy()` (Task 3 ↔ tests), `RUN_ID_RE` (Task 2
  ↔ route), `profile_sha256` (Task 5 agent ↔ api), `declared_absent` /
  `setDeclaredAbsent` (Task 6 ↔ Task 7), `runIdentityErrors` (Task 6 ↔
  route), `evaluateReport` / `floorInputFrom` (Task 7 ↔ route ↔ fixture
  runner).
