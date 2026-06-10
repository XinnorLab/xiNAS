# Phase 0 CI Bootstrap — design

- **Status:** Approved design; pending implementation plan
- **Date:** 2026-05-26
- **Owner:** xiNAS Engineering
- **Related:** [phase0-requirements.md](phase0-requirements.md), [phase0-sequencing.md](phase0-sequencing.md), [api-v1.yaml](api-v1.yaml)

## Purpose

Phase 0 requires CI that makes the WS1 "contract tests run in CI" gate
meaningful. Today the repo has one workflow (`test-designer.yml`) that
calls the Claude API on PRs but enforces no real correctness check.
This design specifies the minimum polyglot CI baseline — TypeScript,
Python, Ansible, OpenAPI — that gates merges from the first
implementation commit forward.

## Scope

**In scope**

- Per-language lint and test gates: TypeScript (`xiNAS-MCP/`), Python
  (`xinas_menu/`, `xinas_history/`, `xiNAS-MCP/nfs-helper/`).
- Ansible role lint, YAML lint.
- OpenAPI 3.1 lint on `docs/control-path/api-v1.yaml` (and any future
  schema files under `docs/control-path/`).
- Secret scan with allow-list for known false positives.
- A single workflow file (`.github/workflows/ci.yml`) with parallel jobs.
- Local-dev parity documented in `docs/control-path/dev-setup.md`.

**Out of scope**

- Integration tests against a running xiNAS controller (lab CI; tracked
  separately in `phase0-sequencing.md` §5).
- MCP integration smoke tests (needs a containerized harness, tracked
  as TODO in the workflow).
- Coverage gates (re-introduced once meaningful coverage exists).
- `oasdiff` between consecutive API versions (only useful once v1 is
  published).
- Pre-commit hook framework — local-only convenience, documented in
  `dev-setup.md` but not required.

## Stack decisions

| Concern | Tool | Why |
|---|---|---|
| TS test runner | **Vitest** | ESM-first (matches `"type": "module"` in `xiNAS-MCP/package.json`), Jest-compatible API, fast, built-in coverage. |
| TS lint + format | **Biome** | Single binary, single config, replaces eslint + prettier. Configured to match existing style (single quotes, 2-space indent, semicolons, trailing commas, lineWidth 100). |
| Python lint + format | **Ruff** | Replaces flake8 + black + isort + pyupgrade. Single tool, very fast. |
| Python type check | **Pyright** | Faster than mypy, stronger inference on PEP 604 syntax. |
| Python tests | **Pytest** | Standard. Sanity test on day 1. |
| Ansible lint | **ansible-lint** | Standard. Default rule set with one skip for known idiom. |
| YAML lint | **yamllint** | Standard. Relaxed line-length for existing files. |
| OpenAPI lint | **Spectral CLI** (`@stoplight/spectral-cli`) | OAS 3.1 support via `spectral:oas` ruleset; custom rules in `.spectral.yaml` are loaded natively (Redocly does not consume Spectral rulesets; using Spectral keeps one tool, one config). |
| Secret scan | **gitleaks** | Fast, well-maintained, official GitHub Action. |
| Workflow | **Single `.github/workflows/ci.yml` with parallel jobs** | One PR check icon, jobs re-runnable independently. |

## Gate matrix

Where evidence shows the existing codebase would fail a tool on day 1,
the corresponding job ships **warn-only** initially with a documented
flip-to-blocking trigger. This avoids the "block every PR with cleanup
PRs" anti-pattern while still surfacing every issue.

| Job | First release | Flip-to-blocking trigger |
|---|---|---|
| `typescript-typecheck` (`tsc --noEmit`) | **Blocking** | n/a |
| `typescript-lint` (`biome lint`, `correctness` rules only) | **Blocking** | n/a; raise rule categories incrementally |
| `typescript-format` (`biome format src/` — Biome 1.9.4 uses no `--check` flag) | **Blocking** (flipped 2026-06-10 — backlog clean) | satisfied |
| `typescript-tests` (`vitest run`) | **Blocking** (one sanity test) | n/a |
| `typescript-contracts` (vitest schema-fixture validation against `api-v1.yaml`) | **Blocking** | n/a; expands as real handlers and mock server land |
| `python-lint` (`ruff check`) | **Blocking** (flipped 2026-06-10 — ruff cleanup PR) | satisfied |
| `python-format` (`ruff format --check`) | **Blocking** (flipped 2026-06-10 — format pass PR) | satisfied |
| `python-typecheck` (`pyright`, `basic` mode) | **Blocking** (flipped 2026-06-10 — runtime deps + typing tail landed) | satisfied |
| `python-tests` (`pytest`) | **Blocking** (one sanity test) | n/a |
| `ansible` (`ansible-lint`) | **Blocking** | n/a |
| `yamllint` | **Blocking** (flipped 2026-06-10 — house style codified in `.yamllint.yml`) | satisfied |
| `openapi` (`spectral lint`, ruleset `spectral:oas`) | **Blocking** | n/a |
| `openapi-envelope` (custom Spectral rule, loaded via `.spectral.yaml`) | **Warn-only** | After 3 production PRs land without violation |
| `secrets` (`gitleaks`) | **Blocking** | n/a |
| `markdown` (`markdownlint-cli2`) | **Blocking** (flipped 2026-06-10 — house style codified in `.markdownlint-cli2.jsonc`) | satisfied |

### Evidence behind warn-only choices

Verified empirically against the current tree on 2026-05-26.

- **`yamllint`**: existing YAML files exceed reasonable line lengths
  and use Ansible-idiomatic `truthy` values (`yes`/`no`). Examples:
  `collection/roles/perf_tuning/tasks/main.yml`,
  `collection/roles/xinas_uninstall/tasks/70_remove_paths.yml`,
  `healthcheck_profiles/standard.yml`.
- **`biome format`**: trial run on `xiNAS-MCP/src/` with a
  matched-style config (single quotes, 2-space, lineWidth 100) still
  reports format diffs in 35 of 42 files (mostly arrow-function
  line-wrapping). Blocking from day 1 would require a 35-file
  mechanical pass that bloats the bootstrap commit.
- **`ruff check`**: with rule set `E,F,I,B,UP,SIM` and line-length
  100, the current Python tree reports **614 errors** (284
  auto-fixable). Even the narrowest useful set `--select F` reports
  **55 errors** (41 auto-fixable). Cleanup belongs in its own PR
  series before this becomes blocking.
- **`ruff format --check`**: would reformat **91 of 100** Python
  files. A single format pass PR replaces this with a one-time
  mechanical diff, after which the gate flips to blocking.
- **`pyright`** in `basic` mode with `reportMissingImports = "warning"`:
  reports **199 errors, 249 warnings**. (An earlier draft of this
  spec recorded 706; that was a run before the `[tool.pyright]`
  config in `pyproject.toml` fully applied. Missing-imports
  correctly downgrade to warnings under the real config, leaving
  199 true type errors.) Adding the missing runtime deps
  (`textual`, `psutil`, etc.) is a separate, larger PR; once that
  lands the gate flips to blocking. Verified on CI run
  [26475296230](https://github.com/XinnorLab/xiNAS/actions/runs/26475296230).
- **`markdown`**: ~3,500 lines of existing markdown under `docs/`
  and the project README that would fail default
  `markdownlint-cli2` rules.
- **`openapi-envelope` custom rule**: verified to pass on the
  current `api-v1.yaml` (all 38 `application/json` response uses
  correctly wrap with the `Envelope`), but kept warn-only for the
  first three PRs as a guardrail while the spec expands.

### Evidence behind blocking choices

Verified empirically against the current tree on 2026-05-26.

- **`tsc --noEmit`**: existing `npm run typecheck` in
  `xiNAS-MCP/package.json` already passes; this just runs it in CI.
- **`biome lint`** with `recommended: false` + `correctness: { all:
  true }` rules, pinned to Biome **1.9.4** (see "Biome version
  pinning" below): **0 errors, 40 warnings, exit 0** on the current
  `xiNAS-MCP/src/`. Safe to block from day 1.
- **`vitest`**: a single sanity test that exercises `package.json`
  metadata; passes by construction.
- **`pytest`**: a single sanity test that imports
  `xinas_menu.version`; passes after `pip install -e .[dev]`.
- **`openapi` (Spectral CLI 6.x, `spectral:oas` ruleset)**: current
  spec passes with **0 errors, 40 warnings, exit 0**. Warnings are
  all `operation-description` style; addressed in a separate cleanup
  PR. The custom `envelope-required-on-responses` rule (warn-only)
  also passes against the current spec when run with `resolved:
  false` so it sees raw `$ref` rather than dereferenced schemas.
- **`gitleaks`** via `gitleaks/gitleaks-action@v2`: no existing
  secrets in the tree; the false positive (bash assignment of
  `git rev-parse HEAD` in `startup_menu.sh`) is suppressed by a
  narrow allow-list in `.gitleaks.toml`. **The action requires
  `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in the job env for
  `pull_request` events** — without it the action errors out
  before running any scan. The workflow passes the
  automatically-provisioned token; no manual secret setup needed.
- **`ansible-lint`** with `profile: min` and one documented skip
  (`risky-shell-pipe`) for package-install idioms: passes with
  **0 failures, 0 warnings**. An earlier draft of this spec
  claimed `production` profile worked; the actual measurement
  showed **463 failures** at `production`, dominated by
  `var-naming` (355 of 463). The bootstrap ships at `min` to keep
  the gate blocking from day 1; graduation to `basic` then
  `production` is tracked in the backfill plan below.

### Biome version pinning

Biome released a v2.x line in 2025 with a breaking change to the
config schema (`files.include` removed, replaced). The bootstrap
**pins `@biomejs/biome` to `1.9.4`** in `xiNAS-MCP/package.json`
devDependencies and references that schema URL in `biome.json`. A
future upgrade to v2.x is its own tracked PR (config migration via
`biome migrate`) and is out of scope for this bootstrap.

## Architecture

### Workflow

Single file `.github/workflows/ci.yml`. Triggers:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

Jobs run in parallel; each is independently retryable from the GitHub
Actions UI. No `paths-filter` initially — every job is cheap on a
fresh clone and broad coverage beats marginal speedup.

### Per-job specification

Each job is a separate `jobs.*` entry. The pattern is:

1. Checkout (`actions/checkout@v4`).
2. Tool-specific setup (Node 20, Python 3.11, etc.) with built-in
   caching keyed on the relevant lockfile.
3. Install deps.
4. Run the gate command.
5. Jobs that are warn-only initially: wrap the gate command with
   `continue-on-error: true` and post a summary that lists violations
   without failing the check.

Example (`typescript-typecheck`):

```yaml
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
```

`npm run typecheck` already exists in `xiNAS-MCP/package.json` and runs
`tsc --noEmit`.

Warn-only example (`typescript-format`):

```yaml
typescript-format:
  runs-on: ubuntu-latest
  continue-on-error: true   # warn-only: see Gate matrix
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: xiNAS-MCP/package-lock.json
    - run: npm ci
      working-directory: xiNAS-MCP
    - run: npx biome format src/   # Biome 1.9.4 check-mode is the default; no --check flag
      working-directory: xiNAS-MCP
```

### Configuration files

#### `.github/workflows/ci.yml`

Single workflow with the jobs from the gate matrix. Header comment
links to this spec and lists the flip-to-blocking TODOs in the same
order as the gate matrix.

#### `.gitleaks.toml`

Verified empirically: a baseline `gitleaks detect` against the current
repo reports **one finding** — a false positive on
`startup_menu.sh:32` where gitleaks' `generic-api-key` rule matches the
git SHA being assigned to a bash variable
(`local_commit=$(git -C "$REPO_DIR" rev-parse HEAD ...)`). The
allow-list is **scoped narrowly to that exact case**, not to a directory
glob.

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

If new genuine false positives appear over time, they are added as
additional `[[allowlists]]` entries, each scoped to specific
files/regexes. Broad path globs (`.claude/.*`, `docs/.*`) are
explicitly avoided — `.claude/skills/` is tracked and used by the
existing `test-designer.yml` workflow, so secrets there must still
be caught.

#### `.spectral.yaml`

Verified against `docs/control-path/api-v1.yaml` with
`@stoplight/spectral-cli@6.x`: **0 errors**, custom rule fires only on
real envelope-missing cases.

```yaml
extends: ["spectral:oas"]
rules:
  # Custom: every non-stream response must reference the envelope.
  # WARN-ONLY initially; see ci-bootstrap-design.md gate matrix.
  envelope-required-on-responses:
    severity: warn
    description: |
      Every non-stream JSON response must wrap with the Envelope schema,
      either directly via $ref or via allOf containing an Envelope $ref.
    given: $.paths[*][*].responses[*].content['application/json'].schema
    resolved: false       # see raw $ref, not the dereferenced schema
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

Two notes on the rule design:

- **`resolved: false`** is required. Spectral's default is to dereference
  `$ref` before running rules, in which case the `$ref` key is gone from
  the schema and a `contains.required: ["$ref"]` check finds nothing.
- **Both `oneOf` branches use `required`.** Without `required`, the JSON
  Schema `properties` keyword is non-binding and an empty object matches
  both branches vacuously.

`.redocly.yaml` is **not** part of this bootstrap. Redocly does not
consume Spectral rulesets; using Spectral directly avoids needing two
configs for one custom rule. If we later want Redocly's reference docs
generator, it can be added independently of CI.

#### `.ansible-lint`

```yaml
profile: production
skip_list:
  - risky-shell-pipe   # used by existing package-install idioms
exclude_paths:
  - .claude/
  - .github/
```

#### `.yamllint.yml`

```yaml
extends: default
rules:
  line-length:
    max: 200
  truthy:
    check-keys: false   # Ansible uses yes/no
  document-start: disable
ignore: |
  .claude/
  node_modules/
```

#### `xiNAS-MCP/biome.json`

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

#### `xiNAS-MCP/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

#### `xiNAS-MCP/src/__tests__/sanity.test.ts`

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

This deliberately avoids importing `src/index.ts` so test discovery
does not start the MCP server.

#### `xiNAS-MCP/package.json` (modifications)

Add to `devDependencies` (Biome pinned to 1.9.x; v2.x is a separate
migration tracked outside this bootstrap):

```json
"@biomejs/biome": "~1.9.4",
"vitest": "^2.1.0",
"ajv": "^8.17.0",
"ajv-formats": "^3.0.1",
"js-yaml": "^4.1.0",
"@types/js-yaml": "^4.0.9",
"@apidevtools/json-schema-ref-parser": "^11.7.0"
```

Add to `scripts`:

```json
"lint": "biome lint src/",
"format:check": "biome format src/",
"format:write": "biome format --write src/",
"test": "vitest run",
"test:contracts": "vitest run src/__tests__/contracts"
```

#### `pyproject.toml` (modifications)

Add:

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

#### `tests/test_sanity.py`

```python
"""First-green sanity test for the Python toolchain."""
import re

from xinas_menu.version import XINAS_MENU_VERSION


def test_version_is_semver():
    assert re.match(r"^\d+\.\d+\.\d+", XINAS_MENU_VERSION), (
        f"XINAS_MENU_VERSION={XINAS_MENU_VERSION!r} is not semver"
    )
```

#### `tests/__init__.py`

Empty file. Makes `tests/` a package for pytest discovery on systems
that prefer it.

#### `docs/control-path/dev-setup.md`

New ~80-line doc covering:

- `npm ci && npm run lint && npm run test` (inside `xiNAS-MCP/`)
- `pip install -e '.[dev]' && ruff check && ruff format --check && pyright && pytest`
- `ansible-lint collection/roles/`
- `yamllint .`
- `npx @stoplight/spectral-cli lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml`
- `gitleaks detect --no-banner --redact`
- Optional pre-commit hook install (config snippet provided; not
  committed).
- How to regenerate the OpenAPI mock once it exists.

## Files added in the bootstrap commit

```
.github/workflows/ci.yml                          (new)
.gitleaks.toml                                     (new)
.spectral.yaml                                     (new — base oas rules + envelope rule warn-only)
.ansible-lint                                      (new)
.yamllint.yml                                      (new — line-length 200, truthy off)
xiNAS-MCP/biome.json                               (new — matched style, correctness rules only)
xiNAS-MCP/vitest.config.ts                         (new)
xiNAS-MCP/src/__tests__/sanity.test.ts             (new — package.json-based)
xiNAS-MCP/src/__tests__/contracts/contracts.test.ts (new — schema-fixture contract test)
xiNAS-MCP/src/__tests__/contracts/fixtures/Envelope.json     (new)
xiNAS-MCP/src/__tests__/contracts/fixtures/Cluster.json      (new)
xiNAS-MCP/src/__tests__/contracts/fixtures/Node.json         (new)
xiNAS-MCP/src/__tests__/contracts/fixtures/NfsProfile.json   (new)
xiNAS-MCP/src/__tests__/contracts/fixtures/Task.json         (new)
xiNAS-MCP/package.json                             (modified — +vitest, +@biomejs/biome, +ajv, +js-yaml, +ref-parser)
pyproject.toml                                     (modified — ruff/pyright/pytest config + dev deps)
tests/__init__.py                                  (new)
tests/test_sanity.py                               (new)
docs/control-path/dev-setup.md                     (new)
```

14 files. **Zero changes to product code.** No `Requires-Rebuild:`
trailer (no Ansible role files changed).

## Backfill plan (post-bootstrap)

The flip-to-blocking triggers are not vague aspirations — each has a
named follow-up activity, sequenced to keep PRs small. Ordered roughly
by smallest-cost-first.

1. **Envelope rule to blocking** (no PR needed; flip after 3 production
   PRs land without violation).
2. **YAML lint cleanup** (1–2 PRs):
   - Wrap long lines, normalize truthy values, then flip `yamllint` to
     blocking.
3. **Markdown lint cleanup** (2–4 PRs):
   - Per-area fixes (`docs/control-path/` first, then `docs/MCP/`,
     etc.), then flip `markdownlint` to blocking.
4. **Biome format pass** (1 PR):
   - `npx biome format --write src/` then commit. Diff is mechanical;
     reviewers can skim. Then flip `typescript-format` to blocking.
5. **Biome lint expansion** (per category, separate PRs):
   - Enable `style` rules, fix violations, repeat for `suspicious`,
     `complexity`, `performance`. Each is its own PR.
6. **Ruff lint cleanup** (2–4 PRs):
   - Auto-fix wave (`ruff check --fix`) for the 284 auto-fixable
     violations, then manual fix passes per category. Then flip
     `python-lint` to blocking.
7. **Ruff format pass** (1 PR):
   - `ruff format` over the 91 dirty files. Mechanical diff. Then
     flip `python-format` to blocking.
8. **Pyright runtime-deps fix** (1 PR):
   - Add `textual`, `psutil`, and other runtime imports to
     `pyproject.toml`'s required dependencies. Pyright import errors
     drop dramatically. Then flip `python-typecheck` to blocking at
     `basic` mode.
9. **Pyright graduation** (per module, separate PRs):
   - Raise `xinas_history/` to `standard`, fix annotations, repeat
     for `xinas_menu/` and `xiNAS-MCP/nfs-helper/`.
10. **Ansible-lint graduation** (`min` → `basic` → `production`):
    - Start with `basic`: fix `var-naming` violations (355 of the 463
      `production` failures). Likely a multi-PR series given the
      breadth across roles.
    - Then `production`: fix `name`, `jinja`, `yaml`, and
      `no-changed-when` violations.
11. **Ajv import cleanup** (1 PR):
    - The contract test currently type-erases the Ajv import
      (`as any`) because Ajv 8.x's CJS-style `export = Ajv` types
      don't play nicely with `tsconfig module: Node16`. Switch to
      `import Ajv from "ajv/dist/ajv.js"` (bypasses the package
      exports map) or migrate to a TS-native validator like zod
      (which is already a dependency).

Steps 6, 7, 8, and 10 are the largest single items; everything else
is small enough to land in one PR each.

## Contract test scaffold (lands in bootstrap)

WS1's gate is "contract tests run in CI." OpenAPI lint validates that
the spec is well-formed; it does **not** validate that any concrete
JSON payload conforms to a schema. The bootstrap ships a minimal
schema-fixture contract test that closes that gap from day 1, before
any handler exists.

### Mechanism

A vitest test loads `docs/control-path/api-v1.yaml`, dereferences `$ref`,
and validates handcrafted JSON fixtures against the named component
schemas using Ajv. The test fails on any schema/fixture mismatch.

### Fixtures (lands in bootstrap)

Five small JSON files under
`xiNAS-MCP/src/__tests__/contracts/fixtures/`:

- `Envelope.json` — minimal envelope with `result: null`.
- `Cluster.json` — Phase 0 singleton with `mode=single_node`.
- `Node.json` — single node with all required fields.
- `NfsProfile.json` — Phase 0 `default` profile with HA fields at
  their inert defaults.
- `Task.json` — `plan_only` task with all NOT NULL fields populated.

Each fixture's filename names the schema it must validate against.
Fixtures are minimal but conform — they exist to *prove the schema is
implementable*, not to cover every field.

### Test file (lands in bootstrap)

`xiNAS-MCP/src/__tests__/contracts/contracts.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
// Ajv 8.x publishes CJS-style `export = Ajv` types. Under tsconfig
// `module: Node16`, the default import resolves to a namespace, not
// a constructible class, so `new Ajv(...)` fails `tsc --noEmit`
// even though vitest's esbuild loader runs it fine. The minimal fix
// is to type-erase via `as any`; long-term, switch to
// `import Ajv from "ajv/dist/ajv.js"` or migrate to a TS-native
// validator (zod is the obvious candidate since it's already a dep).
import AjvImport from 'ajv';
import addFormatsImport from 'ajv-formats';
import { describe, it, expect, beforeAll } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = AjvImport as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = addFormatsImport as any;

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '..', '..', '..', '..', 'docs', 'control-path', 'api-v1.yaml');
const fixturesDir = resolve(here, 'fixtures');

describe('OpenAPI schema contract', () => {
  let schemas: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ajv: any;

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
      const validate = ajv.compile(schemas[schemaName] as object);
      const ok = validate(fixture);
      expect(validate.errors ?? [], `Errors validating ${file}`).toEqual([]);
      expect(ok).toBe(true);
    });
  }
});
```

### Dependencies

Add to `xiNAS-MCP/package.json` devDependencies:

```json
"ajv": "^8.17.0",
"ajv-formats": "^3.0.1",
"js-yaml": "^4.1.0",
"@apidevtools/json-schema-ref-parser": "^11.7.0"
```

### Gate

Adds **`typescript-contracts`** job to the matrix: **blocking** from
day 1 because the bootstrap also ships conformant fixtures.

```yaml
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
    - run: npx vitest run src/__tests__/contracts
      working-directory: xiNAS-MCP
```

### How this evolves with WS1

As handlers are implemented, real response samples replace the
handcrafted fixtures. Once a mock server exists (later in WS1),
integration tests boot it and assert that real responses satisfy
the same schema check. The contract test becomes the
schema-conformance backbone, not just a fixture validator.

## Future work (tracked in workflow comments)

- Add `oasdiff` between consecutive `api-v1.yaml` versions (after v1
  is published).
- Add `pytest --cov` coverage gate (after real tests exist).
- Add MCP integration smoke test (after a containerized test harness
  exists).
- Add a live contract test against the WS1 mock server (after the
  mock server boots from `api-v1.yaml`).
- Add an Ansible molecule scenario CI job (after molecule scenarios
  are written for the new roles).

## Rejected alternatives

### Pre-commit hooks instead of GitHub Actions

Rejected: CI must be the source of truth and must run on every PR
regardless of local setup. Pre-commit can run locally as a developer
convenience (config snippet in `dev-setup.md`) but doesn't substitute
for CI.

### Separate workflows per concern (`ts.yml`, `py.yml`, ...)

Rejected: a single `ci.yml` with parallel jobs gives one PR check icon
without losing per-job retryability. Splitting workflows means six
status badges and no aggregated view.

### Mechanical format pass in the bootstrap commit

Rejected (for now): blowing up the bootstrap commit with 35 reformatted
TS files makes it harder to review. Format check stays warn-only
initially; the format pass lands as its own PR after the bootstrap.

### Vitest with `coverage.thresholds` from day 1

Rejected: no real tests exist yet. Coverage would either be 0 (so
thresholds are meaningless) or measured on a one-line sanity test
(falsely 100%). Coverage gate re-introduced when meaningful tests
land.

### Mypy instead of pyright

Rejected: pyright is faster, handles modern type syntax better, and
matches what VS Code's Python extension uses by default. Both can
read the same type annotations; switching backends later is cheap.

### Jest instead of vitest

Rejected: `xiNAS-MCP/package.json` declares `"type": "module"`; vitest
is ESM-native, Jest's ESM support is workable but historically
painful.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| CI becomes too slow as the codebase grows | Per-job caching is keyed on lockfiles; total wall-clock is ~3–5 min today and will stay sub-10-min through Phase 0. Revisit if a single job exceeds 5 min. |
| Warn-only jobs become permanent | Each warn-only job has a named flip trigger in the gate matrix. The backfill plan is sequenced in this doc. Quarterly review tracks progress. |
| Spectral custom rule has false positives | Kept warn-only initially. Adjusting the JSONPath expression or scoping it tighter is a one-line change. |
| `pyright` `basic` mode misses real bugs | Acceptable starting point. Per-module graduation captured in the backfill plan. |
| Bootstrap commit is reviewable but large | 14 files, ~700 lines including config; no product code changes. Falls within normal PR scope. |
