# xiNAS nfs-helper — service lifecycle contract (live spec)

**Status:** live (2026-08-16). Owns the **systemd lifecycle** of
`xinas-nfs-helper.service` and the **unreachable-helper error contract** the
control path presents when the daemon's socket is absent.

**Relationship to other docs.** The helper's *wire protocol* (ops, envelopes,
lock surface, file ownership) lives in `docs/MCP/spec-nfs-helper.md`, which is
otherwise legacy-reference. This spec **supersedes that document's §Systemd
Unit** section and nothing else. The NFS executor's use of the helper is
`docs/control-path/s3-nfs-executor-spec.md`; the ops it calls are unchanged
here.

---

## 1. Why this spec exists

`xinas-nfs-helper` is the sole writer of `/etc/exports` and the only path the
control path has to NFS state — `share.create/update/delete`,
`nfs-profile.update`, `nfs-idmap.set`, the `ExportRule` / `NfsSession`
collectors, and every `share.*` preflight all round-trip through
`/run/xinas-nfs-helper.sock`. When the socket is gone, that entire surface
fails, and the agent's poll sweep fails with it.

The unit previously declared:

```ini
After=network.target nfs-kernel-server.service
Requires=nfs-kernel-server.service
```

`Requires=` is bidirectional in its failure behavior: it also **propagates
stop**. Any `nfs-server` stop — an admin `systemctl stop`, a failed restart,
an unrelated teardown — takes the helper down with it, and because that is a
*clean dependency-driven stop* rather than a crash, `Restart=on-failure` never
fires. The helper stays dead until a human notices.

Observed on a node (2026-08-16, xiNAS-CEC467FFE6ADE86): `nfs-server` stopped at
16:37:53 during a filesystem teardown; systemd tore down `xinas-nfs-helper` in
the same transaction; a `share.create` 23 minutes later failed at preflight with
`connect ENOENT /run/xinas-nfs-helper.sock`, and the agent had logged
`poll_sweep_failed / NfsSession` with the same error every 30 s in between.
Neither service returned on its own.

The dependency the helper actually needs is **ordering**, not co-liveness (§3).

---

## 2. Unit contract

`xiNAS-MCP/nfs-helper/xinas-nfs-helper.service`, installed verbatim to
`/etc/systemd/system/xinas-nfs-helper.service` by the `xinas_nfs_helper` role:

```ini
[Unit]
After=network.target nfs-kernel-server.service
Wants=nfs-kernel-server.service

[Service]
Restart=always
RestartSec=5s
```

| Directive | Value | Contract |
|---|---|---|
| `After=` | includes `nfs-kernel-server.service` | Ordering only: at boot the helper starts *after* nfsd, so its startup check (§3) sees the steady state. |
| `Wants=` | `nfs-kernel-server.service` | Pulls nfsd in when the helper starts, **without** binding the helper's lifetime to it. A stop, restart, or start-failure of nfsd MUST NOT stop the helper. |
| `Requires=` | **absent** | Forbidden on this unit. Re-introducing it restores the outage in §1. |
| `Restart=` | `always` | The helper exits **0** on SIGTERM (`nfs_helper.py` `shutdown()`), so `on-failure` does not cover an unexpected clean exit. `always` does. An explicit `systemctl stop xinas-nfs-helper` still stays stopped — that is systemd's job semantics and is the intended admin escape hatch. |

The unit **file** names the canonical `nfs-kernel-server.service`. On Ubuntu
22.04/24.04 that is an alias whose primary name is `nfs-server.service`, so a
live `systemctl show xinas-nfs-helper -p After,Wants` reports
`nfs-server.service`. Both names refer to the same unit; tests assert against
the file text or accept the alias-resolved name, and must not require
`nfs-kernel-server.service` in systemd's resolved output.

---

## 3. Availability rule

**The helper's availability is independent of nfsd's runtime state.**

The daemon already treats a missing or non-functional NFS server as advisory,
not fatal: at startup it probes `exportfs -s` and a missing binary or a
non-zero result is logged at WARNING, after which it binds its socket and
serves normally (`nfs_helper.py`, startup health check). Operations that
genuinely need a live nfsd fail per-op, with the helper's own typed error and
the failing command's stderr — a per-request failure a caller can act on,
rather than a vanished socket that fails every request identically.

This is what makes `Wants=` correct rather than merely lenient: a helper that
is up while nfsd is down still answers `list_exports`, still lets the collector
observe, and still reports *why* an export operation cannot complete.

---

## 4. Unreachable-helper error contract

When the socket cannot be connected, **neither** helper transport may surface
its raw connect error: `connect ENOENT /run/xinas-nfs-helper.sock` (the agent's
`agent/probe/nfs.ts` → `callHelper`) and `NFS helper socket not found: …` (the
TUI's `xinas_menu/api/nfs_client.py`) each name the component that is down at
best, and never the way back.

Connect-time failures — `ENOENT` (socket file absent: daemon not running),
`ECONNREFUSED` (stale socket file, no listener), `EACCES` (socket present,
caller lacks permission) — are wrapped as:

```
nfs-helper is not reachable at <socket> (<code>): <cause> —
xinas-nfs-helper.service is not running; start it with:
systemctl start xinas-nfs-helper
```

Requirements:

- The message names the **socket path**, the **unit**, and a **command**.
- In the agent transport the original error is preserved as `cause` for the
  log record; the TUI client returns the message in its existing
  `(ok, result, error)` tuple.
- Errors *after* connect (helper-returned `ok:false`, timeouts, oversized or
  malformed responses) are unchanged — they already identify the helper and
  carry the helper's own code.
- The wrap lives in the transport, so every consumer inherits it: task stages
  (surfaced through `error_message` on the terminal event, and thus in the TUI
  dialog), the poll sweep's `poll_sweep_failed` log, the collectors, and the
  TUI's own NFS screens.

A `share.*` preflight that fails this way is a **`FAILED_BEFORE_CHANGE`-class**
failure in intent — nothing was written — though the task runner reports
`FAILED_PARTIAL_ROLLED_BACK` because rollback runs on any stage failure and
no-ops via its stash markers (`s3-nfs-executor-spec.md` §error table). That
taxonomy is unchanged by this spec.

---

## 5. Deployment

The unit is installed by `collection/roles/xinas_nfs_helper/`. A change to the
unit file **only reaches a host when that role re-runs**, so any commit that
edits it MUST carry:

```
Requires-Rebuild: xinas_nfs_helper
```

Without the trailer the release-tag checkout updates the repo copy and leaves
`/etc/systemd/system/xinas-nfs-helper.service` at the old text.

The §4 wrap in `agent/probe/nfs.ts` is TypeScript under `xiNAS-MCP/src/`, which
the agent runs as compiled JavaScript from the untracked `dist/`; a commit
touching it additionally needs `Requires-Rebuild: xinas_node_build`. The TUI
client is plain Python and needs no tag.

---

## 6. Tests

| Level | Check |
|---|---|
| Contract (`tests/test_nfs_helper_unit.py`) | Unit file orders `After=` nfs-kernel-server; declares `Wants=`; has **no** `Requires=` naming the NFS server; sets `Restart=always`. |
| Unit (`xiNAS-MCP/src/__tests__/agent/probe/nfs.test.ts`) | `callHelper` against an absent socket rejects with a message naming the socket, the unit, and the `systemctl start` remediation — not a bare `ENOENT`; the libuv error survives as `cause`. |
| Unit (`tests/test_nfs_helper_client_errors.py`) | The TUI client returns the same remediation for both an absent socket file and a stale one (bound, not listening). |
