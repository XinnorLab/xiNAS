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

# rc=0: key found, value on stdout. rc=1: no layer defines the key (the
# ordinary negative result, like grep's "no match"). rc=2: the effective
# document itself could not be computed (e.g. malformed YAML in a role
# default) - kept distinct from rc=1 so a real failure never reads as "not
# set".
#
# Looks up presence with has() rather than the `.key // default` operator:
# `//` treats a *present* `false` the same as absent (and folds a present
# `null` the same way too), which silently breaks every boolean role default
# that ships as `false` - several do - and makes a stored `null` indistinguishable
# from an unset key. has() only asks "is the key there", so both are read
# correctly, and a real value of the literal string "__XINAS_ABSENT__" can no
# longer collide with a sentinel.
xinas_config_get() {
    local key="$1" effective has
    effective=$(xinas_config_effective) || return 2
    has=$(printf '%s\n' "$effective" | yq eval "has(\"${key}\")" -) || return 2
    if [ "$has" != "true" ]; then
        return 1
    fi
    printf '%s\n' "$effective" | yq eval ".${key}" -
}

# The value is interpreted as YAML when that's unambiguous, so
# `xinas_config_set local net_mtu 9000` stores an int and
# `... net_manual_ips '{}'` stores a mapping. Values that are empty, span
# multiple lines, or collide with YAML's own block-sequence/document-marker
# syntax ("-", "---", "- <word>") are stored as literal strings instead -
# interpreting them as a standalone YAML document would silently fold,
# null out, or reject them. (Residual limitation, not specially handled: a
# value that happens to contain other YAML syntax, e.g. "key: value" with
# the space, or a leading "#", is parsed as that syntax like any bare YAML
# scalar would be - a colon-space turns the value into a nested map, and a
# leading "#" turns it into null.)
#
# CALLER CONTRACT, not enforced by this function: any string value that is
# not known ahead of time to be a safe bare YAML scalar (a plain true/false,
# a bare integer, ...) MUST be pre-wrapped by the CALLER in literal double
# quotes, so it round-trips as a quoted YAML string regardless of what it
# contains -
#   xinas_config_set local net_netplan_template "\"$path\""
# not
#   xinas_config_set local net_netplan_template "$path"
# Every string-valued caller in this tree already does this
# (net_ip_pool_start, net_ip_pool_end, net_netplan_template - each wrapped
# in literal `\"…\"` at the call site in configure_network.sh). That
# convention is the only thing keeping the colon-space/leading-"#" trap
# above unreachable today; it is not checked here, so a future caller that
# passes a bare, unquoted string is exposed to it the moment that string
# happens to contain either.
#
# yq's own exit status is checked before the `mv` on purpose: a caller that
# writes `if xinas_config_set ...; then` - the natural way to check success -
# suspends `errexit` for the whole call per bash's if/&&/pipeline exemptions,
# so a failing yq here would otherwise go unnoticed and `mv` would replace a
# good layer file with an empty one.
xinas_config_set() {
    local layer="$1" key="$2" value="$3" path tmp expr
    path=$(_xinas_layer_path "$layer") || return 2
    mkdir -p "$(dirname "$path")"
    [ -f "$path" ] || printf -- '---\n' > "$path"

    expr='env(XINAS_VALUE)'
    case "$value" in
        ''|'-'|'---'|'- '*|*$'\n'*) expr='strenv(XINAS_VALUE)' ;;
    esac

    tmp=$(mktemp)
    if ! XINAS_VALUE="$value" yq eval ".${key} = ${expr}" "$path" > "$tmp"; then
        rm -f "$tmp"
        return 2
    fi
    mv "$tmp" "$path"
}

# Replace a whole layer from a YAML document on stdin.
xinas_config_replace_layer() {
    local layer="$1" path
    path=$(_xinas_layer_path "$layer") || return 2
    mkdir -p "$(dirname "$path")"
    cat > "$path"
}

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
    # Exit status checked for the same reason as the merge below: an
    # unchecked failure here would silently drop the playbook's vars (or,
    # with no other var files present, wipe the overlay down to nothing)
    # while still returning rc=0 - every real caller invokes this function
    # under `||`, which suppresses errexit for its entire body, so nothing
    # here fails the function on its own unless it is checked explicitly.
    local playvars=""
    if [ -f "$pdir/playbook.yml" ]; then
        if ! playvars=$(yq eval '.[0].vars // {}' "$pdir/playbook.yml"); then
            echo "preset $preset: failed to read playbook vars" >&2
            return 1
        fi
        if [ "$playvars" != "{}" ] && [ -n "$playvars" ]; then
            local tmp_pv
            tmp_pv=$(mktemp); printf '%s\n' "$playvars" > "$tmp_pv"
            sources+=("$tmp_pv"); echo "- playbook vars"
        fi
    fi

    # Captured rather than piped straight into xinas_config_replace_layer: a
    # bare pipeline's exit status is never checked below, and this function's
    # last statement is an unconditional `... || true` marker write - so
    # without this check, a malformed var file makes yq fail, the previous
    # overlay gets silently replaced with an empty one, and the function
    # still returns 0. That is exactly the "fall through on a mixed preset"
    # failure this helper exists to prevent (confirmed: with the old direct
    # pipe, a preset with one good and one malformed var file printed both
    # as applied, wrote a 0-byte layer, and returned rc=0).
    local merged
    if [ ${#sources[@]} -eq 0 ]; then
        merged='---'
    elif ! merged=$(yq eval-all '. as $item ireduce ({}; . * $item)' "${sources[@]}"); then
        echo "preset $preset: failed to merge configuration" >&2
        return 1
    fi
    # Plain statement, checked via a separate $? afterward, rather than
    # `if ! ... | xinas_config_replace_layer preset; then`: testing a call to
    # a local multi-statement function directly in an if/pipe condition
    # suppresses `errexit` for that function's entire body for the duration
    # of the call (documented bash behavior, the same class of gotcha as
    # finding 3 in the Task 1 review) - avoided here even though it is not
    # exploitable in the current body of xinas_config_replace_layer, since
    # that function's only destructive statement is already its last one.
    printf '%s\n' "$merged" | xinas_config_replace_layer preset
    local write_rc=$?
    if [ "$write_rc" -ne 0 ]; then
        echo "preset $preset: failed to write overlay layer" >&2
        return 1
    fi

    echo "$preset" > /opt/xiNAS/.xinas_applied_preset 2>/dev/null || true
}

# Read-modify-write editors need the value the operator sees, not the release
# default. Seed exactly one key so the overlay stays an override set.
#
# Two problems surfaced while wiring this into the real editors (Task 5),
# neither of which the obvious `xinas_config_set local "$key" "$value"`
# one-liner survives:
#
#   - `.key // "ABSENT"` folds a present `false` to "absent" - the exact trap
#     xinas_config_get's own has() check exists to avoid (see its comment
#     above). nvme_auto_namespace is a plain boolean toggle, so a preset or a
#     prior toggle that leaves it `false` would read back as "nothing to
#     seed" and silently skip seeding it, for both the local-layer presence
#     check and the effective-value lookup. has() is used for both instead.
#
#   - xiraid_arrays, xiraid_spare_pools and exports are lists of maps; their
#     effective value is multi-line YAML. Passing that through
#     xinas_config_set hits its documented literal-string fallback for any
#     value containing a newline and lands in the local layer as an opaque
#     block-scalar string, not a sequence. Confirmed by hand: seed a local
#     layer that way, then run configure_raid.sh's own edit_devices() write
#     against it - `.xiraid_arrays[]` on a string splats to nothing, so the
#     select/assign matches nothing, yq exits 0, and the operator's edit is
#     dropped with no error anywhere. load() reads a temp copy of the
#     effective document as real YAML instead of round-tripping it through a
#     shell/env-var scalar, so both scalar and structural values come back
#     typed the way they actually are.
#
# Always leaves $XINAS_LOCAL_LAYER existing as a valid YAML document, even
# when there is nothing to seed: every caller added in Task 5 chains a raw
# `yq "..." "$XINAS_LOCAL_LAYER" > tmp` write immediately afterward, and that
# read fails outright (yq exits nonzero, no output) against a missing file.
xinas_config_seed_local() {
    local key="$1" has_local has_eff tmp_eff tmp_out

    mkdir -p "$(dirname "$XINAS_LOCAL_LAYER")"
    [ -f "$XINAS_LOCAL_LAYER" ] || printf -- '---\n' > "$XINAS_LOCAL_LAYER"

    has_local=$(yq eval "has(\"${key}\")" "$XINAS_LOCAL_LAYER") || return 2
    if [ "$has_local" = "true" ]; then return 0; fi

    has_eff=$(xinas_config_effective | yq eval "has(\"${key}\")" -) || return 2
    if [ "$has_eff" != "true" ]; then return 0; fi

    tmp_eff=$(mktemp)
    xinas_config_effective > "$tmp_eff"
    tmp_out=$(mktemp)
    if ! yq eval ".${key} = load(\"${tmp_eff}\").${key}" "$XINAS_LOCAL_LAYER" > "$tmp_out"; then
        rm -f "$tmp_eff" "$tmp_out"
        return 2
    fi
    rm -f "$tmp_eff"
    mv "$tmp_out" "$XINAS_LOCAL_LAYER"
}

# role -> preset filename. A role absent from this map has no preset file of
# its own, so an overlay key it owns cannot round-trip through save/apply -
# xinas_key_owner reports that key rather than guessing where to put it.
_xinas_role_preset_file() {
    case "$1" in
        net_controllers) echo network.yml ;;
        raid_fs)         echo raid_fs.yml ;;
        nvme_namespace)  echo nvme_namespace.yml ;;
        exports)         echo nfs_exports.yml ;;
        *) return 1 ;;
    esac
}

# Which preset file owns key $1: scan role defaults, in sorted role-name
# order, for the first *mapped* role whose defaults/main.yml defines the key;
# print its preset filename and return 0. A role that defines the key but has
# no preset file of its own (see _xinas_role_preset_file) does not stop the
# scan - a later, mapped role that also happens to define the same key name
# still wins (two shipped role defaults collide on a key name today:
# xinas_storage_reset is defined by both nvme_namespace and raid_fs, and both
# are mapped, so this only matters if an unmapped role is ever added ahead of
# a mapped one alphabetically). Prints nothing and returns 1 when no mapped
# role owns the key.
#
# has() rather than the `//` alternative operator: same trap documented on
# xinas_config_get above - a present `false` must read as "defined", not
# "absent".
xinas_key_owner() {
    local key="$1" f role file has
    while IFS= read -r f; do
        if [ -z "$f" ]; then
            continue
        fi
        if ! has=$(yq eval "has(\"${key}\")" "$f"); then
            continue
        fi
        if [ "$has" = "true" ]; then
            role=$(basename "$(dirname "$(dirname "$f")")")
            if file=$(_xinas_role_preset_file "$role"); then
                printf '%s\n' "$file"
                return 0
            fi
        fi
    done < <(find "$REPO_DIR/collection/roles" -path '*/defaults/main.yml' 2>/dev/null | sort)
    return 1
}

# Decompose the live overlay (the preset layer + the local layer merged,
# later wins - deliberately NOT role defaults, which is the release baseline
# this whole design keeps out of a saved preset) back into
# presets/<name>/*.yml, one file per owning role, plus playbook.yml copied
# from the current playbooks/site.yml. A key no mapped role owns is named on
# stderr and skipped - never guessed into an unrelated file. Replaces rather
# than accumulates: a re-save under a name that already has preset files
# starts from a clean slate for the four known preset filenames, so a key
# dropped from the live overlay since the last save under this name does not
# survive as a stale leftover.
#
# Every statement that can fail is checked explicitly with `if !` / `return`
# rather than left for `set -e` to catch. This function's real callers -
# startup_menu.sh's save_preset, mirroring the already-landed apply_preset
# wrapper, and the guarded-call tests below - invoke it as
# `out=$(xinas_save_preset ...) || rc=$?`, never as a bare statement. Per
# documented bash behavior, a function executing inside such a guard (an if
# condition, or the non-final side of && / ||, and a command substitution
# feeding one does not exempt itself from this) has `errexit` suspended for
# its ENTIRE body, not just the top-level call - confirmed by hand with a
# throwaway probe function: a bare `false` partway through its loop, called
# this exact way, let the loop run to completion and the function report
# rc=0, while an identical bare top-level call correctly aborted at the
# failure. A bare failing statement in here would therefore silently be
# skipped under the calling convention production actually uses, and this
# function would return whatever its last statement happened to produce -
# easily 0 - even though a real write had failed. That gap is invisible to
# any test that only calls this function bare, which is why one of the tests
# below drives it through the guarded form instead.
xinas_save_preset() {
    local name="$1" pdir="$REPO_DIR/presets/$1" key file tmp overlay

    if ! mkdir -p "$pdir"; then
        echo "xinas_save_preset $name: failed to create $pdir" >&2
        return 1
    fi

    # Best-effort: nothing later depends on these having succeeded, only on
    # the files not existing with stale content from a previous save.
    local rolefile
    for rolefile in network.yml raid_fs.yml nvme_namespace.yml nfs_exports.yml; do
        rm -f "$pdir/$rolefile" 2>/dev/null || true
    done

    local -a layers=()
    if [ -f "$XINAS_PRESET_LAYER" ]; then layers+=("$XINAS_PRESET_LAYER"); fi
    if [ -f "$XINAS_LOCAL_LAYER" ]; then layers+=("$XINAS_LOCAL_LAYER"); fi

    overlay=$(mktemp)
    if [ ${#layers[@]} -eq 0 ]; then
        printf '%s\n' '{}' > "$overlay"
    elif ! yq eval-all '. as $item ireduce ({}; . * $item)' "${layers[@]}" > "$overlay"; then
        echo "xinas_save_preset $name: failed to read the configuration overlay" >&2
        rm -f "$overlay"
        return 1
    fi

    local keys_raw
    if ! keys_raw=$(yq eval 'keys | .[]' "$overlay"); then
        echo "xinas_save_preset $name: failed to enumerate overlay keys" >&2
        rm -f "$overlay"
        return 1
    fi
    local -a keys=()
    mapfile -t keys <<< "$keys_raw"

    for key in "${keys[@]}"; do
        if [ -z "$key" ]; then
            continue
        fi

        if ! file=$(xinas_key_owner "$key"); then
            echo "skipped: no preset file owns '$key'" >&2
            continue
        fi

        if [ ! -f "$pdir/$file" ]; then
            if ! printf -- '---\n' > "$pdir/$file"; then
                echo "xinas_save_preset $name: failed to create $pdir/$file" >&2
                rm -f "$overlay"
                return 1
            fi
        fi

        tmp=$(mktemp)
        # load() pulls the value out of the overlay file as a typed YAML
        # node - the same pattern xinas_config_seed_local uses above, and
        # for the same reason: routing a structural value (a list of maps
        # such as xiraid_arrays or exports) through a shell variable and
        # back via env()/from_yaml is not equivalent. Confirmed by hand:
        # `XINAS_VALUE="$value" yq eval '... = (env(XINAS_VALUE) | from_yaml)'`
        # - the shape this task's own earlier draft used - errors outright
        # ("Error: EOF") on a multi-line list value, because env() already
        # parses a value that merely *looks* scalar-shaped and from_yaml
        # then receives an already-typed node instead of a string to parse.
        # load() never round-trips the value through a shell/env string at
        # all, so the failure mode does not exist.
        if ! yq eval ".${key} = load(\"${overlay}\").${key}" "$pdir/$file" > "$tmp"; then
            rm -f "$tmp" "$overlay"
            echo "xinas_save_preset $name: failed to write '$key' into $file" >&2
            return 1
        fi
        if ! mv "$tmp" "$pdir/$file"; then
            rm -f "$tmp" "$overlay"
            echo "xinas_save_preset $name: failed to update $pdir/$file" >&2
            return 1
        fi
    done
    rm -f "$overlay"

    if ! cp "$REPO_DIR/playbooks/site.yml" "$pdir/playbook.yml"; then
        echo "xinas_save_preset $name: failed to copy playbooks/site.yml" >&2
        return 1
    fi

    if [ -f "$XINAS_LOCAL_ARTEFACTS/netplan.yaml.j2" ]; then
        echo "note: manual netplan template not saved (presets may not ship one)" >&2
    fi
    return 0
}

# Bridge for hosts installed before this overlay design existed, when
# apply_preset overwrote git-tracked role defaults directly instead of
# writing $XINAS_PRESET_LAYER. Obvious-looking alternative that does NOT
# work: reading the mutated role defaults on disk and reconstructing the
# overlay from them. The update flow runs `git checkout --force` before any
# new code executes (xinas_menu/utils/update_check.py,
# collection/roles/xinas_menu/files/xinas-update-git) specifically because
# the installed tree is dirty by design - so by the time this function ever
# runs on an updated host, those mutated defaults are already gone, checked
# out back to pristine. The one thing that survives a forced checkout is the
# untracked marker file every xinas_apply_preset call writes
# ($XINAS_PRESET_MARKER, see above) - it is the only signal this bridge has.
# Operator edits made through the config editors before migration cannot be
# recovered this way; that loss is accepted and documented (Task 10).
: "${XINAS_PRESET_MARKER:=/opt/xiNAS/.xinas_applied_preset}"

# Idempotent: a host already migrated (XINAS_PRESET_LAYER exists) is left
# completely untouched, on purpose - re-reading the marker and re-applying
# its preset on every run would silently stomp any operator edit made to the
# overlay since migration, which is exactly the failure mode the old
# file-replacement mechanism had and this whole plan exists to remove.
# Prints the one line describing what it did on stdout for the caller to
# surface to the operator; prints nothing when there is nothing to do
# (already migrated, or no marker - a normal fresh install).
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
