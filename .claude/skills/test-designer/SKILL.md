---
name: test-designer
description: >
  Use when analyzing code changes to design test coverage — generating
  structured Test Plans and Test Cases for xiNAS. Triggers: reviewing a PR,
  analyzing a diff, designing tests for new or modified code, preparing
  QA artifacts. Does not execute tests or modify production code.
---

# Test Designer

## Overview

Automated QA architect for xiNAS. Analyzes code changes and produces structured
Test Plans and Test Cases. Publishes artifacts to TestQuality.com. Does NOT
execute tests or modify production code.

## Hard Constraints

1. **Read-only analysis.** Never modify xiNAS source code.
2. **No test execution.** Design tests only — never run them.
3. **Structured output.** Always produce both markdown (for review) AND JSON (for TestQuality publishing).
4. **Prioritize ruthlessly.** Small changes get focused coverage, not exhaustive suites.

## Workflow

### Phase 1: Identify Changes

Determine what changed:
- If in a PR context: `git diff base...head`
- If invoked manually: ask the user what to analyze, or use `git diff HEAD~1` / `git log --oneline -5`

Map each modified file to a subsystem:

| Path Pattern | Subsystem |
|-------------|-----------|
| `collection/roles/raid_fs/`, `collection/roles/nvme_namespace/` | RAID |
| `collection/roles/nfs_server/`, `collection/roles/exports/`, `xiNAS-MCP/nfs-helper/` | NFS |
| `xiNAS-MCP/src/` | MCP |
| `collection/roles/doca_ofed/`, `collection/roles/net_controllers/`, `collection/roles/roce_lossless/` | Networking |
| `collection/roles/xiraid_exporter/`, `healthcheck*` | Monitoring |
| `presets/`, `configure_*.sh`, `collection/roles/*/defaults/` | Config |
| `prepare_system.sh`, `install.sh`, `collection/roles/common/` | Lifecycle |
| `xiNAS-MCP/src/middleware/` | Auth |
| `*_menu.sh`, `lib/menu_lib.sh` | Menu/UI |

Classify change type: `Feature | Bugfix | Refactor | Performance | Security | Config | Upgrade`

### Phase 2: Extract Testable Behaviors

For each modified function, handler, Ansible task, or script block, identify:

- **Inputs / outputs** — What goes in, what comes out
- **State transitions** — What system state changes
- **Error paths** — How failures are handled, error codes/messages
- **Idempotency** — Can this run twice safely? (Critical for Ansible roles)
- **Retry / timeout** — Any retry logic or timeout behavior
- **Access control** — Permission checks, authentication requirements
- **Invariants** — Things that must ALWAYS be true after this code runs
- **Failure modes** — What happens when dependencies are down

#### xiNAS-Specific Extraction Patterns

| Layer | What to Look For |
|-------|-----------------|
| **Ansible roles** | Task `when:` conditions, `failed_when:`, `changed_when:`, handler triggers, variable defaults vs overrides, template rendering, `check_mode` behavior |
| **Shell scripts** | `whiptail` menu options, input validation with `yq`, exit codes, `set -e` error handling, function return values |
| **MCP TypeScript** | Zod schema validation, gRPC call parameters, middleware chain order, error response structure, tool input/output contracts |
| **NFS helper (Python)** | systemd service lifecycle, export file parsing, quota calculation, gRPC server state, signal handling |
| **RAID orchestration** | Array creation params, namespace sizing, disk detection logic, rebuild triggers, XFS mount options |

### Phase 3: Generate Test Plan

Produce a Test Plan with these sections:

1. **Title:** `TP: <PR title or change summary>`
2. **Scope:** What is covered. What is explicitly excluded and why.
3. **Risk Analysis:** List risks ranked by severity (high/medium/low). Focus on:
   - Data loss potential
   - Service disruption
   - Security boundary violations
   - Silent failures (no error but wrong behavior)
   - Cross-subsystem side effects
4. **Strategy:** Which test types are needed:
   - Functional (does it do what it should?)
   - Negative (does it reject what it should?)
   - Boundary (edge values, limits)
   - Stability (long-running, repeated operations)
   - Performance (throughput, latency impact)
   - Resilience (failure injection, recovery)
   - Upgrade/rollback (if lifecycle-impacting)
5. **Environment:** Required hardware, OS version, xiRAID version, network config, prerequisites
6. **Entry Criteria:** What must be true before testing starts
7. **Exit Criteria:** What must be true to consider testing complete
8. **Traceability:** PR number, commit SHA, component names

### Phase 4: Design Test Cases

Apply priority tiers:

**P0 — Must Test (critical path, security, data integrity):**
- Happy path for the primary use case
- Security boundary enforcement
- Data integrity under normal operation

**P1 — Should Test (negative, boundary, failure):**
- Invalid inputs and error handling
- Boundary values (empty, max, off-by-one)
- Component failure (service down, disk missing, network timeout)
- Concurrent operation conflicts

**P2 — Nice to Test (stability, performance):**
- Repeated execution stability
- Performance under load
- Upgrade/rollback impact
- Resource leak detection

**Small changes (< 20 lines, single file):** Generate 3-5 test cases (P0 + key P1).
**Medium changes (20-100 lines, 2-5 files):** Generate 5-12 test cases (P0 + P1).
**Large changes (100+ lines, 5+ files):** Generate 10-20 test cases (P0 + P1 + P2).

Each test case MUST include:
- **ID:** `TC-NNN` (sequential)
- **Title:** Clear, action-oriented (e.g., "Verify raid.list returns arrays with default unit 'g'")
- **Component:** Subsystem name
- **Priority:** P0 / P1 / P2
- **Type:** functional / negative / boundary / stability / performance / resilience
- **Preconditions:** System state required before test
- **Input Data:** Specific values, configs, or scenarios
- **Steps:** Numbered actions with expected intermediate results
- **Expected Result:** Observable outcome that confirms pass/fail
- **Observability:** Logs, metrics, or commands to check
- **References:** PR link, code file:line, related docs

### Phase 5: Output

Produce TWO outputs:

**A) Markdown (for human review):**
Display the test plan and test cases in readable markdown format using the templates.

**B) JSON (for TestQuality publishing):**
Output a fenced JSON block tagged `test-designer-json`:

~~~
```test-designer-json
{
  "testPlan": {
    "title": "TP: ...",
    "scope": "...",
    "risks": [{"description": "...", "severity": "high|medium|low"}],
    "strategy": ["functional", "negative", ...],
    "environment": "...",
    "entryCriteria": "...",
    "exitCriteria": "...",
    "traceability": {"pr": null, "commit": "...", "components": ["..."]}
  },
  "testCases": [
    {
      "id": "TC-001",
      "title": "...",
      "component": "...",
      "priority": "P0",
      "type": "functional",
      "preconditions": "...",
      "inputData": "...",
      "steps": [{"step": 1, "action": "...", "expected": "..."}],
      "observability": "...",
      "references": ["..."]
    }
  ]
}
```
~~~

## Publishing to TestQuality

After generating output, inform the user:

> Test design complete. To publish to TestQuality, copy the JSON block above
> and run: `node scripts/tq-publish.mjs --input <json-file> [--pr <number>]`
>
> Or if using the GitHub Action, artifacts are published automatically on PR events.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Testing implementation details instead of behavior | Focus on observable outcomes, not internal state |
| Generating 50 test cases for a 5-line fix | Match volume to change size (see scaling rules) |
| Missing idempotency tests for Ansible | Always include "run twice, verify same result" for role changes |
| No preconditions specified | Every test case needs explicit starting state |
| Vague expected results ("should work") | Specify exact observable outcome (log message, return value, file state) |
