#!/usr/bin/env bash
# xiNAS Client One-Shot Installer
# Usage: curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install_client.sh | sudo bash
#    or: wget -qO- https://github.com/XinnorLab/xiNAS/releases/latest/download/install_client.sh | sudo bash
#
# Installs/updates from published GitHub Releases only — never main/master.

set -euo pipefail

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
# xiNAS brand green (#83B449) — truecolor; degrades gracefully on 256-color terms
XGREEN='\033[38;2;131;180;73m'

# ── Output helpers ─────────────────────────────────────────────────────────────
SEP="${DIM}     ──────────────────────────────────────────────────────${NC}"

step() {
    local n="$1" total="$2" msg="$3"
    echo ""
    echo -e "  ${CYAN}${BOLD}▶ Step ${n} / ${total}${NC}  ${WHITE}${BOLD}${msg}${NC}"
    echo -e "$SEP"
}
ok()    { echo -e "     ${GREEN}✓${NC}  $*"; }
skip()  { echo -e "     ${DIM}–${NC}  $*"; }
info()  { echo -e "     ${DIM}›${NC}  $*"; }
warn()  { echo -e "     ${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "     ${RED}✗${NC}  $*"; }

REPO_URL="https://github.com/XinnorLab/xiNAS.git"
REPO_SLUG="XinnorLab/xiNAS"
INSTALL_DIR="/opt/xinas-client"

# A 401 from GitHub (stale root credentials, a credential helper, a proxy)
# otherwise makes git prompt for a username on /dev/tty. This installer is
# meant to run from `curl … | sudo bash` and across a client fleet, so the
# prompt would hang the run instead of failing it. See
# docs/Installer/update-spec.md "Non-interactive git access".
export GIT_TERMINAL_PROMPT=0

# ── GitHub access token ───────────────────────────────────────────────────────
# GitHub throttles *anonymous* requests per source IP — REST and git-over-HTTPS
# alike — so every host behind one NAT shares one quota, and a spent quota
# surfaces as a 401 on clone/fetch and a 403/429 on the API. A token moves the
# caller onto its own per-account quota. Resolution order: $XINAS_GH_TOKEN,
# $GITHUB_TOKEN, then the first line of /etc/xinas/github-token. The token is
# never printed and never placed in argv: curl reads it from stdin config, git
# from a credential helper that GitHub's 401 triggers (anonymous first).
# Canonical copy: lib/menu_lib.sh; docs/Installer/update-spec.md "GitHub rate
# limits and the access token"; tests/test_github_token_parity.py pins copies.
XINAS_GH_TOKEN_FILE="${XINAS_GH_TOKEN_FILE:-/etc/xinas/github-token}"

xinas_github_token() {
    local t="${XINAS_GH_TOKEN:-${GITHUB_TOKEN:-}}"
    if [[ -z "$t" && -r "$XINAS_GH_TOKEN_FILE" ]]; then
        t="$(head -n 1 "$XINAS_GH_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
    fi
    printf '%s' "$t"
}

xinas_gh_curl() {
    local t
    t="$(xinas_github_token)"
    if [[ -n "$t" ]]; then
        printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -K - "$@"
    else
        curl "$@"
    fi
}

xinas_gh_git() {
    local t
    t="$(xinas_github_token)"
    if [[ -n "$t" ]]; then
        XINAS_GH_TOKEN="$t" git -c credential.helper= \
            -c 'credential.helper=!f() { [ "$1" = get ] || exit 0; echo username=x-access-token; echo "password=$XINAS_GH_TOKEN"; }; f' \
            "$@"
    else
        git "$@"
    fi
}
# ── end GitHub access token ───────────────────────────────────────────────────

# xiNAS ships from published GitHub Releases only — never the main branch
# (see docs/Installer/update-spec.md). Resolve the latest release tag; print
# nothing on failure. Callers must NOT fall back to main.
xinas_latest_release_tag() {
    xinas_gh_curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/'
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${XGREEN}"
cat << 'EOF'

            ██╗███╗   ██╗ █████╗ ███████╗
            ╚═╝████╗  ██║██╔══██╗██╔════╝
    ███╗███╗██╗██╔██╗ ██║███████║███████╗
    ╚█████╔╝██║██║╚██╗██║██╔══██║╚════██║
    ███╔███╗██║██║ ╚████║██║  ██║███████║
    ╚══╝╚══╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝

EOF
echo -e "${NC}"
echo -e "  ${XGREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${YELLOW}${BOLD}  NFS Client Installer${NC}"
echo -e "  ${XGREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "${RED}Must be run as root${NC}"
    echo ""
    echo -e "     Run:  ${CYAN}curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install_client.sh | sudo bash${NC}"
    echo ""
    exit 1
fi

# ── Step 1: Requirements ──────────────────────────────────────────────────────
step 1 5 "Checking system requirements"

if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
    PKG_UPDATE="apt-get update -qq"
    PKG_INSTALL="apt-get install -y -qq"
elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
    PKG_UPDATE="dnf check-update || true"
    PKG_INSTALL="dnf install -y -q"
elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
    PKG_UPDATE="yum check-update || true"
    PKG_INSTALL="yum install -y -q"
else
    fail "Unsupported package manager"
    echo ""
    echo -e "     ${DIM}Supported: apt (Debian/Ubuntu), dnf/yum (RHEL/CentOS/Fedora)${NC}"
    echo ""
    exit 1
fi

ok "Package manager: ${WHITE}${BOLD}${PKG_MGR}${NC}"
ok "Running as root"

# ── Step 2: Dependencies ──────────────────────────────────────────────────────
step 2 5 "Installing dependencies"

info "Refreshing package index..."
$PKG_UPDATE >/dev/null 2>&1 || true

if ! command -v git &>/dev/null; then
    info "Installing git..."
    $PKG_INSTALL git >/dev/null 2>&1
    ok "git installed"
else
    skip "git already present"
fi

if ! command -v whiptail &>/dev/null; then
    info "Installing whiptail..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL whiptail >/dev/null 2>&1
    else
        $PKG_INSTALL newt >/dev/null 2>&1
    fi
    ok "whiptail installed"
else
    skip "whiptail already present"
fi

if ! command -v mount.nfs4 &>/dev/null; then
    info "Installing NFS tools..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL nfs-common >/dev/null 2>&1
    else
        $PKG_INSTALL nfs-utils >/dev/null 2>&1
    fi
    ok "nfs-common installed"
else
    skip "NFS tools already present"
fi

# ── Step 3: Client package ────────────────────────────────────────────────────
step 3 5 "Downloading xiNAS client"

RELEASE_TAG="$(xinas_latest_release_tag)"
if [[ -z "$RELEASE_TAG" ]]; then
    fail "Could not resolve the latest xiNAS GitHub Release."
    echo -e "     ${DIM}xiNAS installs from releases only — no fallback to main.${NC}"
    echo -e "     ${DIM}Check access to https://api.github.com and that a release exists.${NC}"
    exit 1
fi

if [[ -d "$INSTALL_DIR" ]]; then
    info "Existing installation found — updating to ${RELEASE_TAG}..."
    cd "$INSTALL_DIR"
    # RELEASE_TAG came from an unanchored grep/sed over the GitHub API
    # response (xinas_latest_release_tag, above); refuse anything that isn't
    # a semver release tag before calling git (docs/Installer/update-spec.md
    # "Tag validation before checkout"). install_client.sh can't source
    # lib/menu_lib.sh (standalone client installer), so this regex is a
    # character-identical copy of _is_release_tag in lib/menu_lib.sh / the
    # inline copy in install.sh.
    if [[ ! "$RELEASE_TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
        fail "Refusing to check out non-release ref: '${RELEASE_TAG}'"
        exit 1
    fi
    # The tree may be dirty by design; --force resets to the release tag,
    # never paired with git clean. Drop 2>/dev/null so a real git error
    # reaches the operator; --quiet already hides success chatter.
    if xinas_gh_git fetch --quiet origin --tags && git checkout --force --quiet "$RELEASE_TAG"; then
        ok "Client updated to ${RELEASE_TAG}"
    else
        fail "Failed to update client to ${RELEASE_TAG} (git fetch/checkout error)"
        exit 1
    fi
else
    info "Cloning repository (sparse — client only) at ${RELEASE_TAG}..."
    xinas_gh_git clone --quiet --branch "$RELEASE_TAG" --depth 1 --filter=blob:none --sparse "$REPO_URL" "$INSTALL_DIR" 2>/dev/null
    cd "$INSTALL_DIR"
    git sparse-checkout set client_repo 2>/dev/null
    ok "Client cloned to ${WHITE}${INSTALL_DIR}${NC}"
fi

if [[ ! -f "$INSTALL_DIR/client_repo/client_setup.sh" ]]; then
    fail "client_setup.sh not found — clone may have failed"
    exit 1
fi

chmod +x "$INSTALL_DIR/client_repo/client_setup.sh"

mkdir -p /usr/local/bin
ln -sf "$INSTALL_DIR/client_repo/client_setup.sh" /usr/local/bin/xinas-client
ok "Command registered: ${WHITE}${BOLD}xinas-client${NC}"

# ── Step 4: NFS tuning ────────────────────────────────────────────────────────
step 4 5 "Configuring NFS client"

if [[ ! -f /etc/modprobe.d/nfsclient.conf ]]; then
    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf
    ok "NFS performance tuning applied ${DIM}(max_session_slots=180)${NC}"
else
    skip "NFS tuning already configured"
fi

# ── Step 5: NFS-RDMA transport ────────────────────────────────────────────────
step 5 5 "Enabling NFS-RDMA transport"

enable_nfs_rdma_oneshot() {
    # Skip on TCP-only clients.
    if [[ ! -d /sys/class/infiniband ]] || ! ls /sys/class/infiniband/ 2>/dev/null | grep -q . ; then
        skip "RDMA hardware not present — skipping NFS-RDMA setup"
        return 0
    fi

    # Persist load-on-boot regardless of current load state.
    local persist=/etc/modules-load.d/xinas-nfs-rdma.conf
    if [[ ! -f "$persist" ]] || ! grep -qx rpcrdma "$persist" 2>/dev/null; then
        echo rpcrdma > "$persist"
    fi

    # Auto-apply the EXPORT_SYMBOL_GPL fix BEFORE the load-state branches —
    # otherwise a box that already has mlnx-nfsrdma-dkms installed and the
    # (buggy) rpcrdma module loaded short-circuits at the lsmod check below
    # and the patch never runs. The applier is idempotent and gates on
    # mlnx-nfsrdma-dkms being installed, so it's safe to call here even on
    # TCP-only / no-OFED systems (it exits 0 with "nothing to do").
    # See: docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
    local applier="${INSTALL_DIR}/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh"
    if [[ -x "$applier" ]]; then
        info "Checking for mlnx-nfsrdma GDS-hook export bug..."
        if "$applier" 2>&1 | sed 's/^/     /'; then
            ok "mlnx-nfsrdma GDS-hook check complete"
        else
            warn "mlnx-nfsrdma GDS-hook patch attempt failed — see output above"
        fi
    fi

    if lsmod 2>/dev/null | awk '{print $1}' | grep -qx rpcrdma; then
        skip "rpcrdma already loaded"
        return 0
    fi

    if modprobe rpcrdma 2>/dev/null; then
        ok "rpcrdma loaded ${DIM}(persisted in ${persist})${NC}"
        return 0
    fi

    # modprobe failed — most common cause is MLNX/DOCA-OFED ABI mismatch.
    local has_ofed=0
    if dpkg -l mlnx-ofed-kernel-dkms 2>/dev/null | awk '$1=="ii"{f=1} END{exit !f}'; then
        has_ofed=1
    elif command -v ofed_info &>/dev/null && ofed_info -s &>/dev/null; then
        has_ofed=1
    fi

    if [[ $has_ofed -eq 0 ]]; then
        local errline
        errline="$(dmesg 2>/dev/null | grep -E 'rpcrdma' | tail -1 || true)"
        warn "rpcrdma load failed; no MLNX/DOCA-OFED detected"
        [[ -n "$errline" ]] && info "${DIM}${errline}${NC}"
        info "TCP NFS mounts will still work"
        return 0
    fi

    if [[ "$PKG_MGR" != "apt" ]]; then
        warn "DOCA-OFED detected, but mlnx-nfsrdma-dkms is only installable via apt on this OS"
        info "TCP NFS mounts will still work"
        return 0
    fi

    if ! dpkg -l mlnx-nfsrdma-dkms 2>/dev/null | awk '$1=="ii"{f=1} END{exit !f}'; then
        info "DOCA-OFED detected — installing mlnx-nfsrdma-dkms..."
        if ! $PKG_INSTALL mlnx-nfsrdma-dkms >/dev/null 2>&1; then
            warn "mlnx-nfsrdma-dkms unavailable — check the DOCA-Host apt source"
            info "TCP NFS mounts will still work"
            return 0
        fi
        ok "mlnx-nfsrdma-dkms installed"
    else
        skip "mlnx-nfsrdma-dkms already installed"
    fi

    # Applier already ran at the top of enable_nfs_rdma_oneshot — it
    # handles the buggy-source detection + DKMS rebuild + reload (or "reboot
    # to activate") on every reachable code path.

    if command -v dkms &>/dev/null; then
        dkms autoinstall -k "$(uname -r)" >/dev/null 2>&1 || true
    fi

    if modprobe rpcrdma 2>/dev/null; then
        ok "rpcrdma loaded ${DIM}(DKMS build matches OFED ABI; persisted in ${persist})${NC}"
        return 0
    fi

    local errline
    errline="$(dmesg 2>/dev/null | grep -E 'rpcrdma' | tail -1 || true)"
    warn "rpcrdma still cannot be loaded after DKMS rebuild"
    [[ -n "$errline" ]] && info "${DIM}${errline}${NC}"
    info "TCP NFS mounts will still work"
    return 0
}

enable_nfs_rdma_oneshot

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}${BOLD}✓  xiNAS client installed successfully!${NC}"
echo ""
echo -e "  ${DIM}Directory :${NC}  ${WHITE}${INSTALL_DIR}${NC}"
echo -e "  ${DIM}Command   :${NC}  ${CYAN}sudo xinas-client${NC}"
echo -e "  ${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# ── Launch wizard ─────────────────────────────────────────────────────────────
if [[ -t 0 ]]; then
    echo -e "  ${YELLOW}Launch client setup now? [Y/n]${NC} "
    read -r -n 1 answer
    echo ""
    if [[ ! "${answer:-}" =~ ^[Nn]$ ]]; then
        exec "$INSTALL_DIR/client_repo/client_setup.sh"
    fi
else
    echo -e "     ${DIM}Run${NC} ${CYAN}sudo xinas-client${NC} ${DIM}to start the setup wizard${NC}"
    echo ""
fi
