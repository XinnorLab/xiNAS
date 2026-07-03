# NFS Share Seed Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the installer's declared NFS exports into the control-path desired state at first API boot, so the install-time default share is visible, editable, and removable in the TUI instead of vanishing the moment any share is added.

**Architecture:** The Ansible `exports` role renders a JSON seed manifest from the same `exports` preset var that drives `/etc/exports` (additive — the `/etc/exports` template task is untouched). On its first boot after install, `xinas-api` reads that manifest and `put()`s one desired `Share` row per entry (no executor, no `/etc/exports` write — the export already exists), then sets a one-time marker `/xinas/v1/meta/shares_seeded` so operator deletes stay permanent and nothing is resurrected on restart.

**Tech Stack:** TypeScript (Node, better-sqlite3 KV, Express API, vitest), Ansible (Jinja2 templates), Python nfs-helper (unchanged).

**Design doc:** `docs/superpowers/specs/2026-07-03-nfs-share-seed-adoption-design.md`

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `xiNAS-MCP/src/api/config.ts` | Modify | Add optional `seed?: { shares_manifest_path?: string }` to `ApiConfig` |
| `xiNAS-MCP/src/api/seed-shares.ts` | Create | `seedShares(state, config)` — read manifest, seed desired Shares once, set marker |
| `xiNAS-MCP/src/__tests__/api/seed-shares.test.ts` | Create | Unit tests for `seedShares` |
| `xiNAS-MCP/src/api/server.ts` | Modify | Call `seedShares(state, config)` right after `seedInfrastructure` |
| `collection/roles/exports/templates/shares-seed.json.j2` | Create | Render the manifest from the `exports` var |
| `collection/roles/exports/tasks/main.yml` | Modify | Add seed-dir + manifest-render tasks (additive) |
| `collection/roles/xinas_api/defaults/main.yml` | Modify | Add `xinas_api_seed_manifest_path` default |
| `collection/roles/xinas_api/templates/xinas-api-config.json.j2` | Modify | Emit the `seed.shares_manifest_path` config field |
| `docs/Installer/fs-exports-spec.md` | Modify | Document the manifest contract + install→desired seeding |
| `docs/control-path/adr/0016-*.md` (or `bootstrap`-owning spec) | Modify | Extend the bootstrap-seed contract to the one-time Share seed |

---

## Task 1: Add the `seed` config field to `ApiConfig`

**Files:**
- Modify: `xiNAS-MCP/src/api/config.ts` (the `ApiConfig` interface, after the `tasks?` field)

- [ ] **Step 1: Add the optional field**

In `xiNAS-MCP/src/api/config.ts`, inside `export interface ApiConfig { ... }`, add after the `tasks?: { max_inflight?: number };` field:

```typescript
  /**
   * Install-time NFS share seed (see docs/.../2026-07-03-nfs-share-seed-adoption).
   * `shares_manifest_path` points at the JSON manifest the Ansible `exports`
   * role renders (default /var/lib/xinas/seed/shares.json). Consumed once by
   * seedShares() at bootstrap; absent → the code default path is used.
   */
  seed?: { shares_manifest_path?: string };
```

- [ ] **Step 2: Typecheck**

Run: `cd xiNAS-MCP && npx tsc --noEmit`
Expected: no new errors (the field is optional; nothing else changes).

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/api/config.ts
git commit -m "feat(api): add optional seed.shares_manifest_path to ApiConfig"
```

---

## Task 2: Create `seedShares()` with tests (TDD)

This is the core. Write the test file first, watch it fail, then implement.

**Files:**
- Test: `xiNAS-MCP/src/__tests__/api/seed-shares.test.ts`
- Create: `xiNAS-MCP/src/api/seed-shares.ts`

- [ ] **Step 1: Write the failing test file**

Create `xiNAS-MCP/src/__tests__/api/seed-shares.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../api/config.js';
import { seedShares } from '../../api/seed-shares.js';
import { buildTestApp } from './_helpers.js';

const MARKER_KEY = '/xinas/v1/meta/shares_seeded';
const SHARE_PREFIX = '/xinas/v1/desired/Share/';

interface ShareRow {
  kind: string;
  id: string;
  spec: { path: string; clients: Array<{ pattern: string; options: string[] }>; fsid: number };
}

describe('seedShares — install-time desired-state adoption', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  let dir: string;
  let manifestPath: string;

  const cfg = (): ApiConfig => ({
    ...setup.config,
    seed: { shares_manifest_path: manifestPath },
  });

  const writeManifest = (entries: unknown): void =>
    writeFileSync(manifestPath, JSON.stringify(entries), 'utf8');

  beforeEach(async () => {
    setup = await buildTestApp();
    dir = mkdtempSync(join(tmpdir(), 'xinas-seed-'));
    manifestPath = join(dir, 'shares.json');
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await setup.cleanup();
  });

  it('seeds one desired Share per manifest entry and sets the marker', () => {
    writeManifest([
      {
        path: '/mnt/data',
        clients: '*',
        options: ['rw', 'sync', 'insecure', 'no_root_squash', 'no_subtree_check', 'no_wdelay', 'fsid=0'],
      },
    ]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows).toHaveLength(1);
    const share = rows[0].value;
    expect(share.kind).toBe('Share');
    expect(share.id).toBe('mnt/data'); // encExportId('/mnt/data')
    expect(share.spec.path).toBe('/mnt/data');
    expect(share.spec.fsid).toBe(0); // fsid=0 extracted from options, preserved
    expect(share.spec.clients).toEqual([
      { pattern: '*', options: ['rw', 'sync', 'insecure', 'no_root_squash', 'no_subtree_check', 'no_wdelay'] },
    ]);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('is a no-op when the marker is already set (never re-seeds)', () => {
    setup.state.kv.put(MARKER_KEY, { seeded_at: 'x', source: 'api:bootstrap' });
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);

    seedShares(setup.state, cfg());

    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
  });

  it('does NOT resurrect a deleted share on the next boot', () => {
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);
    seedShares(setup.state, cfg()); // first boot seeds + marks

    const id = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX })[0].value.id;
    setup.state.kv.delete(`${SHARE_PREFIX}${id}`); // operator removes it via TUI

    seedShares(setup.state, cfg()); // simulated restart

    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
  });

  it('leaves the marker unset when the manifest is absent (seeds on a later boot)', () => {
    // no writeManifest() → file does not exist
    seedShares(setup.state, cfg());
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();

    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(1);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('leaves the marker unset for an empty manifest', () => {
    writeManifest([]);
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();
  });

  it('does not duplicate a path that already has a desired Share', () => {
    setup.state.kv.put(`${SHARE_PREFIX}mnt/data`, {
      kind: 'Share',
      id: 'mnt/data',
      spec: { path: '/mnt/data', clients: [{ pattern: '10.0.0.0/24', options: ['ro'] }], fsid: 7 },
    });
    writeManifest([{ path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] }]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows).toHaveLength(1);
    expect(rows[0].value.spec.fsid).toBe(7); // untouched operator/existing row
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('assigns fsid max+1 when a manifest entry omits fsid', () => {
    writeManifest([
      { path: '/mnt/a', clients: '*', options: ['rw', 'fsid=0'] },
      { path: '/mnt/b', clients: '*', options: ['rw'] }, // no fsid → assigned
    ]);

    seedShares(setup.state, cfg());

    const byPath = new Map(
      setup.state.kv
        .list<ShareRow>({ prefix: SHARE_PREFIX })
        .map((r) => [r.value.spec.path, r.value.spec.fsid]),
    );
    expect(byPath.get('/mnt/a')).toBe(0);
    expect(byPath.get('/mnt/b')).toBe(1); // max(0)+1
  });

  it('skips an unencodable path but still seeds the rest and marks', () => {
    writeManifest([
      { path: '/', clients: '*', options: ['rw'] }, // encExportId throws → skipped
      { path: '/mnt/data', clients: '*', options: ['rw', 'fsid=0'] },
    ]);

    seedShares(setup.state, cfg());

    const rows = setup.state.kv.list<ShareRow>({ prefix: SHARE_PREFIX });
    expect(rows.map((r) => r.value.spec.path)).toEqual(['/mnt/data']);
    expect(setup.state.kv.get(MARKER_KEY)).not.toBeNull();
  });

  it('does not seed or mark on a malformed manifest (retries next boot)', () => {
    writeFileSync(manifestPath, '{ not json', 'utf8');
    seedShares(setup.state, cfg());
    expect(setup.state.kv.list({ prefix: SHARE_PREFIX })).toHaveLength(0);
    expect(setup.state.kv.get(MARKER_KEY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/seed-shares.test.ts`
Expected: FAIL — `Cannot find module '../../api/seed-shares.js'` (the module does not exist yet).

- [ ] **Step 3: Implement `seedShares`**

Create `xiNAS-MCP/src/api/seed-shares.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { encExportId } from '../lib/nfs-export-id.js';
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig } from './config.js';

/**
 * Install-time NFS share adoption (design:
 * docs/superpowers/specs/2026-07-03-nfs-share-seed-adoption-design.md).
 *
 * The Ansible `exports` role renders a JSON manifest from the same preset
 * `exports` var that drives /etc/exports. On the FIRST api boot after install,
 * this seeds one desired Share per manifest entry so the install-time export is
 * a first-class managed Share (visible/editable/removable in the TUI). It runs
 * in the bootstrap window (before any listener binds, alongside
 * seedInfrastructure), so plain put() with no CAS is safe — the api is the sole
 * writer. No executor runs and /etc/exports is NOT written: the export already
 * exists on disk from the role's own `exports.j2` render.
 *
 * A one-time marker makes seeding permanent-once: an operator who deletes a
 * seeded share is NOT re-seeded on the next restart (which would leave a ghost
 * desired row with no matching export). A fresh state DB (re-install) has no
 * marker and re-seeds.
 */

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** One-time seed marker. Outside desired/·observed/ (like /xinas/v1/cluster) so
 *  it never leaks into a list route. */
const SEEDED_MARKER_KEY = '/xinas/v1/meta/shares_seeded';
const DEFAULT_MANIFEST_PATH = '/var/lib/xinas/seed/shares.json';
/** Origin tag on every seed write (mirrors bootstrap.ts). */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

interface ManifestEntry {
  path?: unknown;
  clients?: unknown;
  options?: unknown;
}

/** Split `fsid=N` out of the raw option tokens. Returns the parsed fsid (or
 *  undefined) and the remaining non-fsid tokens (order preserved). */
function extractFsid(options: string[]): { fsid: number | undefined; options: string[] } {
  let fsid: number | undefined;
  const rest: string[] = [];
  for (const o of options) {
    const m = /^fsid=(\d+)$/.exec(o);
    if (m) fsid = Number(m[1]);
    else rest.push(o);
  }
  return { fsid, options: rest };
}

export function seedShares(state: OpenedStateStore, config: ApiConfig): void {
  // One-time: once marked, never touch shares again (deletes stay permanent).
  if (state.kv.get(SEEDED_MARKER_KEY) !== null) return;

  const manifestPath = config.seed?.shares_manifest_path ?? DEFAULT_MANIFEST_PATH;
  if (!existsSync(manifestPath)) return; // no manifest yet → leave marker unset

  let entries: ManifestEntry[];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) return; // malformed → do not seed, do not mark
    entries = parsed as ManifestEntry[];
  } catch {
    return; // malformed JSON → retry on a later boot
  }
  if (entries.length === 0) return; // nothing to seed → leave marker unset

  // Existing desired paths + used fsids (skip duplicates; assign fsid on gaps).
  const rows = state.kv.list<{ spec?: { path?: unknown; fsid?: unknown } }>({
    prefix: DESIRED_SHARE_PREFIX,
  });
  const existingPaths = new Set<string>();
  const usedFsids = new Set<number>();
  for (const r of rows) {
    const p = r.value.spec?.path;
    if (typeof p === 'string') existingPaths.add(p);
    const f = r.value.spec?.fsid;
    if (typeof f === 'number' && Number.isInteger(f)) usedFsids.add(f);
  }

  for (const entry of entries) {
    const path = entry.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    if (existingPaths.has(path)) continue;

    let id: string;
    try {
      id = encExportId(path); // '/mnt/data' → 'mnt/data'; throws on '/' or '..'
    } catch {
      continue; // unencodable path → skip, boot continues
    }

    const rawOpts = Array.isArray(entry.options)
      ? entry.options.filter((o): o is string => typeof o === 'string')
      : [];
    const { fsid: parsedFsid, options } = extractFsid(rawOpts);
    let fsid = parsedFsid;
    if (fsid === undefined || usedFsids.has(fsid)) {
      fsid = Math.max(0, ...usedFsids) + 1; // 0 reserved; next free integer
    }
    usedFsids.add(fsid);
    existingPaths.add(path);

    const pattern = typeof entry.clients === 'string' && entry.clients.length > 0
      ? entry.clients
      : '*';
    const spec = { path, clients: [{ pattern, options }], fsid };
    // Same doc shape as providers/nfs.ts toDesiredShareDoc + the GET routes.
    state.kv.put(`${DESIRED_SHARE_PREFIX}${id}`, { kind: 'Share', id, spec }, PUT_SOURCE);
  }

  state.kv.put(
    SEEDED_MARKER_KEY,
    { seeded_at: new Date().toISOString(), source: 'api:bootstrap' },
    PUT_SOURCE,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api/seed-shares.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Typecheck + lint**

Run: `cd xiNAS-MCP && npx tsc --noEmit && npx biome check src/api/seed-shares.ts src/__tests__/api/seed-shares.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/api/seed-shares.ts xiNAS-MCP/src/__tests__/api/seed-shares.test.ts
git commit -m "feat(api): seedShares() — adopt install-time exports into desired state (one-time)"
```

---

## Task 3: Wire `seedShares` into server bootstrap

**Files:**
- Modify: `xiNAS-MCP/src/api/server.ts` (right after the existing `seedInfrastructure(state, config)` call, ~line 43)

- [ ] **Step 1: Import `seedShares`**

In `xiNAS-MCP/src/api/server.ts`, next to the existing bootstrap import (`import { seedInfrastructure } from './bootstrap.js';`), add:

```typescript
import { seedShares } from './seed-shares.js';
```

- [ ] **Step 2: Call it after `seedInfrastructure`**

Find (around line 40-43):

```typescript
  // ADR-0016: seed /xinas/v1/cluster + /xinas/v1/nodes/<controller_id>
  seedInfrastructure(state, config);
```

Add immediately below it:

```typescript
  // Install-time NFS share adoption (one-time; leaves operator deletes permanent).
  seedShares(state, config);
```

- [ ] **Step 3: Typecheck**

Run: `cd xiNAS-MCP && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full API test suite to confirm no regressions**

Run: `cd xiNAS-MCP && npx vitest run src/__tests__/api`
Expected: PASS (existing bootstrap tests + the new seed-shares tests).

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/server.ts
git commit -m "feat(api): call seedShares at bootstrap after seedInfrastructure"
```

---

## Task 4: Ansible — render the seed manifest in the `exports` role

**Files:**
- Create: `collection/roles/exports/templates/shares-seed.json.j2`
- Modify: `collection/roles/exports/tasks/main.yml` (append two additive tasks; do NOT touch the existing `/etc/exports` template task)

- [ ] **Step 1: Create the manifest template**

Create `collection/roles/exports/templates/shares-seed.json.j2`:

```jinja
{# Managed by the xiNAS `exports` role. Consumed ONCE by xinas-api seedShares()
   to adopt the install-time exports into control-path desired state.
   Rendered from the SAME `exports` var that drives exports.j2, so this manifest
   and /etc/exports are consistent by construction. #}
{% set entries = [] %}
{% for ex in exports %}
{%   set _ = entries.append({
       'path': ex.path,
       'clients': ex.clients,
       'options': ex.options.split(',') | map('trim') | select | list,
     }) %}
{% endfor %}
{{ entries | to_nice_json }}
```

- [ ] **Step 2: Append the seed-dir + render tasks**

At the END of `collection/roles/exports/tasks/main.yml` (after the existing "Render /etc/exports from template" task), append:

```yaml
- name: Ensure the xinas-api seed directory exists
  ansible.builtin.file:
    path: /var/lib/xinas/seed
    state: directory
    owner: root
    group: root
    mode: '0755'
  tags: [exports]

- name: Render the NFS share seed manifest for the control-path API
  ansible.builtin.template:
    src: shares-seed.json.j2
    dest: /var/lib/xinas/seed/shares.json
    owner: root
    group: root
    mode: '0644'
  tags: [exports]
```

- [ ] **Step 3: Verify the template renders valid JSON**

Run (uses the jinja2 that ships with ansible):

```bash
python3 - <<'PY'
from jinja2 import Environment
import json
# minimal to_nice_json shim matching ansible's filter output
env = Environment()
env.filters['to_nice_json'] = lambda o: json.dumps(o, indent=4, sort_keys=True)
tmpl = open('collection/roles/exports/templates/shares-seed.json.j2').read()
# strip the leading {# ... #} comment block for the standalone render
out = env.from_string(tmpl).render(exports=[
    {'path': '/mnt/data', 'clients': '*',
     'options': 'rw,sync,insecure,no_root_squash,no_subtree_check,no_wdelay,fsid=0'}
])
parsed = json.loads(out)
assert parsed == [{
    'path': '/mnt/data', 'clients': '*',
    'options': ['rw', 'sync', 'insecure', 'no_root_squash', 'no_subtree_check', 'no_wdelay', 'fsid=0'],
}], parsed
print('OK: manifest renders valid JSON:', json.dumps(parsed))
PY
```

Expected: `OK: manifest renders valid JSON: [...]` (no assertion error).

- [ ] **Step 4: Commit**

```bash
git add collection/roles/exports/templates/shares-seed.json.j2 collection/roles/exports/tasks/main.yml
git commit -m "feat(exports): render NFS share seed manifest for control-path adoption"
```

---

## Task 5: Ansible — point `xinas-api` config at the manifest

**Files:**
- Modify: `collection/roles/xinas_api/defaults/main.yml` (add a default var)
- Modify: `collection/roles/xinas_api/templates/xinas-api-config.json.j2` (emit the `seed` block)

- [ ] **Step 1: Add the default var**

In `collection/roles/xinas_api/defaults/main.yml`, near `xinas_api_state_dir`, add:

```yaml
# Path to the NFS share seed manifest the `exports` role renders. xinas-api
# reads it ONCE at first boot (seedShares) to adopt install-time exports into
# desired state. MUST match the exports role's dest (/var/lib/xinas/seed/shares.json).
xinas_api_seed_manifest_path: /var/lib/xinas/seed/shares.json
```

- [ ] **Step 2: Emit the `seed` block in the config template**

In `collection/roles/xinas_api/templates/xinas-api-config.json.j2`, add a `seed` block. Insert it after the `"tasks": { ... },` block and before `"state": {`:

```jinja
  "seed": {
    "shares_manifest_path": "{{ xinas_api_seed_manifest_path }}"
  },
```

The resulting config must remain valid JSON (the `seed` block ends with a comma because `state` follows it).

- [ ] **Step 3: Verify the rendered config is valid JSON**

Run:

```bash
python3 - <<'PY'
from jinja2 import Environment
import json
env = Environment()
tmpl = open('collection/roles/xinas_api/templates/xinas-api-config.json.j2').read()
out = env.from_string(tmpl).render(
    xinas_api_controller_id='node-1', xinas_api_socket='/run/xinas/api.sock',
    _xinas_admin_gid=1001, _xinas_api_admin_token='tok',
    xinas_api_agent_socket='/run/xinas/agent.sock', xinas_api_agent_heartbeat_interval_ms=5000,
    xinas_api_config_dir='/etc/xinas-api', xinas_api_tasks_max_inflight=4,
    xinas_api_state_dir='/var/lib/xinas/state', xinas_api_log_dir='/var/log/xinas',
    xinas_api_seed_manifest_path='/var/lib/xinas/seed/shares.json',
)
cfg = json.loads(out)
assert cfg['seed']['shares_manifest_path'] == '/var/lib/xinas/seed/shares.json', cfg
print('OK: config renders valid JSON with seed block')
PY
```

Expected: `OK: config renders valid JSON with seed block`.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/defaults/main.yml collection/roles/xinas_api/templates/xinas-api-config.json.j2
git commit -m "feat(xinas_api): point config.seed.shares_manifest_path at the exports manifest"
```

---

## Task 6: Spec-first — update the durable specs

**Files:**
- Modify: `docs/Installer/fs-exports-spec.md`
- Modify: the bootstrap-owning control-path doc — `docs/control-path/adr/0016-*.md` (append a short "Share seed" note; if 0016 is append-only landed history, add the note to the live spec that references bootstrap seeding instead and cross-link)

- [ ] **Step 1: Document the manifest + seeding in `fs-exports-spec.md`**

Add a section to `docs/Installer/fs-exports-spec.md` (adapt heading numbering to the file's style):

```markdown
## Install-time share adoption (seed manifest)

The `exports` role renders `/etc/exports` from the `exports` preset var
(`exports.j2`) AND a JSON seed manifest at `/var/lib/xinas/seed/shares.json`
(`shares-seed.json.j2`) from the same var, so the two are consistent by
construction. The manifest is additive — it does not change the `/etc/exports`
template task.

Manifest shape (one entry per preset export; `options` is the comma-split token
list, carried raw):

    [{ "path": "/mnt/data", "clients": "*",
       "options": ["rw","sync","insecure","no_root_squash",
                   "no_subtree_check","no_wdelay","fsid=0"] }]

On its FIRST boot after install, `xinas-api` (`seedShares()`) reads the manifest
and writes one desired `Share` per entry
(`/xinas/v1/desired/Share/<encExportId(path)>` =
`{ kind:'Share', id, spec:{ path, clients:[{pattern,options}], fsid } }`),
extracting `fsid` from the option tokens (assigning `max+1` when absent). No
executor runs and `/etc/exports` is not rewritten — the export already exists.
A one-time marker `/xinas/v1/meta/shares_seeded` makes seeding permanent-once:
an operator delete is never resurrected; a fresh state DB re-seeds.

Scope: only the install-declared exports are adopted. Out-of-band `exportfs`
edits are NOT auto-adopted — they remain drift (`drift.nfs-exports` `extra`).
This feature is not forced on plain release updates (no `Requires-Rebuild:
exports`, which would re-template `/etc/exports` and could clobber a
helper-managed file); existing installs adopt on their next full provision.
```

- [ ] **Step 2: Note the Share seed in the bootstrap-owning control-path doc**

Add a short note where the bootstrap self-seed is documented (ADR-0016 / `bootstrap.ts` owner): the api, at bootstrap, ALSO runs `seedShares()` (its own module `seed-shares.ts`) to adopt install-time exports into desired state once, guarded by `/xinas/v1/meta/shares_seeded`. Cross-link `docs/Installer/fs-exports-spec.md` and the design doc. (If ADR-0016 is landed/append-only, put the note in the live control-path spec that references bootstrap seeding and cross-link the ADR.)

- [ ] **Step 3: Commit**

```bash
git add docs/Installer/fs-exports-spec.md docs/control-path/
git commit -m "docs(installer,control-path): document install-time NFS share seed adoption"
```

---

## Task 7: Full verification pass

- [ ] **Step 1: TS suite + typecheck + lint**

Run: `cd xiNAS-MCP && npx tsc --noEmit && npx vitest run && npx biome check src`
Expected: all green.

- [ ] **Step 2: Confirm both Ansible render checks pass**

Re-run the `python3` render checks from Task 4 Step 3 and Task 5 Step 3.
Expected: both print `OK`.

- [ ] **Step 3: Manual acceptance narrative (record in the PR description)**

Confirm the original bug is fixed by tracing the flow:
1. Fresh install → `exports` role writes `/etc/exports` + `/var/lib/xinas/seed/shares.json`.
2. First `xinas-api` boot → `seedShares` creates `/xinas/v1/desired/Share/mnt/data` + marker.
3. `GET /api/v1/shares` returns the default → TUI "Show NFS Exports" lists it.
4. Add `/mnt/data/234` via the wizard → `GET /shares` returns BOTH → the default no longer disappears; Edit/Remove work on it.

---

## Self-Review Notes (verify during execution)

- **Marker key namespace** — `/xinas/v1/meta/shares_seeded` sits outside `desired/`·`observed/`; confirmed the KV `put()` has no key-prefix validation (`state/backend-sqlite.ts` is a generic INSERT). It won't appear in any list route.
- **fsid=0 preserved** — the default preset export uses `fsid=0`; `extractFsid` keeps it (0 is not `undefined`), and future wizard creates compute `max(used)+1 = 1`, so no collision.
- **Row shape parity** — the seeded doc matches `providers/nfs.ts` `toDesiredShareDoc` and the `routes-nfs.test.ts` fixture (`{ kind:'Share', id, spec }`), so GET/PATCH/DELETE all work on a seeded share.
- **No `Requires-Rebuild` trailer** — intentional (see spec §6). Do not add one for these commits.
