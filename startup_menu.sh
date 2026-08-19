#!/usr/bin/env bash
# Interactive provisioning menu for xiNAS
# Uses colored console menus instead of whiptail
# Exits on errors and cleans up temporary files

set -euo pipefail
XINAS_SETUP_VERSION="2.0.0"
TMP_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory of the repository currently being configured
REPO_DIR="$(pwd)"
# This is the interactive installer: record per-role progress to
# install-state.json (finding #2). Day-2 management (Python TUI) leaves this
# unset, so it never overwrites install state.
export XINAS_RECORD_INSTALL_STATE=1

# Finding #8: a killed wizard must take its children with it. A SIGTERM
# (`pkill -f startup_menu.sh`) or SIGINT (Ctrl-C) otherwise kills only this bash,
# leaving a running `ansible-playbook` and its `apt-get`/`dpkg` child re-parented
# to init — still holding /var/lib/dpkg/lock and blocking the next install.
# Recursively SIGTERM every descendant before exiting.
_kill_descendants() {
    local parent="$1" child
    for child in $(pgrep -P "$parent" 2>/dev/null); do
        _kill_descendants "$child"
        kill -TERM "$child" 2>/dev/null || true
    done
}
_on_signal() {
    trap '' TERM INT            # don't re-enter while tearing down
    _kill_descendants "$$"
    exit 130                    # triggers the EXIT trap (TMP_DIR cleanup)
}
trap '_on_signal' TERM INT
trap 'rm -rf "$TMP_DIR"' EXIT

# Source the menu library
source "$SCRIPT_DIR/lib/menu_lib.sh"
. "$SCRIPT_DIR/lib/xinas_config.sh"

# Update check — GitHub Releases only (never the main branch).
# See docs/Installer/update-spec.md.
UPDATE_AVAILABLE=""
UPDATE_TARGET_TAG=""
REPO_SLUG="XinnorLab/xiNAS"

# _latest_release_tag / _current_release_tag / check_for_updates now live in
# lib/menu_lib.sh (WS3 T4, Part B) — they were byte-identical to
# simple_menu.sh's copies and had to be fixed twice in T3. See that file for
# the implementation and the ordering-safety note on REPO_DIR/REPO_SLUG.

do_update() {
    if ! command -v git &>/dev/null; then
        msg_box "Error" "Git is not installed."
        return 1
    fi

    # 20s max-time / 5s connect-timeout: unlike the passive startup check's
    # tight 3s/2s bound, this resolve only runs when the operator explicitly
    # picked "Update" without an already-cached UPDATE_TARGET_TAG — they are
    # already waiting on a blocking action, so it is correct to ride out a
    # slow-but-live network rather than fail fast (docs/Installer/update-spec.md
    # "Bash-path parity").
    local _tag="${UPDATE_TARGET_TAG:-$(_latest_release_tag 20 5)}"
    if [[ -z "$_tag" ]]; then
        msg_box "Update Failed" "Could not resolve the latest GitHub Release.\n\nxiNAS updates from releases only — no fallback to main."
        return 1
    fi

    # _tag came from an unanchored `grep -o | sed` over the GitHub API
    # response (_latest_release_tag, lib/menu_lib.sh) — refuse anything that
    # isn't a semver release tag before ever calling git (WS3 T5c).
    if ! _is_release_tag "$_tag"; then
        msg_box "Update Failed" "Refusing to check out non-release ref: '${_tag}'.\n\nxiNAS updates from releases only — no fallback to main."
        return 1
    fi

    info_box "Updating..." "Checking out release ${_tag}..."

    local _before
    _before=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")

    # The installed tree is git-dirty by design (presets are copied over
    # tracked role defaults/playbooks/site.yml), so a plain checkout aborts
    # with "local changes would be overwritten". --force discards changes
    # to *tracked* files only and is never paired with `git clean` (mirrors
    # xinas-update-git; see docs/Installer/update-spec.md "Reset-to-release").
    if git -C "$REPO_DIR" fetch origin --tags 2>"$TMP_DIR/update.log" \
        && git -C "$REPO_DIR" checkout --force "$_tag" 2>>"$TMP_DIR/update.log"; then
        UPDATE_AVAILABLE=""

        # Rebuild MCP server and NFS helper if installed
        local _mcp_dir="$REPO_DIR/xiNAS-MCP"
        local _helper_lib="/usr/lib/xinas-mcp/nfs-helper"
        if [[ -d "$_mcp_dir" && -f "$_mcp_dir/package.json" ]]; then
            info_box "Updating..." "Rebuilding MCP server..."
            local _pkg_changed=""
            if [[ -n "$_before" ]]; then
                _pkg_changed=$(git -C "$REPO_DIR" diff "$_before" HEAD \
                    -- xiNAS-MCP/package-lock.json --name-only 2>/dev/null || true)
            fi
            [[ -n "$_pkg_changed" ]] && \
                npm --prefix "$_mcp_dir" ci 2>>"$TMP_DIR/npm.log" || true
            npm --prefix "$_mcp_dir" run build 2>>"$TMP_DIR/npm.log" || {
                msg_box "MCP Build Warning" \
                    "MCP server build failed:\n\n$(head -5 "$TMP_DIR/npm.log")\n\nBase xiNAS update was successful."
            }

            if [[ -d "$_helper_lib" ]]; then
                info_box "Updating..." "Copying NFS helper files..."
                cp "$_mcp_dir"/nfs-helper/nfs_helper.py \
                   "$_mcp_dir"/nfs-helper/nfs_exports.py \
                   "$_mcp_dir"/nfs-helper/nfs_quota.py \
                   "$_mcp_dir"/nfs-helper/nfs_sessions.py \
                   "$_helper_lib/" 2>/dev/null || true
                chmod 755 "$_helper_lib/nfs_helper.py" 2>/dev/null || true
                cp "$_mcp_dir/nfs-helper/xinas-nfs-helper.service" \
                   /etc/systemd/system/xinas-nfs-helper.service 2>/dev/null || true
                systemctl daemon-reload 2>/dev/null || true
                systemctl restart xinas-nfs-helper 2>/dev/null || true
            fi
        fi

        msg_box "Update Complete" "xiNAS has been updated successfully!\n\nPlease restart the menu to use the new version."
    else
        msg_box "Update Failed" "Failed to update:\n\n$(cat "$TMP_DIR/update.log")"
    fi
}

# Run synchronously (NOT backgrounded): a background subshell's
# UPDATE_AVAILABLE/UPDATE_TARGET_TAG assignments are invisible to this parent
# shell — bash never propagates a subshell's variables back to its parent —
# so `check_for_updates &` silently discarded every result (F4). Safe to
# block on now: the tcp reachability probe above is bounded to 2s
# (`timeout 2`) and _latest_release_tag's curl is bounded to a 2s connect /
# 3s total by default (see lib/menu_lib.sh), so the worst case with GitHub
# unreachable is ~5s, not an indefinite hang.
check_for_updates

check_license() {
    local license_file="/tmp/license"
    if [ ! -f "$license_file" ]; then
        msg_box "License Required" "License file $license_file not found.\nPlease run 'Enter License' first."
        return 1
    fi
    return 0
}

# Display package status using dpkg-query with a trailing newline
pkg_status() {
    local pkg="$1"
    dpkg-query -W -f='${Status}\n' "$pkg" 2>/dev/null || true
}

# Check if xiRAID has an active license via xicli
# Sets _XIRAID_LICENSE_OUTPUT if found
# Returns 0 if active license found, 1 otherwise
_xiraid_has_license() {
    _XIRAID_LICENSE_OUTPUT=""
    command -v xicli &>/dev/null || return 1

    local output=""
    output=$(xicli license show 2>/dev/null) || return 1
    [[ -z "$output" ]] && return 1

    # Check status is valid
    local status=""
    status=$(echo "$output" | awk -F': ' '/^status:/ {print $2}') || true
    [[ "$status" != "valid" ]] && return 1

    _XIRAID_LICENSE_OUTPUT="$output"
    return 0
}

# Finding #4: `xicli license show` output is NOT a usable license file — it
# carries the hwkey/status/metadata but no license_key blob, so it cannot be fed
# back to `xicli license update -p`. Never write it to the canonical license
# path. Save the captured details to <file>.recovered for reference and return 1
# so callers fall through to manual license entry.
_save_recovered_license_note() {
    local license_file="${1:-/tmp/license}"
    local note="${license_file}.recovered"
    printf '%s\n' "$_XIRAID_LICENSE_OUTPUT" > "$note" 2>/dev/null || true
    msg_box "Cannot Auto-Recover License" \
        "xiRAID reports an active license, but 'xicli license show' is not a\nusable license file (no license key), so it cannot be reinstalled.\n\nCaptured details saved for reference:\n  $note\n\nPaste your original license, or place the license file at:\n  $license_file"
    return 1
}

# Prompt user for license string and store it in /tmp/license
# Show license prompt and save to /tmp/license
enter_license() {
    local license_file="/tmp/license"
    # chmod on a missing ./hwkey fails, and under set -e that failing `||`
    # branch aborts the whole menu — trailing `|| true` keeps a missing
    # binary from killing the interactive session (F7).
    [ -x ./hwkey ] || chmod +x ./hwkey 2>/dev/null || true
    local hwkey_val

    # Check if xiRAID already has an active license
    local has_xiraid_license=false
    if _xiraid_has_license; then
        has_xiraid_license=true
    fi

    if [ -f "$license_file" ] && [ -s "$license_file" ]; then
        # License file exists and is not empty
        if [[ "$has_xiraid_license" == "true" ]]; then
            local choice
            choice=$(menu_select "License" "License file already exists." \
                "1" "✅ Keep current license" \
                "2" "📋 Replace — paste new license" \
                "3" "🔄 Replace — recover from xiRAID" \
                "0" "🔙 Back") || return
            case "$choice" in
                1) return 0 ;;
                2) ;; # fall through to manual paste
                3)
                    # Cannot recover a usable license from `xicli license show`
                    # (finding #4) — note it and fall through to manual paste.
                    _save_recovered_license_note "$license_file" || true
                    ;;
                0) return 0 ;;
            esac
        else
            if ! yes_no "License Exists" "License already exists. Replace it?"; then
                return 0
            fi
        fi
        cp "$license_file" "${license_file}.$(date +%Y%m%d%H%M%S).bak"
    elif [[ "$has_xiraid_license" == "true" ]]; then
        # No license file but xiRAID has one — offer recovery or manual
        local choice
        choice=$(menu_select "Enter License" "No license file found. xiRAID has an active license." \
            "1" "🔄 Recover license from xiRAID (Recommended)" \
            "2" "📋 Enter license manually" \
            "0" "🔙 Back") || return
        case "$choice" in
            1)
                # `xicli license show` is not a reinstallable license (finding
                # #4) — note it and fall through to manual paste.
                _save_recovered_license_note "$license_file" || true
                ;;
            2) ;; # fall through to manual paste
            0) return 0 ;;
        esac
    fi

    # Under pipefail, this assignment's status is non-zero if ANY stage of
    # the pipe fails (a hardware-read error in ./hwkey itself, not just the
    # tr stages) — that would abort the menu (F7). Fall back to empty rather
    # than let a failing hwkey take down the whole session; `hwkey_val` is
    # also referenced under set -u below, so it must end up set either way.
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]') || hwkey_val=""

    # Show HWKEY to the user. Say "unavailable" rather than render a blank
    # after the colon: this dialog tells the operator to quote the key to
    # support, and an empty field reads as a UI glitch instead of a failed
    # hardware read.
    msg_box "Hardware Key" "HWKEY: ${hwkey_val:-unavailable}\n\nRequest your license key from xiNNOR Support."

    if ! text_area "Enter License" "Paste your license key below:" "$TMP_DIR/license"; then
        return 0
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
        text_box "Playbook Info" "$info_file"
    else
        msg_box "Not Found" "File $info_file not found"
    fi
}

# Show NFS share configuration based on the effective exports config
# (role defaults, overlaid with any preset/operator overrides).
configure_nfs_shares() {
    local vars_file="$TMP_DIR/effective_exports.yml"
    xinas_config_effective > "$vars_file"
    local share_start
    share_start=$(grep -n '^exports:' "$vars_file" | cut -d: -f1)
    local tmp="$TMP_DIR/nfs_info"
    sed -n "$((share_start+1)),$((share_start+3))p" "$vars_file" > "$tmp"
    text_box "NFS Share" "$tmp"

    local default_path
    default_path=$(awk '/^exports:/ {flag=1; next} flag && /- path:/ {print $3; exit}' "$vars_file")

    while true; do
        show_header
        local choice
        choice=$(menu_select "xiNAS Setup" "Choose an action:" \
            "1" "Edit NFS Export Path" \
            "2" "Back") || break
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

# Configure or update git repository under /opt/provision.
#
# DEV/EXPERT OVERRIDE — NOT the production update path. This lets an expert
# point the provisioning tree at an arbitrary fork/branch for development.
# Production installs and updates come from published GitHub Releases only
# (see docs/Installer/update-spec.md and the release-based do_update above);
# this manual, opt-in reconfiguration is deliberately kept separate from that
# flow and is never invoked by the automatic update checker.
configure_git_repo() {
    # Release Policy (CLAUDE.md): this repoints REPO_DIR at an arbitrary
    # URL/branch and `git pull`s a branch — forbidden in the production update
    # path. It survives only as a DEV affordance, off by default. Gate it
    # behind XINAS_DEV_REPO_CONFIG=1 so a normal expert session can't reach it.
    if [ "${XINAS_DEV_REPO_CONFIG:-0}" != "1" ]; then
        msg_box "Developer Feature" \
            "Git repository configuration is a development-only feature and is\ndisabled. xiNAS installs and updates only from published GitHub\nReleases (see docs/Installer/update-spec.md).\n\nTo enable for development, re-launch with XINAS_DEV_REPO_CONFIG=1."
        return 0
    fi

    local repo_dir="/opt/provision"
    mkdir -p "$repo_dir"

    local out="$TMP_DIR/git_config"
    if [ -d "$repo_dir/.git" ]; then
        git -C "$repo_dir" config --list >"$out" 2>&1
    else
        git config --list >"$out" 2>&1 || echo "No git configuration found" >"$out"
    fi
    text_box "Current Git Configuration" "$out"

    if ! yes_no "Modify Git" "Modify Git repository settings?"; then
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

    local url branch
    url=$(input_box "Git Repository" "Git repository URL:" "$current_url") || return 0
    branch=$(input_box "Git Branch" "Git branch:" "$current_branch") || return 0

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

    msg_box "Repository Configured" "Repository configured at $repo_dir"
    REPO_DIR="$repo_dir"
    cd "$REPO_DIR"
}

# Run ansible-playbook and stream output
run_playbook() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local inventory="${2:-inventories/lab.ini}"
    xinas_run_playbook "$playbook" -i "$inventory" -v
    return $?
}

# Run a playbook with extra variables
run_playbook_with_vars() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local extra_vars="${2:-}"
    local inventory="inventories/lab.ini"
    if [[ -n "$extra_vars" ]]; then
        xinas_run_playbook "$playbook" -i "$inventory" -v -e "$extra_vars"
    else
        xinas_run_playbook "$playbook" -i "$inventory" -v
    fi
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
            msg_box "Cleanup" "Obsolete packages removed"
            rm -f "$log"
        fi
        return 0
    fi

    found=$(echo "$pkgs" | tr '\n' ' ')
    if ! yes_no "xiRAID Packages" "Found installed xiRAID packages:\n${found}\n\nRemove them before running Ansible?"; then
        return 1
    fi

    if sudo apt-get purge -y -qq --allow-change-held-packages $pkgs >"$log" 2>&1 \
        && sudo apt-get autoremove -y -qq --allow-change-held-packages >>"$log" 2>&1 \
        && sudo rm -rf /etc/xiraid >>"$log" 2>&1; then
        msg="xiRAID packages removed successfully"
    else
        msg="Errors occurred during removal. See $log for details"
    fi
    msg_box "Removal Complete" "$msg"
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
    yes_no "Run Playbook" "Run Ansible playbook to configure the system?\n\nThis will execute the following roles:${role_list}"
}

# Show installation profile selection with descriptions
install_menu() {
    if ! has_license; then
        # Try to recover license from running xiRAID before giving up
        if _xiraid_has_license; then
            # `xicli license show` can't be reinstalled (finding #4): don't
            # fabricate /tmp/license. Note it and require a real license file.
            _save_recovered_license_note /tmp/license || true
            return
        else
            msg_box "License Required" "Oops! You need a license to continue.\n\n┌─────────────────────────────────────────┐\n│  Please complete step 2 first:          │\n│                                         │\n│  🔑 Enter License                       │\n│                                         │\n│  Contact: support@xinnor.io             │\n└─────────────────────────────────────────┘\n\nWe're excited to have you on board! 🎉"
            return
        fi
    fi

    local choice
    choice=$(menu_select "Installation Profile" "Choose how to deploy xiNAS:" \
        "1" "🖥️  Full Installation (NVMe)" \
        "2" "🖧  VM Profile (Virtual Machine)" \
        "3" "💾 Use Existing RAID Arrays" \
        "0" "🔙 Back") || return

    local desc=""
    case "$choice" in
        1)
            desc="FULL INSTALLATION — NVMe Auto-Detect\n"
            desc+="\nThis is the standard deployment for physical servers\n"
            desc+="with NVMe drives. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers for RDMA networking"
            desc+="\n  3. Configure network interfaces (IP addressing)"
            desc+="\n  4. Install Xinnor xiRAID software"
            desc+="\n  5. Auto-detect NVMe drives and create namespaces"
            desc+="\n  6. Build RAID arrays (RAID 5 data + RAID 10 log)"
            desc+="\n  7. Create XFS filesystem and mount storage"
            desc+="\n  8. Configure NFS exports for client access"
            desc+="\n  9. Apply performance tuning"
            desc+="\n\nAll non-OS NVMe drives will be used for storage."
            desc+="\nExisting data on those drives will be erased."
            if ! yes_no "Full Installation" "$desc"; then
                return
            fi
            apply_preset "default"
            ;;
        2)
            desc="VM PROFILE — Virtual Machine\n"
            desc+="\nOptimized for virtual environments using virtio or\n"
            desc+="SCSI drives instead of NVMe. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers"
            desc+="\n  3. Configure network interfaces"
            desc+="\n  4. Install Xinnor xiRAID software"
            desc+="\n  5. Auto-detect all non-OS block devices"
            desc+="\n  6. Assign drives: 2 smallest for log, rest for data"
            desc+="\n  7. Build RAID arrays and create XFS filesystem"
            desc+="\n  8. Configure NFS exports for client access"
            desc+="\n  9. Apply VM-tuned performance settings"
            desc+="\n\nAll non-OS drives will be used for storage."
            desc+="\nExisting data on those drives will be erased."
            if ! yes_no "VM Installation" "$desc"; then
                return
            fi
            apply_preset "xinnorVM"
            ;;
        3)
            desc="EXISTING RAID — Skip Array Creation\n"
            desc+="\nUse this when xiRAID arrays are already configured\n"
            desc+="and you only need to set up NFS. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers"
            desc+="\n  3. Configure network interfaces"
            desc+="\n  4. Skip xiRAID install and RAID array creation"
            desc+="\n  5. Create XFS filesystem on existing RAID devices"
            desc+="\n  6. Configure NFS exports for client access"
            desc+="\n  7. Apply performance tuning"
            desc+="\n\nExisting RAID arrays must already be present."
            desc+="\nRAID devices (/dev/xi_data, /dev/xi_log) must exist."
            if ! yes_no "Existing RAID Installation" "$desc"; then
                return
            fi
            # Use default preset but skip xiRAID installation
            apply_preset "default"
            # Set skip flags for xiraid and namespace roles
            local extra_vars="xiraid_skip_install=true nvme_auto_namespace=false"
            if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
                if run_playbook_with_vars "playbooks/site.yml" "$extra_vars"; then
                    echo ""
                    echo "🎉 Deployment complete! System status:"
                    echo ""
                    xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
                    exit 0
                fi
            fi
            return
            ;;
        0) return ;;
    esac

    if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
        if run_playbook "playbooks/site.yml"; then
            echo ""
            echo "🎉 Deployment complete! System status:"
            echo ""
            xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
            exit 0
        fi
    fi
}

# Merge configuration files from a preset directory into the group_vars
# overlay and optionally run its playbook
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

# Present available presets to the user
choose_preset() {
    local preset_dir="$REPO_DIR/presets"
    [ -d "$preset_dir" ] || { msg_box "No Presets" "No presets available"; return; }

    local -a items=()
    for d in "$preset_dir"/*/; do
        [ -d "$d" ] || continue
        items+=("$(basename "$d")" "Preset configuration")
    done
    items+=("Save" "Save current configuration")
    items+=("Back" "Return to main menu")

    show_header
    local choice
    choice=$(menu_select "Presets" "Select preset or save current:" "${items[@]}") || return

    if [ "$choice" = "Back" ]; then
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
    preset=$(input_box "Save Preset" "Preset name:") || return
    [ -n "$preset" ] || { msg_box "Error" "Preset name cannot be empty"; return; }

    local pdir="$REPO_DIR/presets/$preset"
    if [ -d "$pdir" ]; then
        if ! yes_no "Overwrite" "Preset exists. Overwrite?"; then
            return
        fi
        rm -rf "$pdir"
    fi
    mkdir -p "$pdir"

    # Decomposes the live overlay (preset + operator layers, not the
    # git-tracked role defaults) back into presets/$preset/*.yml. Guarded the
    # same way apply_preset above guards xinas_apply_preset: called through
    # command substitution, a bare failing statement inside
    # xinas_save_preset would otherwise not abort it under `set -e` (errexit
    # is suspended for the whole callee body in this calling shape), so
    # xinas_save_preset checks its own failures explicitly rather than
    # relying on that.
    local skipped rc=0
    skipped=$(xinas_save_preset "$preset" 2>&1 >/dev/null) || rc=$?
    if [ "$rc" -ne 0 ]; then
        msg_box "Error" "Preset $preset could not be saved.\n\n$skipped"
        return
    fi
    if [ -n "$skipped" ]; then
        msg_box "Preset Saved (with notes)" "Preset saved to $pdir\n\n$skipped"
    else
        msg_box "Preset Saved" "Preset saved to $pdir"
    fi
}

has_license() {
    [ -f "/tmp/license" ] && [ -s "/tmp/license" ]
}

# Detect if running inside a virtual machine
is_vm() {
    local virt
    virt=$(systemd-detect-virt 2>/dev/null) || virt=""
    [[ -n "$virt" && "$virt" != "none" ]]
}

# Suggest VM preset if running inside a VM
suggest_vm_preset() {
    is_vm || return 0
    local virt_type
    virt_type=$(systemd-detect-virt 2>/dev/null)

    if yes_no "Virtual Machine Detected" \
        "This system is running as a VM ($virt_type).\n\nVMs typically use virtio/SCSI drives instead of NVMe.\nThe xinnorVM preset auto-detects all non-OS drives\nand assigns them for RAID (2 log + remaining data).\n\nApply the xinnorVM preset?"; then
        apply_preset "xinnorVM"
    fi
}

# Show branded header
show_header() {
    clear
    echo -e "${BLUE}"
    cat << 'EOF'

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
    echo -e "${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}     xiNAS Setup${NC}  ${DIM}v${XINAS_SETUP_VERSION}${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Show welcome message
show_header
echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS Expert Mode!${NC}                           ${WHITE}│${NC}"
echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "    ${WHITE}ADVANCED CONFIGURATION FOR POWER USERS${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "    ${GREEN}📊${NC}  Collect system information"
echo -e "    ${GREEN}🔑${NC}  Enter your license (required)"
echo -e "    ${GREEN}🌐${NC}  Configure network & hostname"
echo -e "    ${GREEN}💾${NC}  Configure RAID & NFS exports"
echo -e "    ${GREEN}📦${NC}  Manage presets"
echo -e "    ${GREEN}🚀${NC}  Launch the installation"
echo ""
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""
read -p "    Press Enter to continue..." -r

# Suggest VM preset if running on a virtual machine
suggest_vm_preset

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced Settings Menu
# ═══════════════════════════════════════════════════════════════════════════════

advanced_settings_menu() {
    while true; do
        show_header

        # Update status indicator
        local update_text="🔄 Check for Updates"
        if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
            update_text="🔄 Check for Updates [Update Available!]"
        fi

        # Developer-only affordance (see configure_git_repo's Release Policy
        # gate): label it as such when reachable, so an operator without the
        # env var set sees the entry but not a false promise it will work.
        local git_repo_text="🔧 Git Repository Configuration (dev, disabled)"
        if [ "${XINAS_DEV_REPO_CONFIG:-0}" = "1" ]; then
            git_repo_text="🔧 Git Repository Configuration (dev)"
        fi

        local choice
        choice=$(menu_select "Advanced Settings" "Configuration & Management Options" \
            "1" "🌐 Configure Network" \
            "2" "🏷️  Set Hostname" \
            "3" "💾 Configure RAID" \
            "4" "📂 Edit NFS Exports" \
            "5" "📦 Presets" \
            "6" "$git_repo_text" \
            "7" "$update_text" \
            "0" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) configure_network ;;
            2) configure_hostname ;;
            3) configure_raid ;;
            4) edit_nfs_exports ;;
            5) choose_preset ;;
            6) configure_git_repo ;;
            7)
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if yes_no "Update Available" "A new version of xiNAS is available!\n\nWould you like to update now?\n\nThis will pull the latest changes from GitHub."; then
                        do_update
                    fi
                else
                    info_box "Checking for Updates" "Checking for updates..."
                    check_for_updates
                    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                        if yes_no "Update Found" "Update found! Install now?"; then
                            do_update
                        fi
                    else
                        msg_box "Up to Date" "xiNAS is already up to date!"
                    fi
                fi
                ;;
            0) return ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

while true; do
    show_header

    # Build dynamic menu based on license status
    if has_license; then
        license_text="🔑 Enter License [Licensed]"
        license_status="${GREEN}✅ Licensed${NC}"
        install_text="🚀 Install"
    else
        license_text="🔑 Enter License [Required]"
        license_status="${RED}❌ No License${NC}"
        install_text="🚀 Install [License Required]"
    fi

    # Advanced settings indicator
    advanced_text="🛠 Advanced Settings"
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        advanced_text="🛠 Advanced Settings [!]"
    fi

    # Show status bar
    echo -e "  ${WHITE}License:${NC} $license_status"
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        echo -e "  ${WHITE}Updates:${NC} ${YELLOW}📦 Update available!${NC}"
    fi
    echo ""

    choice=$(menu_select "xiNAS Setup v${XINAS_SETUP_VERSION}" "Select an option:" \
        "1" "📊 Collect System Data" \
        "2" "$license_text" \
        "3" "$install_text" \
        "4" "$advanced_text" \
        "0" "🚪 Exit") || { echo ""; exit 2; }

    case "$choice" in
        1) ./collect_data.sh ;;
        2) enter_license ;;
        3) install_menu ;;
        4) advanced_settings_menu ;;
        0)
            msg_box "See you soon!" "Thank you for choosing xiNAS!\n\nRun this menu again anytime:\nsudo xinas-menu\n\nQuestions? support@xinnor.io"
            exit 2
            ;;
    esac
done
