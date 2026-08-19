# Preset Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a preset override role defaults through an untracked variable overlay instead of overwriting the role's `defaults/main.yml`, so an incomplete preset can no longer delete configuration.

**Architecture:** Preset variables and config-editor edits move to
`playbooks/group_vars/all/{10-preset.yml,20-local.yml}`, which Ansible loads
next to the playbook regardless of `--inventory`. Role defaults become
read-only at runtime; `playbooks/site.yml` is always the playbook that runs. One
shell helper library owns reading and writing the overlay, and the three
duplicated `apply_preset` implementations collapse onto it.

**Tech Stack:** Bash (installer menus), `yq` v4 (mikefarah), Ansible (ansible-core 2.21 verified), pytest.

**Spec:** [docs/superpowers/specs/2026-08-18-preset-overlay-design.md](../specs/2026-08-18-preset-overlay-design.md)

## Global Constraints

- All repository artifacts in English (repo `CLAUDE.md` §Language).
- `yq` is mikefarah v4 at `/usr/local/bin/yq`, not the Python wrapper.
- Overlay directory: `playbooks/group_vars/all/`. Preset layer `10-preset.yml`,
  local layer `20-local.yml`. Alphabetical merge, later wins (verified on
  ansible-core 2.21.0).
- Non-variable runtime artefacts: `.xinas-local/` at repo root.
- No runtime writes to any path under `collection/roles/` or to
  `playbooks/site.yml`.
- The `net_controllers` change carries `Requires-Rebuild: net_controllers`. No
  other commit in this plan carries a trailer.
- Verification gate before claiming any task done (repo `CLAUDE.md` §Verification):
  `pytest --cov=xinas_history --cov-fail-under=20`,
  `ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper`,
  `ruff format --check .`, `yamllint -c .yamllint.yml .`,
  `ansible-lint collection/roles/`.
- Commits follow Conventional Commits. Do not push; do not open a PR.

## Deviation from the spec

The spec places the shared helpers in `lib/menu_lib.sh`. This plan puts them in
a new `lib/xinas_config.sh` instead: `menu_lib.sh` is 1389 lines of whiptail
dialog rendering with no config concerns, and `autoinstall.sh` needs the config
helpers without pulling in dialog code. `menu_lib.sh` is untouched.

## File structure

| File | Responsibility |
|---|---|
| `lib/xinas_config.sh` (new) | Overlay paths, effective-value reads, layer writes, preset application, migration bridge. Sourced by both menus and `autoinstall.sh`. |
| `startup_menu.sh` | Calls the helper; keeps its own dialogs. `apply_preset` / `save_preset` bodies replaced. |
| `simple_menu.sh` | Calls the helper. `apply_preset` body replaced. |
| `autoinstall.sh` | Calls the helper instead of its inline `copy_if` block. |
| `configure_raid.sh`, `configure_nfs_exports.sh`, `configure_network.sh` | Read effective, write `20-local.yml`. |
| `collection/roles/net_controllers/{defaults,tasks}/main.yml` | `net_netplan_template` variable. |
| `xinas_history/collector.py` | `CONFIG_SOURCES` gains the overlay. |
| `tests/test_preset_overlay.py` (new) | Helper behaviour, layer precedence, migration. |
| `tests/test_preset_key_ownership.py` (new) | Every preset key is defined by some role. |
| `tests/test_no_runtime_writes_to_tracked.py` (new) | No script writes under `collection/roles/` or to `site.yml`. |
| `tests/test_preset_playbooks.py` | Rewritten: `site.yml` is the source of truth. |

---

### Task 1: Overlay helper library

**Files:**
- Create: `lib/xinas_config.sh`
- Modify: `.gitignore`
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `xinas_overlay_dir()` → prints the overlay directory path;
  `xinas_config_get <key>` → prints the effective value of a top-level key, or
  empty and exit 1 if no layer defines it; `xinas_config_set <layer> <key> <yaml-value>`
  where `<layer>` is `preset` or `local`; `xinas_config_effective` → prints the
  merged YAML document of all role defaults plus both overlay layers.

- [ ] **Step 1: Write the failing test**

Create `tests/test_preset_overlay.py`:

```python
"""The overlay helper is the only writer of preset and operator configuration.

`lib/xinas_config.sh` replaces three copies of an `apply_preset` that overwrote
git-tracked role defaults. These tests drive the shell functions directly.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "lib/xinas_config.sh"


def _run(script: str, repo_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", f'set -eu; REPO_DIR="{repo_dir}"; . "{HELPER}"\n{script}'],
        capture_output=True,
        text=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A minimal tree with one role default and an empty overlay."""
    role = tmp_path / "collection/roles/demo/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("demo_key: from_defaults\nonly_default: yes\n")
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    return tmp_path


def test_get_falls_back_to_role_defaults(repo: Path):
    r = _run("xinas_config_get demo_key", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_defaults"


def test_preset_layer_overrides_role_defaults(repo: Path):
    r = _run("xinas_config_set preset demo_key from_preset; xinas_config_get demo_key", repo)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_preset"


def test_local_layer_beats_preset_layer(repo: Path):
    r = _run(
        "xinas_config_set preset demo_key from_preset;"
        "xinas_config_set local demo_key from_local;"
        "xinas_config_get demo_key",
        repo,
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "from_local"


def test_writes_land_in_the_expected_layer_files(repo: Path):
    _run("xinas_config_set preset a 1; xinas_config_set local b 2", repo)
    gv = repo / "playbooks/group_vars/all"
    assert yaml.safe_load((gv / "10-preset.yml").read_text()) == {"a": 1}
    assert yaml.safe_load((gv / "20-local.yml").read_text()) == {"b": 2}


def test_no_layer_defines_the_key(repo: Path):
    r = _run("xinas_config_get absent_key || echo MISSING", repo)
    assert "MISSING" in r.stdout


def test_role_defaults_are_never_written(repo: Path):
    before = (repo / "collection/roles/demo/defaults/main.yml").read_text()
    _run("xinas_config_set preset demo_key changed; xinas_config_set local x 1", repo)
    assert (repo / "collection/roles/demo/defaults/main.yml").read_text() == before
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: every test fails — `lib/xinas_config.sh` does not exist, so the
`source` in `_run` returns non-zero and stdout is empty.

- [ ] **Step 3: Write the helper**

Create `lib/xinas_config.sh`:

```bash
#!/usr/bin/env bash
# Configuration layers for xiNAS.
#
#   collection/roles/*/defaults/main.yml   base, git-tracked, never written
#   playbooks/group_vars/all/10-preset.yml  preset overlay, untracked
#   playbooks/group_vars/all/20-local.yml   operator overlay, untracked, wins
#
# The overlay sits next to the playbook, not the inventory: autoinstall.sh
# accepts --inventory, and Ansible only resolves inventory-adjacent group_vars
# when the inventory is the repo's own. Files in group_vars/all/ merge
# alphabetically, so 20- beats 10-.

: "${REPO_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

XINAS_OVERLAY_DIR="$REPO_DIR/playbooks/group_vars/all"
XINAS_PRESET_LAYER="$XINAS_OVERLAY_DIR/10-preset.yml"
XINAS_LOCAL_LAYER="$XINAS_OVERLAY_DIR/20-local.yml"
XINAS_LOCAL_ARTEFACTS="$REPO_DIR/.xinas-local"

xinas_overlay_dir() { printf '%s\n' "$XINAS_OVERLAY_DIR"; }

_xinas_layer_path() {
    case "$1" in
        preset) printf '%s\n' "$XINAS_PRESET_LAYER" ;;
        local)  printf '%s\n' "$XINAS_LOCAL_LAYER" ;;
        *) echo "unknown config layer: $1" >&2; return 2 ;;
    esac
}

# Every role default, then the preset layer, then the local layer. Later wins.
xinas_config_effective() {
    local -a files=()
    local f
    while IFS= read -r f; do files+=("$f"); done < <(
        find "$REPO_DIR/collection/roles" -path '*/defaults/main.yml' 2>/dev/null | sort
    )
    if [ -f "$XINAS_PRESET_LAYER" ]; then files+=("$XINAS_PRESET_LAYER"); fi
    if [ -f "$XINAS_LOCAL_LAYER" ];  then files+=("$XINAS_LOCAL_LAYER");  fi
    if [ ${#files[@]} -eq 0 ]; then echo '{}'; return 0; fi
    yq eval-all '. as $item ireduce ({}; . * $item)' "${files[@]}"
}

xinas_config_get() {
    local key="$1" out
    out=$(xinas_config_effective | yq eval ".${key} // \"__XINAS_ABSENT__\"" -)
    if [ "$out" = "__XINAS_ABSENT__" ]; then return 1; fi
    printf '%s\n' "$out"
}

# Value is parsed as YAML, so `xinas_config_set local net_mtu 9000` stores an
# int and `... net_manual_ips '{}'` stores a mapping.
xinas_config_set() {
    local layer="$1" key="$2" value="$3" path tmp
    path=$(_xinas_layer_path "$layer") || return 2
    mkdir -p "$(dirname "$path")"
    [ -f "$path" ] || printf -- '---\n' > "$path"
    tmp=$(mktemp)
    XINAS_VALUE="$value" yq eval ".${key} = (env(XINAS_VALUE) | from_yaml)" "$path" > "$tmp"
    mv "$tmp" "$path"
}

# Replace a whole layer from a YAML document on stdin.
xinas_config_replace_layer() {
    local layer="$1" path
    path=$(_xinas_layer_path "$layer") || return 2
    mkdir -p "$(dirname "$path")"
    cat > "$path"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: 6 passed.

- [ ] **Step 5: Ignore the overlay and the local artefacts**

Append to `.gitignore`:

```
# Live configuration layers (preset apply + config editors write here).
# Untracked on purpose: the update flow runs `git checkout --force`, which
# discards tracked modifications. See docs/Installer/update-spec.md.
playbooks/group_vars/
.xinas-local/
```

- [ ] **Step 6: Commit**

```bash
git add lib/xinas_config.sh tests/test_preset_overlay.py .gitignore
git commit -m "feat(installer): add the configuration overlay helper"
```

---

### Task 2: Apply presets into the overlay, from one implementation

**Files:**
- Modify: `lib/xinas_config.sh`
- Modify: `startup_menu.sh:574-609`, `simple_menu.sh:504-534`, `autoinstall.sh:231-249`
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: `xinas_config_replace_layer`, `_xinas_layer_path` from Task 1.
- Produces: `xinas_apply_preset <preset-name>` → merges the preset's four var
  files and its playbook `vars:` into `10-preset.yml`, writes
  `/opt/xiNAS/.xinas_applied_preset`, prints one `- <description>` line per
  applied part on stdout for the caller's dialog. Returns 2 on a missing preset
  directory, 3 if the preset ships a forbidden `netplan.yaml.j2`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preset_overlay.py`:

```python
def _preset_repo(tmp_path: Path) -> Path:
    role = tmp_path / "collection/roles/demo/defaults"
    role.mkdir(parents=True)
    (role / "main.yml").write_text("demo_key: from_defaults\nsurvivor: yes\n")
    preset = tmp_path / "presets/vm"
    preset.mkdir(parents=True)
    (preset / "raid_fs.yml").write_text("demo_key: from_preset\n")
    (preset / "nvme_namespace.yml").write_text("nvme_key: 5\n")
    (preset / "playbook.yml").write_text(
        "---\n- hosts: storage_nodes\n  vars:\n    perf_nr_requests: 0\n  roles: [demo]\n"
    )
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    return tmp_path


def test_apply_preset_merges_every_var_file(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run("xinas_apply_preset vm", repo)
    assert r.returncode == 0, r.stderr
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert layer == {"demo_key": "from_preset", "nvme_key": 5, "perf_nr_requests": 0}


def test_apply_preset_does_not_delete_keys_it_omits(tmp_path: Path):
    """The whole point: `survivor` is in the defaults and in no preset file."""
    repo = _preset_repo(tmp_path)
    _run("xinas_apply_preset vm", repo)
    r = _run("xinas_config_get survivor", repo)
    assert r.stdout.strip() == "true"


def test_apply_preset_replaces_rather_than_accumulates(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    _run("xinas_config_set preset stale_key 1; xinas_apply_preset vm", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert "stale_key" not in layer


def test_apply_preset_keeps_operator_edits(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    _run("xinas_config_set local demo_key from_operator; xinas_apply_preset vm", repo)
    r = _run("xinas_config_get demo_key", repo)
    assert r.stdout.strip() == "from_operator"


def test_apply_preset_rejects_a_preset_netplan_template(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    (repo / "presets/vm/netplan.yaml.j2").write_text("network: {}\n")
    r = _run("xinas_apply_preset vm || echo RC=$?", repo)
    assert "RC=3" in r.stdout


def test_apply_preset_unknown_name(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run("xinas_apply_preset nope || echo RC=$?", repo)
    assert "RC=2" in r.stdout
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q -k apply_preset`
Expected: 6 failures — `xinas_apply_preset: command not found`.

- [ ] **Step 3: Implement `xinas_apply_preset`**

Append to `lib/xinas_config.sh`:

```bash
# Var files a preset may contribute. The role each one is named after is
# irrelevant to the merge: Ansible resolves all of these in one host scope, and
# presets already cross the boundary (presets/default/raid_fs.yml sets nvme_*).
XINAS_PRESET_VAR_FILES=(network.yml raid_fs.yml nvme_namespace.yml nfs_exports.yml)

xinas_apply_preset() {
    local preset="$1" pdir="$REPO_DIR/presets/$1"
    [ -d "$pdir" ] || { echo "preset not found: $preset" >&2; return 2; }

    # A preset netplan template replaced the role's dynamic one and stranded
    # every NIC; tests/test_net_controllers_template.py forbids it. Fail loudly
    # rather than silently ignoring a file the author expected to take effect.
    if [ -f "$pdir/netplan.yaml.j2" ]; then
        echo "preset $preset ships netplan.yaml.j2, which is not supported" >&2
        return 3
    fi

    local -a sources=()
    local f
    for f in "${XINAS_PRESET_VAR_FILES[@]}"; do
        if [ -f "$pdir/$f" ]; then sources+=("$pdir/$f"); echo "- $f"; fi
    done

    # The preset's playbook contributes its play vars only; its role list is
    # pinned equal to playbooks/site.yml by tests/test_preset_playbooks.py.
    local playvars=""
    if [ -f "$pdir/playbook.yml" ]; then
        playvars=$(yq eval '.[0].vars // {}' "$pdir/playbook.yml")
        if [ "$playvars" != "{}" ] && [ -n "$playvars" ]; then
            local tmp_pv
            tmp_pv=$(mktemp); printf '%s\n' "$playvars" > "$tmp_pv"
            sources+=("$tmp_pv"); echo "- playbook vars"
        fi
    fi

    if [ ${#sources[@]} -eq 0 ]; then
        printf -- '---\n' | xinas_config_replace_layer preset
    else
        yq eval-all '. as $item ireduce ({}; . * $item)' "${sources[@]}" \
            | xinas_config_replace_layer preset
    fi

    echo "$preset" > /opt/xiNAS/.xinas_applied_preset 2>/dev/null || true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: 12 passed.

- [ ] **Step 5: Replace the three call sites**

In `startup_menu.sh`, delete the body of `apply_preset` (lines 574-609) and replace with:

```bash
apply_preset() {
    local preset="$1" applied rc=0
    applied=$(xinas_apply_preset "$preset") || rc=$?
    case "$rc" in
        0) msg_box "Preset Applied" "Applying preset: $preset\n$applied" ;;
        2) msg_box "Error" "Preset $preset not found" ;;
        3) msg_box "Error" "Preset $preset ships a netplan template, which is not supported" ;;
        *) msg_box "Error" "Preset $preset could not be applied" ;;
    esac
}
```

Add `. "$REPO_DIR/lib/xinas_config.sh"` next to the existing `menu_lib.sh`
source line. Apply the identical replacement to `simple_menu.sh:504-534`.

In `autoinstall.sh`, delete the `copy_if` block (lines 231-249) and replace with:

```bash
step "Applying preset: $preset"
. "$(dirname "$0")/lib/xinas_config.sh"
xinas_apply_preset "$preset_dir_name" || die "preset apply failed: $preset_dir_name"
ok "Preset applied"
```

- [ ] **Step 6: Verify no call site still copies**

Run: `grep -rn "defaults/main.yml" startup_menu.sh simple_menu.sh autoinstall.sh`
Expected: no output.

Run: `bash -n startup_menu.sh && bash -n simple_menu.sh && bash -n autoinstall.sh`
Expected: no output (syntax clean). `tests/test_bash_syntax_sweep.py` covers this in CI.

- [ ] **Step 7: Commit**

```bash
git add lib/xinas_config.sh tests/test_preset_overlay.py startup_menu.sh simple_menu.sh autoinstall.sh
git commit -m "feat(installer): apply presets into the overlay from one implementation"
```

---

### Task 3: `site.yml` is the playbook that runs

**Files:**
- Modify: `startup_menu.sh`, `simple_menu.sh` (remove the `playbook.yml` copy — already gone after Task 2; this task removes the *contract*)
- Modify: `tests/test_preset_playbooks.py`
- Test: `tests/test_preset_playbooks.py`

**Interfaces:**
- Consumes: `xinas_apply_preset` from Task 2.
- Produces: nothing new. Establishes the invariant later tasks rely on: every
  install runs `playbooks/site.yml`.

- [ ] **Step 1: Write the failing test**

Replace the body of `tests/test_preset_playbooks.py` below its imports with:

```python
REPO_ROOT = Path(__file__).resolve().parents[1]
PRESETS = ["default", "xinnorVM"]
SITE = REPO_ROOT / "playbooks/site.yml"


def _roles(doc_path: Path) -> list[str]:
    doc = yaml.safe_load(doc_path.read_text())
    return [r["role"] if isinstance(r, dict) else r for r in doc[0]["roles"]]


def _preset_playbook(preset: str) -> Path:
    return REPO_ROOT / "presets" / preset / "playbook.yml"


def test_presets_deploy_nfs_helper():
    for preset in PRESETS:
        assert "xinas_nfs_helper" in _roles(_preset_playbook(preset)), (
            f"{preset} preset does not deploy xinas_nfs_helper (finding #14)"
        )


def test_nfs_helper_runs_before_legacy_mcp():
    for preset in PRESETS:
        order = _roles(_preset_playbook(preset))
        if "xinas_mcp" in order:
            assert order.index("xinas_nfs_helper") < order.index("xinas_mcp"), (
                f"{preset}: helper must precede the xinas_mcp daemon that uses it"
            )


def test_preset_role_lists_match_site_yml():
    """Presets contribute variables, not play structure.

    The installer no longer copies a preset playbook over `playbooks/site.yml`,
    so `site.yml` is what runs. A preset whose role list drifts from it would
    silently document a deployment that never happens.
    """
    expected = _roles(SITE)
    for preset in PRESETS:
        assert _roles(_preset_playbook(preset)) == expected, (
            f"{preset}: role list differs from playbooks/site.yml"
        )


def test_site_yml_keeps_the_xiraid_skip_guard():
    """`-e xiraid_skip_install=true` was inert while a preset playbook — which
    carries no guard — was copied over site.yml. Both existing-RAID paths
    (autoinstall --preset existing-raid, startup_menu.sh) depend on it."""
    doc = yaml.safe_load(SITE.read_text())
    entry = next(r for r in doc[0]["roles"] if isinstance(r, dict) and r["role"] == "xiraid_classic")
    assert "xiraid_skip_install" in str(entry.get("when", "")), (
        "playbooks/site.yml no longer guards xiraid_classic with xiraid_skip_install"
    )
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_playbooks.py -q`
Expected: `test_preset_role_lists_match_site_yml` FAILS — `presets/default/playbook.yml`
and `presets/xinnorVM/playbook.yml` list `nvme_namespace` where `site.yml` has a
dict entry for `xiraid_classic` carrying `when:`; the extracted role *names* are
equal, so confirm the failure is real before proceeding. If it passes, the role
lists already agree and only the guard test is new.

- [ ] **Step 3: Update the preset playbooks' docstring context**

Replace the module docstring of `tests/test_preset_playbooks.py`:

```python
"""Preset playbooks document intent; `playbooks/site.yml` is what runs.

Finding #14 (InstallationFeedback-2026-05-28): the `xinas_nfs_helper` role
shipped without any preset playbook invoking it. At that time `autoinstall.sh`
copied `presets/<name>/playbook.yml` over `playbooks/site.yml`, so the preset
playbook *was* the source of truth. That copy is gone — presets now contribute
variables only — so these tests pin two things: the historical helper ordering,
and that no preset's role list drifts away from the playbook that actually runs.
"""
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_playbooks.py -q`
Expected: 4 passed.

- [ ] **Step 5: Verify the guard is live end to end**

Run:

```bash
grep -n "xiraid_skip_install" playbooks/site.yml presets/*/playbook.yml
```

Expected: the guard appears in `playbooks/site.yml` only. That is correct — the
preset playbooks no longer run, so their lack of a guard is now inert rather
than harmful.

- [ ] **Step 6: Commit**

```bash
git add tests/test_preset_playbooks.py
git commit -m "test(installer): pin preset role lists to playbooks/site.yml"
```

---

### Task 4: `net_netplan_template` variable

**Files:**
- Modify: `collection/roles/net_controllers/defaults/main.yml`
- Modify: `collection/roles/net_controllers/tasks/main.yml:188`, `:225`
- Test: `tests/test_net_controllers_template.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `net_netplan_template`, an Ansible variable read by both `template:`
  tasks. Task 5 sets it in `20-local.yml`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_net_controllers_template.py`:

```python
def test_template_src_is_a_variable():
    """Manual-mode netplan must be writable without touching the tracked role
    template. Both deploy tasks read the same variable so pool mode and manual
    mode cannot diverge."""
    tasks = yaml.safe_load((REPO / "collection/roles/net_controllers/tasks/main.yml").read_text())
    srcs = [
        t["ansible.builtin.template"]["src"]
        for t in tasks
        if isinstance(t, dict) and "ansible.builtin.template" in t
        and str(t["ansible.builtin.template"].get("dest", "")).endswith("99-xinas.yaml")
    ]
    assert srcs, "no netplan deploy task found"
    assert all(s == "{{ net_netplan_template }}" for s in srcs), srcs


def test_template_variable_defaults_to_the_role_template():
    defaults = yaml.safe_load(
        (REPO / "collection/roles/net_controllers/defaults/main.yml").read_text()
    )
    assert defaults["net_netplan_template"] == "netplan.yaml.j2"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_net_controllers_template.py -q`
Expected: both new tests FAIL — `src` is the literal `netplan.yaml.j2`, and
`net_netplan_template` raises `KeyError`.

- [ ] **Step 3: Add the variable and use it**

Append to `collection/roles/net_controllers/defaults/main.yml`:

```yaml
# Netplan template to render. Role-relative by default; configure_network.sh
# manual mode points this at an absolute path under .xinas-local/ so it never
# writes the tracked role template. Ansible's template lookup accepts both.
net_netplan_template: netplan.yaml.j2
```

In `collection/roles/net_controllers/tasks/main.yml`, change `src: netplan.yaml.j2`
to `src: "{{ net_netplan_template }}"` at both line 189 and line 226.

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_net_controllers_template.py -q`
Expected: all pass.

- [ ] **Step 5: Lint the role**

Run: `ansible-lint collection/roles/net_controllers/ && yamllint -c .yamllint.yml collection/roles/net_controllers/`
Expected: no findings.

- [ ] **Step 6: Commit — this one carries the trailer**

```bash
git add collection/roles/net_controllers tests/test_net_controllers_template.py
git commit -m "feat(net_controllers): make the netplan template path a variable

The role rendered a hardcoded templates/netplan.yaml.j2, so manual-mode network
configuration had to overwrite a git-tracked file. Both deploy tasks now read
net_netplan_template, defaulting to the same role-relative template.

Requires-Rebuild: net_controllers"
```

---

### Task 5: Config editors read effective, write `20-local.yml`

**Files:**
- Modify: `configure_raid.sh:18-19,45-98,164-178`
- Modify: `configure_nfs_exports.sh:18,28-56,68-71`
- Modify: `configure_network.sh:9-10,51-88,171-172,238-239,262-265`
- Modify: `simple_menu.sh:428-436,477-479`
- Modify: `startup_menu.sh:287-299`
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: `xinas_config_get`, `xinas_config_set`, `xinas_config_effective`,
  `XINAS_LOCAL_ARTEFACTS` from Task 1; `net_netplan_template` from Task 4.
- Produces: `xinas_config_seed_local <key>` → if `20-local.yml` lacks the key,
  copy its effective value in, so a read-modify-write edit starts from the
  value the operator is actually looking at.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preset_overlay.py`:

```python
def test_seed_local_copies_the_effective_value(repo: Path):
    _run("xinas_config_set preset demo_key from_preset; xinas_config_seed_local demo_key", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert layer == {"demo_key": "from_preset"}


def test_seed_local_leaves_an_existing_local_value_alone(repo: Path):
    _run(
        "xinas_config_set local demo_key mine;"
        "xinas_config_set preset demo_key theirs;"
        "xinas_config_seed_local demo_key",
        repo,
    )
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert layer == {"demo_key": "mine"}


def test_seed_local_seeds_only_the_named_key(repo: Path):
    """Seeding the whole document would turn the overlay into a second frozen
    snapshot of the defaults — the failure mode this design exists to remove."""
    _run("xinas_config_seed_local demo_key", repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/20-local.yml").read_text())
    assert set(layer) == {"demo_key"}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q -k seed_local`
Expected: 3 failures — `xinas_config_seed_local: command not found`.

- [ ] **Step 3: Implement the seed helper**

Append to `lib/xinas_config.sh`:

```bash
# Read-modify-write editors need the value the operator sees, not the release
# default. Seed exactly one key so the overlay stays an override set.
xinas_config_seed_local() {
    local key="$1" existing value
    existing=$(yq eval ".${key} // \"__XINAS_ABSENT__\"" "$XINAS_LOCAL_LAYER" 2>/dev/null || echo __XINAS_ABSENT__)
    if [ "$existing" != "__XINAS_ABSENT__" ]; then return 0; fi
    value=$(xinas_config_effective | yq eval ".${key} // \"__XINAS_ABSENT__\"" -)
    if [ "$value" = "__XINAS_ABSENT__" ]; then return 0; fi
    xinas_config_set local "$key" "$value"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: all pass.

- [ ] **Step 5: Repoint `configure_raid.sh`**

Source the helper after the existing `menu_lib.sh` source, then replace the two
path variables:

```bash
. "$(dirname "$0")/lib/xinas_config.sh"
vars_file="$XINAS_LOCAL_LAYER"
auto_vars_file="$XINAS_LOCAL_LAYER"
```

Before each `yq` **read** (`configure_raid.sh:45`, `:50`, `:104`) read from the
effective document instead of the file:

```bash
xinas_config_effective | yq -r ".xiraid_arrays[] | select(.level==${level}) | .devices | join(\" \")"
```

Before each `yq` **write** (`:59`, `:96`, `:176`) call `xinas_config_seed_local`
for the key being edited — `xiraid_spare_pools`, `xiraid_arrays`,
`nvme_auto_namespace` respectively — then keep the existing write, which now
targets `$XINAS_LOCAL_LAYER`.

- [ ] **Step 6: Repoint `configure_nfs_exports.sh`**

Same shape: `vars_file="$XINAS_LOCAL_LAYER"`, reads at `:28`, `:29`, `:68`, `:71`
go through `xinas_config_effective`, and `xinas_config_seed_local exports`
precedes the writes at `:36` and `:54`.

- [ ] **Step 7: Repoint `configure_network.sh` — pool mode**

Replace `save_pool_settings` (lines 64-85) entirely:

```bash
# Targeted writes, not a document rewrite: the previous `cat >` emitted a fixed
# eight-key file and silently dropped every other key in the role defaults.
save_pool_settings() {
    local start="$1" end="$2" prefix="$3"
    xinas_config_set local net_ip_pool_enabled true
    xinas_config_set local net_ip_pool_start "\"$start\""
    xinas_config_set local net_ip_pool_end "\"$end\""
    xinas_config_set local net_ip_pool_prefix "$prefix"
}
```

Replace the reads in `get_pool_settings` (lines 51-56) with `xinas_config_get`
calls, and the two `yq -i '.net_ip_pool_enabled = ...' "$ROLE_DEFAULTS"` writes
(lines 172, 239) with `xinas_config_set local net_ip_pool_enabled false` / `true`.
Delete the `ROLE_DEFAULTS` variable (line 9).

- [ ] **Step 8: Repoint `configure_network.sh` — manual mode**

Replace line 10 and the write at lines 262-265:

```bash
LIVE_TEMPLATE="$XINAS_LOCAL_ARTEFACTS/netplan.yaml.j2"
```

```bash
    mkdir -p "$XINAS_LOCAL_ARTEFACTS"
    backup_if_changed "$LIVE_TEMPLATE" "$tmp_file"
    mv "$tmp_file" "$LIVE_TEMPLATE"
    xinas_config_set local net_netplan_template "\"$LIVE_TEMPLATE\""
    msg_box "Manual Config Saved" "Manual configuration saved to:\n$LIVE_TEMPLATE\n\nNote: IP pool is DISABLED in manual mode."
```

In the pool-mode re-enable path (line 239), drop the override so a stale manual
template cannot outlive manual mode:

```bash
    yq -i 'del(.net_netplan_template)' "$XINAS_LOCAL_LAYER" 2>/dev/null || true
    rm -f "$LIVE_TEMPLATE"
```

- [ ] **Step 9: Repoint the two in-menu writers**

Pre-flight found these outside the three `configure_*.sh`; they are the same
defect and Task 9's contract test fails without them.

In `simple_menu.sh`, the existing-RAID wizard writes six values into three role
defaults. Replace lines 428-430 with a single target:

```bash
    # All configuration writes land in the overlay; role defaults are read-only.
    local auto_vars="$XINAS_LOCAL_LAYER"
    local raid_vars="$XINAS_LOCAL_LAYER"
    local xiraid_vars="$XINAS_LOCAL_LAYER"
```

The four `yq -i` calls at lines 432-435 and the two structural writes at
lines 477-478 then need no further change — they already write through these
variables. Source `lib/xinas_config.sh` near the top of the script, next to the
existing `menu_lib.sh` source.

In `startup_menu.sh`, `configure_nfs_shares()` reads the exports defaults
directly at line 287 and would display the release value rather than the
effective one. Replace the `vars_file` assignment and the three reads that
follow it:

```bash
    local vars_file="$TMP_DIR/effective_exports.yml"
    xinas_config_effective > "$vars_file"
```

The existing `grep`/`sed`/`awk` reads against `$vars_file` then operate on the
effective document and need no further change.

- [ ] **Step 10: Verify no editor writes a tracked path**

Run: `grep -n "collection/roles" configure_raid.sh configure_nfs_exports.sh configure_network.sh simple_menu.sh`
Expected: no output. (`startup_menu.sh:453` keeps a `collection/roles/<r>/README.md`
read for role descriptions — that is a read of documentation, not config, and stays.)

Run: `for f in configure_raid.sh configure_nfs_exports.sh configure_network.sh simple_menu.sh startup_menu.sh; do bash -n "$f"; done`
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add lib/xinas_config.sh tests/test_preset_overlay.py configure_raid.sh configure_nfs_exports.sh configure_network.sh simple_menu.sh startup_menu.sh
git commit -m "fix(installer): config editors write the overlay, not role defaults"
```

---

### Task 6: `save_preset` decomposes the overlay

**Files:**
- Modify: `lib/xinas_config.sh`
- Modify: `startup_menu.sh:640-658`
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: `xinas_config_effective`, `XINAS_PRESET_LAYER`, `XINAS_LOCAL_LAYER`
  from Task 1. (It does **not** use `XINAS_PRESET_VAR_FILES`; it defines its own
  `_xinas_role_preset_file` map below.)
- Produces: `xinas_key_owner <key>` → prints the preset filename that owns a
  key, or exit 1; `xinas_save_preset <name>` → writes the preset directory.

**Key→file map.** A key is routed by which role's `defaults/main.yml` defines
it, then that role maps to a preset filename:

| Role | Preset file |
|---|---|
| `net_controllers` | `network.yml` |
| `raid_fs` | `raid_fs.yml` |
| `nvme_namespace` | `nvme_namespace.yml` |
| `exports` | `nfs_exports.yml` |
| any other role | `raid_fs.yml` is **not** a catch-all — the key is reported and skipped |

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preset_overlay.py`:

```python
def _save_repo(tmp_path: Path) -> Path:
    for role, body in (
        ("net_controllers", "net_mtu: 0\n"),
        ("nvme_namespace", "nvme_raid_data_level: 5\n"),
        ("perf_tuning", "perf_nr_requests: 128\n"),
    ):
        d = tmp_path / f"collection/roles/{role}/defaults"
        d.mkdir(parents=True)
        (d / "main.yml").write_text(body)
    (tmp_path / "playbooks/group_vars/all").mkdir(parents=True)
    (tmp_path / "playbooks/site.yml").write_text("---\n- hosts: storage_nodes\n  roles: []\n")
    return tmp_path


def test_save_preset_routes_keys_by_owning_role(tmp_path: Path):
    repo = _save_repo(tmp_path)
    _run(
        "xinas_config_set local net_mtu 9000;"
        "xinas_config_set preset nvme_raid_data_level 6;"
        "xinas_save_preset saved",
        repo,
    )
    p = repo / "presets/saved"
    assert yaml.safe_load((p / "network.yml").read_text()) == {"net_mtu": 9000}
    assert yaml.safe_load((p / "nvme_namespace.yml").read_text()) == {"nvme_raid_data_level": 6}


def test_save_preset_reports_a_key_no_preset_file_owns(tmp_path: Path):
    """perf_tuning has no preset file; the key cannot round-trip, so it is
    named rather than silently dropped into an unrelated file."""
    repo = _save_repo(tmp_path)
    r = _run("xinas_config_set local perf_nr_requests 0; xinas_save_preset saved", repo)
    assert "perf_nr_requests" in (r.stdout + r.stderr)


def test_save_preset_copies_site_yml_as_the_playbook(tmp_path: Path):
    repo = _save_repo(tmp_path)
    _run("xinas_save_preset saved", repo)
    assert (repo / "presets/saved/playbook.yml").read_text() == (
        repo / "playbooks/site.yml"
    ).read_text()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q -k save_preset`
Expected: 3 failures — `xinas_save_preset: command not found`.

- [ ] **Step 3: Implement**

Append to `lib/xinas_config.sh`:

```bash
# role -> preset filename. A role absent from this map has no preset file, so
# an overlay key it owns cannot round-trip through save/apply.
_xinas_role_preset_file() {
    case "$1" in
        net_controllers) echo network.yml ;;
        raid_fs)         echo raid_fs.yml ;;
        nvme_namespace)  echo nvme_namespace.yml ;;
        exports)         echo nfs_exports.yml ;;
        *) return 1 ;;
    esac
}

xinas_key_owner() {
    local key="$1" f role
    while IFS= read -r f; do
        if yq eval "has(\"$key\")" "$f" | grep -qx true; then
            role=$(basename "$(dirname "$(dirname "$f")")")
            _xinas_role_preset_file "$role" && return 0
        fi
    done < <(find "$REPO_DIR/collection/roles" -path '*/defaults/main.yml' | sort)
    return 1
}

xinas_save_preset() {
    local name="$1" pdir="$REPO_DIR/presets/$1" key file
    mkdir -p "$pdir"
    local overlay; overlay=$(mktemp)
    yq eval-all '. as $item ireduce ({}; . * $item)' \
        "$XINAS_PRESET_LAYER" "$XINAS_LOCAL_LAYER" 2>/dev/null > "$overlay" || echo '{}' > "$overlay"

    while IFS= read -r key; do
        if [ -z "$key" ]; then continue; fi
        if ! file=$(xinas_key_owner "$key"); then
            echo "skipped: no preset file owns '$key'" >&2
            continue
        fi
        [ -f "$pdir/$file" ] || printf -- '---\n' > "$pdir/$file"
        local value tmp
        value=$(yq eval ".${key}" "$overlay")
        tmp=$(mktemp)
        XINAS_VALUE="$value" yq eval ".${key} = (env(XINAS_VALUE) | from_yaml)" "$pdir/$file" > "$tmp"
        mv "$tmp" "$pdir/$file"
    done < <(yq eval 'keys | .[]' "$overlay")

    cp "$REPO_DIR/playbooks/site.yml" "$pdir/playbook.yml"
    if [ -f "$XINAS_LOCAL_ARTEFACTS/netplan.yaml.j2" ]; then
        echo "note: manual netplan template not saved (presets may not ship one)" >&2
    fi
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: all pass.

- [ ] **Step 5: Repoint the menu**

Replace the `cp` block in `startup_menu.sh:652-657` with:

```bash
    local skipped
    skipped=$(xinas_save_preset "$preset" 2>&1 >/dev/null)
    if [ -n "$skipped" ]; then
        msg_box "Preset Saved (with notes)" "Preset saved to $pdir\n\n$skipped"
    else
        msg_box "Preset Saved" "Preset saved to $pdir"
    fi
```

- [ ] **Step 6: Commit**

```bash
git add lib/xinas_config.sh tests/test_preset_overlay.py startup_menu.sh
git commit -m "feat(installer): save_preset decomposes the overlay by owning role"
```

---

### Task 7: Migration bridge

**Files:**
- Modify: `lib/xinas_config.sh`
- Modify: `startup_menu.sh`, `simple_menu.sh`, `autoinstall.sh` (one call each, at startup)
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: `xinas_apply_preset` from Task 2.
- Produces: `xinas_migrate_overlay` → idempotent; prints one line describing
  what it did, or nothing when already migrated.

**Why the marker and not the files.** The update flow runs
`git checkout --force` before any new code executes
(`xinas_menu/utils/update_check.py:570`,
`collection/roles/xinas_menu/files/xinas-update-git:36`), so the mutated role
defaults are already gone by the time this runs. `/opt/xiNAS/.xinas_applied_preset`
is untracked and survives. Config-editor edits made before migration are not
recoverable and Task 10 documents that.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preset_overlay.py`:

```python
def test_migration_reapplies_the_marked_preset(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    marker = tmp_path / "marker"
    marker.write_text("vm\n")
    r = _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    assert r.returncode == 0, r.stderr
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert layer["demo_key"] == "from_preset"


def test_migration_is_a_noop_once_migrated(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    marker = tmp_path / "marker"
    marker.write_text("vm\n")
    _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    _run("xinas_config_set preset demo_key edited_after_migration", repo)
    _run(f'XINAS_PRESET_MARKER="{marker}" xinas_migrate_overlay', repo)
    layer = yaml.safe_load((repo / "playbooks/group_vars/all/10-preset.yml").read_text())
    assert layer["demo_key"] == "edited_after_migration"


def test_migration_without_a_marker_leaves_the_overlay_absent(tmp_path: Path):
    repo = _preset_repo(tmp_path)
    r = _run(f'XINAS_PRESET_MARKER="{tmp_path}/absent" xinas_migrate_overlay', repo)
    assert r.returncode == 0, r.stderr
    assert not (repo / "playbooks/group_vars/all/10-preset.yml").exists()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q -k migration`
Expected: 3 failures — `xinas_migrate_overlay: command not found`.

- [ ] **Step 3: Implement**

Append to `lib/xinas_config.sh`:

```bash
: "${XINAS_PRESET_MARKER:=/opt/xiNAS/.xinas_applied_preset}"

# One-shot bridge from the file-replacement era. Runs before the menus draw.
xinas_migrate_overlay() {
    if [ -f "$XINAS_PRESET_LAYER" ]; then return 0; fi
    if [ ! -f "$XINAS_PRESET_MARKER" ]; then return 0; fi
    local preset
    preset=$(tr -d '[:space:]' < "$XINAS_PRESET_MARKER")
    if [ -z "$preset" ]; then return 0; fi
    [ -d "$REPO_DIR/presets/$preset" ] || {
        echo "migration: preset '$preset' from the marker no longer exists" >&2
        return 0
    }
    xinas_apply_preset "$preset" >/dev/null || return 0
    echo "migrated: re-applied preset '$preset' into the configuration overlay"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: all pass.

- [ ] **Step 5: Call it at startup**

In `startup_menu.sh` and `simple_menu.sh`, immediately after sourcing
`lib/xinas_config.sh`:

```bash
migrated=$(xinas_migrate_overlay) || true
if [ -n "$migrated" ]; then msg_box "Configuration Migrated" "$migrated"; fi
```

In `autoinstall.sh`, after the source line added in Task 2:

```bash
migrated=$(xinas_migrate_overlay) || true
if [ -n "$migrated" ]; then info "$migrated"; fi
```

- [ ] **Step 6: Commit**

```bash
git add lib/xinas_config.sh tests/test_preset_overlay.py startup_menu.sh simple_menu.sh autoinstall.sh
git commit -m "feat(installer): migrate legacy preset state into the overlay"
```

---

### Task 8: `xinas_history` sees the overlay

**Files:**
- Modify: `xinas_history/collector.py:16-25`
- Modify: `docs/config-history/specs.md:203`
- Test: `tests/test_system_files_payload.py`

**Interfaces:**
- Consumes: the overlay paths from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_system_files_payload.py`:

```python
def test_config_sources_cover_the_overlay():
    """Role defaults became immutable between releases; the desired state a
    snapshot must capture now lives in the overlay. Without these entries,
    snapshot, diff and drift detection are blind to every config change."""
    from xinas_history.collector import CONFIG_SOURCES

    values = set(CONFIG_SOURCES.values())
    assert "playbooks/group_vars/all/10-preset.yml" in values
    assert "playbooks/group_vars/all/20-local.yml" in values
    assert ".xinas-local/netplan.yaml.j2" in values
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_system_files_payload.py -q -k overlay`
Expected: FAIL on the first assertion.

- [ ] **Step 3: Extend `CONFIG_SOURCES`**

In `xinas_history/collector.py`, add to the `CONFIG_SOURCES` dict:

```python
    # Live configuration layers. Role defaults above are the immutable base and
    # stay in the list because they change across releases; these two carry the
    # desired state that presets and the config editors actually set.
    "overlay.preset.yml": "playbooks/group_vars/all/10-preset.yml",
    "overlay.local.yml": "playbooks/group_vars/all/20-local.yml",
    "netplan.live.j2": ".xinas-local/netplan.yaml.j2",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_system_files_payload.py -q`
Expected: all pass. Absent files are already handled — see
`tests/test_absent_files_manifest.py`, which covers sources that do not exist on
a given host.

- [ ] **Step 5: Update the durable spec**

In `docs/config-history/specs.md` at the collected-sources list (line 203), add
the three sources with one sentence explaining that role defaults are the
immutable base and the overlay carries desired state.

- [ ] **Step 6: Commit**

```bash
git add xinas_history/collector.py tests/test_system_files_payload.py docs/config-history/specs.md
git commit -m "feat(history): snapshot the configuration overlay"
```

---

### Task 9: Contract tests

**Files:**
- Create: `tests/test_preset_key_ownership.py`
- Create: `tests/test_no_runtime_writes_to_tracked.py`

**Interfaces:**
- Consumes: the finished state of Tasks 2, 5, 6.
- Produces: nothing.

- [ ] **Step 1: Write `tests/test_preset_key_ownership.py`**

```python
"""Every key a preset sets must be defined by some role's defaults.

Not "by the role the preset file is named after": `presets/default/raid_fs.yml`
legitimately sets five `nvme_*` keys that `nvme_namespace` defines and `raid_fs`
does not. Ansible merges all role defaults into one host scope, and after the
overlay change every preset var file lands in one merged document, so the
filename does not partition the keyspace. What the test does catch is a key no
role defines at all — a typo, or a rename that left the preset behind.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
PRESET_VAR_FILES = ("network.yml", "raid_fs.yml", "nvme_namespace.yml", "nfs_exports.yml")


def _all_role_default_keys() -> set[str]:
    keys: set[str] = set()
    for path in (REPO / "collection/roles").glob("*/defaults/main.yml"):
        doc = yaml.safe_load(path.read_text()) or {}
        keys |= set(doc)
    return keys


def test_every_preset_key_is_defined_by_some_role():
    known = _all_role_default_keys()
    for preset_dir in sorted((REPO / "presets").iterdir()):
        if not preset_dir.is_dir():
            continue
        for name in PRESET_VAR_FILES:
            path = preset_dir / name
            if not path.exists():
                continue
            doc = yaml.safe_load(path.read_text()) or {}
            unknown = sorted(set(doc) - known)
            assert not unknown, (
                f"{path.relative_to(REPO)} sets keys no role defines: {unknown}"
            )


def test_no_preset_ships_a_netplan_template():
    """Duplicated from test_net_controllers_template.py on purpose: apply_preset
    now rejects such a preset at runtime, and this states the same rule where a
    preset author will look for it."""
    for preset_dir in sorted((REPO / "presets").iterdir()):
        if preset_dir.is_dir():
            assert not (preset_dir / "netplan.yaml.j2").exists(), preset_dir.name
```

- [ ] **Step 2: Run it**

Run: `.venv/bin/python -m pytest tests/test_preset_key_ownership.py -q`
Expected: 2 passed. If `test_every_preset_key_is_defined_by_some_role` fails,
the named key is a genuine defect in the preset — fix the preset, not the test.

- [ ] **Step 3: Write `tests/test_no_runtime_writes_to_tracked.py`**

```python
"""No installer script may write a git-tracked configuration file at runtime.

Writing role defaults is what let an incomplete preset delete configuration, and
what made `git checkout --force` (the update path) silently reset a node. The
property worth pinning is "nothing writes there", which is a textual claim about
the shell sources, so this is a grep rather than a behavioural test.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

SCRIPTS = [
    "startup_menu.sh",
    "simple_menu.sh",
    "autoinstall.sh",
    "configure_raid.sh",
    "configure_network.sh",
    "configure_nfs_exports.sh",
    "lib/xinas_config.sh",
]

# Writers, not readers. Two exclusions matter: `yq eval` / `grep` against a role
# default is a read, and for `cp`/`mv` the tracked path only counts when it is
# the LAST argument — `cp playbooks/site.yml <preset>/playbook.yml` reads the
# tracked file, it does not write it (lib/xinas_config.sh does exactly that).
WRITE = re.compile(
    r"""(?x)
    (?: \bcp\s[^\n|;]*                       # cp <src> <tracked-dest>
      | \bmv\s[^\n|;]*                       # mv <tmp> <tracked-dest>
      | \bcat\s*>\s*                         # cat > <tracked>
      | \byq\s+(?:-i|eval\s+-i)\s[^\n|;]*    # in-place yq
      | >\s*                                 # plain redirect
    )
    (?P<target>[^\s"']*(?:collection/roles|playbooks/site\.yml)[^\s"']*)
    ["']?\s*$                                # destination = last argument
    """
)


def test_no_script_writes_a_tracked_config_file():
    offenders: list[str] = []
    for name in SCRIPTS:
        text = (REPO / name).read_text()
        for lineno, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if WRITE.search(line):
                offenders.append(f"{name}:{lineno}: {line.strip()}")
    assert not offenders, "runtime writes to tracked config:\n" + "\n".join(offenders)
```

- [ ] **Step 4: Run it**

Run: `.venv/bin/python -m pytest tests/test_no_runtime_writes_to_tracked.py -q`
Expected: 1 passed. A failure names the file and line to fix.

- [ ] **Step 5: Run the whole suite**

Run: `.venv/bin/python -m pytest --cov=xinas_history --cov-fail-under=20 -q`
Expected: all pass, coverage above the floor.

- [ ] **Step 6: Commit**

```bash
git add tests/test_preset_key_ownership.py tests/test_no_runtime_writes_to_tracked.py
git commit -m "test(installer): pin preset key ownership and the no-tracked-writes rule"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/Installer/spec.md` §1 (lines 14-47), lines 24, 28, 47, 80, 175
- Modify: `docs/Installer/update-spec.md` (reset-to-release section)
- Modify: `docs/TODO.md`

**Interfaces:** none.

- [ ] **Step 1: Rewrite `docs/Installer/spec.md` §1**

Replace the sentence at line 16 with the layer model: role defaults are the
immutable base; `playbooks/group_vars/all/10-preset.yml` carries the preset;
`20-local.yml` carries config-editor edits and wins; `-e` wins over both. State
that a preset contributes variables only, that `playbooks/site.yml` is always
the playbook that runs, and that a preset may not ship `netplan.yaml.j2`.

Fix the three stale claims found while writing this plan:

- Lines 24 and 80: `nvme_namespace` **is** listed in
  `presets/default/playbook.yml`. Remove the parenthetical and the §2 note.
- Lines 28 and 47: neither preset ships `netplan.yaml.j2`; the rows go.
- Line 175: the sentence already describes overlay semantics and now becomes
  accurate — keep it, and point at §1 for the layer order.

- [ ] **Step 2: Extend `docs/Installer/update-spec.md`**

In the reset-to-release section, record: the overlay is untracked and therefore
survives `git checkout --force`, which is why configuration now persists across
updates; on the first update to this version the migration bridge re-applies the
preset named in `/opt/xiNAS/.xinas_applied_preset`; and edits made through the
config editors **before** that update are not recoverable, because
`checkout --force` already discarded them on every prior update too.

- [ ] **Step 3: Add the deferred item to `docs/TODO.md`**

```markdown
### `net_detect_infiniband` / `net_detect_mlx5` are dead

`collection/roles/net_controllers/defaults/main.yml` declares both and
`configure_network.sh` used to write them, but no task in the role reads either.
They survived because the preset copy deleted them and nothing noticed. Decide
whether interface detection should honour them or whether they should go; until
then `tests/test_preset_key_ownership.py` keeps them from being referenced by a
preset that expects an effect. Done = either wired into the role's detection
step or removed from the defaults.
```

- [ ] **Step 4: Lint the docs**

Run: `npx --yes markdownlint-cli2 'docs/**/*.md'`
Expected: 0 issues.

- [ ] **Step 5: Full verification gate**

Run each line from repo `CLAUDE.md` §Verification, verbatim. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add docs/Installer/spec.md docs/Installer/update-spec.md docs/TODO.md
git commit -m "docs(installer): describe the configuration layer model"
```

---

### Task 11: `configure_hostname.sh` writes the overlay

Added after Task 9, by ruling. The plan's file set never included this editor,
yet `configure_hostname.sh:74` does `mv "$tmp" "$vars_file"` where `vars_file`
is `collection/roles/common/defaults/main.yml` — a runtime write to a tracked
role default. That is what §2 goal 4 forbids and what the update flow's
`git checkout --force` silently discards. Leaving it also leaves
`tests/test_no_runtime_writes_to_tracked.py` advertising coverage it does not
have, since the file is absent from its `SCRIPTS` list.

**Files:**
- Modify: `configure_hostname.sh`
- Modify: `tests/test_no_runtime_writes_to_tracked.py`
- Test: `tests/test_preset_overlay.py`

**Interfaces:**
- Consumes: `xinas_config_effective`, `xinas_config_get`, `xinas_config_set`,
  `xinas_config_seed_local`, `XINAS_LOCAL_LAYER` from Tasks 1 and 5.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preset_overlay.py` a test in the shape Task 5 used for the
other editors: seed the overlay with a hostname-related key, drive the real
write path from `configure_hostname.sh`, and assert the value lands in
`20-local.yml` while `collection/roles/common/defaults/main.yml` is untouched.
Read Task 5's editor tests first and follow their construction — they source the
real script's functions rather than reimplementing them.

- [ ] **Step 2: Run it and confirm it fails**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q -k hostname`
Expected: FAIL, because the write still goes to the role default.

- [ ] **Step 3: Repoint the script**

Source `lib/xinas_config.sh` next to the existing `menu_lib.sh` source line,
using the script's own `SCRIPT_DIR` — not `REPO_DIR`, which means the repo being
configured. Replace the `vars_file` assignment with `$XINAS_LOCAL_LAYER`, route
every read through `xinas_config_effective`, and call `xinas_config_seed_local`
for the edited key before writing. Match what Task 5 did to `configure_raid.sh`
and `configure_nfs_exports.sh`.

Watch the two traps this plan has already hit here: `backup_if_changed` in this
file carries the same `[ -f "$file" ] || return` shape that aborted a caller
under `set -e` in Task 5 — fix it to `return 0` the same way; and a value read
with `//` treats a present `false` as absent, so use `has()`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `.venv/bin/python -m pytest tests/test_preset_overlay.py -q`
Expected: all pass.

- [ ] **Step 5: Close the contract test's hole**

Add `configure_hostname.sh` to `SCRIPTS` in
`tests/test_no_runtime_writes_to_tracked.py`, then run
`.venv/bin/python -m pytest tests/test_no_runtime_writes_to_tracked.py -q`.
Expected: pass. If it fails, the repoint in Step 3 is incomplete — fix the
script, not the test.

- [ ] **Step 6: Verify and commit**

Run: `.venv/bin/python -m pytest --cov=xinas_history --cov-fail-under=20 -q`,
`ruff format --check .`, and `bash -n configure_hostname.sh`.

```bash
git add configure_hostname.sh tests/test_no_runtime_writes_to_tracked.py tests/test_preset_overlay.py
git commit -m "fix(installer): configure_hostname.sh writes the overlay, not role defaults"
```

---

## Self-review notes

**Spec coverage.** §3 → Task 1; §4 → Tasks 2, 3; §5 → Tasks 4, 5; §6 → Task 5;
§7 → Task 6; §8 → Task 2 (consolidation is the shape of `xinas_apply_preset`);
§9 → Task 7; §10 → Task 8; §11 → Tasks 1-9 inline plus Task 9; §12 → Task 10.

**Ordering constraint.** Task 4 must land before Task 5 step 8, which sets
`net_netplan_template`. Task 2 must land before Task 7, which calls
`xinas_apply_preset`. Everything else is independent.

**Shell safety.** Every conditional in the helper is an `if` block, never
`[ test ] && action`. An AND-list whose test fails returns 1, and the helper is
sourced into `set -eu` contexts (the test harness, and `autoinstall.sh`), where
that aborts the caller. The first draft of this plan had six such lines.

**Known risk.** Task 5 touches three scripts with no automated coverage of their
dialog flow; `bash -n` and the grep contract test are the only gates. The
editors should be exercised by hand on a VM before release: pool mode → manual
mode → back to pool mode, checking that `20-local.yml` gains and then loses
`net_netplan_template` and that `.xinas-local/netplan.yaml.j2` is removed.
