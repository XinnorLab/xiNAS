# Requirements section template

Requirements live in the area's requirements document where one exists
(`docs/control-path/*-requirements.md`, `docs/config-history/requirements.md`)
or in a *Requirements* section of the area spec otherwise.

```markdown
## Requirements: <feature>

Version: commit `<sha>` · Status: draft | approved

### Context and goal

### Users and scenarios

### Requirements

REQ-AREA-NNN <statement>
Source: <person or document> · Priority: <must / should / could>
Acceptance: <testable condition>
Scenario: <link>

### Out of scope

### Assumptions

| Id | Assumption | Owner | Confirm by |
|----|------------|-------|------------|
| A-1 | … | name | G1 |

### Open questions

| Id | Unknown | Impact | Addressed to | Needed material |
|----|---------|--------|--------------|-----------------|
| Q-AREA-NNN | … | … | owner / architect / research | … |
```

Replace "fast", "reliable", "convenient" and "supports" with measurable
conditions. "Not required" fixes a boundary; "not decided yet" is an open
question and may block G1.
