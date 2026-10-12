# xiNAS documentation map

Every document under `docs/` belongs to an area. Durable behavior
contracts are the area specs; everything dated is a draft or a record.

## Areas

| Area code | Folder | Contract documents | ADRs |
|-----------|--------|--------------------|------|
| `INST` | `docs/Installer/` | `spec.md`, `network-spec.md`, `raid-spec.md`, `fs-exports-spec.md`, `uninstall-spec.md`, `update-spec.md`, `hwkey-spec.md`, `xinas-api-role-spec.md` | — |
| `STOR` | `docs/Storage/` | `raid-management-spec.md`, `fs-shares-management-spec.md` | — |
| `MGMT` | `docs/Management/` | `user-management-spec.md`, `audit-log-spec.md`, `quick-actions-spec.md`, `xiraid-exporter-spec.md` | — |
| `NET` | `docs/Network/` | `spec-network-management.md` | — |
| `NOTIF` | `docs/Notifications/` | `spec-email-notifications.md` | — |
| `HC` | `docs/HealthCheck/`, `docs/healthcheck-tunables/` | one file per check; tunables reference | — |
| `HIST` | `docs/config-history/` | `requirements.md`, `architecture.md`, `specs.md`, `grpc-api-reference.md` | — |
| `CP` | `docs/control-path/` | `phase0-requirements.md`, `sN-*-requirements.md`, `sN-*-spec.md`, `api-v1.yaml` (CI-gated) | `docs/control-path/adr/` (`ADR-0001`…) |
| `CLIENT` | `docs/Client/` | `client-setup-spec.md` | — |
| `MCP` | `docs/MCP/` | legacy, reference only (superseded by ADR-0010 and `s8-clients-spec.md`) | — |

ADRs are numbered globally (`ADR-NNNN`) and kept in
`docs/control-path/adr/` for every area. An ADR supersedes earlier plan
or spec language where they conflict.

## Process records

| Folder | Contents | Naming |
|--------|----------|--------|
| `docs/process/` | the workflow, the Superpowers onboarding record, templates | — |
| `docs/features/` | one card per feature: gate, document versions, approvals, open questions | `FEAT-<AREA>-NN.md` |
| `docs/reviews/` | independent review reports (architecture, spec, implementation) | `REV-<FEAT>-<STAGE>-NN.md` |
| `docs/test-runs/` | final verification reports with exact commands and results | `RUN-<FEAT>-NN.md` |
| `docs/plans/` | dated design and implementation plans, append-only | `YYYY-MM-DD-<topic>-plan.md` |
| `docs/superpowers/` | dated drafts written by Superpowers skills (`specs/`, `plans/`, `tests/`), append-only | `YYYY-MM-DD-<topic>-design.md` |
| `docs/troubleshooting/` | postmortems and known-issue write-ups | one file per incident |
| `docs/TODO.md` | deferred work, with what "done" looks like | — |

## Identifiers

| Prefix | Object | Example | Where |
|--------|--------|---------|-------|
| `REQ` | requirement | `REQ-CP-021` | area requirements document |
| `Q` | open question | `Q-CP-004` | requirements document, questions section |
| `ADR` | architecture decision | `ADR-0019` | `docs/control-path/adr/` |
| `AC` | acceptance criterion | `AC-STOR-003` | spec, acceptance section |
| `TASK` | plan task | `TASK-STOR-07-02` | plan |
| `REV` | review report | `REV-STOR-07-SPEC-01` | `docs/reviews/` |
| `TEST` | test case or check | `TEST-STOR-003` | test plan and test code |
| `RUN` | test run report | `RUN-STOR-07-01` | `docs/test-runs/` |
| `FEAT` | feature card | `FEAT-STOR-07` | `docs/features/` |

Numbers are never reused. A withdrawn requirement is marked withdrawn;
its identifier stays. Test names or docstrings mention the `REQ` and
`AC` identifiers they cover, so the coverage matrix can be checked with
a search.

## Where a new document goes

- New behavior in an existing area: update that area's spec. Do not
  create a second spec for the same surface.
- A new surface that fits no area: a new folder under `docs/` with a
  noun name and its own area code added to the table above.
- A significant decision (module boundary, data ownership, interface,
  state model, reliability, compatibility, a new dependency): a new ADR.
- Anything an agent drafted in a session: `docs/superpowers/` or
  `docs/plans/`, dated, and then folded into the area spec before gate G3.
