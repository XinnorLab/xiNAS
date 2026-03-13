# Test Designer Skill — Baseline Test Results

## RED Phase: What Claude Does WITHOUT the Skill

### Scenario 1: RAID Bugfix (commit 2f3bb93, 6 lines, 1 file)

**What worked well:**
- Good technical depth — understood gRPC, withRetry, raidShow
- Covered happy path, negative, boundary, failure, and regression
- Identified the need for static analysis (grep for missed call sites)
- Reasonable test case count (~30)

**What was missing:**
- No explicit subsystem classification ("RAID")
- No change type classification ("Bugfix")
- No structured JSON output — only markdown tables
- No priority tiers (P0/P1/P2) — all test cases treated equally
- No formal Test Plan (scope, risk analysis, strategy, environment, entry/exit criteria, traceability)
- No observability notes per test case
- No reference links per test case (PR, file:line)
- Generated ~30 test cases for a 6-line fix (should be 3-5 per our scaling rules)

### Scenario 2: SSH Key Feature (commit 5ecfed6, 30 lines, 1 file)

**What worked well:**
- Excellent technical depth — found real bugs (missing error handling, substring grep issue)
- Good security analysis section
- Identified issues summary with severity
- Thorough boundary condition coverage
- Understood whiptail/shell patterns

**What was missing:**
- Same structural gaps as Scenario 1
- No subsystem classification ("Menu/UI")
- No change type classification ("Feature")
- No JSON output
- No priorities
- No formal test plan structure
- Generated ~40 cases for a 30-line feature (should be 5-12 per scaling rules)

## Common Baseline Gaps (What SKILL.md Must Teach)

1. **Classification** — Agent doesn't classify subsystem or change type
2. **Structured JSON** — Agent outputs only markdown, never JSON
3. **Priority tiers** — No P0/P1/P2 differentiation
4. **Formal test plan** — Missing scope, risk analysis, strategy, environment, entry/exit, traceability
5. **Observability** — No per-test-case observability notes
6. **References** — No per-test-case reference links
7. **Scaling** — Generates too many test cases regardless of change size
8. **Dual output** — Agent doesn't know it needs both markdown AND JSON

## What Agent Already Does Well (Don't Over-Teach)

1. Technical depth and domain awareness
2. Good variety of test types (happy, negative, boundary, failure)
3. Identifies real bugs during analysis
4. Understands shell script and TypeScript patterns
5. Covers security considerations when relevant

## GREEN Phase Results

(To be filled after testing with SKILL.md)

## REFACTOR Phase Results

(To be filled after closing loopholes)
