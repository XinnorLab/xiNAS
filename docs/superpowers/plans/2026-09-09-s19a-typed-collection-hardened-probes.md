# S19a — Typed collection status and hardened probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `health.probe` section carry a typed collection status the api maps honestly, rewrite the probe host so every artifact is per-run and self-reporting, and expose one confirmable `health.probe.run` tool — slice a of S19.

**Architecture:** Shared pure types in `lib/health/collection.ts` (both api and agent import lib; lib imports neither). The agent's `health.probe` returns `{ schema: 2, sections }`; `lib/health/standard.ts` builders take a `Section<T>` and map `not_supported → skipped`, other failures → `degraded` with the status in evidence; the route adds `coverage_status` and `collection`. The probe host is rewritten around `O_EXCL`/`O_NOFOLLOW` opens, an fstat device check, per-run names and mountpoints, and a cleanup verdict; a new agent RPC `health.probe.run` runs one probe behind an in-flight guard. On the api, `health.probe.run` is a `direct` catalog entry (operator, `requires_mcp_apply`, `confirmation: 'required'`); the S15 confirmation service gains a direct-entry branch that binds `{ tool, args }` through a synthesized plan document, and the route verifies and consumes the record before calling the agent.

**Tech Stack:** TypeScript (Node ≥ 20, `node:fs/promises` with `fs.constants`), vitest, supertest, better-sqlite3 (existing S15 store), biome.

**Spec:** `docs/control-path/s19-mcp-health-prompt-spec.md` §1 (S19a), §7, §9, §13, §14, §15; ADR-0018 §3, §4.

## Global Constraints

- Every commit that touches `xiNAS-MCP/src/` carries the trailer line `Requires-Rebuild: xinas_node_build` (CLAUDE.md).
- Conventional Commits; English only; no squash on merge.
- `lib/` imports nothing from `agent/` or `api/`; nothing outside `src/agent/` imports `agent/probe/*` (`probe-boundary.test.ts`).
- `HealthReport.overall` semantics unchanged (spec §7.3, REPORT-01). New report fields are additive; `api-v1.yaml` changes must pass `oasdiff` (no removals, no tightening).
- Only `not_supported` may become `skipped`; `error | timeout | permission_denied` become `degraded` (spec §7.2, D-05).
- Probe artifacts: unique per run, `O_CREAT|O_EXCL|O_NOFOLLOW`, same-device check, cleanup failure reported, timeout enforced on the agent (spec §9.3, D-08). The old fixed-name path is removed, not kept as a fallback.
- `health.probe.run`: `mutability: 'direct'`, `requires_mcp_apply: true`, `min_role: 'operator'`, `confirmation: 'required'`; REST operators need no confirmation; MCP needs `mcp.allow_apply` and a form confirmation (spec §9.1).
- Verification gate before "done": `npm run typecheck && npm run lint && npm run format:check`, `npm test`, `npm run test:contracts`, `npm run build && npm run test:e2e`, plus `yamllint`, spectral on `api-v1.yaml`, markdownlint on `docs/**`.

---

## File structure

| Path | Responsibility |
|---|---|
| `xiNAS-MCP/src/lib/health/collection.ts` (new) | `CollectionStatus`, `Section<T>`, `collectionEvidence()`, `isCollectionFailure()` — pure, shared |
| `xiNAS-MCP/src/agent/health/collect.ts` (new) | `ProbeCollectionError`, `classifyNodeError()`, `collect()` — turns a dep call into a `Section` |
| `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` | v2 result assembly; deps throw instead of returning null; wiring classifies `ENOENT`/timeouts |
| `xiNAS-MCP/src/lib/health/standard.ts` | builders over `Section<T>`; shared failure mapping |
| `xiNAS-MCP/src/lib/health/drift.ts` | `driftNfsConfCheck` takes the render `Section` |
| `xiNAS-MCP/src/api/routes/health.ts` | v2/v1 normalization, `coverage_status`, `collection`, quick-check evidence; `POST /health/probe` |
| `xiNAS-MCP/src/lib/health/probe-types.ts` (new) | `ProbeOutcome`, `ProbeRunOptions`, `ProbeKind`, the `proves` texts — shared by agent and api |
| `xiNAS-MCP/src/agent/health/probe-host.ts` | rewritten hardened host |
| `xiNAS-MCP/src/agent/health/fake-probe-host.ts` | fake over the new interface, same `probe-host-state.json` protocol |
| `xiNAS-MCP/src/agent/rpc/methods/health-probe-run.ts` (new) | the `health.probe.run` RPC handler with the in-flight guard |
| `xiNAS-MCP/src/agent/rpc/dispatch.ts` | structured `data.code` pass-through for `PROBE_IN_PROGRESS` and friends |
| `xiNAS-MCP/src/agent-server.ts` | registers `health.probe.run` |
| `xiNAS-MCP/src/api/mcp/catalog.ts` | the `health.probe.run` entry |
| `xiNAS-MCP/src/api/mcp/confirmation/direct.ts` (new) | `isDirectConfirmable`, `directBindings`, `directDocument` |
| `xiNAS-MCP/src/api/mcp/confirmation/service.ts` | `handleDirect()` branch; `view()` for direct records |
| `xiNAS-MCP/src/__tests__/api/_helpers.ts` | `respondToRpc(method, handler)` on the mock agent |
| `docs/control-path/api-v1.yaml` | `HealthReport.coverage_status`/`collection`; `/health/probe` |
| `docs/control-path/s19-mcp-health-prompt-spec.md`, `docs/TODO.md`, `CHANGELOG.md`, `docs/control-path/hardware-smoke-runbook.md` | status, deviations, closure of the hardening TODO, release note |

Commands below run from `xiNAS-MCP/` unless a path says otherwise.

---

### Task 1: Shared collection types and the agent-side `collect()` helper

**Files:**
- Create: `xiNAS-MCP/src/lib/health/collection.ts`
- Create: `xiNAS-MCP/src/agent/health/collect.ts`
- Test: `xiNAS-MCP/src/__tests__/agent/health/collect.test.ts`

**Interfaces:**
- Produces: `CollectionStatus`, `Section<T>`, `collectionEvidence(section)`, `isCollectionFailure(status)`, `ProbeCollectionError`, `classifyNodeError(err)`, `collect(fn, clock)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/agent/health/collect.test.ts
import { describe, expect, it } from 'vitest';
import { ProbeCollectionError, classifyNodeError, collect } from '../../../agent/health/collect.js';
import { collectionEvidence, isCollectionFailure } from '../../../lib/health/collection.js';

const clock = () => 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

describe('collect()', () => {
  it('success carries the value and the clock time', async () => {
    const s = await collect(async () => [1, 2], clock);
    expect(s).toEqual({ status: 'success', observed_at: '2023-11-14T22:13:20.000Z', value: [1, 2] });
    expect(isCollectionFailure(s.status)).toBe(false);
    expect(collectionEvidence(s)).toEqual({ status: 'success', observed_at: '2023-11-14T22:13:20.000Z' });
  });

  it('ENOENT is not_supported/TOOL_ABSENT — the only status that may become skipped', async () => {
    const s = await collect(async () => {
      throw Object.assign(new Error('spawn xicli ENOENT'), { code: 'ENOENT' });
    }, clock);
    expect(s.status).toBe('not_supported');
    expect(s.error).toEqual({ code: 'TOOL_ABSENT', message: 'spawn xicli ENOENT' });
    expect(isCollectionFailure(s.status)).toBe(false);
  });

  it('EACCES/EPERM → permission_denied; killed subprocess → timeout; anything else → error', () => {
    expect(classifyNodeError(Object.assign(new Error('x'), { code: 'EACCES' })).status).toBe('permission_denied');
    expect(classifyNodeError(Object.assign(new Error('x'), { code: 'EPERM' })).status).toBe('permission_denied');
    expect(classifyNodeError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }))).toEqual({
      status: 'timeout', code: 'TIMEOUT', message: 'x',
    });
    expect(classifyNodeError(new Error('boom'))).toEqual({ status: 'error', code: 'ERROR', message: 'boom' });
    expect(classifyNodeError('not an error')).toEqual({ status: 'error', code: 'ERROR', message: 'not an error' });
  });

  it('a ProbeCollectionError carries its own status and code', async () => {
    const s = await collect(async () => {
      throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', 'socket refused');
    }, clock);
    expect(s).toEqual({
      status: 'error', observed_at: '2023-11-14T22:13:20.000Z',
      error: { code: 'HELPER_UNREACHABLE', message: 'socket refused' },
    });
    expect(collectionEvidence(s)).toEqual({
      status: 'error', observed_at: '2023-11-14T22:13:20.000Z', code: 'HELPER_UNREACHABLE', message: 'socket refused',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/agent/health/collect.test.ts`
Expected: FAIL — cannot resolve `../../../agent/health/collect.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/health/collection.ts
/**
 * Typed collection status (S19 §7, D-05). One closed enum per data source:
 * only `not_supported` (the tool is not installed) may become a `skipped`
 * check; the other failures become `degraded` with this block in their
 * evidence, so a failed query never looks like an absent component.
 */
export type CollectionStatus = 'success' | 'error' | 'timeout' | 'permission_denied' | 'not_supported';

export interface CollectionErrorInfo {
  code: string;
  message: string;
}

export interface Section<T> {
  status: CollectionStatus;
  /** The agent's clock at the end of the collection — never the api's request time. */
  observed_at: string;
  value?: T;
  error?: CollectionErrorInfo;
}

export interface CollectionEvidence {
  status: CollectionStatus;
  observed_at: string | null;
  code?: string;
  message?: string;
  /** 'kv' for facts read from the state store (no per-fact time in S19a). */
  source?: string;
}

export function isCollectionFailure(status: CollectionStatus): boolean {
  return status === 'error' || status === 'timeout' || status === 'permission_denied';
}

export function collectionEvidence(section: Section<unknown>): CollectionEvidence {
  return {
    status: section.status,
    observed_at: section.observed_at,
    ...(section.error !== undefined ? { code: section.error.code, message: section.error.message } : {}),
  };
}
```

```ts
// src/agent/health/collect.ts
import type { CollectionStatus, Section } from '../../lib/health/collection.js';

/** A dep that knows its own status throws this (e.g. HELPER_UNREACHABLE). */
export class ProbeCollectionError extends Error {
  constructor(
    readonly status: Exclude<CollectionStatus, 'success'>,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeCollectionError';
  }
}

export interface Classified {
  status: Exclude<CollectionStatus, 'success'>;
  code: string;
  message: string;
}

/** Node/execFile error → collection status (spec §7.1 table). */
export function classifyNodeError(err: unknown): Classified {
  if (err instanceof ProbeCollectionError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (!(err instanceof Error)) return { status: 'error', code: 'ERROR', message: String(err) };
  const e = err as Error & { code?: unknown; killed?: unknown; signal?: unknown };
  if (e.code === 'ENOENT') return { status: 'not_supported', code: 'TOOL_ABSENT', message: e.message };
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return { status: 'permission_denied', code: String(e.code), message: e.message };
  }
  if (e.killed === true || e.code === 'ETIMEDOUT') {
    return { status: 'timeout', code: 'TIMEOUT', message: e.message };
  }
  return { status: 'error', code: typeof e.code === 'string' ? e.code : 'ERROR', message: e.message };
}

/** Run one dep and fold its outcome into a Section. Never throws. */
export async function collect<T>(fn: () => Promise<T> | T, clock: () => number): Promise<Section<T>> {
  try {
    const value = await fn();
    return { status: 'success', observed_at: new Date(clock()).toISOString(), value };
  } catch (err) {
    const c = classifyNodeError(err);
    return {
      status: c.status,
      observed_at: new Date(clock()).toISOString(),
      error: { code: c.code, message: c.message },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/agent/health/collect.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/health/collection.ts src/agent/health/collect.ts src/__tests__/agent/health/collect.test.ts
git commit -F- <<'MSG'
feat(health): typed collection status types and the agent collect() helper (S19a T1)

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: `health.probe` returns schema 2 sections

**Files:**
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` (the handler, `execText`, both wirings)
- Test: `xiNAS-MCP/src/__tests__/agent/rpc/health-probe.test.ts` (rewrite the handler cases)

**Interfaces:**
- Consumes: `collect`, `ProbeCollectionError` (Task 1).
- Produces: `HealthProbeResultV2 { schema: 2; sections: { license: Section<ParsedLicense|null>; rdma_links: Section<RdmaLink[]>; collectors: Section<Record<string,string>>; nfs_profile_render: Section<Record<string,string>|null>; probes?: Section<DeepProbeResults> } }`. `HealthProbeDeps.clock?(): number`. Deps now **throw** on failure: `readLicenseText` rejects (never resolves null for "unavailable"; null means "ran, nothing printed"), `dryRenderNfsProfile` rejects with `ProbeCollectionError('error','HELPER_UNREACHABLE', …)`.

- [ ] **Step 1: Write the failing tests** (replace the three `health.probe handler` cases)

```ts
describe('health.probe handler (schema 2)', () => {
  const clock = () => 1_700_000_000_000;
  const okDeps = (over: Partial<HealthProbeDeps> = {}): HealthProbeDeps => ({
    readLicenseText: async () => VALID_LICENSE_TEXT, // the existing fixture constant in this file
    rdmaLinkShow: async () => JSON.stringify([{ netdev: 'ibp0', state: 'ACTIVE' }]),
    getCollectorHealth: () => ({ XiraidArray: 'running' }),
    dryRenderNfsProfile: async () => ({ '/etc/nfs.conf': 'sha256:abc' }),
    clock,
    ...over,
  });

  it('assembles every standard section as success with the clock time', async () => {
    const r = (await makeHealthProbeHandler(okDeps())({
      level: 'standard', desired_nfs_profile: { threads: 8 },
    })) as HealthProbeResultV2;
    expect(r.schema).toBe(2);
    expect(r.sections.license.status).toBe('success');
    expect(r.sections.license.value?.status).toBe('active');
    expect(r.sections.rdma_links).toMatchObject({ status: 'success', value: [{ netdev: 'ibp0', state: 'ACTIVE' }] });
    expect(r.sections.collectors).toMatchObject({ status: 'success', value: { XiraidArray: 'running' } });
    expect(r.sections.nfs_profile_render).toMatchObject({ status: 'success', value: { '/etc/nfs.conf': 'sha256:abc' } });
    expect(r.sections.license.observed_at).toBe('2023-11-14T22:13:20.000Z');
    expect(r.sections.probes).toBeUndefined();
  });

  it('each failing source degrades only its own section, with the reason kept', async () => {
    const deps = okDeps({
      readLicenseText: async () => { throw Object.assign(new Error('spawn xicli ENOENT'), { code: 'ENOENT' }); },
      rdmaLinkShow: async () => { throw Object.assign(new Error('rdma: EACCES'), { code: 'EACCES' }); },
      dryRenderNfsProfile: async () => { throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', 'refused'); },
    });
    const r = (await makeHealthProbeHandler(deps)({ level: 'standard', desired_nfs_profile: {} })) as HealthProbeResultV2;
    expect(r.sections.license).toMatchObject({ status: 'not_supported', error: { code: 'TOOL_ABSENT' } });
    expect(r.sections.rdma_links).toMatchObject({ status: 'permission_denied', error: { code: 'EACCES' } });
    expect(r.sections.nfs_profile_render).toMatchObject({ status: 'error', error: { code: 'HELPER_UNREACHABLE', message: 'refused' } });
    expect(r.sections.collectors.status).toBe('success');
  });

  it('no desired profile → render section success with value null, helper not called', async () => {
    let called = false;
    const deps = okDeps({ dryRenderNfsProfile: async () => { called = true; return {}; } });
    const r = (await makeHealthProbeHandler(deps)({ level: 'standard' })) as HealthProbeResultV2;
    expect(r.sections.nfs_profile_render).toMatchObject({ status: 'success', value: null });
    expect(called).toBe(false);
  });

  it('deep: the probes section is success when wired and error when the runner throws', async () => {
    const ok = okDeps({ runDeepProbes: async () => ({ fs_io: [{ mountpoint: '/mnt/a', ok: true }], nfs_loopback: null }) });
    const r1 = (await makeHealthProbeHandler(ok)({ level: 'deep' })) as HealthProbeResultV2;
    expect(r1.sections.probes).toMatchObject({ status: 'success', value: { fs_io: [{ mountpoint: '/mnt/a', ok: true }] } });
    const bad = okDeps({ runDeepProbes: async () => { throw new Error('mountinfo unreadable'); } });
    const r2 = (await makeHealthProbeHandler(bad)({ level: 'deep' })) as HealthProbeResultV2;
    expect(r2.sections.probes).toMatchObject({ status: 'error', error: { code: 'ERROR', message: 'mountinfo unreadable' } });
  });

  it('rejects a bad level', async () => {
    await expect(makeHealthProbeHandler(okDeps())({ level: 'quick' })).rejects.toThrow(/level/);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/__tests__/agent/rpc/health-probe.test.ts`
Expected: FAIL — `r.schema` undefined, sections missing.

- [ ] **Step 3: Implement**

In `health-probe.ts` replace `HealthProbeResult` with:

```ts
import { collect, ProbeCollectionError } from '../../health/collect.js';
import type { Section } from '../../../lib/health/collection.js';

export interface DeepProbeResults { /* unchanged */ }
export type RdmaLink = { netdev?: string; ifname?: string; state?: string; physical_state?: string };

export interface HealthProbeResultV2 {
  schema: 2;
  sections: {
    license: Section<ParsedLicense | null>;
    rdma_links: Section<RdmaLink[]>;
    collectors: Section<Record<string, string>>;
    nfs_profile_render: Section<Record<string, string> | null>;
    probes?: Section<DeepProbeResults>;
  };
}
```

Handler body:

```ts
const clock = deps.clock ?? Date.now;
const desired = typeof p.desired_nfs_profile === 'object' && p.desired_nfs_profile !== null
  ? (p.desired_nfs_profile as Record<string, unknown>) : null;
const sections: HealthProbeResultV2['sections'] = {
  license: await collect(async () => {
    const text = await deps.readLicenseText();
    return text === null ? null : parseXicliLicense(text, deps.now ?? Date.now);
  }, clock),
  rdma_links: await collect(async () => parseRdmaLinks(await deps.rdmaLinkShow()), clock),
  collectors: await collect(() => deps.getCollectorHealth(), clock),
  nfs_profile_render: await collect(
    async () => (desired === null ? null : deps.dryRenderNfsProfile(desired)), clock),
};
if (level === 'deep' && deps.runDeepProbes !== undefined) {
  const run = deps.runDeepProbes;
  sections.probes = await collect(
    () => run(typeof p.first_export_path === 'string' ? p.first_export_path : null), clock);
}
return { schema: 2, sections };
```

`parseRdmaLinks(raw)` keeps the current filter logic (empty string → `[]`, non-array → `[]`, non-object rows dropped) as a named function.

Wiring changes:

- `execText` → `execTextOrThrow(file, args)`: resolves `stdout`; rejects with the `execFile` error (its `code` is `ENOENT` when the binary is absent, `killed: true` on the 10 s timeout).
- fixture `readLicenseText`: missing `xicli-license.txt` → `throw new ProbeCollectionError('not_supported', 'TOOL_ABSENT', 'fixture: xicli-license.txt absent')`.
- fixture `dryRenderNfsProfile`: missing `nfs-profile-render.json` → `throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', 'fixture: nfs-profile-render.json absent')`.
- real `dryRenderNfsProfile`: `catch (err) { throw new ProbeCollectionError('error', 'HELPER_UNREACHABLE', err instanceof Error ? err.message : String(err)); }`.
- add `clock?(): number` to `HealthProbeDeps`.

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/__tests__/agent/rpc/health-probe.test.ts src/__tests__/agent/health/probe-host.test.ts`
Expected: PASS. (`probe-host.test.ts` still passes: `makeDeepProbeRunner` is untouched until Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/rpc/methods/health-probe.ts src/__tests__/agent/rpc/health-probe.test.ts
git commit -F- <<'MSG'
feat(agent): health.probe answers schema 2 with a typed status per section (S19a T1)

Requires-Rebuild: xinas_node_build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Api builders map sections to check outcomes

**Files:**
- Modify: `xiNAS-MCP/src/lib/health/standard.ts`, `xiNAS-MCP/src/lib/health/drift.ts` (`driftNfsConfCheck`)
- Test: `xiNAS-MCP/src/__tests__/lib/health/standard.test.ts` (new)

**Interfaces:**
- Consumes: `Section<T>`, `collectionEvidence`, `isCollectionFailure` (Task 1).
- Produces: `xiraidLicenseCheck(section: Section<ProbeLicense|null>)`, `xiraidServiceCheck(section: Section<Record<string,string>>)`, `rdmaLiveCheck(section: Section<ProbeRdmaLink[]>)`, `agentCollectorsCheck(section)`, `filesystemIoCheck(section: Section<ProbeDeepResults>)`, `nfsLoopbackCheck(section: Section<ProbeDeepResults>)`, `probeUnavailable(level, reason)` (evidence gains `collection`), `driftNfsConfCheck(desired, render: Section<Record<string,string>|null> | undefined, effectiveFiles)`; exported helper `collectionFailureCheck(base, section)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/lib/health/standard.test.ts
import { describe, expect, it } from 'vitest';
import type { Section } from '../../../lib/health/collection.js';
import {
  agentCollectorsCheck, filesystemIoCheck, nfsLoopbackCheck, probeUnavailable,
  rdmaLiveCheck, xiraidLicenseCheck, xiraidServiceCheck,
} from '../../../lib/health/standard.js';

const at = '2023-11-14T22:13:20.000Z';
const ok = <T>(value: T): Section<T> => ({ status: 'success', observed_at: at, value });
const failed = (status: 'error' | 'timeout' | 'permission_denied', code: string): Section<never> =>
  ({ status, observed_at: at, error: { code, message: `${code} happened` } });
const absent: Section<never> = { status: 'not_supported', observed_at: at, error: { code: 'TOOL_ABSENT', message: 'ENOENT' } };

describe('collection status → check status (spec §7.2)', () => {
  it('not_supported is the ONLY status that yields skipped, and it says the tool is missing', () => {
    const c = xiraidLicenseCheck(absent);
    expect(c.status).toBe('skipped');
    expect(c.symptom).toContain('not installed');
    expect(c.evidence.collection).toEqual({ status: 'not_supported', observed_at: at, code: 'TOOL_ABSENT', message: 'ENOENT' });
  });

  it.each(['error', 'timeout', 'permission_denied'] as const)('%s → degraded with the code in evidence', (status) => {
    for (const build of [xiraidLicenseCheck, xiraidServiceCheck, rdmaLiveCheck, agentCollectorsCheck, filesystemIoCheck, nfsLoopbackCheck]) {
      const c = build(failed(status, 'X_CODE') as never);
      expect(c.status, build.name).toBe('degraded');
      expect(c.symptom, build.name).toContain('collection failed: X_CODE');
      expect(c.evidence.collection, build.name).toMatchObject({ status, code: 'X_CODE' });
    }
  });

  it('success + empty keeps the old skipped symptom but now says the query succeeded', () => {
    const c = rdmaLiveCheck(ok([]));
    expect(c.status).toBe('skipped');
    expect(c.symptom).toBe('no RDMA links reported');
    expect(c.evidence.collection).toEqual({ status: 'success', observed_at: at });
  });

  it('success values flow into the existing logic and carry collection evidence', () => {
    expect(xiraidLicenseCheck(ok({ status: 'active', days_left: 100, features: [] }))).toMatchObject({
      status: 'ok', evidence: { days_left: 100, collection: { status: 'success', observed_at: at } },
    });
    expect(xiraidLicenseCheck(ok({ status: 'expired', days_left: null, features: [] })).status).toBe('critical');
    expect(xiraidServiceCheck(ok({ XiraidArray: 'error: down' })).status).toBe('critical');
    expect(agentCollectorsCheck(ok({ a: 'running', b: 'error: x' })).status).toBe('degraded');
    expect(filesystemIoCheck(ok({ fs_io: [{ mountpoint: '/m', ok: false, error: 'EIO' }], nfs_loopback: null })).status).toBe('critical');
    expect(nfsLoopbackCheck(ok({ fs_io: [], nfs_loopback: { attempted: true, export: '/srv', ok: true } })).status).toBe('ok');
  });

  it('probeUnavailable degrades every probe-backed check with EXECUTOR_UNAVAILABLE collection evidence', () => {
    const checks = probeUnavailable('deep', 'connect refused');
    expect(checks.map((c) => c.id)).toEqual([
      'xiraid.license', 'xiraid.service', 'network.rdma-live', 'agent.collectors', 'drift.nfs-conf', 'filesystem.io', 'nfs.loopback',
    ]);
    for (const c of checks) {
      expect(c.status).toBe('degraded');
      expect(c.evidence.collection).toEqual({ status: 'error', observed_at: null, code: 'EXECUTOR_UNAVAILABLE', message: 'connect refused' });
    }
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/__tests__/lib/health/standard.test.ts`
Expected: FAIL — builders read `section.status`/`.value` and get undefined (`c.status` not skipped/degraded as asserted).

- [ ] **Step 3: Implement**

In `standard.ts` add:

```ts
import { type Section, collectionEvidence, isCollectionFailure } from './collection.js';

const RECOMMENDED: Record<string, string> = {
  timeout: 'the source did not answer in time; re-run the profile and check agent load',
  permission_denied: 'the agent lacks permission to read this source; check the unit capabilities',
  error: 'inspect the agent journal for the collection error',
};

/** Spec §7.2: the shared prelude of every probe-backed builder. */
export function collectionFailureCheck(
  base: { id: string; category: HealthCheckResult['category'] },
  section: Section<unknown>,
): HealthCheckResult | undefined {
  if (section.status === 'success') return undefined;
  const collection = collectionEvidence(section);
  if (section.status === 'not_supported') {
    return {
      ...base, status: 'skipped',
      symptom: `${section.error?.code === 'TOOL_ABSENT' ? 'tool' : section.error?.code ?? 'source'} not installed`,
      impact: 'none', evidence: { collection }, recommended_action: 'no action required',
    };
  }
  if (!isCollectionFailure(section.status)) return undefined;
  return {
    ...base, status: 'degraded',
    symptom: `collection failed: ${section.error?.code ?? section.status}`,
    impact: 'the state behind this check is unknown',
    evidence: { collection },
    recommended_action: RECOMMENDED[section.status] ?? RECOMMENDED.error,
  };
}
```

Each builder becomes `export function xiraidLicenseCheck(section: Section<ProbeLicense | null>) { const base = …; const failed = collectionFailureCheck(base, section); if (failed) return failed; const license = section.value ?? null; const collection = collectionEvidence(section); … }` and every returned result spreads `collection` into `evidence` (`evidence: { ...license, collection }`, `evidence: { collectors: …, collection }`, etc.). `filesystemIoCheck` / `nfsLoopbackCheck` take `Section<ProbeDeepResults>` and read `section.value?.fs_io ?? []` / `section.value?.nfs_loopback ?? null`. `probeUnavailable` adds `collection: { status: 'error', observed_at: null, code: 'EXECUTOR_UNAVAILABLE', message: reason }` to each evidence. In `drift.ts`, `driftNfsConfCheck(desired, render: Section<Record<string,string>|null> | undefined, effectiveFiles)`: `undefined` keeps today's "skipped (quick)" branch; a failed section returns `collectionFailureCheck({ id: 'drift.nfs-conf', category: 'drift' }, render)`; success uses `render.value` as before and adds `collection` to evidence.

- [ ] **Step 4: Run GREEN, then typecheck (the route no longer compiles until Task 4 — that is expected; run only the lib tests here)**

Run: `npx vitest run src/__tests__/lib/health/`
Expected: PASS.

- [ ] **Step 5: Commit** (message `feat(health): standard/deep builders map typed collection status (S19a T1)` with the trailer and co-author lines as in Task 1).

---

### Task 4: The health route — v2 normalization, `coverage_status`, `collection`, OpenAPI

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/health.ts`
- Modify: `xiNAS-MCP/src/__tests__/api/_helpers.ts` — add `respondToRpc(method, handler)` to `MockAgentServer`
- Modify: `docs/control-path/api-v1.yaml` (`HealthReport`)
- Test: `xiNAS-MCP/src/__tests__/api/routes-health.test.ts` (new cases), `xiNAS-MCP/src/__tests__/api/mock-agent.test.ts` (one case for the hook)

**Interfaces:**
- Consumes: Task 3 builders; `HealthProbeResultV2` shape (structural copy in the route — `api/` must not import from `agent/`).
- Produces: `HealthReport.coverage_status: 'complete' | 'partial'`, `HealthReport.collection: { agent: 'answered' | 'unavailable' | 'not_needed'; sources: Record<string, CollectionStatus> }`; every quick check's `evidence.collection = { status: 'success', source: 'kv', observed_at: null }`.
- Mock agent: `respondToRpc(method: string, handler: (params: unknown) => { result: unknown } | { error: { code: number; message: string; data?: unknown } }): void` — consulted before the built-in branches.

- [ ] **Step 1: Write the failing tests**

In `_helpers.ts` (test infrastructure, no RED needed) add the hook: a `Map<string, RpcHook>` checked first in the connection handler:

```ts
const rpcHooks = new Map<string, (params: unknown) => { result: unknown } | { error: { code: number; message: string; data?: unknown } }>();
// in the line loop, before `if (req.method === 'agent.health' …)`:
const hook = typeof req.method === 'string' ? rpcHooks.get(req.method) : undefined;
if (hook !== undefined) {
  const out = hook(req.params);
  conn.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...out })}\n`);
  continue;
}
// on the returned object:
respondToRpc(method, handler) { rpcHooks.set(method, handler); },
```

Route tests (`routes-health.test.ts`, using `buildTestAppWithMockAgent` — read its signature in `_helpers.ts`; it returns `{ app, state, mockAgent, cleanup }`):

```ts
describe('S19a: coverage_status and collection (spec §7.3)', () => {
  const at = '2023-11-14T22:13:20.000Z';
  const section = (value: unknown, status = 'success') => ({ status, observed_at: at, value });

  it('quick: complete coverage, agent not_needed, every check carries kv collection evidence', async () => {
    const res = await request(setup.app).get('/api/v1/health?profile=quick').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.coverage_status).toBe('complete');
    expect(res.body.result.collection).toEqual({ agent: 'not_needed', sources: {} });
    for (const c of res.body.result.checks) expect(c.evidence.collection).toEqual({ status: 'success', source: 'kv', observed_at: null });
  });

  it('standard with a v2 probe: sources listed; a not_supported source keeps coverage complete', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({ result: { schema: 2, sections: {
      license: { status: 'not_supported', observed_at: at, error: { code: 'TOOL_ABSENT', message: 'ENOENT' } },
      rdma_links: section([]), collectors: section({ XiraidArray: 'running' }), nfs_profile_render: section(null),
    } } }));
    const res = await request(setup.app).get('/api/v1/health?profile=standard').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result.collection).toEqual({ agent: 'answered', sources: {
      license: 'not_supported', rdma_links: 'success', collectors: 'success', nfs_profile_render: 'success' } });
    expect(res.body.result.coverage_status).toBe('complete');
    const byId = new Map(res.body.result.checks.map((c: { id: string }) => [c.id, c]));
    expect(byId.get('xiraid.license')).toMatchObject({ status: 'skipped', evidence: { collection: { status: 'not_supported' } } });
  });

  it('standard with a failed source: coverage partial, the check is degraded, overall follows', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({ result: { schema: 2, sections: {
      license: section({ status: 'active', days_left: 90, features: [] }),
      rdma_links: { status: 'timeout', observed_at: at, error: { code: 'TIMEOUT', message: 'rdma link show' } },
      collectors: section({}), nfs_profile_render: section(null),
    } } }));
    const res = await request(setup.app).get('/api/v1/health?profile=standard').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result.coverage_status).toBe('partial');
    expect(res.body.result.collection.sources.rdma_links).toBe('timeout');
    expect(res.body.result.overall).toBe('degraded');
  });

  it('a legacy (v1) probe result is mapped to error/LEGACY_AGENT on every section', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({ result: { license: null, rdma_links: [], collectors: {}, nfs_profile_render: null } }));
    const res = await request(setup.app).get('/api/v1/health?profile=standard').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result.coverage_status).toBe('partial');
    expect(Object.values(res.body.result.collection.sources)).toEqual(['error', 'error', 'error', 'error']);
    const lic = res.body.result.checks.find((c: { id: string }) => c.id === 'xiraid.license');
    expect(lic.evidence.collection.code).toBe('LEGACY_AGENT');
  });

  it('agent unavailable on standard: coverage partial, collection.agent unavailable', async () => {
    setup.mockAgent.respondToRpc('health.probe', () => ({ error: { code: -32603, message: 'down' } }));
    const res = await request(setup.app).get('/api/v1/health?profile=standard').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result.collection.agent).toBe('unavailable');
    expect(res.body.result.coverage_status).toBe('partial');
  });
});
```

- [ ] **Step 2: RED** — `npx vitest run src/__tests__/api/routes-health.test.ts` fails on `coverage_status` undefined.

- [ ] **Step 3: Implement** in `routes/health.ts`:

```ts
type SectionLike<T> = { status: CollectionStatus; observed_at: string; value?: T; error?: { code: string; message: string } };
interface ProbeV2 { schema: 2; sections: { license: SectionLike<ProbeLicense | null>; rdma_links: SectionLike<ProbeRdmaLink[]>;
  collectors: SectionLike<Record<string, string>>; nfs_profile_render: SectionLike<Record<string, string> | null>; probes?: SectionLike<ProbeDeepResults> } }
const SECTION_NAMES = ['license', 'rdma_links', 'collectors', 'nfs_profile_render', 'probes'] as const;

function normalizeProbe(raw: unknown, level: 'standard' | 'deep'): ProbeV2 {
  const r = raw as Partial<ProbeV2> | null;
  if (r !== null && typeof r === 'object' && r.schema === 2 && r.sections !== undefined) return r as ProbeV2;
  const legacy = (): SectionLike<never> => ({ status: 'error', observed_at: new Date().toISOString(),
    error: { code: 'LEGACY_AGENT', message: 'the agent answered health.probe with the schema 1 shape; rebuild and restart it' } });
  return { schema: 2, sections: { license: legacy(), rdma_links: legacy(), collectors: legacy(), nfs_profile_render: legacy(),
    ...(level === 'deep' ? { probes: legacy() } : {}) } };
}
const withKv = (c: HealthCheckResult): HealthCheckResult =>
  c.evidence.collection === undefined ? { ...c, evidence: { ...c.evidence, collection: { status: 'success', source: 'kv', observed_at: null } } } : c;
```

Route flow: quick → `checks.map(withKv)`, `collection = { agent: 'not_needed', sources: {} }`, `coverage_status: 'complete'`. standard/deep → after the RPC: `probe === null` → `probeUnavailable`, `collection = { agent: 'unavailable', sources: {} }`, `coverage: 'partial'`; else `v2 = normalizeProbe(probe, level)`, builders take `v2.sections.*`, `sources` = `Object.fromEntries(SECTION_NAMES.filter(n => v2.sections[n]).map(n => [n, v2.sections[n].status]))`, `coverage = Object.values(sources).some(isCollectionFailure) ? 'partial' : 'complete'`. Response adds `coverage_status` and `collection`. The KV-derived drift checks and quick checks go through `withKv`.

`api-v1.yaml` `HealthReport`: add

```yaml
        coverage_status:
          type: string
          enum: [complete, partial]
          description: S19 — partial when the agent was unavailable on standard/deep or any probe section failed to collect (error, timeout, permission_denied); complete otherwise. Does not change `overall`.
        collection:
          type: object
          description: S19 — how the probe-backed sections were collected.
          properties:
            agent: { type: string, enum: [answered, unavailable, not_needed] }
            sources:
              type: object
              additionalProperties: { type: string, enum: [success, error, timeout, permission_denied, not_supported] }
```

and to `HealthCheck.evidence` description: "May carry `collection: { status, observed_at, code?, message?, source? }` (S19 §7.2)."

- [ ] **Step 4: GREEN + gates** — `npx vitest run src/__tests__/api/routes-health.test.ts src/__tests__/api/mock-agent.test.ts src/__tests__/lib/health/ && npm run typecheck && npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset ../.spectral.yaml ../docs/control-path/api-v1.yaml` (0 errors) and `/Users/sergeyplatonov/Documents/GitHub/xiNAS/.venv/bin/yamllint -c ../.yamllint.yml ../docs/control-path/api-v1.yaml`.

- [ ] **Step 5: Commit** — `feat(api): health report carries coverage_status and per-source collection status (S19a T1)` + `api-v1.yaml` in the same commit, trailer and co-author.

---

### Task 5: The hardened probe host

**Files:**
- Create: `xiNAS-MCP/src/lib/health/probe-types.ts`
- Rewrite: `xiNAS-MCP/src/agent/health/probe-host.ts`, `xiNAS-MCP/src/agent/health/fake-probe-host.ts`
- Test: `xiNAS-MCP/src/__tests__/agent/health/probe-host.test.ts` (rewrite)

**Interfaces:**
- Produces:

```ts
// lib/health/probe-types.ts
export type ProbeKind = 'fs_io' | 'nfs_loopback';
export type ProbeStage = 'open' | 'dir' | 'create' | 'write' | 'fsync' | 'read' | 'unlink' | 'lock' | 'mount' | 'readdir' | 'umount';
export interface ProbeRunOptions { runId: string | null; timeoutMs: number }
export interface ProbeOutcome {
  ok: boolean; started_at: string; completed_at: string;
  artifact: { kind: 'file' | 'mountpoint'; path: string } | null;
  error?: { code: string; message: string; stage: ProbeStage };
  cleanup: { status: 'clean' | 'failed' | 'not_needed'; detail?: string };
}
export const PROVES: Record<ProbeKind, string> = {
  fs_io: 'a 4 KiB write, fsync, read-back and unlink succeeded on this mountpoint from the node itself; not client connectivity, not RDMA, not durability beyond fsync',
  nfs_loopback: 'the export was NFS-mounted from the node itself, listed and unmounted; not real-client connectivity, not RDMA transport',
};
export const PROBE_PAYLOAD_BYTES = 4096;
export const PROBE_DIR_NAME = '.xinas-health';
```

```ts
// agent/health/probe-host.ts
export interface ProbeHost {
  fsIo(mountpoint: string, opts: ProbeRunOptions): Promise<ProbeOutcome>;
  nfsLoopback(exportPath: string, opts: ProbeRunOptions): Promise<ProbeOutcome>;
}
export interface RealProbeHostDeps {
  /** Loopback root; default /run/xinas/health-probe. */
  root?: string;
  /** Owner the probe directory must have; default process.getuid?.() ?? 0. */
  uid?: number;
  /** 16 hex chars; default randomBytes(8).toString('hex'). */
  random?: () => string;
  /** systemd-mount / systemd-umount runner; default execFile with a timeout. */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>;
  clock?: () => number;
}
export function createRealProbeHost(deps?: RealProbeHostDeps): ProbeHost;
```

- [ ] **Step 1: Write the failing tests** (new file; the old `touchProbe` cases go away)

```ts
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeProbeHost } from '../../../agent/health/fake-probe-host.js';
import { createRealProbeHost } from '../../../agent/health/probe-host.js';
import { PROBE_DIR_NAME } from '../../../lib/health/probe-types.js';

const base = mkdtempSync(join(tmpdir(), 'xinas-probe-host-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string): string => { const d = join(base, name); mkdirSync(d); return d; };
const opts = { runId: 'run-1', timeoutMs: 5_000 };

describe('createRealProbeHost.fsIo (spec §9.3)', () => {
  it('writes a unique per-run file under .xinas-health, reads it back, unlinks it, reports clean', async () => {
    const mnt = fresh('ok');
    const host = createRealProbeHost({ random: () => 'deadbeefdeadbeef' });
    const r = await host.fsIo(mnt, opts);
    expect(r.ok).toBe(true);
    expect(r.artifact).toEqual({ kind: 'file', path: join(mnt, PROBE_DIR_NAME, 'probe-run-1-deadbeefdeadbeef') });
    expect(r.cleanup).toEqual({ status: 'clean' });
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);           // only its own file, and it is gone
  });

  it('two runs never share a name; a colliding random retries', async () => {
    const mnt = fresh('unique');
    const names: string[] = [];
    let n = 0;
    const host = createRealProbeHost({ random: () => (n++ < 2 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb') });
    mkdirSync(join(mnt, PROBE_DIR_NAME));
    writeFileSync(join(mnt, PROBE_DIR_NAME, 'probe-run-1-aaaaaaaaaaaaaaaa'), 'someone else');
    const r = await host.fsIo(mnt, opts);
    expect(r.ok).toBe(true);
    names.push(r.artifact?.path ?? '');
    expect(names[0]).toContain('bbbbbbbbbbbbbbbb');
    // the foreign file is untouched
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual(['probe-run-1-aaaaaaaaaaaaaaaa']);
  });

  it('a symlinked .xinas-health is refused before anything is written', async () => {
    const mnt = fresh('symlink');
    const elsewhere = fresh('elsewhere');
    symlinkSync(elsewhere, join(mnt, PROBE_DIR_NAME));
    const r = await createRealProbeHost().fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'probe_dir_untrusted', stage: 'dir' });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(r.cleanup).toEqual({ status: 'not_needed' });
  });

  it('a probe directory owned by someone else is refused', async () => {
    const mnt = fresh('owner');
    const r = await createRealProbeHost({ uid: (process.getuid?.() ?? 0) + 1 }).fsIo(mnt, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'probe_dir_untrusted', stage: 'dir' });
  });

  it('a cleanup failure is reported, never swallowed', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const mnt = fresh('cleanup');
    const host = createRealProbeHost({ random: () => 'cafecafecafecafe' });
    const dir = join(mnt, PROBE_DIR_NAME);
    mkdirSync(dir, { mode: 0o700 });
    // make the directory non-writable AFTER the file is created: hook the fsync step
    const r = await host.fsIo(mnt, { ...opts, timeoutMs: 5_000 }, { beforeUnlink: () => chmodSync(dir, 0o500) });
    chmodSync(dir, 0o700);
    expect(r.ok).toBe(true);
    expect(r.cleanup.status).toBe('failed');
    expect(r.cleanup.detail).toMatch(/EACCES|EPERM/);
  });

  it('a missing mountpoint fails at the open stage', async () => {
    const r = await createRealProbeHost().fsIo(join(base, 'nope'), opts);
    expect(r).toMatchObject({ ok: false, error: { code: 'ENOENT', stage: 'open' }, cleanup: { status: 'not_needed' } });
  });

  it('a step that exceeds the timeout ends the probe with TIMEOUT and still attempts the unlink', async () => {
    const mnt = fresh('timeout');
    const host = createRealProbeHost({ random: () => 'feedfeedfeedfeed' });
    const r = await host.fsIo(mnt, { runId: null, timeoutMs: 20 }, { beforeFsync: () => new Promise((res) => setTimeout(res, 200)) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'TIMEOUT', stage: 'fsync' });
    expect(readdirSync(join(mnt, PROBE_DIR_NAME))).toEqual([]);
  });
});

describe('createRealProbeHost.nfsLoopback', () => {
  it('mounts at a per-run directory, lists, unmounts, removes the directory', async () => {
    const root = fresh('loop-root');
    const calls: string[][] = [];
    const host = createRealProbeHost({ root, random: () => 'abcdabcdabcdabcd', exec: async (file, args) => { calls.push([file, ...args]); } });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r.ok).toBe(true);
    const mnt = join(root, 'run-1-abcdabcdabcdabcd', 'mnt');
    expect(r.artifact).toEqual({ kind: 'mountpoint', path: mnt });
    expect(calls).toEqual([['systemd-mount', '--collect', 'localhost:/srv/data', mnt], ['systemd-umount', mnt]]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a second concurrent loopback is refused with PROBE_IN_PROGRESS while the first holds the lock', async () => {
    const root = fresh('loop-lock');
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const host = createRealProbeHost({ root, exec: async (file) => { if (file === 'systemd-mount') await gate; } });
    const first = host.nfsLoopback('/srv/a', opts);
    await new Promise((res) => setTimeout(res, 10));
    const second = await host.nfsLoopback('/srv/b', opts);
    expect(second).toMatchObject({ ok: false, error: { code: 'PROBE_IN_PROGRESS', stage: 'lock' } });
    release();
    expect((await first).ok).toBe(true);
  });

  it('a failed umount leaves the directory and reports cleanup failed', async () => {
    const root = fresh('loop-umount');
    const host = createRealProbeHost({ root, random: () => '0000000000000000', exec: async (file) => { if (file === 'systemd-umount') throw new Error('busy'); } });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r.ok).toBe(true);
    expect(r.cleanup).toEqual({ status: 'failed', detail: 'systemd-umount: busy' });
    expect(readdirSync(root)).toEqual(['run-1-0000000000000000']);
  });

  it('a mount failure is the result, not a throw', async () => {
    const root = fresh('loop-fail');
    const host = createRealProbeHost({ root, exec: async (file) => { if (file === 'systemd-mount') throw new Error('mount.nfs: access denied'); } });
    const r = await host.nfsLoopback('/srv/data', opts);
    expect(r).toMatchObject({ ok: false, error: { stage: 'mount' }, cleanup: { status: 'clean' } });
  });
});

describe('createFakeProbeHost', () => {
  it('honors fail lists and records the same op strings the e2e suite reads', async () => {
    const dir = fresh('fake');
    writeFileSync(join(dir, 'probe-host-state.json'), JSON.stringify({ fail_touch: ['/mnt/bad'], fail_loopback: ['/srv/bad'] }));
    const host = createFakeProbeHost(dir);
    expect((await host.fsIo('/mnt/ok', opts)).ok).toBe(true);
    expect((await host.fsIo('/mnt/bad', opts)).ok).toBe(false);
    expect((await host.nfsLoopback('/srv/ok', opts)).ok).toBe(true);
    expect((await host.nfsLoopback('/srv/bad', opts)).ok).toBe(false);
    const state = JSON.parse(readFileSync(join(dir, 'probe-host-state.json'), 'utf8'));
    expect(state.ops).toEqual(['touch:/mnt/ok', 'touch:/mnt/bad', 'loopback:/srv/ok', 'loopback-umount:/srv/ok', 'loopback:/srv/bad', 'loopback-umount:/srv/bad']);
  });
});
```

(`fsIo` takes an optional third `hooks?: { beforeFsync?(): Promise<void> | void; beforeUnlink?(): Promise<void> | void }` argument used only by tests; document it on the interface as test-only.)

- [ ] **Step 2: RED** — `npx vitest run src/__tests__/agent/health/probe-host.test.ts` fails (`fsIo` is not a function).

- [ ] **Step 3: Implement `probe-host.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, type FileHandle, mkdir, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PROBE_DIR_NAME, PROBE_PAYLOAD_BYTES, type ProbeOutcome, type ProbeRunOptions, type ProbeStage } from '../../lib/health/probe-types.js';

const DEFAULT_ROOT = '/run/xinas/health-probe';
const LOCK_NAME = '.lock';
const PAYLOAD = Buffer.alloc(PROBE_PAYLOAD_BYTES, 'xinas-health-probe\n');

class StageError extends Error {
  constructor(readonly stage: ProbeStage, readonly code: string, message: string) { super(message); }
}
const codeOf = (err: unknown): string =>
  err instanceof StageError ? err.code : typeof (err as { code?: unknown })?.code === 'string' ? String((err as { code: string }).code) : 'ERROR';

async function step<T>(stage: ProbeStage, deadline: number, clock: () => number, fn: () => Promise<T>): Promise<T> {
  const left = deadline - clock();
  if (left <= 0) throw new StageError(stage, 'TIMEOUT', `probe timed out before ${stage}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StageError(stage, 'TIMEOUT', `probe timed out during ${stage}`)), left); }),
    ]);
  } catch (err) {
    if (err instanceof StageError) throw err;
    throw new StageError(stage, codeOf(err), err instanceof Error ? err.message : String(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

`fsIo(mountpoint, opts, hooks)`:

1. `open(mountpoint, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)` → `mnt`; `const mntStat = await mnt.stat()`; stage `open`.
2. stage `dir`: `mkdir(join(mountpoint, PROBE_DIR_NAME), { mode: 0o700 })` ignoring `EEXIST`; `open(dirPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)` (a symlink → `ELOOP`/`ENOTDIR` → mapped to `probe_dir_untrusted`); `dirStat = await dir.stat()`; require `dirStat.dev === mntStat.dev && dirStat.uid === uid && dirStat.isDirectory()` else `throw new StageError('dir', 'probe_dir_untrusted', …)`.
3. stage `create`: up to 3 attempts: `name = \`probe-${opts.runId ?? 'none'}-${random()}\``; `open(join(dirPath, name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`; `EEXIST` → next attempt; other → throw. After opening: `fstat` → require `st.dev === mntStat.dev && st.nlink === 1 && st.isFile()` else `probe_dir_untrusted` (the post-open check that stands in for `openat`). `artifact = { kind: 'file', path }`.
4. stage `write`: `fh.write(PAYLOAD)`; stage `fsync`: `await hooks?.beforeFsync?.(); await fh.sync()`; close.
5. stage `read`: `open(path, O_RDONLY | O_NOFOLLOW)`, `fstat().ino === written ino`, read `PROBE_PAYLOAD_BYTES`, `Buffer.compare === 0` else `StageError('read', 'READ_BACK_MISMATCH', …)`; close.
6. `finally` (whenever the file was created): `await hooks?.beforeUnlink?.(); try { await unlink(path); cleanup = { status: 'clean' } } catch (e) { cleanup = { status: 'failed', detail: \`${codeOf(e)}: ${message}\` } }` — the unlink is attempted even after a TIMEOUT; before creation `cleanup = { status: 'not_needed' }`.
7. Every handle is closed in `finally`. Result `{ ok, started_at, completed_at, artifact, error?, cleanup }`.

`nfsLoopback(exportPath, opts)`:

1. stage `lock`: in-process `let loopbackBusy = false` guard **and** `open(join(root, LOCK_NAME), O_WRONLY | O_CREAT | O_EXCL, 0o600)` after `mkdir(root, { recursive: true, mode: 0o700 })`; on `EEXIST` read the pid inside; if `process.kill(pid, 0)` throws `ESRCH` the lock is stale → `unlink` and retry once; otherwise `StageError('lock', 'PROBE_IN_PROGRESS', 'another loopback probe holds the lock')`. Write `process.pid` into the lock. Result `cleanup: { status: 'not_needed' }` on a lock refusal.
2. `dir = join(root, \`${opts.runId ?? 'none'}-${random()}\`)`, `mnt = join(dir, 'mnt')`, `mkdir(mnt, { recursive: true, mode: 0o700 })`; `artifact = { kind: 'mountpoint', path: mnt }`.
3. stage `mount`: `exec('systemd-mount', ['--collect', \`localhost:${exportPath}\`, mnt], left)`; on failure → error result, then `rm(dir, { recursive: true })` → `cleanup: clean` (nothing was mounted).
4. stage `readdir`: `readdir(mnt)`.
5. `finally` after a successful mount: `exec('systemd-umount', [mnt], min(left, 20_000))` — success → `rmdir(mnt); rmdir(dir)`; `cleanup: { status: 'clean' }`; failure → `cleanup: { status: 'failed', detail: \`systemd-umount: ${message}\` }` and the directory stays. Lock file unlinked and `loopbackBusy = false` in the outermost `finally`.

Default `exec`:

```ts
const defaultExec = (file: string, args: string[], timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, _stdout, stderr) => {
      if (err !== null) reject(new Error(`${file} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
```

`fake-probe-host.ts`: same state-file protocol; `fsIo` records `touch:<mountpoint>`, `nfsLoopback` records `loopback:<export>` then `loopback-umount:<export>`; failures come from `fail_touch` / `fail_loopback`; outcomes carry `artifact: { kind: 'file', path: \`${mountpoint}/.xinas-health/probe-${runId ?? 'none'}-fake\` }` / `{ kind: 'mountpoint', path: \`/run/xinas/health-probe/${runId ?? 'none'}-fake/mnt\` }`, `cleanup: { status: 'clean' }`, `error: { code: 'FAKE_FAIL', message: 'fake touch failure' | 'fake loopback failure', stage: 'write' | 'mount' }`.

- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/agent/health/probe-host.test.ts` (the old `makeDeepProbeRunner` block is deleted from this file; Task 6 re-adds its test next to the runner).

- [ ] **Step 5: Commit** — `feat(agent): hardened probe host with per-run artifacts and cleanup verdicts (S19a T2)`.

---

### Task 6: Deep runner on the new host, `health.probe.run` RPC, dispatcher code pass-through

**Files:**
- Modify: `xiNAS-MCP/src/agent/rpc/methods/health-probe.ts` (`makeDeepProbeRunner`, `DeepProbeResults` rows gain `cleanup`)
- Create: `xiNAS-MCP/src/agent/rpc/methods/health-probe-run.ts`
- Modify: `xiNAS-MCP/src/agent/rpc/dispatch.ts` (structured codes), `xiNAS-MCP/src/agent-server.ts` (register)
- Test: `xiNAS-MCP/src/__tests__/agent/rpc/health-probe-run.test.ts` (new), `xiNAS-MCP/src/__tests__/agent/rpc/dispatch.test.ts` (one case; find the existing dispatcher test file with `grep -rl createDispatcher src/__tests__/agent` and add there)

**Interfaces:**
- Produces: RPC `health.probe.run` params `{ probe: ProbeKind; path: string; run_id?: string | null; timeout_ms?: number }` → result `ProbeOutcome & { probe: ProbeKind; path: string }`. Errors: `INVALID_PARAMS` (-32602); `PROBE_IN_PROGRESS` as `-32000` with `data: { code: 'PROBE_IN_PROGRESS' }`.
- `makeHealthProbeRunHandler({ probeHost, maxTimeoutMs = 60_000, defaultTimeoutMs = 20_000 })`.
- `DeepProbeResults.fs_io[i]` gains `cleanup?: ProbeOutcome['cleanup']`; `nfs_loopback` likewise.
- `createDispatcher`: an `Error` whose `code` is in `PASSTHROUGH_CODES = new Set(['PROBE_IN_PROGRESS', 'PRECONDITION_FAILED', 'NOT_FOUND'])` becomes `-32000` with `{ code, ...(err.details ?? {}) }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/agent/rpc/health-probe-run.test.ts
import { describe, expect, it } from 'vitest';
import type { ProbeHost } from '../../../agent/health/probe-host.js';
import { makeHealthProbeRunHandler } from '../../../agent/rpc/methods/health-probe-run.js';
import { makeDeepProbeRunner } from '../../../agent/rpc/methods/health-probe.js';

const outcome = (ok: boolean) => ({ ok, started_at: 's', completed_at: 'c', artifact: null, cleanup: { status: 'clean' as const } });
const slowHost = (gate: Promise<void>): ProbeHost => ({
  fsIo: async () => { await gate; return outcome(true); },
  nfsLoopback: async () => outcome(true),
});

describe('health.probe.run handler', () => {
  it('validates params: probe kind, absolute path, timeout bounds', async () => {
    const h = makeHealthProbeRunHandler({ probeHost: slowHost(Promise.resolve()) });
    await expect(h({ probe: 'scrub', path: '/mnt/a' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(h({ probe: 'fs_io', path: 'relative' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(h({ probe: 'fs_io', path: '/mnt/a', timeout_ms: 999_999 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('runs one probe and echoes probe/path; a second concurrent call is PROBE_IN_PROGRESS', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = makeHealthProbeRunHandler({ probeHost: slowHost(gate) });
    const first = h({ probe: 'fs_io', path: '/mnt/a', run_id: 'r1' });
    await expect(h({ probe: 'nfs_loopback', path: '/srv/x' })).rejects.toMatchObject({ code: 'PROBE_IN_PROGRESS' });
    release();
    expect(await first).toMatchObject({ probe: 'fs_io', path: '/mnt/a', ok: true });
    // the guard is released afterwards
    expect(await h({ probe: 'nfs_loopback', path: '/srv/x' })).toMatchObject({ ok: true });
  });
});

describe('makeDeepProbeRunner over the new host', () => {
  it('touches every mounted fs with runId null; loopback only with an export; listing failure → empty', async () => {
    const seen: string[] = [];
    const host: ProbeHost = {
      fsIo: async (m, o) => { seen.push(`${m}:${o.runId}`); return { ...outcome(m !== '/mnt/bad'), ...(m === '/mnt/bad' ? { error: { code: 'EIO', message: 'fake', stage: 'write' as const } } : {}) }; },
      nfsLoopback: async (e) => { seen.push(`loop:${e}`); return outcome(true); },
    };
    const runner = makeDeepProbeRunner({ probeHost: host, listMountedManaged: async () => ['/mnt/ok', '/mnt/bad'] });
    const r = await runner('/srv/ok');
    expect(r.fs_io).toEqual([
      { mountpoint: '/mnt/ok', ok: true, cleanup: { status: 'clean' } },
      { mountpoint: '/mnt/bad', ok: false, error: 'EIO: fake', cleanup: { status: 'clean' } },
    ]);
    expect(r.nfs_loopback).toMatchObject({ attempted: true, export: '/srv/ok', ok: true });
    expect(seen).toEqual(['/mnt/ok:null', '/mnt/bad:null', 'loop:/srv/ok']);
    expect((await makeDeepProbeRunner({ probeHost: host, listMountedManaged: async () => { throw new Error('x'); } })(null)).fs_io).toEqual([]);
  });
});
```

Dispatcher case (in the existing dispatcher test file):

```ts
it('passes a structured code through as -32000 data.code (S19a)', async () => {
  const dispatch = createDispatcher({ busy: async () => { throw Object.assign(new Error('a probe is in flight'), { code: 'PROBE_IN_PROGRESS', details: { probe: 'fs_io' } }); } });
  const out = JSON.parse(await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'busy' })));
  expect(out.error).toEqual({ code: -32000, message: 'a probe is in flight', data: { code: 'PROBE_IN_PROGRESS', probe: 'fs_io' } });
});
```

- [ ] **Step 2: RED** — the two files fail to import / the dispatcher returns -32603.

- [ ] **Step 3: Implement**

```ts
// agent/rpc/methods/health-probe-run.ts
import type { ProbeHost } from '../../health/probe-host.js';
import type { ProbeKind, ProbeOutcome } from '../../../lib/health/probe-types.js';

export interface HealthProbeRunDeps { probeHost: ProbeHost; defaultTimeoutMs?: number; maxTimeoutMs?: number }
const invalid = (msg: string): Error => Object.assign(new Error(`health.probe.run: ${msg}`), { code: 'INVALID_PARAMS' });

export function makeHealthProbeRunHandler(deps: HealthProbeRunDeps) {
  const defaultTimeout = deps.defaultTimeoutMs ?? 20_000;
  const maxTimeout = deps.maxTimeoutMs ?? 60_000;
  let inFlight: { probe: ProbeKind; path: string } | null = null;
  return async (params: unknown): Promise<ProbeOutcome & { probe: ProbeKind; path: string }> => {
    const p = (params ?? {}) as { probe?: unknown; path?: unknown; run_id?: unknown; timeout_ms?: unknown };
    if (p.probe !== 'fs_io' && p.probe !== 'nfs_loopback') throw invalid("params.probe must be 'fs_io' or 'nfs_loopback'");
    if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.includes('\0')) throw invalid('params.path must be an absolute path');
    const runId = typeof p.run_id === 'string' && p.run_id.length > 0 ? p.run_id : null;
    const timeoutMs = p.timeout_ms === undefined ? defaultTimeout : p.timeout_ms;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > maxTimeout) {
      throw invalid(`params.timeout_ms must be an integer between 1000 and ${maxTimeout}`);
    }
    if (inFlight !== null) {
      throw Object.assign(new Error('a health probe is already in flight on this node'), { code: 'PROBE_IN_PROGRESS', details: { ...inFlight } });
    }
    inFlight = { probe: p.probe, path: p.path };
    try {
      const outcome = p.probe === 'fs_io'
        ? await deps.probeHost.fsIo(p.path, { runId, timeoutMs })
        : await deps.probeHost.nfsLoopback(p.path, { runId, timeoutMs });
      return { probe: p.probe, path: p.path, ...outcome };
    } finally {
      inFlight = null;
    }
  };
}
```

`makeDeepProbeRunner`: `const r = await opts.probeHost.fsIo(mountpoint, { runId: null, timeoutMs: 20_000 }); fsIo.push({ mountpoint, ok: r.ok, ...(r.error ? { error: \`${r.error.code}: ${r.error.message}\` } : {}), cleanup: r.cleanup });` and the same for loopback (`nfsLoopback(firstExportPath, { runId: null, timeoutMs: 20_000 })`, row `{ attempted: true, export, ok, error?, cleanup }`). The `DeepProbeResults` type (agent) and `ProbeDeepResults` (lib/standard.ts) gain `cleanup?: { status: 'clean' | 'failed' | 'not_needed'; detail?: string }`; `filesystemIoCheck` adds a `warning` outcome when every fs is ok but some `cleanup.status === 'failed'` (symptom `probe cleanup failed on: …`, `recommended_action: 'remove the listed probe file(s) under .xinas-health by hand'`), and `nfsLoopbackCheck` likewise for a failed umount.

`dispatch.ts`: before the final `-32603` branch:

```ts
const PASSTHROUGH_CODES = new Set(['PROBE_IN_PROGRESS', 'PRECONDITION_FAILED', 'NOT_FOUND']);
if (typeof typed.code === 'string' && PASSTHROUGH_CODES.has(typed.code)) {
  const details = (typed as { details?: Record<string, unknown> }).details ?? {};
  return errorEnvelope(id, -32000, typed.message, { code: typed.code, ...details });
}
```

`agent-server.ts`: build one host per process — `const probeHost = fixtureDir() !== null ? createFakeProbeHost(fixtureDir() as string) : createRealProbeHost();` — pass it to `makeHealthProbeDeps` (add `probeHost` to `HealthProbeWiring` and use it in `makeDeepProbeRunner` instead of creating one inside, so deep and `health.probe.run` share the in-process loopback guard), and register `'health.probe.run': makeHealthProbeRunHandler({ probeHost })`.

- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/agent/ src/__tests__/lib/health/ && npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(agent): health.probe.run RPC and deep probes on the hardened host (S19a T2)`.

---

### Task 7: Confirmation service — the direct-entry branch

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/direct.ts`
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/service.ts` (`handle()`, `view()`, an in-memory `directDocs` map)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/confirmation-service.test.ts` (new `describe`)

**Interfaces:**
- Produces: `isDirectConfirmable(entry)`, `directBindings(entry, args, identity): BindingKey`, `directDocument(entry, args, identity, nowMs): PlanDocument` (with `plan_id: 'direct:<arguments_hash>'`, `plan_hash: <arguments_hash>`, `operation_kind: entry.name`, `resource_ref: { kind: <'Filesystem' | 'Share' | entry.name>, id: args.target | null }`, `risk_level: 'non_disruptive'`, `rollback_model: 'non_disruptive'`, `client_impact: 'No impact on NFS clients.'`, `blockers: []`, `warnings: []`, `diff: redactValue(args)`, `state_revision_expected: 0`, `observed_revision_expected: null`, `observed_at: null`, `affected_resources: [resource_ref]` when id non-null, `created_by: { principal, client_type: 'mcp' }`); `ConfirmationService.handle()` routes direct entries to `handleDirect()`; `view()` renders a direct record from the remembered document or throws `plan_pruned`.

- [ ] **Step 1: Write the failing tests** (reuse the file's `makeService()`/`callInput()` helpers — read them first; below assumes `makeService()` returns `{ service, store }` and `callInput(entry, args, identity, client, mrtr?)` builds a `HandleInput`)

```ts
const PROBE_ENTRY: CatalogEntry = {
  name: 'health.probe.run', description: 'probe', method: 'POST', path: '/health/probe',
  input_schema: { type: 'object' }, mutability: 'direct', requires_mcp_apply: true,
  min_role: 'operator', status: 'live', confirmation: 'required',
};
const PROBE_ARGS = { probe: 'fs_io', target: 'fs-data' };

describe('direct confirmable entries (S19a, spec §9.1)', () => {
  it('initial call → form input_required whose message names the tool and target, no plan needed', async () => {
    const { service, store } = makeService();
    const out = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT));
    expect(out.kind).toBe('input_required');
    const rec = store.list({}).items[0];
    expect(rec).toMatchObject({ mode: 'form', tool_name: 'health.probe.run', plan_id: `direct:${argumentsHash('health.probe.run', PROBE_ARGS)}`,
      expected_revision: 0, risk_level: 'non_disruptive', status: 'pending' });
    const text = JSON.stringify(out);
    expect(text).toContain('health.probe.run');
    expect(text).toContain('fs-data');
  });

  it('retry with decision APPLY → proceed with the record id; DECLINE → CONFIRMATION_DECLINED', async () => {
    const { service } = makeService();
    const first = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT));
    const state = requestStateOf(first); // helper already in the file: extracts requestState from the input_required result
    const ok = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT,
      { requestState: state, inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } } }));
    expect(ok.kind).toBe('proceed');
    const again = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT));
    const state2 = requestStateOf(again);
    const no = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT,
      { requestState: state2, inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'DECLINE' } } } }));
    expect(no.kind).toBe('error');
    expect(JSON.stringify(no)).toContain('CONFIRMATION_DECLINED');
  });

  it('different args or a different principal never reuse the record', async () => {
    const { service, store } = makeService();
    await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT));
    await service.handle(callInput(PROBE_ENTRY, { ...PROBE_ARGS, target: 'fs-other' }, OPERATOR_IDENTITY, BOTH_CLIENT));
    await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, IDENTITY_B, BOTH_CLIENT));
    expect(store.list({}).items).toHaveLength(3);
  });

  it('a viewer is refused before any record exists', async () => {
    const { service, store } = makeService();
    const out = await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, { principal: 'v', role: 'viewer' }, BOTH_CLIENT));
    expect(JSON.stringify(out)).toContain('PERMISSION_DENIED');
    expect(store.list({}).items).toHaveLength(0);
  });

  it('view() renders the direct document; a fresh service (restart) answers plan_pruned', async () => {
    const { service, store, db } = makeService();
    await service.handle(callInput(PROBE_ENTRY, PROBE_ARGS, OPERATOR_IDENTITY, BOTH_CLIENT));
    const id = store.list({}).items[0].confirmation_id;
    const v = service.view(id, { principal: PRINCIPAL, client_type: 'rest' });
    expect(v?.plan.operation_kind).toBe('health.probe.run');
    const restarted = makeService({ db }).service;
    expect(() => restarted.view(id, { principal: PRINCIPAL, client_type: 'rest' })).toThrow(/no longer stored/);
  });
});
```

(Adapt `makeService`/`callInput`/`requestStateOf` names to the helpers that exist in the file; if `makeService` cannot take an existing `db`, add that option.)

- [ ] **Step 2: RED** — `npx vitest run src/__tests__/api/mcp/confirmation-service.test.ts -t direct` fails with `'plan_id' is required`.

- [ ] **Step 3: Implement**

`direct.ts` per the Interfaces block (`import { PLAN_DOCUMENT_SCHEMA, type PlanDocument, redactValue } from '../../plan/document.js'`; `import { argumentsHash } from './policy.js'`). `resource_ref.kind`: `args.probe === 'nfs_loopback' ? 'Share' : args.probe === 'fs_io' ? 'Filesystem' : entry.name`.

`service.ts`:

```ts
private readonly directDocs = new Map<string, PlanDocument>();

async handle(input: HandleInput): Promise<HandleOutcome> {
  if (isDirectConfirmable(input.entry)) return this.handleDirect(input);
  … existing body …
}

private async handleDirect(input: HandleInput): Promise<HandleOutcome> {
  const { entry, args, identity } = input;
  if (ROLE_RANK[identity.role] < ROLE_RANK[entry.min_role]) {
    return err('PERMISSION_DENIED', `role '${identity.role}' may not call ${entry.name} (requires ${entry.min_role})`,
      { required_role: entry.min_role, operation: entry.name });
  }
  const bindings = directBindings(entry, args, identity);
  const doc = directDocument(entry, args, identity, this.now());
  const mode: ConfirmationMode = 'form';
  if (input.mrtr?.requestState !== undefined) {
    const { payload, record } = this.verifyRetryState(input, bindings);
    this.directDocs.set(record.confirmation_id, doc);
    return this.retry(input, doc, bindings.arguments_hash, mode, bindings, payload, record);
  }
  const out = this.initial(input, doc, bindings.arguments_hash, planDocumentHash(doc), mode, bindings);
  if (out.kind === 'input_required') {
    const open = this.store.findOpenByBindings(bindings);
    if (open !== null) this.directDocs.set(open.confirmation_id, doc);
  }
  return out;
}
```

`view()`: `const doc = record.plan_id.startsWith('direct:') ? this.directDocs.get(id) : this.tasks.get(record.plan_id)?.plan_document;` — the existing `plan_pruned` throw covers the restart case. Sweeper/expiry paths need no change (they act on the record). `retry()` calls `this.reissue(record, doc)` and `this.elicitation(record, doc, nonce)` with the synthesized doc, which `renderConfirmationMessage` renders (`summarizeDiff(doc.diff)` shows the args).

- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/api/mcp/ && npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(mcp): S15 confirmation binds direct confirmable entries by tool and arguments (S19a T2)`.

---

### Task 8: Catalog entry, gate pins, and `POST /health/probe`

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/catalog.ts` (entry), `xiNAS-MCP/src/api/routes/health.ts` (route)
- Modify: `docs/control-path/api-v1.yaml` (`/health/probe`, schemas `HealthProbeRunRequest`, `HealthProbeRunResult`)
- Test: `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts` (pins), `xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts` (gate), `xiNAS-MCP/src/__tests__/api/routes-health-probe.test.ts` (new)

**Interfaces:**
- Consumes: `respondToRpc` (Task 4), `ConfirmationStore` (`ctx.tasks.confirmations`), `argumentsHash`, `PROVES` (Task 5).
- Produces: REST `POST /health/probe` body `{ probe, target, run_id?, timeout_s? }` → `200 { probe, target, path, run_id, started_at, completed_at, ok, operation, error, cleanup, proves, confirmation_id? }`; errors `INVALID_ARGUMENT` (400), `NOT_FOUND` (404, unknown id), `PRECONDITION_FAILED` (412: `not_mounted`, `confirmation_required`, `confirmation_binding`, `confirmation_not_approved`), `CONFLICT` (409, `PROBE_IN_PROGRESS`), `UNSUPPORTED` (422, no agent client).

- [ ] **Step 1: Write the failing tests**

Catalog pins (append to the `min_role spot pins` test):

```ts
expect(byName.get('health.probe.run')).toMatchObject({
  mutability: 'direct', requires_mcp_apply: true, min_role: 'operator', confirmation: 'required', method: 'POST', path: '/health/probe',
});
```

Gate (`mcp-dispatch.test.ts`, in the `gateVerdict` describe):

```ts
it('health.probe.run is gated by mcp.allow_apply like an apply and is confirmable', () => {
  const e = entry('health.probe.run');
  expect(gateVerdict(e, { probe: 'fs_io', target: 'fs-a' }, false).allowed).toBe(false);
  expect(gateVerdict(e, { probe: 'fs_io', target: 'fs-a' }, true).allowed).toBe(true);
  expect(isConfirmable(e, { probe: 'fs_io', target: 'fs-a' })).toBe(true);
});
```

Route tests (`routes-health-probe.test.ts`, `buildTestAppWithMockAgent`; seed `/xinas/v1/observed/Filesystem/fs-data` with `status: { mountpoint: '/mnt/data', mounted: true }` and `/xinas/v1/desired/Share/sh-1` with `spec: { path: '/mnt/data' }`):

```ts
const okOutcome = { ok: true, started_at: 's', completed_at: 'c', artifact: { kind: 'file', path: '/mnt/data/.xinas-health/probe-none-x' }, cleanup: { status: 'clean' } };

it('REST operator: runs fs_io on the filesystem mountpoint with no confirmation', async () => {
  let seen: unknown;
  setup.mockAgent.respondToRpc('health.probe.run', (p) => { seen = p; return { result: { probe: 'fs_io', path: '/mnt/data', ...okOutcome } }; });
  const res = await request(setup.app).post('/api/v1/health/probe').set('Authorization', OPERATOR_TOKEN).send({ probe: 'fs_io', target: 'fs-data', timeout_s: 10 });
  expect(res.status).toBe(200);
  expect(seen).toMatchObject({ probe: 'fs_io', path: '/mnt/data', run_id: null, timeout_ms: 10_000 });
  expect(res.body.result).toMatchObject({ probe: 'fs_io', target: 'fs-data', path: '/mnt/data', ok: true, cleanup: { status: 'clean' },
    proves: expect.stringContaining('4 KiB write') });
});
it('nfs_loopback resolves the share export path', async () => { /* same shape, probe nfs_loopback, target sh-1 → path '/mnt/data' */ });
it('viewer → 401 PERMISSION_DENIED (catalog rank)', …);
it('unknown target → 404; unmounted filesystem → 412 not_mounted; bad body → 400', …);
it('agent PROBE_IN_PROGRESS → 409 CONFLICT', async () => {
  setup.mockAgent.respondToRpc('health.probe.run', () => ({ error: { code: -32000, message: 'busy', data: { code: 'PROBE_IN_PROGRESS' } } }));
  const res = await request(setup.app).post('/api/v1/health/probe').set('Authorization', OPERATOR_TOKEN).send({ probe: 'fs_io', target: 'fs-data' });
  expect(res.status).toBe(409);
  expect(res.body.errors[0].details.reason).toBe('PROBE_IN_PROGRESS');
});
describe('forwarded MCP calls', () => {
  // the loopback token + forwarded headers are what dispatch sends; `_helpers` exposes LOOPBACK headers builder (read it; add one if absent)
  it('without a confirmation → 412 confirmation_required', …);
  it('with a pending form record bound to these args → consumed, 200, confirmation_id echoed', async () => {
    const store = setup.ctx.tasks.confirmations; // create a record via store.create({...}) with tool_name 'health.probe.run',
    // arguments_hash: argumentsHash('health.probe.run', body), mode 'form', status pending, expires in 300 s
    …
    expect(res.status).toBe(200);
    expect(store.get(rec.confirmation_id)?.status).toBe('consumed');
  });
  it('a record for other arguments → 412 confirmation_binding; a consumed record → 412 confirmation_not_approved', …);
});
```

- [ ] **Step 2: RED** — the catalog pin fails (`undefined`), the route returns 404 `NOT_FOUND` route.

- [ ] **Step 3: Implement**

Catalog entry (after `health.check`):

```ts
{
  name: 'health.probe.run',
  description: 'Run ONE confirmed active health probe. fs_io writes, fsyncs, reads back and unlinks a 4 KiB file under <mountpoint>/.xinas-health of the given Filesystem; nfs_loopback NFS-mounts the given Share from the node itself, lists it and unmounts. Proves only the operation it performed — not client connectivity, not RDMA, not durability beyond fsync.',
  method: 'POST', path: '/health/probe',
  input_schema: { type: 'object', properties: {
    probe: { type: 'string', enum: ['fs_io', 'nfs_loopback'] },
    target: { type: 'string', description: 'Filesystem id for fs_io, Share id for nfs_loopback' },
    run_id: { type: 'string', description: 'optional S19 run id for audit correlation' },
    timeout_s: { type: 'integer', minimum: 1, maximum: 60 },
  }, required: ['probe', 'target'], additionalProperties: false },
  mutability: 'direct', requires_mcp_apply: true, min_role: 'operator', status: 'live', confirmation: 'required',
},
```

Route (in `healthRouter`):

```ts
r.post('/health/probe', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const probe = body.probe; const target = body.target;
    if (probe !== 'fs_io' && probe !== 'nfs_loopback') throw new ApiException('INVALID_ARGUMENT', "probe must be 'fs_io' or 'nfs_loopback'");
    if (typeof target !== 'string' || target.length === 0) throw new ApiException('INVALID_ARGUMENT', 'target is required');
    const runId = typeof body.run_id === 'string' && body.run_id.length > 0 ? body.run_id : null;
    const timeoutS = body.timeout_s === undefined ? 20 : body.timeout_s;
    if (typeof timeoutS !== 'number' || !Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 60) throw new ApiException('INVALID_ARGUMENT', 'timeout_s must be an integer 1..60');
    const rc = req.context as RequestContext;

    // resolve the target
    let path: string;
    if (probe === 'fs_io') {
      const fs = getOrNull<{ status?: { mountpoint?: string; mounted?: boolean } }>(ctx.state, `/xinas/v1/observed/Filesystem/${target}`);
      if (fs === null) throw new ApiException('NOT_FOUND', `no filesystem ${target}`);
      if (fs.status?.mounted !== true || typeof fs.status.mountpoint !== 'string') throw new ApiException('PRECONDITION_FAILED', `filesystem ${target} is not mounted`, { reason: 'not_mounted' });
      path = fs.status.mountpoint;
    } else {
      const share = getOrNull<{ spec?: { path?: string } }>(ctx.state, `/xinas/v1/desired/Share/${target}`);
      if (share === null || typeof share.spec?.path !== 'string') throw new ApiException('NOT_FOUND', `no share ${target}`);
      path = share.spec.path;
    }

    // S15 §8.3 analogue for a direct entry: verify, then consume BEFORE running.
    let confirmation: ConfirmationRecord | undefined;
    if (rc.client_type === 'mcp') {
      const store = ctx.tasks?.confirmations;
      if (store === undefined || rc.mcp_confirmation_id === undefined) throw new ApiException('PRECONDITION_FAILED', 'an MCP probe requires a verified confirmation', { reason: 'confirmation_required' });
      const record = store.get(rc.mcp_confirmation_id); const now = Date.now();
      if (record === null || record.principal !== rc.principal || record.tool_name !== 'health.probe.run' || record.arguments_hash !== argumentsHash('health.probe.run', body)) {
        throw new ApiException('PRECONDITION_FAILED', 'the confirmation does not belong to this principal, tool and arguments', { reason: 'confirmation_binding' });
      }
      if (record.status !== 'pending' || record.mode !== 'form' || record.expires_at <= now) throw new ApiException('PRECONDITION_FAILED', 'the confirmation is not pending', { reason: 'confirmation_not_approved', status: record.status });
      const probeId = `probe:${randomUUID()}`;
      if (!store.consume({ confirmation_id: record.confirmation_id, task_id: probeId, from: 'pending', principal: rc.principal, now })) {
        throw new ApiException('PRECONDITION_FAILED', 'the confirmation was consumed concurrently', { reason: 'confirmation_not_approved', status: 'consumed' });
      }
      confirmation = store.get(record.confirmation_id) ?? record;
      queueConfirmationEvent(ctx.state.audit, 'consumed', confirmation, { task_id: probeId });
    }

    const client = ctx.tasks?.agentClient;
    if (client === undefined) throw new ApiException('UNSUPPORTED', 'no agent RPC client configured');
    let outcome: Record<string, unknown>;
    try {
      outcome = (await client.call('health.probe.run', { probe, path, run_id: runId, timeout_ms: timeoutS * 1000 }, timeoutS * 1000 + 5_000)) as Record<string, unknown>;
    } catch (err) {
      const code = err instanceof AgentRpcError ? (err.data as { code?: string } | undefined)?.code : undefined;
      if (code === 'PROBE_IN_PROGRESS') throw new ApiException('CONFLICT', 'a health probe is already in flight on this node', { reason: 'PROBE_IN_PROGRESS' });
      throw err;
    }
    const { probe: _p, path: _q, ...rest } = outcome;
    sendOk(req, res, { probe, target, path, run_id: runId, ...rest, proves: PROVES[probe],
      ...(confirmation !== undefined ? { confirmation_id: confirmation.confirmation_id } : {}) });
  } catch (err) { next(err); }
});
```

`api-v1.yaml`: add `/health/probe` (`post`, tags `[health]`, `operationId: runHealthProbe`, description = the catalog description plus the gate sentence "REST: operator role. MCP: additionally `mcp.allow_apply` and a form confirmation (S15).", request body schema `HealthProbeRunRequest`, responses `200` `HealthProbeRunResult`, `400 InvalidArgument`, `403 PermissionDenied`, `404 NotFound`, `409 Conflict`, `412 PreconditionFailed`, `500 Internal`) and the two schemas mirroring the route's shapes (`operation`, `error`, `cleanup`, `proves`, `confirmation_id` optional).

- [ ] **Step 4: GREEN + gates** — `npx vitest run src/__tests__/api/ && npm run typecheck && npm run lint && npm run format:check`, spectral + yamllint on `api-v1.yaml`.

- [ ] **Step 5: Commit** — `feat(api): health.probe.run — confirmable active probe tool over POST /health/probe (S19a T2)`.

---

### Task 9: Wire-level MCP test and e2e

**Files:**
- Test: `xiNAS-MCP/src/__tests__/api/mcp-integration.test.ts` (legacy client on `health.probe.run` → `MCP_CONFIRMATION_UNSUPPORTED` with `allow_apply`; `MCP_APPLY_DISABLED` without)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts` (modern client: `health.probe.run` → `input_required` form → retry `decision: APPLY` → tool result `ok: true`, record `consumed`; mock agent answers `health.probe.run`)
- Test: `xiNAS-MCP/src/__tests__/e2e/health-support.test.ts` (deep still records `touch:/mnt/data`, `loopback:/mnt/data`, `loopback-umount:/mnt/data`; a REST `POST /health/probe` fs_io on `mnt-data.mount` returns `ok: true`, `cleanup.status: 'clean'`, `proves`)

- [ ] **Step 1: Write the tests** (RED: the mcp-confirmation harness needs a filesystem row seeded and the mock agent hook — use `seedShare`-style helpers already in `_helpers.ts`; the e2e fixture already has `mnt-data.mount` mounted at `/mnt/data`).
- [ ] **Step 2: RED** — run each file; the new cases fail on the missing tool result.
- [ ] **Step 3: Implement** — nothing new should be needed; fix whatever the wire tests reveal (typically the `client_type` header on the loopback hop or the `confirm_apply` form key).
- [ ] **Step 4: GREEN** — `npx vitest run src/__tests__/api/mcp-integration.test.ts src/__tests__/api/mcp/mcp-confirmation.test.ts && npm run build && npm run test:e2e`.
- [ ] **Step 5: Commit** — `test(mcp): health.probe.run over the wire on both eras and in e2e (S19a T2)`.

---

### Task 10: Docs, TODO closure, changelog, full gate

**Files:**
- Modify: `docs/control-path/s19-mcp-health-prompt-spec.md` (Status line: "S19a implemented <date>; S19b–d pending"; inline deviation notes: §7.2 quick-check `collection` is `{ status: 'success', source: 'kv', observed_at: null }` until `health.context` carries per-kind freshness; §9.1 `rollback_model: 'non_disruptive'` instead of `not_applicable` because the vocabulary is closed and the renderer's default sentence is right; §9.3 Node has no `openat`, so the post-open `fstat` device/nlink check is the mitigation; §9.5 `probes_per_run` waits for the S19b ledger)
- Modify: `docs/TODO.md` — delete "Health — the deep-profile probe artifacts are not hardened"; add "Health — `probes_per_run` is not enforced until the S19b run ledger" (what is missing / what the code does / why / done)
- Modify: `CHANGELOG.md` Unreleased: Added (typed collection status + `coverage_status`, `health.probe.run`), Fixed (probe artifacts hardened; failed collections no longer look like absent components)
- Modify: `docs/control-path/hardware-smoke-runbook.md`: the `profile=deep` bullet mentions the per-run names under `.xinas-health` and the per-run mountpoint; a new bullet for `POST /health/probe` (operator token; MCP needs allow_apply + confirmation)
- Modify: `docs/control-path/xinas-agent-s0s1-spec.md`: the two "Planned (S19)" rows become "Real (S19a)" with the final param shapes

- [ ] **Step 1: Edit the docs** as listed.
- [ ] **Step 2: Run every gate** from Global Constraints (TypeScript trio, `npm test`, `npm run test:contracts`, `npm run build && npm run test:e2e`, yamllint, spectral, markdownlint, `ruff format --check .` from the repo root).
- [ ] **Step 3: Commit** — `docs(control-path): S19a implemented — spec status, deviations, TODO closure, changelog` (no trailer: docs only).
- [ ] **Step 4: Push and open the PR** into `release/3.14` with the verification table and a note that the commits carry `Requires-Rebuild: xinas_node_build`.

---

## Self-review

- **Spec coverage:** §7.1 (Task 2), §7.2 (Task 3), §7.3 + §14 report fields (Task 4), §9.1 gate matrix (Tasks 7, 8, 9), §9.2 response (Task 8), §9.3 host (Task 5), §9.4 legacy deep on the same host (Task 6), §9.5 `active_probes_per_node` (Task 6 guard; `probes_per_run` explicitly deferred to S19b in Task 10), §13 authorization (Task 8 tests), §15 test rows for S19a (Tasks 1–9), TODO closure (Task 10).
- **Type consistency:** `Section<T>` from `lib/health/collection.ts` is the one type used by the agent (`collect`) and the api builders; `ProbeOutcome`/`ProbeRunOptions`/`PROVES` from `lib/health/probe-types.ts` are used by the host, the RPC and the route; `respondToRpc` (Task 4) is the hook Tasks 8 and 9 use; `collectionFailureCheck` is exported from `standard.ts` and reused by `drift.ts`.
- **Placeholders:** none — every step carries the code or the exact edit.
