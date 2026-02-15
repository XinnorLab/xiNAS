#!/usr/bin/env bash
# xiNAS Post-Install Management Menu
# Colored console menu for daily NAS management
# Run after each login for quick system management

set -euo pipefail

# Save original args for exec restart after update
_ORIG_ARGS=("$@")

# Debug mode: --debug or --db flag enables error tracing
XINAS_DEBUG=false
for _arg in "$@"; do
    [[ "$_arg" == "--debug" || "$_arg" == "--db" ]] && XINAS_DEBUG=true
done
if [[ "$XINAS_DEBUG" == "true" ]]; then
    XINAS_DEBUG_LOG="/tmp/xinas-debug.log"
    : > "$XINAS_DEBUG_LOG"
    _debug_trap() {
        local _ec=$? _ln=${BASH_LINENO[0]} _cmd="$BASH_COMMAND"
        local _fn="${FUNCNAME[1]:-main}" _src="${BASH_SOURCE[1]:-unknown}"
        printf '[ERR] exit=%d line=%d func=%s cmd=%s file=%s\n' \
            "$_ec" "$_ln" "$_fn" "$_cmd" "$_src" >> "$XINAS_DEBUG_LOG"
        printf '[ERR] exit=%d line=%d func=%s cmd=%s\n' \
            "$_ec" "$_ln" "$_fn" "$_cmd" >/dev/tty
    }
    trap '_debug_trap' ERR
    echo "Debug mode ON — logging to $XINAS_DEBUG_LOG"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Version tracking
XINAS_MENU_VERSION="1.4.0"

# Source the menu library (check multiple locations)
if [[ -f "$SCRIPT_DIR/lib/menu_lib.sh" ]]; then
    source "$SCRIPT_DIR/lib/menu_lib.sh"
elif [[ -f "/usr/local/bin/lib/menu_lib.sh" ]]; then
    source "/usr/local/bin/lib/menu_lib.sh"
elif [[ -f "/opt/xiNAS/lib/menu_lib.sh" ]]; then
    source "/opt/xiNAS/lib/menu_lib.sh"
elif [[ -f "/home/xinnor/xiNAS/lib/menu_lib.sh" ]]; then
    source "/home/xinnor/xiNAS/lib/menu_lib.sh"
else
    echo "Error: menu_lib.sh not found" >&2
    exit 1
fi

# Source operation status library
if [[ -f "$SCRIPT_DIR/lib/op_status.sh" ]]; then
    source "$SCRIPT_DIR/lib/op_status.sh"
elif [[ -f "/usr/local/bin/lib/op_status.sh" ]]; then
    source "/usr/local/bin/lib/op_status.sh"
elif [[ -f "/opt/xiNAS/lib/op_status.sh" ]]; then
    source "/opt/xiNAS/lib/op_status.sh"
elif [[ -f "/home/xinnor/xiNAS/lib/op_status.sh" ]]; then
    source "/home/xinnor/xiNAS/lib/op_status.sh"
fi

# Audit log
AUDIT_LOG="/var/log/xinas/audit.log"
AUDIT_LOGROTATE="/etc/logrotate.d/xinas-audit"

audit_log() {
    local action="$1"
    local detail="${2:-}"
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    local user="${SUDO_USER:-$USER}"
    mkdir -p "$(dirname "$AUDIT_LOG")"
    printf '%s | %-8s | %s' "$ts" "$user" "$action" >> "$AUDIT_LOG"
    [[ -n "$detail" ]] && printf ' | %s' "$detail" >> "$AUDIT_LOG"
    printf '\n' >> "$AUDIT_LOG"
    # Ensure logrotate config exists
    if [[ ! -f "$AUDIT_LOGROTATE" ]]; then
        cat > "$AUDIT_LOGROTATE" 2>/dev/null <<'LOGROTATE'
/var/log/xinas/audit.log {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}
LOGROTATE
    fi
}

# Initialize operation log
_op_log_init

# Locate healthcheck.sh (check multiple locations)
_find_healthcheck() {
    local paths=(
        "$SCRIPT_DIR/healthcheck.sh"
        "/usr/local/bin/healthcheck.sh"
        "/opt/xiNAS/healthcheck.sh"
        "/home/xinnor/xiNAS/healthcheck.sh"
    )
    for p in "${paths[@]}"; do
        if [[ -f "$p" ]]; then
            echo "$p"
            return 0
        fi
    done
    return 1
}

# Update check
UPDATE_AVAILABLE=""
UPDATE_DETAILS=""

# Locate the xiNAS git repo (may differ from SCRIPT_DIR when installed to /usr/local/bin)
_find_repo_dir() {
    local candidates=(
        "$SCRIPT_DIR"
        "/opt/xiNAS"
        "/home/xinnor/xiNAS"
    )
    for dir in "${candidates[@]}"; do
        if [[ -d "$dir/.git" ]]; then
            echo "$dir"
            return 0
        fi
    done
    return 1
}

# Compare installed scripts against repo copies; populate UPDATE_DETAILS
_check_installed_files() {
    local repo_dir="$1"
    local stale_files=()
    # Map: repo_path -> installed_path
    local -A file_map=(
        ["post_install_menu.sh"]="/usr/local/bin/xinas-menu"
        ["lib/menu_lib.sh"]="/usr/local/bin/lib/menu_lib.sh"
        ["lib/op_status.sh"]="/usr/local/bin/lib/op_status.sh"
        ["healthcheck.sh"]="/usr/local/bin/healthcheck.sh"
    )
    for repo_rel in "${!file_map[@]}"; do
        local repo_file="$repo_dir/$repo_rel"
        local inst_file="${file_map[$repo_rel]}"
        if [[ -f "$repo_file" ]] && [[ -f "$inst_file" ]]; then
            if ! cmp -s "$repo_file" "$inst_file"; then
                stale_files+=("$repo_rel")
            fi
        fi
    done
    if (( ${#stale_files[@]} > 0 )); then
        UPDATE_DETAILS="Outdated installed files:\n"
        for f in "${stale_files[@]}"; do
            UPDATE_DETAILS+="  - $f\n"
        done
        return 0
    fi
    return 1
}

check_for_updates() {
    command -v git &>/dev/null || return 0
    local repo_dir
    repo_dir=$(_find_repo_dir) || return 0

    # Check if installed copies differ from repo
    if _check_installed_files "$repo_dir"; then
        UPDATE_AVAILABLE="true"
    fi

    # Check remote for new commits
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0
    local local_commit
    local_commit=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0
    git -C "$repo_dir" fetch --quiet origin main 2>/dev/null || return 0
    local remote_commit
    remote_commit=$(git -C "$repo_dir" rev-parse origin/main 2>/dev/null) || return 0
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
        local behind
        behind=$(git -C "$repo_dir" rev-list --count HEAD..origin/main 2>/dev/null) || behind="?"
        UPDATE_DETAILS="Remote is ${behind} commit(s) ahead\n${UPDATE_DETAILS}"
    fi
}

do_update() {
    if ! command -v git &>/dev/null; then
        msg_box "Error" "Git is not installed."
        return 1
    fi
    local repo_dir
    repo_dir=$(_find_repo_dir) || { msg_box "Error" "Cannot find xiNAS git repository."; return 1; }

    info_box "Updating..." "Pulling latest changes from origin/main..."
    if git -C "$repo_dir" pull origin main 2>"$TMP_DIR/update.log"; then
        # Sync installed scripts from repo
        local synced=()
        if [[ -f "$repo_dir/post_install_menu.sh" ]]; then
            cp "$repo_dir/post_install_menu.sh" /usr/local/bin/xinas-menu 2>/dev/null && synced+=("xinas-menu")
        fi
        if [[ -f "$repo_dir/lib/menu_lib.sh" ]]; then
            mkdir -p /usr/local/bin/lib
            cp "$repo_dir/lib/menu_lib.sh" /usr/local/bin/lib/menu_lib.sh 2>/dev/null && synced+=("lib/menu_lib.sh")
        fi
        if [[ -f "$repo_dir/lib/op_status.sh" ]]; then
            mkdir -p /usr/local/bin/lib
            cp "$repo_dir/lib/op_status.sh" /usr/local/bin/lib/op_status.sh 2>/dev/null && synced+=("lib/op_status.sh")
        fi
        if [[ -f "$repo_dir/healthcheck.sh" ]]; then
            cp "$repo_dir/healthcheck.sh" /usr/local/bin/healthcheck.sh 2>/dev/null && synced+=("healthcheck.sh")
        fi
        if [[ -d "$repo_dir/healthcheck_profiles" ]]; then
            cp -r "$repo_dir/healthcheck_profiles" /usr/local/bin/ 2>/dev/null && synced+=("healthcheck_profiles/")
        fi
        UPDATE_AVAILABLE=""
        UPDATE_DETAILS=""
        local sync_msg=""
        if (( ${#synced[@]} > 0 )); then
            sync_msg="\n\nSynced installed files:\n"
            for f in "${synced[@]}"; do
                sync_msg+="  - $f\n"
            done
        fi
        msg_box "Update Complete" "xiNAS has been updated!${sync_msg}\nRestarting menu..."
        exec "$0" "${_ORIG_ARGS[@]}"
    else
        msg_box "Update Failed" "Failed to update:\n\n$(cat "$TMP_DIR/update.log")"
    fi
}

# Run update check in background (use temp file to pass results back from subshell)
_UPDATE_FILE="$TMP_DIR/.update_status"
(
    check_for_updates
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        printf '%s\n' "$UPDATE_DETAILS" > "$_UPDATE_FILE"
    fi
) &
_load_bg_update() {
    if [[ -f "$_UPDATE_FILE" ]]; then
        UPDATE_AVAILABLE="true"
        UPDATE_DETAILS=$(cat "$_UPDATE_FILE")
        rm -f "$_UPDATE_FILE"
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
    echo -e "${YELLOW}     NAS Management Console${NC}  ${DIM}v${XINAS_MENU_VERSION}${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Check if running in interactive terminal (skip for non-interactive CLI flags)
case "${1:-}" in
    --version|-v|--help|-h|--status|-s|--raid|-r|--healthcheck|--hc|--debug|--db) ;;
    *)
        if [[ ! -t 0 ]]; then
            echo "This script must be run in an interactive terminal"
            exit 1
        fi
        ;;
esac

# ═══════════════════════════════════════════════════════════════════════════════
# RAID Information Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_raid_info() {
    local extended="${1:-false}"
    local out="$TMP_DIR/raid_info"
    local title="RAID Arrays"

    if [[ "$extended" == "true" ]]; then
        title="RAID Arrays (Extended)"
    fi

    if ! command -v xicli &>/dev/null; then
        msg_box "$title" "xiRAID CLI not found\n\nThe xicli command is not installed.\nPlease ensure xiRAID is properly installed.\n\nRun the installation playbook first:\n./startup_menu.sh → Install"
        return
    fi

    # Get JSON output and format it nicely
    local json_file="$TMP_DIR/raid_json"
    local ext_flag=""
    [[ "$extended" == "true" ]] && ext_flag="-e"

    if ! xicli raid show -f json $ext_flag > "$json_file" 2>&1; then
        msg_box "$title" "Failed to retrieve RAID information"
        return
    fi

    # Format the JSON output using Python
    python3 - "$json_file" "$extended" > "$out" << 'PYEOF'
import sys
import json

# Box drawing constants
W = 74  # Inner width of the box
import unicodedata

def char_width(c):
    """Get display width of a character (emoji=2, most others=1)"""
    if ord(c) > 0x1F000:  # Emoji range
        return 2
    ea = unicodedata.east_asian_width(c)
    return 2 if ea in ('F', 'W') else 1

def visible_len(s):
    """Get visible terminal width of string"""
    return sum(char_width(c) for c in s)

def line(content="", border="|"):
    """Create a line with proper padding to align right border"""
    vlen = visible_len(content)
    padding = W - vlen
    if padding < 0:
        content = content[:W]
        padding = 0
    return f"{border} {content}{' ' * padding}{border}"

def separator(char="-", left="+", right="+"):
    return f"{left}{char * (W + 1)}{right}"

def progress_bar(percent, width=30):
    filled = int(percent * width / 100)
    empty = width - filled
    return f"[{'#' * filled}{'.' * empty}] {percent:3d}%"

def format_state(state_list):
    if not state_list:
        return "unknown"
    states = state_list if isinstance(state_list, list) else [state_list]
    # Filter out None/empty values
    states = [s for s in states if s]
    if not states:
        return "unknown"
    icons = {
        "online": "*", "initialized": "*", "initing": "~",
        "degraded": "!", "rebuilding": "~", "offline": "x", "failed": "x"
    }
    return " ".join(f"{icons.get(s.lower(), '•')} {s}" for s in states)

def count_device_states(devices):
    online = degraded = offline = 0
    for dev in devices:
        raw = dev[2][0] if dev[2] and dev[2][0] else None
        state = raw.lower() if raw else "unknown"
        if state == "online":
            online += 1
        elif state in ["degraded", "rebuilding"]:
            degraded += 1
        else:
            offline += 1
    return online, degraded, offline

try:
    json_file = sys.argv[1]
    extended = sys.argv[2] == "true"

    with open(json_file) as f:
        data = json.load(f)

    if not data:
        print("No RAID arrays configured")
        sys.exit(0)

    # Header
    print(f"+{'=' * (W + 1)}+")
    title = "  RAID ARRAY STATUS"
    title_width = visible_len(title)
    pad = (W - title_width) // 2
    print(f"|{' ' * pad}{title}{' ' * (W - pad - title_width + 1)}|")
    print(f"+{'=' * (W + 1)}+")
    print()

    for name, arr in data.items():
        level = arr.get("level", "?")
        size = arr.get("size", "N/A")
        state = arr.get("state", [])
        devices = arr.get("devices", [])
        strip_size = arr.get("strip_size", "?")
        sparepool = arr.get("sparepool", "-")
        init_progress = arr.get("init_progress")
        memory_mb = arr.get("memory_usage_mb", 0)
        block_size = arr.get("block_size", 4096)

        online, degraded, offline = count_device_states(devices)
        total_devs = len(devices)
        state_str = format_state(state)
        is_initing = any(s and s.lower() == "initing" for s in state)

        # Build device summary
        dev_parts = [f"{total_devs} total", f"{online} online"]
        if degraded > 0:
            dev_parts.append(f"{degraded} degraded")
        if offline > 0:
            dev_parts.append(f"{offline} offline")
        dev_summary = " | ".join(dev_parts)

        # Array box
        print(f"+{'-' * (W + 1)}+")
        print(line(f" Array: {name.upper()}"))
        print(separator())
        print(line())
        print(line(f"  RAID Level    |  RAID-{level}"))
        print(line(f"  Capacity      |  {size}"))
        print(line(f"  Status        |  {state_str}"))
        print(line(f"  Devices       |  {dev_summary}"))
        print(line(f"  Strip Size    |  {strip_size} KB"))
        print(line(f"  Spare Pool    |  {sparepool}"))

        if init_progress is not None and is_initing:
            print(line())
            print(line(f"  ~ Initializing: {progress_bar(init_progress)}"))

        if extended:
            print(line())
            print(line(f"  Memory Usage  |  {memory_mb} MB"))
            print(line(f"  Block Size    |  {block_size} bytes"))

            health = arr.get("devices_health")
            wear = arr.get("devices_wear")
            if health or wear:
                print(line())
                print(separator())
                print(line(" DEVICE HEALTH & WEAR"))
                print(separator())
                for i, dev in enumerate(devices):
                    dev_path = dev[1].replace("/dev/", "")
                    dev_state = dev[2][0] if dev[2] else "?"
                    h = health[i] if health and i < len(health) else "N/A"
                    w = wear[i] if wear and i < len(wear) else "N/A"
                    icon = "*" if dev_state.lower() == "online" else "o"
                    print(line(f"  {icon} {dev_path:<14} Health: {h:<6} Wear: {w}"))

        print(line())
        print(f"+{'-' * (W + 1)}+")
        print()

    # Summary
    total_arrays = len(data)
    healthy = sum(1 for a in data.values()
                  if all(s.lower() in ["online", "initialized"] for s in a.get("state", [])))
    print(f"{'=' * (W + 3)}")
    print(f"  Summary: {total_arrays} array(s), {healthy} healthy")
    print(f"{'=' * (W + 3)}")

except Exception as e:
    print(f"Error parsing RAID data: {e}")
    sys.exit(1)
PYEOF

    text_box "$title" "$out"
}

show_physical_drives() {
    if ! command -v xicli &>/dev/null; then
        echo "xicli not found"
        return
    fi

    local json_file
    json_file=$(mktemp)

    if ! xicli raid show -f json -e > "$json_file" 2>&1; then
        echo "Failed to get RAID information"
        rm -f "$json_file"
        return
    fi

    python3 - "$json_file" << 'PYEOF'
import sys
import json
import os

def get_drive_size(path):
    """Get drive size from /sys/block"""
    try:
        dev_name = os.path.basename(path)
        size_path = f"/sys/block/{dev_name}/size"
        if os.path.exists(size_path):
            with open(size_path) as f:
                sectors = int(f.read().strip())
                bytes_size = sectors * 512
                return format_size(bytes_size)
    except:
        pass
    return "N/A"

def format_size(bytes_size):
    """Format bytes to human readable"""
    if bytes_size >= 1099511627776:
        return f"{bytes_size / 1099511627776:.1f} TB"
    elif bytes_size >= 1073741824:
        return f"{bytes_size / 1073741824:.0f} GB"
    elif bytes_size >= 1048576:
        return f"{bytes_size / 1048576:.0f} MB"
    return f"{bytes_size} B"

def get_numa_node(path):
    """Get NUMA node for an NVMe device from sysfs"""
    import re
    try:
        dev_name = os.path.basename(path)
        # Extract controller name (nvme0 from nvme0n1, nvme10 from nvme10n2)
        m = re.match(r"(nvme\d+)", dev_name)
        if m:
            ctrl = m.group(1)
            numa_path = f"/sys/class/nvme/{ctrl}/numa_node"
            if os.path.exists(numa_path):
                with open(numa_path) as f:
                    node = f.read().strip()
                    return node if node != "-1" else "-"
        # Fallback for non-NVMe block devices
        numa_path = f"/sys/block/{dev_name}/device/numa_node"
        if os.path.exists(numa_path):
            with open(numa_path) as f:
                node = f.read().strip()
                return node if node != "-1" else "-"
    except:
        pass
    return "-"

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)

    if not data:
        print("No RAID arrays configured")
        sys.exit(0)

    print("PHYSICAL DRIVES")
    print("=" * 75)
    print()

    # Collect all drives from all arrays
    all_drives = []
    for arr_name, arr in data.items():
        devices = arr.get("devices", [])
        health = arr.get("devices_health") or []
        wear = arr.get("devices_wear") or []
        serials = arr.get("serials") or []

        for i, dev in enumerate(devices):
            idx = dev[0]
            path = dev[1]
            state = dev[2][0] if dev[2] else "unknown"
            h = health[i] if i < len(health) else "N/A"
            w = wear[i] if i < len(wear) else "N/A"
            serial = serials[i] if i < len(serials) else "N/A"
            size = get_drive_size(path)
            numa = get_numa_node(path)
            all_drives.append({
                "array": arr_name,
                "idx": idx,
                "path": path,
                "state": state,
                "health": h,
                "wear": w,
                "serial": serial,
                "size": size,
                "numa": numa
            })

    # Group by array
    arrays = {}
    for d in all_drives:
        arr = d["array"]
        if arr not in arrays:
            arrays[arr] = []
        arrays[arr].append(d)

    for arr_name, drives in arrays.items():
        online = sum(1 for d in drives if d["state"].lower() == "online")
        total = len(drives)

        print(f"Array: {arr_name.upper()} ({online}/{total} online)")
        print("-" * 75)
        print(f"  {'Device':<14}{'Size':<10}{'State':<10}{'NUMA':<6}{'Health':<8}{'Wear':<7}{'Serial'}")
        print("-" * 75)

        for d in drives:
            path = d["path"].replace("/dev/", "")
            state = d["state"]
            icon = "*" if state.lower() == "online" else "o"
            health = d["health"]
            wear = d["wear"]
            size = d["size"]
            numa = d["numa"]
            serial = d["serial"][:16] if len(d["serial"]) > 16 else d["serial"]
            print(f"  {icon} {path:<12}{size:<10}{state:<10}{numa:<6}{health:<8}{wear:<7}{serial}")

        print()

    # Summary
    total_drives = len(all_drives)
    online_drives = sum(1 for d in all_drives if d["state"].lower() == "online")
    numa_nodes = sorted(set(d["numa"] for d in all_drives if d["numa"] != "-"))
    print("=" * 75)
    summary = f"Total: {total_drives} drives, {online_drives} online"
    if numa_nodes:
        summary += f" (NUMA nodes: {', '.join(numa_nodes)})"
    print(summary)

except Exception as e:
    print(f"Error: {e}")
PYEOF

    rm -f "$json_file"
}

show_spare_pools() {
    if ! command -v xicli &>/dev/null; then
        echo "xicli not found"
        return
    fi

    local json_file
    json_file=$(mktemp)

    if ! xicli pool show -f json > "$json_file" 2>&1; then
        echo "Failed to get spare pool information"
        rm -f "$json_file"
        return
    fi

    python3 - "$json_file" << 'PYEOF'
import sys
import json

W = 66

def line(content="", border="|"):
    padding = W - len(content)
    if padding < 0:
        content = content[:W]
        padding = 0
    return f"{border} {content}{' ' * padding}{border}"

def separator(char="-", left="+", right="+"):
    return f"{left}{char * (W + 1)}{right}"

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)

    if not data:
        print("=" * 50)
        print("          SPARE POOLS")
        print("=" * 50)
        print()
        print("  No spare pools configured.")
        print()
        print("  Spare pools can be created with:")
        print("    xicli pool create -n <name> -d <drive1> [drive2]..[driveN]")
        print()
        sys.exit(0)

    # Header
    print("=" * (W + 3))
    print("          SPARE POOLS")
    print("=" * (W + 3))
    print()

    for name, pool in data.items():
        devices = pool.get("devices", [])
        serials = pool.get("serials", [])
        sizes = pool.get("sizes", [])
        state = pool.get("state", "unknown")

        print(f"+{'-' * (W + 1)}+")
        print(line(f" Pool: {name.upper()}"))
        print(separator())
        print(line(f"  State: {state}"))
        print(line(f"  Devices: {len(devices)}"))
        print(separator())

        if devices:
            print(line(f"  {'Device':<20}{'Size':<15}{'Serial'}"))
            print(separator())
            for i, dev in enumerate(devices):
                dev_path = dev[1] if isinstance(dev, list) else dev
                dev_path = dev_path.replace("/dev/", "")
                size = sizes[i] if i < len(sizes) else "N/A"
                serial = serials[i][:16] if i < len(serials) and serials[i] else "N/A"
                print(line(f"  {dev_path:<20}{size:<15}{serial}"))

        print(line())
        print(f"+{'-' * (W + 1)}+")
        print()

    print(f"  Total: {len(data)} pool(s)")
    print("=" * (W + 3))

except Exception as e:
    print(f"Error: {e}")
PYEOF

    rm -f "$json_file"
}

raid_menu() {
    local choice
    local out
    while true; do
        show_header
        choice=$(menu_select "💾 RAID Management" "View and manage your storage arrays" \
            "1" "📋 Quick Overview" \
            "2" "🔍 Extended Details" \
            "3" "💿 Physical Drives" \
            "4" "🔄 Spare Pools" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) audit_log "RAID > Quick Overview"; show_raid_info "false" ;;
            2) audit_log "RAID > Extended Details"; show_raid_info "true" ;;
            3)
                audit_log "RAID > Physical Drives"
                out="$TMP_DIR/drives"
                show_physical_drives > "$out"
                text_box "💿 Physical Drives" "$out"
                ;;
            4)
                audit_log "RAID > Spare Pools"
                out="$TMP_DIR/pools"
                show_spare_pools > "$out"
                text_box "🔄 Spare Pools" "$out"
                ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Network Configuration Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_network_info() {
    local out="$TMP_DIR/net_info"

    python3 - > "$out" << 'PYEOF'
import subprocess
import os
import socket

def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL).decode().strip()
    except:
        return ""

def get_interfaces():
    interfaces = []
    net_path = "/sys/class/net"
    for iface in os.listdir(net_path):
        if iface == "lo":
            continue
        iface_path = os.path.join(net_path, iface)
        if not os.path.isdir(iface_path):
            continue

        # Get state
        try:
            with open(os.path.join(iface_path, "operstate")) as f:
                state = f.read().strip()
        except:
            state = "unknown"

        # Get speed
        try:
            with open(os.path.join(iface_path, "speed")) as f:
                speed = int(f.read().strip())
        except:
            speed = 0

        # Get MAC
        try:
            with open(os.path.join(iface_path, "address")) as f:
                mac = f.read().strip()
        except:
            mac = "N/A"

        # Get driver
        try:
            driver_link = os.path.join(iface_path, "device/driver")
            driver = os.path.basename(os.readlink(driver_link))
        except:
            driver = ""

        # Get IP
        ip_out = run(f"ip -o -4 addr show {iface}")
        ip_addr = ""
        if ip_out:
            parts = ip_out.split()
            for i, p in enumerate(parts):
                if p == "inet" and i + 1 < len(parts):
                    ip_addr = parts[i + 1]
                    break

        # Get IPv6
        ip6_out = run(f"ip -o -6 addr show {iface} scope global")
        ip6_addr = ""
        if ip6_out:
            parts = ip6_out.split()
            for i, p in enumerate(parts):
                if p == "inet6" and i + 1 < len(parts):
                    ip6_addr = parts[i + 1]
                    break

        interfaces.append({
            "name": iface,
            "state": state,
            "speed": speed,
            "mac": mac,
            "driver": driver,
            "ip": ip_addr,
            "ip6": ip6_addr
        })

    return sorted(interfaces, key=lambda x: x["name"])

def format_speed(speed):
    if speed <= 0:
        return "---"
    elif speed >= 100000:
        return f"{speed // 1000}Gb/s"
    elif speed >= 1000:
        return f"{speed // 1000}Gb/s"
    else:
        return f"{speed}Mb/s"

def speed_bar(speed):
    """Visual bar for speed"""
    if speed <= 0:
        return "[----]"
    elif speed >= 100000:
        return "[****]"  # 100Gb+
    elif speed >= 25000:
        return "[*** ]"  # 25-100Gb
    elif speed >= 10000:
        return "[**  ]"  # 10-25Gb
    elif speed >= 1000:
        return "[*   ]"  # 1-10Gb
    else:
        return "[.   ]"  # < 1Gb

# Header
hostname = socket.gethostname()
try:
    fqdn = socket.getfqdn()
except:
    fqdn = hostname

print("NETWORK CONFIGURATION")
print("=" * 72)
print()

# System info
print(f"  Hostname:  {hostname}")
if fqdn != hostname:
    print(f"  FQDN:      {fqdn}")
print()

# Get default gateway
gw_info = run("ip route | grep default")
if gw_info:
    parts = gw_info.split()
    gw_ip = parts[2] if len(parts) > 2 else "N/A"
    gw_dev = parts[4] if len(parts) > 4 else "N/A"
    print(f"  Gateway:   {gw_ip} via {gw_dev}")

# Get DNS
dns_servers = []
try:
    with open("/etc/resolv.conf") as f:
        for line in f:
            if line.strip().startswith("nameserver"):
                dns_servers.append(line.split()[1])
except:
    pass
if dns_servers:
    print(f"  DNS:       {', '.join(dns_servers[:3])}")

print()
print("-" * 72)
print("  NETWORK INTERFACES")
print("-" * 72)
print()

interfaces = get_interfaces()
up_count = sum(1 for i in interfaces if i["state"] == "up")
total = len(interfaces)

print(f"  Found {total} interface(s), {up_count} active")
print()

for iface in interfaces:
    name = iface["name"]
    state = iface["state"]
    speed = iface["speed"]
    mac = iface["mac"]
    driver = iface["driver"]
    ip = iface["ip"]
    ip6 = iface["ip6"]

    # Status icon
    if state == "up":
        icon = "[UP]"
    elif state == "down":
        icon = "[DN]"
    else:
        icon = "[??]"

    speed_str = format_speed(speed)
    bar = speed_bar(speed)

    print(f"  {icon} {name}")
    print(f"      State:   {state:<10} Speed: {bar} {speed_str}")
    if ip:
        print(f"      IPv4:    {ip}")
    else:
        print(f"      IPv4:    (not configured)")
    if ip6:
        print(f"      IPv6:    {ip6}")
    print(f"      MAC:     {mac}")
    if driver:
        print(f"      Driver:  {driver}")
    print()

print("-" * 72)
print("  ROUTING TABLE")
print("-" * 72)
print()

routes = run("ip route show")
if routes:
    for line in routes.split("\n")[:8]:
        print(f"  {line}")
else:
    print("  No routes configured")

print()
print("=" * 72)
PYEOF

    text_box "Network Information" "$out"
}

edit_interface_ip() {
    # Edit IP address of a specific interface directly in netplan
    local netplan_file="/etc/netplan/99-xinas.yaml"

    # Find the netplan file
    if [[ ! -f "$netplan_file" ]]; then
        for f in /etc/netplan/*.yaml; do
            [[ -f "$f" ]] && { netplan_file="$f"; break; }
        done
    fi

    if [[ ! -f "$netplan_file" ]]; then
        msg_box "No Config" "No netplan configuration found.\n\nRun the initial setup first."
        return
    fi

    # Get list of interfaces from the system
    local -a ifaces=()
    local -a menu_items=()

    for iface_path in /sys/class/net/*; do
        [[ -d "$iface_path" ]] || continue
        local name
        name=$(basename "$iface_path")
        [[ "$name" == "lo" ]] && continue

        local state ip_addr speed_str
        state=$(cat "$iface_path/operstate" 2>/dev/null || echo "unknown")
        ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}' | head -1)
        [[ -z "$ip_addr" ]] && ip_addr="no IP"

        local speed
        speed=$(cat "$iface_path/speed" 2>/dev/null || echo "0")
        if [[ "$speed" =~ ^[0-9]+$ ]] && [[ $speed -gt 0 ]]; then
            if [[ $speed -ge 1000 ]]; then
                speed_str="$((speed/1000))G"
            else
                speed_str="${speed}M"
            fi
        else
            speed_str="--"
        fi

        ifaces+=("$name")
        menu_items+=("$name" "[$state] $ip_addr ($speed_str)")
    done

    if [[ ${#ifaces[@]} -eq 0 ]]; then
        msg_box "No Interfaces" "No network interfaces found."
        return
    fi

    menu_items+=("Done" "Finish and apply changes")

    local changes_made=false

    while true; do
        show_header
        local choice
        choice=$(menu_select "Edit Interface IP" "Select interface to configure:\n\nCurrent netplan: $netplan_file" \
            "${menu_items[@]}") || break

        [[ "$choice" == "Done" ]] && break
        [[ -z "$choice" ]] && continue

        # Get current IP for this interface
        local current_ip
        current_ip=$(ip -o -4 addr show "$choice" 2>/dev/null | awk '{print $4}' | head -1)
        [[ -z "$current_ip" ]] && current_ip="10.10.1.1/24"

        local new_ip
        new_ip=$(input_box "Configure $choice" "Enter IPv4 address with prefix:\n\nCurrent: $current_ip\nFormat:  X.X.X.X/prefix (e.g., 192.168.1.100/24)\n\nLeave empty to skip this interface." "$current_ip") || continue

        [[ -z "$new_ip" ]] && continue

        # Validate IP/CIDR format
        if [[ ! "$new_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            msg_box "Invalid Format" "Invalid IP format.\n\nUse: X.X.X.X/prefix (e.g., 192.168.1.100/24)"
            continue
        fi

        # Update netplan file using Python for safe YAML editing
        local tmp_file
        tmp_file=$(mktemp)

        python3 - "$netplan_file" "$choice" "$new_ip" "$tmp_file" << 'PYEOF'
import sys
import yaml

netplan_file = sys.argv[1]
iface = sys.argv[2]
new_ip = sys.argv[3]
tmp_file = sys.argv[4]

try:
    with open(netplan_file) as f:
        config = yaml.safe_load(f) or {}
except:
    config = {}

# Ensure structure exists
if "network" not in config:
    config["network"] = {}
if "version" not in config["network"]:
    config["network"]["version"] = 2
if "renderer" not in config["network"]:
    config["network"]["renderer"] = "networkd"
if "ethernets" not in config["network"]:
    config["network"]["ethernets"] = {}

# Update interface
config["network"]["ethernets"][iface] = {
    "dhcp4": False,
    "addresses": [new_ip]
}

with open(tmp_file, "w") as f:
    yaml.dump(config, f, default_flow_style=False, sort_keys=False)

print("OK")
PYEOF

        if [[ -f "$tmp_file" && -s "$tmp_file" ]]; then
            # Backup and replace
            local ts
            ts=$(date +%Y%m%d%H%M%S)
            sudo cp "$netplan_file" "${netplan_file}.${ts}.bak" 2>/dev/null || true
            sudo cp "$tmp_file" "$netplan_file"
            changes_made=true

            # Update menu display
            menu_items=()
            for iface_path in /sys/class/net/*; do
                [[ -d "$iface_path" ]] || continue
                local name
                name=$(basename "$iface_path")
                [[ "$name" == "lo" ]] && continue

                local state ip_show speed_str
                state=$(cat "$iface_path/operstate" 2>/dev/null || echo "unknown")

                # Show new IP if just changed, otherwise current
                if [[ "$name" == "$choice" ]]; then
                    ip_show="$new_ip [NEW]"
                else
                    ip_show=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}' | head -1)
                    [[ -z "$ip_show" ]] && ip_show="no IP"
                fi

                local speed
                speed=$(cat "$iface_path/speed" 2>/dev/null || echo "0")
                if [[ "$speed" =~ ^[0-9]+$ ]] && [[ $speed -gt 0 ]]; then
                    if [[ $speed -ge 1000 ]]; then
                        speed_str="$((speed/1000))G"
                    else
                        speed_str="${speed}M"
                    fi
                else
                    speed_str="--"
                fi

                menu_items+=("$name" "[$state] $ip_show ($speed_str)")
            done
            menu_items+=("Done" "Finish and apply changes")

            msg_box "Updated" "Interface $choice configured:\n\nIP: $new_ip\n\nSelect 'Done' to apply changes."
        fi
        rm -f "$tmp_file"
    done

    # Apply changes if any were made
    if [[ "$changes_made" == "true" ]]; then
        if yes_no "Apply Changes" "Network configuration has been updated.\n\nApply changes now?\n\nThis will run 'netplan apply' to activate\nthe new IP addresses.\n\nActive connections may be briefly interrupted."; then
            op_start "Apply Network Config"
            op_step "backup + update netplan" 0
            op_run "netplan apply" sudo netplan apply || true
            local _iface_info=""
            _iface_info=$(ip -o -4 addr show 2>/dev/null | grep -v '127.0.0.1' | awk '{print $2, $4}' | tr '\n' ', ' || true)
            op_verify "interfaces configured" test -n "$_iface_info" || true
            op_end "${_iface_info}" || true
        fi
    fi
}

network_menu() {
    local choice
    local netplan_file
    while true; do
        show_header
        choice=$(menu_select "🌐 Network Settings" "Configure network interfaces" \
            "1" "📋 View Current Configuration" \
            "2" "✏️  Edit Interface IP Address" \
            "3" "🚀 Apply Network Changes" \
            "4" "📄 View Netplan Config File" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) audit_log "Network > View Config"; show_network_info ;;
            2) audit_log "Network > Edit IP"; edit_interface_ip ;;
            3)
                if yes_no "Apply Changes" "Apply network configuration?\n\nThis will run 'netplan apply' to activate\nany changes to the network settings.\n\nActive connections may be briefly interrupted."; then
                    if sudo netplan apply 2>/dev/null; then
                        audit_log "Network > Apply Netplan" "success"
                        msg_box "Success" "Network configuration applied successfully!"
                    else
                        audit_log "Network > Apply Netplan" "failed"
                        msg_box "Error" "Failed to apply network configuration.\nCheck /var/log/syslog for details."
                    fi
                fi
                ;;
            4)
                audit_log "Network > View Netplan File"
                netplan_file=""
                for f in /etc/netplan/99-xinas.yaml /etc/netplan/*.yaml; do
                    [[ -f "$f" ]] && { netplan_file="$f"; break; }
                done
                if [[ -n "$netplan_file" && -f "$netplan_file" ]]; then
                    text_box "📄 Netplan: $netplan_file" "$netplan_file"
                else
                    msg_box "Netplan" "No netplan configuration found."
                fi
                ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# System Status Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_status() {
    clear
    if command -v xinas-status &>/dev/null; then
        xinas-status
    else
        echo -e "${YELLOW}xinas-status command not found${NC}"
        echo ""
        echo "Basic system information:"
        echo ""
        echo "Hostname: $(hostname)"
        echo "Uptime:   $(uptime -p)"
        echo "Load:     $(cat /proc/loadavg | awk '{print $1, $2, $3}')"
        echo ""
        echo "Memory:"
        free -h
        echo ""
        echo "Disk Usage:"
        df -h | grep -E '^/dev|^Filesystem'
    fi
    echo ""
    echo -e "${CYAN}Press Enter to return to menu...${NC}"
    read -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# NFS Access Rights Functions (User-Friendly)
# ═══════════════════════════════════════════════════════════════════════════════

show_nfs_exports() {
    local out="$TMP_DIR/nfs_info"

    python3 - > "$out" << 'PYEOF'
import os
import subprocess

def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL).decode().strip()
    except:
        return ""

def parse_export_line(line):
    """Parse an export line into path and clients"""
    parts = line.split()
    if not parts:
        return None, []
    path = parts[0]
    clients = parts[1:] if len(parts) > 1 else []
    return path, clients

def explain_access(client_spec):
    """Explain access rules in simple terms"""
    if not client_spec:
        return "No access configured"

    explanations = []
    for spec in client_spec:
        # Parse host(options)
        if "(" in spec:
            host = spec.split("(")[0]
            opts = spec.split("(")[1].rstrip(")")
        else:
            host = spec
            opts = ""

        # Explain host
        if host == "*":
            host_desc = "Everyone (all hosts)"
        elif "/" in host:
            host_desc = f"Network: {host}"
        else:
            host_desc = f"Host: {host}"

        # Explain options
        opt_list = opts.split(",") if opts else []
        perms = []
        if "rw" in opt_list:
            perms.append("Read & Write")
        elif "ro" in opt_list:
            perms.append("Read Only")
        else:
            perms.append("Read & Write")  # default

        if "no_root_squash" in opt_list:
            perms.append("Full admin access")

        # Extract security mode
        sec_mode = "sys"
        for o in opt_list:
            if o.startswith("sec="):
                sec_mode = o.split("=", 1)[1]

        explanations.append(f"  {host_desc}: {', '.join(perms)}")

    return "\n".join(explanations)

def get_share_usage(path):
    """Get disk usage for a share path"""
    try:
        result = run(f"df -h '{path}' 2>/dev/null | tail -1")
        if result:
            parts = result.split()
            if len(parts) >= 5:
                return f"{parts[2]} used of {parts[1]} ({parts[4]})"
    except:
        pass
    return "N/A"

def get_active_clients():
    """Get list of connected NFS clients"""
    clients = []
    # Try /proc/fs/nfsd/clients
    clients_dir = "/proc/fs/nfsd/clients"
    if os.path.isdir(clients_dir):
        for entry in os.listdir(clients_dir):
            info_file = os.path.join(clients_dir, entry, "info")
            if os.path.isfile(info_file):
                try:
                    with open(info_file) as f:
                        for line in f:
                            if "address:" in line:
                                ip = line.split("address:")[1].strip().split()[0]
                                if ip and ip not in clients:
                                    clients.append(ip)
                except:
                    pass

    # Fallback to ss
    if not clients:
        result = run("ss -tn state established '( dport = :2049 )' 2>/dev/null")
        for line in result.split("\n")[1:]:
            parts = line.split()
            if len(parts) >= 4:
                ip = parts[3].rsplit(":", 1)[0]
                if ip and ip not in clients:
                    clients.append(ip)

    return clients

# Main output
print("NFS SHARED FOLDERS")
print("=" * 65)
print()
print("  NFS (Network File System) allows other hosts to access")
print("  folders on this server over the network.")
print()

exports_file = "/etc/exports"
if not os.path.isfile(exports_file):
    print("  [!] No shares configured yet.")
    print()
    print("  Run the installation wizard to set up shared folders.")
    exit(0)

# Parse exports
shares = []
with open(exports_file) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        path, clients = parse_export_line(line)
        if path:
            shares.append({"path": path, "clients": clients})

if not shares:
    print("  [!] No shares configured in /etc/exports")
    exit(0)

print("-" * 65)
print("  YOUR SHARED FOLDERS")
print("-" * 65)
print()

for i, share in enumerate(shares, 1):
    path = share["path"]
    clients = share["clients"]

    # Check if path exists
    exists = os.path.isdir(path)
    status = "[OK]" if exists else "[!]"

    print(f"  {i}. {path}  {status}")
    print()

    if exists:
        usage = get_share_usage(path)
        print(f"     Storage: {usage}")
    else:
        print("     Storage: Path does not exist!")

    # Get security mode from first client spec
    share_sec = "sys"
    for c in clients:
        if "(" in c:
            copts = c.split("(")[1].rstrip(")").split(",")
            for o in copts:
                if o.startswith("sec="):
                    share_sec = o.split("=", 1)[1]
            break

    sec_labels = {
        "sys": "Standard (UID/GID)",
        "krb5": "Kerberos",
        "krb5i": "Kerberos + integrity",
        "krb5p": "Kerberos + encryption",
    }
    print(f"     Security: {sec_labels.get(share_sec, share_sec)}")
    print()
    print("     Who can access:")
    print(explain_access(clients))
    print()
    print("-" * 65)

# Active clients
print()
print("  CONNECTED HOSTS")
print("-" * 65)
clients = get_active_clients()
if clients:
    for ip in clients:
        print(f"  [*] {ip}")
else:
    print("  No hosts currently connected")
print()
print("=" * 65)
PYEOF

    text_box "NFS Shared Folders" "$out"
}

edit_nfs_share() {
    local exports_file="/etc/exports"

    if [[ ! -f "$exports_file" ]]; then
        msg_box "No Shares" "No shared folders configured yet.\n\nRun the installation wizard first to create\nshared folders on your NAS."
        return
    fi

    # Get list of shares
    mapfile -t paths < <(awk '!/^#/ && NF {print $1}' "$exports_file" 2>/dev/null)

    if [[ ${#paths[@]} -eq 0 ]]; then
        msg_box "No Shares" "No shared folders found."
        return
    fi

    # Build menu with friendly descriptions
    local -a menu_items=()
    for path in "${paths[@]}"; do
        local desc
        if [[ -d "$path" ]]; then
            desc="Folder exists"
        else
            desc="[!] Path not found"
        fi
        menu_items+=("$path" "$desc")
    done

    # Select share to edit
    show_header
    local share_path
    share_path=$(menu_select "Select Shared Folder" "Choose a folder to change access settings:\n\nThese are the folders that other hosts\ncan connect to over the network." \
        "${menu_items[@]}") || return

    # Get current settings
    local current_line
    current_line=$(grep "^${share_path}[[:space:]]" "$exports_file" 2>/dev/null | head -1)
    local current_spec
    current_spec=$(echo "$current_line" | awk '{print $2}')

    # Parse current host and options
    local current_host="*"
    local current_rw="rw"
    local current_root="no_root_squash"
    local current_options=""

    if [[ -n "$current_spec" ]]; then
        current_host="${current_spec%%(*}"
        # Extract options between parentheses
        current_options="${current_spec#*(}"
        current_options="${current_options%)}"
        [[ "$current_options" == *"ro"* ]] && current_rw="ro"
        [[ "$current_options" != *"no_root_squash"* ]] && current_root="root_squash"
    fi

    # Wizard steps with back navigation
    local step=1
    local access_choice="" new_host="" perm_choice="" new_rw=""
    local admin_choice="" new_root="" sec_choice="" new_sec=""

    # Parse existing sec= from current options (default: sys)
    local current_sec="sys"
    if [[ "$current_options" =~ sec=([^,]+) ]]; then
        current_sec="${BASH_REMATCH[1]}"
    fi

    while [[ $step -ge 1 && $step -le 5 ]]; do
        case $step in
        1)  # Step 1: Who can access?
            show_header
            access_choice=$(menu_select "Step 1: Who Can Access?  (Esc = Back)" "Who should be able to connect to:\n$share_path\n\nChoose who can access this folder:" \
                "1" "Everyone (any host on the network)" \
                "2" "Specific network (e.g., 192.168.1.0/24)" \
                "3" "Single host (by IP address)") || { step=$((step - 1)); continue; }

            case "$access_choice" in
                1)
                    new_host="*"
                    ;;
                2)
                    new_host=$(input_box "Enter Network Address" "Enter the network address:\n\nExample: 192.168.1.0/24\nThis allows all hosts from 192.168.1.1 to 192.168.1.254\n\nFormat: X.X.X.0/24" "192.168.1.0/24") || continue
                    [[ -z "$new_host" ]] && new_host="*"
                    ;;
                3)
                    new_host=$(input_box "Enter Computer IP" "Enter the IP address of the host:\n\nExample: 192.168.1.100\n\nOnly this host will be able to connect.") || continue
                    [[ -z "$new_host" ]] && new_host="*"
                    ;;
            esac
            step=$((step + 1))
            ;;
        2)  # Step 2: Read or Read-Write?
            show_header
            perm_choice=$(menu_select "Step 2: Access Permissions  (Esc = Back)" "What can connected hosts do?\n\nShare: $share_path\nAccess: $new_host" \
                "1" "Read & Write (can add, edit, delete files)" \
                "2" "Read Only (can only view files)") || { step=$((step - 1)); continue; }

            case "$perm_choice" in
                1) new_rw="rw" ;;
                2) new_rw="ro" ;;
            esac
            step=$((step + 1))
            ;;
        3)  # Step 3: Admin access?
            show_header
            admin_choice=$(menu_select "Step 3: Admin Access  (Esc = Back)" "Allow full administrator access?\n\nIf enabled, remote admin users have full control\nover files (same as local root user).\n\nRecommended: Yes for trusted networks" \
                "1" "Yes - Full admin access (recommended)" \
                "2" "No - Limited access (more secure)") || { step=$((step - 1)); continue; }

            case "$admin_choice" in
                1) new_root="no_root_squash" ;;
                2) new_root="root_squash" ;;
            esac
            step=$((step + 1))
            ;;
        4)  # Step 4: Security Mode
            # Check Kerberos readiness for the info line
            local krb_status
            krb_status=$(check_kerberos_server_readiness | head -1 || true)
            local krb_note=""
            if [[ "$krb_status" != "READY" ]]; then
                krb_note="\n\nNote: Kerberos infrastructure is not configured\non this server. krb5 modes may not work until\n/etc/krb5.conf and keytab are set up."
            fi

            show_header
            sec_choice=$(menu_select "Step 4: Security Mode  (Esc = Back)" "Select authentication mode for:\n$share_path\n\nCurrent: $current_sec${krb_note}" \
                "sys" "Standard UID/GID (default)" \
                "krb5" "Kerberos authentication" \
                "krb5i" "Kerberos + integrity" \
                "krb5p" "Kerberos + encryption") || { step=$((step - 1)); continue; }

            new_sec="$sec_choice"

            # Configure idmapd domain if switching to Kerberos
            if [[ "$new_sec" != "sys" ]]; then
                local idmapd_domain
                idmapd_domain=$(grep -Po '^\s*Domain\s*=\s*\K\S+' /etc/idmapd.conf 2>/dev/null || true)
                if [[ -z "$idmapd_domain" ]]; then
                    configure_idmapd_domain
                fi
            fi
            step=$((step + 1))
            ;;
        5)  # Confirm and apply
            # Build the new export line - preserve existing optimized options
            local new_options=""
            if [[ -n "$current_options" ]]; then
                # Start with existing options and update only what changed
                new_options="$current_options"
                # Replace rw/ro
                if [[ "$new_rw" == "rw" ]]; then
                    new_options=$(echo "$new_options" | sed 's/\bro\b/rw/')
                else
                    new_options=$(echo "$new_options" | sed 's/\brw\b/ro/')
                fi
                # Replace root_squash/no_root_squash
                if [[ "$new_root" == "no_root_squash" ]]; then
                    new_options=$(echo "$new_options" | sed 's/\broot_squash\b/no_root_squash/')
                else
                    new_options=$(echo "$new_options" | sed 's/\bno_root_squash\b/root_squash/')
                fi
                # Update sec= option
                if [[ "$new_sec" != "sys" ]]; then
                    if [[ "$new_options" =~ sec= ]]; then
                        new_options=$(echo "$new_options" | sed "s/sec=[^,]*/sec=${new_sec}/")
                    else
                        new_options="${new_options},sec=${new_sec}"
                    fi
                else
                    # Remove sec= if reverting to sys (NFS default)
                    new_options=$(echo "$new_options" | sed 's/,sec=[^,]*//;s/^sec=[^,]*,//')
                fi
            else
                # No existing options, use defaults
                new_options="${new_rw},sync,no_subtree_check,${new_root}"
                [[ "$new_sec" != "sys" ]] && new_options="${new_options},sec=${new_sec}"
            fi
            local new_spec="${new_host}(${new_options})"
            local new_line="${share_path} ${new_spec}"

            # Show summary and confirm
            local perm_desc="Read & Write"
            [[ "$new_rw" == "ro" ]] && perm_desc="Read Only"

            local admin_desc="Yes (full control)"
            [[ "$new_root" == "root_squash" ]] && admin_desc="No (limited)"

            local sec_desc="Standard UID/GID"
            case "$new_sec" in
                krb5)  sec_desc="Kerberos" ;;
                krb5i) sec_desc="Kerberos + integrity" ;;
                krb5p) sec_desc="Kerberos + encryption" ;;
            esac

            local host_desc="$new_host"
            [[ "$new_host" == "*" ]] && host_desc="Everyone"

            if yes_no "Confirm Changes" "Please review your settings:\n\nShared Folder: $share_path\n\nWho can access:   $host_desc\nPermissions:      $perm_desc\nAdmin access:     $admin_desc\nSecurity:         $sec_desc\n\nApply these settings?"; then

                op_start "Edit NFS Share: $share_path" "$(grep "^${share_path}[[:space:]]" "$exports_file" 2>/dev/null | head -1 || true)"

                # Create backup
                local ts
                ts=$(date +%Y%m%d%H%M%S)
                op_step "backup /etc/exports" 0
                sudo cp "$exports_file" "${exports_file}.${ts}.bak"

                # Update the export line
                op_run "update export line" sudo sed -i "s|^${share_path}[[:space:]].*|${new_line}|" "$exports_file" || true

                # Apply changes
                op_run "exportfs -ra" sudo exportfs -ra || true
                local _active_line=""
                _active_line=$(exportfs -v 2>/dev/null | grep "$share_path" || true)
                op_verify "share active" test -n "$_active_line" || true
                op_end "Folder: $share_path\nAccess: $host_desc ($perm_desc)" || true
                return 0
            else
                step=$((step - 1)); continue
            fi
            ;;
        esac
    done
}

add_nfs_share() {
    # Add a new NFS share
    local exports_file="/etc/exports"

    # Wizard steps with back navigation
    local step=1
    local share_path="" access_choice="" new_host=""
    local perm_choice="" new_rw="" sec_choice="" new_sec=""

    while [[ $step -ge 1 && $step -le 5 ]]; do
        case $step in
        1)  # Step 1: Enter folder path
            share_path=$(input_box "Add New Shared Folder - Step 1  (Esc = Back)" "Enter the folder path to share:\n\nThis is the folder on this server that other\nhosts will be able to access.\n\nExample: /mnt/data/shared" "/mnt/data/") || { step=$((step - 1)); continue; }

            [[ -z "$share_path" ]] && { step=$((step - 1)); continue; }

            # Check if path exists
            if [[ ! -d "$share_path" ]]; then
                if yes_no "Folder Not Found" "The folder does not exist:\n$share_path\n\nWould you like to create it?"; then
                    if ! sudo mkdir -p "$share_path" 2>/dev/null; then
                        msg_box "Error" "Could not create folder."
                        continue
                    fi
                else
                    continue
                fi
            fi

            # Normalize path: remove trailing slash (except root /)
            share_path="${share_path%/}"
            [[ -z "$share_path" ]] && share_path="/"

            # Check if already shared (exact match or trailing-slash variant)
            if grep -qE "^${share_path}/?[[:space:]]" "$exports_file" 2>/dev/null; then
                msg_box "Already Shared" "This folder is already being shared.\n\nUse 'Edit Share Settings' to modify it."
                continue
            fi

            # Check for parent/child overlap with existing shares
            local _overlap=""
            while IFS= read -r _eline; do
                [[ -z "$_eline" ]] && continue
                local _epath
                _epath=$(printf '%s' "$_eline" | awk '{print $1}')
                _epath="${_epath%/}"
                [[ -z "$_epath" ]] && _epath="/"
                if [[ "$share_path" == "$_epath"/* ]]; then
                    _overlap="Parent folder already shared: $_epath"
                    break
                elif [[ "$_epath" == "$share_path"/* ]]; then
                    _overlap="Child folder already shared: $_epath"
                    break
                fi
            done < <(grep '^/' "$exports_file" 2>/dev/null)

            if [[ -n "$_overlap" ]]; then
                if ! yes_no "Overlap Detected" "$_overlap\n\nSharing overlapping paths can cause\nunexpected NFS behavior.\n\nContinue anyway?"; then
                    continue
                fi
            fi

            # Check for duplicate entries already in the file
            local _dup_count
            _dup_count=$(grep -cE '^/' "$exports_file" 2>/dev/null || echo 0)
            local _unique_count
            _unique_count=$(awk '!/^#/ && /^\// {print $1}' "$exports_file" 2>/dev/null | sed 's|/$||' | sort -u | wc -l)
            if [[ "$_dup_count" -gt "$_unique_count" && "$_unique_count" -gt 0 ]]; then
                msg_warn "Note: /etc/exports contains duplicate entries. Review with 'View Config File'."
            fi
            step=$((step + 1))
            ;;
        2)  # Step 2: Who can access?
            show_header
            access_choice=$(menu_select "Add New Share - Step 2  (Esc = Back)" "Who should be able to access this folder?\n\nFolder: $share_path" \
                "1" "Everyone (any host)" \
                "2" "Specific network (recommended)" \
                "3" "Single host only") || { step=$((step - 1)); continue; }

            case "$access_choice" in
                1)
                    new_host="*"
                    ;;
                2)
                    new_host=$(input_box "Network Address" "Enter network address (e.g., 192.168.1.0/24):" "192.168.1.0/24") || continue
                    [[ -z "$new_host" ]] && new_host="*"
                    ;;
                3)
                    new_host=$(input_box "Computer IP" "Enter the IP address:") || continue
                    [[ -z "$new_host" ]] && new_host="*"
                    ;;
            esac
            step=$((step + 1))
            ;;
        3)  # Step 3: Permissions
            show_header
            perm_choice=$(menu_select "Add New Share - Step 3  (Esc = Back)" "What permissions should connected hosts have?" \
                "1" "Read & Write (full access)" \
                "2" "Read Only (view only)") || { step=$((step - 1)); continue; }

            new_rw="rw"
            [[ "$perm_choice" == "2" ]] && new_rw="ro"
            step=$((step + 1))
            ;;
        4)  # Step 4: Security Mode
            local krb_status
            krb_status=$(check_kerberos_server_readiness | head -1 || true)
            local krb_note=""
            if [[ "$krb_status" != "READY" ]]; then
                krb_note="\n\nNote: Kerberos infrastructure is not configured\non this server. krb5 modes may not work until\n/etc/krb5.conf and keytab are set up."
            fi

            show_header
            sec_choice=$(menu_select "Add New Share - Step 4  (Esc = Back)" "Select authentication mode:${krb_note}" \
                "sys" "Standard UID/GID (default)" \
                "krb5" "Kerberos authentication" \
                "krb5i" "Kerberos + integrity" \
                "krb5p" "Kerberos + encryption") || { step=$((step - 1)); continue; }

            new_sec="$sec_choice"

            # Configure idmapd domain if switching to Kerberos
            if [[ "$new_sec" != "sys" ]]; then
                local idmapd_domain
                idmapd_domain=$(grep -Po '^\s*Domain\s*=\s*\K\S+' /etc/idmapd.conf 2>/dev/null || true)
                if [[ -z "$idmapd_domain" ]]; then
                    configure_idmapd_domain
                fi
            fi
            step=$((step + 1))
            ;;
        5)  # Confirm and apply
            # Build export line - copy optimized options from existing share if available
            local base_options="${new_rw},sync,no_subtree_check,no_root_squash"
            local existing_opts
            existing_opts=$(grep -m1 '^/' "$exports_file" 2>/dev/null | grep -oP '\([^)]+\)' | tr -d '()')
            if [[ -n "$existing_opts" ]]; then
                # Use existing options as template, just update rw/ro
                base_options="$existing_opts"
                if [[ "$new_rw" == "rw" ]]; then
                    base_options=$(echo "$base_options" | sed 's/\bro\b/rw/')
                else
                    base_options=$(echo "$base_options" | sed 's/\brw\b/ro/')
                fi
            fi
            # Add sec= if not sys
            if [[ "$new_sec" != "sys" ]]; then
                if [[ "$base_options" =~ sec= ]]; then
                    base_options=$(echo "$base_options" | sed "s/sec=[^,]*/sec=${new_sec}/")
                else
                    base_options="${base_options},sec=${new_sec}"
                fi
            else
                # Remove sec= if present (sys is NFS default)
                base_options=$(echo "$base_options" | sed 's/,sec=[^,]*//;s/^sec=[^,]*,//')
            fi
            local new_line="${share_path} ${new_host}(${base_options})"

            # Confirm
            local host_desc="$new_host"
            [[ "$new_host" == "*" ]] && host_desc="Everyone"

            local perm_desc="Read & Write"
            [[ "$new_rw" == "ro" ]] && perm_desc="Read Only"

            local sec_desc="Standard UID/GID"
            case "$new_sec" in
                krb5)  sec_desc="Kerberos" ;;
                krb5i) sec_desc="Kerberos + integrity" ;;
                krb5p) sec_desc="Kerberos + encryption" ;;
            esac

            if yes_no "Confirm New Share" "Create this shared folder?\n\nFolder:      $share_path\nAccess:      $host_desc\nPermissions: $perm_desc\nSecurity:    $sec_desc"; then

                op_start "Add NFS Share: $share_path"

                # Add to exports
                op_run "add to /etc/exports" bash -c "echo '$new_line' | sudo tee -a '$exports_file' > /dev/null" || true

                # Apply
                op_run "exportfs -ra" sudo exportfs -ra || true
                local _active_line=""
                _active_line=$(exportfs -v 2>/dev/null | grep "$share_path" || true)
                op_verify "share active" test -n "$_active_line" || true
                op_end "Folder: $share_path\nAccess: $host_desc ($perm_desc)" "Share Created" || true
                return 0
            else
                step=$((step - 1)); continue
            fi
            ;;
        esac
    done
}

remove_nfs_share() {
    local exports_file="/etc/exports"

    if [[ ! -f "$exports_file" ]]; then
        msg_box "No Shares" "No shared folders configured."
        return
    fi

    # Get list of shares
    mapfile -t paths < <(awk '!/^#/ && NF {print $1}' "$exports_file" 2>/dev/null)

    if [[ ${#paths[@]} -eq 0 ]]; then
        msg_box "No Shares" "No shared folders found."
        return
    fi

    # Build menu
    local -a menu_items=()
    for path in "${paths[@]}"; do
        local spec
        spec=$(grep "^${path}[[:space:]]" "$exports_file" 2>/dev/null | awk '{print $2}' | head -1)
        menu_items+=("$path" "${spec:-unknown}")
    done

    # Select share to remove
    show_header
    local share_path
    share_path=$(menu_select "Remove Shared Folder" "Select a folder to stop sharing:\n\nThis will remove it from /etc/exports.\nThe folder itself will NOT be deleted." \
        "${menu_items[@]}") || return

    [[ -z "$share_path" ]] && return

    # Get the current export line for display
    local current_line
    current_line=$(grep "^${share_path}[[:space:]]" "$exports_file" 2>/dev/null | head -1)

    # Detect if this is a default/primary share (deployed by preset)
    local is_default=false
    # Check against known preset paths and primary data mount
    local _norm_path="${share_path%/}"
    if [[ "$_norm_path" == "/mnt/data" ]]; then
        is_default=true
    fi
    # Also check if it's the only share or has fsid=0 (root export)
    if [[ "$current_line" == *"fsid=0"* ]]; then
        is_default=true
    fi

    # Extract host and options separately for readable display
    local _export_host _export_opts
    _export_host=$(printf '%s' "${current_line##* }" | sed 's/(.*//')
    _export_opts=$(printf '%s' "${current_line##* }" | grep -oP '\([^)]*\)' || true)
    _export_opts="${_export_opts#(}"
    _export_opts="${_export_opts%)}"

    # Wrap long options into two lines (max ~60 chars per line)
    local _opts_display=""
    if [[ ${#_export_opts} -le 60 ]]; then
        _opts_display="$_export_opts"
    else
        # Split at a comma near the midpoint
        local _half=$(( ${#_export_opts} / 2 ))
        local _split_pos
        _split_pos=$(printf '%s' "${_export_opts:0:$((_half+10))}" | grep -ob ',' | tail -1 | cut -d: -f1)
        if [[ -n "$_split_pos" ]]; then
            _opts_display="${_export_opts:0:$((_split_pos+1))}\n         ${_export_opts:$((_split_pos+1))}"
        else
            _opts_display="$_export_opts"
        fi
    fi

    # First confirmation
    if ! yes_no "Remove Share" "Remove this shared folder?\n\nFolder:  $share_path\nAccess:  $_export_host\nOptions: $_opts_display\n\nThe folder and its files will NOT be deleted.\nOnly the NFS share will be removed."; then
        return
    fi

    # Double confirmation for default/primary shares
    if [[ "$is_default" == "true" ]]; then
        local confirm_text
        confirm_text=$(input_box "⚠  Default Share" "WARNING: This is a primary/default share\ndeployed during initial setup.\n\nRemoving it may disrupt all connected clients.\n\nType the path to confirm removal:\n$share_path") || return

        if [[ "$confirm_text" != "$share_path" ]]; then
            msg_box "Cancelled" "Path did not match. Share not removed."
            return
        fi
    fi

    op_start "Remove NFS Share: $share_path" "$current_line"

    # Backup exports file
    local ts
    ts=$(date +%Y%m%d%H%M%S)
    sudo cp "$exports_file" "${exports_file}.${ts}.bak"
    op_step "backup /etc/exports" 0

    # Remove the line
    op_run "remove from /etc/exports" sudo sed -i "\|^${share_path}[[:space:]]|d" "$exports_file" || true

    # Unexport and refresh
    op_run "unexport share" sudo exportfs -u "*:${share_path}" || true
    op_run "exportfs -ra" sudo exportfs -ra || true

    # Verify removal
    op_verify "share removed from exports" bash -c "! grep -q '^${share_path}[[:space:]]' '$exports_file'" || true
    op_verify "share not active" bash -c "! exportfs -v 2>/dev/null | grep -q '${share_path}'" || true

    local _remaining
    _remaining=$(grep -c '^/' "$exports_file" 2>/dev/null || echo 0)
    op_end "Remaining shares: ${_remaining}" "Share Removed" || true
    audit_log "NFS > Remove Share" "$share_path"
}

configure_idmapd_domain() {
    # Configure /etc/idmapd.conf Domain for NFSv4 ID mapping (Kerberos)
    local idmapd_conf="/etc/idmapd.conf"

    # If Domain is already set (uncommented), nothing to do
    if grep -qP '^\s*Domain\s*=' "$idmapd_conf" 2>/dev/null; then
        return 0
    fi

    # Auto-detect domain
    local detected_domain=""
    detected_domain=$(dnsdomainname 2>/dev/null || true)
    if [[ -z "$detected_domain" ]]; then
        detected_domain=$(awk '/^(search|domain)/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)
    fi

    # Prompt user with detected value pre-filled
    local domain
    domain=$(input_box "NFSv4 ID Mapping Domain" \
        "Kerberos NFS requires a domain for ID mapping.\n\nThis must match on server and all clients.\nTypically your DNS domain (e.g. example.com).\n\nEnter the NFSv4 domain:" \
        "$detected_domain") || return 0

    if [[ -z "$domain" ]]; then
        msg_box "Skipped" "No domain entered. idmapd.conf was not changed.\nID mapping may not work with Kerberos."
        return 0
    fi

    op_start "Configure idmapd Domain"

    # Update or create idmapd.conf
    if [[ -f "$idmapd_conf" ]]; then
        if grep -qP '^\s*#\s*Domain\s*=' "$idmapd_conf"; then
            op_run "uncomment Domain" sudo sed -i "s/^\s*#\s*Domain\s*=.*/Domain = ${domain}/" "$idmapd_conf" || true
        elif grep -qP '^\[General\]' "$idmapd_conf"; then
            op_run "insert Domain" sudo sed -i "/^\[General\]/a Domain = ${domain}" "$idmapd_conf" || true
        else
            op_run "append [General] section" bash -c "printf '\n[General]\nDomain = %s\n' '$domain' | sudo tee -a '$idmapd_conf' > /dev/null" || true
        fi
    else
        op_run "create idmapd.conf" bash -c "sudo tee '$idmapd_conf' > /dev/null <<IDMAPEOF
[General]
Domain = ${domain}

[Mapping]
Nobody-User = nobody
Nobody-Group = nogroup
IDMAPEOF" || true
    fi

    # Restart nfs-idmapd if running
    if systemctl is-active --quiet nfs-idmapd 2>/dev/null; then
        op_run "restart nfs-idmapd" sudo systemctl restart nfs-idmapd || true
    fi

    local _domain_check=""
    _domain_check=$(grep -Po '^\s*Domain\s*=\s*\K\S+' "$idmapd_conf" 2>/dev/null || true)
    op_verify "Domain set in idmapd.conf" test "$_domain_check" = "$domain" || true
    op_end "Domain: ${_domain_check}" "Domain Configured" || true
}

check_kerberos_server_readiness() {
    # Quick check for Kerberos infrastructure on the server
    local warnings=()
    local ready=true

    if [[ ! -f /etc/krb5.conf ]]; then
        warnings+=("- /etc/krb5.conf not found")
        ready=false
    fi
    if [[ ! -f /etc/krb5.keytab ]]; then
        warnings+=("- /etc/krb5.keytab not found")
        ready=false
    fi
    if ! systemctl is-active --quiet rpc-svcgssd 2>/dev/null && \
       ! systemctl is-active --quiet gssproxy 2>/dev/null; then
        warnings+=("- Neither rpc-svcgssd nor gssproxy is active")
        ready=false
    fi

    if [[ "$ready" == "false" ]]; then
        echo "NOT READY"
        printf '%s\n' "${warnings[@]}"
    else
        echo "READY"
    fi
}

nfs_menu() {
    local choice
    while true; do
        # Get quick status
        local share_count=0
        local client_count=0
        if [[ -f /etc/exports ]]; then
            share_count=$(grep -c '^/' /etc/exports 2>/dev/null || echo 0)
        fi
        if [[ -d /proc/fs/nfsd/clients ]]; then
            client_count=$(ls -1 /proc/fs/nfsd/clients 2>/dev/null | wc -l)
        fi

        show_header
        choice=$(menu_select "📂 NFS Shared Folders" "Manage folders shared over the network\n\nStatus: $share_count shared folder(s), $client_count connected" \
            "1" "📋 View Shared Folders" \
            "2" "✏️  Edit Share Settings" \
            "3" "➕ Add New Shared Folder" \
            "4" "🗑  Remove Shared Folder" \
            "5" "🔄 Refresh (apply changes)" \
            "6" "📄 View Config File" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) audit_log "NFS > View Shares"; show_nfs_exports ;;
            2) audit_log "NFS > Edit Share"; edit_nfs_share ;;
            3) audit_log "NFS > Add Share"; add_nfs_share ;;
            4) audit_log "NFS > Remove Share"; remove_nfs_share ;;
            5)
                op_start "Refresh NFS Exports"
                op_run "exportfs -ra" sudo exportfs -ra || true
                local _export_count=""
                _export_count=$(exportfs -v 2>/dev/null | wc -l)
                op_verify "exports active" test "$_export_count" -gt 0 || true
                local _ec=0
                op_end "Active exports: ${_export_count}" || _ec=$?
                if [[ $_ec -eq 0 ]]; then
                    audit_log "NFS > Refresh Exports" "success"
                else
                    audit_log "NFS > Refresh Exports" "failed"
                fi
                ;;
            6)
                audit_log "NFS > View Config"
                if [[ -f /etc/exports ]]; then
                    text_box "📄 /etc/exports" /etc/exports
                else
                    msg_box "Config File" "No configuration file found."
                fi
                ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# User Management Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_users() {
    local out="$TMP_DIR/users_info"

    python3 - > "$out" << 'PYEOF'
import pwd
import grp
import subprocess
import os

def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL).decode().strip()
    except:
        return ""

def get_quota(user):
    """Get user quota if quotas are enabled"""
    try:
        result = run(f"quota -u {user} 2>/dev/null | tail -1")
        if result and not result.startswith("Disk"):
            parts = result.split()
            if len(parts) >= 3:
                used = parts[1]
                limit = parts[2]
                if limit != "0":
                    return f"{used}/{limit} KB"
        return "No limit"
    except:
        return "N/A"

print("USER ACCOUNTS")
print("=" * 70)
print()

# Get regular users (UID >= 1000, with home directory)
users = []
for p in pwd.getpwall():
    if p.pw_uid >= 1000 and p.pw_uid < 65534:
        if os.path.isdir(p.pw_dir) or p.pw_dir.startswith("/home"):
            users.append(p)

if not users:
    print("  No regular user accounts found.")
    print()
    print("  System only has root and service accounts.")
else:
    print(f"  Found {len(users)} user account(s)")
    print()
    print("-" * 70)
    print(f"  {'Username':<15} {'UID':<8} {'Group':<15} {'Home Directory'}")
    print("-" * 70)

    for u in sorted(users, key=lambda x: x.pw_name):
        try:
            group = grp.getgrgid(u.pw_gid).gr_name
        except:
            group = str(u.pw_gid)
        print(f"  {u.pw_name:<15} {u.pw_uid:<8} {group:<15} {u.pw_dir}")

    print("-" * 70)

print()

# Check if quotas are enabled
quota_status = run("quotaon -p /mnt/data 2>/dev/null")
if "is on" in quota_status:
    print("  Disk Quotas: ENABLED")
else:
    print("  Disk Quotas: Not enabled")
    print("  (Enable with: sudo quotaon -v /mnt/data)")

print()
print("=" * 70)
PYEOF

    text_box "User Accounts" "$out"
}

create_user() {
    # Wizard steps with back navigation
    local step=1
    local username="" password="" password2="" create_home="yes"

    while [[ $step -ge 1 && $step -le 3 ]]; do
        case $step in
        1)  # Step 1: Enter username
            username=$(input_box "Create User - Step 1  (Esc = Back)" "Enter the username for the new account:\n\nRules:\n- Lowercase letters and numbers only\n- Must start with a letter\n- 3-32 characters long") || { step=$((step - 1)); continue; }

            [[ -z "$username" ]] && { step=$((step - 1)); continue; }

            # Validate username
            if [[ ! "$username" =~ ^[a-z][a-z0-9]{2,31}$ ]]; then
                msg_box "Invalid Username" "Invalid username format.\n\nUsername must:\n- Start with a lowercase letter\n- Contain only lowercase letters and numbers\n- Be 3-32 characters long"
                continue
            fi

            # Check if user exists
            if id "$username" &>/dev/null; then
                msg_box "User Exists" "User '$username' already exists."
                continue
            fi
            step=$((step + 1))
            ;;
        2)  # Step 2: Set password
            password=$(password_box "Create User - Step 2  (Esc = Back)" "Enter password for '$username':\n\n(Minimum 6 characters)") || { step=$((step - 1)); continue; }

            if [[ ${#password} -lt 6 ]]; then
                msg_box "Password Too Short" "Password must be at least 6 characters."
                continue
            fi

            password2=$(password_box "Create User - Step 2" "Confirm password:") || continue

            if [[ "$password" != "$password2" ]]; then
                msg_box "Password Mismatch" "Passwords do not match."
                continue
            fi
            step=$((step + 1))
            ;;
        3)  # Step 3: Home directory + confirm
            if yes_no "Create User - Step 3  (Esc = Back)" "Create home directory for '$username'?\n\nThis will create /home/$username"; then
                create_home="yes"
            else
                create_home="no"
            fi

            # Confirm
            if yes_no "Confirm User Creation" "Create this user account?\n\nUsername:    $username\nHome Dir:    $([ "$create_home" = "yes" ] && echo "/home/$username" || echo "None")\n\nProceed?"; then

                # Create user
                local useradd_opts="-m"
                [[ "$create_home" != "yes" ]] && useradd_opts="-M"

                op_start "Create User: $username" "user does not exist"
                if ! op_run "useradd $username" sudo useradd $useradd_opts -s /bin/bash "$username"; then
                    op_end "" "Error" "Check system logs for details." || true
                    return 0
                fi
                op_run "set password" bash -c "echo '$username:$password' | sudo chpasswd" || true
                local _uid_info=""
                _uid_info=$(id "$username" 2>/dev/null || echo "")
                op_verify "user exists" id "$username" || true
                op_end "$_uid_info" "User Created" "The user can now log in with their password.\n\nTo set a disk quota, use 'Set User Quota'\nfrom the User Management menu." || true
                return 0
            else
                step=$((step - 1)); continue
            fi
            ;;
        esac
    done
}

delete_user() {
    # Get list of users
    local -a users=()
    while IFS=: read -r uname _ uid _ _ home _; do
        if [[ $uid -ge 1000 && $uid -lt 65534 ]]; then
            users+=("$uname" "$home")
        fi
    done < /etc/passwd

    if [[ ${#users[@]} -eq 0 ]]; then
        msg_box "No Users" "No regular user accounts to delete."
        return
    fi

    show_header
    local username
    username=$(menu_select "Delete User" "Select user to delete:\n\nWARNING: This cannot be undone!" \
        "${users[@]}") || return

    [[ -z "$username" ]] && return

    # Confirm with username
    local confirm
    confirm=$(input_box "Confirm Deletion" "Are you sure you want to delete user '$username'?\n\nThis will:\n- Remove the user account\n- Optionally remove their home directory\n\nType the username to confirm:") || return

    if [[ "$confirm" != "$username" ]]; then
        msg_box "Cancelled" "Username did not match. User not deleted."
        return
    fi

    # Ask about home directory
    local remove_home=""
    if yes_no "Remove Home Directory?" "Also remove the home directory?\n\n/home/$username\n\nSelect 'No' to keep the files."; then
        remove_home="-r"
    fi

    op_start "Delete User: $username"
    op_run "userdel $username" sudo userdel $remove_home "$username" || true
    op_verify "user removed" bash -c "! id '$username' 2>/dev/null" || true
    op_end "" || true
}

set_user_quota() {
    # Check if quota tools are available
    if ! command -v setquota &>/dev/null; then
        msg_box "Quota Tools Missing" "Quota tools are not installed.\n\nInstall with:\n  sudo apt-get install quota"
        return
    fi

    # Get mount point for quotas
    local mount_point="/mnt/data"

    if [[ ! -d "$mount_point" ]]; then
        mount_point=$(input_box "Mount Point" "Enter the mount point for quotas:\n\nExample: /mnt/data or /home" "/mnt/data") || return
    fi

    if [[ ! -d "$mount_point" ]]; then
        msg_box "Invalid Path" "Mount point does not exist."
        return
    fi

    # Get list of users
    local -a users=()
    while IFS=: read -r uname _ uid _ _ _ _; do
        if [[ $uid -ge 1000 && $uid -lt 65534 ]]; then
            # Get current quota
            local quota_info
            quota_info=$(quota -u "$uname" 2>/dev/null | tail -1 | awk '{print $3}')
            [[ -z "$quota_info" || "$quota_info" == "0" ]] && quota_info="No limit"
            users+=("$uname" "Limit: $quota_info")
        fi
    done < /etc/passwd

    if [[ ${#users[@]} -eq 0 ]]; then
        msg_box "No Users" "No regular user accounts found."
        return
    fi

    show_header
    local username
    username=$(menu_select "Set Quota - Select User" "Select user to set quota for:\n\nMount point: $mount_point" \
        "${users[@]}") || return

    [[ -z "$username" ]] && return

    # Get quota size
    local quota_size
    quota_size=$(input_box "Set Quota - Size" "Enter disk quota for '$username':\n\nExamples:\n  10G    = 10 Gigabytes\n  500M   = 500 Megabytes\n  0      = No limit (unlimited)\n\nEnter size:" "10G") || return

    [[ -z "$quota_size" ]] && return

    # Convert to KB
    local quota_kb=0
    if [[ "$quota_size" == "0" ]]; then
        quota_kb=0
    elif [[ "$quota_size" =~ ^([0-9]+)[Gg]$ ]]; then
        quota_kb=$((${BASH_REMATCH[1]} * 1024 * 1024))
    elif [[ "$quota_size" =~ ^([0-9]+)[Mm]$ ]]; then
        quota_kb=$((${BASH_REMATCH[1]} * 1024))
    elif [[ "$quota_size" =~ ^([0-9]+)[Kk]?$ ]]; then
        quota_kb=${BASH_REMATCH[1]}
    else
        msg_box "Invalid Size" "Invalid quota format.\n\nUse: 10G, 500M, or 1024K"
        return
    fi

    # Set soft limit slightly lower than hard limit
    local soft_kb=$((quota_kb * 90 / 100))

    # Confirm
    local limit_desc="Unlimited"
    [[ $quota_kb -gt 0 ]] && limit_desc="$quota_size"

    if yes_no "Confirm Quota" "Set disk quota for '$username'?\n\nLimit: $limit_desc\nMount: $mount_point\n\nProceed?"; then

        op_start "Set Quota: $username"
        # Enable quotas if not already
        op_run "quotaon $mount_point" sudo quotaon "$mount_point" || true

        # Set quota
        op_run "setquota $username" sudo setquota -u "$username" $soft_kb $quota_kb 0 0 "$mount_point" || true
        local _quota_detail=""
        _quota_detail=$(sudo repquota -u "$mount_point" 2>/dev/null | grep "^${username}" || echo "")
        op_verify "quota applied" test -n "$_quota_detail" || true
        op_end "User: $username  Limit: $limit_desc  Mount: $mount_point" || true
    fi
}

show_quotas() {
    local out="$TMP_DIR/quotas_info"

    {
        echo "DISK QUOTA REPORT"
        printf '=%.0s' {1..70}; echo ""
        echo ""

        # Check quota status on common mount points
        for mp in /mnt/data /home /; do
            [[ -d "$mp" ]] || continue

            echo "Mount Point: $mp"
            printf -- '-%.0s' {1..70}; echo ""

            quota_status=$(quotaon -p "$mp" 2>/dev/null)
            if [[ "$quota_status" == *"is on"* ]]; then
                echo "  Status: ENABLED"
                echo ""
                echo "  User quotas:"
                repquota -u "$mp" 2>/dev/null | grep -v "^#" | grep -v "^$" | head -20 || echo "  No quotas set"
            else
                echo "  Status: Not enabled"
            fi
            echo ""
        done

        printf '=%.0s' {1..70}; echo ""
    } > "$out"

    text_box "Disk Quotas" "$out"
}

user_menu() {
    local choice
    while true; do
        # Get user count
        local user_count
        user_count=$(awk -F: '$3 >= 1000 && $3 < 65534 {count++} END {print count+0}' /etc/passwd)

        show_header
        choice=$(menu_select "👥 User Management" "Manage user accounts and disk quotas\n\nUsers: $user_count account(s)" \
            "1" "📋 View User Accounts" \
            "2" "➕ Create New User" \
            "3" "🗑  Delete User" \
            "4" "📏 Set User Quota" \
            "5" "📊 View Quota Report" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) audit_log "Users > View Accounts"; show_users ;;
            2) audit_log "Users > Create User"; create_user ;;
            3) audit_log "Users > Delete User"; delete_user ;;
            4) audit_log "Users > Set Quota"; set_user_quota ;;
            5) audit_log "Users > View Quotas"; show_quotas ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Quick Actions
# ═══════════════════════════════════════════════════════════════════════════════

view_audit_log() {
    if [[ ! -f "$AUDIT_LOG" ]]; then
        msg_box "📝 Audit Log" "No audit log entries yet.\n\nActions will be recorded as you use the menu."
        return
    fi
    local out="$TMP_DIR/audit_view"
    {
        echo "AUDIT LOG"
        echo "========="
        echo "Log file: $AUDIT_LOG"
        echo ""
        tail -200 "$AUDIT_LOG" | tac
    } > "$out"
    text_box "📝 Audit Log (recent 200)" "$out"
}

quick_actions_menu() {
    local choice
    local out
    local status
    local icon
    while true; do
        show_header
        choice=$(menu_select "⚡ Quick Actions" "Common administrative tasks" \
            "1" "📊 Show xinas-status" \
            "2" "🔁 Restart NFS Server" \
            "3" "📜 View System Logs" \
            "4" "💿 Check Disk Health" \
            "5" "🔧 Service Status" \
            "6" "📝 Audit Log" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) audit_log "Quick > Status"; show_status ;;
            2)
                if yes_no "Restart NFS" "Restart the NFS server?\n\nActive client connections may be\ntemporarily interrupted."; then
                    op_start "Restart NFS Server"
                    op_run "systemctl restart nfs-server" sudo systemctl restart nfs-server || true
                    local _nfs_status=""
                    _nfs_status=$(systemctl is-active nfs-server 2>/dev/null || echo "unknown")
                    op_verify "nfs-server active" test "$_nfs_status" = "active" || true
                    local _ec=0
                    op_end "nfs-server: ${_nfs_status}" || _ec=$?
                    if [[ $_ec -eq 0 ]]; then
                        audit_log "Quick > Restart NFS" "success"
                    else
                        audit_log "Quick > Restart NFS" "failed"
                    fi
                fi
                ;;
            3)
                audit_log "Quick > System Logs"
                out="$TMP_DIR/logs"
                {
                    echo "=== Recent System Messages ==="
                    echo ""
                    journalctl -n 50 --no-pager 2>/dev/null || dmesg | tail -50
                } > "$out"
                text_box "System Logs" "$out"
                ;;
            4)
                audit_log "Quick > Disk Health"
                out="$TMP_DIR/disks"
                show_physical_drives > "$out"
                text_box "Disk Health" "$out"
                ;;
            5)
                audit_log "Quick > Service Status"
                out="$TMP_DIR/services"
                {
                    echo "=== Service Status ==="
                    echo ""
                    for svc in nfs-server xiraid xiraid-exporter nfsdcld rpcbind; do
                        status=$(systemctl is-active "$svc" 2>/dev/null || echo "not found")
                        case "$status" in
                            active) icon="*" ;;
                            inactive) icon="o" ;;
                            *) icon="?" ;;
                        esac
                        printf "  %s  %-20s %s\n" "$icon" "$svc" "$status"
                    done
                } > "$out"
                text_box "🔧 Services" "$out"
                ;;
            6) audit_log "Quick > View Audit Log"; view_audit_log ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# xiRAID Exporter
# ═══════════════════════════════════════════════════════════════════════════════

EXPORTER_GITHUB_REPO="E4-Computer-Engineering/xiraid-exporter"
EXPORTER_UPDATE_AVAILABLE=""

get_exporter_installed_version() {
    dpkg-query -W -f='${Version}' xiraid-exporter 2>/dev/null || echo ""
}

get_exporter_latest_version() {
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${EXPORTER_GITHUB_REPO}/releases/latest" 2>/dev/null \
        | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
    echo "$latest"
}

check_exporter_update() {
    local installed latest
    installed=$(get_exporter_installed_version)
    [[ -z "$installed" ]] && return 0
    latest=$(get_exporter_latest_version)
    [[ -z "$latest" ]] && return 0
    if [[ "$installed" != "$latest" ]]; then
        EXPORTER_UPDATE_AVAILABLE="$latest"
    else
        EXPORTER_UPDATE_AVAILABLE=""
    fi
}

install_xiraid_exporter() {
    local version="$1"
    local arch="amd64"
    local deb_url="https://github.com/${EXPORTER_GITHUB_REPO}/releases/download/v${version}/xiraid-exporter_${version}_linux_${arch}.deb"
    local deb_file="/tmp/xiraid-exporter_${version}.deb"

    op_start "Install xiraid-exporter v${version}"

    info_box "📥 Downloading" "Downloading xiraid-exporter v${version}..."
    if ! op_run "download .deb" curl -fSL -o "$deb_file" "$deb_url"; then
        op_end "" "Download Failed" || true
        return 1
    fi

    info_box "📦 Installing" "Installing xiraid-exporter v${version}..."
    if ! op_run "dpkg -i" sudo dpkg -i "$deb_file"; then
        op_end "" "Install Failed" || true
        rm -f "$deb_file"
        return 1
    fi
    op_run "daemon-reload" sudo systemctl daemon-reload || true
    op_run "enable service" sudo systemctl enable xiraid-exporter || true
    op_run "start service" sudo systemctl restart xiraid-exporter || true

    local _svc_status=""
    _svc_status=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
    op_verify "service active" test "$_svc_status" = "active" || true
    local _installed_ver=""
    _installed_ver=$(dpkg -l xiraid-exporter 2>/dev/null | awk '/xiraid-exporter/{print $3}' || true)
    op_end "v${_installed_ver} (${_svc_status})\nMetrics: http://localhost:9827/metrics" "Installed" || true
    EXPORTER_UPDATE_AVAILABLE=""
    rm -f "$deb_file"
}

uninstall_xiraid_exporter() {
    if yes_no "🗑  Uninstall" "Remove xiraid-exporter and stop the service?"; then
        op_start "Uninstall xiraid-exporter"
        op_run "stop service" sudo systemctl stop xiraid-exporter || true
        op_run "disable service" sudo systemctl disable xiraid-exporter || true
        op_run "purge package" sudo apt-get purge -y xiraid-exporter || true
        local _svc_status=""
        _svc_status=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
        op_verify "service stopped" test "$_svc_status" != "active" || true
        op_end "" || true
    fi
}

manage_xiraid_exporter() {
    while true; do
        show_header

        local installed
        installed=$(get_exporter_installed_version)

        if [[ -n "$installed" ]]; then
            local svc_status
            svc_status=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
            local status_color="$GREEN"
            [[ "$svc_status" != "active" ]] && status_color="$RED"

            echo -e "  ${WHITE}📈 xiRAID Exporter:${NC} ${status_color}● v${installed} (${svc_status})${NC}"
            [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && echo -e "  ${WHITE}🔄 Update:${NC} ${YELLOW}v${EXPORTER_UPDATE_AVAILABLE} available${NC}"
            echo ""

            local update_item="🔄 Check for Update"
            [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && update_item="🔄 Update to v${EXPORTER_UPDATE_AVAILABLE}"

            local choice
            choice=$(menu_select "📈 xiRAID Exporter" "Manage Exporter" \
                "1" "$update_item" \
                "2" "🔁 Restart Service" \
                "3" "🗑  Uninstall" \
                "0" "🔙 Back") || return

            case "$choice" in
                1)
                    if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                        audit_log "Exporter > Update" "to v${EXPORTER_UPDATE_AVAILABLE}"
                        install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                    else
                        audit_log "Exporter > Check Update"
                        info_box "🔄 Checking..." "Checking for exporter updates..."
                        check_exporter_update
                        if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                            if yes_no "🔄 Update Available" "xiraid-exporter v${EXPORTER_UPDATE_AVAILABLE} is available.\nInstalled: v${installed}\n\nUpdate now?"; then
                                audit_log "Exporter > Update" "to v${EXPORTER_UPDATE_AVAILABLE}"
                                install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                            fi
                        else
                            msg_box "✅ Up to Date" "xiraid-exporter v${installed} is the latest version."
                        fi
                    fi
                    ;;
                2)
                    audit_log "Exporter > Restart"
                    op_start "Restart xiraid-exporter"
                    op_run "systemctl restart xiraid-exporter" sudo systemctl restart xiraid-exporter || true
                    local _svc_status=""
                    _svc_status=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
                    op_verify "service active" test "$_svc_status" = "active" || true
                    op_end "xiraid-exporter: ${_svc_status}" || true
                    ;;
                3) audit_log "Exporter > Uninstall"; uninstall_xiraid_exporter ;;
                0) return ;;
            esac
        else
            echo -e "  ${WHITE}📈 xiRAID Exporter:${NC} ${DIM}Not installed${NC}"
            echo -e "  ${DIM}Prometheus metrics exporter for xiRAID storage${NC}"
            echo -e "  ${DIM}Developed by E4 Computer Engineering${NC}"
            echo ""

            local choice
            choice=$(menu_select "📈 xiRAID Exporter" "Install Exporter" \
                "1" "📥 Install Latest" \
                "0" "🔙 Back") || return

            case "$choice" in
                1)
                    audit_log "Exporter > Install"
                    info_box "🔍 Checking..." "Fetching latest version..."
                    local latest
                    latest=$(get_exporter_latest_version)
                    if [[ -z "$latest" ]]; then
                        msg_box "❌ Error" "Could not fetch latest version from GitHub.\nCheck your internet connection."
                    else
                        if yes_no "📥 Install" "Install xiraid-exporter v${latest}?\nDeveloped by E4 Computer Engineering\n\nThis will:\n- Download the .deb package from GitHub\n- Install and enable the systemd service\n- Expose metrics on port 9827"; then
                            install_xiraid_exporter "$latest"
                        fi
                    fi
                    ;;
                0) return ;;
            esac
        fi
    done
}

# Background exporter update check
check_exporter_update &

# ═══════════════════════════════════════════════════════════════════════════════
# Welcome Screen
# ═══════════════════════════════════════════════════════════════════════════════

show_welcome() {
    # Get quick stats for welcome screen
    local hostname
    hostname=$(hostname -f 2>/dev/null || hostname)
    local uptime_str
    uptime_str=$(uptime -p 2>/dev/null | sed 's/up //')

    # Get RAID status summary
    local raid_status="Not installed"
    local raid_icon="${RED}o${NC}"
    if command -v xicli &>/dev/null; then
        local raid_count
        raid_count=$(xicli raid show -f json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.keys()))" 2>/dev/null || echo "0")
        if [[ "$raid_count" != "0" ]]; then
            raid_status="$raid_count array(s)"
            raid_icon="${GREEN}*${NC}"
        fi
    fi

    # Get NFS status
    local nfs_status="Stopped"
    local nfs_icon="${RED}o${NC}"
    if [[ -f /proc/fs/nfsd/threads ]]; then
        local threads
        threads=$(cat /proc/fs/nfsd/threads 2>/dev/null)
        nfs_status="Running ($threads threads)"
        nfs_icon="${GREEN}*${NC}"
    fi

    show_header
    echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${WHITE}    │${NC}  ${CYAN}Welcome back to your NAS server!${NC}                           ${WHITE}│${NC}"
    echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "    ${WHITE}SYSTEM STATUS${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "        ${WHITE}Host:${NC}    ${CYAN}$hostname${NC}"
    echo -e "        ${WHITE}Uptime:${NC}  ${GREEN}$uptime_str${NC}"
    echo -e "        ${WHITE}RAID:${NC}    $raid_icon $raid_status"
    echo -e "        ${WHITE}NFS:${NC}     $nfs_icon $nfs_status"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    read -p "    Press Enter to continue..." -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

main_menu() {
    # Show welcome on first run (can be skipped with --no-welcome)
    if [[ "${1:-}" != "--no-welcome" ]]; then
        show_welcome
    fi

    while true; do
        # Pick up results from background update check
        _load_bg_update

        # Update status indicators
        local update_text="🔄 Check for Updates"
        if [[ "$UPDATE_AVAILABLE" == "true" ]] || [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
            update_text="🔄 Check for Updates [Update Available!]"
        fi

        # Exporter status indicator
        local exporter_text="📈 xiRAID Exporter"
        local exporter_ver
        exporter_ver=$(get_exporter_installed_version)
        if [[ -n "$exporter_ver" ]]; then
            local svc_state
            svc_state=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
            if [[ "$svc_state" == "active" ]]; then
                exporter_text="📈 xiRAID Exporter [v${exporter_ver} Running]"
            else
                exporter_text="📈 xiRAID Exporter [v${exporter_ver} Stopped]"
            fi
            [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && exporter_text="📈 xiRAID Exporter [Update!]"
        else
            exporter_text="📈 xiRAID Exporter [Not Installed]"
        fi

        show_header
        echo -e "  ${WHITE}$(hostname)${NC} | $(uptime -p 2>/dev/null | sed 's/up //')"
        if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
            echo -e "  ${YELLOW}📦 Update available!${NC}"
        fi
        echo ""

        local choice
        choice=$(menu_select "xiNAS Management" "Select an option:" \
            "1" "📊 System Status" \
            "2" "💾 RAID Management" \
            "3" "🌐 Network Settings" \
            "4" "📂 NFS Access Rights" \
            "5" "👥 User Management" \
            "6" "$exporter_text" \
            "7" "⚡ Quick Actions" \
            "8" "🩺 Health Check" \
            "9" "$update_text" \
            "0" "🚪 Exit") || break

        case "$choice" in
            1) audit_log "System Status"; show_status ;;
            2) audit_log "RAID Management"; raid_menu ;;
            3) audit_log "Network Settings"; network_menu ;;
            4) audit_log "NFS Access Rights"; nfs_menu ;;
            5) audit_log "User Management"; user_menu ;;
            6) audit_log "xiRAID Exporter"; manage_xiraid_exporter ;;
            7) audit_log "Quick Actions"; quick_actions_menu ;;
            8) audit_log "Health Check"; local _hc; _hc=$(_find_healthcheck) && source "$_hc" && healthcheck_menu || msg_box "Error" "healthcheck.sh not found" ;;
            9)
                audit_log "Check for Updates"
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    local detail_msg="A new version of xiNAS is available!"
                    [[ -n "$UPDATE_DETAILS" ]] && detail_msg+="\n\n${UPDATE_DETAILS}"
                    detail_msg+="\n\nWould you like to update now?"
                    if yes_no "🔄 Update Available" "$detail_msg"; then
                        do_update
                    fi
                else
                    info_box "🔄 Checking..." "Checking for updates..."
                    check_for_updates
                    check_exporter_update
                    if [[ "$UPDATE_AVAILABLE" == "true" ]] || [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                        local msg=""
                        [[ "$UPDATE_AVAILABLE" == "true" ]] && msg+="xiNAS: update available\n"
                        [[ -n "$UPDATE_DETAILS" ]] && msg+="${UPDATE_DETAILS}\n"
                        [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && msg+="xiraid-exporter: v${EXPORTER_UPDATE_AVAILABLE} available\n"
                        msg_box "📦 Updates Found" "$msg"
                    else
                        msg_box "✅ Up to Date" "Everything is up to date!"
                    fi
                fi
                ;;
            0)
                msg_box "👋 See you soon!" "Thank you for using xiNAS!\n\nRun this menu again anytime:\n  xinas-menu\n\nOr view status with:\n  xinas-status\n\nQuestions? support@xinnor.io"
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

# Handle command line arguments
case "${1:-}" in
    --version|-v)
        echo "xiNAS Menu v$XINAS_MENU_VERSION"
        if [[ -d "$SCRIPT_DIR/.git" ]] && command -v git &>/dev/null; then
            _commit=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
            [[ -n "$_commit" ]] && echo "Commit: $_commit"
        fi
        exit 0
        ;;
    --status|-s)
        # Quick status view
        if command -v xinas-status &>/dev/null; then
            xinas-status
        else
            echo "xinas-status not found"
        fi
        exit 0
        ;;
    --raid|-r)
        # Quick RAID info
        if command -v xicli &>/dev/null; then
            xicli raid show || true
        else
            echo "xicli not found"
        fi
        exit 0
        ;;
    --healthcheck|--hc)
        _hc=$(_find_healthcheck) || { echo "Error: healthcheck.sh not found" >&2; exit 1; }
        source "$_hc"
        _hc_cli_main "${@:2}"
        exit 0
        ;;
    --help|-h)
        echo "xiNAS Management Menu v$XINAS_MENU_VERSION"
        echo ""
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --version, -v    Show version information"
        echo "  --status, -s     Show system status and exit"
        echo "  --raid, -r       Show RAID info and exit"
        echo "  --healthcheck    Run health check (--quick|--standard|--deep|--json)"
        echo "  --no-welcome     Skip welcome screen"
        echo "  --debug, --db    Enable error tracing (log to /tmp/xinas-debug.log)"
        echo "  --help, -h       Show this help message"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    --no-welcome)
        main_menu --no-welcome
        ;;
    --debug|--db)
        main_menu
        ;;
    *)
        main_menu
        ;;
esac
