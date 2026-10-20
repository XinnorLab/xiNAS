# Development workflow with agents

This is the xiNAS adaptation of the team's methodology for developing
with Claude Code and Superpowers. The rule it enforces: requirements,
architecture and the spec are clarified and approved first, then the
plan, and only then does implementation start. Agents prepare material
and review each other; a human decides at the gates.

The full methodology (in Russian) is the source of this document. This
file states what applies to this repository and where things live here.

## Roles

| Role | Does | Returns | How it runs here |
|------|------|---------|------------------|
| Owner (human) | clarifies the goal, approves gate transitions | decisions recorded in the feature card | named per feature in the card |
| Orchestrator | passes context, assigns tasks, merges results, keeps the card current | feature status and next step | the main Claude Code session |
| Requirements analyst | finds gaps, writes requirements and questions | `REQ`, `AC`, assumptions, `Q` list | `.claude/agents/requirements-analyst.md` |
| Architect | designs the change within project rules | architecture section, ADR drafts, risks | `.claude/agents/project-architect.md` with the `project-architecture` skill |
| Architecture reviewers | independent check of the design | findings with evidence | `.claude/agents/architecture-reviewer.md`, one per review area |
| Spec author | turns requirements and architecture into a testable contract | area spec update | orchestrator or a subagent |
| Spec reviewer | checks completeness, consistency, testability | verdict: ready or rework | `.claude/agents/spec-reviewer.md` |
| Executor | one plan task, tests first | code, local checks, status | Superpowers `subagent-driven-development` |
| Implementation reviewer | spec compliance, then code quality | findings by severity | `.claude/agents/implementation-reviewer.md` |
| Test agent | final verification | `RUN` report | orchestrator or a subagent with Bash |

The author of a document never reviews it. A reviewer reads the material
directly and never edits it during the review.

## Gates

| Gate | Material | Condition to pass | Who |
|------|----------|-------------------|-----|
| G0 Setup | `docs/process/superpowers-onboarding.md` filled in | a practice feature ran through the whole cycle | team |
| G1 Requirements | requirements in the area doc, questions list | critical questions closed, acceptance criteria testable | owner |
| G2 Architecture | architecture section, ADRs (`proposed`) | independent review done, findings closed, ADRs accepted | owner or delegated architect |
| G3 Spec | area spec updated, `REV-…-SPEC` on record | reviewer verdict "ready", human approval recorded | owner |
| G4 Plan | plan with `TASK` ids and coverage of the spec | human allowed implementation of this plan version | owner |
| G5 Task | code and tests for one task | spec-compliance and code-quality reviews passed | reviewer |
| G6 Feature | integrated branch | acceptance criteria confirmed by a `RUN` report on the final commit | test agent, orchestrator |
| G7 Acceptance | final package | human accepted the result and its stated limits | owner |

An approval refers to a commit. If the document changes materially after
approval, the card goes back to the earlier gate.

## Feature profile

The owner picks a profile at G1 and records it in the card. The gates
stay; the amount of paper changes.

| | Small | Medium | Large or risky |
|---|---|---|---|
| Signs | one area, no contract or data change | new scenario or API change in one or two areas | several areas, data migration, security, public contract, anything under `api-v1.yaml` |
| Requirements and architecture | one section in the area spec | separate requirements and architecture sections | separate documents, diagrams, research, experiments on a node |
| ADR | only for a significant choice | per significant decision | per significant decision, with a verification method |
| Review | one independent reviewer per document | separate architecture and spec reviewers | reviewers per area plus a brainstorm |
| Approvals | G1–G4 in one sitting over the whole package | each gate separately | each gate separately, accepted risks written down |

If a contract or the data model turns out to change mid-way, move the
feature to the stricter profile.

## Where things live

| Artifact | Location |
|----------|----------|
| Feature card | `docs/features/FEAT-<AREA>-NN.md` (template in `docs/process/templates/`) |
| Active feature pointer | `.claude/active-feature` (path to the card, or `trivial`) |
| Requirements, architecture, spec | the area's documents under `docs/<Area>/` |
| ADRs | `docs/control-path/adr/NNNN-<slug>.md` |
| Drafts from skills | `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/superpowers/tests/` |
| Plans | `docs/superpowers/plans/` or `docs/plans/`, dated |
| Review reports | `docs/reviews/REV-<FEAT>-<STAGE>-NN.md` |
| Test run reports | `docs/test-runs/RUN-<FEAT>-NN.md` |
| Deferred work | `docs/TODO.md` |

Superpowers' `brainstorming` writes its design document to
`docs/superpowers/specs/` and hands over to `writing-plans`. In this
repository that handover waits: between the design and the plan come the
ADRs, the area spec update and the spec review (G2 and G3). The
orchestrator does not start a plan before G3 is recorded in the card.

## Context and sessions

- One stage per session. Start a new session or `/clear` between
  analysis, architecture, spec, plan and implementation. Before
  clearing, update the feature card: gate, document commits, open
  questions, next step.
- Pass work between stages through documents, never through chat
  history. A subagent sees only its prompt and the files.
- Use plan mode for analysis, architecture and planning sessions.
- One feature per branch (`<type>/<slug>` off `release/X.Y`). Use a
  worktree (`claude --worktree <name>` or `using-git-worktrees`) when
  more than one session is active.
- Implementation tasks run sequentially, one executor at a time, as
  `subagent-driven-development` requires. Parallel subagents are for
  independent reading and review only.

## Executor status codes

| Status | Orchestrator action |
|--------|---------------------|
| `DONE` | send to spec-compliance and code-quality review |
| `DONE_WITH_CONCERNS` | if the concern is about the contract, go back to the spec; otherwise pass the concern to the reviewer |
| `NEEDS_CONTEXT` | add the documents to the prompt; do not let the executor guess |
| `BLOCKED` | find the cause and the stage to return to |

Each accepted task ends in its own commit whose message carries the
`TASK` id (Conventional Commits, see CLAUDE.md), plus a
`Requires-Rebuild:` trailer when the change needs an Ansible role to
re-run. The agent proposes the commit and the human confirms it; the
full commit rules are in AGENTS.md *Commits*.

## Returns

A finding goes back to the material that holds its cause: a vague goal
to the requirements, a wrong trade-off to the architecture and ADRs, an
incomplete contract to the spec, a code defect to the task. After a
document changes, re-check what depends on it and reset the affected
approvals in the card. A fix must not hide an unclear contract.

Separate new wishes from defects: a new capability that the agreed
acceptance criteria do not need becomes the next feature or a
`docs/TODO.md` entry.

## Verification evidence

The `RUN` report records the commit, the environment, the exact commands
from CLAUDE.md *Verification*, their results, the criteria confirmed, the
scenarios not checked and why. Tests on mocks do not prove the real
service; a local run does not prove CI; CI does not prove a node. Name
which level was reached. The hardware smoke runbook in
`docs/control-path/hardware-smoke-runbook.md` is the node-level check.

## Retrospective

After G7, note in the card which review findings repeated, where agents
went wrong, and which rules did not work. Fold the lessons into the
skills, the rules and the agent prompts. Changing the process is itself
a documented change.
