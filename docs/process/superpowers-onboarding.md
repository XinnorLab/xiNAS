# Superpowers onboarding record

Gate G0 of the workflow. Fill this in from the installed environment, not
from someone else's machine or an article. Repeat the short exercise
after every plugin update and correct this file.

## Installed versions

| Item | Value | Checked on |
|------|-------|------------|
| Claude Code (`claude --version`) | _fill in_ | _date_ |
| Superpowers source (`claude-plugins-official` or `superpowers-marketplace`) | _fill in_ | _date_ |
| Superpowers version (`/plugin` list) | _fill in_ | _date_ |
| Skills visible in the session (`/skills` or ask Claude to list them) | _fill in_ | _date_ |

## Skills used in this process

| Stage | Skill | Where its output goes |
|-------|-------|-----------------------|
| Idea refinement | `brainstorming` | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (draft); the area spec is updated before G3 |
| Planning | `writing-plans` | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` |
| Implementation | `subagent-driven-development` | commits per `TASK`; scratch state in `.superpowers/` (ignored) |
| Implementation in one session | `executing-plans` | same, for small features |
| Tests first | `test-driven-development` | inside each task |
| Review | `requesting-code-review`, `receiving-code-review` | `docs/reviews/` |
| Defects | `systematic-debugging` | finding and proof in the task or the card |
| Before "done" | `verification-before-completion` | `docs/test-runs/` |
| Isolation | `using-git-worktrees` | `.worktrees/` (ignored) |
| Finishing | `finishing-a-development-branch` | PR into `release/X.Y` |
| Project skills | `writing-skills` | `.claude/skills/<name>/SKILL.md` |

## Path overrides

Both `brainstorming` and `writing-plans` say user preferences override
their default paths. The defaults already match this repository's
`docs/superpowers/` convention, so no override is needed. The durable
contract is still the area spec under `docs/<Area>/`.

## Differences between the plugin flow and this process

- `brainstorming` goes straight to `writing-plans` after design
  approval. Here, ADRs, the area spec update and the spec review (G2,
  G3) come first.
- `subagent-driven-development` reviews each task for spec compliance
  and code quality; this process keeps that and adds the human gates
  before implementation and at acceptance.
- Several independent reviewers and a brainstorm between agents are
  arranged by the orchestrator; no plugin skill does this on its own.

## Practice feature

Record the practice run that closes G0: feature card, which skills were
invoked, where the files appeared, where the session stopped for a
human, and what did not work.

| Item | Result |
|------|--------|
| Feature card | _path_ |
| Skills invoked | _list_ |
| Files produced | _paths_ |
| Human stops | _gates reached_ |
| Hook test (`.claude/hooks/require-approved-spec.sh`) | _blocked with draft, allowed with approved: yes/no_ |
| Problems | _list_ |
