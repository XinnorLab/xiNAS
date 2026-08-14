# xiRAID Exporter integration (spec)

**Owns:** the Management → Integrations → **xiRAID Exporter** screen
(`xinas_menu/screens/exporter.py`), the systemd unit-name resolver
(`xinas_menu/utils/service_ctl.py::xiraid_exporter_unit`), and the
`xiraid_exporter` Ansible role. Also governs how every other xiNAS surface
refers to the exporter service: the health engines
(`xinas_menu/health/engine.py`, `healthcheck.sh`), Quick Actions → Service
Status, and the `xinas_uninstall` teardown.

**Status:** active (2026-07-24).

## Component

The xiRAID Prometheus exporter is a third-party component from
[E4 Computer Engineering](https://github.com/E4-Computer-Engineering/xiraid-exporter),
distributed as a `.deb` and installed from its GitHub Releases. It scrapes
xiRAID state and serves Prometheus metrics on **port 9827**
(`http://localhost:9827/metrics`). xiNAS installs, updates, restarts, reports
on, and removes it, but does not vendor or build it.

The port is the upstream default, documented in the project README as
`--web.listen-address … (default: :9827)`
(<https://github.com/E4-Computer-Engineering/xiraid-exporter>). xiNAS does not
pass that flag, so changing it upstream would change it here.

It is **not** part of `site.yml`. The `xiraid_exporter` role exists for
explicit invocation (`--tags xiraid_exporter`); the normal path is the TUI
screen, which downloads the release asset and installs it with `apt`.

## The package/unit name split

This is the contract every call site must respect.

| Identifier | Spelling | Example |
|-----------|----------|---------|
| Debian package | **hyphen** | `xiraid-exporter` (`dpkg-query -W xiraid-exporter`) |
| Binary | **hyphen** | `/usr/bin/xiraid-exporter` |
| GitHub repo / release asset | **hyphen** | `xiraid-exporter_1.1.1_linux_amd64.deb` |
| **systemd unit** | **underscore** | `/usr/lib/systemd/system/xiraid_exporter.service` |

The unit is the odd one out. Older builds of the package shipped the
hyphenated unit (`xiraid-exporter.service`), so **both spellings exist in the
field** and the unit name must not be hardcoded.

> **[observed]** The upstream README documents the exporter's flags and
> metrics but says nothing about the Debian package layout — no package name,
> no unit name, no statement that the unit is spelled with an underscore. The
> whole table above was established by inspecting installed `.deb`s on real
> nodes, and the underscore/hyphen split is the reason
> `tests/test_xiraid_exporter_unit.py` exists. Since it is undocumented,
> upstream can change it in any release without notice: the runtime
> resolution contract below is the mitigation, and the candidate list must
> stay ordered rather than reduced to a single "correct" name.

### Why hardcoding fails silently

`systemctl show <unknown-unit> --property=ActiveState` exits **0** and reports
`ActiveState=inactive`, not an error. A wrong unit name is therefore
indistinguishable from a stopped service:

```console
$ systemctl is-active xiraid_exporter.service   # real unit
active
$ systemctl is-active xiraid-exporter.service   # does not exist
inactive
$ systemctl is-enabled xiraid-exporter.service
Failed to get unit file state: No such file or directory   # exit 4
```

Every affected surface reported a healthy, metrics-serving exporter as down,
and `systemctl restart` on the nonexistent unit returned success while doing
nothing — so the screen's Restart action could never clear the false
"inactive". See the regression test
`tests/test_xiraid_exporter_unit.py` for the full failure description.

## Resolution contract

**Every systemd operation on the exporter MUST resolve the unit name at
runtime.** No surface may embed a literal unit name.

Resolution probes `LoadState`, which distinguishes an installed-but-stopped
unit (`loaded`) from an unknown one (`not-found`) — unlike `ActiveState`,
which conflates them:

1. Try `xiraid_exporter.service` (current packaging, preferred).
2. Fall back to `xiraid-exporter.service` (older packaging).
3. If neither resolves — the exporter is not installed — return the **first**
   candidate, so callers still have a stable name to display and to attribute
   errors to.

Order is pinned by `service_ctl.XIRAID_EXPORTER_UNITS` and, for Ansible, by
`xiraid_exporter_unit_candidates` in the role defaults. When both units are
present (upgrade leftovers), the preferred spelling wins.

### Consumers

| Surface | Mechanism |
|---------|-----------|
| `xinas_menu/screens/exporter.py` | `xiraid_exporter_unit()` before each `state()` / `restart()` |
| `xinas_menu/screens/quick_actions.py` | `_services()` resolves at call time; the Service Status list is built per invocation, not at import |
| `xinas_menu/health/engine.py` | local `xiraid_exporter_unit()` helper, resolved when `check_services` builds `service_map` |
| `healthcheck.sh` | byte-identical copy of that helper — the embedded Python runs standalone and cannot import `xinas_menu` |
| `collection/roles/xiraid_exporter` | `service_facts` + `set_fact` → `xiraid_exporter_unit`, consumed by the `service:` task and the reload handler |
| `collection/roles/xinas_uninstall` | loops **both** candidates with `failed_when: false`, so teardown never depends on guessing |

The two health-engine copies are kept byte-identical and enforced by
`tests/test_xiraid_exporter_unit.py::test_health_engine_copies_are_identical`.

## Screen behavior

Management → Integrations → xiRAID Exporter offers:

| Action | Behavior |
|--------|----------|
| **Status** | Installed version via `dpkg-query -W -f='${Version}' xiraid-exporter` (package name — hyphen), service state via the **resolved** unit. Shows the metrics URL. When the package is absent, shows "Not installed" and does not query systemd |
| **Install / Update** | Resolves the latest release from the GitHub API, downloads the `.deb` matching `xiraid.exporter.*\.deb`, installs with `apt`. Reports "already latest" when versions match |
| **Restart** | Confirms, then restarts the **resolved** unit. Refuses when the package is not installed |
| **Uninstall** | Confirms, then `apt-get purge -y xiraid-exporter` (package name — hyphen) |

Install, update, restart, and uninstall are audited (`exporter.install`,
`exporter.restart`, `exporter.uninstall`).

## Rebuild semantics

Changes confined to the TUI, the resolver, or the health engines are
**code-only** — they take effect on the next TUI start and need no
`Requires-Rebuild:` trailer.

Role changes need no trailer either, for a different reason: `xiraid_exporter`
is **not** listed in `playbooks/site.yml`, so the trailer's
`ansible-playbook playbooks/site.yml --tags xiraid_exporter` would match no
tasks and silently do nothing. Role changes here take effect only when the
role is invoked explicitly, and must not carry the trailer — adding one would
train users to click through an Ansible warning that cannot help them.

## Known constraints

- The role pins `xiraid_exporter_version` (currently `1.1.0`) while the TUI
  installs whatever the GitHub API reports as latest. The two paths can
  therefore land different versions on the same host; the TUI is the
  supported route and wins in practice.
- `post_install_menu.sh` carries its own copy of the exporter menu and still
  uses the hyphenated unit name. It is a deprecated day-2 surface (see
  CLAUDE.md, *Shell vs. Python TUI scope*) and is intentionally not fixed —
  use the Python TUI.
