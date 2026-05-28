# xinas-api Ansible role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `collection/roles/xinas_api/` (Phase 0 installer) + the source-tree unit-file fixes that make it actually deployable, per `docs/Installer/xinas-api-role-spec.md`.

**Architecture:** A new opt-in Ansible role with five files (defaults, handlers, tasks, two templates) plus a small fix to the systemd unit shipped by PR #201. The role pre-creates filesystem state via a tmpfiles.d snippet (instead of `StateDirectory`/`RuntimeDirectory` directives the unit can't make group-traversable under `DynamicUser`), bootstraps an admin bearer token coupled to the config-file lifecycle, and starts the service. No `playbooks/site.yml` change; no `xinas_uninstall` change.

**Tech Stack:** Ansible (collection role pattern matching `xinas_mcp` / `xinas_history`), systemd-tmpfiles, Jinja2 templates, `to_uuid` filter, `openssl rand -hex 32` for token generation, `getent` for gid lookup. CI runs `ansible-lint` + `ansible-playbook --syntax-check` on every role.

**Reference spec:**
- [docs/Installer/xinas-api-role-spec.md](../Installer/xinas-api-role-spec.md) — the contract this plan implements
- [docs/control-path/adr/0001-api-surface.md](../control-path/adr/0001-api-surface.md) — transport + principal model
- [docs/control-path/adr/0002-agent-privilege-model.md](../control-path/adr/0002-agent-privilege-model.md) — Hardening sample unit + "API is sole SQLite writer"
- [docs/control-path/adr/0003-state-store.md](../control-path/adr/0003-state-store.md) — canonical `/var/lib/xinas/state/` + `/var/log/xinas/audit.jsonl` paths
- [PR #201](https://github.com/XinnorLab/xiNAS/pull/201) — the `xinas-api` skeleton this role deploys

**Branch:** `claude/xinas-api-ansible-role` (already exists, off `main` tip `aa12337`; spec committed at `ed6d149`).

**Out of scope (separate PRs):**
- `playbooks/site.yml` integration (deferred until xinas-api becomes the primary control surface — WS12)
- `xinas_uninstall` symmetric cleanup hook
- TCP listener config + TLS termination
- Token rotation tooling (manual delete-both-files-and-rerun for now)
- Audit log rotation (out until WS9)
- `socketGroup` runtime override (variable is exposed; unit hardcoding makes it Phase 0 advisory-only)

---

## File map

| Path                                                | Action | Owns                                                                       |
|-----------------------------------------------------|--------|----------------------------------------------------------------------------|
| `xiNAS-MCP/xinas-api.service`                       | Modify | Fix ExecStart path; drop StateDirectory/LogsDirectory/RuntimeDirectory; add ReadWritePaths. |
| `collection/roles/xinas_api/defaults/main.yml`      | Create | All role variables.                                                        |
| `collection/roles/xinas_api/handlers/main.yml`      | Create | `reload systemd`, `restart xinas-api` handlers.                            |
| `collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2` | Create | tmpfiles.d snippet for /run/xinas + /var/lib/xinas/state + /var/log/xinas. |
| `collection/roles/xinas_api/templates/xinas-api-config.json.j2`   | Create | The runtime config JSON.                                                   |
| `collection/roles/xinas_api/tasks/main.yml`         | Create | Pre-flight, group, gid lookup, dirs, tmpfiles, token+config bootstrap, unit install, enable+start. |
| `collection/roles/xinas_api/README.md`              | Create | Role overview, vars, example play, rotation procedure, pre-flight gotcha.  |

No `meta/main.yml` (intentionally — no role-dep on `xinas_mcp` per spec §Preconditions).

---

## Task 1: Source-tree fix to the systemd unit

**Files:**
- Modify: `xiNAS-MCP/xinas-api.service`

The current unit has four problems (per spec §Systemd unit — source-tree fix): wrong ExecStart path, `StateDirectory`/`LogsDirectory` that contradict ADR-0003, missing `ReadWritePaths` (locks the service out of its own dirs under `ProtectSystem=strict`), and `RuntimeDirectory=xinas` that puts `/run/xinas` under the dynamic uid (not group-traversable by xinas-admin).

- [ ] **Step 1: Read the current unit**

Run: `cat xiNAS-MCP/xinas-api.service`

Confirm the four problem lines are present: `ExecStart=/usr/bin/node /opt/xinas-mcp/dist/api-server.js`, `StateDirectory=xinas-api`, `LogsDirectory=xinas-api`, `RuntimeDirectory=xinas`, `RuntimeDirectoryMode=0750`. Confirm `ReadWritePaths` is absent.

- [ ] **Step 2: Apply the four edits**

Use Edit tool, one fix per Edit call:

```
Edit #1:
  old: ExecStart=/usr/bin/node /opt/xinas-mcp/dist/api-server.js
  new: ExecStart=/usr/bin/node /opt/xiNAS/xiNAS-MCP/dist/api-server.js
```

```
Edit #2 (single multi-line edit to drop both StateDirectory + LogsDirectory + the comment block above them):
  old:
    # Writable storage — systemd creates these under /var/lib/private/
    # and /var/log/private/ with the DynamicUser as owner, then mounts
    # them at the standard paths inside the unit's namespace.
    StateDirectory=xinas-api
    LogsDirectory=xinas-api
  new:
    # Writable storage — the xinas_api Ansible role pre-creates
    # /var/lib/xinas/state and /var/log/xinas as root:xinas-admin
    # 0770 via /usr/lib/tmpfiles.d/xinas-api.conf. ReadWritePaths
    # grants the DynamicUser write access under ProtectSystem=strict.
    ReadWritePaths=/var/lib/xinas/state /var/log/xinas
```

```
Edit #3 (drop RuntimeDirectory directives + their explanatory comment):
  old:
    # Group that may connect to the UDS at /run/xinas/api.sock. The
    # Ansible role creates the xinas-admin group and adds operators to
    # it; the server.ts chmods the socket to 0660 root:xinas-admin.
    # For the skeleton, the unit doesn't create the group — the role does.
    RuntimeDirectory=xinas
    RuntimeDirectoryMode=0750
  new:
    # /run/xinas is created by the xinas_api Ansible role's tmpfiles.d
    # entry as root:xinas-admin 0750 (NOT via RuntimeDirectory, which
    # under DynamicUser would assign ownership to the transient uid and
    # block xinas-admin traversal). systemd-tmpfiles-setup.service
    # recreates it on every boot.
```

- [ ] **Step 3: Verify the unit reads as expected**

Run: `grep -nE "^[A-Z]|^#" xiNAS-MCP/xinas-api.service | head -50`

Expected: ExecStart now points at `/opt/xiNAS/xiNAS-MCP/dist/api-server.js`; no `StateDirectory=` or `LogsDirectory=` or `RuntimeDirectory=` lines anywhere; `ReadWritePaths=/var/lib/xinas/state /var/log/xinas` present. `SupplementaryGroups=xinas-admin`, `DynamicUser=yes`, the hardening directives all still there.

- [ ] **Step 4: Verify no test regression**

Run: `cd xiNAS-MCP && npm test 2>&1 | tail -4`

Expected: `Test Files  32 passed (32)`, `Tests  176 passed (176)`. The unit file isn't exercised by vitest (it's only loaded by systemd), but a sanity full-suite run catches any accidental other change.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/xinas-api.service
git commit -m "$(cat <<'EOF'
fix(api): align xinas-api.service with ADR-0002/0003 + role-managed dirs

Four fixes the spec at docs/Installer/xinas-api-role-spec.md
called out:

  ExecStart   /opt/xinas-mcp/...    -> /opt/xiNAS/xiNAS-MCP/...
              (the original path existed nowhere)

  StateDirectory=xinas-api       -> dropped
  LogsDirectory=xinas-api        -> dropped
              (created /var/lib/xinas-api which contradicted
               ADR-0003's canonical /var/lib/xinas/state)

  ReadWritePaths=/var/lib/xinas/state /var/log/xinas   -> added
              (without this, ProtectSystem=strict makes SQLite
               open and audit JSONL writes fail with EROFS)

  RuntimeDirectory=xinas         -> dropped
  RuntimeDirectoryMode=0750      -> dropped
              (under DynamicUser these created /run/xinas owned by
               the transient uid, blocking xinas-admin traversal to
               reach the socket)

The xinas_api Ansible role (next commits in this PR) pre-creates
/run/xinas, /var/lib/xinas/state, and /var/log/xinas as root:xinas-admin
via /usr/lib/tmpfiles.d/xinas-api.conf, satisfying all three writable
paths the unit needs.

Requires-Rebuild: xinas_api

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Role scaffold (empty directory tree)

**Files:**
- Create: `collection/roles/xinas_api/defaults/.gitkeep`
- Create: `collection/roles/xinas_api/handlers/.gitkeep`
- Create: `collection/roles/xinas_api/tasks/.gitkeep`
- Create: `collection/roles/xinas_api/templates/.gitkeep`

Empty directories aren't tracked by git; the gitkeep files keep the tree visible. They'll be replaced as each subsequent task fills the real files.

- [ ] **Step 1: Create the four subdirectories**

```bash
mkdir -p collection/roles/xinas_api/defaults \
         collection/roles/xinas_api/handlers \
         collection/roles/xinas_api/tasks \
         collection/roles/xinas_api/templates
```

- [ ] **Step 2: Drop placeholder files so git tracks the tree**

```bash
touch collection/roles/xinas_api/defaults/.gitkeep
touch collection/roles/xinas_api/handlers/.gitkeep
touch collection/roles/xinas_api/tasks/.gitkeep
touch collection/roles/xinas_api/templates/.gitkeep
```

- [ ] **Step 3: Verify**

Run: `find collection/roles/xinas_api -type f -o -type d | sort`

Expected:
```
collection/roles/xinas_api
collection/roles/xinas_api/defaults
collection/roles/xinas_api/defaults/.gitkeep
collection/roles/xinas_api/handlers
collection/roles/xinas_api/handlers/.gitkeep
collection/roles/xinas_api/tasks
collection/roles/xinas_api/tasks/.gitkeep
collection/roles/xinas_api/templates
collection/roles/xinas_api/templates/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/
git commit -m "$(cat <<'EOF'
chore(xinas_api): scaffold role directory tree

Empty role skeleton ahead of the defaults/handlers/tasks/templates
files added in the next commits. gitkeep stubs keep the tree visible
in git; they're overwritten as each real file lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: defaults/main.yml — all role variables

**Files:**
- Create: `collection/roles/xinas_api/defaults/main.yml`
- Delete: `collection/roles/xinas_api/defaults/.gitkeep`

- [ ] **Step 1: Write the defaults file**

Replace `collection/roles/xinas_api/defaults/.gitkeep` with `collection/roles/xinas_api/defaults/main.yml` containing:

```yaml
---
# xinas_api role defaults — Phase 0 installer.
# Spec: docs/Installer/xinas-api-role-spec.md

# Source tree where the Node app is built (must match xinas_mcp_repo_path).
xinas_api_repo_path: /opt/xiNAS/xiNAS-MCP

# On-disk config + secret directory.
xinas_api_config_dir: /etc/xinas-api

# Canonical Phase 0 state + audit paths (per ADR-0003 §State store and
# §Audit semantics). xinas-api is the sole writer of both per ADR-0002
# — the future xinas-agent reports observations via the API's
# /internal/v1/observed endpoint, not by writing these files directly.
# The directories are pre-created by tmpfiles.d at install + boot
# (DynamicUser's transient uid can't own a persistent dir); group-write
# to xinas-admin is how the api process gains write access via its
# SupplementaryGroups membership.
xinas_api_state_dir: /var/lib/xinas/state
xinas_api_log_dir:   /var/log/xinas

# Unix-domain socket path. The parent directory /run/xinas is created
# by the role's tmpfiles.d entry as root:xinas-admin 0750 so operators
# in xinas-admin can traverse it; the socket file itself is chmod 0660
# + chown :{{ xinas_api_socket_group }} by server.ts after binding.
xinas_api_socket: /run/xinas/api.sock

# Group that owns the UDS file (gid resolved at template time via
# getent). The same name is used to create the group (task 2 of the
# role's tasks/main.yml), to stamp the socket file, and to own the
# role-managed directories.
#
# Phase 0 caveat: the systemd unit shipped in xiNAS-MCP/xinas-api.service
# hardcodes `SupplementaryGroups=xinas-admin`. Overriding this variable
# alone is NOT enough — you must also patch the unit (or ship your own
# drop-in at /etc/systemd/system/xinas-api.service.d/) so the dynamic
# user gains membership in your replacement group. The variable exists
# for naming consistency across the role's tasks; full override support
# lands when the unit is templated.
xinas_api_socket_group: xinas-admin

# Per-controller identity. UUIDv5 derivation from machine-id gives a
# stable UUID-shaped string without an extra on-disk file. Operators
# can override if they have a pre-assigned controller_id from a
# control-plane registry.
xinas_api_controller_id: "{{ ansible_machine_id | to_uuid }}"
```

- [ ] **Step 2: Remove the gitkeep stub**

```bash
rm collection/roles/xinas_api/defaults/.gitkeep
```

- [ ] **Step 3: Verify with ansible-lint**

Run: `ansible-lint collection/roles/xinas_api/defaults/main.yml 2>&1 | tail -10`

Expected: either no output, or `Passed: 0 failure(s), 0 warning(s)`. Any failure stops the task; fix and rerun.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/defaults/
git commit -m "$(cat <<'EOF'
feat(xinas_api): add role defaults

Six variables per the spec at docs/Installer/xinas-api-role-spec.md:
xinas_api_repo_path, xinas_api_config_dir, xinas_api_state_dir,
xinas_api_log_dir, xinas_api_socket, xinas_api_socket_group, and
xinas_api_controller_id. Defaults match ADR-0003 canonical paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: handlers/main.yml — reload + restart

**Files:**
- Create: `collection/roles/xinas_api/handlers/main.yml`
- Delete: `collection/roles/xinas_api/handlers/.gitkeep`

- [ ] **Step 1: Write the handlers file**

```yaml
---
# xinas_api role handlers.

- name: reload systemd
  ansible.builtin.systemd:
    daemon_reload: true

- name: restart xinas-api
  ansible.builtin.service:
    name: xinas-api
    state: restarted
```

- [ ] **Step 2: Remove the gitkeep stub**

```bash
rm collection/roles/xinas_api/handlers/.gitkeep
```

- [ ] **Step 3: Verify**

Run: `ansible-lint collection/roles/xinas_api/handlers/main.yml 2>&1 | tail -5`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/handlers/
git commit -m "$(cat <<'EOF'
feat(xinas_api): add reload-systemd + restart-xinas-api handlers

Standard handler pair matching the xinas_mcp role pattern. The
config-template and unit-install tasks notify restart xinas-api;
the unit-install task also notifies reload systemd via the
flush_handlers meta-task to ensure daemon-reload runs before
enable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: templates/xinas-api-tmpfiles.conf.j2

**Files:**
- Create: `collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2`

- [ ] **Step 1: Write the tmpfiles snippet template**

```
# /usr/lib/tmpfiles.d/xinas-api.conf
# Managed by the xiNAS xinas_api Ansible role. Do not edit by hand.
#
# Type 'd': create directory if absent; on every systemd-tmpfiles run,
# fix owner/group/mode if drifted. Created on install via
# `systemd-tmpfiles --create` and on every boot via
# systemd-tmpfiles-setup.service.
#
# /run/xinas is on tmpfs and MUST be recreated each boot. The
# persistent state + log dirs use the same mechanism for owner/mode
# consistency.

d /run/xinas             0750 root {{ xinas_api_socket_group }} -
d /var/lib/xinas         0755 root root          -
d {{ xinas_api_state_dir }}   0770 root {{ xinas_api_socket_group }} -
d {{ xinas_api_log_dir }}     0770 root {{ xinas_api_socket_group }} -
```

- [ ] **Step 2: Verify the template syntax**

Run: `python3 -c "from jinja2 import Template; Template(open('collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2').read()).render(xinas_api_socket_group='xinas-admin', xinas_api_state_dir='/var/lib/xinas/state', xinas_api_log_dir='/var/log/xinas')"`

Expected: no output on success (the render is to /dev/null). Any Jinja parse error fails fast.

- [ ] **Step 3: Verify rendered output is well-formed tmpfiles syntax**

Run: `python3 -c "
from jinja2 import Template
out = Template(open('collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2').read()).render(
    xinas_api_socket_group='xinas-admin',
    xinas_api_state_dir='/var/lib/xinas/state',
    xinas_api_log_dir='/var/log/xinas',
)
print(out)
"`

Expected: four `d` lines, no leading whitespace, exactly the columns: type, path, mode, uid, gid, age. Comments preserved.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2
git commit -m "$(cat <<'EOF'
feat(xinas_api): add tmpfiles.d template for run/state/log dirs

Four `d` entries: /run/xinas (tmpfs, recreated each boot),
/var/lib/xinas (intermediate root:root 0755), the configurable
state dir as root:xinas-admin 0770, and the log dir likewise.
Substitutes xinas_api_socket_group, xinas_api_state_dir, and
xinas_api_log_dir from role vars so site overrides cascade.

The four directories are exactly the writable paths the unit's
ReadWritePaths line names, so the api can open SQLite + write
audit JSONL under ProtectSystem=strict.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: templates/xinas-api-config.json.j2

**Files:**
- Create: `collection/roles/xinas_api/templates/xinas-api-config.json.j2`

- [ ] **Step 1: Write the config template**

```json
{
  "controller_id": "{{ xinas_api_controller_id }}",
  "listen": {
    "kind": "unix",
    "socket": "{{ xinas_api_socket }}",
    "socketGroup": {{ _xinas_admin_gid }}
  },
  "tokens": {
    "{{ _xinas_api_admin_token }}": {
      "principal": "admin:bootstrap",
      "role": "admin"
    }
  },
  "state": {
    "databasePath": "{{ xinas_api_state_dir }}/xinas.db",
    "auditJsonlPath": "{{ xinas_api_log_dir }}/audit.jsonl",
    "archiveDir": "{{ xinas_api_state_dir }}/archive"
  }
}
```

Naming convention: variables prefixed `_` are role-internal facts set by tasks (not part of the role's public interface). `_xinas_admin_gid` comes from the getent lookup; `_xinas_api_admin_token` is either freshly generated or slurped from an existing config.

- [ ] **Step 2: Verify the template renders to valid JSON**

Run: `python3 -c "
import json
from jinja2 import Template
out = Template(open('collection/roles/xinas_api/templates/xinas-api-config.json.j2').read()).render(
    xinas_api_controller_id='00000000-0000-0000-0000-0000000000aa',
    xinas_api_socket='/run/xinas/api.sock',
    _xinas_admin_gid=985,
    _xinas_api_admin_token='deadbeef' * 8,
    xinas_api_state_dir='/var/lib/xinas/state',
    xinas_api_log_dir='/var/log/xinas',
)
parsed = json.loads(out)
print('OK:', parsed['controller_id'], parsed['listen']['socketGroup'])
"`

Expected: `OK: 00000000-0000-0000-0000-0000000000aa 985`. Any JSON parse failure means the template is broken — fix and re-run.

- [ ] **Step 3: Verify the rendered config matches the API's ApiConfig type**

Run: `cd xiNAS-MCP && cat > /tmp/sample-config.json <<'EOF'
{
  "controller_id": "00000000-0000-0000-0000-0000000000aa",
  "listen": { "kind": "unix", "socket": "/run/xinas/api.sock", "socketGroup": 985 },
  "tokens": { "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": { "principal": "admin:bootstrap", "role": "admin" } },
  "state": { "databasePath": "/var/lib/xinas/state/xinas.db", "auditJsonlPath": "/var/log/xinas/audit.jsonl", "archiveDir": "/var/lib/xinas/state/archive" }
}
EOF
npx tsx -e "import {loadConfig} from './src/api/config.js'; const c = loadConfig({configPath:'/tmp/sample-config.json'}); console.log('parsed OK', c.controller_id, c.listen);"`

Expected: `parsed OK 00000000-0000-0000-0000-0000000000aa { kind: 'unix', socket: '/run/xinas/api.sock', socketGroup: 985 }`. Any TS error means the template generates a shape `ApiConfig` rejects — fix the template.

Cleanup: `rm /tmp/sample-config.json`

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/templates/xinas-api-config.json.j2
git commit -m "$(cat <<'EOF'
feat(xinas_api): add config.json template

Mirrors the ApiConfig shape in xiNAS-MCP/src/api/config.ts:
controller_id, listen.{kind,socket,socketGroup}, tokens map keyed
by the bootstrap admin bearer, state.{databasePath,auditJsonlPath,
archiveDir}. _xinas_admin_gid and _xinas_api_admin_token are
role-internal facts populated by tasks/main.yml (next commit).

Verified locally by loading a rendered sample through loadConfig()
— the template's output type-checks against the api's config loader.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: tasks/main.yml part A — preflight + group + dirs

**Files:**
- Create: `collection/roles/xinas_api/tasks/main.yml`
- Delete: `collection/roles/xinas_api/tasks/.gitkeep`

The full `tasks/main.yml` is built up across three tasks (7, 8, 9). This one lands the first six steps: pre-flight stat, group create, gid lookup, config dir, tmpfiles install, systemd-tmpfiles --create.

- [ ] **Step 1: Write the initial tasks/main.yml**

Replace `collection/roles/xinas_api/tasks/.gitkeep` with `collection/roles/xinas_api/tasks/main.yml`:

```yaml
---
# xinas_api role — Phase 0 installer.
# Spec: docs/Installer/xinas-api-role-spec.md

# 1. Pre-flight: the xinas-mcp build artifacts must exist. The role
#    deliberately does NOT meta-depend on xinas_mcp (which would
#    drag in the MCP daemon, Claude config, SSE transport). The
#    operator runs xinas_mcp first; this task fails fast with an
#    actionable message if they haven't.
- name: Pre-flight — verify xinas-mcp build artifacts are present
  ansible.builtin.stat:
    path: "{{ xinas_api_repo_path }}/dist/api-server.js"
  register: _xinas_api_build_stat
  tags: [xinas_api]

- name: Fail with actionable message when build artifacts are missing
  ansible.builtin.fail:
    msg: |
      xinas_api requires xinas-mcp build artifacts at
      {{ xinas_api_repo_path }}/dist/api-server.js, which were not
      found. Run the xinas_mcp role first — either include it in
      the same playbook above xinas_api, or invoke it directly via
      `ansible-playbook playbooks/site.yml --tags xinas_mcp`.
  when: not _xinas_api_build_stat.stat.exists
  tags: [xinas_api]

# 2. Create the admin group (no-op if it already exists). gid is
#    system-assigned; we look it up in the next step.
- name: Create the {{ xinas_api_socket_group }} group
  ansible.builtin.group:
    name: "{{ xinas_api_socket_group }}"
    state: present
  tags: [xinas_api, group]

# 3. Look up the gid. getent always returns the gid as the third
#    colon-separated field; we register the whole row and parse it
#    in the next step.
- name: Look up {{ xinas_api_socket_group }} gid
  ansible.builtin.getent:
    database: group
    key: "{{ xinas_api_socket_group }}"
  tags: [xinas_api, group]

- name: Cache the looked-up gid as _xinas_admin_gid
  ansible.builtin.set_fact:
    _xinas_admin_gid: "{{ ansible_facts.getent_group[xinas_api_socket_group][1] | int }}"
  tags: [xinas_api, group]

# 4. /etc/xinas-api/ — root:xinas-admin 0750. The DynamicUser+SupplementaryGroups
#    api process gets read access via group membership.
- name: Create config directory {{ xinas_api_config_dir }}
  ansible.builtin.file:
    path: "{{ xinas_api_config_dir }}"
    state: directory
    owner: root
    group: "{{ xinas_api_socket_group }}"
    mode: '0750'
  tags: [xinas_api, config]

# 5. Install the tmpfiles.d snippet. systemd-tmpfiles-setup.service
#    re-runs this on every boot; we run it once at install time below
#    so the dirs exist before the service starts.
- name: Install /usr/lib/tmpfiles.d/xinas-api.conf
  ansible.builtin.template:
    src: xinas-api-tmpfiles.conf.j2
    dest: /usr/lib/tmpfiles.d/xinas-api.conf
    owner: root
    group: root
    mode: '0644'
  tags: [xinas_api, tmpfiles]

# 6. Run systemd-tmpfiles once at install so /run/xinas,
#    /var/lib/xinas/state, /var/log/xinas all exist before the unit
#    starts. changed_when is unconditional: --create is itself
#    idempotent (it adjusts perms in place) but Ansible can't tell
#    whether anything actually changed.
- name: Run systemd-tmpfiles to materialize the dirs
  ansible.builtin.command:
    cmd: systemd-tmpfiles --create /usr/lib/tmpfiles.d/xinas-api.conf
  changed_when: false
  tags: [xinas_api, tmpfiles]
```

- [ ] **Step 2: Remove the gitkeep stub**

```bash
rm collection/roles/xinas_api/tasks/.gitkeep
```

- [ ] **Step 3: Verify with ansible-lint**

Run: `ansible-lint collection/roles/xinas_api/ 2>&1 | tail -10`

Expected: `Passed: 0 failure(s)`. Warnings are tolerable; failures must be fixed before commit.

- [ ] **Step 4: Verify with --syntax-check**

Create a throwaway test playbook to give --syntax-check something to chew on:

```bash
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -5
rm /tmp/test-xinas-api.yml
```

Expected: `playbook: /tmp/test-xinas-api.yml` (success). Any syntax error means the YAML or task structure is broken.

- [ ] **Step 5: Commit**

```bash
git add collection/roles/xinas_api/tasks/
git commit -m "$(cat <<'EOF'
feat(xinas_api): tasks/main.yml part A — preflight, group, dirs, tmpfiles

Six tasks land the role's structural setup:

  1. stat /opt/xiNAS/xiNAS-MCP/dist/api-server.js + fail with
     an actionable message if the xinas-mcp build hasn't run yet
  2. create the xinas-admin group (no fixed gid)
  3-4. getent lookup of the gid, cached as _xinas_admin_gid fact
       for the config template
  5. create /etc/xinas-api/ as root:xinas-admin 0750
  6. install /usr/lib/tmpfiles.d/xinas-api.conf + run
     systemd-tmpfiles --create so /run/xinas, /var/lib/xinas/state,
     and /var/log/xinas exist before the unit starts

The token + config bootstrap (part B) and unit install + enable
(part C) land in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: tasks/main.yml part B — token + config bootstrap

**Files:**
- Modify: `collection/roles/xinas_api/tasks/main.yml` (append)

This is the trickiest task. The config.json is the source of truth for the bootstrap token; the `/etc/xinas-api/admin-token` file is a mirror of whatever's in config. The bootstrap branch (first install) generates a fresh token, templates config, writes the mirror. The derive branch (config already exists) slurps config, finds the entry with `principal: admin:bootstrap`, refreshes the mirror.

All token-handling tasks use `no_log: true`.

- [ ] **Step 1: Append the bootstrap block to tasks/main.yml**

Append to `collection/roles/xinas_api/tasks/main.yml`:

```yaml

# 7. Token + config bootstrap.
#
# Lifecycle: config.json is the source of truth. admin-token is a
# mirror operators can `cat` for remote tooling. Deleting just the
# admin-token file re-derives it from config on the next run.
# Deleting both forces a fresh token (rotation procedure).

- name: stat {{ xinas_api_config_dir }}/config.json
  ansible.builtin.stat:
    path: "{{ xinas_api_config_dir }}/config.json"
  register: _xinas_api_config_stat
  tags: [xinas_api, config]

# --- Bootstrap branch: config absent ---

- name: Generate a fresh admin bearer token (first install only)
  ansible.builtin.command:
    cmd: openssl rand -hex 32
  register: _xinas_api_token_gen
  changed_when: true
  no_log: true
  when: not _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

- name: Cache the generated token as _xinas_api_admin_token (first install)
  ansible.builtin.set_fact:
    _xinas_api_admin_token: "{{ _xinas_api_token_gen.stdout }}"
  no_log: true
  when: not _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

- name: Template config.json with the fresh token (first install)
  ansible.builtin.template:
    src: xinas-api-config.json.j2
    dest: "{{ xinas_api_config_dir }}/config.json"
    owner: root
    group: "{{ xinas_api_socket_group }}"
    mode: '0640'
    force: true
  no_log: true
  notify: restart xinas-api
  when: not _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

# --- Derive branch: config present, mirror the existing token ---

- name: Slurp existing config.json to extract the bootstrap token
  ansible.builtin.slurp:
    src: "{{ xinas_api_config_dir }}/config.json"
  register: _xinas_api_config_blob
  no_log: true
  when: _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

- name: Decode + parse existing config.json
  ansible.builtin.set_fact:
    _xinas_api_config_parsed: "{{ _xinas_api_config_blob.content | b64decode | from_json }}"
  no_log: true
  when: _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

- name: Find the entry with principal 'admin:bootstrap'
  ansible.builtin.set_fact:
    _xinas_api_admin_token: >-
      {{ (_xinas_api_config_parsed.tokens
           | dict2items
           | selectattr('value.principal', 'equalto', 'admin:bootstrap')
           | map(attribute='key')
           | list
           | first)
         | default(None) }}
  no_log: true
  when: _xinas_api_config_stat.stat.exists
  tags: [xinas_api, config]

- name: Fail if config exists but bootstrap token is missing (operator removed it)
  ansible.builtin.fail:
    msg: |
      {{ xinas_api_config_dir }}/config.json exists but its tokens
      map has no entry with principal 'admin:bootstrap'. This role
      mirrors only the bootstrap token to admin-token; it won't
      guess which other token to expose. To recover: delete both
      {{ xinas_api_config_dir }}/config.json and
      {{ xinas_api_config_dir }}/admin-token and re-run the role
      (rotation procedure). To keep the existing config, re-add the
      bootstrap entry by hand.
  when:
    - _xinas_api_config_stat.stat.exists
    - _xinas_api_admin_token is none
  tags: [xinas_api, config]

# --- Both branches converge here: write/refresh admin-token mirror ---

- name: Write/refresh {{ xinas_api_config_dir }}/admin-token
  ansible.builtin.copy:
    content: "{{ _xinas_api_admin_token }}\n"
    dest: "{{ xinas_api_config_dir }}/admin-token"
    owner: root
    group: "{{ xinas_api_socket_group }}"
    mode: '0640'
  no_log: true
  tags: [xinas_api, config]
```

- [ ] **Step 2: Verify ansible-lint**

Run: `ansible-lint collection/roles/xinas_api/ 2>&1 | tail -10`

Expected: clean (no `risky-shell-pipe`, no `command-instead-of-shell` issues — we used `command` with a single binary + args, no pipes).

- [ ] **Step 3: Verify --syntax-check**

```bash
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -5
rm /tmp/test-xinas-api.yml
```

Expected: `playbook: /tmp/test-xinas-api.yml`.

- [ ] **Step 4: Dry-run the parse + filter logic on a sample config**

Run a one-shot ansible task locally to verify the dict2items / selectattr filter chain finds the right entry:

```bash
ansible localhost -m debug -a "msg={{ ({'tokens': {'abc123': {'principal': 'admin:bootstrap', 'role': 'admin'}, 'def456': {'principal': 'operator:alice', 'role': 'operator'}}}.tokens | dict2items | selectattr('value.principal', 'equalto', 'admin:bootstrap') | map(attribute='key') | list | first) }}" 2>&1 | tail -5
```

Expected: `"msg": "abc123"` — confirms the filter picks out the admin:bootstrap entry by principal.

- [ ] **Step 5: Commit**

```bash
git add collection/roles/xinas_api/tasks/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_api): tasks/main.yml part B — token + config bootstrap

Conditional flow:

  config.json absent (first install):
    - openssl rand -hex 32 generates a 256-bit token
    - template config.json with the token, force: true
    - notify restart xinas-api

  config.json present:
    - slurp + parse it
    - find the entry with principal 'admin:bootstrap'
    - fail with an actionable message if none (operator removed it)

  both branches converge:
    - write/refresh /etc/xinas-api/admin-token as a mirror of the
      bootstrap token, mode 0640 root:xinas-admin

This makes config.json the single source of truth. Deleting only
the admin-token file re-derives it from config (no service restart);
deleting both files is the documented rotation procedure.

All token-touching tasks use no_log: true so the secret never lands
in Ansible's structured output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: tasks/main.yml part C — unit install + enable

**Files:**
- Modify: `collection/roles/xinas_api/tasks/main.yml` (append)

- [ ] **Step 1: Append the unit-install + enable block**

```yaml

# 8. Install the systemd unit verbatim from the source tree. Triggers
#    'reload systemd' (via flush_handlers before enable) and 'restart
#    xinas-api' (covered by config notification too).
- name: Install /etc/systemd/system/xinas-api.service
  ansible.builtin.copy:
    src: "{{ xinas_api_repo_path }}/xinas-api.service"
    dest: /etc/systemd/system/xinas-api.service
    owner: root
    group: root
    mode: '0644'
    remote_src: true
  notify:
    - reload systemd
    - restart xinas-api
  tags: [xinas_api, service]

# 9. Force daemon-reload before enable so systemd picks up the new
#    unit. Without this, the next `service` task can race the reload
#    and fail with "Unit xinas-api.service not found."
- name: Force systemd daemon-reload before enable
  ansible.builtin.meta: flush_handlers
  tags: [xinas_api, service]

# 10. Enable + start. Idempotent.
- name: Enable and start xinas-api
  ansible.builtin.service:
    name: xinas-api
    enabled: true
    state: started
  tags: [xinas_api, service]
```

- [ ] **Step 2: Verify ansible-lint**

Run: `ansible-lint collection/roles/xinas_api/ 2>&1 | tail -10`

Expected: clean.

- [ ] **Step 3: Verify --syntax-check**

```bash
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -5
rm /tmp/test-xinas-api.yml
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/tasks/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_api): tasks/main.yml part C — unit install + enable

Three tasks complete the role:

  - copy xiNAS-MCP/xinas-api.service to /etc/systemd/system/
    (remote_src: true so it reads from the controller's filesystem),
    notifying reload systemd + restart xinas-api
  - meta: flush_handlers to force daemon-reload before enable
    (without this, the service task can race the reload)
  - enable + start xinas-api

After this commit, tasks/main.yml is the full ten-step sequence
from the spec. README + sanity checks land next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: README.md — role documentation

**Files:**
- Create: `collection/roles/xinas_api/README.md`

- [ ] **Step 1: Write the README**

```markdown
# `xinas_api` role

Phase 0 installer for the `xinas-api` REST service introduced by PR #201.
Deploys the unit, the runtime config, the bootstrap admin bearer token,
and the filesystem/group plumbing it depends on.

**Spec:** [docs/Installer/xinas-api-role-spec.md](../../../docs/Installer/xinas-api-role-spec.md).

## What this role does

- Creates the `xinas-admin` Unix group (system-assigned gid).
- Pre-creates `/run/xinas/`, `/var/lib/xinas/state/`, and `/var/log/xinas/`
  via `/usr/lib/tmpfiles.d/xinas-api.conf` as `root:xinas-admin 0770/0750`.
- Templates `/etc/xinas-api/config.json` with a fresh 256-bit admin
  bearer token (first install) or with the existing token (re-run).
- Writes `/etc/xinas-api/admin-token` as a mirror of the bootstrap
  token, mode `0640 root:xinas-admin`, so operators can `cat` it.
- Installs `/etc/systemd/system/xinas-api.service` from the source tree.
- Enables + starts the service.

## What this role does NOT do

- It is **opt-in** — not wired into `playbooks/site.yml`. Operators
  add `- role: xinas_api` to their own playbook.
- No `xinas_uninstall` symmetric cleanup hook (separate small PR later).
- No Node.js install or TypeScript build — see "Pre-flight" below.
- No TCP listener (UDS-only by default).
- No automated token rotation — see "Rotation" below.

## Pre-flight

The role expects `xinas-mcp`'s build artifacts at
`/opt/xiNAS/xiNAS-MCP/dist/api-server.js`. If absent, it fails fast
with an actionable message. To satisfy:

```bash
ansible-playbook playbooks/site.yml --tags xinas_mcp
```

(or include the `xinas_mcp` role above `xinas_api` in your playbook —
but be aware that runs the MCP daemon, Claude Code config, SSE transport,
etc., not just the build).

## Role variables

See `defaults/main.yml`. Highlights:

| Variable | Default | Notes |
|---|---|---|
| `xinas_api_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Must match `xinas_mcp_repo_path`. |
| `xinas_api_config_dir` | `/etc/xinas-api` | Holds `config.json` + `admin-token`. |
| `xinas_api_state_dir` | `/var/lib/xinas/state` | SQLite + WAL + archive. Per ADR-0003. |
| `xinas_api_log_dir` | `/var/log/xinas` | Audit JSONL. Per ADR-0003. |
| `xinas_api_socket` | `/run/xinas/api.sock` | Unix-domain socket. |
| `xinas_api_socket_group` | `xinas-admin` | **See Phase 0 caveat in defaults comment** — also referenced by the unit's hardcoded `SupplementaryGroups`. |
| `xinas_api_controller_id` | `{{ ansible_machine_id \| to_uuid }}` | UUIDv5 derivation; override for pre-assigned IDs. |

## Example play

```yaml
- hosts: storage-controllers
  become: true
  tasks:
    - name: Ensure xinas-mcp build artifacts are present
      ansible.builtin.import_role:
        name: xinas_mcp
      tags: [xinas_mcp]

    - name: Deploy xinas-api
      ansible.builtin.import_role:
        name: xinas_api
      tags: [xinas_api]
```

## Verifying a successful install

```bash
# Service running:
systemctl is-active xinas-api    # expect: active

# Socket exists with correct perms (owner is the systemd DynamicUser):
ls -l /run/xinas/api.sock        # expect: srw-rw---- <dyn-user> xinas-admin

# UDS health probe as an xinas-admin member (no token needed over UDS):
sudo -u $USER -g xinas-admin curl --unix-socket /run/xinas/api.sock \
  http://localhost/api/v1/health
# expect: {"request_id":"...","result":{"overall":"ok",...},...}

# Same probe with the bootstrap bearer (still over UDS for now):
TOKEN=$(sudo cat /etc/xinas-api/admin-token)
curl --unix-socket /run/xinas/api.sock \
     -H "Authorization: Bearer $TOKEN" \
     http://localhost/api/v1/health
```

## Adding an operator to xinas-admin

The role creates the group but does NOT add users. To grant operator
access:

```bash
sudo usermod -aG xinas-admin <operator-username>
# Operator must log out + back in for the new group to take effect.
```

## Rotation

There is no automated rotation in Phase 0. To rotate:

1. `sudo systemctl stop xinas-api`
2. `sudo rm /etc/xinas-api/config.json /etc/xinas-api/admin-token`
3. Re-run your playbook: `ansible-playbook <your playbook> --tags xinas_api`
4. New token is at `/etc/xinas-api/admin-token`; service restart fires
   via the role's handler chain.

A future workstream (auth.RotateToken + RBAC delivery) will replace
this with a runtime API call that swaps the token without a restart.

## Tags

| Tag | Selects |
|---|---|
| `xinas_api` | All tasks. |
| `group` | Group create + gid lookup. |
| `config` | Dirs, tmpfiles, token + config bootstrap. |
| `tmpfiles` | tmpfiles.d template + systemd-tmpfiles run. |
| `service` | Unit install + enable + start. |
```

- [ ] **Step 2: Verify with markdownlint (warn-only gate but worth checking)**

Run: `npx --yes markdownlint-cli2 collection/roles/xinas_api/README.md 2>&1 | tail -5`

Expected: minor stylistic warnings are tolerable (the gate is warn-only); structural errors (broken tables, malformed code blocks) must be fixed.

- [ ] **Step 3: Commit**

```bash
git add collection/roles/xinas_api/README.md
git commit -m "$(cat <<'EOF'
docs(xinas_api): add role README

Covers what the role does, what it doesn't, the pre-flight
dependency on xinas_mcp build artifacts, role variables, an
example play, post-install verification commands, the
xinas-admin membership procedure for operators, and the manual
rotation procedure. Tags table maps the standard --tags arguments
operators reach for.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Whole-role sanity check

**Files:**
- (none — verification only)

- [ ] **Step 1: Full role lint**

Run: `ansible-lint collection/roles/xinas_api/ 2>&1 | tail -15`

Expected: `Passed: 0 failure(s)`. Any failure stops the task — investigate.

- [ ] **Step 2: Syntax-check via a test playbook**

```bash
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -5
rm /tmp/test-xinas-api.yml
```

Expected: `playbook: /tmp/test-xinas-api.yml` (no syntax errors).

- [ ] **Step 3: Inspect the file tree**

Run: `find collection/roles/xinas_api -type f | sort`

Expected:
```
collection/roles/xinas_api/README.md
collection/roles/xinas_api/defaults/main.yml
collection/roles/xinas_api/handlers/main.yml
collection/roles/xinas_api/tasks/main.yml
collection/roles/xinas_api/templates/xinas-api-config.json.j2
collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2
```

Six files, no stray gitkeep stubs, no `meta/main.yml`.

- [ ] **Step 4: Verify the source-tree unit still has all the expected directives**

Run:
```bash
grep -cE "^(ExecStart|DynamicUser|SupplementaryGroups|ProtectSystem|ReadWritePaths|CapabilityBoundingSet)=" xiNAS-MCP/xinas-api.service
```

Expected: `6` (one match per directive). If any are missing, Task 1 has a regression.

Run:
```bash
grep -cE "^(StateDirectory|LogsDirectory|RuntimeDirectory)" xiNAS-MCP/xinas-api.service
```

Expected: `0`. If any are present, Task 1 had an incomplete edit.

- [ ] **Step 5: Verify the rendered config still type-checks against ApiConfig**

(Same check as Task 6 Step 3, repeated here to catch any later regression in the template.)

```bash
cat > /tmp/sample-config.json <<'EOF'
{
  "controller_id": "00000000-0000-0000-0000-0000000000aa",
  "listen": { "kind": "unix", "socket": "/run/xinas/api.sock", "socketGroup": 985 },
  "tokens": { "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef": { "principal": "admin:bootstrap", "role": "admin" } },
  "state": { "databasePath": "/var/lib/xinas/state/xinas.db", "auditJsonlPath": "/var/log/xinas/audit.jsonl", "archiveDir": "/var/lib/xinas/state/archive" }
}
EOF
cd xiNAS-MCP && npx tsx -e "import {loadConfig} from './src/api/config.js'; const c = loadConfig({configPath:'/tmp/sample-config.json'}); console.log('parsed OK', c.controller_id, c.listen);" && cd ..
rm /tmp/sample-config.json
```

Expected: `parsed OK 00000000-0000-0000-0000-0000000000aa { kind: 'unix', socket: '/run/xinas/api.sock', socketGroup: 985 }`.

- [ ] **Step 6: No commit needed** (verification only).

If anything fails, fix in the task it came from and re-run this sanity task before moving on.

---

## Task 12: Push + PR + watch CI + OPERATOR-GATED merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin claude/xinas-api-ansible-role 2>&1 | tail -5
```

Expected: branch creation message; the URL `https://github.com/XinnorLab/xiNAS/pull/new/...`.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head claude/xinas-api-ansible-role \
  --title "feat(installer): add xinas_api Ansible role (Phase 0)" \
  --body "$(cat <<'EOF'
## Summary

Deploys the `xinas-api` service introduced by PR #201. Opt-in role
matching the existing `xinas_mcp` shape; lands the systemd unit
config + bootstrap admin token + filesystem/group plumbing operators
need to actually reach the new REST surface.

- Source-tree fixes to `xiNAS-MCP/xinas-api.service`: correct
  ExecStart path; drop `StateDirectory`/`LogsDirectory` (contradicted
  ADR-0003 canonical paths); add `ReadWritePaths` (required under
  `ProtectSystem=strict`); drop `RuntimeDirectory=xinas` (DynamicUser
  + RuntimeDirectory left `/run/xinas` un-traversable by xinas-admin).
- New `collection/roles/xinas_api/` with defaults, handlers, two
  Jinja templates (tmpfiles snippet + config.json), full `tasks/main.yml`,
  and README.
- tmpfiles.d snippet pre-creates `/run/xinas`, `/var/lib/xinas/state`,
  `/var/log/xinas` as `root:xinas-admin` so the DynamicUser process
  can write via its `SupplementaryGroups` membership. ADR-0002 makes
  xinas-api the sole SQLite writer.
- Config bootstrap couples the lifecycle: `config.json` is the
  source of truth; `admin-token` mirrors the bootstrap-token entry.
  All token-touching tasks use `no_log: true`.
- Pre-flight check fails fast with an actionable message if
  xinas-mcp build artifacts aren't present (no implicit meta-dep).

Spec: `docs/Installer/xinas-api-role-spec.md` (committed in this PR).

## Test plan

- [x] `ansible-lint collection/roles/xinas_api/` clean
- [x] `ansible-playbook --syntax-check` against a test playbook clean
- [x] Rendered `config.json` type-checks against `ApiConfig` (loadConfig parses it)
- [x] Tmpfiles snippet renders to valid systemd-tmpfiles syntax
- [x] Token-selection filter chain returns the `admin:bootstrap` entry on a sample
- [x] Unit file still has all hardening directives + no `StateDirectory`/`RuntimeDirectory`
- [x] `npm test` 176/32 (regression check after the unit edit)
- [ ] CI green
- [ ] Operator approves merge

## What's deferred

- `playbooks/site.yml` integration (will close the rebuild-restart
  notification gap via the `Requires-Rebuild:` trailer mechanism
  when it lands)
- `xinas_uninstall` symmetric cleanup hook
- TCP listener / TLS / reverse proxy
- Automated token rotation (manual delete-both-files-and-rerun for now)
- Audit log rotation (out until WS9)
- `socketGroup` runtime override (variable is exposed; unit hardcoding
  of `SupplementaryGroups=xinas-admin` makes it Phase 0 advisory-only)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

Expected: the PR URL.

- [ ] **Step 3: Watch CI**

```bash
sleep 8
RUN=$(gh run list --branch claude/xinas-api-ansible-role --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
echo "watching run $RUN"
gh run watch $RUN --exit-status > /tmp/role-watch.out 2>&1; echo "exit=$?"
gh run view $RUN --json status,conclusion,jobs > /tmp/run.json
python3 -c "
import json
d = json.load(open('/tmp/run.json'))
print(f'overall: {d[\"status\"]}/{d[\"conclusion\"]}')
for j in sorted(d['jobs'], key=lambda x: (x['conclusion'] != 'success', x['name'])):
    print(f'  {j[\"conclusion\"] or \"...\":10s} {j[\"name\"]}')
"
```

Expected: `completed/success` overall (warn-only gates may still fail). The `ansible` job MUST pass — that's the gate that exercises this role's lint. typescript jobs should all pass (no TS changes other than the unit file, which isn't compiled).

- [ ] **Step 4: Operator gate — STOP**

Print to Sergey:

> PR #N (xinas_api role) is green. `ansible` job passes (clean lint on the new role). 8 blocking jobs pass; the same 4–5 warn-only debt jobs (markdown, python-format, python-lint, python-typecheck, yamllint) fail as documented backlog. The unit-file fix also lands in this PR; no `npm test` regression. Ready to merge via `gh pr merge N --rebase --delete-branch`. Approve?

**Do NOT proceed without explicit approval.**

- [ ] **Step 5: Merge (after approval)**

```bash
gh pr merge <N> --rebase --delete-branch 2>&1 | tail -3
gh pr view <N> --json state,mergedAt,mergeCommit
```

Expected: `state=MERGED`. The local-checkout step may fail on `'main' is already used by worktree at ...` — the server-side merge still completes; verify via `gh pr view`.

- [ ] **Step 6: Watch the post-merge CI on main**

```bash
git fetch origin main 2>&1 | tail -3
sleep 8
RUN=$(gh run list --branch main --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status > /tmp/post.out 2>&1; echo "exit=$?"
gh run view $RUN --json status,conclusion,jobs > /tmp/run.json
python3 -c "
import json
d = json.load(open('/tmp/run.json'))
print(f'overall: {d[\"status\"]}/{d[\"conclusion\"]}')
ok = sum(1 for j in d['jobs'] if j['conclusion']=='success')
fail = sum(1 for j in d['jobs'] if j['conclusion']=='failure')
print(f'jobs: success={ok} failure={fail} of {len(d[\"jobs\"])}')
"
```

Expected: `completed/success` on main; same job shape as the PR run.

---

## Self-review

**Spec coverage:**

| Spec section | Implementing task(s) |
|---|---|
| Purpose / Scope | All tasks collectively |
| Pre-flight (xinas-mcp build artifacts) | Task 7 step 1 |
| Role variables (defaults/main.yml) | Task 3 |
| Task sequence step 1 (pre-flight) | Task 7 |
| Step 2 (group create) | Task 7 |
| Step 3 (gid lookup) | Task 7 |
| Step 4 (/etc/xinas-api dir) | Task 7 |
| Step 5 (tmpfiles install) | Task 5 (template) + Task 7 (install) |
| Step 6 (systemd-tmpfiles --create) | Task 7 |
| Step 7 (token + config bootstrap) | Task 6 (template) + Task 8 (logic) |
| Step 8 (unit install) | Task 9 |
| Step 9 (daemon-reload) | Task 9 |
| Step 10 (enable + start) | Task 9 |
| Filesystem layout / perms | Task 5 (tmpfiles) + Task 7 (config dir) + Task 8 (config + token mode) |
| config.json template | Task 6 |
| Systemd unit source-tree fix | Task 1 |
| Handlers | Task 4 |
| Verification commands | Task 10 (README) |
| Failure-modes table | Task 8 (covers all the lifecycle branches) |
| Token rotation procedure | Task 10 (README) |
| Related specs / ADRs | Plan reference-spec list + Task 1 commit refs |

No spec section is uncovered.

**Placeholder scan:** No `TBD` / `TODO` / `fill in details` / `Similar to Task N` in any step. Code blocks present everywhere code is required. Exact commands with expected output throughout.

**Type consistency:**

- Variable names match exactly between defaults (Task 3), templates (Tasks 5 + 6), and tasks/main.yml (Tasks 7 + 8 + 9): `xinas_api_repo_path`, `xinas_api_config_dir`, `xinas_api_state_dir`, `xinas_api_log_dir`, `xinas_api_socket`, `xinas_api_socket_group`, `xinas_api_controller_id`.
- Internal facts named consistently with leading underscore: `_xinas_admin_gid`, `_xinas_api_admin_token`, `_xinas_api_config_stat`, `_xinas_api_config_blob`, `_xinas_api_config_parsed`, `_xinas_api_token_gen`.
- Handler names (`reload systemd`, `restart xinas-api`) match between handlers/main.yml (Task 4) and the `notify:` lines in tasks/main.yml (Tasks 8 + 9).
- ApiConfig field names (`controller_id`, `listen.kind`, `listen.socket`, `listen.socketGroup`, `tokens`, `state.databasePath`, `state.auditJsonlPath`, `state.archiveDir`) match what `xiNAS-MCP/src/api/config.ts` already accepts (verified live on main in the brainstorming round).
- ADR-0003 canonical paths (`/var/lib/xinas/state/xinas.db`, `/var/log/xinas/audit.jsonl`) appear identically across the tmpfiles template, the config template, and the unit's `ReadWritePaths`.

Ready for execution.
