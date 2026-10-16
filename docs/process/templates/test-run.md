# RUN-AREA-NN-NN Verification of FEAT-AREA-NN

Date and executor: YYYY-MM-DD, role or name
Code state: branch `type/slug`, commit `<sha>`
Environment: local venv | CI run `<url>` | node `<host>`, Ubuntu VERSION, xiRAID VERSION
Versions: Python, Node, Ansible, relevant packages

## Commands

Copied from CLAUDE.md *Verification*, exactly as run:

```bash
pytest --cov=xinas_history --cov-fail-under=20
ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check .
pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper
```

## Results

| Command | Result | Notes |
|---------|--------|-------|
| `pytest …` | passed / failed / skipped | … |

## Criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| AC-AREA-NNN | confirmed / failed / not checked | test name, log |

## Not verified

| Scenario | Reason |
|----------|--------|
| … | environment not available / out of scope |

## Logs and artifacts

- links or paths

## Defects and follow-up

| Id | Description | Requirement | Action |
|----|-------------|-------------|--------|
| … | … | REQ-AREA-NNN | returned to task / spec / TODO |
