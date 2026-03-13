# Test Designer Skill — Design Document

**Date:** 2026-02-28
**Status:** Approved
**Approach:** Skill-First (Approach A)

## Summary

An automated QA architect skill for xiNAS that analyzes code changes and produces structured Test Plans and Test Cases, publishing them to TestQuality.com via GitHub integration. It does not execute tests or modify production code.

## Architecture

```
Developer (manual)                    GitHub (automated)
       |                                     |
  /test-designer                     PR opened/updated
       |                                     |
  Claude Code + SKILL.md          GH Action + Claude API
       |                                     |
       +----------+  Structured JSON  +------+
                  |                   |
             tq-publish.mjs (@testquality/sdk)
                        |
                  TestQuality.com
                        |
                  PR Summary Comment
```

### Dual Paths

- **Manual:** Developer runs `/test-designer` in Claude Code. Skill analyzes changes, outputs test plan + cases as markdown (for review) and JSON (for publishing). Developer can optionally run `tq-publish.mjs` to sync to TestQuality.
- **Automated:** GitHub Action triggers on `pull_request` events (`opened`, `synchronize`). Calls Claude API with the skill's methodology prompt + diff. Runs `tq-publish.mjs` automatically. Posts PR summary comment.

## Deliverables

| File | Purpose |
|------|---------|
| `.claude/skills/test-designer/SKILL.md` | Skill methodology — teaches Claude test design |
| `.claude/skills/test-designer/templates/test-plan.md` | Human-readable test plan template |
| `.claude/skills/test-designer/templates/test-case.md` | Human-readable test case template |
| `scripts/tq-publish.mjs` | Node.js script using `@testquality/sdk` to publish to TQ |
| `.github/workflows/test-designer.yml` | GitHub Action workflow |

## Skill Methodology (SKILL.md)

### Phase 1: Change Classification

- Parse git diff to identify modified files
- Map each file to subsystem: `RAID | NFS | MCP | Networking | Monitoring | Config | Lifecycle | Auth`
- Classify change type: `Feature | Bugfix | Refactor | Performance | Security | Config | Upgrade`
- Detect cross-subsystem impact

### Phase 2: Behavior Extraction

For each modified function/handler/task:
- Inputs, outputs, state transitions
- Error handling paths and failure modes
- Idempotency requirements (critical for Ansible roles)
- Retry/timeout behavior
- Access control boundaries
- System invariants

### Phase 3: Test Plan Generation

Produce structured plan:
- Scope (covered and explicitly excluded)
- Risk analysis (ranked by severity)
- Strategy (test types needed)
- Environment requirements (hardware, OS, xiRAID version, network)
- Entry/exit criteria
- Traceability (PR, commit, component)

### Phase 4: Test Case Design

Apply prioritization:
- **P0:** Happy path for critical functionality, security, data integrity
- **P1:** Negative inputs, boundary conditions, failure scenarios, error handling
- **P2:** Stability/long-running, scalability, performance under load

### xiNAS-Specific Heuristics

| Layer | Key Test Patterns |
|-------|-------------------|
| Ansible roles | Idempotency (run twice), check_mode, variable override precedence |
| Shell scripts | Input validation, menu flow paths, error messages |
| MCP TypeScript | gRPC tool contracts, middleware chain, error responses, concurrency |
| NFS helper (Python) | Export management, quota enforcement, session tracking, daemon lifecycle |
| RAID orchestration | Array create/delete, rebuild, disk failure handling |

## Output Format

### Structured JSON (for TestQuality)

```json
{
  "testPlan": {
    "title": "TP: <change summary>",
    "scope": "...",
    "risks": [{"description": "...", "severity": "high|medium|low"}],
    "strategy": ["functional", "negative", "boundary"],
    "environment": "...",
    "entryCriteria": "...",
    "exitCriteria": "...",
    "traceability": {"pr": 123, "commit": "abc123", "components": ["raid_fs"]}
  },
  "testCases": [
    {
      "id": "TC-001",
      "title": "...",
      "component": "raid_fs",
      "priority": "P0",
      "type": "functional",
      "preconditions": "...",
      "inputData": "...",
      "steps": [{"step": 1, "action": "...", "expected": "..."}],
      "observability": "...",
      "references": ["PR #123"]
    }
  ]
}
```

### Markdown (for human review in Claude Code conversations)

Uses templates from `.claude/skills/test-designer/templates/`.

## TestQuality Integration

### Setup Requirements

1. Sign up at testquality.com (free for public GitHub repos)
2. Install TestQuality from GitHub Marketplace
3. Connect XinnorLab/xiNAS repository
4. Generate Personal Access Token (PAT)
5. Add GitHub repo secrets: `TQ_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`

### Publishing Script (tq-publish.mjs)

Uses `@testquality/sdk` to:
1. Authenticate with PAT
2. Create/update test plan (find existing by naming convention)
3. Create test suites per component
4. Create test cases with steps
5. Link to GitHub PR

### GitHub Action (test-designer.yml)

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  test-design:
    runs-on: ubuntu-latest
    steps:
      - Checkout code
      - Compute diff (base...head)
      - Call Claude API with methodology prompt + diff
      - Parse structured JSON output
      - Run tq-publish.mjs
      - Post PR comment with coverage summary
```

### PR Comment Format

```
## Test Design Summary
- Test Plan: xiNAS-TP-0421
- 12 Test Cases generated (4 P0, 5 P1, 3 P2)
- Components: RAID namespace, NFS exports
- Key risks: concurrency handling, rollback behavior
- [View in TestQuality](link)
```

## Explicit Non-Goals

- Does NOT execute tests
- Does NOT provision test environments
- Does NOT modify xiNAS production code
- Does NOT push to main repository

## TestQuality Account Setup Guide

1. Go to [testquality.com](https://testquality.com) and sign up with GitHub
2. On the GitHub Marketplace page, install the TestQuality app for XinnorLab/xiNAS
3. In TestQuality, create a project linked to the xiNAS repository
4. Go to Settings → Personal Access Tokens → Generate new token
5. In GitHub repo settings → Secrets → Actions, add:
   - `TQ_ACCESS_TOKEN`: the TestQuality PAT
   - `ANTHROPIC_API_KEY`: your Anthropic API key for Claude
6. The GitHub Action will use these secrets automatically

## Sources

- [TestQuality](https://testquality.com/)
- [TestQuality GitHub Marketplace](https://github.com/marketplace/testquality)
- [TestQuality CLI](https://github.com/BitModern/testQualityCli)
- [TestQuality API Docs](https://doc.testquality.com/api)
- [@testquality/sdk](https://www.npmjs.com/package/@testquality/sdk)
