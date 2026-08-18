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
