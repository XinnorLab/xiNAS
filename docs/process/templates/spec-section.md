# Spec section template

Area specs in this repository are long-lived documents under
`docs/<Area>/`. A feature adds or changes sections in that document; it
does not create a second spec. Use these headings for the part the
feature touches, so the spec reviewer can check each one.

```markdown
## <Feature or surface name>

Status: draft | in-review | approved (commit `<sha>`)
Requirements: REQ-AREA-NNN, REQ-AREA-NNN
ADRs: ADR-NNNN

### Goal and boundaries

### Scenarios (main and alternative)

### Interface and data contracts

Fields, required or optional, value limits, responses, errors. For
`api-v1.yaml` changes: the exact schema diff.

### States and transitions

### Errors and recovery

Repeat, connection loss, restart, partial failure.

### Compatibility and migration

Existing hosts, `Requires-Rebuild:` trailer, update path.

### Observability

### Acceptance criteria

| Id | Criterion | Check |
|----|-----------|-------|
| AC-AREA-NNN | … | test name or manual step |

### Open questions

### Review and approval

Reviewer, report id, verdict; approver, date, commit.
```

Vendor behavior (xiRAID, DOCA-OFED, netplan, NVMe, XFS, nfsd) is cited
from the vendor's documentation with URL and product version, or the
spec says how the fact was obtained (observed on a node, inferred from
an error). See CLAUDE.md *Spec-first rule*.
