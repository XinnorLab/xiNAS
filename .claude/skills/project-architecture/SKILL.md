---
name: project-architecture
description: Architecture rules for designing changes to xiNAS (installer roles, Python TUI, TypeScript control path, configuration history). Use when designing a feature, drafting an ADR, or reviewing a design; it says which patterns the project prefers, when each applies, and what must be justified in an ADR.
---

# xiNAS architecture rules

Read the approved requirements, the area spec, the ADRs that touch the
area (`docs/control-path/adr/`), and the code of the affected components
before proposing a design. Return architecture text, alternatives, ADR
drafts, risks and questions. Do not change the implementation and do not
approve on a human's behalf.

## System shape

```text
operator → bash installer menus → presets → Ansible roles → node
operator → Python/Textual TUI (xinas_menu) ─┐
operator → xinasctl CLI / MCP client        ├→ xinas-api (REST + /mcp) → xinas-agent → node
                                            └→ xinas_history (snapshots, drift, rollback)
```

- Install-time behavior belongs to Ansible roles under `collection/roles/`
  and is described in `docs/Installer/`. Roles are idempotent: a re-run
  over a healthy node converges without reformatting or rebuilding.
  Destructive storage operations require the explicit
  `xinas_storage_reset: true` path.
- Day-2 management is Python (`xinas_menu/`) or the TypeScript control
  path (`xiNAS-MCP/`). The post-install bash menus are deprecated: no new
  features there.
- Mutations of node state go through the control path's task engine
  (ADR-0004) with the agent privilege model (ADR-0002); the TUI and CLI
  are clients (ADR-0010). Do not add a second mutation path.
- Configuration changes that must be reversible go through
  `xinas_history`'s transactional runner: lock, preflight, snapshot,
  execute, validate, auto-rollback, release.

## Rules that need an ADR when broken or extended

Create an ADR (template: `docs/process/templates/adr.md`) when a design
touches module boundaries, data ownership, a public interface, a state
model, reliability behavior, compatibility, or adds a dependency. In
particular:

- A new REST route, MCP tool, resource or prompt, or a change to
  `docs/control-path/api-v1.yaml`. The file is CI-gated: Spectral lints
  it and `oasdiff` fails the PR on breaking changes. Design additive
  changes; a removal or tightening is a major decision.
- A new observed or desired state kind in the state store (ADR-0003), or
  a new collector. Say the poll interval and what it costs on the node.
- Any apply path reachable over MCP: it needs the human confirmation
  after `mcp.allow_apply` (S15) and the token scoped to `"surface": "mcp"`.
- A new systemd unit, package, sysctl, kernel module, NFS flag, RAID
  layout or netplan content. These need `Requires-Rebuild: <role>` on the
  commit; say so in the design.
- Network configuration: every IB interface lives only in
  `/etc/netplan/99-xinas.yaml`; applying always flushes PBR tables
  100–199 and mlx addresses first. A design that writes elsewhere needs
  an ADR and a very good reason.
- Anything in the install or update path: xiNAS installs and updates
  only from published GitHub Releases. No branch, tag-less or raw-URL
  fallback, ever.

## Preferred patterns and when they apply

| Situation | Preferred approach | Justify in the ADR |
|-----------|--------------------|--------------------|
| Operation outlives a client session | durable task with state in the store, idempotent re-apply, explicit cancel semantics (ADR-0012) | why a synchronous call is not enough |
| Reading node facts | an observed collector with a stated interval; `health.*` for health facts | cost of a faster interval on every consumer |
| Operator-visible failure | fail closed, surface the error; never map a read error to "ok" or "absent" | any case where degraded data is shown as healthy |
| Configuration files on the node | owned by exactly one role or executor; seed-adoption for pre-existing files | shared ownership |
| Vendor tool behavior (xiRAID `xicli`, DOCA-OFED, netplan, `nvme-cli`, XFS, nfsd) | cite the vendor doc with URL and version; otherwise state how the fact was observed | a flag used on the strength of its name alone |
| TUI feature | Textual screen in `xinas_menu/screens/` calling the control path; no logic in bash | any new bash day-2 UI |
| Cross-area contract | one canonical definition, referenced from both areas | a second copy |

Keep a simple synchronous operation simple. Do not make it distributed,
queued or background because a pattern exists; the requirements must ask
for it.

## Compatibility checklist for every design

- Existing hosts upgrading through the TUI update flow: what changes on
  disk, which role must re-run, what happens if the playbook fails.
- Fresh install from a release tag: does the installer need the change?
- Both MCP eras (legacy and the `2026-07-28` modern era, S14): which one
  the change targets.
- Client package (`client_repo/`): affected or not.
- Rollback: can `xinas_history` restore the previous state, and is the
  risk class (`destroying_data`, `changing_access`, `non_disruptive`) stated.

## What the design must contain

Component boundaries and responsibilities; data and control flows;
external and internal interfaces; where state lives and who owns it;
dependencies; error handling, timeouts, retries, recovery; versioning
and migration. Sequence or state diagrams where the order of events is
hard to check from prose. For every requirement either a place in the
design or a sentence on why no structural change is needed.

Leave exact request fields, error codes and edge cases to the spec; the
architecture and the spec must not contradict each other.
