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
# scalar would be.)
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
