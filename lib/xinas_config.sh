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
