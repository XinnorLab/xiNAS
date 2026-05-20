#!/bin/bash
# xiNAS Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install.sh | sudo bash
#    or: wget -qO- https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install.sh | sudo bash

set -e

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Output helpers ─────────────────────────────────────────────────────────────
SEP="${DIM}     ──────────────────────────────────────────────────────${NC}"

step() {
    echo ""
    echo -e "  ${CYAN}${BOLD}▶ $1${NC}"
    echo -e "$SEP"
}
ok()   { echo -e "     ${GREEN}✓${NC}  $*"; }
info() { echo -e "     ${DIM}›${NC}  $*"; }
warn() { echo -e "     ${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "     ${RED}✗${NC}  $*"; }

# ── Quiet runner with spinner ─────────────────────────────────────────────────
# Output goes to $LOG_FILE; spinner shows the label until the command exits.
# On failure, the tail of the log is dumped so the user can see what happened.
LOG_FILE="${XINAS_LOG:-/tmp/xinas-install.log}"
: > "$LOG_FILE" 2>/dev/null || LOG_FILE="$(mktemp)"

_SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

run_quiet() {
    local label="$1"; shift
    local pid rc=0 i=0

    {
        printf '\n=== %s | %s ===\n' "$(date '+%H:%M:%S')" "$label"
        "$@"
    } >>"$LOG_FILE" 2>&1 &
    pid=$!

    tput civis 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
        printf '\r     %b%s%b  %s' "$CYAN" "${_SPIN[i % ${#_SPIN[@]}]}" "$NC" "$label"
        i=$((i + 1))
        sleep 0.1
    done
    tput cnorm 2>/dev/null || true

    wait "$pid" || rc=$?
    if [[ $rc -eq 0 ]]; then
        printf '\r     %b✓%b  %s\033[K\n' "$GREEN" "$NC" "$label"
    else
        printf '\r     %b✗%b  %s\033[K\n' "$RED" "$NC" "$label"
        echo ""
        echo -e "     ${RED}Failed — last 20 lines of ${LOG_FILE}:${NC}"
        tail -20 "$LOG_FILE" 2>/dev/null | sed 's/^/       /'
        return "$rc"
    fi
}

# ── Unattended (non-interactive) mode ─────────────────────────────────────────
# Set XINAS_UNATTENDED=1 to provision without any TTY prompts. Provisioning is
# driven by XINAS_PRESET / XINAS_LICENSE* and handed off to autoinstall.sh.
# See docs/Installer/spec.md section 7.
UNATTENDED="${XINAS_UNATTENDED:-0}"

# ── Banner ────────────────────────────────────────────────────────────────────
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
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${YELLOW}${BOLD}  High-Performance NAS Provisioning${NC}"
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Quick Start Guide ─────────────────────────────────────────────────────────
echo -e "  ${WHITE}───────────────────────────────────────────────────────${NC}"
echo -e "    ${CYAN}${BOLD}✨  Welcome to xiNAS — let's get you started!${NC}"
echo -e "  ${WHITE}───────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${WHITE}${BOLD}QUICK START GUIDE${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}①${NC}  ${WHITE}📊 Collect System Data${NC}"
echo -e "      ${DIM}Gather hardware info and generate your licensing key${NC}"
echo ""
echo -e "  ${YELLOW}${BOLD}②${NC}  ${WHITE}🔑 Obtain & Enter License${NC}  ${RED}${BOLD}★ Required${NC}"
echo -e "      ${DIM}Send hardware key to${NC} ${CYAN}support@xinnor.io${NC}"
echo -e "      ${DIM}then enter the received license in the menu${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}③${NC}  ${WHITE}🌐 Configure Network${NC}  ${DIM}(optional — skip for auto-detect)${NC}"
echo -e "      ${DIM}Set IP ranges and interfaces for your storage network${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}④${NC}  ${WHITE}🚀 Run Installation${NC}"
echo -e "      ${DIM}Select your profile and let the installer do the rest${NC}"
echo ""
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo -e "  ${DIM}💬 Questions?${NC}  ${CYAN}support@xinnor.io${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo ""

# ── Confirm ───────────────────────────────────────────────────────────────────
echo -e "  ${DIM}The installer will set up required packages${NC}"
echo -e "  ${DIM}(git, Ansible, yq) and launch the provisioning menu.${NC}"
echo ""
if [[ "$UNATTENDED" == "1" ]]; then
    info "Unattended mode — proceeding without confirmation"
else
    read -p "  Ready to proceed? [Y/n] " -n 1 -r </dev/tty
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo ""
        warn "Installation cancelled. Run this script again when ready."
        echo ""
        exit 0
    fi
fi

# ── Step 1: Requirements ──────────────────────────────────────────────────────
step "Checking requirements"

if [[ $EUID -ne 0 ]]; then
    fail "${RED}Must be run as root${NC}"
    echo ""
    echo -e "     Run:  ${CYAN}sudo bash <(curl -fsSL URL)${NC}"
    echo ""
    exit 1
fi
ok "Running as root"

if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    if [[ "$ID" != "ubuntu" ]]; then
        warn "xiNAS is designed for Ubuntu — detected: ${BOLD}$PRETTY_NAME${NC}"
        if [[ "$UNATTENDED" == "1" ]]; then
            warn "Unattended mode — continuing on unsupported OS"
        else
            read -p "     Continue anyway? [y/N] " -n 1 -r </dev/tty
            echo ""
            [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
        fi
    else
        ok "OS: ${BOLD}$PRETTY_NAME${NC}"
    fi
else
    warn "Could not detect OS version"
fi

# ── Step 1b: Root SSH access ──────────────────────────────────────────────────
step "Configuring root SSH access"

# Ubuntu cloud images (AWS/GCP/Azure) drop a cloud-init config that sets
# PermitRootLogin no. We override it with a lower-numbered drop-in so
# key-based root SSH works for the AI / MCP bridge.
_sshd_dropin="/etc/ssh/sshd_config.d/10-xinas-root-access.conf"
mkdir -p /etc/ssh/sshd_config.d
if [[ ! -f "$_sshd_dropin" ]]; then
    cat > "$_sshd_dropin" <<'SSHEOF'
# Managed by xiNAS installer
# Allows key-based root SSH login (for Claude Code MCP stdio transport)
# Password root login remains blocked by Ubuntu default policy
PermitRootLogin prohibit-password
SSHEOF
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    ok "Root SSH key-login enabled (password login stays blocked)"
else
    ok "Root SSH config already present"
fi

# Warn if root has no password — useful for console recovery and sudo auditing
_root_pw=$(passwd -S root 2>/dev/null | awk '{print $2}')
if [[ "$_root_pw" == "L" || "$_root_pw" == "NP" ]]; then
    warn "Root has no password set — run ${CYAN}xinas-menu${NC} → A → 4 to set one"
else
    ok "Root password is set"
fi

# ── Step 2: Repository ────────────────────────────────────────────────────────
INSTALL_DIR="/opt/xiNAS"
REPO_URL="https://github.com/XinnorLab/xiNAS.git"

step "Setting up repository"
info "Target: ${WHITE}${INSTALL_DIR}${NC}"

if ! command -v git &>/dev/null; then
    run_quiet "Installing git" bash -c 'apt-get update -qq && apt-get install -y -qq git'
else
    ok "git found"
fi

if [[ -d "$INSTALL_DIR" ]]; then
    cd "$INSTALL_DIR"
    run_quiet "Updating xiNAS repository at ${INSTALL_DIR}" \
        bash -c 'git fetch origin -q && git reset --hard origin/main -q'
else
    run_quiet "Cloning xiNAS repository to ${INSTALL_DIR}" \
        git clone -q "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

chmod +x ./*.sh 2>/dev/null || true

# ── Step 3: System preparation ────────────────────────────────────────────────
step "Preparing system"
info "Detailed log: ${WHITE}${LOG_FILE}${NC}"

XINAS_QUIET=1 XINAS_UNATTENDED="$UNATTENDED" XINAS_LOG="$LOG_FILE" ./prepare_system.sh

# ── Unattended provisioning ───────────────────────────────────────────────────
# prepare_system.sh installed the dependencies and (in unattended mode) skipped
# the interactive menu. Hand off to autoinstall.sh, which applies the preset and
# runs the playbook headlessly. autoinstall.sh reads its XINAS_* config from the
# environment this script already inherited.
if [[ "$UNATTENDED" == "1" ]]; then
    step "Running unattended provisioning"
    set +e
    ./autoinstall.sh
    rc=$?
    set -e
    exit "$rc"
fi

# ── Ensure xinas-menu wrapper exists ─────────────────────────────────────────
# The xinas_menu Ansible role creates this during full provisioning (site.yml).
# Bootstrap it here so the command works immediately, even if the user exited
# the provisioning menu early.
if [[ ! -x /usr/local/bin/xinas-menu ]]; then
    step "Setting up management console"
    run_quiet "Installing python3-venv" \
        bash -c 'apt-get install -y -qq python3-venv' || true
    if [[ ! -d "$INSTALL_DIR/venv/bin" ]]; then
        run_quiet "Creating Python virtualenv" python3 -m venv "$INSTALL_DIR/venv"
    fi
    run_quiet "Installing Textual TUI dependencies" \
        "$INSTALL_DIR/venv/bin/pip" install -q "textual>=0.70.0" "pyyaml>=6.0" || true

    cat > /usr/local/bin/xinas-menu <<WEOF
#!/bin/sh
# xiNAS Management Console wrapper
# Managed by xinas_menu Ansible role — do not edit manually
PYTHONPATH=$INSTALL_DIR \\
  exec $INSTALL_DIR/venv/bin/python -m xinas_menu "\$@"
WEOF
    chmod 755 /usr/local/bin/xinas-menu

    cat > /usr/local/bin/xinas-setup <<WEOF
#!/bin/sh
# xiNAS Setup (provisioning) wrapper
# Managed by xinas_menu Ansible role — do not edit manually
PYTHONPATH=$INSTALL_DIR \\
  exec $INSTALL_DIR/venv/bin/python -m xinas_menu --setup "\$@"
WEOF
    chmod 755 /usr/local/bin/xinas-setup
    ok "xinas-menu command installed"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
_W=55
_bar() { printf '═%.0s' $(seq 1 $_W); }
echo -e "  ${GREEN}$(_bar)${NC}"
echo -e "    ${GREEN}${BOLD}✓  xiNAS installed successfully!${NC}"
echo -e ""
echo -e "    ${DIM}Directory :${NC}  ${WHITE}${INSTALL_DIR}${NC}"
echo -e "    ${DIM}Management:${NC}  ${CYAN}sudo xinas-menu${NC}"
echo -e "  ${GREEN}$(_bar)${NC}"
echo ""
