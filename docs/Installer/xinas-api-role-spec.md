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
- Create the on-disk config directory and write `config.json` + the
  bootstrap admin bearer token.
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
# by tmpfiles.d at install + boot (DynamicUser's transient uid can't
# own a persistent dir); group-write to xinas-admin is how the api
# process gains write access via its SupplementaryGroups membership.
xinas_api_state_dir: /var/lib/xinas/state
xinas_api_log_dir:   /var/log/xinas

# Unix-domain socket path. The parent directory /run/xinas is created
# by the role's tmpfiles.d entry as root:xinas-admin 0750 so operators
# in xinas-admin can traverse it; the socket file itself is chmod 0660
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

# Per-controller identity. UUIDv5 derivation from machine-id gives a
# stable UUID-shaped string without an extra on-disk file. Operators
# can override if they have a pre-assigned controller_id from a
# control-plane registry.
xinas_api_controller_id: "{{ ansible_machine_id | to_uuid }}"
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

4.  Create /etc/xinas-api/ directory: mode 0750, owner root,
    group {{ xinas_api_socket_group }}. (Group needs +x for traversal
    so the DynamicUser+SupplementaryGroups api process can read its
    config.)

5.  Install tmpfiles.d snippet at /usr/lib/tmpfiles.d/xinas-api.conf
    (mode 0644 root:root) with these lines:

        d /run/xinas             0750 root {{ xinas_api_socket_group }} -
        d /var/lib/xinas         0755 root root          -
        d /var/lib/xinas/state   0770 root {{ xinas_api_socket_group }} -
        d /var/log/xinas         0770 root {{ xinas_api_socket_group }} -

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
    start. (At reboot, systemd-tmpfiles-setup.service re-runs.)

7.  Token + config bootstrap (the heart of the role):

    7a. stat /etc/xinas-api/config.json -> register as _config_stat.
    7b. If _config_stat.stat.exists is false (first install):
        - Generate a random 256-bit bearer token via
          `openssl rand -hex 32`. no_log: true.
        - Template config.json from xinas-api-config.json.j2 with that
          token, the looked-up _xinas_admin_gid, and the
          controller_id. force: true (first write only because of the
          enclosing condition). no_log: true.
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

/var/lib/xinas/state/                    0770  root:xinas-admin
/var/lib/xinas/state/xinas.db            (created by api at first run)
/var/lib/xinas/state/xinas.db-wal        (SQLite WAL)
/var/lib/xinas/state/archive/            (created by GcSweeper as needed)

/var/log/xinas/                          0770  root:xinas-admin
/var/log/xinas/audit.jsonl               (created by api at first write)

/run/xinas/                              0750  root:xinas-admin   (by tmpfiles.d)
/run/xinas/api.sock                      0660  <dyn-user>:xinas-admin  (by server.ts)

/etc/systemd/system/xinas-api.service    0644  root:root
```

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

The current `xiNAS-MCP/xinas-api.service` (landed in PR #201) has four
problems that this role PR fixes in the source tree, not by templating:

- `ExecStart=/usr/bin/node /opt/xinas-mcp/dist/api-server.js` points at
  a path that exists nowhere. Fix to
  `/usr/bin/node /opt/xiNAS/xiNAS-MCP/dist/api-server.js` (canonical
  install path per `xinas_mcp_repo_path`).
- `StateDirectory=xinas-api` and `LogsDirectory=xinas-api` create
  `/var/lib/xinas-api/` and `/var/log/xinas-api/`, which contradict
  ADR-0003's canonical `/var/lib/xinas/state/` and `/var/log/xinas/`.
  **Drop both lines.** The role's tmpfiles.d entry pre-creates the
  canonical paths; the dynamic-user api process writes them via its
  xinas-admin supplementary-group membership.
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
  `/run/xinas/` as `root:xinas-admin 0750` before the unit starts (and
  systemd-tmpfiles-setup.service recreates it on every boot because
  /run is tmpfs).

After these fixes, the unit's hardening directives that came from
PR #201's CR1 — `DynamicUser=yes`, `SupplementaryGroups=xinas-admin`,
empty `CapabilityBoundingSet`, `ProtectSystem=strict`, the
SystemCallFilter, etc. — are all kept as-is. The four changes above
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

# Socket exists with correct perms (owner is the systemd DynamicUser —
# shown as a transient name like 'xinas-api'; group is xinas-admin):
ls -l /run/xinas/api.sock        # expect: srw-rw---- <dyn-user> xinas-admin

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
  §Hardening — the unprivileged-api requirement that drives
  DynamicUser, empty CapabilityBoundingSet, the xinas-admin
  group-membership trust model, and the agent-runs-as-root split.
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
