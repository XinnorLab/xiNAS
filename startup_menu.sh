#!/usr/bin/env bash
# Interactive provisioning menu for xiNAS
# POSIX-compliant startup menu script using whiptail
# Exits on errors and cleans up temporary files
# Requires: whiptail (usually provided by the 'whiptail' package)

set -euo pipefail
TMP_DIR="$(mktemp -d)"
# Path to whiptail if available
WHIPTAIL=$(command -v whiptail || true)
# Directory of the repository currently being configured
REPO_DIR="$(pwd)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Update check
UPDATE_AVAILABLE=""

check_for_updates() {
    # Check if running from a git repo
    local git_dir="$REPO_DIR/.git"
    [[ -d "$git_dir" ]] || return 0

    # Skip if no git command
    command -v git &>/dev/null || return 0

    # Skip if no network (quick check)
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0

    # Get local commit
    local local_commit
    local_commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null) || return 0

    # Fetch latest (quiet, background-friendly)
    git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || return 0

    # Get remote commit
    local remote_commit
    remote_commit=$(git -C "$REPO_DIR" rev-parse origin/main 2>/dev/null) || return 0

    # Compare
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

do_update() {
    if ! command -v git &>/dev/null; then
        whiptail --title "Error" --msgbox "Git is not installed." 8 40
        return 1
    fi

    whiptail --title "Updating..." --infobox "Pulling latest changes from origin/main..." 6 50

    if git -C "$REPO_DIR" pull origin main 2>"$TMP_DIR/update.log"; then
        UPDATE_AVAILABLE=""
        whiptail --title "✅ Update Complete" --msgbox "xiNAS has been updated successfully!\n\nPlease restart the menu to use the new version." 10 50
    else
        whiptail --title "❌ Update Failed" --msgbox "Failed to update:\n\n$(cat "$TMP_DIR/update.log")" 12 60
    fi
}

# Run update check in background
check_for_updates &

check_license() {
    local license_file="/tmp/license"
    if [ ! -f "$license_file" ]; then
        whiptail --msgbox "License file $license_file not found. Please run 'Enter License' first." 10 60
        return 1
    fi
    return 0
}

# Display package status using dpkg-query with a trailing newline
pkg_status() {
    local pkg="$1"
    dpkg-query -W -f='${Status}\n' "$pkg" 2>/dev/null || true
}

# Prompt user for license string and store it in /tmp/license
# Show license prompt and save to /tmp/license
enter_license() {
    local license_file="/tmp/license"
    [ -x ./hwkey ] || chmod +x ./hwkey
    local hwkey_val
    local replace=0

    local ts=""
    if [ -f "$license_file" ]; then
        if whiptail --yesno "License already exists. Replace it?" 10 60; then
            replace=1
            ts=$(date +%Y%m%d%H%M%S)
        else
            return 0
        fi
    fi

    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')

    # Show HWKEY to the user
    whiptail --title "Hardware Key" --msgbox "HWKEY: ${hwkey_val}\nRequest your license key from xiNNOR Support." 10 60

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
    if [ $replace -eq 1 ]; then
        cp "$license_file" "${license_file}.${ts}.bak"
    fi
    cat "$TMP_DIR/license" > "$license_file"
}

# Edit network configuration (IP pool or manual)
configure_network() {
    ./configure_network.sh
}
# Configure hostname for Ansible role
configure_hostname() {
    ./configure_hostname.sh
}


# Display playbook information from /opt/provision/README.md
show_playbook_info() {
    local info_file="/opt/provision/README.md"
    if [ -f "$info_file" ]; then
        cat "$info_file"
    else
        echo "File $info_file not found" >&2
    fi
    read -rp "Press Enter to continue..." _
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
    choice=$(whiptail --title "xiNAS Setup" --nocancel --menu "Choose an action:" 20 70 16 \
        1 "Enter License" \
        2 "Configure Network" \
        3 "Set Hostname" \
        3 "Set Hostname" \
        4 "Configure RAID" \
        5 "Edit NFS Exports" \
        6 "Presets" \
        7 "Git Repository Configuration" \
        8 "Install" \
        9 "Exit" \
        3>&1 1>&2 2>&3)
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
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local inventory="${2:-inventories/lab.ini}"
    ansible-playbook "$playbook" -i "$inventory" -v
    return $?
}

# Check for installed xiRAID packages and optionally remove them
check_remove_xiraid() {
    local pkgs found repo_status log=/tmp/xiraid_remove.log
    pkgs=$(dpkg-query -W -f='${Package} ${Status}\n' 'xiraid*' 2>/dev/null | \
        awk '$4=="installed"{print $1}')
    repo_status=$(pkg_status xiraid-repo)
    [ -n "$repo_status" ] && echo "xiraid-repo: $repo_status"
    rm -f "$log"
    if [ -z "$pkgs" ]; then
        sudo apt-get autoremove -y -qq --allow-change-held-packages >"$log" 2>&1 || true
        if [ -s "$log" ]; then
            msg="Obsolete packages removed"
            if [ -n "$WHIPTAIL" ]; then
                whiptail --msgbox "$msg" 8 60
            else
                echo "$msg"
            fi
            rm -f "$log"
        fi
        return 0
    fi

    found=$(echo "$pkgs" | tr '\n' ' ')
    if ! whiptail --yesno "Found installed xiRAID packages:\n${found}\nRemove them before running Ansible?" 12 70; then
        return 1
    fi

    if sudo apt-get purge -y -qq --allow-change-held-packages $pkgs >"$log" 2>&1 \
        && sudo apt-get autoremove -y -qq --allow-change-held-packages >>"$log" 2>&1 \
        && sudo rm -rf /etc/xiraid >>"$log" 2>&1; then
        msg="xiRAID packages removed successfully"
    else
        msg="Errors occurred during removal. See $log for details"
    fi
    if [ -n "$WHIPTAIL" ]; then
        whiptail --msgbox "$msg" 8 60
    else
        echo "$msg"
    fi
    rm -f "$log"
    return 0
}

# Display roles from a playbook and confirm execution
confirm_playbook() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local roles role_list desc_file desc
    roles=$(grep -E '^\s*- role:' "$playbook" | awk '{print $3}')
    role_list=""
    for r in $roles; do
        desc_file="$REPO_DIR/collection/roles/${r}/README.md"
        if [ -f "$desc_file" ]; then
            desc=$(awk '/^#/ {next} /^[[:space:]]*$/ {if(found) exit; next} {if(found){printf " %s", $0} else {printf "%s", $0; found=1}} END{print ""}' "$desc_file")
        else
            desc="No description available"
        fi
        role_list="${role_list}\n - ${r}: ${desc}"
    done
    whiptail --yesno --scrolltext "Run Ansible playbook to configure the system?\n\nThis will execute the following roles:${role_list}" 20 70
}

# Copy configuration files from a preset directory and optionally run its playbook
apply_preset() {
    local preset="$1"
    local pdir="$REPO_DIR/presets/$preset"
    [ -d "$pdir" ] || { whiptail --msgbox "Preset $preset not found" 8 60; return; }

    local msg="Applying preset: $preset\n"
    if [ -f "$pdir/network.yml" ]; then
        cp "$pdir/network.yml" "collection/roles/net_controllers/defaults/main.yml"
        msg+="- IP pool configuration\n"
    fi
    if [ -f "$pdir/netplan.yaml.j2" ]; then
        cp "$pdir/netplan.yaml.j2" "collection/roles/net_controllers/templates/netplan.yaml.j2"
        msg+="- network template\n"
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
        cp "$pdir/playbook.yml" "playbooks/site.yml"
        msg+="- playbook updated\n"
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
    items+=("Save" "Save current configuration")
    items+=("Back" "Return")

    set +e
    local choice
    choice=$(whiptail --title "Presets" --menu "Select preset or save current:" 20 70 10 "${items[@]}" 3>&1 1>&2 2>&3)
    local status=$?
    set -e
    if [ $status -ne 0 ] || [ "$choice" = "Back" ]; then
        return
    fi
    if [ "$choice" = "Save" ]; then
        save_preset
        return
    fi
    apply_preset "$choice"
}

# Save current configuration files as a new preset directory
save_preset() {
    local preset
    preset=$(whiptail --inputbox "Preset name" 8 60 3>&1 1>&2 2>&3) || return
    [ -n "$preset" ] || { whiptail --msgbox "Preset name cannot be empty" 8 60; return; }

    local pdir="$REPO_DIR/presets/$preset"
    if [ -d "$pdir" ]; then
        if ! whiptail --yesno "Preset exists. Overwrite?" 8 60; then
            return
        fi
        rm -rf "$pdir"
    fi
    mkdir -p "$pdir"
    cp "collection/roles/net_controllers/defaults/main.yml" "$pdir/network.yml" 2>/dev/null || true
    cp "collection/roles/net_controllers/templates/netplan.yaml.j2" "$pdir/netplan.yaml.j2" 2>/dev/null || true
    cp "collection/roles/raid_fs/defaults/main.yml" "$pdir/raid_fs.yml" 2>/dev/null || true
    cp "collection/roles/exports/defaults/main.yml" "$pdir/nfs_exports.yml" 2>/dev/null || true
    [ -f "playbooks/site.yml" ] && cp "playbooks/site.yml" "$pdir/playbook.yml"
    whiptail --msgbox "Preset saved to $pdir" 8 60
}

has_license() {
    [ -f "/tmp/license" ] && [ -s "/tmp/license" ]
}

# Show welcome message
whiptail --title "✨ Welcome to xiNAS Expert Mode!" --msgbox "\
   Advanced configuration for power users!

   ┌─────────────────────────────────────────────┐
   │  📊  Collect system information             │
   │  🔑  Enter your license (required)          │
   │  🌐  Configure network & hostname           │
   │  💾  Configure RAID & NFS exports           │
   │  📦  Manage presets                         │
   │  🚀  Launch the installation                │
   └─────────────────────────────────────────────┘

   Need help? Contact: support@xinnor.io
" 20 55

# Main menu loop
while true; do
    # Build dynamic menu based on license and update status
    if has_license; then
        license_text="🔑 Enter License ✓ Licensed"
        install_text="🚀 Install → Ready to go!"
    else
        license_text="🔑 Enter License ⚠ REQUIRED"
        install_text="🚀 Install (License required)"
    fi

    # Update status indicator
    update_status=""
    update_text="🔄 Check for Updates"
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        update_status=" | 📦 Update available!"
        update_text="🔄 Update Available ⬆️"
    fi

    choice=$(whiptail --title "═══ xiNAS Expert Setup ═══" --nocancel --menu "\
  Status: $(has_license && echo '✅ License OK' || echo '❌ No License')$update_status
  ─────────────────────────────────────────────" 26 65 12 \
        "1" "📊 Collect System Data" \
        "2" "$license_text" \
        "3" "🌐 Configure Network" \
        "4" "🏷️  Set Hostname" \
        "5" "💾 Configure RAID" \
        "6" "📂 Edit NFS Exports" \
        "7" "📦 Presets" \
        "8" "🔧 Git Repository Configuration" \
        "9" "$install_text" \
        "10" "$update_text" \
        "11" "🚪 Exit" \
        3>&1 1>&2 2>&3)

    case "$choice" in
        1) ./collect_data.sh ;;
        2) enter_license ;;
        3) configure_network ;;
        4) configure_hostname ;;
        5) configure_raid ;;
        6) edit_nfs_exports ;;
        7) choose_preset ;;
        8) configure_git_repo ;;
        9)
            if ! has_license; then
                whiptail --title "⚠️ License Required" --msgbox "\
   Oops! You need a license to continue.

   ┌─────────────────────────────────────────┐
   │  Please complete step 2 first:          │
   │                                         │
   │  🔑 Enter License                       │
   │                                         │
   │  Contact: support@xinnor.io             │
   └─────────────────────────────────────────┘

   We're excited to have you on board! 🎉
" 16 50
                continue
            fi
            if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
                run_playbook "playbooks/site.yml"
                echo ""
                echo "🎉 Deployment complete! System status:"
                echo ""
                xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
                exit 0
            fi
            ;;
        10)
            if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                if whiptail --title "📦 Update Available" --yesno "\
   A new version of xiNAS is available!

   Would you like to update now?

   This will pull the latest changes from GitHub.
" 12 50; then
                    do_update
                fi
            else
                whiptail --title "Checking for Updates" --infobox "Checking for updates..." 6 40
                check_for_updates
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if whiptail --title "📦 Update Available" --yesno "Update found! Install now?" 8 40; then
                        do_update
                    fi
                else
                    whiptail --title "✅ Up to Date" --msgbox "xiNAS is already up to date!" 8 40
                fi
            fi
            ;;
        11)
            whiptail --title "👋 See you soon!" --msgbox "\
   Thank you for choosing xiNAS!

   Run this menu again anytime:
   ./startup_menu.sh

   Questions? support@xinnor.io
" 12 45
            exit 2
            ;;
    esac
done

