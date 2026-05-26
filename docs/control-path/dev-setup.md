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

The bootstrap uses the `min` profile. Long-term goal is `production`;
see `ci-bootstrap-design.md` backfill plan for graduation steps.

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

Gitleaks's `detect` command by default returns exit code 1 when leaks
are found; the GitHub Action job in CI uses the same behavior.

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
