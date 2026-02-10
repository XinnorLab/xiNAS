#!/usr/bin/env bash
# xiNAS Post-Install Management Menu
# Colored console menu for daily NAS management
# Run after each login for quick system management

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Version tracking
XINAS_MENU_VERSION="1.1.0"

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

check_for_updates() {
    local git_dir="$SCRIPT_DIR/.git"
    [[ -d "$git_dir" ]] || return 0
    command -v git &>/dev/null || return 0
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0
    local local_commit
    local_commit=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null) || return 0
    git -C "$SCRIPT_DIR" fetch --quiet origin main 2>/dev/null || return 0
    local remote_commit
    remote_commit=$(git -C "$SCRIPT_DIR" rev-parse origin/main 2>/dev/null) || return 0
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

do_update() {
    if ! command -v git &>/dev/null; then
        msg_box "Error" "Git is not installed."
        return 1
    fi
    info_box "Updating..." "Pulling latest changes from origin/main..."
    if git -C "$SCRIPT_DIR" pull origin main 2>"$TMP_DIR/update.log"; then
        UPDATE_AVAILABLE=""
        msg_box "Update Complete" "xiNAS has been updated!\n\nPlease restart the menu to use the new version."
    else
        msg_box "Update Failed" "Failed to update:\n\n$(cat "$TMP_DIR/update.log")"
    fi
}

# Run update check in background
check_for_updates &

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
    --version|-v|--help|-h|--status|-s|--raid|-r|--healthcheck|--hc) ;;
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
    icons = {
        "online": "*", "initialized": "*", "initing": "~",
        "degraded": "!", "rebuilding": "~", "offline": "x", "failed": "x"
    }
    return " ".join(f"{icons.get(s.lower(), '•')} {s}" for s in states)

def count_device_states(devices):
    online = degraded = offline = 0
    for dev in devices:
        state = dev[2][0].lower() if dev[2] else "unknown"
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
        is_initing = any(s.lower() == "initing" for s in state)

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
            all_drives.append({
                "array": arr_name,
                "idx": idx,
                "path": path,
                "state": state,
                "health": h,
                "wear": w,
                "serial": serial,
                "size": size
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
        print(f"  {'Device':<14}{'Size':<10}{'State':<10}{'Health':<8}{'Wear':<7}{'Serial'}")
        print("-" * 75)

        for d in drives:
            path = d["path"].replace("/dev/", "")
            state = d["state"]
            icon = "*" if state.lower() == "online" else "o"
            health = d["health"]
            wear = d["wear"]
            size = d["size"]
            serial = d["serial"][:16] if len(d["serial"]) > 16 else d["serial"]
            print(f"  {icon} {path:<12}{size:<10}{state:<10}{health:<8}{wear:<7}{serial}")

        print()

    # Summary
    total_drives = len(all_drives)
    online_drives = sum(1 for d in all_drives if d["state"].lower() == "online")
    print("=" * 75)
    print(f"Total: {total_drives} drives, {online_drives} online")

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
            1) show_raid_info "false" ;;
            2) show_raid_info "true" ;;
            3)
                out="$TMP_DIR/drives"
                show_physical_drives > "$out"
                text_box "💿 Physical Drives" "$out"
                ;;
            4)
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
            if sudo netplan apply 2>&1; then
                msg_box "Success" "Network configuration applied!\n\nNew settings are now active."
            else
                msg_box "Error" "Failed to apply network configuration.\n\nCheck: sudo netplan try"
            fi
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
            1) show_network_info ;;
            2) edit_interface_ip ;;
            3)
                if yes_no "Apply Changes" "Apply network configuration?\n\nThis will run 'netplan apply' to activate\nany changes to the network settings.\n\nActive connections may be briefly interrupted."; then
                    if sudo netplan apply 2>/dev/null; then
                        msg_box "Success" "Network configuration applied successfully!"
                    else
                        msg_box "Error" "Failed to apply network configuration.\nCheck /var/log/syslog for details."
                    fi
                fi
                ;;
            4)
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

    # Step 1: Who can access?
    show_header
    local access_choice
    access_choice=$(menu_select "Step 1: Who Can Access?" "Who should be able to connect to:\n$share_path\n\nChoose who can access this folder:" \
        "1" "Everyone (any host on the network)" \
        "2" "Specific network (e.g., 192.168.1.0/24)" \
        "3" "Single host (by IP address)") || return

    local new_host
    case "$access_choice" in
        1)
            new_host="*"
            ;;
        2)
            new_host=$(input_box "Enter Network Address" "Enter the network address:\n\nExample: 192.168.1.0/24\nThis allows all hosts from 192.168.1.1 to 192.168.1.254\n\nFormat: X.X.X.0/24" "192.168.1.0/24") || return
            [[ -z "$new_host" ]] && new_host="*"
            ;;
        3)
            new_host=$(input_box "Enter Computer IP" "Enter the IP address of the host:\n\nExample: 192.168.1.100\n\nOnly this host will be able to connect.") || return
            [[ -z "$new_host" ]] && new_host="*"
            ;;
    esac

    # Step 2: Read or Read-Write?
    show_header
    local perm_choice
    perm_choice=$(menu_select "Step 2: Access Permissions" "What can connected hosts do?\n\nShare: $share_path\nAccess: $new_host" \
        "1" "Read & Write (can add, edit, delete files)" \
        "2" "Read Only (can only view files)") || return

    local new_rw
    case "$perm_choice" in
        1) new_rw="rw" ;;
        2) new_rw="ro" ;;
    esac

    # Step 3: Admin access?
    show_header
    local admin_choice
    admin_choice=$(menu_select "Step 3: Admin Access" "Allow full administrator access?\n\nIf enabled, remote admin users have full control\nover files (same as local root user).\n\nRecommended: Yes for trusted networks" \
        "1" "Yes - Full admin access (recommended)" \
        "2" "No - Limited access (more secure)") || return

    local new_root
    case "$admin_choice" in
        1) new_root="no_root_squash" ;;
        2) new_root="root_squash" ;;
    esac

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
    else
        # No existing options, use defaults
        new_options="${new_rw},sync,no_subtree_check,${new_root}"
    fi
    local new_spec="${new_host}(${new_options})"
    local new_line="${share_path} ${new_spec}"

    # Show summary and confirm
    local perm_desc="Read & Write"
    [[ "$new_rw" == "ro" ]] && perm_desc="Read Only"

    local admin_desc="Yes (full control)"
    [[ "$new_root" == "root_squash" ]] && admin_desc="No (limited)"

    local host_desc="$new_host"
    [[ "$new_host" == "*" ]] && host_desc="Everyone"

    if yes_no "Confirm Changes" "Please review your settings:\n\nShared Folder: $share_path\n\nWho can access:   $host_desc\nPermissions:      $perm_desc\nAdmin access:     $admin_desc\n\nApply these settings?"; then

        # Create backup
        local ts
        ts=$(date +%Y%m%d%H%M%S)
        sudo cp "$exports_file" "${exports_file}.${ts}.bak"

        # Update the export line
        sudo sed -i "s|^${share_path}[[:space:]].*|${new_line}|" "$exports_file"

        # Apply changes
        if sudo exportfs -ra 2>/dev/null; then
            msg_box "Success!" "Settings updated successfully!\n\nFolder: $share_path\nAccess: $host_desc ($perm_desc)\n\nChanges are now active. Computers can\nconnect using this address:\n\n  $share_path"
        else
            msg_box "Warning" "Settings saved but could not activate.\n\nPlease check /etc/exports for errors\nor restart the NFS service."
        fi
    fi
}

add_nfs_share() {
    # Add a new NFS share
    local exports_file="/etc/exports"

    # Step 1: Enter folder path
    local share_path
    share_path=$(input_box "Add New Shared Folder - Step 1" "Enter the folder path to share:\n\nThis is the folder on this server that other\nhosts will be able to access.\n\nExample: /mnt/data/shared" "/mnt/data/") || return

    [[ -z "$share_path" ]] && return

    # Check if path exists
    if [[ ! -d "$share_path" ]]; then
        if yes_no "Folder Not Found" "The folder does not exist:\n$share_path\n\nWould you like to create it?"; then
            if ! sudo mkdir -p "$share_path" 2>/dev/null; then
                msg_box "Error" "Could not create folder."
                return
            fi
        else
            return
        fi
    fi

    # Check if already shared
    if grep -q "^${share_path}[[:space:]]" "$exports_file" 2>/dev/null; then
        msg_box "Already Shared" "This folder is already being shared.\n\nUse 'Edit Share Settings' to modify it."
        return
    fi

    # Step 2: Who can access?
    show_header
    local access_choice
    access_choice=$(menu_select "Add New Share - Step 2" "Who should be able to access this folder?\n\nFolder: $share_path" \
        "1" "Everyone (any host)" \
        "2" "Specific network (recommended)" \
        "3" "Single host only") || return

    local new_host
    case "$access_choice" in
        1)
            new_host="*"
            ;;
        2)
            new_host=$(input_box "Network Address" "Enter network address (e.g., 192.168.1.0/24):" "192.168.1.0/24") || return
            [[ -z "$new_host" ]] && new_host="*"
            ;;
        3)
            new_host=$(input_box "Computer IP" "Enter the IP address:") || return
            [[ -z "$new_host" ]] && new_host="*"
            ;;
    esac

    # Step 3: Permissions
    show_header
    local perm_choice
    perm_choice=$(menu_select "Add New Share - Step 3" "What permissions should connected hosts have?" \
        "1" "Read & Write (full access)" \
        "2" "Read Only (view only)") || return

    local new_rw="rw"
    [[ "$perm_choice" == "2" ]] && new_rw="ro"

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
    local new_line="${share_path} ${new_host}(${base_options})"

    # Confirm
    local host_desc="$new_host"
    [[ "$new_host" == "*" ]] && host_desc="Everyone"

    local perm_desc="Read & Write"
    [[ "$new_rw" == "ro" ]] && perm_desc="Read Only"

    if yes_no "Confirm New Share" "Create this shared folder?\n\nFolder:      $share_path\nAccess:      $host_desc\nPermissions: $perm_desc"; then

        # Add to exports
        echo "$new_line" | sudo tee -a "$exports_file" > /dev/null

        # Apply
        if sudo exportfs -ra 2>/dev/null; then
            msg_box "Share Created!" "New shared folder created successfully!\n\nOther hosts can now connect to:\n$share_path\n\nFrom: $host_desc"
        else
            msg_box "Warning" "Share added but could not activate."
        fi
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
            "4" "🔄 Refresh (apply changes)" \
            "5" "📄 View Config File" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) show_nfs_exports ;;
            2) edit_nfs_share ;;
            3) add_nfs_share ;;
            4)
                if sudo exportfs -ra 2>/dev/null; then
                    msg_box "✅ Success" "Shared folders refreshed!"
                else
                    msg_box "❌ Error" "Failed to refresh.\nCheck settings for errors."
                fi
                ;;
            5)
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
    # Step 1: Enter username
    local username
    username=$(input_box "Create User - Step 1" "Enter the username for the new account:\n\nRules:\n- Lowercase letters and numbers only\n- Must start with a letter\n- 3-32 characters long") || return

    [[ -z "$username" ]] && return

    # Validate username
    if [[ ! "$username" =~ ^[a-z][a-z0-9]{2,31}$ ]]; then
        msg_box "Invalid Username" "Invalid username format.\n\nUsername must:\n- Start with a lowercase letter\n- Contain only lowercase letters and numbers\n- Be 3-32 characters long"
        return
    fi

    # Check if user exists
    if id "$username" &>/dev/null; then
        msg_box "User Exists" "User '$username' already exists."
        return
    fi

    # Step 2: Set password
    local password password2
    password=$(password_box "Create User - Step 2" "Enter password for '$username':\n\n(Minimum 6 characters)") || return

    if [[ ${#password} -lt 6 ]]; then
        msg_box "Password Too Short" "Password must be at least 6 characters."
        return
    fi

    password2=$(password_box "Create User - Step 2" "Confirm password:") || return

    if [[ "$password" != "$password2" ]]; then
        msg_box "Password Mismatch" "Passwords do not match."
        return
    fi

    # Step 3: Additional options
    local create_home="yes"

    if yes_no "Create User - Step 3" "Create home directory for '$username'?\n\nThis will create /home/$username"; then
        create_home="yes"
    else
        create_home="no"
    fi

    # Confirm
    if yes_no "Confirm User Creation" "Create this user account?\n\nUsername:    $username\nHome Dir:    $([ "$create_home" = "yes" ] && echo "/home/$username" || echo "None")\n\nProceed?"; then

        # Create user
        local useradd_opts="-m"
        [[ "$create_home" != "yes" ]] && useradd_opts="-M"

        if sudo useradd $useradd_opts -s /bin/bash "$username" 2>/dev/null; then
            # Set password
            echo "$username:$password" | sudo chpasswd 2>/dev/null

            msg_box "User Created" "User '$username' created successfully!\n\nThe user can now log in with their password.\n\nTo set a disk quota, use 'Set User Quota'\nfrom the User Management menu."
        else
            msg_box "Error" "Failed to create user.\nCheck system logs for details."
        fi
    fi
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

    if sudo userdel $remove_home "$username" 2>/dev/null; then
        msg_box "User Deleted" "User '$username' has been deleted."
    else
        msg_box "Error" "Failed to delete user."
    fi
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

        # Enable quotas if not already
        sudo quotaon "$mount_point" 2>/dev/null || true

        # Set quota
        if sudo setquota -u "$username" $soft_kb $quota_kb 0 0 "$mount_point" 2>/dev/null; then
            msg_box "Quota Set" "Disk quota set successfully!\n\nUser:    $username\nLimit:   $limit_desc\nMount:   $mount_point"
        else
            msg_box "Error" "Failed to set quota.\n\nMake sure quotas are enabled:\n  sudo quotacheck -cug $mount_point\n  sudo quotaon $mount_point"
        fi
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
            1) show_users ;;
            2) create_user ;;
            3) delete_user ;;
            4) set_user_quota ;;
            5) show_quotas ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Quick Actions
# ═══════════════════════════════════════════════════════════════════════════════

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
            "0" "🔙 Back") || break

        case "$choice" in
            1) show_status ;;
            2)
                if yes_no "Restart NFS" "Restart the NFS server?\n\nActive client connections may be\ntemporarily interrupted."; then
                    if sudo systemctl restart nfs-server 2>/dev/null; then
                        msg_box "Success" "NFS server restarted successfully!"
                    else
                        msg_box "Error" "Failed to restart NFS server."
                    fi
                fi
                ;;
            3)
                out="$TMP_DIR/logs"
                {
                    echo "=== Recent System Messages ==="
                    echo ""
                    journalctl -n 50 --no-pager 2>/dev/null || dmesg | tail -50
                } > "$out"
                text_box "System Logs" "$out"
                ;;
            4)
                out="$TMP_DIR/disks"
                show_physical_drives > "$out"
                text_box "Disk Health" "$out"
                ;;
            5)
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

    info_box "📥 Downloading" "Downloading xiraid-exporter v${version}..."
    if ! curl -fSL -o "$deb_file" "$deb_url" 2>"$TMP_DIR/exporter_dl.log"; then
        msg_box "Download Failed" "Could not download xiraid-exporter v${version}.\n\n$(cat "$TMP_DIR/exporter_dl.log")"
        return 1
    fi

    info_box "📦 Installing" "Installing xiraid-exporter v${version}..."
    if sudo dpkg -i "$deb_file" 2>"$TMP_DIR/exporter_inst.log"; then
        sudo systemctl daemon-reload
        sudo systemctl enable xiraid-exporter 2>/dev/null || true
        sudo systemctl restart xiraid-exporter 2>/dev/null || true
        msg_box "✅ Installed" "xiraid-exporter v${version} installed and started.\n\nMetrics available at http://localhost:9827/metrics"
        EXPORTER_UPDATE_AVAILABLE=""
    else
        msg_box "❌ Install Failed" "Failed to install package.\n\n$(cat "$TMP_DIR/exporter_inst.log")"
        return 1
    fi
    rm -f "$deb_file"
}

uninstall_xiraid_exporter() {
    if yes_no "🗑  Uninstall" "Remove xiraid-exporter and stop the service?"; then
        sudo systemctl stop xiraid-exporter 2>/dev/null || true
        sudo systemctl disable xiraid-exporter 2>/dev/null || true
        if sudo apt-get purge -y xiraid-exporter 2>"$TMP_DIR/exporter_rm.log"; then
            msg_box "✅ Removed" "xiraid-exporter has been uninstalled."
        else
            msg_box "❌ Error" "Failed to remove.\n\n$(cat "$TMP_DIR/exporter_rm.log")"
        fi
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
                        install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                    else
                        info_box "🔄 Checking..." "Checking for exporter updates..."
                        check_exporter_update
                        if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                            if yes_no "🔄 Update Available" "xiraid-exporter v${EXPORTER_UPDATE_AVAILABLE} is available.\nInstalled: v${installed}\n\nUpdate now?"; then
                                install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                            fi
                        else
                            msg_box "✅ Up to Date" "xiraid-exporter v${installed} is the latest version."
                        fi
                    fi
                    ;;
                2)
                    sudo systemctl restart xiraid-exporter 2>/dev/null
                    msg_box "✅ Restarted" "xiraid-exporter service restarted."
                    ;;
                3) uninstall_xiraid_exporter ;;
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
            1) show_status ;;
            2) raid_menu ;;
            3) network_menu ;;
            4) nfs_menu ;;
            5) user_menu ;;
            6) manage_xiraid_exporter ;;
            7) quick_actions_menu ;;
            8) local _hc; _hc=$(_find_healthcheck) && source "$_hc" && healthcheck_menu || msg_box "Error" "healthcheck.sh not found" ;;
            9)
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if yes_no "🔄 Update Available" "A new version of xiNAS is available!\n\nWould you like to update now?"; then
                        do_update
                    fi
                else
                    info_box "🔄 Checking..." "Checking for updates..."
                    check_for_updates
                    check_exporter_update
                    if [[ "$UPDATE_AVAILABLE" == "true" ]] || [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                        local msg=""
                        [[ "$UPDATE_AVAILABLE" == "true" ]] && msg+="xiNAS: update available\n"
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
        echo "  --help, -h       Show this help message"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    --no-welcome)
        main_menu --no-welcome
        ;;
    *)
        main_menu
        ;;
esac
