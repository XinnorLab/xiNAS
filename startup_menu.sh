#!/usr/bin/env bash
# Interactive provisioning menu for xiNAS
# POSIX-compliant startup menu script using whiptail
# Exits on errors and cleans up temporary files
# Requires: whiptail (usually provided by the 'whiptail' package)

set -euo pipefail
TMP_DIR="$(mktemp -d)"
# Directory of the repository currently being configured
REPO_DIR="$(pwd)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Prompt user for license string and store it in /tmp/license
# Show license prompt and save to /tmp/license
enter_license() {
    local license_file="/tmp/license"
    [ -x ./hwkey ] || chmod +x ./hwkey
    local hwkey_val
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')

    # Show HWKEY to the user
    whiptail --title "Hardware Key" --msgbox "HWKEY: ${hwkey_val}\nRequest your license key from xiNNOR Support." 10 60

    if [ -f "$license_file" ]; then
        if whiptail --yesno "License already exists. Replace it?" 10 60; then
            local ts
            ts=$(date +%Y%m%d%H%M%S)
            cp "$license_file" "${license_file}.${ts}.bak"
            rm -f "$license_file"
        else
            return 0
        fi
    fi

    : > "$TMP_DIR/license_tmp"
    if command -v dialog >/dev/null 2>&1; then
        if dialog --title "Enter License" --editbox "$TMP_DIR/license_tmp" 20 70 2>"$TMP_DIR/license"; then
            :
        else
            return 0
        fi
    else
        whiptail --title "Enter License" --msgbox "Paste license in the terminal. End with Ctrl-D." 10 60
        cat >>"$TMP_DIR/license"
    fi
    cat "$TMP_DIR/license" > "$license_file"
}

# Edit network configuration for Ansible netplan role
configure_network() {
    local template="collection/roles/net_controllers/templates/netplan.yaml.j2"
    if [ ! -f "$template" ]; then
        whiptail --msgbox "File $template not found" 8 60
        return
    fi

    local edit_tmp="$TMP_DIR/netplan_edit"
    cp "$template" "$edit_tmp"

    if command -v dialog >/dev/null 2>&1; then
        if dialog --title "Edit netplan template" --editbox "$edit_tmp" 20 70 2>"$TMP_DIR/netplan_new"; then
            cat "$TMP_DIR/netplan_new" > "$template"
        else
            return 0
        fi
    else
        whiptail --title "Edit netplan" --msgbox "Modify $template in the terminal. End with Ctrl-D." 10 60
        cat "$template" > "$TMP_DIR/netplan_new"
        cat >> "$TMP_DIR/netplan_new"
        cat "$TMP_DIR/netplan_new" > "$template"
    fi

    whiptail --title "Ansible Netplan" --textbox "$template" 20 70
}

# Display playbook information from /opt/provision/README.md
show_playbook_info() {
    local info_file="/opt/provision/README.md"
    if [ -f "$info_file" ]; then
        whiptail --title "Playbook Info" --scrolltext --textbox "$info_file" 20 70
    else
        whiptail --msgbox "File $info_file not found" 8 60
    fi
}

# Show NFS share configuration based on exports role defaults
configure_nfs_shares() {
    local vars_file="collection/roles/exports/defaults/main.yml"
    if [ ! -f "$vars_file" ]; then
        whiptail --msgbox "File $vars_file not found" 8 60
        return
    fi
    local share_start
    share_start=$(grep -n '^exports:' "$vars_file" | cut -d: -f1)
    local tmp="$TMP_DIR/nfs_info"
    sed -n "$((share_start+1)),$((share_start+3))p" "$vars_file" > "$tmp"
    whiptail --title "NFS Share" --textbox "$tmp" 12 70

    local default_path
    default_path=$(awk '/^exports:/ {flag=1; next} flag && /- path:/ {print $3; exit}' "$vars_file")

    while true; do
        local choice
        choice=$(whiptail --title "NFS Share" --menu "Choose an action:" 15 70 4 \
            1 "Edit default share" \
            2 "Back" 3>&1 1>&2 2>&3)
        case "$choice" in
            1) ./configure_nfs_exports.sh --edit "$default_path" ;;
            *) break ;;
        esac
    done
}

# Edit NFS export clients and options interactively
edit_nfs_exports() {
    ./configure_nfs_exports.sh
}

# Configure RAID devices interactively
configure_raid() {
    ./configure_raid.sh
}

# Configure or update git repository under /opt/provision
configure_git_repo() {
    local repo_dir="/opt/provision"
    mkdir -p "$repo_dir"

    local out="$TMP_DIR/git_config"
    if [ -d "$repo_dir/.git" ]; then
        git -C "$repo_dir" config --list >"$out" 2>&1
    else
        git config --list >"$out" 2>&1 || echo "No git configuration found" >"$out"
    fi
    whiptail --title "Current Git Configuration" --textbox "$out" 20 70
    if ! whiptail --yesno "Modify Git repository settings?" 8 60; then
        return 0
    fi

    local current_url=""
    local current_branch="main"
    if [ -d "$repo_dir/.git" ]; then
        current_url=$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)
        current_branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    elif [ -f "$repo_dir/repo.url" ]; then
        current_url=$(cat "$repo_dir/repo.url")
        [ -f "$repo_dir/repo.branch" ] && current_branch=$(cat "$repo_dir/repo.branch")
    fi

    url=$(whiptail --inputbox "Git repository URL" 8 60 "$current_url" 3>&1 1>&2 2>&3) || return 0
    branch=$(whiptail --inputbox "Git branch" 8 60 "$current_branch" 3>&1 1>&2 2>&3) || return 0

    if [ -d "$repo_dir/.git" ]; then
        git -C "$repo_dir" remote set-url origin "$url"
        git -C "$repo_dir" fetch origin
        git -C "$repo_dir" checkout "$branch"
        git -C "$repo_dir" pull origin "$branch"
    else
        rm -rf "$repo_dir"
        git clone -b "$branch" "$url" "$repo_dir"
    fi

    echo "$url" >"$repo_dir/repo.url"
    echo "$branch" >"$repo_dir/repo.branch"

    whiptail --msgbox "Repository configured at $repo_dir" 8 60
    REPO_DIR="$repo_dir"
    cd "$REPO_DIR"
}

# Run ansible-playbook and stream output
run_playbook() {
    local playbook="${1:-$REPO_DIR/site.yml}"
    local log="$TMP_DIR/playbook.log"
    touch "$log"
    whiptail --title "Ansible Playbook" --tailbox "$log" 20 70 &
    local box_pid=$!
    if ansible-playbook "$playbook" >"$log" 2>&1; then
        result=0
    else
        result=$?
    fi
    kill "$box_pid" 2>/dev/null || true
    wait "$box_pid" 2>/dev/null || true
    if [ $result -eq 0 ]; then
        whiptail --msgbox "Playbook completed successfully" 8 60
    else
        whiptail --msgbox "Playbook failed. Check log: $log" 10 60
    fi
    return $result
}

# Copy configuration files from a preset directory and optionally run its playbook
apply_preset() {
    local preset="$1"
    local pdir="$REPO_DIR/presets/$preset"
    [ -d "$pdir" ] || { whiptail --msgbox "Preset $preset not found" 8 60; return; }

    local msg="Applying preset: $preset\n"
    if [ -f "$pdir/netplan.yaml.j2" ]; then
        cp "$pdir/netplan.yaml.j2" "collection/roles/net_controllers/templates/netplan.yaml.j2"
        msg+="- network configuration\n"
    fi
    if [ -f "$pdir/raid_fs.yml" ]; then
        cp "$pdir/raid_fs.yml" "collection/roles/raid_fs/defaults/main.yml"
        msg+="- RAID configuration\n"
    fi
    if [ -f "$pdir/nfs_exports.yml" ]; then
        cp "$pdir/nfs_exports.yml" "collection/roles/exports/defaults/main.yml"
        msg+="- NFS exports\n"
    fi
    if [ -f "$pdir/playbook.yml" ]; then
        run_playbook "$pdir/playbook.yml"
    fi
    whiptail --msgbox "$msg" 15 70
}

# Present available presets to the user
choose_preset() {
    local preset_dir="$REPO_DIR/presets"
    [ -d "$preset_dir" ] || { whiptail --msgbox "No presets available" 8 60; return; }

    local items=()
    for d in "$preset_dir"/*/; do
        [ -d "$d" ] || continue
        items+=("$(basename "$d")" "")
    done
    items+=("Back" "Return")

    set +e
    local choice
    choice=$(whiptail --title "Presets" --menu "Select preset:" 20 70 10 "${items[@]}" 3>&1 1>&2 2>&3)
    local status=$?
    set -e
    if [ $status -ne 0 ] || [ "$choice" = "Back" ]; then
        return
    fi
    apply_preset "$choice"
}

# Main menu loop
while true; do
    choice=$(whiptail --title "xiNAS Setup" --nocancel --menu "Choose an action:" 20 70 14 \
        1 "Enter License" \
        2 "Configure Network" \
        3 "Configure RAID" \
        4 "Edit NFS Exports" \
        5 "Presets" \
        6 "Git Repository Configuration" \
        7 "Continue" \
        3>&1 1>&2 2>&3)
    case "$choice" in
        1) enter_license ;;
        2) configure_network ;;
        3) configure_raid ;;
        4) edit_nfs_exports ;;
        5) choose_preset ;;
        6) configure_git_repo ;;
        7) exit 0 ;;
    esac
done

