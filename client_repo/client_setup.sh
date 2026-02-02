#!/usr/bin/env bash
# xiNAS Client Setup Menu
# Emotionally-designed interactive menu for NFS client configuration
# Supports both RDMA and TCP transports

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Version tracking
CLIENT_VERSION="1.1.0"

# Network configuration file
NETWORK_CONFIG="$SCRIPT_DIR/network_config.yml"
UPDATE_AVAILABLE=""

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

# ═══════════════════════════════════════════════════════════════════════════════
# Update Check
# ═══════════════════════════════════════════════════════════════════════════════

check_for_updates() {
    # Only check if installed via git (standard install location)
    local install_dir="/opt/xinas-client"
    local git_dir="$install_dir/.git"

    # Also check if running from a git repo directly
    if [[ ! -d "$git_dir" ]]; then
        git_dir="$SCRIPT_DIR/../.git"
        [[ -d "$git_dir" ]] || git_dir="$SCRIPT_DIR/.git"
        [[ -d "$git_dir" ]] || return 0  # Not a git install, skip check
        install_dir="$(dirname "$git_dir")"
    fi

    # Skip if no git command
    command -v git &>/dev/null || return 0

    # Skip if no network (quick check)
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0

    # Get local commit
    local local_commit
    local_commit=$(git -C "$install_dir" rev-parse HEAD 2>/dev/null) || return 0

    # Fetch latest (quiet, background-friendly)
    git -C "$install_dir" fetch --quiet origin main 2>/dev/null || return 0

    # Get remote commit
    local remote_commit
    remote_commit=$(git -C "$install_dir" rev-parse origin/main 2>/dev/null) || return 0

    # Compare
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

show_update_banner() {
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        echo -e "${YELLOW}    ┌─────────────────────────────────────────────────────────────┐${NC}"
        echo -e "${YELLOW}    │${NC}  ${CYAN}📦 Update available!${NC} Run: ${WHITE}curl -fsSL https://xinnor.io/install_client.sh | sudo bash${NC}"
        echo -e "${YELLOW}    └─────────────────────────────────────────────────────────────┘${NC}"
        echo ""
    fi
}

# Run update check in background to avoid slowing startup
check_for_updates &
UPDATE_CHECK_PID=$!

# Check for root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo $0"
    exit 1
fi

# Check for whiptail
WHIPTAIL=$(command -v whiptail || true)
if [[ -z "$WHIPTAIL" ]]; then
    echo -e "${YELLOW}Installing whiptail...${NC}"
    if command -v apt-get &>/dev/null; then
        apt-get update -qq && apt-get install -y -qq whiptail
    elif command -v yum &>/dev/null; then
        yum install -y newt
    fi
    WHIPTAIL=$(command -v whiptail || true)
fi

if [[ -z "$WHIPTAIL" ]]; then
    echo -e "${RED}Error: whiptail is required for this menu${NC}"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Display Functions
# ═══════════════════════════════════════════════════════════════════════════════

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
    echo -e "${YELLOW}     NFS Client Setup${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

show_welcome() {
    show_header

    # Wait for update check to complete (with timeout)
    if [[ -n "${UPDATE_CHECK_PID:-}" ]]; then
        # Wait up to 3 seconds for the background check
        for _ in {1..30}; do
            kill -0 "$UPDATE_CHECK_PID" 2>/dev/null || break
            sleep 0.1
        done 2>/dev/null
        wait "$UPDATE_CHECK_PID" 2>/dev/null || true
    fi

    # Show update banner if available
    show_update_banner

    # Get current mount status
    local nfs_mounts
    nfs_mounts=$(mount -t nfs,nfs4 2>/dev/null | wc -l || echo "0")

    # Check RDMA support
    local rdma_status="Not available"
    local rdma_icon="${RED}○${NC}"
    if [[ -d /sys/class/infiniband ]] && ls /sys/class/infiniband/ &>/dev/null; then
        rdma_status="Available"
        rdma_icon="${GREEN}●${NC}"
    fi

    # Check nfs-common
    local nfs_status="Not installed"
    local nfs_icon="${RED}○${NC}"
    if command -v mount.nfs &>/dev/null || command -v mount.nfs4 &>/dev/null; then
        nfs_status="Installed"
        nfs_icon="${GREEN}●${NC}"
    fi

    echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS Client Setup!${NC}                          ${WHITE}│${NC}"
    echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "    ${WHITE}SYSTEM STATUS${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "        ${WHITE}Hostname:${NC}    ${CYAN}$(hostname)${NC}"
    echo -e "        ${WHITE}NFS Tools:${NC}   $nfs_icon $nfs_status"
    echo -e "        ${WHITE}RDMA:${NC}        $rdma_icon $rdma_status"
    echo -e "        ${WHITE}NFS Mounts:${NC}  ${GREEN}$nfs_mounts active${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${WHITE}QUICK START${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "    ${GREEN}①${NC}  ${WHITE}Install NFS Tools${NC} ${DIM}(if not installed)${NC}"
    echo -e "    ${GREEN}②${NC}  ${WHITE}Install DOCA OFED${NC} ${DIM}(for RDMA support)${NC}"
    echo -e "    ${GREEN}③${NC}  ${WHITE}Configure Network${NC} ${DIM}(storage network IPs)${NC}"
    echo -e "    ${GREEN}④${NC}  ${WHITE}Connect to NAS${NC} ${DIM}(mount NFS share)${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    read -p "    Press Enter to continue..." -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# System Status Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_status() {
    local out="$TMP_DIR/status"

    {
        echo "CLIENT SYSTEM STATUS"
        printf '=%.0s' {1..70}; echo ""
        echo ""

        echo "  Hostname:  $(hostname)"
        echo "  Kernel:    $(uname -r)"
        echo ""

        # NFS tools status
        echo "NFS TOOLS"
        printf -- '-%.0s' {1..70}; echo ""
        if command -v mount.nfs4 &>/dev/null; then
            echo "  [OK] NFS client tools installed"
            local nfs_version
            nfs_version=$(rpcinfo -p 2>/dev/null | grep -m1 nfs | awk '{print $2}' || echo "N/A")
            echo "       NFS version: $nfs_version"
        else
            echo "  [!!] NFS client tools NOT installed"
            echo "       Install with: apt-get install nfs-common"
        fi
        echo ""

        # RDMA status
        echo "RDMA SUPPORT"
        printf -- '-%.0s' {1..70}; echo ""
        if [[ -d /sys/class/infiniband ]]; then
            local ib_devices
            ib_devices=$(ls /sys/class/infiniband/ 2>/dev/null | tr '\n' ' ')
            if [[ -n "$ib_devices" ]]; then
                echo "  [OK] RDMA devices found: $ib_devices"
                # Show link status
                for dev in /sys/class/infiniband/*/ports/*/state; do
                    [[ -f "$dev" ]] || continue
                    local state
                    state=$(cat "$dev" 2>/dev/null | awk '{print $2}')
                    local dev_name
                    dev_name=$(echo "$dev" | sed 's|/sys/class/infiniband/||;s|/ports.*||')
                    local port
                    port=$(echo "$dev" | grep -oP 'ports/\K\d+')
                    echo "       $dev_name port $port: $state"
                done
            else
                echo "  [--] RDMA module loaded but no devices"
            fi
        else
            echo "  [!!] RDMA not available"
            echo "       Install DOCA OFED for RDMA support"
        fi
        echo ""

        # Current NFS mounts
        echo "ACTIVE NFS MOUNTS"
        printf -- '-%.0s' {1..70}; echo ""
        local mounts
        mounts=$(mount -t nfs,nfs4 2>/dev/null)
        if [[ -n "$mounts" ]]; then
            echo "$mounts" | while read -r line; do
                local server share mountpoint
                server=$(echo "$line" | awk -F: '{print $1}')
                share=$(echo "$line" | awk '{print $1}' | cut -d: -f2)
                mountpoint=$(echo "$line" | awk '{print $3}')
                local opts
                opts=$(echo "$line" | grep -oP '\(\K[^)]+')

                echo "  [*] $mountpoint"
                echo "      Server: $server"
                echo "      Share:  $share"
                if [[ "$opts" == *"rdma"* ]]; then
                    echo "      Mode:   RDMA (high-performance)"
                else
                    echo "      Mode:   TCP"
                fi
                echo ""
            done
        else
            echo "  No NFS mounts active"
            echo ""
        fi

        # /etc/fstab NFS entries
        echo "CONFIGURED MOUNTS (fstab)"
        printf -- '-%.0s' {1..70}; echo ""
        local fstab_nfs
        fstab_nfs=$(grep -E '^\s*[^#].*\snfs' /etc/fstab 2>/dev/null || true)
        if [[ -n "$fstab_nfs" ]]; then
            echo "$fstab_nfs" | while read -r line; do
                local server mountpoint
                server=$(echo "$line" | awk '{print $1}')
                mountpoint=$(echo "$line" | awk '{print $2}')
                echo "  $server -> $mountpoint"
            done
        else
            echo "  No NFS entries in /etc/fstab"
        fi
        echo ""

        # High-speed network interfaces
        echo "HIGH-SPEED NETWORK INTERFACES"
        printf -- '-%.0s' {1..70}; echo ""
        local hs_found=0
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            local name
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue

            local type driver
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                local ip_addr speed state
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}')
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                speed=$(cat "$iface/speed" 2>/dev/null || echo "unknown")
                state=$(cat "$iface/operstate" 2>/dev/null || echo "unknown")
                echo "  [*] $name"
                echo "      IP:     $ip_addr"
                echo "      Speed:  ${speed}Mb/s"
                echo "      State:  $state"
                echo "      Driver: $driver"
                hs_found=1
            fi
        done
        [[ $hs_found -eq 0 ]] && echo "  No high-speed interfaces detected"
        echo ""

        printf '=%.0s' {1..70}; echo ""
    } > "$out"

    whiptail --title "System Status" --scrolltext --textbox "$out" 28 76
}

# ═══════════════════════════════════════════════════════════════════════════════
# NFS Mount Configuration
# ═══════════════════════════════════════════════════════════════════════════════

install_nfs_tools() {
    if command -v mount.nfs4 &>/dev/null; then
        whiptail --title "Already Installed" --msgbox "\
NFS client tools are already installed.

You can proceed to mount NFS shares." 10 50
        return 0
    fi

    if whiptail --title "Install NFS Tools" --yesno "\
NFS client tools are not installed.

Install them now?

This will install:
  - nfs-common (Debian/Ubuntu)
  - nfs-utils (RHEL/CentOS)" 14 50; then

        whiptail --title "Installing..." --infobox "Installing NFS client tools..." 6 45

        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq nfs-common
        elif command -v yum &>/dev/null; then
            yum install -y nfs-utils
        elif command -v dnf &>/dev/null; then
            dnf install -y nfs-utils
        else
            whiptail --title "Error" --msgbox "Could not detect package manager." 8 45
            return 1
        fi

        # Configure NFS client kernel module for better performance
        cat > /etc/modprobe.d/nfsclient.conf <<'EOF'
# NFS client performance tuning for high-throughput workloads
options nfs max_session_slots=180
options nfs max_session_cb_slots=48
options nfs callback_nr_threads=10
options nfs nfs4_disable_idmapping=1
options nfs nfs_idmap_cache_timeout=900
options nfs delay_retrans=-1
options nfs nfs_access_max_cachesize=4194304
options nfs enable_ino64=1
EOF

        # Configure sysctl parameters for high-throughput NFS
        cat > /etc/sysctl.d/90-nfs-client.conf <<'EOF'
# Network buffer sizes for high-throughput NFS (256 MB)
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456

# Minimize swapping for better NFS performance
vm.swappiness = 10
EOF
        sysctl --system >/dev/null 2>&1

        whiptail --title "Success" --msgbox "\
NFS client tools installed successfully!

You can now mount NFS shares from your xiNAS server." 10 55
    fi
}

configure_nfs_mount() {
    # Check if NFS tools are installed
    if ! command -v mount.nfs4 &>/dev/null; then
        if whiptail --title "NFS Tools Required" --yesno "\
NFS client tools are not installed.

Install them now?" 10 45; then
            install_nfs_tools
        else
            return
        fi
    fi

    # Step 1: Select protocol
    local protocol
    protocol=$(whiptail --title "Step 1: Select Protocol" --menu "\
Choose the connection protocol:

RDMA provides much higher performance but requires
compatible network hardware (InfiniBand/RoCE).

TCP works with any network." 18 60 2 \
        "RDMA" "High-performance (requires DOCA OFED)" \
        "TCP" "Standard (works everywhere)" \
        3>&1 1>&2 2>&3) || return

    # Check RDMA availability if selected
    if [[ "$protocol" == "RDMA" ]]; then
        if [[ ! -d /sys/class/infiniband ]] || [[ -z "$(ls /sys/class/infiniband/ 2>/dev/null)" ]]; then
            if ! whiptail --title "RDMA Not Available" --yesno "\
RDMA hardware not detected on this system.

Would you like to:
- Yes: Continue with TCP instead
- No: Cancel and install DOCA OFED first" 12 55; then
                return
            fi
            protocol="TCP"
        fi
    fi

    # Step 2: Number of server IPs
    local num_ips
    num_ips=$(whiptail --title "Step 2: Number of Server IPs" --menu "\
How many server IP addresses will you use?

Using multiple IPs distributes connections for
better performance across network paths.

The 16 available NFS connections will be evenly
distributed across all IPs." 18 60 4 \
        "1" "Single IP (16 connections)" \
        "2" "Two IPs (8 connections each)" \
        "4" "Four IPs (4 connections each)" \
        "8" "Eight IPs (2 connections each)" \
        3>&1 1>&2 2>&3) || return

    local nconnect=$((16 / num_ips))

    # Step 3: Enter server IP(s)
    local server_ips=()
    local i
    for ((i=1; i<=num_ips; i++)); do
        local ip_label="Server Address"
        local ip_prompt="Enter the IP address of your xiNAS server:"
        if [[ $num_ips -gt 1 ]]; then
            ip_label="Server Address $i of $num_ips"
            ip_prompt="Enter IP address $i of $num_ips:"
        fi

        local server_ip
        server_ip=$(whiptail --title "Step 3: $ip_label" --inputbox "\
$ip_prompt

Example: 192.168.1.100 or 10.10.1.1

This is the storage network IP of your NAS." 14 55 "10.10.1.$i" 3>&1 1>&2 2>&3) || return

        [[ -z "$server_ip" ]] && return

        # Validate IP format
        if [[ ! "$server_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            whiptail --title "Invalid IP" --msgbox "Please enter a valid IP address." 8 45
            return
        fi

        server_ips+=("$server_ip")
    done

    # Step 4: Enter remote share path
    local share_path
    share_path=$(whiptail --title "Step 4: Share Path" --inputbox "\
Enter the NFS share path on the server:

Examples:
  /mnt/data      - Data volume
  /              - Root export

Ask your NAS administrator if unsure." 14 55 "/mnt/data" 3>&1 1>&2 2>&3) || return

    [[ -z "$share_path" ]] && share_path="/"

    # Step 5: Enter local mount point
    local mount_point_base
    local mount_point_msg="Enter the local directory to mount the share:

This directory will be created if it doesn't exist.

Example: /mnt/nas"
    if [[ $num_ips -gt 1 ]]; then
        mount_point_msg="Enter the base directory for mount points:

Each IP will be mounted to a numbered subdirectory:
  /mnt/nas/1, /mnt/nas/2, etc.

Example: /mnt/nas"
    fi
    mount_point_base=$(whiptail --title "Step 5: Mount Point" --inputbox "\
$mount_point_msg" 14 55 "/mnt/nas" 3>&1 1>&2 2>&3) || return

    [[ -z "$mount_point_base" ]] && mount_point_base="/mnt/nas"

    # Step 6: Mount options
    local add_to_fstab="yes"
    if whiptail --title "Step 6: Persistent Mount" --yesno "\
Add this mount to /etc/fstab?

If yes, the share will be automatically
mounted when the system boots.

Recommended: Yes" 12 50; then
        add_to_fstab="yes"
    else
        add_to_fstab="no"
    fi

    # Build mount options
    local mount_opts
    if [[ "$protocol" == "RDMA" ]]; then
        mount_opts="rdma,port=20049,nconnect=$nconnect,vers=4.2,sync"
    else
        mount_opts="nconnect=$nconnect,vers=4.2,sync"
    fi

    # Confirm settings
    local proto_desc="TCP (standard)"
    [[ "$protocol" == "RDMA" ]] && proto_desc="RDMA (high-performance)"

    local ip_list="${server_ips[*]}"
    local mount_point_desc="$mount_point_base"
    if [[ $num_ips -gt 1 ]]; then
        mount_point_desc="$mount_point_base/{1..$num_ips}"
    fi

    if ! whiptail --title "Confirm Settings" --yesno "\
Please review your mount configuration:

Server IPs:  $ip_list
Share:       $share_path
Mount Point: $mount_point_desc
Protocol:    $proto_desc
Connections: $nconnect per IP (total: 16)
Persistent:  $add_to_fstab

Proceed with mounting?" 18 60; then
        return
    fi

    # Mount each IP
    local mount_log="$TMP_DIR/mount.log"
    local failed_mounts=()
    local successful_mounts=()

    for ((i=0; i<num_ips; i++)); do
        local current_ip="${server_ips[$i]}"
        local mount_point
        if [[ $num_ips -eq 1 ]]; then
            mount_point="$mount_point_base"
        else
            mount_point="$mount_point_base/$((i+1))"
        fi

        # Create mount point
        mkdir -p "$mount_point"

        whiptail --title "Mounting..." --infobox "Connecting to $current_ip ($((i+1))/$num_ips)..." 6 50

        local mount_cmd="mount -t nfs -o $mount_opts $current_ip:$share_path $mount_point"

        if $mount_cmd > "$mount_log" 2>&1; then
            successful_mounts+=("$current_ip → $mount_point")

            # Add to fstab if requested
            if [[ "$add_to_fstab" == "yes" ]]; then
                # Remove any existing entry for this mount point
                sed -i "\|^.*[[:space:]]$mount_point[[:space:]]|d" /etc/fstab 2>/dev/null || true
                # Add new entry
                echo "$current_ip:$share_path $mount_point nfs $mount_opts 0 0" >> /etc/fstab
            fi
        else
            failed_mounts+=("$current_ip: $(cat "$mount_log")")
        fi
    done

    # Show results
    if [[ ${#failed_mounts[@]} -eq 0 ]]; then
        local mount_list=""
        for m in "${successful_mounts[@]}"; do
            mount_list+="  $m"$'\n'
        done

        whiptail --title "Success!" --msgbox "\
NFS share(s) mounted successfully!

Protocol:    $proto_desc
Connections: $nconnect per IP (total: 16)

Mounted:
$mount_list
$([ "$add_to_fstab" == "yes" ] && echo "These mounts will persist across reboots.")" 20 60
    elif [[ ${#successful_mounts[@]} -gt 0 ]]; then
        local fail_list=""
        for f in "${failed_mounts[@]}"; do
            fail_list+="  $f"$'\n'
        done

        whiptail --title "Partial Success" --msgbox "\
Some mounts succeeded, others failed.

Failed:
$fail_list
Troubleshooting:
- Check server IPs are correct
- Verify NFS server is running
- Check firewall settings" 18 65
    else
        local fail_list=""
        for f in "${failed_mounts[@]}"; do
            fail_list+="  $f"$'\n'
        done

        whiptail --title "Mount Failed" --msgbox "\
Failed to mount NFS share(s).

Errors:
$fail_list
Troubleshooting:
- Check server IPs are correct
- Verify NFS server is running
- Check firewall settings
- For RDMA: ensure DOCA OFED is installed" 18 65
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Mount Management
# ═══════════════════════════════════════════════════════════════════════════════

manage_mounts() {
    while true; do
        # Get current NFS mounts
        local mounts=()
        local mount_info=()

        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local mp
            mp=$(echo "$line" | awk '{print $3}')
            local server
            server=$(echo "$line" | awk '{print $1}')
            mounts+=("$mp")
            mount_info+=("$mp" "$server")
        done < <(mount -t nfs,nfs4 2>/dev/null)

        if [[ ${#mounts[@]} -eq 0 ]]; then
            whiptail --title "No Mounts" --msgbox "\
No active NFS mounts found.

Use 'Connect to NAS' to mount a share." 10 50
            return
        fi

        mount_info+=("" "")
        mount_info+=("Back" "Return to main menu")

        local choice
        choice=$(whiptail --title "Manage NFS Mounts" --menu "\
Select a mount to manage:

Active NFS mounts: ${#mounts[@]}" 18 65 8 \
            "${mount_info[@]}" 3>&1 1>&2 2>&3) || return

        [[ "$choice" == "Back" || -z "$choice" ]] && return

        # Show mount details and options
        local server share opts
        server=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f1)
        share=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f2)
        opts=$(mount | grep " $choice " | grep -oP '\(\K[^)]+')

        local action
        action=$(whiptail --title "Mount: $choice" --menu "\
Server: $server
Share:  $share
Options: $opts

Select action:" 18 60 4 \
            "1" "View Details" \
            "2" "Unmount" \
            "3" "Remount" \
            "4" "Back" \
            3>&1 1>&2 2>&3) || continue

        case "$action" in
            1)
                local details="$TMP_DIR/mount_details"
                {
                    echo "MOUNT DETAILS"
                    printf '=%.0s' {1..60}; echo ""
                    echo ""
                    echo "  Mount Point: $choice"
                    echo "  Server:      $server"
                    echo "  Share:       $share"
                    echo ""
                    echo "  Options:"
                    echo "  $opts" | tr ',' '\n' | sed 's/^/    /'
                    echo ""
                    echo "  Disk Usage:"
                    df -h "$choice" 2>/dev/null | tail -1 | awk '{print "    Used: "$3" / "$2" ("$5")"}'
                    echo ""
                    printf '=%.0s' {1..60}; echo ""
                } > "$details"
                whiptail --title "Mount Details" --textbox "$details" 20 65
                ;;
            2)
                if whiptail --title "Unmount" --yesno "\
Unmount $choice?

Server: $server:$share

Make sure no programs are using this mount." 12 55; then
                    if umount "$choice" 2>/dev/null; then
                        whiptail --title "Unmounted" --msgbox "Successfully unmounted $choice" 8 50
                    else
                        whiptail --title "Error" --msgbox "\
Failed to unmount.

The mount may be in use. Try:
  lsof +f -- $choice" 12 55
                    fi
                fi
                ;;
            3)
                if whiptail --title "Remount" --yesno "Remount $choice?" 8 45; then
                    if mount -o remount "$choice" 2>/dev/null; then
                        whiptail --title "Remounted" --msgbox "Successfully remounted $choice" 8 50
                    else
                        whiptail --title "Error" --msgbox "Failed to remount." 8 40
                    fi
                fi
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# DOCA OFED Installation
# ═══════════════════════════════════════════════════════════════════════════════

install_doca_ofed() {
    # Check if already installed
    if [[ -d /sys/class/infiniband ]] && command -v ibstat &>/dev/null; then
        local ib_devices
        ib_devices=$(ls /sys/class/infiniband/ 2>/dev/null | tr '\n' ' ')
        if [[ -n "$ib_devices" ]]; then
            whiptail --title "DOCA OFED Status" --msgbox "\
DOCA OFED appears to be installed.

Detected devices: $ib_devices

If you need to reinstall, use:
  ansible-playbook playbooks/doca_ofed_install.yml" 12 55
            return
        fi
    fi

    if ! whiptail --title "Install DOCA OFED" --yesno "\
Install NVIDIA DOCA OFED drivers?

This enables RDMA support for high-performance
NFS connections (NFS over RDMA).

Requirements:
- Compatible network adapter (ConnectX, etc.)
- Internet connection for package download
- System reboot after installation

Proceed with installation?" 16 55; then
        return
    fi

    # Check for Ansible
    if ! command -v ansible-playbook &>/dev/null; then
        whiptail --title "Installing Ansible..." --infobox "Installing Ansible..." 6 40
        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq ansible
        elif command -v yum &>/dev/null; then
            yum install -y ansible
        else
            whiptail --title "Error" --msgbox "Could not install Ansible." 8 45
            return 1
        fi
    fi

    # Run the playbook
    local playbook="$SCRIPT_DIR/playbooks/doca_ofed_install.yml"
    if [[ ! -f "$playbook" ]]; then
        whiptail --title "Error" --msgbox "Playbook not found:\n$playbook" 10 55
        return 1
    fi

    local log="$TMP_DIR/ansible.log"

    whiptail --title "Installing DOCA OFED" --infobox "\
Installing NVIDIA DOCA OFED...

This may take several minutes.
Please wait..." 10 50

    cd "$SCRIPT_DIR"
    if ansible-playbook "$playbook" -i inventories/lab.ini > "$log" 2>&1; then
        whiptail --title "Installation Complete" --msgbox "\
DOCA OFED installed successfully!

A system reboot is recommended to load
the new kernel modules.

After reboot, RDMA will be available for
high-performance NFS connections." 14 55

        if whiptail --title "Reboot Now?" --yesno "\
Reboot the system now?

RDMA will not be available until reboot." 10 50; then
            reboot
        fi
    else
        whiptail --title "Installation Failed" --scrolltext --textbox "$log" 20 70
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Connection Test
# ═══════════════════════════════════════════════════════════════════════════════

test_connection() {
    local server_ip
    server_ip=$(whiptail --title "Test Connection" --inputbox "\
Enter the xiNAS server IP to test:

This will check network connectivity and
NFS service availability." 12 55 "10.10.1.1" 3>&1 1>&2 2>&3) || return

    [[ -z "$server_ip" ]] && return

    local out="$TMP_DIR/test_result"

    {
        echo "CONNECTION TEST RESULTS"
        printf '=%.0s' {1..60}; echo ""
        echo ""
        echo "Target: $server_ip"
        echo ""

        # Ping test
        echo "1. Network Connectivity (ping)"
        printf -- '-%.0s' {1..60}; echo ""
        if ping -c 2 -W 2 "$server_ip" &>/dev/null; then
            echo "   [OK] Host is reachable"
        else
            echo "   [!!] Host unreachable - check network"
        fi
        echo ""

        # NFS port test
        echo "2. NFS Service (port 2049)"
        printf -- '-%.0s' {1..60}; echo ""
        if timeout 3 bash -c "echo >/dev/tcp/$server_ip/2049" 2>/dev/null; then
            echo "   [OK] NFS port is open"
        else
            echo "   [!!] NFS port closed or filtered"
        fi
        echo ""

        # RDMA port test
        echo "3. NFS-RDMA Service (port 20049)"
        printf -- '-%.0s' {1..60}; echo ""
        if timeout 3 bash -c "echo >/dev/tcp/$server_ip/20049" 2>/dev/null; then
            echo "   [OK] NFS-RDMA port is open"
        else
            echo "   [--] NFS-RDMA port not available"
            echo "       (Normal if RDMA not configured)"
        fi
        echo ""

        # RPC info
        echo "4. RPC Services"
        printf -- '-%.0s' {1..60}; echo ""
        if command -v rpcinfo &>/dev/null; then
            local rpc_out
            rpc_out=$(rpcinfo -p "$server_ip" 2>/dev/null | grep -E 'nfs|mountd' | head -5)
            if [[ -n "$rpc_out" ]]; then
                echo "   [OK] NFS services detected:"
                echo "$rpc_out" | sed 's/^/       /'
            else
                echo "   [!!] No NFS services found"
            fi
        else
            echo "   [--] rpcinfo not available"
        fi
        echo ""

        # Show exports if possible
        echo "5. Available Exports"
        printf -- '-%.0s' {1..60}; echo ""
        if command -v showmount &>/dev/null; then
            local exports
            exports=$(showmount -e "$server_ip" 2>/dev/null | tail -n +2)
            if [[ -n "$exports" ]]; then
                echo "   [OK] Exports found:"
                echo "$exports" | sed 's/^/       /'
            else
                echo "   [--] No exports visible (may be access restricted)"
            fi
        else
            echo "   [--] showmount not available"
        fi
        echo ""

        printf '=%.0s' {1..60}; echo ""
    } > "$out"

    whiptail --title "Connection Test: $server_ip" --scrolltext --textbox "$out" 28 70
}

# ═══════════════════════════════════════════════════════════════════════════════
# Update Management
# ═══════════════════════════════════════════════════════════════════════════════

check_and_update() {
    local install_dir="/opt/xinas-client"
    local git_dir="$install_dir/.git"

    # Check alternate locations
    if [[ ! -d "$git_dir" ]]; then
        git_dir="$SCRIPT_DIR/../.git"
        [[ -d "$git_dir" ]] || git_dir="$SCRIPT_DIR/.git"
        if [[ -d "$git_dir" ]]; then
            install_dir="$(dirname "$git_dir")"
        fi
    fi

    if [[ ! -d "$git_dir" ]]; then
        whiptail --title "Not Git Installation" --msgbox "\
This installation was not done via git.

To enable automatic updates, reinstall using:
  curl -fsSL https://xinnor.io/install_client.sh | sudo bash" 12 60
        return
    fi

    if ! command -v git &>/dev/null; then
        whiptail --title "Git Not Found" --msgbox "\
Git is required for update checking.

Install git first, then retry." 10 50
        return
    fi

    whiptail --title "Checking..." --infobox "Checking for updates..." 6 40

    # Fetch latest
    if ! git -C "$install_dir" fetch --quiet origin main 2>/dev/null; then
        whiptail --title "Network Error" --msgbox "\
Could not connect to update server.

Please check your internet connection." 10 50
        return
    fi

    local local_commit remote_commit
    local_commit=$(git -C "$install_dir" rev-parse HEAD 2>/dev/null)
    remote_commit=$(git -C "$install_dir" rev-parse origin/main 2>/dev/null)

    if [[ "$local_commit" == "$remote_commit" ]]; then
        whiptail --title "Up to Date" --msgbox "\
xiNAS Client is up to date!

Version: $CLIENT_VERSION
Commit:  ${local_commit:0:8}" 12 50
        UPDATE_AVAILABLE=""
        return
    fi

    # Show what's new
    local changes
    changes=$(git -C "$install_dir" log --oneline HEAD..origin/main 2>/dev/null | head -10)

    if whiptail --title "Update Available" --yesno "\
A new version is available!

Current: ${local_commit:0:8}
Latest:  ${remote_commit:0:8}

Recent changes:
$changes

Update now?" 20 60; then

        whiptail --title "Updating..." --infobox "Downloading update..." 6 40

        if git -C "$install_dir" pull --quiet origin main 2>/dev/null; then
            UPDATE_AVAILABLE=""
            whiptail --title "Updated!" --msgbox "\
xiNAS Client has been updated!

The menu will now restart with the new version." 10 55

            # Re-execute the script with the new version
            exec "$0" "$@"
        else
            whiptail --title "Update Failed" --msgbox "\
Update failed. You can try manually:

  cd $install_dir
  git pull origin main

Or reinstall:
  curl -fsSL https://xinnor.io/install_client.sh | sudo bash" 14 60
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Network Configuration
# ═══════════════════════════════════════════════════════════════════════════════

# Validate IPv4 address (without CIDR)
valid_ipv4() {
    local ip="$1"
    [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS=. read -r o1 o2 o3 o4 <<< "$ip"
    for octet in $o1 $o2 $o3 $o4; do
        [[ $octet -ge 0 && $octet -le 255 ]] || return 1
    done
    return 0
}

# Validate IPv4 address with CIDR prefix
valid_ipv4_cidr() {
    local ip=${1%/*}
    local prefix=${1#*/}
    [[ "$1" == */* ]] || return 1
    valid_ipv4 "$ip" || return 1
    [[ $prefix =~ ^[0-9]{1,2}$ ]] || return 1
    [[ $prefix -ge 0 && $prefix -le 32 ]] || return 1
    return 0
}

# Get current network pool settings
get_network_pool_settings() {
    if [[ -f "$NETWORK_CONFIG" ]] && command -v yq &>/dev/null; then
        net_pool_enabled=$(yq '.net_ip_pool_enabled // false' "$NETWORK_CONFIG" 2>/dev/null || echo "false")
        net_pool_start=$(yq '.net_ip_pool_start // "10.10.1.2"' "$NETWORK_CONFIG" 2>/dev/null || echo "10.10.1.2")
        net_pool_end=$(yq '.net_ip_pool_end // "10.10.255.2"' "$NETWORK_CONFIG" 2>/dev/null || echo "10.10.255.2")
        net_pool_prefix=$(yq '.net_ip_pool_prefix // 24' "$NETWORK_CONFIG" 2>/dev/null || echo "24")
        net_mtu=$(yq '.net_mtu // 0' "$NETWORK_CONFIG" 2>/dev/null || echo "0")
    else
        net_pool_enabled=false
        net_pool_start="10.10.1.2"
        net_pool_end="10.10.255.2"
        net_pool_prefix=24
        net_mtu=0
    fi
}

# Save network pool settings
save_network_pool_settings() {
    local start="$1" end="$2" prefix="$3" mtu="${4:-0}"

    # Install yq if not present
    if ! command -v yq &>/dev/null; then
        if command -v snap &>/dev/null; then
            snap install yq 2>/dev/null || true
        fi
    fi

    cat > "$NETWORK_CONFIG" <<EOF
---
# xiNAS Client Network Configuration
# Automatic IP pool allocation for storage network interfaces
net_ip_pool_enabled: true
net_ip_pool_start: "$start"
net_ip_pool_end: "$end"
net_ip_pool_prefix: $prefix

# Interface detection
net_detect_infiniband: true
net_detect_mlx5: true

# MTU (0 = system default, 9000 = jumbo frames)
net_mtu: $mtu
EOF
}

# Detect high-speed network interfaces
detect_high_speed_interfaces() {
    local interfaces=()
    for iface in /sys/class/net/*; do
        [ -d "$iface" ] || continue
        local name
        name=$(basename "$iface")
        [ "$name" = "lo" ] && continue
        [ -e "$iface/device" ] || continue

        local type driver
        type=$(cat "$iface/type" 2>/dev/null || echo "0")
        driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

        # InfiniBand (type 32) or NVIDIA MLX5 driver
        if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
            interfaces+=("$name")
        fi
    done
    echo "${interfaces[@]}"
}

# Configure IP pool for automatic allocation
configure_network_ip_pool() {
    get_network_pool_settings

    # Input start IP
    while true; do
        local new_start
        new_start=$(whiptail --title "Network: IP Pool Start" --inputbox "\
Configure IP pool for storage network interfaces.

Start IP address of the pool:

Format: X.X.X.X (e.g., 10.10.1.2)
Each interface will get the next subnet:
  Interface 1: 10.10.1.2
  Interface 2: 10.10.2.2
  etc.

Note: Use .2 addresses if .1 is your NAS server." 18 60 "$net_pool_start" 3>&1 1>&2 2>&3) || return

        if valid_ipv4 "$new_start"; then
            break
        else
            whiptail --title "Invalid IP" --msgbox "Invalid IP address format. Use X.X.X.X" 8 50
        fi
    done

    # Input end IP
    while true; do
        local new_end
        new_end=$(whiptail --title "Network: IP Pool End" --inputbox "\
End IP address of the pool:

Format: X.X.X.X (e.g., 10.10.255.2)" 12 60 "$net_pool_end" 3>&1 1>&2 2>&3) || return

        if valid_ipv4 "$new_end"; then
            break
        else
            whiptail --title "Invalid IP" --msgbox "Invalid IP address format. Use X.X.X.X" 8 50
        fi
    done

    # Input prefix
    while true; do
        local new_prefix
        new_prefix=$(whiptail --title "Network: Subnet Prefix" --inputbox "\
Subnet prefix (CIDR):

(e.g., 24 for /24 = 255.255.255.0)" 12 50 "$net_pool_prefix" 3>&1 1>&2 2>&3) || return

        if [[ $new_prefix =~ ^[0-9]{1,2}$ ]] && [[ $new_prefix -ge 1 && $new_prefix -le 32 ]]; then
            break
        else
            whiptail --title "Invalid Prefix" --msgbox "Invalid prefix. Use 1-32." 8 40
        fi
    done

    # Input MTU
    local new_mtu
    new_mtu=$(whiptail --title "Network: MTU Setting" --inputbox "\
MTU (Maximum Transmission Unit):

  0    = System default
  1500 = Standard Ethernet
  9000 = Jumbo frames (recommended for storage)

Leave at 0 unless you know your network supports jumbo frames." 16 60 "$net_mtu" 3>&1 1>&2 2>&3) || return

    [[ -z "$new_mtu" ]] && new_mtu=0

    # Save settings
    save_network_pool_settings "$new_start" "$new_end" "$new_prefix" "$new_mtu"

    # Show summary
    whiptail --title "IP Pool Configured" --msgbox "\
IP Pool configured:

Range: $new_start - $new_end
Prefix: /$new_prefix
MTU: $([ "$new_mtu" = "0" ] && echo "System default" || echo "$new_mtu")

Interfaces will be auto-assigned:
  Interface 1: ${new_start}/${new_prefix}
  Interface 2: next subnet
  etc.

Saved to: $NETWORK_CONFIG

Use 'Apply Network Configuration' to activate." 18 60
}

# Configure interfaces manually
configure_network_manual() {
    # Gather available interfaces
    readarray -t all_interfaces < <(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

    if [[ ${#all_interfaces[@]} -eq 0 ]]; then
        whiptail --title "No Interfaces" --msgbox "No network interfaces found." 8 45
        return
    fi

    declare -A curr_ip new_ip
    local configs=()

    for iface in "${all_interfaces[@]}"; do
        local ip_addr
        ip_addr=$(ip -o -4 addr show "$iface" 2>/dev/null | awk '{print $4}')
        [[ -z "$ip_addr" ]] && ip_addr="none"
        curr_ip[$iface]="$ip_addr"
        new_ip[$iface]=""
    done

    while true; do
        local menu_items=()
        for iface in "${all_interfaces[@]}"; do
            local speed="unknown"
            if [[ -e "/sys/class/net/$iface/speed" ]]; then
                speed=$(cat "/sys/class/net/$iface/speed" 2>/dev/null || echo "unknown")
            fi
            # Check if high-speed interface
            local type driver marker=""
            if [[ -e "/sys/class/net/$iface/device" ]]; then
                type=$(cat "/sys/class/net/$iface/type" 2>/dev/null || echo "0")
                driver=$(basename "$(readlink -f "/sys/class/net/$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
                if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                    marker=" [RDMA]"
                fi
            fi
            local desc="${curr_ip[$iface]}"
            [[ -n "${new_ip[$iface]}" ]] && desc+=" -> ${new_ip[$iface]}"
            desc+=" - ${speed}Mb/s${marker}"
            menu_items+=("$iface" "$desc")
        done
        menu_items+=("" "")
        menu_items+=("Finish" "Apply configuration")

        local iface
        iface=$(whiptail --title "Manual Network Configuration" --menu "\
Select interface to configure:

[RDMA] indicates high-speed interfaces suitable for storage." 20 70 10 \
            "${menu_items[@]}" 3>&1 1>&2 2>&3) || return

        [[ "$iface" == "Finish" ]] && break
        [[ -z "$iface" ]] && continue

        local prompt="IPv4 address for $iface (current: ${curr_ip[$iface]})"
        [[ -n "${new_ip[$iface]}" ]] && prompt+="\n[new: ${new_ip[$iface]}]"

        while true; do
            local addr
            addr=$(whiptail --title "Configure: $iface" --inputbox "\
$prompt

Format: X.X.X.X/prefix (e.g., 10.10.1.2/24)

Leave empty to skip this interface." 14 60 3>&1 1>&2 2>&3) || break

            [[ -z "$addr" ]] && break

            if valid_ipv4_cidr "$addr"; then
                new_ip[$iface]="$addr"
                local found=""
                for i in "${!configs[@]}"; do
                    local name
                    IFS=: read -r name _ <<< "${configs[i]}"
                    if [[ "$name" == "$iface" ]]; then
                        configs[i]="$iface:$addr"
                        found=1
                        break
                    fi
                done
                [[ -z "$found" ]] && configs+=("$iface:$addr")
                break
            else
                whiptail --title "Invalid Format" --msgbox "Invalid IPv4/CIDR format. Use X.X.X.X/prefix" 8 60
            fi
        done
    done

    if [[ ${#configs[@]} -eq 0 ]]; then
        whiptail --title "No Changes" --msgbox "No interfaces were configured." 8 45
        return
    fi

    # Ask for MTU
    get_network_pool_settings
    local mtu
    mtu=$(whiptail --title "MTU Setting" --inputbox "\
MTU (Maximum Transmission Unit):

  0    = System default
  1500 = Standard Ethernet
  9000 = Jumbo frames (recommended for storage)" 14 55 "$net_mtu" 3>&1 1>&2 2>&3) || return

    [[ -z "$mtu" ]] && mtu=0

    # Generate netplan configuration
    local netplan_file="/etc/netplan/99-xinas-client.yaml"
    local tmp_file
    tmp_file=$(mktemp)

    cat > "$tmp_file" <<EOF
# xiNAS Client Network Configuration
# Generated by client_setup.sh
network:
  version: 2
  renderer: networkd
  ethernets:
EOF

    for cfg in "${configs[@]}"; do
        local name addr
        IFS=: read -r name addr <<< "$cfg"
        cat >> "$tmp_file" <<EOF
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF
        if [[ "$mtu" -gt 0 ]]; then
            cat >> "$tmp_file" <<EOF
      mtu: $mtu
EOF
        fi
    done

    # Show preview
    local preview="$TMP_DIR/netplan_preview"
    cat "$tmp_file" > "$preview"

    if whiptail --title "Confirm Configuration" --yesno "\
Review the netplan configuration:

$(cat "$preview")

Apply this configuration?

This will modify: $netplan_file" 24 70; then
        # Backup existing config
        if [[ -f "$netplan_file" ]]; then
            cp "$netplan_file" "${netplan_file}.$(date +%Y%m%d%H%M%S).bak"
        fi

        mv "$tmp_file" "$netplan_file"
        chmod 600 "$netplan_file"

        # Save MTU to config
        if [[ -f "$NETWORK_CONFIG" ]] && command -v yq &>/dev/null; then
            yq -i ".net_mtu = $mtu" "$NETWORK_CONFIG" 2>/dev/null || true
            yq -i '.net_ip_pool_enabled = false' "$NETWORK_CONFIG" 2>/dev/null || true
        else
            cat > "$NETWORK_CONFIG" <<EOF
---
net_ip_pool_enabled: false
net_mtu: $mtu
EOF
        fi

        if whiptail --title "Apply Now?" --yesno "\
Configuration saved to $netplan_file

Apply network configuration now?

Warning: This may briefly disrupt network connectivity." 12 55; then
            whiptail --title "Applying..." --infobox "Applying network configuration..." 6 45
            if netplan apply 2>/dev/null; then
                sleep 2
                whiptail --title "Success" --msgbox "\
Network configuration applied successfully!

Configured interfaces:
$(for cfg in "${configs[@]}"; do echo "  ${cfg/:/ -> }"; done)

MTU: $([ "$mtu" = "0" ] && echo "System default" || echo "$mtu")" 16 55
            else
                whiptail --title "Warning" --msgbox "\
netplan apply returned an error.

Please check the configuration:
  cat $netplan_file

You may need to apply manually:
  sudo netplan apply" 14 55
            fi
        else
            whiptail --title "Saved" --msgbox "\
Configuration saved but not applied.

To apply later, run:
  sudo netplan apply" 10 50
        fi
    else
        rm -f "$tmp_file"
    fi
}

# Apply IP pool configuration to interfaces
apply_network_pool() {
    get_network_pool_settings

    if [[ "$net_pool_enabled" != "true" ]]; then
        whiptail --title "Pool Not Configured" --msgbox "\
IP pool is not enabled.

Please configure the IP pool first using
'Configure IP Pool' option." 10 50
        return
    fi

    # Detect high-speed interfaces
    local hs_ifaces
    hs_ifaces=$(detect_high_speed_interfaces)

    if [[ -z "$hs_ifaces" ]]; then
        whiptail --title "No Interfaces" --msgbox "\
No high-speed interfaces detected.

Make sure DOCA OFED is installed and your
InfiniBand/RDMA hardware is recognized." 12 55
        return
    fi

    # Convert to array
    local interfaces=($hs_ifaces)

    if [[ ${#interfaces[@]} -eq 0 ]]; then
        whiptail --title "No Interfaces" --msgbox "No interfaces to configure." 8 45
        return
    fi

    # Parse start IP to calculate allocation
    IFS=. read -r s1 s2 s3 s4 <<< "$net_pool_start"

    # Generate netplan
    local netplan_file="/etc/netplan/99-xinas-client.yaml"
    local tmp_file
    tmp_file=$(mktemp)

    cat > "$tmp_file" <<EOF
# xiNAS Client Network Configuration
# Generated by client_setup.sh (IP Pool Mode)
network:
  version: 2
  renderer: networkd
  ethernets:
EOF

    local idx=0
    local allocated_ips=""
    for iface in "${interfaces[@]}"; do
        # Calculate IP: increment third octet for each interface
        local ip_third=$((s3 + idx))
        local ip="${s1}.${s2}.${ip_third}.${s4}"
        allocated_ips+="  $iface: ${ip}/${net_pool_prefix}\n"

        cat >> "$tmp_file" <<EOF
    $iface:
      dhcp4: no
      addresses: [ ${ip}/${net_pool_prefix} ]
EOF
        if [[ "$net_mtu" -gt 0 ]]; then
            cat >> "$tmp_file" <<EOF
      mtu: $net_mtu
EOF
        fi
        ((++idx))
    done

    # Show preview
    if whiptail --title "Apply IP Pool Configuration" --yesno "\
Detected ${#interfaces[@]} high-speed interface(s).

IP Allocation:
$(echo -e "$allocated_ips")
Pool: $net_pool_start - $net_pool_end / $net_pool_prefix
MTU: $([ "$net_mtu" = "0" ] && echo "System default" || echo "$net_mtu")

Apply this configuration?" 20 60; then
        # Backup existing config
        if [[ -f "$netplan_file" ]]; then
            cp "$netplan_file" "${netplan_file}.$(date +%Y%m%d%H%M%S).bak"
        fi

        mv "$tmp_file" "$netplan_file"
        chmod 600 "$netplan_file"

        whiptail --title "Applying..." --infobox "Applying network configuration..." 6 45

        if netplan apply 2>/dev/null; then
            sleep 2
            whiptail --title "Success" --msgbox "\
Network configuration applied!

Configured interfaces:
$(echo -e "$allocated_ips")
Configuration: $netplan_file" 16 55
        else
            whiptail --title "Warning" --msgbox "\
netplan apply returned an error.

Please check the configuration manually:
  cat $netplan_file
  sudo netplan apply" 12 55
        fi
    else
        rm -f "$tmp_file"
    fi
}

# View current network configuration
view_network_config() {
    get_network_pool_settings

    local out="$TMP_DIR/network_config"
    {
        echo "NETWORK CONFIGURATION"
        printf '=%.0s' {1..60}; echo ""
        echo ""

        echo "IP POOL SETTINGS"
        printf -- '-%.0s' {1..60}; echo ""
        echo "  Enabled: $net_pool_enabled"
        echo "  Range:   $net_pool_start - $net_pool_end"
        echo "  Prefix:  /$net_pool_prefix"
        echo "  MTU:     $([ "$net_mtu" = "0" ] && echo "System default" || echo "$net_mtu")"
        echo ""

        echo "DETECTED HIGH-SPEED INTERFACES"
        printf -- '-%.0s' {1..60}; echo ""
        local found=0
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            local name
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue

            local type driver
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                local ip_addr speed state
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}')
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                speed=$(cat "$iface/speed" 2>/dev/null || echo "unknown")
                state=$(cat "$iface/operstate" 2>/dev/null || echo "unknown")
                echo "  $name:"
                echo "    IP:     $ip_addr"
                echo "    Speed:  ${speed}Mb/s"
                echo "    State:  $state"
                echo "    Driver: $driver"
                found=1
            fi
        done
        [[ $found -eq 0 ]] && echo "  No high-speed interfaces detected"
        echo ""

        echo "CURRENT NETPLAN (99-xinas-client.yaml)"
        printf -- '-%.0s' {1..60}; echo ""
        if [[ -f "/etc/netplan/99-xinas-client.yaml" ]]; then
            cat "/etc/netplan/99-xinas-client.yaml" | sed 's/^/  /'
        else
            echo "  Not configured"
        fi
        echo ""

        echo "ALL NETWORK INTERFACES"
        printf -- '-%.0s' {1..60}; echo ""
        ip -br addr 2>/dev/null | sed 's/^/  /'
        echo ""

        printf '=%.0s' {1..60}; echo ""
    } > "$out"

    whiptail --title "Network Configuration" --scrolltext --textbox "$out" 28 76
}

# Network settings menu
configure_network() {
    while true; do
        get_network_pool_settings

        local pool_status="DISABLED"
        [[ "$net_pool_enabled" == "true" ]] && pool_status="ENABLED"

        # Count high-speed interfaces
        local hs_count
        hs_count=$(detect_high_speed_interfaces | wc -w)

        local choice
        choice=$(whiptail --title "Network Settings" --menu "\
IP Pool: $net_pool_start - $net_pool_end [$pool_status]
High-speed interfaces detected: $hs_count

Configure storage network interfaces:" 18 65 6 \
            "1" "Configure IP Pool (automatic allocation)" \
            "2" "Configure Interfaces Manually" \
            "3" "Apply IP Pool Configuration" \
            "4" "View Current Configuration" \
            "5" "Back to Main Menu" \
            3>&1 1>&2 2>&3) || return

        case "$choice" in
            1) configure_network_ip_pool ;;
            2) configure_network_manual ;;
            3) apply_network_pool ;;
            4) view_network_config ;;
            5) return ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

main_menu() {
    show_welcome

    while true; do
        # Get quick status for menu
        local nfs_mounts
        nfs_mounts=$(mount -t nfs,nfs4 2>/dev/null | wc -l || echo "0")

        local rdma_status="No"
        [[ -d /sys/class/infiniband ]] && [[ -n "$(ls /sys/class/infiniband/ 2>/dev/null)" ]] && rdma_status="Yes"

        # Build update indicator
        local update_indicator=""
        [[ "$UPDATE_AVAILABLE" == "true" ]] && update_indicator=" | ${YELLOW}Update!${NC}"

        local choice
        choice=$(whiptail --title "═══ xiNAS Client Setup v$CLIENT_VERSION ═══" --menu "\
  $(hostname) | Mounts: $nfs_mounts | RDMA: $rdma_status
  ─────────────────────────────────────────────" 24 60 10 \
            "1" "📊 System Status" \
            "2" "🔌 Connect to NAS" \
            "3" "📁 Manage Mounts" \
            "4" "🌐 Network Settings" \
            "5" "🔧 Install NFS Tools" \
            "6" "⚡ Install DOCA OFED" \
            "7" "🔍 Test Connection" \
            "8" "🔄 Check for Updates" \
            "9" "🚪 Exit" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2) configure_nfs_mount ;;
            3) manage_mounts ;;
            4) configure_network ;;
            5) install_nfs_tools ;;
            6) install_doca_ofed ;;
            7) test_connection ;;
            8) check_and_update ;;
            9)
                whiptail --title "See you soon!" --msgbox "\
   Thank you for using xiNAS Client Setup!

   Run this menu again anytime:
     sudo ./client_setup.sh

   Questions? support@xinnor.io
" 12 50
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

case "${1:-}" in
    --version|-v)
        echo "xiNAS Client v$CLIENT_VERSION"
        # Show git commit if available
        _install_dir="/opt/xinas-client"
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR/.."
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR"
        if [[ -d "$_install_dir/.git" ]] && command -v git &>/dev/null; then
            _commit=$(git -C "$_install_dir" rev-parse --short HEAD 2>/dev/null)
            [[ -n "$_commit" ]] && echo "Commit: $_commit"
        fi
        exit 0
        ;;
    --update|-u)
        echo -e "${CYAN}Checking for updates...${NC}"
        _install_dir="/opt/xinas-client"
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR/.."
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR"
        if [[ ! -d "$_install_dir/.git" ]]; then
            echo -e "${RED}Error: Not a git installation${NC}"
            echo "Reinstall using: curl -fsSL https://xinnor.io/install_client.sh | sudo bash"
            exit 1
        fi
        git -C "$_install_dir" fetch --quiet origin main 2>/dev/null || {
            echo -e "${RED}Error: Could not fetch updates${NC}"
            exit 1
        }
        _local_commit=$(git -C "$_install_dir" rev-parse HEAD 2>/dev/null)
        _remote_commit=$(git -C "$_install_dir" rev-parse origin/main 2>/dev/null)
        if [[ "$_local_commit" == "$_remote_commit" ]]; then
            echo -e "${GREEN}Already up to date${NC}"
            exit 0
        fi
        echo -e "${YELLOW}Update available: ${_local_commit:0:8} -> ${_remote_commit:0:8}${NC}"
        git -C "$_install_dir" pull --quiet origin main 2>/dev/null && {
            echo -e "${GREEN}Updated successfully!${NC}"
            exit 0
        }
        echo -e "${RED}Update failed${NC}"
        exit 1
        ;;
    --status|-s)
        mount -t nfs,nfs4 2>/dev/null || echo "No NFS mounts"
        exit 0
        ;;
    --mount|-m)
        # Quick mount mode
        # Supports multiple IPs: SERVER1,SERVER2:SHARE MOUNTPOINT [rdma|tcp]
        shift
        if [[ $# -lt 2 ]]; then
            echo "Usage: $0 --mount SERVER:SHARE MOUNTPOINT [rdma|tcp]"
            echo "       $0 --mount SERVER1,SERVER2:SHARE MOUNTPOINT [rdma|tcp]"
            echo ""
            echo "Multiple IPs distribute 16 connections evenly:"
            echo "  1 IP  = nconnect=16"
            echo "  2 IPs = nconnect=8 each"
            echo "  4 IPs = nconnect=4 each"
            exit 1
        fi
        server_share="$1"
        mount_point="$2"
        proto="${3:-tcp}"

        # Parse server(s) and share path
        servers_part="${server_share%%:*}"
        share_path="${server_share#*:}"

        # Split servers by comma
        IFS=',' read -ra server_ips <<< "$servers_part"
        num_ips=${#server_ips[@]}

        # Validate number of IPs (must be power of 2, max 16)
        if [[ $num_ips -ne 1 && $num_ips -ne 2 && $num_ips -ne 4 && $num_ips -ne 8 && $num_ips -ne 16 ]]; then
            echo "Error: Number of IPs must be 1, 2, 4, 8, or 16"
            exit 1
        fi

        nconnect=$((16 / num_ips))

        if [[ "$proto" == "rdma" ]]; then
            opts="rdma,port=20049,nconnect=$nconnect,vers=4.2,sync"
        else
            opts="nconnect=$nconnect,vers=4.2,sync"
        fi

        exit_code=0
        for ((i=0; i<num_ips; i++)); do
            current_ip="${server_ips[$i]}"
            if [[ $num_ips -eq 1 ]]; then
                current_mount="$mount_point"
            else
                current_mount="$mount_point/$((i+1))"
            fi
            mkdir -p "$current_mount"
            echo "Mounting $current_ip:$share_path to $current_mount (nconnect=$nconnect)"
            if ! mount -t nfs -o "$opts" "$current_ip:$share_path" "$current_mount"; then
                echo "Failed to mount $current_ip"
                exit_code=1
            fi
        done
        exit $exit_code
        ;;
    --network-status|-n)
        echo -e "${CYAN}Network Configuration Status${NC}"
        echo ""
        if [[ -f "$NETWORK_CONFIG" ]]; then
            echo "Configuration file: $NETWORK_CONFIG"
            cat "$NETWORK_CONFIG"
        else
            echo "No network configuration file found."
        fi
        echo ""
        echo -e "${CYAN}High-Speed Interfaces:${NC}"
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}' || echo "no IP")
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                echo "  $name: $ip_addr (driver: $driver)"
            fi
        done
        exit 0
        ;;
    --help|-h)
        echo "xiNAS Client Setup v$CLIENT_VERSION"
        echo ""
        echo "Usage: sudo $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --status, -s              Show current NFS mounts"
        echo "  --mount, -m SERVER MOUNT  Quick mount (see examples below)"
        echo "  --network-status, -n      Show network configuration status"
        echo "  --version, -v             Show version information"
        echo "  --update, -u              Check for and install updates"
        echo "  --help, -h                Show this help"
        echo ""
        echo "Mount examples:"
        echo "  Single IP:    -m 10.10.1.1:/data /mnt/nas [tcp|rdma]"
        echo "  Multiple IPs: -m 10.10.1.1,10.10.1.2:/data /mnt/nas [tcp|rdma]"
        echo ""
        echo "Multiple IPs distribute 16 connections evenly across all addresses:"
        echo "  1 IP  = nconnect=16       4 IPs = nconnect=4 each"
        echo "  2 IPs = nconnect=8 each   8 IPs = nconnect=2 each"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    *)
        main_menu
        ;;
esac
