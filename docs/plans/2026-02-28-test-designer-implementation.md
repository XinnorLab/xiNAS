# Test Designer Skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a Claude Code skill that analyzes xiNAS code changes and generates structured Test Plans + Test Cases, publishing them to TestQuality.com via SDK, with automated GitHub Action triggering on PRs.

**Architecture:** Skill-First — SKILL.md defines methodology shared by manual (Claude Code) and automated (GitHub Action + Claude API) paths. A Node.js publishing script (`tq-publish.mjs`) uses `@testquality/sdk` to sync artifacts. See `docs/plans/2026-02-28-test-designer-skill-design.md` for full design.

**Tech Stack:** Markdown (skill), Node.js/ESM (publishing script), `@testquality/sdk`, GitHub Actions, Claude API (Anthropic SDK)

---

## Task 1: RED Phase — Baseline Test (No Skill)

Run a subagent scenario WITHOUT the skill to document how Claude naturally designs tests for a xiNAS change. This establishes what the skill needs to teach.

**Files:**
- Read: Recent git diff (e.g., commit `2f3bb93` — "Fix raid.list crash: always pass units='g' to raidShow gRPC call")

**Step 1: Run baseline scenario**

Launch a subagent (Task tool, subagent_type=general-purpose) with this prompt:

```
You are analyzing the xiNAS project. Here is a recent code change:

<diff>
(paste git diff for commit 2f3bb93)
</diff>

Design a comprehensive test plan and test cases for this change. Cover:
- Happy path
- Negative inputs
- Boundary conditions
- Failure scenarios

Output a structured Test Plan and Test Cases.
```

**Step 2: Document baseline behavior**

Record in a scratch file `docs/plans/test-designer-baseline.md`:
- What structure did the agent use? (flat list vs. hierarchical?)
- Did it identify the subsystem (RAID)?
- Did it classify the change type (bugfix)?
- Did it produce a risk analysis?
- Did it include xiNAS-specific context (gRPC, xiRAID, Ansible)?
- Did it output structured JSON or just prose?
- What was missing compared to our design's expected output?

**Step 3: Repeat with a second scenario**

Use a different change type — e.g., commit `5ecfed6` ("Add Paste SSH Key option to MCP Root SSH Access menu") which is a feature addition to a shell script menu. Document the same observations.

**Step 4: Identify patterns in baseline gaps**

Summarize: What does the agent consistently miss or do poorly without the skill? These are what SKILL.md must explicitly address.

---

## Task 2: Write SKILL.md — Core Skill File

**Files:**
- Create: `.claude/skills/test-designer/SKILL.md`

**Step 1: Create directory**

```bash
mkdir -p .claude/skills/test-designer/templates
```

**Step 2: Write SKILL.md**

Write the following content to `.claude/skills/test-designer/SKILL.md`:

```markdown
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
```

**Step 3: Commit**

```bash
git add .claude/skills/test-designer/SKILL.md
git commit -m "feat: add test-designer skill (SKILL.md)"
```

---

## Task 3: Write Templates

**Files:**
- Create: `.claude/skills/test-designer/templates/test-plan.md`
- Create: `.claude/skills/test-designer/templates/test-case.md`

**Step 1: Write test-plan.md template**

```markdown
# Test Plan: {{title}}

**PR:** {{pr_number}} | **Commit:** {{commit_sha}} | **Date:** {{date}}

## Scope

{{scope}}

## Risk Analysis

| Risk | Severity | Mitigation |
|------|----------|------------|
| {{risk_description}} | {{high/medium/low}} | {{mitigation}} |

## Test Strategy

**Test Types:** {{strategy_list}}

## Environment Requirements

{{environment}}

## Entry Criteria

{{entry_criteria}}

## Exit Criteria

{{exit_criteria}}

## Components

{{components_list}}

## Test Cases Summary

| ID | Title | Priority | Type | Component |
|----|-------|----------|------|-----------|
| {{id}} | {{title}} | {{priority}} | {{type}} | {{component}} |
```

**Step 2: Write test-case.md template**

```markdown
## {{id}}: {{title}}

**Component:** {{component}} | **Priority:** {{priority}} | **Type:** {{type}}

### Preconditions

{{preconditions}}

### Input Data

{{input_data}}

### Steps

| # | Action | Expected Result |
|---|--------|-----------------|
| {{step}} | {{action}} | {{expected}} |

### Expected Result

{{expected_result}}

### Observability

{{observability}}

### References

{{references}}
```

**Step 3: Commit**

```bash
git add .claude/skills/test-designer/templates/
git commit -m "feat: add test-designer templates (test-plan, test-case)"
```

---

## Task 4: GREEN Phase — Test Skill with Scenario

Re-run the same scenarios from Task 1, now WITH the skill loaded.

**Step 1: Run scenario with skill**

Launch a subagent with the SKILL.md content prepended:

```
<skill>
(paste full SKILL.md content here)
</skill>

You are analyzing the xiNAS project. Here is a recent code change:

<diff>
(paste git diff for commit 2f3bb93)
</diff>

Design test coverage for this change following the skill instructions.
```

**Step 2: Verify improvements**

Compare against baseline from Task 1:
- Does it produce both markdown AND JSON? (Required)
- Does it correctly classify subsystem as RAID?
- Does it classify change type as Bugfix?
- Does it include risk analysis?
- Does it use priority tiers (P0/P1/P2)?
- Does it scale test count appropriately for change size?
- Does it include xiNAS-specific patterns (gRPC, units parameter)?

**Step 3: Run second scenario with skill**

Repeat with the feature addition diff (commit `5ecfed6`). Verify it handles shell script analysis differently from TypeScript/gRPC changes.

**Step 4: Document results**

Update `docs/plans/test-designer-baseline.md` with GREEN phase results. Note any remaining gaps.

---

## Task 5: REFACTOR Phase — Close Loopholes

Based on GREEN phase results, update SKILL.md to address any gaps.

**Step 1: Identify remaining issues**

Review GREEN phase output for:
- Missing sections in JSON output
- Wrong priority assignments
- Missing xiNAS-specific patterns
- Vague or generic test cases
- Incorrect change classification

**Step 2: Update SKILL.md**

Edit `.claude/skills/test-designer/SKILL.md` to address each issue. Add explicit instructions for any pattern the agent missed.

**Step 3: Re-test**

Run both scenarios again. Verify all issues are resolved.

**Step 4: Add rationalization table (if needed)**

If agents consistently skip or shortcut parts of the methodology, add a "Red Flags" section to SKILL.md.

**Step 5: Commit**

```bash
git add .claude/skills/test-designer/SKILL.md
git commit -m "refactor: close test-designer skill loopholes from testing"
```

---

## Task 6: Create Publishing Script Package

**Files:**
- Create: `scripts/package.json`
- Create: `scripts/tq-publish.mjs`

**Step 1: Create scripts directory and package.json**

```bash
mkdir -p scripts
```

Write `scripts/package.json`:

```json
{
  "name": "xinas-scripts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "xiNAS automation scripts",
  "scripts": {
    "tq-publish": "node tq-publish.mjs"
  },
  "dependencies": {
    "@testquality/sdk": "latest"
  }
}
```

**Step 2: Install dependencies**

```bash
cd scripts && npm install
```

**Step 3: Write tq-publish.mjs**

Write `scripts/tq-publish.mjs`. This script:
1. Reads JSON input from a file (passed via `--input` flag)
2. Authenticates with TestQuality using `TQ_ACCESS_TOKEN` env var
3. Creates/updates a test plan
4. Creates test suites per component
5. Creates test cases with steps
6. Optionally links to a PR (via `--pr` flag)
7. Outputs summary with TQ artifact IDs

```javascript
#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    pr: { type: 'string', short: 'p' },
    project: { type: 'string', default: 'xiNAS' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.input) {
  console.error('Usage: node tq-publish.mjs --input <json-file> [--pr <number>] [--project <name>] [--dry-run]');
  process.exit(1);
}

const accessToken = process.env.TQ_ACCESS_TOKEN;
if (!accessToken && !values['dry-run']) {
  console.error('Error: TQ_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// Read and parse input JSON
const raw = readFileSync(values.input, 'utf-8');
const data = JSON.parse(raw);

if (!data.testPlan || !data.testCases) {
  console.error('Error: JSON must contain "testPlan" and "testCases" fields');
  process.exit(1);
}

const { testPlan, testCases } = data;

// Dry-run mode: just validate and summarize
if (values['dry-run']) {
  console.log('=== DRY RUN ===');
  console.log(`Test Plan: ${testPlan.title}`);
  console.log(`Scope: ${testPlan.scope}`);
  console.log(`Risks: ${testPlan.risks?.length || 0}`);
  console.log(`Strategy: ${testPlan.strategy?.join(', ')}`);
  console.log(`Test Cases: ${testCases.length}`);
  const byPriority = { P0: 0, P1: 0, P2: 0 };
  testCases.forEach(tc => { byPriority[tc.priority] = (byPriority[tc.priority] || 0) + 1; });
  console.log(`  P0: ${byPriority.P0}, P1: ${byPriority.P1}, P2: ${byPriority.P2}`);
  const components = [...new Set(testCases.map(tc => tc.component))];
  console.log(`Components: ${components.join(', ')}`);
  console.log('=== Validation passed ===');
  process.exit(0);
}

// --- TestQuality SDK Integration ---
// Note: The @testquality/sdk API surface is not fully documented publicly.
// This implementation uses the REST API approach as a fallback.
// When TQ account is set up, verify SDK methods and update accordingly.

const TQ_API_BASE = 'https://api.testquality.com';

async function tqFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${TQ_API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TQ API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function findOrCreateProject(name) {
  const projects = await tqFetch('/api/project');
  const existing = projects.find(p => p.name === name);
  if (existing) return existing;
  return tqFetch('/api/project', 'POST', { name });
}

async function createTestPlan(projectId, plan) {
  return tqFetch('/api/plan', 'POST', {
    project_id: projectId,
    name: plan.title,
    description: [
      `**Scope:** ${plan.scope}`,
      `**Strategy:** ${plan.strategy?.join(', ')}`,
      `**Environment:** ${plan.environment}`,
      `**Entry Criteria:** ${plan.entryCriteria}`,
      `**Exit Criteria:** ${plan.exitCriteria}`,
    ].join('\n\n'),
  });
}

async function createTestSuite(projectId, planId, name) {
  return tqFetch('/api/suite', 'POST', {
    project_id: projectId,
    plan_id: planId,
    name,
  });
}

async function createTestCase(projectId, suiteId, tc) {
  const test = await tqFetch('/api/test', 'POST', {
    project_id: projectId,
    suite_id: suiteId,
    name: `${tc.id}: ${tc.title}`,
    precondition: tc.preconditions,
    description: [
      `**Priority:** ${tc.priority}`,
      `**Type:** ${tc.type}`,
      `**Input Data:** ${tc.inputData}`,
      `**Observability:** ${tc.observability}`,
      `**References:** ${tc.references?.join(', ')}`,
    ].join('\n'),
  });

  // Add steps
  for (const step of tc.steps || []) {
    await tqFetch('/api/step', 'POST', {
      project_id: projectId,
      test_id: test.id,
      step: step.action,
      expected_result: step.expected,
      sequence: step.step,
    });
  }

  return test;
}

async function main() {
  try {
    // Find or create project
    const project = await findOrCreateProject(values.project);
    console.log(`Project: ${project.name} (ID: ${project.id})`);

    // Create test plan
    const plan = await createTestPlan(project.id, testPlan);
    console.log(`Test Plan created: ${plan.name} (ID: ${plan.id})`);

    // Group test cases by component
    const byComponent = {};
    for (const tc of testCases) {
      const comp = tc.component || 'general';
      if (!byComponent[comp]) byComponent[comp] = [];
      byComponent[comp].push(tc);
    }

    // Create suites and test cases
    let totalCreated = 0;
    for (const [component, cases] of Object.entries(byComponent)) {
      const suite = await createTestSuite(project.id, plan.id, component);
      console.log(`  Suite: ${component} (${cases.length} cases)`);

      for (const tc of cases) {
        await createTestCase(project.id, suite.id, tc);
        totalCreated++;
      }
    }

    // Summary
    const byPriority = { P0: 0, P1: 0, P2: 0 };
    testCases.forEach(tc => { byPriority[tc.priority] = (byPriority[tc.priority] || 0) + 1; });

    const summary = {
      planId: plan.id,
      planName: plan.name,
      totalCases: totalCreated,
      p0: byPriority.P0,
      p1: byPriority.P1,
      p2: byPriority.P2,
      components: Object.keys(byComponent),
      risks: testPlan.risks?.map(r => `${r.severity}: ${r.description}`) || [],
    };

    console.log('\n=== Published to TestQuality ===');
    console.log(JSON.stringify(summary, null, 2));

    // Output summary as JSON for GitHub Action consumption
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `tq_summary=${JSON.stringify(summary)}\n`);
    }
  } catch (err) {
    console.error('Failed to publish to TestQuality:', err.message);
    process.exit(1);
  }
}

main();
```

**Step 4: Test with dry-run mode**

Create a sample JSON input file and verify dry-run:

```bash
cat > /tmp/test-designer-sample.json << 'EOF'
{
  "testPlan": {
    "title": "TP: Fix raid.list crash",
    "scope": "RAID list command with units parameter",
    "risks": [{"description": "Missing units param crashes gRPC call", "severity": "high"}],
    "strategy": ["functional", "negative"],
    "environment": "Ubuntu 22.04, xiRAID 2.x",
    "entryCriteria": "xiRAID service running",
    "exitCriteria": "All P0 and P1 tests pass",
    "traceability": {"pr": null, "commit": "2f3bb93", "components": ["raid_fs"]}
  },
  "testCases": [
    {
      "id": "TC-001",
      "title": "raid.list returns arrays with default unit g",
      "component": "raid_fs",
      "priority": "P0",
      "type": "functional",
      "preconditions": "xiRAID running, at least one array exists",
      "inputData": "No explicit units parameter",
      "steps": [{"step": 1, "action": "Call raid.list via MCP", "expected": "Returns array list with sizes in GB"}],
      "observability": "Check MCP server logs for gRPC call parameters",
      "references": ["commit 2f3bb93"]
    }
  ]
}
EOF
node scripts/tq-publish.mjs --input /tmp/test-designer-sample.json --dry-run
```

Expected output: Validation summary showing 1 test case, P0 count = 1.

**Step 5: Commit**

```bash
git add scripts/package.json scripts/package-lock.json scripts/tq-publish.mjs
git commit -m "feat: add tq-publish.mjs for TestQuality integration"
```

---

## Task 7: Create GitHub Action Workflow

**Files:**
- Create: `.github/workflows/test-designer.yml`

**Step 1: Create directory**

```bash
mkdir -p .github/workflows
```

**Step 2: Write the workflow**

Write `.github/workflows/test-designer.yml`:

```yaml
name: Test Designer

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  pull-requests: write
  contents: read

jobs:
  test-design:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install publishing dependencies
        run: cd scripts && npm ci

      - name: Compute diff
        id: diff
        run: |
          DIFF=$(git diff ${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }})
          # Save diff to file (too large for env var)
          echo "$DIFF" > /tmp/pr-diff.txt
          echo "files_changed=$(echo "$DIFF" | grep '^diff --git' | wc -l)" >> $GITHUB_OUTPUT

      - name: Read skill methodology
        id: skill
        run: |
          # Extract the methodology sections from SKILL.md for the API prompt
          cat .claude/skills/test-designer/SKILL.md > /tmp/skill-methodology.md

      - name: Generate test design via Claude API
        id: generate
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          DIFF=$(cat /tmp/pr-diff.txt)
          SKILL=$(cat /tmp/skill-methodology.md)

          # Call Claude API
          RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
            -H "x-api-key: $ANTHROPIC_API_KEY" \
            -H "anthropic-version: 2023-06-01" \
            -H "content-type: application/json" \
            -d "$(jq -n \
              --arg skill "$SKILL" \
              --arg diff "$DIFF" \
              --arg pr "${{ github.event.pull_request.number }}" \
              --arg title "${{ github.event.pull_request.title }}" \
              '{
                model: "claude-sonnet-4-5-20241022",
                max_tokens: 8192,
                messages: [{
                  role: "user",
                  content: ("<skill>\n" + $skill + "\n</skill>\n\nAnalyze this PR and design test coverage.\n\nPR #" + $pr + ": " + $title + "\n\n<diff>\n" + $diff + "\n</diff>\n\nFollow the skill instructions. Output ONLY the JSON block tagged test-designer-json. No markdown output needed.")
                }]
              }'
            )")

          # Extract JSON from response
          echo "$RESPONSE" | jq -r '.content[0].text' | \
            sed -n '/```test-designer-json/,/```/p' | \
            sed '1d;$d' > /tmp/test-design.json

          # Validate JSON
          jq . /tmp/test-design.json > /dev/null 2>&1 || {
            echo "Error: Claude output was not valid JSON"
            echo "$RESPONSE" | jq -r '.content[0].text' > /tmp/claude-raw-output.txt
            cat /tmp/claude-raw-output.txt
            exit 1
          }

          echo "json_file=/tmp/test-design.json" >> $GITHUB_OUTPUT

      - name: Publish to TestQuality
        if: success()
        env:
          TQ_ACCESS_TOKEN: ${{ secrets.TQ_ACCESS_TOKEN }}
        run: |
          node scripts/tq-publish.mjs \
            --input /tmp/test-design.json \
            --pr ${{ github.event.pull_request.number }} \
            --project xiNAS

      - name: Post PR comment
        if: success()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const data = JSON.parse(fs.readFileSync('/tmp/test-design.json', 'utf-8'));
            const plan = data.testPlan;
            const cases = data.testCases;

            const byPriority = { P0: 0, P1: 0, P2: 0 };
            cases.forEach(tc => { byPriority[tc.priority] = (byPriority[tc.priority] || 0) + 1; });
            const components = [...new Set(cases.map(tc => tc.component))];

            const body = [
              '## Test Design Summary',
              '',
              `**Test Plan:** ${plan.title}`,
              `**Test Cases:** ${cases.length} (${byPriority.P0} P0, ${byPriority.P1} P1, ${byPriority.P2} P2)`,
              `**Components:** ${components.join(', ')}`,
              '',
              '### Key Risks',
              ...plan.risks.map(r => `- **${r.severity}:** ${r.description}`),
              '',
              '### Test Strategy',
              `Types: ${plan.strategy.join(', ')}`,
              '',
              '<details>',
              '<summary>Test Cases</summary>',
              '',
              '| ID | Title | Priority | Type | Component |',
              '|----|-------|----------|------|-----------|',
              ...cases.map(tc => `| ${tc.id} | ${tc.title} | ${tc.priority} | ${tc.type} | ${tc.component} |`),
              '',
              '</details>',
              '',
              '---',
              '*Generated by Test Designer skill*',
            ].join('\n');

            // Find existing comment to update
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c => c.body.includes('## Test Design Summary'));

            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }
```

**Step 3: Commit**

```bash
git add .github/workflows/test-designer.yml
git commit -m "feat: add test-designer GitHub Action workflow"
```

---

## Task 8: Update .gitignore and Documentation

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

**Step 1: Add scripts/node_modules to .gitignore**

Add to `.gitignore`:
```
scripts/node_modules/
```

**Step 2: Add test-designer skill reference to CLAUDE.md**

Add a section to `CLAUDE.md` under "Key Commands" or as a new section:

```markdown
### Test Design
```bash
# Manual: invoke /test-designer in Claude Code conversation
# Automated: triggers on PR via .github/workflows/test-designer.yml
# Publish manually: node scripts/tq-publish.mjs --input <json> [--pr <num>] [--dry-run]
```
```

**Step 3: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: add test-designer references to .gitignore and CLAUDE.md"
```

---

## Task 9: End-to-End Verification

**Step 1: Verify skill is discoverable**

In Claude Code, check that `/test-designer` appears as an available skill (or can be invoked).

**Step 2: Manual end-to-end test**

Run the skill manually on a recent commit:
1. Invoke `/test-designer` in Claude Code
2. Point it at a recent diff
3. Verify it produces both markdown and JSON output
4. Save JSON output to a file
5. Run `node scripts/tq-publish.mjs --input <file> --dry-run`
6. Verify dry-run output shows correct summary

**Step 3: Verify GitHub Action syntax**

```bash
# Validate YAML syntax
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test-designer.yml'))"
```

**Step 4: Document TestQuality setup steps for user**

Remind user of required setup (from design doc):
1. Sign up at testquality.com with GitHub
2. Install TestQuality from GitHub Marketplace
3. Connect XinnorLab/xiNAS repository
4. Generate PAT
5. Add repo secrets: `TQ_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: test-designer skill complete — skill, templates, publisher, GH Action"
```
