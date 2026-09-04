#!/bin/bash
# xiNAS non-interactive (unattended) installer.
#
# Reproduces the "Install" menu flow (apply preset -> run site.yml) with no
# TTY prompts, for scripted server provisioning: kickstart, cloud-init,
# golden images, fleet rollout.
#
# Full contract: docs/Installer/spec.md section 7.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors / output helpers ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
step() { echo ""; echo -e "  ${CYAN}${BOLD}> $1${NC}"; }
ok()   { echo -e "     ${GREEN}OK${NC}  $*"; }
info() { echo -e "     ${DIM}..${NC}  $*"; }
warn() { echo -e "     ${YELLOW}!!${NC}  $*"; }
fail() { echo -e "     ${RED}xx${NC}  $*" >&2; }
die()  { fail "$1"; exit 1; }

LICENSE_FILE="/tmp/license"
LOG_FILE="${XINAS_LOG:-/var/log/xinas/install.log}"

usage() {
    cat <<'EOF'
Usage: autoinstall.sh [OPTIONS]

Non-interactive xiNAS provisioning. Configuration is resolved from
(lowest to highest precedence): answer file, environment, CLI flags.

Options:
  --preset NAME         default | xinnorVM | existing-raid   (default: default)
  --license-file PATH   xiRAID license file        (default: /tmp/license)
  --hostname NAME       hostname to set            (default: xiNAS-<HWKEY>)
  --inventory PATH      Ansible inventory          (default: inventories/lab.ini)
  --extra-vars STRING   extra Ansible -e vars, passed through verbatim
  --config PATH         answer file       (default: /etc/xinas/autoinstall.conf)
  --no-purge-xiraid     keep pre-existing xiRAID packages
  --skip-prepare        do not auto-install dependencies
  --dry-run             resolve + validate, print the command, do not run
  --check               validate configuration only
  --status              print last install's per-role progress and exit
  --json                with --status: print the raw install-state JSON
  -h, --help            show this help

The license is read from a file only. When --license-file is omitted the
default /tmp/license is used — the same path the TUI and bash menus write.

Answer-file / environment only (no CLI flag):
  fs_force_format / XINAS_FS_FORCE_FORMAT   (default: no)
      Reformat a REUSED array whose filesystem is not XFS with the
      configured label. Without it such an install stops rather than
      overwrite a filesystem it was not told about. Keeps the arrays.

Environment: XINAS_PRESET, XINAS_LICENSE_FILE, XINAS_HOSTNAME,
  XINAS_INVENTORY, XINAS_EXTRA_VARS, XINAS_PURGE_XIRAID,
  XINAS_SKIP_PREPARE, XINAS_FS_FORCE_FORMAT, XINAS_AUTOINSTALL_CONFIG

See docs/Installer/spec.md section 7 for the full contract.
EOF
}

is_yes() { case "${1,,}" in y|yes|true|1|on) return 0 ;; *) return 1 ;; esac; }

# ── CLI flags (highest precedence) ────────────────────────────────────────────
cli_preset=""; cli_license_file=""
cli_hostname=""; cli_inventory=""; cli_extra_vars=""; cli_config=""
cli_purge=""; cli_skip_prepare=""
DRY_RUN=0; CHECK_ONLY=0; STATUS_ONLY=0; STATUS_JSON=0

# Post-install role report (docs/Installer/spec.md §2.9). Rendered from the
# callback's install-state.json by a standard-library-only module under the
# system python3 — on a fresh install the management venv does not exist yet.
# Never fails the caller: the report must not change the install's status.
#   render_install_report [--exit-code N --log PATH --since EPOCH]
render_install_report() {
    local renderer="$SCRIPT_DIR/xinas_menu/install_report.py"
    local state_file="${XINAS_INSTALL_STATE_PATH:-/var/lib/xinas/install-state.json}"
    if [ -r "$renderer" ] && command -v python3 >/dev/null 2>&1; then
        python3 "$renderer" --state "$state_file" "$@" && return 0
    fi
    echo "  Install report unavailable; per-role state is in $state_file"
    return 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --preset)          cli_preset="${2:-}"; shift; shift 2>/dev/null || true ;;
        --license-file)    cli_license_file="${2:-}"; shift; shift 2>/dev/null || true ;;
        --hostname)        cli_hostname="${2:-}"; shift; shift 2>/dev/null || true ;;
        --inventory)       cli_inventory="${2:-}"; shift; shift 2>/dev/null || true ;;
        --extra-vars)      cli_extra_vars="${2:-}"; shift; shift 2>/dev/null || true ;;
        --config)          cli_config="${2:-}"; shift; shift 2>/dev/null || true ;;
        --no-purge-xiraid) cli_purge="no"; shift ;;
        --skip-prepare)    cli_skip_prepare="yes"; shift ;;
        --dry-run)         DRY_RUN=1; shift ;;
        --check)           CHECK_ONLY=1; shift ;;
        --status)          STATUS_ONLY=1; shift ;;
        --json)            STATUS_JSON=1; shift ;;
        -h|--help)         usage; exit 0 ;;
        *) die "Unknown option: $1 (try --help)" ;;
    esac
done

# ── --status: report the last install's per-role progress and exit ────────────
# Reads the install-state.json the xinas_install_state callback writes. No root
# required; this is a read-only query (finding #2). Prints the §2.9 role
# table; --json prints the raw file instead.
if [ "$STATUS_ONLY" -eq 1 ]; then
    state_file="${XINAS_INSTALL_STATE_PATH:-/var/lib/xinas/install-state.json}"
    if [ -f "$state_file" ]; then
        if [ "$STATUS_JSON" -eq 1 ]; then
            cat "$state_file"
        else
            render_install_report
        fi
        exit 0
    fi
    echo "No install state recorded yet ($state_file not found)." >&2
    exit 1
fi

# ── Answer file (lowest precedence) ───────────────────────────────────────────
preset=""; license_file=""; hostname=""
inventory=""; extra_vars=""; purge_xiraid=""; skip_prepare=""
fs_force_format=""

config_path="${cli_config:-${XINAS_AUTOINSTALL_CONFIG:-/etc/xinas/autoinstall.conf}}"
if [ -f "$config_path" ]; then
    info "Answer file: $config_path"
    # shellcheck disable=SC1090
    source "$config_path"
elif [ -n "$cli_config" ] || [ -n "${XINAS_AUTOINSTALL_CONFIG:-}" ]; then
    die "Answer file not found: $config_path"
fi

# ── Environment overrides answer file ─────────────────────────────────────────
preset="${XINAS_PRESET:-${preset:-default}}"
license_file="${XINAS_LICENSE_FILE:-${license_file:-$LICENSE_FILE}}"
hostname="${XINAS_HOSTNAME:-${hostname:-}}"
inventory="${XINAS_INVENTORY:-${inventory:-inventories/lab.ini}}"
extra_vars="${XINAS_EXTRA_VARS:-${extra_vars:-}}"
purge_xiraid="${XINAS_PURGE_XIRAID:-${purge_xiraid:-}}"
skip_prepare="${XINAS_SKIP_PREPARE:-${skip_prepare:-no}}"
# Reformat a reused array whose filesystem is foreign (raid-spec §11). Default
# "no": an unattended run never silently reformats data it was not told about.
# Deliberately NOT implied by nvme_skip_cleanup_confirmation, which is the
# unattended bypass for the storage-reset YES prompt — a flag chosen for a
# rebuild must not authorise reformatting arrays the operator meant to keep.
fs_force_format="${XINAS_FS_FORCE_FORMAT:-${fs_force_format:-no}}"

# ── CLI overrides everything ──────────────────────────────────────────────────
[ -n "$cli_preset" ]       && preset="$cli_preset"
[ -n "$cli_license_file" ] && license_file="$cli_license_file"
[ -n "$cli_hostname" ]     && hostname="$cli_hostname"
[ -n "$cli_inventory" ]    && inventory="$cli_inventory"
[ -n "$cli_extra_vars" ]   && extra_vars="$cli_extra_vars"
[ -n "$cli_purge" ]        && purge_xiraid="$cli_purge"
[ -n "$cli_skip_prepare" ] && skip_prepare="$cli_skip_prepare"

# ── Resolve derived settings ──────────────────────────────────────────────────
# existing-raid is the default preset plus the xiRAID/namespace skip flags.
existing_raid=0
preset_dir_name="$preset"
if [ "$preset" = "existing-raid" ]; then
    existing_raid=1
    preset_dir_name="default"
fi

# Purge default: keep xiRAID for existing-raid (the arrays need it), else purge.
if [ -z "$purge_xiraid" ]; then
    if [ "$existing_raid" -eq 1 ]; then purge_xiraid="no"; else purge_xiraid="yes"; fi
fi

preset_path="presets/$preset_dir_name"

# ── Validate ──────────────────────────────────────────────────────────────────
[ -d "$preset_path" ] || \
    die "Unknown preset '$preset' (expected: default, xinnorVM, existing-raid)"

if [ ! -f "$license_file" ]; then
    die "License file not found: $license_file — place the license there or pass --license-file"
fi
[ -s "$license_file" ] || die "License file is empty: $license_file"

[ -f "$inventory" ] || die "Inventory not found: $inventory"

if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK_ONLY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
    die "autoinstall.sh must be run as root (use sudo)"
fi

# ── Build the Ansible command ─────────────────────────────────────────────────
ev_args=()
[ -n "$hostname" ] && ev_args+=( -e "xinas_hostname=$hostname" )
# Surfaces the preset to the install-state callback (#2) and the .installed_preset
# marker written by the motd role (#16).
ev_args+=( -e "xinas_install_preset=$preset" )
if [ "$existing_raid" -eq 1 ]; then
    ev_args+=( -e "xiraid_skip_install=true" -e "nvme_auto_namespace=false" )
fi
if is_yes "$fs_force_format"; then
    ev_args+=( -e "xinas_fs_force_format=true" )
fi
[ -n "$extra_vars" ] && ev_args+=( -e "$extra_vars" )

ansible_cmd=( ansible-playbook playbooks/site.yml -i "$inventory" -v )
[ "${#ev_args[@]}" -gt 0 ] && ansible_cmd+=( "${ev_args[@]}" )

# ── Report resolved configuration ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}xiNAS unattended install${NC}"
echo -e "  ${DIM}------------------------------------------${NC}"
info "Preset       : $preset"
info "Inventory    : $inventory"
info "Hostname     : ${hostname:-<auto: xiNAS-HWKEY>}"
info "License file : $license_file"
info "Purge xiRAID : $purge_xiraid"
info "Force format : $fs_force_format"
[ -n "$extra_vars" ] && info "Extra vars   : $extra_vars"

if [ "$CHECK_ONLY" -eq 1 ]; then
    echo ""
    ok "Configuration valid"
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo ""
    ok "Dry run — configuration valid, nothing applied"
    echo -e "     ${DIM}Would run:${NC} ${ansible_cmd[*]}"
    exit 0
fi

# ── Place the license at /tmp/license ─────────────────────────────────────────
# raid_fs applies the license via `xicli license update -p /tmp/license`.
# When --license-file points elsewhere, copy it into place; when it is already
# /tmp/license there is nothing to do (and copying onto itself would empty it).
step "Preparing license"
if [ "$license_file" != "$LICENSE_FILE" ] && [ ! "$license_file" -ef "$LICENSE_FILE" ]; then
    cp -- "$license_file" "$LICENSE_FILE" || die "Cannot copy license to $LICENSE_FILE"
fi
chmod 600 "$LICENSE_FILE" 2>/dev/null || true
[ -s "$LICENSE_FILE" ] || die "License is empty at $LICENSE_FILE"
ok "License ready at $LICENSE_FILE"

# ── Bootstrap dependencies if needed ──────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || LOG_FILE="/tmp/xinas-install.log"

if ! command -v ansible-playbook >/dev/null 2>&1; then
    if is_yes "$skip_prepare"; then
        die "ansible-playbook not found and --skip-prepare is set"
    fi
    [ -x ./prepare_system.sh ] || die "prepare_system.sh not found — cannot bootstrap"
    step "Installing dependencies"
    if ! XINAS_UNATTENDED=1 XINAS_QUIET=1 XINAS_LOG="$LOG_FILE" ./prepare_system.sh; then
        fail "Dependency bootstrap failed — see $LOG_FILE"
        exit 2
    fi
    command -v ansible-playbook >/dev/null 2>&1 \
        || { fail "ansible-playbook still missing after prepare_system.sh"; exit 2; }
    ok "Dependencies installed"
fi

[ -x ./hwkey ] || chmod +x ./hwkey 2>/dev/null || true

# ── Apply the preset (mirrors the menu's apply_preset) ────────────────────────
step "Applying preset: $preset"
. "$SCRIPT_DIR/lib/xinas_config.sh"

# One-shot bridge for hosts installed before the configuration overlay
# existed (docs/superpowers/specs/2026-08-18-preset-overlay-design.md §9).
# No-op on every run after the first; the explicit apply below still runs
# regardless, so this only matters the first time autoinstall.sh runs again
# against a pre-overlay host.
migrated=$(xinas_migrate_overlay) || true
if [ -n "$migrated" ]; then info "$migrated"; fi

xinas_apply_preset "$preset_dir_name" || die "preset apply failed: $preset_dir_name"
ok "Preset applied"

# ── Purge pre-existing xiRAID packages ────────────────────────────────────────
if is_yes "$purge_xiraid"; then
    pkgs=$(dpkg-query -W -f='${Package} ${Status}\n' 'xiraid*' 2>/dev/null \
        | awk '$4=="installed"{print $1}' | tr '\n' ' ')
    if [ -n "${pkgs// /}" ]; then
        step "Removing pre-existing xiRAID packages"
        info "$pkgs"
        apt-get purge -y -qq --allow-change-held-packages $pkgs >>"$LOG_FILE" 2>&1 || true
        apt-get autoremove -y -qq --allow-change-held-packages >>"$LOG_FILE" 2>&1 || true
        rm -rf /etc/xiraid
        ok "xiRAID packages removed"
    fi
fi

# ── Run the playbook ──────────────────────────────────────────────────────────
# Mark this as an install run so the xinas_install_state callback records
# per-role progress to /var/lib/xinas/install-state.json (finding #2). Day-2
# playbook runs leave this unset, so they never clobber install state.
export XINAS_RECORD_INSTALL_STATE=1
step "Running ansible-playbook"
info "Log: $LOG_FILE"
{
    printf '\n=== %s | autoinstall | %s ===\n' \
        "$(date -Iseconds 2>/dev/null || date)" "${ansible_cmd[*]}"
} >>"$LOG_FILE" 2>/dev/null || true

# Launch time, so the report can tell this run's state file from one an
# earlier install left behind.
run_started=$(date +%s)
"${ansible_cmd[@]}" 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}

# Post-install role report (§2.9): always, before the verdict line below.
echo ""
render_install_report --exit-code "$rc" --log "$LOG_FILE" --since "$run_started"

echo ""
if [ "$rc" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}xiNAS deployed successfully${NC}"
    if command -v xinas-status >/dev/null 2>&1; then
        echo ""
        xinas-status || true
    fi
else
    fail "ansible-playbook failed (exit $rc) — see $LOG_FILE"
fi
exit "$rc"
