#!/bin/bash
# xiNAS Uninstall Script
# Removes xiNAS from this host. See docs/Installer/uninstall-spec.md for
# the full behavior contract.

set -u

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

# ── Defaults ──────────────────────────────────────────────────────────────────
REMOVE_XIRAID="false"
REMOVE_OFED="false"
REVERT_PERF="false"
SKIP_GATE="false"
DRY_RUN="false"
INTERACTIVE="true"

INSTALL_DIR="${XINAS_INSTALL_DIR:-/opt/xiNAS}"
PLAYBOOK="${INSTALL_DIR}/playbooks/uninstall.yml"
SUMMARY_PATH="/tmp/xinas-uninstall-summary.json"

# Track which flags were given so explicit-yes overrides the prompt
FLAG_XIRAID_GIVEN="false"
FLAG_OFED_GIVEN="false"
FLAG_PERF_GIVEN="false"

usage() {
    cat <<EOF
xiNAS uninstaller

Usage: sudo $0 [options]

Options:
  --remove-xiraid         Also remove the xiRAID package, repo, and DKMS module.
  --remove-ofed           Also remove Mellanox DOCA-Host / OFED.
  --revert-perf-tuning    Also revert OS performance tunings applied by xiNAS.
  -y, --yes               Skip the typed-hostname confirmation gate. Optional
                          removals still require their own --remove-* flag.
  --dry-run               Run with ansible --check; no changes applied.
  -h, --help              Show this message.

Interactive mode (no flags) is the default: you will be asked the three
"remove this shared component too?" questions, all defaulting to NO, and
then asked to type this host's hostname to confirm.
EOF
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --remove-xiraid)        REMOVE_XIRAID="true";        FLAG_XIRAID_GIVEN="true" ;;
        --remove-ofed)          REMOVE_OFED="true";          FLAG_OFED_GIVEN="true"   ;;
        --revert-perf-tuning)   REVERT_PERF="true";          FLAG_PERF_GIVEN="true"   ;;
        -y|--yes)               SKIP_GATE="true" ;;
        --dry-run)              DRY_RUN="true" ;;
        -h|--help)              usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
done

# Any explicit --remove-* flag implies non-interactive answers for that
# question; the other questions still get prompted unless --yes is set.
if [[ "$FLAG_XIRAID_GIVEN" == "true" || "$FLAG_OFED_GIVEN" == "true" || "$FLAG_PERF_GIVEN" == "true" || "$SKIP_GATE" == "true" ]]; then
    INTERACTIVE="false"
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
fail() { echo -e "  ${RED}✗${NC} $*"; }
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
info() { echo -e "  ${DIM}›${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }

ask_yes_no() {
    # ask_yes_no "Question text"  → echoes "true" or "false" (default false)
    local prompt="$1"
    local reply
    read -r -p "  $prompt [y/N] " reply </dev/tty
    if [[ "$reply" =~ ^[Yy]$ ]]; then
        echo "true"
    else
        echo "false"
    fi
}

# ── Preflight ─────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "Must run as root."
    echo "    Re-run: ${CYAN}sudo $0${NC}"
    exit 1
fi

if [[ ! -f "$PLAYBOOK" ]]; then
    fail "Playbook not found at ${PLAYBOOK}."
    echo "    Make sure xiNAS is checked out at ${INSTALL_DIR} (or set XINAS_INSTALL_DIR)."
    exit 1
fi

if ! command -v ansible-playbook >/dev/null 2>&1; then
    fail "ansible-playbook not on PATH."
    echo "    Install Ansible first, then re-run the uninstaller."
    exit 1
fi

HOSTNAME_FILE=/etc/hostname
HOSTNAME_VALUE="$(cat "$HOSTNAME_FILE" 2>/dev/null || hostname)"

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BLUE}"
cat <<'EOF'

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
echo -e "${NC}"
echo -e "  ${RED}${BOLD}   xiNAS uninstall${NC}"
echo -e "  ${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Interactive questions ─────────────────────────────────────────────────────
if [[ "$INTERACTIVE" == "true" ]]; then
    echo -e "  ${WHITE}${BOLD}This will remove xiNAS from this host.${NC}"
    echo ""
    echo -e "  ${DIM}Three optional questions follow.${NC}"
    echo -e "  ${DIM}Each defaults to NO; press Enter to keep the component.${NC}"
    echo ""

    if [[ "$FLAG_XIRAID_GIVEN" != "true" ]]; then
        REMOVE_XIRAID="$(ask_yes_no "Do you want to remove the xiRAID package from this system?")"
    fi
    if [[ "$FLAG_OFED_GIVEN" != "true" ]]; then
        REMOVE_OFED="$(ask_yes_no "Do you want to remove Mellanox OFED from this system?")"
    fi
    if [[ "$FLAG_PERF_GIVEN" != "true" ]]; then
        REVERT_PERF="$(ask_yes_no "Do you want to remove OS-level performance optimizations applied by xiNAS?")"
    fi
    echo ""
fi

# ── Confirmation banner ───────────────────────────────────────────────────────
echo -e "  ${RED}${BOLD}╭───────────────────────────────────────────────────────────╮${NC}"
echo -e "  ${RED}${BOLD}│  DESTRUCTIVE ACTION                                       │${NC}"
echo -e "  ${RED}${BOLD}╰───────────────────────────────────────────────────────────╯${NC}"
echo ""
echo -e "  Mandatory cleanup includes:"
echo -e "    ${DIM}-${NC} Stopping and removing xiNAS MCP and NFS-helper services"
echo -e "    ${DIM}-${NC} Removing NFS exports created by xiNAS"
echo -e "    ${DIM}-${NC} Unmounting and removing xiRAID Classic arrays + XFS filesystems"
echo -e "      ${RED}(THIS DESTROYS THE DATA ON /mnt/data AND ANY OTHER xiNAS-MANAGED MOUNT)${NC}"
echo -e "    ${DIM}-${NC} Removing ${WHITE}${INSTALL_DIR}${NC} and xiNAS state under /var/lib/xinas, /var/log/xinas"
echo -e "    ${DIM}-${NC} Removing xiNAS systemd units, wrappers, sudoers, and motd hooks"
echo ""
echo -e "  Optional removals (your answers):"
printf "    %s Remove xiRAID:            ${BOLD}%s${NC}\n" "${DIM}·${NC}" "$REMOVE_XIRAID"
printf "    %s Remove Mellanox OFED:     ${BOLD}%s${NC}\n" "${DIM}·${NC}" "$REMOVE_OFED"
printf "    %s Revert OS perf tuning:    ${BOLD}%s${NC}\n" "${DIM}·${NC}" "$REVERT_PERF"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    warn "Dry-run mode: ansible will run with --check; no changes will be applied."
    echo ""
fi

# ── Confirmation gate ─────────────────────────────────────────────────────────
if [[ "$SKIP_GATE" != "true" ]]; then
    echo -e "  To proceed, type this host's hostname (${BOLD}${HOSTNAME_VALUE}${NC}):"
    read -r -p "  > " typed </dev/tty
    if [[ "$typed" != "$HOSTNAME_VALUE" ]]; then
        echo ""
        warn "Hostname did not match. No changes made."
        exit 2
    fi
fi

# ── Run the playbook ──────────────────────────────────────────────────────────
echo ""
info "Running ansible-playbook…"
echo ""

ANSIBLE_ARGS=(
    "$PLAYBOOK"
    -i "${INSTALL_DIR}/inventories/lab.ini"
    -e "uninstall_confirmed=true"
    -e "uninstall_remove_xiraid=${REMOVE_XIRAID}"
    -e "uninstall_remove_ofed=${REMOVE_OFED}"
    -e "uninstall_revert_perf=${REVERT_PERF}"
)

if [[ "$DRY_RUN" == "true" ]]; then
    ANSIBLE_ARGS+=(--check --diff)
fi

# Some uninstall paths remove /opt/xiNAS while ansible is reading the
# playbook tree. cd to /tmp first so ansible-playbook doesn't lose its CWD.
cd /tmp

if ! (cd "$INSTALL_DIR" && ansible-playbook "${ANSIBLE_ARGS[@]}"); then
    echo ""
    fail "Ansible playbook failed. xiNAS state may be partially removed."
    echo "    Re-run this script to retry the remaining steps (it is idempotent)."
    exit 1
fi

# Remove the install dir LAST, from here rather than inside the playbook:
# ansible cannot delete the playbook/role tree it is executing from without
# throwing "FileNotFoundError: ${INSTALL_DIR}/playbooks" and failing the run.
# We are already cd'd to /tmp (above), so this is safe.
rm -rf "$INSTALL_DIR"

# ── Render the final summary ──────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}${BOLD}  xiNAS uninstall complete${NC}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ ! -f "$SUMMARY_PATH" ]]; then
    warn "No summary at ${SUMMARY_PATH} — the playbook may have exited early."
    exit 0
fi

# Use python3 to pretty-print the JSON. Python3 ships with Ubuntu and is
# present even after we have torn down /opt/xiNAS/venv.
python3 - "$SUMMARY_PATH" <<'PY'
import json, sys

DIM   = "\033[2m"
BOLD  = "\033[1m"
GREEN = "\033[0;32m"
RED   = "\033[0;31m"
YELL  = "\033[1;33m"
CYAN  = "\033[0;36m"
WHITE = "\033[1;37m"
NC    = "\033[0m"

def section(title, color=WHITE):
    print(f"  {color}{BOLD}{title}{NC}")

def rows(items, marker, color):
    if not items:
        print(f"    {DIM}(none){NC}")
        return
    for entry in items:
        if isinstance(entry, list) and len(entry) == 2:
            head, body = entry
            print(f"    {color}{marker}{NC}  {WHITE}{head}{NC}: {body}")
        else:
            print(f"    {color}{marker}{NC}  {entry}")

with open(sys.argv[1]) as fh:
    s = json.load(fh)

section("Removed", GREEN)
rows(s.get("removed", []), "✓", GREEN)
print()

section("Preserved")
rows(s.get("preserved", []), "·", DIM)
print()

section("Failed", RED)
rows(s.get("failed", []), "✗", RED)
print()

section("Manual follow-up", YELL)
rows(s.get("manual", []), "→", YELL)
print()

reboot = bool(s.get("reboot", False))
flag = f"{YELL}{BOLD}yes{NC}" if reboot else f"{GREEN}no{NC}"
print(f"  {WHITE}{BOLD}Reboot recommended:{NC} {flag}")
PY

echo ""
info "Persistent log: /var/log/xinas-uninstall-*.log"
echo ""
exit 0
