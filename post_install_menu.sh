#!/usr/bin/env bash
# xiNAS Post-Install Management Menu
# Emotionally-designed interactive menu for daily NAS management
# Run after each login for quick system management

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Check if running in interactive terminal
if [[ ! -t 0 ]]; then
    echo "This script must be run in an interactive terminal"
    exit 1
fi

# Check for whiptail
if ! command -v whiptail &>/dev/null; then
    echo -e "${RED}Error: whiptail is required${NC}"
    echo "Install with: sudo apt-get install whiptail"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# RAID Information Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_raid_info() {
    local extended="${1:-false}"
    local out="$TMP_DIR/raid_info"
    local title="💾 RAID Arrays"

    if [[ "$extended" == "true" ]]; then
        title="💾 RAID Arrays (Extended)"
    fi

    if ! command -v xicli &>/dev/null; then
        whiptail --title "$title" --msgbox "\
   ⚠️  xiRAID CLI not found

   The xicli command is not installed.
   Please ensure xiRAID is properly installed.

   Run the installation playbook first:
   ./startup_menu.sh → Install
" 14 50
        return
    fi

    # Get JSON output and format it nicely
    local json_file="$TMP_DIR/raid_json"
    local ext_flag=""
    [[ "$extended" == "true" ]] && ext_flag="-e"

    if ! xicli raid show -f json $ext_flag > "$json_file" 2>&1; then
        whiptail --title "$title" --msgbox "Failed to retrieve RAID information" 8 50
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

def line(content="", border="│"):
    """Create a line with proper padding to align right border"""
    vlen = visible_len(content)
    padding = W - vlen
    if padding < 0:
        content = content[:W]
        padding = 0
    return f"{border} {content}{' ' * padding}{border}"

def separator(char="─", left="├", right="┤"):
    return f"{left}{char * (W + 1)}{right}"

def progress_bar(percent, width=30):
    filled = int(percent * width / 100)
    empty = width - filled
    return f"[{'█' * filled}{'░' * empty}] {percent:3d}%"

def format_state(state_list):
    if not state_list:
        return "unknown"
    states = state_list if isinstance(state_list, list) else [state_list]
    icons = {
        "online": "✓", "initialized": "✓", "initing": "⟳",
        "degraded": "⚠", "rebuilding": "⟳", "offline": "✗", "failed": "✗"
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
    print(f"╔{'═' * (W + 1)}╗")
    title = "💾  RAID ARRAY STATUS"
    title_width = visible_len(title)
    pad = (W - title_width) // 2
    print(f"║{' ' * pad}{title}{' ' * (W - pad - title_width + 1)}║")
    print(f"╚{'═' * (W + 1)}╝")
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
        print(f"┌{'─' * (W + 1)}┐")
        print(line(f" Array: {name.upper()}"))
        print(separator())
        print(line())
        print(line(f"  RAID Level    │  RAID-{level}"))
        print(line(f"  Capacity      │  {size}"))
        print(line(f"  Status        │  {state_str}"))
        print(line(f"  Devices       │  {dev_summary}"))
        print(line(f"  Strip Size    │  {strip_size} KB"))
        print(line(f"  Spare Pool    │  {sparepool}"))

        if init_progress is not None and is_initing:
            print(line())
            print(line(f"  ⟳ Initializing: {progress_bar(init_progress)}"))

        if extended:
            print(line())
            print(line(f"  Memory Usage  │  {memory_mb} MB"))
            print(line(f"  Block Size    │  {block_size} bytes"))

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
                    icon = "●" if dev_state.lower() == "online" else "○"
                    print(line(f"  {icon} {dev_path:<14} Health: {h:<6} Wear: {w}"))

        print(line())
        print(f"└{'─' * (W + 1)}┘")
        print()

    # Summary
    total_arrays = len(data)
    healthy = sum(1 for a in data.values()
                  if all(s.lower() in ["online", "initialized"] for s in a.get("state", [])))
    print(f"{'━' * (W + 3)}")
    print(f"  Summary: {total_arrays} array(s), {healthy} healthy")
    print(f"{'━' * (W + 3)}")

except Exception as e:
    print(f"Error parsing RAID data: {e}")
    sys.exit(1)
PYEOF

    whiptail --title "$title" --scrolltext --textbox "$out" 30 82
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
        choice=$(whiptail --title "═══ 💾 RAID Management ═══" --menu "\
  View and manage your storage arrays
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "📊 Quick Overview" \
            "2" "📋 Extended Details (-e)" \
            "3" "💿 Physical Drives" \
            "4" "🏊 Spare Pools" \
            "5" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_raid_info "false" ;;
            2) show_raid_info "true" ;;
            3)
                out="$TMP_DIR/drives"
                show_physical_drives > "$out"
                whiptail --title "💿 Physical Drives" --scrolltext --textbox "$out" 24 80
                ;;
            4)
                out="$TMP_DIR/pools"
                show_spare_pools > "$out"
                whiptail --title "🏊 Spare Pools" --scrolltext --textbox "$out" 20 70
                ;;
            5) break ;;
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

    whiptail --title "Network Information" --scrolltext --textbox "$out" 28 78
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
        whiptail --title "No Config" --msgbox "No netplan configuration found.\n\nRun the initial setup first." 10 50
        return
    fi

    # Get list of interfaces from the system
    local ifaces=()
    local menu_items=()

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
        whiptail --title "No Interfaces" --msgbox "No network interfaces found." 8 45
        return
    fi

    menu_items+=("" "")
    menu_items+=("Done" "Finish and apply changes")

    local changes_made=false

    while true; do
        local choice
        choice=$(whiptail --title "Edit Interface IP" --menu "\
Select interface to configure:

Current netplan: $netplan_file" 20 65 10 \
            "${menu_items[@]}" 3>&1 1>&2 2>&3) || break

        [[ "$choice" == "Done" ]] && break
        [[ -z "$choice" ]] && continue

        # Get current IP for this interface
        local current_ip
        current_ip=$(ip -o -4 addr show "$choice" 2>/dev/null | awk '{print $4}' | head -1)
        [[ -z "$current_ip" ]] && current_ip="10.10.1.1/24"

        local new_ip
        new_ip=$(whiptail --title "Configure $choice" --inputbox "\
Enter IPv4 address with prefix:

Current: $current_ip
Format:  X.X.X.X/prefix (e.g., 192.168.1.100/24)

Leave empty to skip this interface." 14 55 "$current_ip" 3>&1 1>&2 2>&3) || continue

        [[ -z "$new_ip" ]] && continue

        # Validate IP/CIDR format
        if [[ ! "$new_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            whiptail --title "Invalid Format" --msgbox "Invalid IP format.\n\nUse: X.X.X.X/prefix (e.g., 192.168.1.100/24)" 10 50
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
            menu_items+=("" "")
            menu_items+=("Done" "Finish and apply changes")

            whiptail --title "Updated" --msgbox "Interface $choice configured:\n\nIP: $new_ip\n\nSelect 'Done' to apply changes." 12 50
        fi
        rm -f "$tmp_file"
    done

    # Apply changes if any were made
    if [[ "$changes_made" == "true" ]]; then
        if whiptail --title "Apply Changes" --yesno "\
Network configuration has been updated.

Apply changes now?

This will run 'netplan apply' to activate
the new IP addresses.

Active connections may be briefly interrupted." 14 55; then
            if sudo netplan apply 2>&1; then
                whiptail --title "Success" --msgbox "Network configuration applied!\n\nNew settings are now active." 10 50
            else
                whiptail --title "Error" --msgbox "Failed to apply network configuration.\n\nCheck: sudo netplan try" 10 50
            fi
        fi
    fi
}

network_menu() {
    local choice
    local netplan_file
    while true; do
        choice=$(whiptail --title "Network Settings" --menu "\
  Configure network interfaces
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "View Current Configuration" \
            "2" "Edit Interface IP Address" \
            "3" "Apply Network Changes" \
            "4" "View Netplan Config File" \
            "5" "Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_network_info ;;
            2) edit_interface_ip ;;
            3)
                if whiptail --title "Apply Changes" --yesno "\
   Apply network configuration?

   This will run 'netplan apply' to activate
   any changes to the network settings.

   Active connections may be briefly interrupted.
" 14 55; then
                    if sudo netplan apply 2>/dev/null; then
                        whiptail --title "Success" --msgbox "Network configuration applied successfully!" 8 50
                    else
                        whiptail --title "Error" --msgbox "Failed to apply network configuration.\nCheck /var/log/syslog for details." 10 55
                    fi
                fi
                ;;
            4)
                netplan_file=""
                for f in /etc/netplan/99-xinas.yaml /etc/netplan/*.yaml; do
                    [[ -f "$f" ]] && { netplan_file="$f"; break; }
                done
                if [[ -n "$netplan_file" && -f "$netplan_file" ]]; then
                    whiptail --title "Netplan: $netplan_file" --scrolltext --textbox "$netplan_file" 24 78
                else
                    whiptail --title "Netplan" --msgbox "No netplan configuration found." 8 45
                fi
                ;;
            5) break ;;
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
# NFS Access Rights Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_nfs_exports() {
    local out="$TMP_DIR/nfs_info"
    {
        echo "═══════════════════════════════════════════════════════════════"
        echo "                    NFS EXPORT CONFIGURATION"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""

        if [[ -f /etc/exports ]]; then
            echo "─── Current Exports (/etc/exports) ─────────────────────────────"
            echo ""
            cat /etc/exports
            echo ""
            echo "─── Active NFS Clients ──────────────────────────────────────────"
            echo ""

            # Check for active clients
            local client_count=0
            if [[ -d /proc/fs/nfsd/clients ]]; then
                for client_dir in /proc/fs/nfsd/clients/*/; do
                    [[ -f "${client_dir}info" ]] || continue
                    client_ip=$(grep -oP 'address:\s*\K[\d.]+' "${client_dir}info" 2>/dev/null | head -1)
                    [[ -n "$client_ip" ]] && {
                        echo "  ● $client_ip"
                        ((client_count++))
                    }
                done
            fi

            if [[ $client_count -eq 0 ]]; then
                # Fallback: check established connections
                ss -tn state established '( dport = :2049 )' 2>/dev/null | \
                    awk 'NR>1 {split($4,a,":"); print "  ● " a[1]}' | sort -u
                [[ $(ss -tn state established '( dport = :2049 )' 2>/dev/null | wc -l) -le 1 ]] && \
                    echo "  No active clients"
            fi

            echo ""
            echo "─── Share Usage ───────────────────────────────────────────────────"
            echo ""
            awk '{print $1}' /etc/exports 2>/dev/null | while read -r path; do
                [[ -z "$path" || "$path" =~ ^# ]] && continue
                if [[ -d "$path" ]]; then
                    df -h "$path" 2>/dev/null | awk 'NR==2 {printf "  %-25s %s used of %s (%s)\n", "'"$path"'", $3, $2, $5}'
                else
                    echo "  $path (not mounted)"
                fi
            done
        else
            echo "  /etc/exports not found"
            echo ""
            echo "  NFS exports have not been configured yet."
            echo "  Run the installation playbook to set up NFS shares."
        fi

    } > "$out"

    whiptail --title "📂 NFS Shares" --scrolltext --textbox "$out" 24 78
}

edit_nfs_clients() {
    if [[ ! -f /etc/exports ]]; then
        whiptail --title "⚠️ No Exports" --msgbox "\
   No NFS exports configured yet.

   Run the installation playbook first to set up
   your NFS shares, then return here to modify
   access rights.
" 12 55
        return
    fi

    # Parse current exports
    local exports_file="/etc/exports"
    local out="$TMP_DIR/exports_list"

    mapfile -t paths < <(awk '!/^#/ && NF {print $1}' "$exports_file" 2>/dev/null)

    if [[ ${#paths[@]} -eq 0 ]]; then
        whiptail --title "⚠️ No Exports" --msgbox "No exports found in /etc/exports" 8 45
        return
    fi

    # Build menu
    local menu_items=()
    for path in "${paths[@]}"; do
        local clients
        clients=$(awk -v p="$path" '$1==p {for(i=2;i<=NF;i++) printf "%s ", $i}' "$exports_file" | head -c 40)
        menu_items+=("$path" "${clients:-no clients}")
    done
    menu_items+=("Back" "Return to menu")

    while true; do
        local choice
        choice=$(whiptail --title "📂 Edit NFS Access Rights" --menu "\
  Select an export to modify access:
  ─────────────────────────────────────────────" 20 70 10 \
            "${menu_items[@]}" 3>&1 1>&2 2>&3) || break

        [[ "$choice" == "Back" ]] && break

        # Get current settings for this export
        local current_line
        current_line=$(grep "^${choice}[[:space:]]" "$exports_file" 2>/dev/null | head -1)
        local current_clients
        current_clients=$(echo "$current_line" | awk '{for(i=2;i<=NF;i++) print $i}')

        # Show edit dialog
        local new_clients
        new_clients=$(whiptail --title "✏️ Edit: $choice" --inputbox "\
  Current access rules:
  $current_clients

  Enter new access rules (e.g., *(rw,sync,no_subtree_check))

  Common formats:
    *                    - Allow all hosts
    192.168.1.0/24       - Allow subnet
    client.example.com   - Allow specific host

  Common options:
    rw,sync,no_subtree_check,no_root_squash
" 20 70 "$current_clients" 3>&1 1>&2 2>&3) || continue

        if [[ -n "$new_clients" ]]; then
            # Create backup
            local ts
            ts=$(date +%Y%m%d%H%M%S)
            sudo cp "$exports_file" "${exports_file}.${ts}.bak"

            # Update the export line
            sudo sed -i "s|^${choice}[[:space:]].*|${choice} ${new_clients}|" "$exports_file"

            # Refresh exports
            if sudo exportfs -ra 2>/dev/null; then
                whiptail --title "✅ Success" --msgbox "\
   Export updated successfully!

   Path: $choice
   Access: $new_clients

   Changes are now active.
" 12 55
                # Update menu items
                menu_items=()
                for path in "${paths[@]}"; do
                    local clients
                    clients=$(awk -v p="$path" '$1==p {for(i=2;i<=NF;i++) printf "%s ", $i}' "$exports_file" | head -c 40)
                    menu_items+=("$path" "${clients:-no clients}")
                done
                menu_items+=("Back" "Return to menu")
            else
                whiptail --title "⚠️ Warning" --msgbox "Export updated but exportfs failed.\nCheck configuration manually." 10 55
            fi
        fi
    done
}

nfs_menu() {
    local choice
    while true; do
        choice=$(whiptail --title "═══ 📂 NFS Access Management ═══" --menu "\
  Manage NFS share permissions
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "📊 View Current Shares & Clients" \
            "2" "✏️  Edit Access Rights" \
            "3" "🔄 Refresh Exports" \
            "4" "📋 View Raw /etc/exports" \
            "5" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_nfs_exports ;;
            2) edit_nfs_clients ;;
            3)
                if sudo exportfs -ra 2>/dev/null; then
                    whiptail --title "✅ Success" --msgbox "NFS exports refreshed successfully!" 8 45
                else
                    whiptail --title "❌ Error" --msgbox "Failed to refresh NFS exports.\nCheck /etc/exports for errors." 10 50
                fi
                ;;
            4)
                if [[ -f /etc/exports ]]; then
                    whiptail --title "📋 /etc/exports" --scrolltext --textbox /etc/exports 20 70
                else
                    whiptail --title "📋 /etc/exports" --msgbox "File not found." 8 40
                fi
                ;;
            5) break ;;
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
        choice=$(whiptail --title "═══ ⚡ Quick Actions ═══" --menu "\
  Common administrative tasks
  ─────────────────────────────────────────────" 18 60 6 \
            "1" "📊 Show xinas-status" \
            "2" "🔄 Restart NFS Server" \
            "3" "📋 View System Logs" \
            "4" "💾 Check Disk Health" \
            "5" "🔍 Service Status" \
            "6" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2)
                if whiptail --title "🔄 Restart NFS" --yesno "\
   Restart the NFS server?

   ⚠️  Active client connections may be
   temporarily interrupted.
" 11 50; then
                    if sudo systemctl restart nfs-server 2>/dev/null; then
                        whiptail --title "✅ Success" --msgbox "NFS server restarted successfully!" 8 45
                    else
                        whiptail --title "❌ Error" --msgbox "Failed to restart NFS server." 8 45
                    fi
                fi
                ;;
            3)
                out="$TMP_DIR/logs"
                {
                    echo "═══ Recent System Messages ═══"
                    echo ""
                    journalctl -n 50 --no-pager 2>/dev/null || dmesg | tail -50
                } > "$out"
                whiptail --title "📋 System Logs" --scrolltext --textbox "$out" 24 78
                ;;
            4)
                out="$TMP_DIR/disks"
                show_physical_drives > "$out"
                whiptail --title "💾 Disk Health" --scrolltext --textbox "$out" 24 80
                ;;
            5)
                out="$TMP_DIR/services"
                {
                    echo "═══ Service Status ═══"
                    echo ""
                    for svc in nfs-server xiraid nfsdcld rpcbind; do
                        status=$(systemctl is-active "$svc" 2>/dev/null || echo "not found")
                        case "$status" in
                            active) icon="✓" ;;
                            inactive) icon="○" ;;
                            *) icon="?" ;;
                        esac
                        printf "  %s  %-20s %s\n" "$icon" "$svc" "$status"
                    done
                } > "$out"
                whiptail --title "🔍 Services" --textbox "$out" 16 50
                ;;
            6) break ;;
        esac
    done
}

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
    if command -v xicli &>/dev/null; then
        local raid_count
        raid_count=$(xicli raid show -f json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.keys()))" 2>/dev/null || echo "0")
        [[ "$raid_count" != "0" ]] && raid_status="$raid_count array(s)"
    fi

    # Get NFS status
    local nfs_status="Stopped"
    if [[ -f /proc/fs/nfsd/threads ]]; then
        local threads
        threads=$(cat /proc/fs/nfsd/threads 2>/dev/null)
        nfs_status="Running ($threads threads)"
    fi

    whiptail --title "✨ xiNAS Management Console" --msgbox "\
   Welcome back to your NAS server!

   ┌─────────────────────────────────────────────┐
   │  🖥️  Host:    $hostname
   │  ⏱️  Uptime:  $uptime_str
   │  💾  RAID:    $raid_status
   │  📂  NFS:     $nfs_status
   └─────────────────────────────────────────────┘

   Select an option from the menu to manage
   your storage system.

   Need help? Contact: support@xinnor.io
" 20 55
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
        local choice
        choice=$(whiptail --title "═══ xiNAS Management ═══" --menu "\
  $(hostname) | $(uptime -p 2>/dev/null | sed 's/up //')
  ─────────────────────────────────────────────" 20 60 8 \
            "1" "📊 System Status" \
            "2" "💾 RAID Management" \
            "3" "🌐 Network Settings" \
            "4" "📂 NFS Access Rights" \
            "5" "⚡ Quick Actions" \
            "6" "🚪 Exit" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2) raid_menu ;;
            3) network_menu ;;
            4) nfs_menu ;;
            5) quick_actions_menu ;;
            6)
                whiptail --title "👋 See you soon!" --msgbox "\
   Thank you for using xiNAS!

   Run this menu again anytime:
     post_install_menu.sh

   Or view status with:
     xinas-status

   Questions? support@xinnor.io
" 14 50
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
    --help|-h)
        echo "xiNAS Post-Install Management Menu"
        echo ""
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --status, -s     Show system status and exit"
        echo "  --raid, -r       Show RAID info and exit"
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
