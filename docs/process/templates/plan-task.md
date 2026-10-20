# Plan task template

Plans follow the `writing-plans` header (goal, architecture, tech stack,
spec reference, global constraints) and add the identifiers below so the
plan can be checked against the spec.

```markdown
### TASK-AREA-NN-02 Short task title

Basis: `docs/Area/<spec>.md` §<section>, commit `<sha>`
Depends on: TASK-AREA-NN-01
Files: exact paths after reading the repository
Result: what behavior exists after the task
Checks: success path, error paths, boundary cases
Command: the exact verification command for this task
Out of scope: what the task must not touch
Acceptance: AC-AREA-NNN, AC-AREA-NNN
Rebuild: `Requires-Rebuild: <role>` or none
```

Stop conditions for the executor: a contract change, an unavailable
dependency, a conflict with an ADR, or an estimate that changes
materially. In each case return `BLOCKED` or `NEEDS_CONTEXT` to the
orchestrator instead of deciding alone.
