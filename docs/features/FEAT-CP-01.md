# FEAT-CP-01 Mount the NFS loopback probe with `--type=nfs`

Area: CP (`docs/control-path/`)
Profile: small
Owner: Sergey Platonov
Approvers: spec and plan Sergey Platonov; acceptance Sergey Platonov
Current gate: G5 Task
Spec status: approved
Branch: fix/nfs-loopback-mount-type (off release/3.14 @ `ead19fb8`)

## Documents

- Spec: `docs/control-path/s19-mcp-health-prompt-spec.md` §9.3
  `nfs_loopback` step 2 (amended)
- Cause and evidence: `docs/troubleshooting/nfs-loopback-probe-systemd-mount-type.md`
- Hardware results: `docs/control-path/hardware-smoke-runbook.md` §5a
  (2026-10-15 notes)
- Spec review: independent `spec-reviewer` pass, verdict recorded below
- Plan: one task, below (small profile)

## Plan

### TASK-CP-01-01 Pass `--type=nfs` to the loopback mount

Basis: S19 spec §9.3 `nfs_loopback` step 2 (this branch)
Files: `xiNAS-MCP/src/agent/health/probe-host.ts` (the `systemd-mount`
argv and the header comment), `xiNAS-MCP/src/__tests__/agent/health/probe-host.test.ts`
(the pinned argv)
Result: the probe runs `systemd-mount --collect --type=nfs localhost:<export> <mnt>`
Checks: the unit test pins the new argv (`probe-host.test.ts:145`); the
F06 test that reads the mountpoint from the stubbed argv
(`probe-host.test.ts:298`, `args[2]`) reads the last argument instead,
since `--type=nfs` shifts the positions; failure, cleanup and lock paths
are untouched and their existing tests stay green
Command: the TypeScript lines of CLAUDE.md *Verification* (CI on the PR;
the workstation has no Node)
Out of scope: `--options=ro`, NFS version pinning, any other probe
Acceptance: the `nfs_loopback` probe and `nfs.loopback` in
`profile=deep` return ok on xinas-box after the rebuild
Rebuild: `Requires-Rebuild: xinas_node_build`

## Approvals

| Gate | Object and version | Decision | Person | Date | Limits |
|------|--------------------|----------|--------|------|--------|
| G3 | S19 spec §9.3 `nfs_loopback` step 2 as amended on this branch (docs commit before the code commit), after spec review 2 "ready" | approved | Sergey Platonov | 2026-10-15 | none |
| G4 | the one-task plan in this card (TASK-CP-01-01) | approved | Sergey Platonov | 2026-10-15 | none |

## Open questions

| Id | Question | Why it matters | Addressed to | Needed material |
|----|----------|----------------|--------------|-----------------|
| Q-CP-001 | Should the fix also go to 3.13.x as a hotfix? | every shipped release since v3.1.1 reports `nfs.loopback: critical` on `profile=deep` | owner | decision |

## Assumptions

| Id | Assumption | Owner | Confirm by |
|----|------------|-------|------------|
| A-1 | `--type=nfs` behaves the same on systemd 249 (Ubuntu 22.04) | owner | a 22.04 node run, or accepted risk |

## Accepted risks

- none yet

## Reviews

- Spec review 1 (2026-10-15, `spec-reviewer`): **rework** — the TODO
  entry was deleted before its done-criterion; the node evidence did not
  match the contract argv; the two documents gave different affected
  ranges; plus three minor findings. All six addressed on this branch
  (TODO entry restored and narrowed; exact argv re-observed; range
  checked with `git tag --contains f8bd8071`).
- Spec review 2 (2026-10-15, same reviewer): **ready** — all six
  findings closed; one minor card wording fix (Q-CP-001's start release)
  applied.

## Next step

1. Owner approves the spec amendment (G3) and the one-task plan (G4).
2. TASK-CP-01-01: test, then code; CI on the PR into `release/3.14`.
3. Forward-port the same change to `release/3.15` (a merge of
   `release/3.14`, or a cherry-pick).
4. Re-run the `nfs_loopback` and F05/F08 rows on xinas-box after the
   rebuild.

## Retrospective (after G7)

- Findings that repeated:
- Where agents went wrong:
- Rules to change:
