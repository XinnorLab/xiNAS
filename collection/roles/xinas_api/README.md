# `xinas_api` role

Phase 0 installer for the `xinas-api` REST service introduced by PR #201.
Deploys the unit, the runtime config, the bootstrap admin bearer token,
and the filesystem/group plumbing it depends on.

**Spec:** [docs/Installer/xinas-api-role-spec.md](../../../docs/Installer/xinas-api-role-spec.md).

## What this role does

- Creates the `xinas-admin` Unix group and the `xinas-api` system user
  (no home dir, `/usr/sbin/nologin` shell, system-assigned uid/gid;
  `xinas-api`'s primary group is `xinas-admin`).
- Adds the installing operator to `xinas-admin` so a non-root sudo user
  can reach the API socket right after install (auto-detected from
  `SUDO_USER`/`USER`; opt out with `xinas_api_add_installing_operator`).
  See "Adding an operator" below.
- Pre-creates `/run/xinas/` as `root:xinas-admin 0770` and
  `/var/lib/xinas/state/` + `/var/log/xinas/` as `xinas-api:xinas-admin 0750`
  via `/usr/lib/tmpfiles.d/xinas-api.conf`.
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
| `xinas_api_add_installing_operator` | `true` | Auto-add the sudo/login operator to `xinas-admin`. Set `false` to manage membership out of band. |
| `xinas_api_admin_users` | `[]` | Extra **existing** accounts to add to `xinas-admin`; unknown names are skipped, never created. |
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

# Socket exists with correct perms:
ls -l /run/xinas/api.sock        # expect: srw-rw---- xinas-api xinas-admin

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

Membership in `xinas-admin` is what lets a non-root operator connect to
`/run/xinas/api.sock` (via `xinas-mcp-stdio` or the CLI). Without it the
adapter fails with `connect EACCES /run/xinas/api.sock`.

**By default the role adds the installing operator for you.** It resolves
the human behind the run from the sudo/login environment
(`ansible_env.SUDO_USER`, falling back to `ansible_env.USER`) and adds
that account to `xinas-admin` — so `sudo ansible-playbook … --tags
xinas_api` grants the invoking user automatically. `root` and empty
values are skipped, accounts that don't exist are never created, and
`append: true` means no one is ever removed.

**The new membership takes effect on the operator's next login** — log
out and back in (or start a fresh `sudo -i` session) before using the
MCP/CLI.

To grant additional accounts, list them (they must already exist):

```yaml
xinas_api_admin_users:
  - alice
  - bob
```

To opt out of the auto-add entirely (manage membership out of band):

```yaml
xinas_api_add_installing_operator: false
```

You can still add operators by hand at any time:

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

The role's fine-grained tags are **post-full-install maintenance
tools, not standalone first-install entry points.** A first install
MUST run the role without tag filters (or with `--tags xinas_api`)
so the xinas-admin group + xinas-api user exist, the `_xinas_admin_gid`
fact is registered, and `/etc/xinas-api/` is created. After that,
the per-area tags are safe for targeted reapplications.

| Tag | Use case |
|---|---|
| `xinas_api` | All tasks. Use for a fresh install or a full re-apply. |
| `group` | Reapply the xinas-admin group + gid lookup (and re-add operators) if the group was deleted by hand. |
| `user` | Reapply the xinas-api system user if it was deleted by hand. |
| `operator` | Re-resolve and re-add operator accounts to xinas-admin (e.g. after changing `xinas_api_admin_users`, or to add a new sudo user on a re-run). |
| `config` | Reapply `/etc/xinas-api/`, the tmpfiles snippet, and the token/config bootstrap after manual edits. |
| `tmpfiles` | Reapply `/usr/lib/tmpfiles.d/xinas-api.conf` + recreate the writable dirs. |
| `service` | Reapply the systemd unit + restart. |

Running `--tags config` or `--tags tmpfiles` on a host that has
never run the role at all will fail: the config tasks reference
`_xinas_admin_gid` (set by the group lookup under the `group` tag),
and the tmpfiles template references the xinas-api user and
xinas-admin group (both created under `group` + `user`). Reapply
the whole role first, then use the targeted tags for follow-up work.
