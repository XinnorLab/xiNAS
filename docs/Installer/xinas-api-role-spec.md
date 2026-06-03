# `xinas_api` Ansible role — Phase 0 installer spec

## Purpose

Deploy the `xinas-api` service (REST control plane, introduced by PR #201)
onto a xiNAS controller. The role is opt-in for Phase 0 — operators add it
to their own playbook when they want the REST surface alongside the
existing MCP server. It is not wired into `playbooks/site.yml` or
`xinas_uninstall` in this iteration; both integrations are deferred to a
later PR once xinas-api becomes the primary control surface (per
ADR-0001 'Migration scope' and WS12 — MCP transport convergence).

## Scope

### In scope

- Create the `xinas-admin` Unix group and look up its system-assigned gid.
- Create the `xinas-api` Unix group (xinas-agent S0+S1 PR) — no human
  members; it is purely the agent-socket gate. The `xinas-api` user joins
  it as a supplementary member so the unit's `SupplementaryGroups=xinas-api`
  grants the running api process the group without disturbing its primary
  group (`xinas-admin`).
- Create the on-disk config directory and write `config.json` + the
  bootstrap admin bearer token.
- Generate `/var/lib/xinas/controller-id` (xinas-agent S0+S1 PR) — the
  persistent per-controller identity, replacing the machine-id derivation.
- Write the split-secret agent token store (xinas-agent S0+S1 PR):
  `/etc/xinas-api/internal-tokens.json` (api-readable) and
  `/etc/xinas-agent/agent-token` (root-only).
- Pre-create the canonical state and audit-log directories per ADR-0003.
- Install the `xinas-api.service` systemd unit shipped in the source tree.
- Enable and start the service.

### Out of scope

- **No** `playbooks/site.yml` change. Opt-in only.
- **No** `xinas_uninstall` entry. Symmetric cleanup is a separate small PR.
- **No** changes to the existing `xinas_mcp` role. Both services coexist.
- **No** Node.js install or TypeScript build — those are owned by
  `xinas_mcp` and reused via a precondition check (see "Preconditions").
- **No** TCP listener, no TLS cert, no reverse proxy — UDS-only by
  default; TCP is enabled later if/when there is a remote consumer.
- **No** token rotation tooling. Rotation is a manual operator action
  (delete config.json + token file, re-run the role); a `xinas-api token
  rotate` workflow is deferred.
- **No** operator user management. The role creates the `xinas-admin`
  group; adding operators to it (`usermod -aG xinas-admin <user>`) is
  the operator's call.

## Preconditions

The role expects the xinas-mcp build artifacts to be present at
`/opt/xiNAS/xiNAS-MCP/dist/api-server.js`. The first task is a
`stat` pre-flight check that fails fast with an actionable message if
the artifact is absent:

> *"xinas_api requires xinas-mcp build artifacts at
> `/opt/xiNAS/xiNAS-MCP/dist/api-server.js`. Run the xinas_mcp role
> first — either include it in the same playbook above `xinas_api`,
> or invoke it directly via `ansible-playbook playbooks/site.yml
> --tags xinas_mcp`."*

The role does **not** declare a `meta/main.yml` dependency on
`xinas_mcp`. That would silently run the full MCP role (including the
MCP daemon, Claude Code MCP config, SSE/HTTP transport setup) every
time someone runs xinas_api, which is far more than 'build the Node
artifacts.' The README documents the relationship; the pre-flight
check enforces it.

## Role variables (defaults/main.yml)

```yaml
# Source tree where the Node app is built (must match xinas_mcp_repo_path).
xinas_api_repo_path: /opt/xiNAS/xiNAS-MCP

# On-disk config + secret directory.
xinas_api_config_dir: /etc/xinas-api

# Canonical Phase 0 state + audit paths (per ADR-0003 §State store and
# §Audit semantics). xinas-api is the sole writer of both the SQLite
# database and the audit JSONL per ADR-0002 — the future xinas-agent
# reports observations through the API's /internal/v1/observed endpoint,
# not by writing state files directly. The directories are pre-created
# by tmpfiles.d at install + boot as xinas-api:xinas-admin 0750. The
# static system user owns the files so they persist with a stable
# owner across restarts (earlier drafts used DynamicUser=yes, but
# transient uid rotation broke write access to previously-written
# state on the next start).
xinas_api_state_dir: /var/lib/xinas/state
xinas_api_log_dir:   /var/log/xinas

# Unix-domain socket path. The parent directory /run/xinas is created
# by the role's tmpfiles.d entry as root:xinas-api 1731 (sticky). The api
# process creates api.sock via its xinas-api SUPPLEMENTARY membership, and
# the agent (root) creates agent.sock; operators (xinas-admin, NOT in
# xinas-api) can only traverse + connect — they cannot replace a socket
# inode (the dir is not group-writable to them, and the sticky bit blocks
# cross-owner unlink). The socket file itself is chmod 0660
# + chown :{{ xinas_api_socket_group }} by server.ts after binding.
xinas_api_socket: /run/xinas/api.sock

# Group that owns the UDS file (gid resolved at template time via
# getent). The same name is used to create the group (task 2), to
# stamp the socket file, and to own the role-managed directories.
#
# Phase 0 caveat: the systemd unit shipped in xiNAS-MCP/xinas-api.service
# hardcodes `SupplementaryGroups=xinas-admin`. Overriding this variable
# alone is NOT enough — you must also patch the unit (or ship your own
# drop-in at /etc/systemd/system/xinas-api.service.d/) so the dynamic
# user gains membership in your replacement group. The variable exists
# for naming consistency across the role's tasks; full override support
# lands when the unit is templated (deferred to the same WS that lifts
# this role into site.yml).
xinas_api_socket_group: xinas-admin

# Per-controller identity. Default is an EMPTY placeholder; the role
# generates /var/lib/xinas/controller-id with `uuidgen` on first install,
# then slurps it FROM THE MANAGED HOST and set_facts this variable from
# the decoded value (guarded `when: xinas_api_controller_id | length == 0`
# so an explicit operator override still wins). This default is
# deliberately NOT `"{{ lookup('file', '/var/lib/xinas/controller-id') }}"`:
# Ansible lookups run on the CONTROL NODE, not the managed host, so a
# lookup would read the controller's filesystem (wrong id, or a hard error
# when the path is absent there). PR #203's `ansible_machine_id | to_uuid`
# derivation has been retired — it produced unstable IDs across machine-id
# regeneration (cloned VMs) and did not co-locate identity with state for
# OS-reinstall preservation. Operators with a pre-assigned controller_id
# from a control-plane registry override this via extra-vars.
xinas_api_controller_id: ""
```

No further tunables in this PR. TCP listen, token policy, log
rotation, and rotation tooling all gain variables when the
corresponding feature ships.

## Task sequence (tasks/main.yml)

```text
1.  Pre-flight: stat /opt/xiNAS/xiNAS-MCP/dist/api-server.js, fail with
    the message above if missing.

2.  Create the {{ xinas_api_socket_group }} group (no fixed gid;
    system-assigned). No-op if it already exists.

3.  Look up the {{ xinas_api_socket_group }} gid via
    `getent group {{ xinas_api_socket_group }}`; register as fact
    _xinas_admin_gid for the template step.

3b. Create the {{ xinas_api_user }} system user with primary group
    {{ xinas_api_socket_group }}, no home directory, /usr/sbin/nologin
    shell, system uid range. Owns the SQLite + audit JSONL so state
    persists with a stable owner across restarts.

4.  Create /etc/xinas-api/ directory: mode 0750, owner root,
    group {{ xinas_api_socket_group }}. (Group needs +x for traversal
    so the api process — whose primary group is xinas-admin via the
    unit's `Group=` — can read its config.)

5.  Install tmpfiles.d snippet at /usr/lib/tmpfiles.d/xinas-api.conf
    (mode 0644 root:root) with these lines:

        d /run/xinas             1731 root xinas-api -
        d /var/lib/xinas         0755 root root          -
        d /var/lib/xinas/state   0750 {{ xinas_api_user }} {{ xinas_api_socket_group }} -
        d /var/log/xinas         0750 {{ xinas_api_user }} {{ xinas_api_socket_group }} -

    Why tmpfiles.d instead of `ansible.builtin.file`:
      - /run/xinas is a runtime directory that must exist before
        xinas-api.service starts AND must be recreated on every boot
        (because /run is a tmpfs). tmpfiles.d is the standard systemd
        mechanism for this; using ansible.builtin.file would not
        survive a reboot.
      - For consistency, the persistent /var/lib/xinas/state and
        /var/log/xinas dirs are created through the same mechanism.
        tmpfiles.d's 'd' type creates a directory if absent and adjusts
        owner/group/mode on every run, matching Ansible's idempotency
        contract.
      - The unit no longer carries RuntimeDirectory=xinas (which would
        give /run/xinas to the dynamic uid — not xinas-admin-traversable)
        or StateDirectory/LogsDirectory (which would create
        /var/lib/xinas-api, not the ADR-0003 canonical path).

6.  Run `systemd-tmpfiles --create /usr/lib/tmpfiles.d/xinas-api.conf`
    once at install time so the dirs exist before the unit's first
    start. (At reboot, systemd-tmpfiles-setup.service re-runs.) The
    snippet now also creates `/var/lib/xinas` (`0755 root:root`, the
    sole authority for that dir — no separate `file:` task) and
    `/etc/xinas-agent` (`0755 root:root`) so steps 6a and 6b can write
    into them.

6a. Controller identity (xinas-agent S0+S1 PR):
    - `command: uuidgen` guarded by `creates: /var/lib/xinas/controller-id`,
      then `copy:` the captured stdout to the file (`0644 root:root`). A
      `creates:`-guarded command + copy, rather than a `shell:` redirect,
      keeps it ansible-lint clean and idempotent; re-runs preserve the
      existing UUID.
    - `slurp` the file FROM THE MANAGED HOST and `set_fact`
      `xinas_api_controller_id` from the decoded blob, guarded
      `when: xinas_api_controller_id | length == 0` so an operator
      extra-var override wins. The config.json template (step 7) renders
      this value. No `lookup('file', ...)` — see the variable comment for
      why a control-node lookup would read the wrong filesystem.

6b. Split-secret agent token store (xinas-agent S0+S1 PR). The agent
    posts observations to the api with a dedicated bearer
    (principal `agent:root`, role `internal_agent`) that must NOT live in
    the operator-readable config.json. Two files, every token-touching
    task `no_log: true`:
    - First install (internal-tokens.json absent): `openssl rand -hex 32`
      → write `/etc/xinas-api/internal-tokens.json`
      (`{ "<token>": { "principal": "agent:root", "role": "internal_agent" } }`,
      mode `0640 root:xinas-api`).
    - Re-run (present): slurp it and extract the `internal_agent` entry's
      key via `... | map(attribute='key') | list)[0] | default(None)`
      (index `[0]`, not the `first` filter, so an empty/corrupt file
      yields Undefined and the actionable Fail fires instead of an
      uncatchable Jinja error).
    - Both branches converge to write/refresh `/etc/xinas-agent/agent-token`
      (mode `0400 root:root`) with the same bearer. The api reads the JSON
      to validate inbound requests (`loadConfig` merges it via
      `internalTokensPath`; key collisions are a startup fatal); the agent
      reads the raw token to set the bearer on outbound observation POSTs.
      Operators in `xinas-admin` can read neither file.

7.  Token + config bootstrap (the heart of the role):

    7a. stat /etc/xinas-api/config.json -> register as _config_stat.
    7b. If _config_stat.stat.exists is false (first install):
        - Generate a random 256-bit bearer token via
          `openssl rand -hex 32`. no_log: true.
        - Template config.json from xinas-api-config.json.j2 with that
          token, the looked-up _xinas_admin_gid, and the
          controller_id. force: true (first write only because of the
          enclosing condition). no_log: true. The template MUST emit
          `internalTokensPath: {{ xinas_api_config_dir }}/internal-tokens.json`
          — without it `loadConfig()` never merges the internal-tokens
          file (there is no default/env fallback), so the agent's bearer
          is unknown to the api and every `POST /internal/v1/observed`
          401s. (Regression-guarded by the rendered-template contract
          test `src/__tests__/agent/config-template.test.ts`.)
        - Write the token to /etc/xinas-api/admin-token, mode 0640,
          owner root, group {{ xinas_api_socket_group }}.
          no_log: true.
    7c. Else (config already present):
        - Slurp /etc/xinas-api/config.json. no_log: true.
        - Identify the bootstrap token: the entry in the tokens map
          whose principal equals "admin:bootstrap". This rule means
          operators who manually add additional tokens (for remote
          tooling, automation, etc.) do NOT have those tokens
          mirrored into admin-token. If no entry with that principal
          exists (the operator deleted the bootstrap), the role
          fails with an actionable message rather than silently
          guessing.
        - Write/refresh /etc/xinas-api/admin-token from that token
          (mode 0640 root:{{ xinas_api_socket_group }}). Idempotent —
          if the file is already correct, Ansible reports 'ok'.
          no_log: true.

    This makes config.json the single source of truth. Deleting only
    admin-token and re-running the role recreates it from config; the
    operator never sees a token mismatch. Deleting only config.json
    forces a fresh token (and a stale admin-token if not also deleted —
    documented in the README rotation procedure).

8.  Install /etc/systemd/system/xinas-api.service by copying
    {{ xinas_api_repo_path }}/xinas-api.service verbatim. Triggers
    'reload systemd' and 'restart xinas-api' handlers.

9.  Force systemd daemon-reload via meta: flush_handlers.

10. Enable and start xinas-api.
```

## Filesystem layout after install

```text
/etc/xinas-api/                          0750  root:xinas-admin
/etc/xinas-api/config.json               0640  root:xinas-admin
/etc/xinas-api/admin-token               0640  root:xinas-admin
/etc/xinas-api/internal-tokens.json      0640  root:xinas-api    (agent bearer; api-readable)

/etc/xinas-agent/                        0755  root:root         (by tmpfiles.d)
/etc/xinas-agent/agent-token             0400  root:root         (agent bearer; agent-only)

/var/lib/xinas/                          0755  root:root         (by tmpfiles.d)
/var/lib/xinas/controller-id             0644  root:root         (uuidgen, first install)
/var/lib/xinas/state/                    0750  xinas-api:xinas-admin
/var/lib/xinas/state/xinas.db            (created by api at first run)
/var/lib/xinas/state/xinas.db-wal        (SQLite WAL)
/var/lib/xinas/state/archive/            (created by GcSweeper as needed)

/var/log/xinas/                          0750  xinas-api:xinas-admin
/var/log/xinas/audit.jsonl               (created by api at first write)

/run/xinas/                              0770  root:xinas-admin   (by tmpfiles.d)
/run/xinas/api.sock                      0660  xinas-api:xinas-admin   (by server.ts)

/etc/systemd/system/xinas-api.service    0644  root:root
```

`internal-tokens.json` (`root:xinas-api`) and `agent-token` (`root:root`)
hold the same `internal_agent` bearer with different audiences: members of
`xinas-admin` can read neither, so an operator cannot impersonate the agent
to push poisoned observations. The `xinas-api` group has no human members;
the api process holds it only as a supplementary group (unit
`SupplementaryGroups=xinas-api`).

The `/var/lib/xinas/config-history/` tree owned by `xinas_history`
(mode `0700 root:root`) is unrelated and untouched by this role.

## config.json template

`templates/xinas-api-config.json.j2`:

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

The `_xinas_admin_gid` and `_xinas_api_admin_token` are role-internal
facts produced by tasks 3 and 7 respectively. Naming convention: a
leading underscore marks variables that are not part of the role's
public interface and should not be referenced from outside.

## Systemd unit — source-tree fix

The current `xiNAS-MCP/xinas-api.service` (landed in PR #201) has five
problems that this role PR fixes in the source tree, not by templating:

- `ExecStart=/usr/bin/node /opt/xinas-mcp/dist/api-server.js` points at
  a path that exists nowhere. Fix to
  `/usr/bin/node /opt/xiNAS/xiNAS-MCP/dist/api-server.js` (canonical
  install path per `xinas_mcp_repo_path`).
- `StateDirectory=xinas-api` and `LogsDirectory=xinas-api` create
  `/var/lib/xinas-api/` and `/var/log/xinas-api/`, which contradict
  ADR-0003's canonical `/var/lib/xinas/state/` and `/var/log/xinas/`.
  **Drop both lines.** The role's tmpfiles.d entry pre-creates the
  canonical paths; the static `xinas-api` user owns them.
- `ProtectSystem=strict` makes the entire filesystem read-only except
  paths systemd has been told are writable. With StateDirectory and
  LogsDirectory dropped, the api can't open the SQLite database (EROFS).
  **Add** `ReadWritePaths=/var/lib/xinas/state /var/log/xinas` to grant
  write access to the tmpfiles.d-created directories. This is the same
  line ADR-0002 §"Hardening — xinas-api" sample unit shows.
- `RuntimeDirectory=xinas` + `RuntimeDirectoryMode=0750` creates
  `/run/xinas/` owned by the **dynamic uid**, NOT `root:xinas-admin`.
  Mode 0750 then means xinas-admin members can't traverse the parent
  dir to reach the socket (EACCES on every UDS connection from an
  operator). **Drop both lines.** The role's tmpfiles.d entry creates
  `/run/xinas/` as `root:xinas-admin 0770` before the unit starts (and
  systemd-tmpfiles-setup.service recreates it on every boot because
  /run is tmpfs).
- **Switch from `DynamicUser=yes` + `SupplementaryGroups=xinas-admin`
  to static `User=xinas-api Group=xinas-admin`.** DynamicUser allocates
  a fresh transient uid on every start; SQLite creates xinas.db with
  mode 0644 by default, so on the next restart the new uid would lose
  write access to its own state files. ADR-0002 §Hardening doesn't
  dictate DynamicUser — it dictates "no root, no caps, ProtectSystem=
  strict, SystemCallFilter." All of those stay. The static user owns
  the persistent files; xinas-admin is its primary group so files it
  creates are group-readable to operators.

After these fixes, the rest of the unit's hardening — empty
`CapabilityBoundingSet`, `NoNewPrivileges=true`, `ProtectSystem=strict`,
`ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
`ProtectKernelTunables=yes`, `ProtectKernelModules=yes`,
`ProtectControlGroups=yes`, `RestrictNamespaces=yes`, `LockPersonality=
yes`, `RestrictRealtime=yes`, `RestrictAddressFamilies=AF_UNIX AF_INET
AF_INET6`, `SystemCallFilter=@system-service`,
`SystemCallErrorNumber=EPERM` — is preserved. The five changes above
adjust the filesystem-access plumbing to match the tmpfiles.d-based
dir provisioning this role uses.

## handlers/main.yml

```yaml
- name: reload systemd
  ansible.builtin.systemd:
    daemon_reload: true

- name: restart xinas-api
  ansible.builtin.service:
    name: xinas-api
    state: restarted
```

`config.json` and `xinas-api.service` changes both notify
`restart xinas-api`. The admin-token file does NOT notify a restart —
the running process re-reads tokens only on (re)start, and we don't
want a restart on every cosmetic playbook run.

## Verification

A successful install produces:

```bash
# Service running:
systemctl is-active xinas-api    # expect: active

# Socket exists with correct perms (owner is the static xinas-api user):
ls -l /run/xinas/api.sock        # expect: srw-rw---- xinas-api xinas-admin

# Token file readable to xinas-admin:
ls -l /etc/xinas-api/admin-token # expect: -rw-r----- root xinas-admin

# UDS health probe as an xinas-admin member (no token needed over UDS):
curl --unix-socket /run/xinas/api.sock http://localhost/api/v1/health
# expect: {"request_id":"...","result":{"overall":"ok",...},...}

# TCP-style health probe via the bootstrap token (still over UDS for now):
TOKEN=$(sudo cat /etc/xinas-api/admin-token)
curl --unix-socket /run/xinas/api.sock \
     -H "Authorization: Bearer $TOKEN" \
     http://localhost/api/v1/health
# expect: same envelope; auth uses the bearer instead of UDS-trust.
```

The role's molecule/integration test (deferred) will run these against
a clean Ubuntu 24.04 container.

## Failure modes the role handles

| Failure | Behavior |
|---|---|
| `dist/api-server.js` missing | Pre-flight fails with the actionable message above. |
| xinas-admin group already exists with a different gid | `getent` returns the existing gid; the config template uses it. No error. |
| `/etc/xinas-api/config.json` already exists | Token re-derived from it; admin-token file refreshed; no rewrite of config. Idempotent. |
| `/etc/xinas-api/admin-token` deleted by operator | Re-derived from config.json on next run. Same token; no service restart needed. |
| Both deleted by operator | Treated as a fresh install: new token generated, new config templated, admin-token written. Service restart fires via the config-change notification. |
| systemd unit changed in source tree | Copy step replaces it; daemon-reload + restart fire via handlers. |
| `xinas-api.service` running but `dist/api-server.js` rebuilt via `xinas_mcp,build` tags | Not handled by this role. The xinas_mcp build step notifies `restart xinas-mcp` only — xinas-api keeps running the old code. Operator workaround: `systemctl restart xinas-api` manually after a build. The xiNAS update flow's `Requires-Rebuild:` commit-trailer mechanism does NOT close this gap in Phase 0 because the trailer drives site.yml and xinas_api is not in site.yml (opt-in by design). The notification chain unifies (and the trailer starts covering this) once xinas_api becomes part of the default deployment — tracked as a follow-up alongside site.yml integration. |

## Token rotation procedure

Not automated in this PR. Documented in README and reproduced here:

1. `systemctl stop xinas-api`
2. `rm /etc/xinas-api/config.json /etc/xinas-api/admin-token`
3. Re-run the role: `ansible-playbook <your playbook> --tags xinas_api`
4. New token at `/etc/xinas-api/admin-token`; service restarted by the
   role's handler chain.

A future workstream (auth.RotateToken / RBAC delivery) will replace
this with a runtime API call that swaps the token without a restart
and notifies long-lived clients.

## Related specs and ADRs

- [ADR-0001](../control-path/adr/0001-api-surface.md) — REST + MCP
  transports; principal × transport table; basis for the bootstrap
  bearer + UDS trust model.
- [ADR-0002](../control-path/adr/0002-agent-privilege-model.md)
  §Hardening — the unprivileged-api requirement that drives the
  empty CapabilityBoundingSet, ProtectSystem=strict, SystemCallFilter,
  and the agent-runs-as-root split. The static `xinas-api` user and
  the xinas-admin group-membership trust model are this role's
  realization of "unprivileged but reachable from operator tools."
- [ADR-0003](../control-path/adr/0003-state-store.md) §State store +
  §Audit semantics — canonical paths
  `/var/lib/xinas/state/xinas.db` and `/var/log/xinas/audit.jsonl`
  used by this role.
- [docs/control-path/api-v1.yaml](../control-path/api-v1.yaml) — the
  REST surface the deployed service implements.
- PR #201 — the `xinas-api` skeleton this role deploys.

## Open questions deferred past this PR

- xinas-agent (WS3) interaction with `/var/lib/xinas/state/`: the
  agent does NOT write SQLite per ADR-0002 — it reports observations
  through the API's `/internal/v1/observed` endpoint. So no shared-
  write coordination is needed; the agent only needs to be able to
  reach the API socket (which xinas-admin membership grants).
- Multi-controller / HA: out of scope for Phase 0 (single-controller
  hardware default per the memory note).
- Audit log rotation: the audit JSONL grows without bound until WS9
  (config history, rollback, and drift) ships its rotation hook.
  Operators can run `logrotate` manually if needed; the audit hash
  chain spans rotations per ADR-0003 §Audit JSONL rotation.
- site.yml integration: deferred to a follow-up. Once landed, the
  `Requires-Rebuild: xinas_api` trailer will trigger the role on
  rebuilds, closing the manual-restart gap in the failure-modes
  table.
