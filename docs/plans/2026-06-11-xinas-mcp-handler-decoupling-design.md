# xinas_mcp role — daemon-lifecycle decoupling

**Date:** 2026-06-11
**Status:** Approved (design)
**Area:** `collection/roles/xinas_mcp/`
**Spec ownership:** `docs/MCP/spec-nfs-helper.md` (nfs-helper unit/install contract). This
change does not alter that contract — it is an internal Ansible-mechanism refactor — so no
spec edit is required. This doc records the design per the brainstorming workflow.

## Problem

`xinas_mcp` is the only role that provisions **two independent daemons** in one role:

- `xinas-nfs-helper.service` (privileged Python sidecar; MCP server's only consumer, over
  `/run/xinas-nfs-helper.sock`)
- `xinas-mcp.service` (Node/TypeScript MCP server)

…plus an unrelated `restart sshd` for the Claude root-SSH feature. All four share one handler
namespace (`handlers/main.yml`) and the tasks file calls **global `ansible.builtin.meta:
flush_handlers` twice** to sequence unit-install → daemon-reload → (re)start.

`flush_handlers` flushes *every* pending handler, regardless of which subsystem queued it.
A handler notified by one daemon therefore fires during the other daemon's flush. This caused a
production failure: the `Build TypeScript → dist/` task notified `restart xinas-mcp`, and the
**NFS-helper** section's `flush_handlers` flushed it before `xinas-mcp.service` was installed —
`Could not find the requested service xinas-mcp`. A prior fix reordered the build below the
NFS-helper flush; that removed the symptom but left the coupling (any future handler queued
before the NFS-helper flush hits the same trap).

Sibling roles `xinas_api` and `xinas_agent` use the same notify + `flush_handlers` pattern
safely **only because each owns a single daemon** — there is never a foreign handler pending at
their flush. `xinas_mcp`'s two-daemon bundling is what makes the global flush unsafe.

## Decision

Keep `xinas_mcp` as one role (the nfs-helper is an MCP sidecar — co-versioned, same
`xinas_mcp_repo_path`, no independent consumer; splitting it would create a role that is never
useful alone). **Remove the handler + `flush_handlers` pattern for daemon lifecycle** and
replace it with explicit, self-contained `ansible.builtin.systemd` tasks — one per daemon —
that do `daemon_reload` + `enabled` + `state` in a single call (the idiom `xinas_agent`'s enable
task already uses). With no pending daemon handlers, there is no global flush to misfire.

This was chosen over splitting into `xinas_nfs_helper` + `xinas_mcp` roles (rejected: more
churn — new role dir, edits to `site.yml` + both preset playbooks, doc role-count updates, a
second `Requires-Rebuild` tag — to separate two things that always deploy together).

## Design

### `collection/roles/xinas_mcp/tasks/main.yml`

Per daemon, the install → reload → start sequence collapses to one task. The `systemd` module
runs `daemon_reload` *before* the state action, so a freshly-copied unit is reloaded before
start — the same guarantee the old `flush_handlers` provided, now scoped to one service.

**NFS helper (section 3):**
- Add `register: _nfs_helper_src` to "Copy NFS helper Python sources"; drop its `notify`.
- Add `register: _nfs_helper_unit` to "Install xinas-nfs-helper systemd unit"; drop its `notify`.
- Delete the section-3 `flush_handlers` task.
- Replace "Enable and start xinas-nfs-helper" with:

```yaml
- name: Reload systemd, enable and (re)start xinas-nfs-helper
  ansible.builtin.systemd:
    name: xinas-nfs-helper
    daemon_reload: true
    enabled: true
    state: "{{ 'restarted' if (_nfs_helper_src is changed or _nfs_helper_unit is changed) else 'started' }}"
  tags: [xinas_mcp, nfs_helper, service]
```

**MCP server (section 4b):**
- Add `register: _mcp_build` to "Build TypeScript → dist/" (keeps `changed_when: true`, so the
  service still restarts on every role run — unchanged behavior); drop its `notify`.
- Add `register: _mcp_unit` to "Install xinas-mcp systemd unit"; drop its `notify`.
- Delete the section-4b `flush_handlers` task.
- Replace "Enable and start xinas-mcp" with:

```yaml
- name: Reload systemd, enable and (re)start xinas-mcp
  ansible.builtin.systemd:
    name: xinas-mcp
    daemon_reload: true
    enabled: true
    state: "{{ 'restarted' if (_mcp_build is changed or _mcp_unit is changed) else 'started' }}"
  tags: [xinas_mcp, service]
```

- Update the stale section-2 NOTE comment: the flush hazard is gone; the build stays in 4b
  simply because it must precede the service start.

### `collection/roles/xinas_mcp/handlers/main.yml`

Delete `reload systemd`, `restart xinas-nfs-helper`, `restart xinas-mcp` (now unused). Keep
`restart sshd`: it is independent of the two daemons, sshd always exists, and with no
`flush_handlers` left in the role it simply runs at end of play.

## Behavior preserved / removed

- **Preserved:** both units installed, daemon-reloaded, enabled, started; restart-on-change for
  each daemon; mcp restarts every run (build always reports changed).
- **Removed:** the entire class of cross-daemon `flush_handlers` misfires.

## Out of scope

- No role split; no playbook/preset edits.
- The four sibling roles using single-daemon `flush_handlers` (`xinas_api`, `xinas_agent`,
  `roce_lossless`, `raid_fs`) are safe as-is and untouched.
- `docs/MCP/spec-nfs-helper.md` install/verify contract is unchanged.

## Commit note

Role tasks change, so the commit needs a `Requires-Rebuild: xinas_mcp` trailer per the repo
CLAUDE.md, even though the externally observable end state is identical.
