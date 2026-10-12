# FEAT-PROCESS-01 Adopt the agentic development workflow

Area: PROCESS (`docs/process/`)
Profile: small
Owner: Sergey Platonov
Approvers: requirements owner; architecture owner; spec and plan owner; acceptance owner
Current gate: G0 Setup
Spec status: draft
Branch: docs/agentic-workflow (off the active release/X.Y)

## Documents

- Workflow: `docs/process/workflow.md`
- Onboarding record: `docs/process/superpowers-onboarding.md` (to fill in)
- Templates: `docs/process/templates/`
- Agent definitions: `.claude/agents/`
- Architecture skill: `.claude/skills/project-architecture/SKILL.md`
- Permissions and hook: `.claude/settings.json`, `.claude/hooks/require-approved-spec.sh`

## Approvals

| Gate | Object and version | Decision | Person | Date | Limits |
|------|--------------------|----------|--------|------|--------|
| — | — | — | — | — | — |

## Open questions

| Id | Question | Why it matters | Addressed to | Needed material |
|----|----------|----------------|--------------|-----------------|
| Q-PROCESS-001 | Who approves each gate when the owner is unavailable? | the card must name a person per gate | owner | decision |
| Q-PROCESS-002 | Should `git push` stay behind a prompt (`ask`) or be denied in `.claude/settings.json`? | affects how PRs are opened | owner | decision |
| Q-PROCESS-003 | Which model does each role get (`model:` in `.claude/agents/*.md`)? Defaults: `opus` for the architect and reviewers, `inherit` for the analyst | cost versus review quality | owner | decision |

## Assumptions

| Id | Assumption | Owner | Confirm by |
|----|------------|-------|------------|
| A-1 | Superpowers is installed from `claude-plugins-official` | owner | G0 |
| A-2 | Claude Code runs with Git Bash on Windows, so `bash` command hooks work | owner | G0 |

## Accepted risks

- none yet

## Next step

1. Fill in `docs/process/superpowers-onboarding.md` from the installed environment.
2. Test the hook: with this card at `Spec status: draft`, ask Claude to edit a file under `xinas_menu/`; the edit must be blocked. Change the status to `approved`, retry; the edit must pass. Set the status back to `draft`.
3. Run a practice feature (a small one) through G1–G7 and record the stops in the onboarding file.
4. Decide the open questions above, then approve G0 in this card.

## Retrospective (after G7)

- Findings that repeated:
- Where agents went wrong:
- Rules to change:
