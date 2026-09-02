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

# A 401 from GitHub (stale root credentials, a credential helper, a proxy)
# otherwise makes git prompt for a username on /dev/tty — and this script runs
# unattended under install.sh and in `-u` update mode, where nobody answers it.
# See docs/Installer/update-spec.md "Non-interactive git access".
export GIT_TERMINAL_PROMPT=0

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
    if ! git fetch origin --tags --quiet; then
        echo -e "${RED}git fetch failed while updating to ${tag}.${NC}" >&2
        return 1
    fi
    # The installed tree is git-dirty by design (presets are copied over
    # tracked role defaults/playbooks/site.yml), so a plain checkout aborts
    # with "local changes would be overwritten". --force discards changes
    # to *tracked* files only and is never paired with `git clean` (mirrors
    # xinas-update-git; see docs/Installer/update-spec.md "Reset-to-release").
    if ! git checkout --force --quiet "$tag"; then
        echo -e "${RED}git checkout ${tag} failed — tree left unchanged.${NC}" >&2
        return 1
    fi
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
    # Install yq v4 (YAML processor) used by configuration scripts.
    # Pinned + checksum-verified (docs/Installer/spec.md §8.1) — never fetch
    # `releases/latest`: a latest-tracking install means the exact binary on a
    # host silently changes between installs, and an unverified download must
    # never be chmod +x'd. Selected by host architecture (uname -m). Bump the
    # version and BOTH hashes together, deliberately, when updating yq.
    YQ_VERSION="v4.53.3"
    YQ_SHA256_AMD64="fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4"
    YQ_SHA256_ARM64="578648e463a11c1b6db6010cbf41eafed6bee79466fcffa1bb446672cf7945ea"

    install_yq() {
        local arch yq_asset yq_sha tmp_yq actual_sha
        case "$(uname -m)" in
            x86_64)        arch="amd64"; yq_sha="$YQ_SHA256_AMD64" ;;
            aarch64|arm64) arch="arm64"; yq_sha="$YQ_SHA256_ARM64" ;;
            *)
                echo -e "${RED}Unsupported architecture for yq: $(uname -m)${NC}" >&2
                return 1
                ;;
        esac
        yq_asset="yq_linux_${arch}"
        tmp_yq="$(mktemp)"
        # Download to a user-owned temp (no sudo needed); sudo only to install.
        if ! wget -qO "$tmp_yq" \
            "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/${yq_asset}"; then
            rm -f "$tmp_yq"
            echo -e "${RED}yq download failed${NC}" >&2
            return 1
        fi
        actual_sha="$(sha256sum "$tmp_yq" | awk '{print $1}')"
        if [ "$actual_sha" != "$yq_sha" ]; then
            rm -f "$tmp_yq"
            echo -e "${RED}yq checksum mismatch for ${yq_asset} ${YQ_VERSION}${NC}" >&2
            echo -e "${RED}expected ${yq_sha}, got ${actual_sha} — aborting, NOT installing.${NC}" >&2
            return 1
        fi
        sudo install -m 0755 "$tmp_yq" /usr/local/bin/yq
        rm -f "$tmp_yq"
    }

    run_quiet "Installing yq ${YQ_VERSION} (YAML processor, checksum-verified)" install_yq
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
        # _tag came from an unanchored grep/sed over the GitHub API response;
        # refuse anything that isn't a semver release tag before `git clone
        # --branch`. lib/menu_lib.sh (and its _is_release_tag) isn't available
        # pre-clone, so this regex is a character-identical copy of
        # _is_release_tag / install.sh's inline copy — kept in sync by
        # tests/test_release_tag_regex_parity.py.
        if [[ ! "$_tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
            echo -e "${RED}Refusing to clone non-release ref: '${_tag}'.${NC}" >&2
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
# F7 guard: chmod on a missing hwkey would exit 1 as the last command of the
# ||-list, tripping errexit and aborting the script — same fix as the hwkey
# sites in lib/menu_lib.sh.
[ -x ./hwkey ] || chmod +x ./hwkey 2>/dev/null || true

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

# Propagate the menu's exit status VERBATIM (docs/Installer/spec.md 2.7):
#
#   0  a playbook ran to completion — the host is provisioned
#   2  the operator chose "Exit" — a clean abort, and nothing was applied
#   *  the menu itself failed
#
# Status 2 used to be collapsed into `exit 0` here. That threw away the only
# signal install.sh has that no provisioning happened, so an aborted setup
# was indistinguishable from a finished one: install.sh went on to bootstrap
# the xinas-menu wrapper and print "installed successfully" for a host with
# no xiRAID, no arrays and no exports on it.
#
# Only a REAL failure gets a diagnostic — 2 is not an error, so it stays
# silent. Without the explicit `exit "$status"` below, a POSIX `if` with no
# `else` and a false condition would exit 0 on its own and silently swallow
# a real menu failure as success.
if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
    echo -e "${RED}Menu exited with status ${status}${NC}" >&2
fi
exit "$status"
