#!/bin/bash
# Prepare system for xiNAS installation
# Uses colored console menus
set -e

usage() {
    echo "Usage: $0 [-e] [-u]" >&2
    echo "  -e  Expert mode with full startup menu" >&2
    echo "  -u  Update repository and exit" >&2
    echo "  -h  Show this help message" >&2
}

EXPERT=0
UPDATE_ONLY=0
while getopts "ehu" opt; do
    case $opt in
        e) EXPERT=1 ;;
        u) UPDATE_ONLY=1 ;;
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Quiet mode (set by install.sh) hides verbose package output behind a spinner.
QUIET_MODE="${XINAS_QUIET:-0}"
LOG_FILE="${XINAS_LOG:-/tmp/xinas-install.log}"
_SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

run_quiet() {
    local label="$1"; shift
    if [ "$QUIET_MODE" != "1" ]; then
        echo -e "${YELLOW}${label}...${NC}"
        "$@"
        return $?
    fi
    local pid rc=0 i=0
    {
        printf '\n=== %s | %s ===\n' "$(date '+%H:%M:%S')" "$label"
        "$@"
    } >>"$LOG_FILE" 2>&1 &
    pid=$!
    tput civis 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
        printf '\r     \033[0;36m%s\033[0m  %s' "${_SPIN[i % ${#_SPIN[@]}]}" "$label"
        i=$((i + 1))
        sleep 0.1
    done
    tput cnorm 2>/dev/null || true
    wait "$pid" || rc=$?
    if [ "$rc" -eq 0 ]; then
        printf '\r     \033[0;32m✓\033[0m  %s\033[K\n' "$label"
    else
        printf '\r     \033[0;31m✗\033[0m  %s\033[K\n' "$label"
        echo ""
        echo "     Failed — last 20 lines of $LOG_FILE:"
        tail -20 "$LOG_FILE" 2>/dev/null | sed 's/^/       /'
        return "$rc"
    fi
}

# xiNAS installs and updates ONLY from published GitHub Releases — never
# from the main/master branch. See docs/Installer/update-spec.md.
REPO_SLUG="XinnorLab/xiNAS"

# Resolve the latest PUBLISHED GitHub Release tag (vX.Y.Z). Prints the tag
# on success, nothing on failure. Never returns a branch name; callers must
# NOT fall back to main.
xinas_latest_release_tag() {
    curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/'
}

# Fetch tags and check out the latest release tag in the cwd repo. Returns
# non-zero (without touching the working tree's branch) if no release
# resolves — deliberately no main fallback.
xinas_update_to_latest_release() {
    local tag
    tag="$(xinas_latest_release_tag)"
    if [ -z "$tag" ]; then
        echo -e "${RED}Could not resolve the latest xiNAS GitHub Release.${NC}" >&2
        echo -e "${RED}xiNAS updates from releases only — no fallback to main.${NC}" >&2
        return 1
    fi
    # tag came from an unanchored `grep -o | sed` over the GitHub API
    # response (xinas_latest_release_tag, above) — refuse anything that
    # isn't a semver release tag before ever calling git (WS3 T5c;
    # _is_release_tag is sourced from lib/menu_lib.sh, see the early
    # `source` below).
    if ! _is_release_tag "$tag"; then
        echo -e "${RED}Refusing to check out non-release ref: '${tag}'.${NC}" >&2
        echo -e "${RED}xiNAS updates from releases only — no fallback to main.${NC}" >&2
        return 1
    fi
    git fetch origin --tags --quiet
    # The installed tree is git-dirty by design (presets are copied over
    # tracked role defaults/playbooks/site.yml), so a plain checkout aborts
    # with "local changes would be overwritten". --force discards changes
    # to *tracked* files only and is never paired with `git clean` (mirrors
    # xinas-update-git; see docs/Installer/update-spec.md "Reset-to-release").
    git checkout --force --quiet "$tag"
    echo "$tag"
}

if [ "$QUIET_MODE" != "1" ]; then
    echo -e "${CYAN}xiNAS System Preparation${NC}"
    echo ""
fi

# Install required packages unless only updating the repository
if [ "$UPDATE_ONLY" -eq 0 ]; then
    run_quiet "Updating package lists" sudo apt-get update -y -qq
    run_quiet "Installing dependencies (ansible, git, dialog, wget, btop)" \
        sudo apt-get install -y -qq ansible git dialog wget btop
    # Install yq v4 for YAML processing used by configuration scripts
    run_quiet "Installing yq (YAML processor)" bash -c '
        sudo wget -qO /usr/local/bin/yq \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
        && sudo chmod +x /usr/local/bin/yq'
    [ "$QUIET_MODE" != "1" ] && echo -e "${GREEN}Packages installed successfully${NC}"
fi

REPO_URL="https://github.com/XinnorLab/xiNAS/"
REPO_DIR="xiNAS"

# Determine if repo already exists in current directory
if [ -f "ansible.cfg" ] && [ -d "playbooks" ]; then
    REPO_DIR="$(pwd)"
else
    if [ ! -d "$REPO_DIR" ]; then
        _tag="$(xinas_latest_release_tag)"
        if [ -z "$_tag" ]; then
            echo -e "${RED}Could not resolve the latest xiNAS GitHub Release.${NC}" >&2
            echo -e "${RED}xiNAS installs from releases only — no fallback to main.${NC}" >&2
            exit 1
        fi
        echo -e "${YELLOW}Cloning xiNAS ${_tag}...${NC}"
        git clone --branch "$_tag" "$REPO_URL" "$REPO_DIR"
    fi
    cd "$REPO_DIR"
fi

# Source the menu library as early as possible — right after the repo
# directory is resolved (cloned into, if it wasn't already present), and
# well before the later `if [ -f "lib/menu_lib.sh" ]` integration point
# further down that wires up the interactive expert-mode update prompt.
# _is_release_tag() (WS3 T5c) must be defined before
# xinas_update_to_latest_release() is ever CALLED, and the -u (update-only)
# path below calls it well before that later block runs. Sourcing here only
# defines functions and color variables (colors use `${RED:-default}`, so
# the values already set above are left untouched); it is safe to source
# again later, and that later block still needs its own file-existence
# check for hosts where the file is missing.
[ -f "lib/menu_lib.sh" ] && source "lib/menu_lib.sh"

# If only updating the repository, perform the update and exit
if [ "$UPDATE_ONLY" -eq 1 ]; then
    echo -e "${YELLOW}Updating to the latest release...${NC}"
    if _tag="$(xinas_update_to_latest_release)"; then
        echo -e "${GREEN}Updated to ${_tag}${NC}"
        exit 0
    fi
    exit 1
fi

# Ensure the hardware key utility is executable
[ -x ./hwkey ] || chmod +x ./hwkey

# Source the menu library if available
if [ -f "lib/menu_lib.sh" ]; then
    source "lib/menu_lib.sh"

    # In expert mode allow updating to the latest GitHub Release
    if [ "$EXPERT" -eq 1 ]; then
        if yes_no "Update Repository" "Update xiNAS to the latest GitHub Release?"; then
            if _tag="$(xinas_update_to_latest_release)"; then
                msg_box "Updated" "Updated to ${_tag}"
            else
                msg_box "Update Failed" "Could not resolve the latest GitHub Release. No fallback to main."
            fi
        fi
    fi
else
    # Fallback to simple prompt if menu library not available
    if [ "$EXPERT" -eq 1 ]; then
        echo -e "${YELLOW}Update xiNAS to the latest GitHub Release? (y/n)${NC}"
        read -r response
        if [[ "$response" =~ ^[Yy] ]]; then
            xinas_update_to_latest_release || \
                echo -e "${RED}Could not resolve the latest release — no fallback to main.${NC}"
        fi
    fi
fi

chmod +x startup_menu.sh simple_menu.sh

# Unattended mode: dependencies are installed; skip the interactive menu.
# install.sh / autoinstall.sh take over provisioning headlessly.
if [ "${XINAS_UNATTENDED:-0}" = "1" ]; then
    [ "$QUIET_MODE" != "1" ] && \
        echo -e "${GREEN}System prepared (unattended mode — menu skipped)${NC}"
    exit 0
fi

set +e
if [ "$EXPERT" -eq 1 ]; then
    ./startup_menu.sh
    status=$?
else
    ./simple_menu.sh
    status=$?
fi
set -e

if [ "$status" -eq 2 ]; then
    exit 0
fi

# POSIX: an `if` with no `else` whose condition is false exits 0, so without
# this explicit exit a real menu failure (any status other than 2) would be
# silently swallowed as success once the errexit-kills-the-shell bug above is
# fixed. Propagate the menu's actual exit status for every other case.
if [ "$status" -ne 0 ]; then
    echo -e "${RED}Menu exited with status ${status}${NC}" >&2
fi
exit "$status"
