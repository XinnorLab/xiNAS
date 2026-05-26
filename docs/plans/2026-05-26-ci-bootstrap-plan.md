# Phase 0 CI Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 14-file Phase 0 CI baseline (workflow + per-language configs + sanity tests + contract test + dev-setup doc) so every PR runs lint, typecheck, schema-contract, secret-scan, and OpenAPI gates from the first implementation commit.

**Architecture:** Single GitHub Actions workflow (`.github/workflows/ci.yml`) with parallel jobs per concern. Jobs that match a known-clean baseline are blocking from day 1; jobs that would fail today on existing backlog (`ruff`, `pyright`, `biome format`, `yamllint`, `markdownlint`) are warn-only initially with named flip-to-blocking triggers. The contract-test scaffold validates handcrafted fixtures against `api-v1.yaml` schemas using Ajv, giving WS1 a real conformance gate before any handler exists.

**Tech Stack:** GitHub Actions (`ubuntu-latest`, `actions/setup-node@v4`, `actions/setup-python@v5`), Biome 1.9.4, Vitest 2.x, Ajv 8.x, `@apidevtools/json-schema-ref-parser` 11.x, `js-yaml` 4.x, Ruff (latest), Pyright (latest), Pytest 8.x, ansible-lint, yamllint, `@stoplight/spectral-cli` 6.x, gitleaks.

**Reference spec:** [docs/control-path/ci-bootstrap-design.md](../control-path/ci-bootstrap-design.md). Empirical verification results recorded in the spec's "Evidence behind blocking choices" and "Evidence behind warn-only choices" sections.

**Worktree:** `.claude/worktrees/determined-hoover-833782` on branch `claude/determined-hoover-833782`. All work happens here; merge or cherry-pick to `main` is a separate operator decision.

---

## File map

| Path | Action | Owns |
|---|---|---|
| `.github/workflows/ci.yml` | Create | Per-job runners, triggers, parallelism, warn-only via `continue-on-error: true` |
| `.gitleaks.toml` | Create | Secret scan rules + narrow allow-list for `startup_menu.sh:32` |
| `.spectral.yaml` | Create | OpenAPI lint (extends `spectral:oas`) + custom envelope rule |
| `.ansible-lint` | Create | Profile + one documented skip for existing roles |
| `.yamllint.yml` | Create | Line-length 200, truthy off, ignore list |
| `xiNAS-MCP/biome.json` | Create | Match existing style, lint `correctness` rules only |
| `xiNAS-MCP/vitest.config.ts` | Create | Test discovery under `src/**/*.test.ts` |
| `xiNAS-MCP/src/__tests__/sanity.test.ts` | Create | Package.json metadata sanity (no entrypoint import) |
| `xiNAS-MCP/src/__tests__/contracts/contracts.test.ts` | Create | Validates 5 fixtures against `api-v1.yaml` schemas via Ajv |
| `xiNAS-MCP/src/__tests__/contracts/fixtures/Envelope.json` | Create | Minimal valid envelope |
| `xiNAS-MCP/src/__tests__/contracts/fixtures/Cluster.json` | Create | Phase 0 singleton with `mode=single_node` |
| `xiNAS-MCP/src/__tests__/contracts/fixtures/Node.json` | Create | Single node with all required fields |
| `xiNAS-MCP/src/__tests__/contracts/fixtures/NfsProfile.json` | Create | `default` profile with inert HA fields |
| `xiNAS-MCP/src/__tests__/contracts/fixtures/Task.json` | Create | `plan_only` task with all NOT NULL fields |
| `xiNAS-MCP/package.json` | Modify | Add devDeps, scripts; pin Biome to ~1.9.4 |
| `pyproject.toml` | Modify | Add `[tool.ruff]`, `[tool.pyright]`, `[tool.pytest.ini_options]`, dev extras |
| `tests/__init__.py` | Create | Empty; makes `tests/` discoverable |
| `tests/test_sanity.py` | Create | Imports `xinas_menu.version`; asserts semver |
| `docs/control-path/dev-setup.md` | Create | How to run each gate locally |

**Total: 18 files (14 new + 2 modified) — no product code changes.**

---

## Task 1: Confirm worktree state

**Files:**
- Read-only: working tree

- [ ] **Step 1: Print branch and status**

Run:
```bash
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 branch --show-current
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 status -s
```

Expected: branch `claude/determined-hoover-833782`. The status may already contain uncommitted Phase 0 spec/ADR work that landed earlier in this session (`docs/control-path/`, `docs/plans/2026-05-26-phase0-control-path-plan.md`, modified `CLAUDE.md`). That's fine — this plan only adds new files and modifies `pyproject.toml` and `xiNAS-MCP/package.json`.

- [ ] **Step 2: Verify base tools are available**

Run:
```bash
node --version
python3 --version
which gitleaks || echo "gitleaks not installed locally (CI installs it)"
```

Expected:
- Node ≥ 18 (CI uses 20).
- Python ≥ 3.10.
- gitleaks: may or may not be present locally; CI installs it. No action required.

No commit at this task; it's only a pre-flight sanity check.

---

## Task 2: Python — extend `pyproject.toml` with dev deps and tool configs

**Files:**
- Modify: `pyproject.toml`

The current file declares only the `xinas-menu` build config. Append the tool sections so `pip install -e '.[dev]'` pulls in ruff / pyright / pytest with their settings.

- [ ] **Step 1: Read the existing pyproject.toml**

Run:
```bash
cat pyproject.toml
```

Expected: the existing 12-line file with `[build-system]`, `[project]`, `[tool.setuptools.dynamic]`, and `[tool.setuptools.packages.find]`. Confirm no `[project.optional-dependencies]` is already present (otherwise merge rather than overwrite).

- [ ] **Step 2: Append the tool configuration**

Edit `pyproject.toml` and append the following sections at the end of the file:

```toml

[project.optional-dependencies]
dev = [
  "pyright>=1.1.380",
  "ruff>=0.6.0",
  "pytest>=8.0",
  "pyyaml",
]

[tool.ruff]
line-length = 100
target-version = "py310"
extend-exclude = [".claude", "node_modules", "xiNAS-MCP/node_modules"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM"]
ignore = []

[tool.ruff.format]
quote-style = "double"
indent-style = "space"

[tool.pyright]
include = ["xinas_menu", "xinas_history", "xiNAS-MCP/nfs-helper"]
exclude = ["**/__pycache__", "**/.git", "**/node_modules", "**/.venv"]
reportMissingImports = "warning"
reportMissingTypeStubs = "none"
typeCheckingMode = "basic"

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
```

- [ ] **Step 3: Verify the file still parses as TOML**

Run:
```bash
python3 -c "import tomllib; tomllib.load(open('pyproject.toml','rb')); print('TOML valid')"
```

Expected output: `TOML valid`.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "$(cat <<'EOF'
build(python): add ruff/pyright/pytest tool config and dev extras

Adds [tool.ruff], [tool.pyright], [tool.pytest.ini_options], and a
[project.optional-dependencies] dev set. Ruff and pyright are run by
the new CI workflow (warn-only initially per the bootstrap design);
pytest runs the new sanity test as a blocking gate.

See docs/control-path/ci-bootstrap-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Python — sanity test (TDD: failing test first, then passing dep install)

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/test_sanity.py`

- [ ] **Step 1: Create `tests/__init__.py` as an empty file**

```bash
mkdir -p tests
touch tests/__init__.py
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_sanity.py` with this content:

```python
"""First-green sanity test for the Python toolchain."""
import re

from xinas_menu.version import XINAS_MENU_VERSION


def test_version_is_semver():
    assert re.match(r"^\d+\.\d+\.\d+", XINAS_MENU_VERSION), (
        f"XINAS_MENU_VERSION={XINAS_MENU_VERSION!r} is not semver"
    )
```

- [ ] **Step 3: Run the test in a clean venv to confirm it fails before install**

Run:
```bash
python3 -m venv /tmp/ci-bootstrap-venv
/tmp/ci-bootstrap-venv/bin/python -m pip install --quiet pytest
/tmp/ci-bootstrap-venv/bin/python -m pytest tests/test_sanity.py -v
```

Expected: `ModuleNotFoundError: No module named 'xinas_menu'` and `1 error`. This confirms the test is real — it actually exercises the package import path.

- [ ] **Step 4: Install dev extras and re-run**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/python -m pip install --quiet -e '.[dev]'
/tmp/ci-bootstrap-venv/bin/python -m pytest tests/test_sanity.py -v
```

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add tests/__init__.py tests/test_sanity.py
git commit -m "$(cat <<'EOF'
test(python): add semver sanity check on XINAS_MENU_VERSION

First-green test so the new python-tests CI job has something to run
without coverage looking like a vacuous 100%. Real tests replace this
as the codebase grows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Verify ruff and pyright baselines match the spec's recorded numbers

This task records the "warn-only" baseline so the CI workflow we land later doesn't surprise us. No new files; verification only.

- [ ] **Step 1: Confirm ruff lint count**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper 2>&1 | tail -3
```

Expected: a line like `Found NNN errors.` (within ±50 of 614 — the spec recorded 614 on 2026-05-26; small drift over time is fine). If the number has dropped to zero, the gate can be flipped to blocking now; that becomes a follow-up PR.

- [ ] **Step 2: Confirm ruff format count**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper 2>&1 | tail -3
```

Expected: `NN files would be reformatted, MM files already formatted` (within ±20 of 91/100 — the spec recorded 91 of 100).

- [ ] **Step 3: Confirm pyright count (basic mode, missing-imports as warning)**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper 2>&1 | tail -3
```

Expected: a line like `NNN errors, MM warnings, 0 informations` (within ±100 of 706 — the spec recorded 706, dominated by missing runtime deps).

No commit. If any number is wildly off (>2x), pause the plan and update the spec's evidence section before continuing.

---

## Task 5: TypeScript — extend `xiNAS-MCP/package.json`

**Files:**
- Modify: `xiNAS-MCP/package.json`

- [ ] **Step 1: Read current state**

Run:
```bash
cat xiNAS-MCP/package.json
```

Expected: existing file with `scripts.{dev,build,typecheck,start}` and the dependencies/devDependencies blocks. Confirm no `vitest`, `@biomejs/biome`, `ajv`, `js-yaml`, or `json-schema-ref-parser` are already present.

- [ ] **Step 2: Replace the file with extended deps and scripts**

Write `xiNAS-MCP/package.json`:

```json
{
  "name": "xinas-mcp",
  "version": "0.1.0",
  "description": "MCP server exposing xiNAS NAS infrastructure operations to AI assistants",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "start": "node dist/index.js",
    "lint": "biome lint src/",
    "format:check": "biome format --check src/",
    "format:write": "biome format --write src/",
    "test": "vitest run",
    "test:contracts": "vitest run src/__tests__/contracts"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.10.0",
    "@grpc/proto-loader": "^0.7.10",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^5.1.0",
    "uuid": "^9.0.0",
    "zod": "^3.22.0",
    "zod-to-json-schema": "^3.25.1"
  },
  "devDependencies": {
    "@apidevtools/json-schema-ref-parser": "^11.7.0",
    "@biomejs/biome": "~1.9.4",
    "@types/express": "^5.0.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.0.0",
    "@types/uuid": "^9.0.0",
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.1",
    "js-yaml": "^4.1.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 3: Update the lockfile**

Run:
```bash
cd xiNAS-MCP && npm install --package-lock-only && cd ..
```

Expected: `package-lock.json` is updated; no errors. The `--package-lock-only` flag avoids touching `node_modules` if it's not already present; CI does a fresh `npm ci`.

- [ ] **Step 4: Verify devDependencies are resolved**

Run:
```bash
cd xiNAS-MCP && jq -r '.packages | keys[]' package-lock.json | grep -E "biome|vitest|ajv|js-yaml|json-schema-ref-parser" && cd ..
```

Expected: each of the new packages appears at least once.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/package.json xiNAS-MCP/package-lock.json
git commit -m "$(cat <<'EOF'
build(ts): add biome 1.9.4, vitest, ajv, and contract-test deps

Pins @biomejs/biome to ~1.9.4 (v2 has a breaking config schema change;
upgrade is a separate PR). Adds vitest plus the libraries the contract
test uses to walk api-v1.yaml: ajv + ajv-formats for schema validation,
js-yaml to parse the spec, @apidevtools/json-schema-ref-parser to
dereference $refs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: TypeScript — Biome config

**Files:**
- Create: `xiNAS-MCP/biome.json`

- [ ] **Step 1: Write the config**

Create `xiNAS-MCP/biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": {
    "include": ["src/**/*.ts"]
  },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": false,
      "correctness": {
        "all": true
      }
    }
  }
}
```

- [ ] **Step 2: Verify Biome lint exits 0**

Run:
```bash
cd xiNAS-MCP && npx --yes @biomejs/biome@1.9.4 lint src/ ; echo "exit=$?" ; cd ..
```

Expected: `exit=0` (warnings are fine; non-zero exit would mean a lint *error*, which the spec verified does not occur).

- [ ] **Step 3: Verify Biome format check reports the known backlog**

Run:
```bash
cd xiNAS-MCP && npx --yes @biomejs/biome@1.9.4 format --check src/ 2>&1 | tail -3 ; cd ..
```

Expected: a line like `Checked 42 files in NN ms. No fixes applied.` plus `Found 35 errors.` (the format backlog the spec records as warn-only).

- [ ] **Step 4: Commit**

```bash
git add xiNAS-MCP/biome.json
git commit -m "$(cat <<'EOF'
ci(ts): add biome config (correctness rules only, matched style)

Pinned to schema 1.9.4 to match the devDependency. Correctness rule
category is blocking from day 1 (verified: 0 errors on src/). Other
categories are enabled incrementally as the codebase cleans up.

Style settings match the existing code: single quotes, 2-space
indent, semicolons, trailing commas, lineWidth 100. This avoids
churning the diff at bootstrap time; a mechanical format pass lands
in a separate PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: TypeScript — Vitest config + sanity test (TDD)

**Files:**
- Create: `xiNAS-MCP/vitest.config.ts`
- Create: `xiNAS-MCP/src/__tests__/sanity.test.ts`

- [ ] **Step 1: Write the vitest config**

Create `xiNAS-MCP/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Write the sanity test**

Create `xiNAS-MCP/src/__tests__/sanity.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package sanity', () => {
  it('package.json declares a semver version', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'),
    );
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.name).toBe('xinas-mcp');
  });
});
```

This deliberately does not import `src/index.ts`, so test discovery does not start the MCP server.

- [ ] **Step 3: Install dev deps and run the test**

Run:
```bash
cd xiNAS-MCP && npm ci && npx vitest run src/__tests__/sanity.test.ts ; cd ..
```

Expected: a passing report (`1 passed`), exit 0.

- [ ] **Step 4: Commit**

```bash
git add xiNAS-MCP/vitest.config.ts xiNAS-MCP/src/__tests__/sanity.test.ts
git commit -m "$(cat <<'EOF'
test(ts): add vitest config and package-metadata sanity test

The sanity test reads package.json directly rather than importing
src/index.ts, so the MCP server is not started during test discovery.
Real tests replace this as WS1 ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Contract test fixtures

**Files:**
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/Envelope.json`
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/Cluster.json`
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/Node.json`
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/NfsProfile.json`
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/Task.json`

The filename of each fixture names the OpenAPI component schema it validates against (e.g., `Envelope.json` → `#/components/schemas/Envelope`).

- [ ] **Step 1: Create the fixtures directory**

```bash
mkdir -p xiNAS-MCP/src/__tests__/contracts/fixtures
```

- [ ] **Step 2: Write Envelope.json**

```json
{
  "request_id": "00000000-0000-0000-0000-000000000001",
  "correlation_id": "fixture-envelope-1",
  "state_revision": 1,
  "warnings": [],
  "errors": [],
  "links": {},
  "result": null
}
```

- [ ] **Step 3: Write Cluster.json**

```json
{
  "kind": "Cluster",
  "id": "default",
  "metadata": {
    "revision": 1,
    "created_at": "2026-05-26T16:00:00Z",
    "modified_at": "2026-05-26T16:00:00Z",
    "owner": "system:installer",
    "source": "ansible:common",
    "validation_status": "valid"
  },
  "spec": {
    "display_name": "xiNAS fixture cluster"
  },
  "status": {
    "mode": "single_node",
    "capabilities": {
      "ha": "not_enabled",
      "quorum": "not_enabled",
      "witness": "not_enabled",
      "nfs.v3_locking_managed": false,
      "nfs.recovery_state_managed": false,
      "mcp.allow_apply": false
    },
    "member_node_ids": ["00000000-0000-0000-0000-0000000000aa"]
  }
}
```

- [ ] **Step 4: Write Node.json**

```json
{
  "kind": "Node",
  "id": "00000000-0000-0000-0000-0000000000aa",
  "metadata": {
    "revision": 1,
    "created_at": "2026-05-26T16:00:00Z",
    "modified_at": "2026-05-26T16:00:00Z",
    "owner": "system:installer",
    "source": "ansible:common",
    "validation_status": "valid"
  },
  "spec": {
    "hostname": "fixture-node-1"
  },
  "status": {
    "agent_state": "healthy",
    "observation_age_seconds": 0
  }
}
```

- [ ] **Step 5: Write NfsProfile.json**

```json
{
  "kind": "NfsProfile",
  "id": "default",
  "metadata": {
    "revision": 1,
    "created_at": "2026-05-26T16:00:00Z",
    "modified_at": "2026-05-26T16:00:00Z",
    "owner": "system:installer",
    "source": "ansible:nfs_server",
    "validation_status": "valid"
  },
  "spec": {
    "versions": {
      "v3":   { "enabled": false },
      "v4_0": { "enabled": false },
      "v4_1": { "enabled": true  },
      "v4_2": { "enabled": true  }
    },
    "rdma": { "enabled": true, "port": 20049 },
    "threads": { "count": 64 },
    "v3_locking": {
      "enabled": false,
      "fixed_rpc_ports": {
        "nfsd": 2049,
        "mountd": 20048,
        "lockd_udp": 32803,
        "lockd_tcp": 32803,
        "statd": 32765,
        "statd_outgoing": 32766
      }
    },
    "v4_recovery": {
      "backend": "nfsdcltrack",
      "recovery_root": "/var/lib/nfs/v4recovery",
      "server_scope": ""
    },
    "service_policy": {
      "on_thread_count_change": "reload",
      "on_version_change":      "restart",
      "on_rdma_change":         "restart",
      "on_v3_settings_change":  "restart"
    }
  },
  "status": {
    "effective_files": {},
    "running": {
      "thread_count": 64,
      "rdma_listening": true,
      "rdma_port": 20049,
      "active_versions": ["4.1", "4.2"]
    },
    "warnings": []
  }
}
```

- [ ] **Step 6: Write Task.json**

```json
{
  "task_id": "01902f25-7c54-7c10-b1f0-aaaabbbbcccc",
  "kind": "share.create",
  "state": "plan_only",
  "principal": "admin:fixture",
  "client_type": "rest",
  "request_id": "00000000-0000-0000-0000-000000000010",
  "correlation_id": "fixture-task-1",
  "input_hash": "sha256:fixture-input",
  "risk_level": "non_disruptive",
  "affected_resources": [
    { "kind": "Share", "id": "fixture-share-1", "revision": 0 }
  ],
  "created_at": "2026-05-26T16:00:00Z",
  "updated_at": "2026-05-26T16:00:00Z"
}
```

- [ ] **Step 7: Verify all fixtures are valid JSON**

Run:
```bash
for f in xiNAS-MCP/src/__tests__/contracts/fixtures/*.json; do
  python3 -m json.tool "$f" > /dev/null && echo "$f OK"
done
```

Expected: five `OK` lines, one per fixture.

- [ ] **Step 8: Commit**

```bash
git add xiNAS-MCP/src/__tests__/contracts/fixtures/
git commit -m "$(cat <<'EOF'
test(contracts): add minimal valid fixtures for 5 core schemas

One fixture each for Envelope, Cluster, Node, NfsProfile, and Task.
Fixtures are minimal-but-conformant — they exist to prove the schemas
are implementable, not to cover every field. Real response samples
replace them as WS1 ships handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Contract test runner (TDD against the live spec)

**Files:**
- Create: `xiNAS-MCP/src/__tests__/contracts/contracts.test.ts`

- [ ] **Step 1: Write the contract test**

Create `xiNAS-MCP/src/__tests__/contracts/contracts.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, it, expect, beforeAll } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'control-path',
  'api-v1.yaml',
);
const fixturesDir = resolve(here, 'fixtures');

describe('OpenAPI schema contract', () => {
  let schemas: Record<string, unknown> = {};
  let ajv: Ajv;

  beforeAll(async () => {
    const raw = yaml.load(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
    const resolved = (await $RefParser.dereference(raw)) as {
      components: { schemas: Record<string, unknown> };
    };
    schemas = resolved.components.schemas;
    ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
  });

  for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))) {
    const schemaName = basename(file, '.json');
    it(`${schemaName} fixture conforms to schema`, () => {
      const fixture = JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf8'));
      const schema = schemas[schemaName];
      expect(schema, `schema ${schemaName} not found in api-v1.yaml`).toBeDefined();
      const validate = ajv.compile(schema as object);
      const ok = validate(fixture);
      expect(validate.errors ?? [], `Errors validating ${file}`).toEqual([]);
      expect(ok).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/contracts ; cd ..
```

Expected: **5 passed** (one per fixture). If a fixture fails, Ajv prints the validation errors; fix the fixture to match the schema rather than relaxing the schema.

- [ ] **Step 3: Sanity-fail check — break a fixture, confirm the test catches it**

Temporarily edit `xiNAS-MCP/src/__tests__/contracts/fixtures/Cluster.json` to remove the `kind` field. Run the test again:

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/contracts ; cd ..
```

Expected: **1 failed** with an Ajv error about `must have required property 'kind'`. This proves the test is real.

Restore the fixture:

```bash
git checkout xiNAS-MCP/src/__tests__/contracts/fixtures/Cluster.json
```

- [ ] **Step 4: Re-run, confirm green**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/contracts ; cd ..
```

Expected: **5 passed**.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/__tests__/contracts/contracts.test.ts
git commit -m "$(cat <<'EOF'
test(contracts): validate fixtures against api-v1.yaml schemas via Ajv

Loads the OpenAPI spec at runtime, dereferences $refs, and asserts each
JSON fixture conforms to the component schema named by its filename.
This is WS1's day-1 contract gate — schema-conformance with no running
server required. Evolves into live mock-server contract tests as
handlers ship.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: OpenAPI — Spectral configuration

**Files:**
- Create: `.spectral.yaml`

- [ ] **Step 1: Write the config**

Create `.spectral.yaml`:

```yaml
extends: ["spectral:oas"]
rules:
  envelope-required-on-responses:
    severity: warn
    description: |
      Every non-stream JSON response must wrap with the Envelope schema,
      either directly via $ref or via allOf containing an Envelope $ref.
    given: $.paths[*][*].responses[*].content['application/json'].schema
    resolved: false
    then:
      function: schema
      functionOptions:
        schema:
          oneOf:
            - type: object
              required: ["allOf"]
              properties:
                allOf:
                  type: array
                  contains:
                    type: object
                    required: ["$ref"]
                    properties:
                      "$ref":
                        type: string
                        pattern: "Envelope"
            - type: object
              required: ["$ref"]
              properties:
                "$ref":
                  type: string
                  pattern: "Envelope|PlanResponse|TaskAcceptedResponse"
```

- [ ] **Step 2: Run Spectral with the config**

Run:
```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml 2>&1 | tail -3
```

Expected: `✖ 40 problems (0 errors, 40 warnings, ...)`. The custom rule (warn severity) does not produce additional findings against the current spec because every response already wraps with Envelope. The 40 remaining warnings are `operation-description` style — accepted backlog.

- [ ] **Step 3: Sanity-fail check — confirm the rule catches a broken response**

Make a temporary edit to `docs/control-path/api-v1.yaml`: change one response schema to a literal `{ type: object }` (without Envelope). Then re-run the lint and confirm `envelope-required-on-responses` fires.

```bash
# Pick any response — for example, edit /capabilities to point at a non-envelope schema temporarily.
# (Do this with the Edit tool when executing the plan; do not script it.)
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml 2>&1 | grep envelope-required | head -2
```

Expected: at least one `envelope-required-on-responses` warning is emitted.

Revert the temporary edit before continuing:

```bash
git checkout docs/control-path/api-v1.yaml
```

- [ ] **Step 4: Final clean run**

Run:
```bash
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml 2>&1 | tail -3
```

Expected: `✖ 40 problems (0 errors, 40 warnings, ...)` — no envelope rule firings.

- [ ] **Step 5: Commit**

```bash
git add .spectral.yaml
git commit -m "$(cat <<'EOF'
ci(openapi): add spectral ruleset (oas base + custom envelope rule)

Extends spectral:oas for OAS 3.1 structural validation (blocking).
Adds a custom rule envelope-required-on-responses that enforces the
Phase 0 contract that every non-stream JSON response wraps with the
Envelope schema. Rule is warn-only initially per the bootstrap
gate matrix; flips to blocking after three production PRs land
without violation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Ansible — `.ansible-lint`

**Files:**
- Create: `.ansible-lint`

- [ ] **Step 1: Write the config**

Create `.ansible-lint`:

```yaml
profile: production
skip_list:
  - risky-shell-pipe
exclude_paths:
  - .claude/
  - .github/
  - node_modules/
  - xiNAS-MCP/node_modules/
```

- [ ] **Step 2: Install and run ansible-lint locally**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/pip install --quiet ansible-lint
/tmp/ci-bootstrap-venv/bin/ansible-lint collection/roles/ 2>&1 | tail -10
```

Expected: `Passed: 0 failure(s), N warning(s) on M files.` exit code 0 (warnings do not fail by default with `profile: production`). If a hard failure appears that wasn't in the spec's evidence, capture it and update either the role or the `skip_list` here.

- [ ] **Step 3: Commit**

```bash
git add .ansible-lint
git commit -m "$(cat <<'EOF'
ci(ansible): add ansible-lint config (production profile)

One documented skip (risky-shell-pipe) for existing package-install
idioms. Excludes .claude/, .github/, and node_modules trees.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: YAML — `.yamllint.yml`

**Files:**
- Create: `.yamllint.yml`

- [ ] **Step 1: Write the config**

Create `.yamllint.yml`:

```yaml
extends: default
rules:
  line-length:
    max: 200
  truthy:
    check-keys: false
  document-start: disable
ignore: |
  .claude/
  node_modules/
  xiNAS-MCP/node_modules/
```

- [ ] **Step 2: Install and run yamllint locally**

Run:
```bash
/tmp/ci-bootstrap-venv/bin/pip install --quiet yamllint
/tmp/ci-bootstrap-venv/bin/yamllint -c .yamllint.yml . 2>&1 | tail -10
echo "exit=$?"
```

Expected: `exit=1` with a list of warnings/errors on existing roles (the spec records this as the warn-only backlog). The CI job sets `continue-on-error: true` so this nonzero exit does not fail the workflow.

- [ ] **Step 3: Commit**

```bash
git add .yamllint.yml
git commit -m "$(cat <<'EOF'
ci(yaml): add yamllint config (line-length 200, truthy off)

Warn-only initially; existing YAML in collection/roles/ and
healthcheck_profiles/ exceeds default rules. Flip-to-blocking
tracked in the bootstrap backfill plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Secrets — `.gitleaks.toml` with narrow allow-list

**Files:**
- Create: `.gitleaks.toml`

- [ ] **Step 1: Write the config**

Create `.gitleaks.toml`:

```toml
title = "gitleaks config for xiNAS"

[extend]
useDefault = true

# Each [[allowlists]] entry is AND-evaluated: a finding is suppressed
# only when ALL of paths/regexes/commits/stopwords match.

[[allowlists]]
description = "Bash assignment of git rev-parse HEAD in startup_menu.sh"
paths = ['''^startup_menu\.sh$''']
regexes = ['''local_commit=\$\(git ''']
```

- [ ] **Step 2: Run gitleaks (must be installed locally — `brew install gitleaks` if missing)**

Run:
```bash
gitleaks detect --no-banner --redact --config .gitleaks.toml --source . 2>&1 | tail -5
```

Expected: a final line `leaks found: 0` (the previously-flagged false positive in `startup_menu.sh:32` is now suppressed).

- [ ] **Step 3: Sanity-fail check — confirm a real secret would be caught**

Create a temporary file with a fake secret:

```bash
echo 'AWS_SECRET_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"' > /tmp/fake-secret-test.txt
gitleaks detect --no-banner --redact --config .gitleaks.toml --source /tmp/fake-secret-test.txt 2>&1 | tail -3
rm /tmp/fake-secret-test.txt
```

Expected: `leaks found: 1` (the allow-list is scoped to `startup_menu.sh` only, so other paths are still scanned).

- [ ] **Step 4: Commit**

```bash
git add .gitleaks.toml
git commit -m "$(cat <<'EOF'
ci(secrets): add gitleaks config with narrow false-positive allow-list

The default ruleset flags startup_menu.sh:32 — a bash variable
assignment of `git rev-parse HEAD` — as a generic-api-key. Allow-list
is scoped to that exact file + regex, not a directory glob.

Verified: baseline scan reports 0 leaks; a fake AWS key elsewhere in
the tree is still caught.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Dev-setup documentation

**Files:**
- Create: `docs/control-path/dev-setup.md`

- [ ] **Step 1: Write the doc**

Create `docs/control-path/dev-setup.md`:

```markdown
# Phase 0 Control Path — local dev setup

This guide shows how to run each CI gate locally before pushing. The
authoritative gate is `.github/workflows/ci.yml`; this doc duplicates
the invocations for fast local feedback.

## One-time setup

```bash
# Python
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

# TypeScript (inside xiNAS-MCP/)
cd xiNAS-MCP
npm ci
cd ..

# Ansible + YAML lint
.venv/bin/pip install ansible-lint yamllint

# Gitleaks
brew install gitleaks   # or use your distro's package manager
```

## Per-language gates

### TypeScript

```bash
cd xiNAS-MCP

# Blocking gates (from day 1)
npm run typecheck
npm run lint
npm test
npm run test:contracts

# Warn-only gate (still useful locally)
npm run format:check
# Apply fixes:
npm run format:write

cd ..
```

### Python

```bash
# Blocking gate
.venv/bin/pytest

# Warn-only gates (still useful locally)
.venv/bin/ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
.venv/bin/ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
.venv/bin/pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper

# Apply ruff fixes:
.venv/bin/ruff check --fix xinas_menu xinas_history xiNAS-MCP/nfs-helper
.venv/bin/ruff format xinas_menu xinas_history xiNAS-MCP/nfs-helper
```

### Ansible

```bash
.venv/bin/ansible-lint collection/roles/
```

### YAML

```bash
.venv/bin/yamllint -c .yamllint.yml .
```

### OpenAPI

```bash
npx -p @stoplight/spectral-cli@latest spectral lint \
  --ruleset .spectral.yaml \
  docs/control-path/api-v1.yaml
```

### Secrets

```bash
gitleaks detect --no-banner --redact --config .gitleaks.toml --source .
```

## Running everything in one go

```bash
# From the repo root
(cd xiNAS-MCP && npm run typecheck && npm run lint && npm test && npm run test:contracts) && \
  .venv/bin/pytest && \
  .venv/bin/ansible-lint collection/roles/ && \
  npx -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml && \
  gitleaks detect --no-banner --redact --config .gitleaks.toml --source .
```

Warn-only gates intentionally not chained — they emit known backlog.

## Optional: pre-commit hooks

The repo does not commit a `.pre-commit-config.yaml` because CI is the
source of truth. If you want local hooks, drop the following at
`.pre-commit-config.yaml` (uncommitted) and run `pre-commit install`:

```yaml
repos:
  - repo: local
    hooks:
      - id: typescript-lint
        name: typescript-lint
        entry: bash -c 'cd xiNAS-MCP && npm run lint'
        language: system
        pass_filenames: false
        files: ^xiNAS-MCP/src/.*\.ts$
      - id: pytest-sanity
        name: pytest-sanity
        entry: .venv/bin/pytest tests/test_sanity.py -q
        language: system
        pass_filenames: false
        files: ^tests/.*\.py$
      - id: spectral
        name: openapi-lint
        entry: npx -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml
        language: system
        pass_filenames: true
        files: ^docs/control-path/api-v1\.yaml$
```

## Regenerating the OpenAPI mock

The mock server is not part of this bootstrap. When WS1 ships it, the
command will be added here. For now, the contract test under
`xiNAS-MCP/src/__tests__/contracts/` is the only schema-conformance
check.
```

- [ ] **Step 2: Commit**

```bash
git add docs/control-path/dev-setup.md
git commit -m "$(cat <<'EOF'
docs(control-path): add dev-setup guide for the CI bootstrap gates

Documents the local equivalent of each CI job. Includes an optional
pre-commit hook config for developers who want fast local feedback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

This is the final assembly. It pulls together every config landed in tasks 2–13.

- [ ] **Step 1: Create the workflow directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
# Phase 0 CI bootstrap.
#
# See docs/control-path/ci-bootstrap-design.md for the full design,
# gate matrix, and backfill plan.
#
# Flip-to-blocking TODOs (in spec order):
#   TODO: flip openapi-envelope rule to blocking after 3 clean PRs
#   TODO: flip yamllint to blocking after backlog cleanup PR series
#   TODO: flip markdownlint to blocking after backlog cleanup PR series
#   TODO: flip typescript-format to blocking after `biome format --write` PR
#   TODO: expand typescript-lint to style/suspicious rule categories
#   TODO: flip python-lint to blocking after ruff cleanup PR series
#   TODO: flip python-format to blocking after `ruff format` PR
#   TODO: flip python-typecheck to blocking after runtime deps land in pyproject.toml
#   TODO: graduate pyright basic -> standard -> strict per module
#   TODO: add oasdiff between consecutive api-v1.yaml versions (after v1 published)
#   TODO: add pytest --cov coverage gate (after meaningful coverage exists)
#   TODO: add MCP integration smoke test (after containerized harness exists)
#   TODO: add live contract test against the WS1 mock server (after mock ships)

name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  typescript-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: xiNAS-MCP/package-lock.json
      - run: npm ci
        working-directory: xiNAS-MCP
      - run: npm run typecheck
        working-directory: xiNAS-MCP

  typescript-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: xiNAS-MCP/package-lock.json
      - run: npm ci
        working-directory: xiNAS-MCP
      - run: npm run lint
        working-directory: xiNAS-MCP

  typescript-format:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after backlog cleanup
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: xiNAS-MCP/package-lock.json
      - run: npm ci
        working-directory: xiNAS-MCP
      - run: npm run format:check
        working-directory: xiNAS-MCP

  typescript-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: xiNAS-MCP/package-lock.json
      - run: npm ci
        working-directory: xiNAS-MCP
      - run: npx vitest run src/__tests__/sanity.test.ts
        working-directory: xiNAS-MCP

  typescript-contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: xiNAS-MCP/package-lock.json
      - run: npm ci
        working-directory: xiNAS-MCP
      - run: npm run test:contracts
        working-directory: xiNAS-MCP

  python-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: pyproject.toml
      - run: pip install -e '.[dev]'
      - run: pytest

  python-lint:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after ruff cleanup PR series
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: pyproject.toml
      - run: pip install -e '.[dev]'
      - run: ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper

  python-format:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after `ruff format` PR
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: pyproject.toml
      - run: pip install -e '.[dev]'
      - run: ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper

  python-typecheck:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after runtime deps land
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
          cache-dependency-path: pyproject.toml
      - run: pip install -e '.[dev]'
      - run: pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper

  ansible:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
      - run: pip install ansible-lint
      - run: ansible-lint collection/roles/

  yamllint:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after backlog cleanup
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'
      - run: pip install yamllint
      - run: yamllint -c .yamllint.yml .

  openapi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: |
          npx --yes -p @stoplight/spectral-cli@latest spectral lint \
            --ruleset .spectral.yaml \
            docs/control-path/api-v1.yaml

  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # gitleaks scans history
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITLEAKS_CONFIG: .gitleaks.toml

  markdown:
    runs-on: ubuntu-latest
    continue-on-error: true   # warn-only: flip after backlog cleanup
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npx --yes markdownlint-cli2 'docs/**/*.md'
```

- [ ] **Step 3: Lint the workflow file**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML valid')"
```

Expected: `YAML valid`.

- [ ] **Step 4: Optional — use `act` for a dry-run if installed**

Run (skip if `act` is not installed locally):
```bash
which act && act -W .github/workflows/ci.yml -l
```

Expected (if `act` is present): a list of jobs matching the matrix above. If `act` is not installed, skip — CI itself is the real verification.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: add Phase 0 baseline workflow with 13 parallel jobs

Five blocking gates from day 1: typescript-{typecheck,lint,tests,
contracts}, python-tests, ansible, openapi, secrets. Seven warn-only
gates with documented flip-to-blocking triggers (typescript-format,
python-lint, python-format, python-typecheck, yamllint, markdown,
openapi-envelope custom rule).

Workflow comments enumerate the flip-to-blocking TODOs in the same
order as docs/control-path/ci-bootstrap-design.md's backfill plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Push and verify on GitHub Actions

This is the only network-touching step. Confirm with Sergey before
pushing, since previous instructions in this session emphasize "no
commits or pushes without explicit ask."

- [ ] **Step 1: Confirm push is authorized**

Ask the operator:

> All bootstrap commits land on `claude/determined-hoover-833782`. Push to `origin` so CI runs, or hold for further review?

Wait for explicit approval.

- [ ] **Step 2: Push**

If approved:

```bash
git push -u origin claude/determined-hoover-833782
```

Expected: branch published to GitHub.

- [ ] **Step 3: Wait for CI to complete**

Run:
```bash
gh run watch
```

Expected: 13 jobs reported; the 6 blocking ones (`typescript-typecheck`, `typescript-lint`, `typescript-tests`, `typescript-contracts`, `python-tests`, `ansible`, `openapi`, `secrets`) report success; the 5 warn-only ones (`typescript-format`, `python-lint`, `python-format`, `python-typecheck`, `yamllint`, `markdown`) may report failure but do not block the overall check.

- [ ] **Step 4: Verify the warn-only jobs ran and produced the expected backlog**

Run:
```bash
gh run view --log | grep -E "Found [0-9]+ errors|files would be reformatted|leaks found" | head -20
```

Expected output should match the spec's recorded numbers (±50 for ruff, ±20 for ruff format, ±100 for pyright). If any number is wildly off, capture it and update the spec's evidence section in a follow-up PR.

- [ ] **Step 5: Report status**

Post a summary to the operator: which jobs passed, which warn-only jobs reported what counts, and any unexpected failures. No further commits at this task.

---

## Self-review

Spec coverage check:

- `.github/workflows/ci.yml` → Task 15 ✓
- `.gitleaks.toml` → Task 13 ✓
- `.spectral.yaml` → Task 10 ✓
- `.ansible-lint` → Task 11 ✓
- `.yamllint.yml` → Task 12 ✓
- `xiNAS-MCP/biome.json` → Task 6 ✓
- `xiNAS-MCP/vitest.config.ts` → Task 7 ✓
- `xiNAS-MCP/src/__tests__/sanity.test.ts` → Task 7 ✓
- `xiNAS-MCP/src/__tests__/contracts/contracts.test.ts` → Task 9 ✓
- 5 fixture files → Task 8 ✓
- `xiNAS-MCP/package.json` modification → Task 5 ✓
- `pyproject.toml` modification → Task 2 ✓
- `tests/__init__.py` → Task 3 ✓
- `tests/test_sanity.py` → Task 3 ✓
- `docs/control-path/dev-setup.md` → Task 14 ✓

Gate matrix coverage:

- `typescript-typecheck` blocking → Task 15 job ✓
- `typescript-lint` blocking (correctness only) → Task 15 job + Task 6 config ✓
- `typescript-format` warn-only → Task 15 job ✓
- `typescript-tests` blocking → Task 15 job + Task 7 sanity test ✓
- `typescript-contracts` blocking → Task 15 job + Task 9 contract test ✓
- `python-tests` blocking → Task 15 job + Task 3 sanity test ✓
- `python-lint` warn-only → Task 15 job ✓
- `python-format` warn-only → Task 15 job ✓
- `python-typecheck` warn-only → Task 15 job ✓
- `ansible` blocking → Task 15 job + Task 11 config ✓
- `yamllint` warn-only → Task 15 job + Task 12 config ✓
- `openapi` blocking → Task 15 job + Task 10 ruleset ✓
- `openapi-envelope` warn-only → Task 10 custom rule ✓
- `secrets` blocking → Task 15 job + Task 13 allow-list ✓
- `markdown` warn-only → Task 15 job ✓

No placeholders detected. Type/method names cross-reference: `package.json` `scripts.test:contracts` (Task 5) ↔ `npm run test:contracts` (Task 15 job) ↔ `vitest run src/__tests__/contracts` (Task 9 directory). Consistent.

No unresolved decisions remain. The plan is ready for execution.
