# AGENTS.md

Common rules for every coding agent working in this repository. Project
knowledge (architecture, commands, release policy) lives in
[CLAUDE.md](CLAUDE.md); Claude Code imports this file from there. The
full process is in [docs/process/workflow.md](docs/process/workflow.md).

## Project

xiNAS is an Ansible-based provisioning framework for high-performance NAS
nodes: bash installer menus, a Python/Textual day-2 TUI (`xinas_menu/`), a
TypeScript control path (`xiNAS-MCP/`) and a configuration-history
library (`xinas_history/`). Target platform: Ubuntu 22.04/24.04 LTS.

- Documentation map: [docs/README.md](docs/README.md)
- Process and gates: [docs/process/workflow.md](docs/process/workflow.md)
- Claude Code specifics: [CLAUDE.md](CLAUDE.md)
- All repository artifacts are written in English, whatever language the
  session uses.

## Mandatory order of work

1. Identify the feature, the owning docs area, the current gate (G0–G7)
   and the boundaries of your task. Read the active feature card named in
   `.claude/active-feature`.
2. Read the area requirements, the area spec, the ADRs that apply and the
   skills you need before proposing anything.
3. Before changing an implementation, the spec must exist, must have an
   independent review on record, and must be approved by a human (G3).
4. Implementation runs only against the approved version of the spec and
   the plan (G4). Record which commit you are working from.
5. Do only the agreed scope of the task. New behavior that is not in the
   spec goes back to the spec, not into the code.
6. Every executor's result gets a separate review: spec compliance first,
   code quality second.
7. Run the verification commands from CLAUDE.md and keep the evidence
   (exact commands, results, what was not run and why).
8. Update the documents before final acceptance (G7).

## Changing a contract

When a new requirement appears or an architectural decision changes,
update and re-approve the affected documents first. A feature card that
says `approved` for a document that has materially changed is wrong:
reset the status, then re-approve.

Never resolve a critical question or an assumption silently. Write it
down with an owner, or ask.

## Documentation

- Durable behavior contracts live in the area spec under `docs/<Area>/`
  (see the table in CLAUDE.md). Update the spec before the code.
- Architecture decisions are ADRs in `docs/control-path/adr/`; an ADR
  supersedes earlier plan or spec language where they conflict.
- Dated drafts produced by skills (brainstorming design docs, plans, test
  scenarios) go to `docs/superpowers/` or `docs/plans/` and are
  append-only. They are not the contract; the area spec is.
- Feature cards: `docs/features/`. Review reports: `docs/reviews/`. Test
  run reports: `docs/test-runs/`. Templates: `docs/process/templates/`.
- Deferred work: [docs/TODO.md](docs/TODO.md).

## Identifiers

`REQ-<AREA>-NNN` requirement, `Q-<AREA>-NNN` open question,
`ADR-NNNN` decision, `AC-<AREA>-NNN` acceptance criterion,
`TASK-<FEAT>-NN` plan task, `REV-<FEAT>-<STAGE>-NN` review report,
`RUN-<FEAT>-NN` test run, `FEAT-<AREA>-NN` feature card. Area codes are
listed in `docs/README.md`. Numbers are never reused.

## Verification

The exact commands and their scope arguments are in CLAUDE.md
(section *Verification*) and are copied from the blocking CI jobs. Report
what ran, what did not run, and why. A green local run is not a CI run;
a CI run is not a smoke test on hardware. Say which one you have.

## Commits

An agent prepares commits; a human confirms them. The permission rules
in `.claude/settings.json` ask before `git commit`, `git push`, merges
and PR creation, so propose the exact command and message and wait.

When to commit:

- One accepted task is one commit. Commit only after the task passed its
  spec-compliance and code-quality reviews (gate G5), never in the middle
  of a task and never to "save progress".
- A document change (requirements, architecture, ADR, spec, plan, review
  report, feature card) is committed when the gate that produced it is
  recorded in the card. Code and the spec it implements land in the same
  change; a commit that ships code without its spec update is incomplete.
- Run the verification commands from CLAUDE.md before committing and
  put the results in the `RUN` report or the task result. Do not commit
  with a failing check unless the owner explicitly accepts it in the card.

How to commit:

- Work on a `<type>/<slug>` branch off the active `release/X.Y`. Never
  commit to `main` or to a release branch directly.
- Conventional Commits: `type(scope): subject`. Put the `TASK` id in the
  subject or body, and the `FEAT` id in the body, so history can be
  traced back to the spec. A trivial code-only fix says so in the body.
- Add `Requires-Rebuild: <role>` when the change needs an Ansible role
  to re-run on the host; `xiNAS-MCP/src/**` always needs
  `Requires-Rebuild: xinas_node_build`. Trailers start a line in the
  body. See CLAUDE.md *Update rebuild markers*.
- Stage files by name. Do not `git add -A` or `git add .`; look at
  `git status` and `git diff` first and leave out anything you did not
  change on purpose.
- Never commit `.claude/active-feature`, `.superpowers/`, `.worktrees/`,
  `playbooks/group_vars/`, `.xinas-local/`, keys, tokens or anything the
  `.gitignore` lists. Never commit `dist/` or `node_modules/`.
- Do not amend, rebase, squash or force-push commits that are already on
  a shared branch. PRs are merged with `--merge`, never `--squash`, so
  the trailers survive.
- A commit message describes the change and the reason, in English. It
  does not describe the conversation that produced it.
- Push only when asked, and only the feature branch. Opening a PR is a
  separate confirmed step: the PR targets `release/X.Y`, links the
  feature card, and lists the verification evidence.

## Approvals

Record every approval in the feature card: object, version (commit),
decision, person, date, limits. Approvals are given by the people named
in the feature card for that feature. An agent never approves on a
human's behalf, and silence is not approval.
