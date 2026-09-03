#!/bin/bash
# xiNAS Installation Script
# Usage: curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo bash
#    or: wget -qO- https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo bash
#
# xiNAS installs and updates ONLY from published GitHub Releases — never
# from the main/master branch. See docs/Installer/update-spec.md.

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
# xiNAS brand green (#83B449) — truecolor; degrades gracefully on 256-color terms
XGREEN='\033[38;2;131;180;73m'

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
echo -e "  ${YELLOW}${BOLD}  High-Performance NAS Provisioning${NC}"
echo -e "  ${XGREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
REPO_SLUG="XinnorLab/xiNAS"

# Never let git fall back to an interactive credential prompt. GitHub answers
# a fetch/clone it will not serve with 401, and git's reflex is to ask
# `Username for 'https://github.com':` on /dev/tty — which run_quiet cannot
# intercept (it redirects stdout/stderr into the log and backgrounds the
# command), so the prompt lands unattributed over the spinner and the install
# blocks forever on a read no operator is watching for. Mirrors
# collection/roles/xinas_menu/files/xinas-update-git; see
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

# Where the token in use came from, for messages that must name the source
# and never the value. Prints nothing when no token is configured.
xinas_github_token_source() {
    if [[ -n "${XINAS_GH_TOKEN:-}" ]]; then
        printf 'XINAS_GH_TOKEN'
    elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
        printf 'GITHUB_TOKEN'
    elif [[ -n "$(xinas_github_token)" ]]; then
        printf '%s' "$XINAS_GH_TOKEN_FILE"
    fi
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

# Keep an environment-supplied token at $1 (mode 0600) for the day-2 surfaces,
# which run after sudo has stripped the environment. Call this only AFTER
# GitHub has accepted the token — a mistyped one must never be kept. No-op
# without an environment token. An existing directory keeps its mode; the
# file is written through a 0600 temp file, so it is never world-readable,
# not even briefly.
xinas_persist_github_token() {
    local dest="$1" tok="${XINAS_GH_TOKEN:-${GITHUB_TOKEN:-}}" tmp
    [[ -n "$tok" ]] || return 0
    [[ -d "$(dirname "$dest")" ]] || install -d -m 0755 "$(dirname "$dest")"
    tmp="$(mktemp "${dest}.XXXXXX")" || return 1
    printf '%s\n' "$tok" > "$tmp" && chmod 0600 "$tmp" && mv -f "$tmp" "$dest"
}

# Explain a failed /releases/latest lookup for $1 (owner/repo) in plain text on
# stdout: probes the HTTP status once and names the cause — a rejected token
# (401), GitHub's rate limit (403/429), or no connection at all.
xinas_gh_explain_release_lookup_failure() {
    local code src
    code="$(xinas_gh_curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code}' \
        "https://api.github.com/repos/${1}/releases/latest" 2>/dev/null || true)"
    src="$(xinas_github_token_source)"
    case "$code" in
        401)
            printf 'GitHub rejected the token from %s (HTTP 401). Fix or remove it.\n' \
                "${src:-the environment}"
            ;;
        403|429)
            if [[ -n "$src" ]]; then
                printf "GitHub's rate limit refused the request (HTTP %s): the quota of the token from %s is spent. Wait for the reset or use another token.\n" \
                    "$code" "$src"
            else
                printf "GitHub's rate limit refused the request (HTTP %s): anonymous requests from this public address share one quota. Use a GitHub token (XINAS_GH_TOKEN or %s).\n" \
                    "$code" "$XINAS_GH_TOKEN_FILE"
            fi
            ;;
        000|"")
            printf 'No connection to https://api.github.com.\n'
            ;;
        *)
            printf 'https://api.github.com answered HTTP %s.\n' "$code"
            ;;
    esac
}
# ── end GitHub access token ───────────────────────────────────────────────────


# How to hand a token to the installer without exposing it: typed into a
# variable (not echoed, not in shell history) and preserved by NAME across
# sudo. `sudo XINAS_GH_TOKEN=<token> bash` would keep the value in sudo's own
# argv for the whole run (visible in ps) and write it to sudo's log (the ENV=
# field, sudoers(5) LOG FORMAT). See update-spec.md "Handing over the token".
token_howto_hint() {
    echo -e "     Lift the limit with a GitHub token (a fine-grained personal access"
    echo -e "     token with no permissions is enough); the installer keeps it in"
    echo -e "     ${WHITE}${XINAS_GH_TOKEN_FILE}${NC} for the update checks that follow:"
    echo -e "       ${CYAN}read -rs XINAS_GH_TOKEN && export XINAS_GH_TOKEN${NC}"
    echo -e "       ${CYAN}curl -fsSL https://github.com/${REPO_SLUG}/releases/latest/download/install.sh | sudo --preserve-env=XINAS_GH_TOKEN bash${NC}"
}

# Printed when GitHub refuses the clone/fetch of a repository that is public
# and whose release tag we just resolved — so the request itself was turned
# away (update-spec.md "Naming the authentication failure"). The usual cause
# is GitHub's per-IP limit on anonymous requests: every install, update check
# and clone from one public address shares one quota, and a spent quota comes
# back as 401.
git_access_hint() {
    echo ""
    fail "GitHub refused git access to ${CYAN}https://github.com/${REPO_SLUG}${NC}."
    echo ""
    echo -e "     The repository is public, so this is GitHub's per-IP rate limit on"
    echo -e "     anonymous requests (many installs, update checks or clones from one"
    echo -e "     public address — a lab or office NAT) or, less often, this host."
    echo ""
    token_howto_hint
    echo ""
    echo -e "     Host-side causes worth ruling out:"
    echo -e "       ${DIM}•${NC} an HTTP proxy in root's environment (${WHITE}https_proxy${NC})"
    echo -e "       ${DIM}•${NC} an ${WHITE}insteadOf${NC} rewrite or credential helper —"
    echo -e "         ${CYAN}git config --list --show-origin | grep -Ei 'credential|insteadof|proxy'${NC}"
    echo ""
    echo -e "     Reproduce the failure directly:"
    echo -e "       ${CYAN}sudo env GIT_TERMINAL_PROMPT=0 git ls-remote ${REPO_URL}${NC}"
    echo ""
}

# Console wrapper paths. Kept in step with the xinas_menu role's
# xinas_menu_wrapper_path / xinas_setup_wrapper_path defaults — the role owns
# these files during provisioning; the block near the end of this script only
# bootstraps them when provisioning did not write them itself.
MENU_WRAPPER="/usr/local/bin/xinas-menu"
SETUP_WRAPPER="/usr/local/bin/xinas-setup"

# Resolve the latest PUBLISHED GitHub Release tag (vX.Y.Z). Prints the tag
# on success, nothing on failure. xiNAS installs from releases only — this
# helper never returns a branch name, and callers must NOT fall back to main.
xinas_latest_release_tag() {
    xinas_gh_curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/'
}

step "Setting up repository"
info "Target: ${WHITE}${INSTALL_DIR}${NC}"

if ! command -v git &>/dev/null; then
    run_quiet "Installing git" bash -c 'apt-get update -qq && apt-get install -y -qq git'
else
    ok "git found"
fi

RELEASE_TAG="$(xinas_latest_release_tag)"
if [[ -z "$RELEASE_TAG" ]]; then
    fail "Could not resolve the latest xiNAS GitHub Release."
    echo ""
    # One status probe names the cause: a rejected token, GitHub's per-IP
    # rate limit, or no connection (update-spec.md "Naming the failure").
    _why="$(xinas_gh_explain_release_lookup_failure "$REPO_SLUG")"
    echo -e "     ${_why}"
    echo ""
    if [[ "$_why" == *"rate limit"* && -z "$(xinas_github_token_source)" ]]; then
        token_howto_hint
        echo ""
    fi
    echo -e "     xiNAS installs only from published releases — no fallback to ${BOLD}main${NC}."
    echo -e "     Releases: ${CYAN}https://github.com/${REPO_SLUG}/releases${NC}"
    echo ""
    exit 1
fi
ok "Latest release: ${BOLD}${RELEASE_TAG}${NC}"

# GitHub accepted that request with the token this run was given, so the
# token is worth keeping for the day-2 surfaces (xinas-menu's update check,
# the xinas-update-git sudo helper), which run after sudo has stripped the
# environment. Persisting before the lookup would keep a mistyped token and
# poison every later run — nothing in xiNAS removes the file.
if [[ -n "${XINAS_GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
    xinas_persist_github_token "$XINAS_GH_TOKEN_FILE"
    ok "GitHub token from $(xinas_github_token_source) saved to ${WHITE}${XINAS_GH_TOKEN_FILE}${NC} (0600)"
elif [[ -n "$(xinas_github_token)" ]]; then
    info "Using GitHub token from ${WHITE}${XINAS_GH_TOKEN_FILE}${NC}"
fi

# Refuse anything that is not a semver release tag before it ever reaches
# `git checkout`/`git clone --branch` (WS3 T5c). install.sh runs standalone
# and cannot `source lib/menu_lib.sh` — that file lives inside the repo
# being cloned/updated — so this is an inline, character-identical copy of
# the canonical regex in lib/menu_lib.sh's _is_release_tag() and
# collection/roles/xinas_menu/files/xinas-update-git. Keep all three in
# sync if the contract ever changes. RELEASE_TAG comes from an unanchored
# `grep -o | sed` over the GitHub API response (xinas_latest_release_tag,
# above) — good enough to find the field, not enough to prove it is a
# release tag rather than a branch name or arbitrary text.
if [[ ! "$RELEASE_TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "Refusing to check out non-release ref: '${RELEASE_TAG}'."
    echo ""
    echo -e "     xiNAS installs only from published releases — no fallback to ${BOLD}main${NC}."
    echo ""
    exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
    cd "$INSTALL_DIR"
    # The installed tree is git-dirty by design (presets are copied over
    # tracked role defaults/playbooks/site.yml), so a plain checkout aborts
    # with "local changes would be overwritten". --force discards changes to
    # *tracked* files only and is never paired with `git clean` (mirrors
    # xinas-update-git; see docs/Installer/update-spec.md "Reset-to-release").
    # RELEASE_TAG is passed as a single argv element to `git` directly — no
    # shell ever re-parses it, so there is nothing for a quote/semicolon in
    # the tag to break out of (the historical bug here was a nested
    # `bash -c "... '${RELEASE_TAG}' ..."` that built a second shell's
    # command string out of the tag; removing that second shell removes the
    # injection).
    run_quiet "Fetching xiNAS release tags" \
        xinas_gh_git fetch origin --tags -q || { git_access_hint; exit 1; }
    run_quiet "Updating xiNAS to ${RELEASE_TAG} at ${INSTALL_DIR}" \
        git checkout --force -q "$RELEASE_TAG"
else
    run_quiet "Cloning xiNAS ${RELEASE_TAG} to ${INSTALL_DIR}" \
        xinas_gh_git clone -q --branch "$RELEASE_TAG" "$REPO_URL" "$INSTALL_DIR" \
        || { git_access_hint; exit 1; }
    cd "$INSTALL_DIR"
fi

chmod +x ./*.sh 2>/dev/null || true

# ── Step 3: System preparation ────────────────────────────────────────────────
step "Preparing system"
info "Detailed log: ${WHITE}${LOG_FILE}${NC}"

set +e
XINAS_QUIET=1 XINAS_UNATTENDED="$UNATTENDED" XINAS_LOG="$LOG_FILE" ./prepare_system.sh
prep_rc=$?
set -e
# Status 2 is the setup menu's "operator chose Exit" — a clean abort with no
# playbook run behind it, not a failure (docs/Installer/spec.md §2.7). It is
# handled after this guard; every other non-zero status is a real failure.
if [[ $prep_rc -ne 0 && $prep_rc -ne 2 ]]; then
    fail "System preparation failed (exit ${prep_rc}) — see ${LOG_FILE}"
    exit "$prep_rc"
fi

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

# ── Setup exited without provisioning ────────────────────────────────────────
# The operator left the setup menu before any playbook ran, so the host is
# untouched: no xiRAID, no arrays, no filesystems, no exports. Installing the
# management console here would put `xinas-menu` on a machine it has nothing
# to manage, and the success banner below would assert an install that never
# happened. Report what actually occurred and stop — cleanly, exit 0, because
# leaving the menu is a legitimate choice and not an error
# (docs/Installer/spec.md §2.7).
if [[ $prep_rc -eq 2 ]]; then
    echo ""
    _W=55
    _bar() { printf '─%.0s' $(seq 1 $_W); }
    echo -e "  ${YELLOW}$(_bar)${NC}"
    echo -e "    ${YELLOW}${BOLD}Setup exited — xiNAS was not provisioned.${NC}"
    echo -e ""
    echo -e "    ${DIM}No playbook ran, so nothing on this host was changed,${NC}"
    echo -e "    ${DIM}and the management console was not installed.${NC}"
    echo -e ""
    echo -e "    ${DIM}Files staged in :${NC}  ${WHITE}${INSTALL_DIR}${NC}"
    echo -e "    ${DIM}Resume setup    :${NC}  ${CYAN}sudo ${INSTALL_DIR}/install.sh${NC}"
    echo -e "  ${YELLOW}$(_bar)${NC}"
    echo ""
    exit 0
fi

# ── Ensure xinas-menu wrapper exists ─────────────────────────────────────────
# Only reached once provisioning completed (prep_rc == 0). The xinas_menu
# Ansible role writes both wrappers during a full site.yml run, so this block
# is normally a no-op; it is the safety net for a preset whose playbook.yml
# leaves the role out.
if [[ ! -x "$MENU_WRAPPER" ]]; then
    step "Setting up management console"
    run_quiet "Installing python3-venv" \
        bash -c 'apt-get install -y -qq python3-venv' || true
    if [[ ! -d "$INSTALL_DIR/venv/bin" ]]; then
        run_quiet "Creating Python virtualenv" python3 -m venv "$INSTALL_DIR/venv"
    fi
    run_quiet "Installing Textual TUI dependencies" \
        "$INSTALL_DIR/venv/bin/pip" install -q "textual>=8.2.8,<8.3" "pyyaml>=6.0" || true

    cat > "$MENU_WRAPPER" <<WEOF
#!/bin/sh
# xiNAS Management Console wrapper
# Managed by xinas_menu Ansible role — do not edit manually
PYTHONPATH=$INSTALL_DIR \\
  exec $INSTALL_DIR/venv/bin/python -m xinas_menu "\$@"
WEOF
    chmod 755 "$MENU_WRAPPER"

    cat > "$SETUP_WRAPPER" <<WEOF
#!/bin/sh
# xiNAS Setup (provisioning) wrapper
# Managed by xinas_menu Ansible role — do not edit manually
PYTHONPATH=$INSTALL_DIR \\
  exec $INSTALL_DIR/venv/bin/python -m xinas_menu --setup "\$@"
WEOF
    chmod 755 "$SETUP_WRAPPER"
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
