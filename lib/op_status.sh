#!/usr/bin/env bash
# op_status.sh - Operation status tracking for xiNAS
# Provides structured operation logging and post-change status reporting.
# Source after menu_lib.sh.

# ═══════════════════════════════════════════════════════════════════════════════
# State variables
# ═══════════════════════════════════════════════════════════════════════════════

_OP_NAME=""
_OP_BEFORE=""
_OP_START_TS=""
_OP_STEPS=()        # "OK|step name|detail" or "FAIL|step name|detail"
_OP_LAST_OUTPUT=""
_OP_LAST_EC=0

OP_LOG="/var/log/xinas/operations.log"
_OP_LOGROTATE="/etc/logrotate.d/xinas-operations"

# ═══════════════════════════════════════════════════════════════════════════════
# Log infrastructure
# ═══════════════════════════════════════════════════════════════════════════════

_op_log_init() {
    mkdir -p "$(dirname "$OP_LOG")" 2>/dev/null || true
    if [[ ! -f "$_OP_LOGROTATE" ]]; then
        cat > "$_OP_LOGROTATE" 2>/dev/null <<'LOGROTATE' || true
/var/log/xinas/operations.log {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}
LOGROTATE
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Operation tracking
# ═══════════════════════════════════════════════════════════════════════════════

op_start() {
    _OP_NAME="${1:-operation}"
    _OP_BEFORE="${2:-}"
    _OP_START_TS=$(date '+%Y-%m-%d %H:%M:%S')
    _OP_STEPS=()
    _OP_LAST_OUTPUT=""
    _OP_LAST_EC=0
}

op_step() {
    local name="${1:-step}"
    local ec="${2:-0}"
    local detail="${3:-}"
    local tag="OK"
    [[ "$ec" -ne 0 ]] && tag="FAIL"
    _OP_STEPS+=("${tag}|${name}|${detail}")
}

op_run() {
    local name="${1:-command}"
    shift
    local output=""
    local ec=0
    output=$("$@" 2>&1) && ec=0 || ec=$?
    _OP_LAST_OUTPUT="$output"
    _OP_LAST_EC=$ec
    local detail=""
    if [[ $ec -ne 0 && -n "$output" ]]; then
        # Trim to first line for log readability
        detail=$(printf '%s' "$output" | head -1)
    fi
    op_step "$name" "$ec" "$detail"
    return $ec
}

op_verify() {
    local desc="${1:-verify}"
    shift
    local output=""
    local ec=0
    output=$("$@" 2>&1) && ec=0 || ec=$?
    _OP_LAST_OUTPUT="$output"
    _OP_LAST_EC=$ec
    op_step "verify: $desc" "$ec" ""
    return $ec
}

# ═══════════════════════════════════════════════════════════════════════════════
# Finish + display
# ═══════════════════════════════════════════════════════════════════════════════

# op_end [after_state] [custom_title] [extra_body]
# Returns: 0=SUCCESS, 1=FAILED, 2=PARTIAL
op_end() {
    local after="${1:-}"
    local custom_title="${2:-}"
    local extra_body="${3:-}"

    local ok_count=0
    local fail_count=0
    local total=${#_OP_STEPS[@]}

    for entry in "${_OP_STEPS[@]}"; do
        local tag="${entry%%|*}"
        if [[ "$tag" == "OK" ]]; then
            ok_count=$((ok_count + 1))
        else
            fail_count=$((fail_count + 1))
        fi
    done

    # Compute status
    local status="SUCCESS"
    local ret=0
    if [[ $total -eq 0 || $fail_count -eq $total ]]; then
        status="FAILED"
        ret=1
    elif [[ $fail_count -gt 0 ]]; then
        status="PARTIAL"
        ret=2
    fi

    # Build display body
    local body=""
    for entry in "${_OP_STEPS[@]}"; do
        local tag="${entry%%|*}"
        local rest="${entry#*|}"
        local sname="${rest%%|*}"
        local sdetail="${rest#*|}"
        if [[ "$tag" == "OK" ]]; then
            body+="  [OK]   ${sname}\n"
        else
            body+="  [FAIL] ${sname}"
            [[ -n "$sdetail" ]] && body+="\n         ${sdetail}"
            body+="\n"
        fi
    done

    [[ -n "$after" ]] && body+="\n${after}\n"
    [[ -n "$extra_body" ]] && body+="\n${extra_body}\n"

    # Display via msg_box
    local title=""
    case "$status" in
        SUCCESS)
            title="${custom_title:-Success}"
            ;;
        FAILED)
            title="${custom_title:-Error}"
            ;;
        PARTIAL)
            title="${custom_title:-Partial Success}"
            ;;
    esac
    msg_box "$title" "$body"

    # Write to log
    _op_write_log "$status" "$after"

    # Reset state
    _OP_NAME=""
    _OP_BEFORE=""
    _OP_START_TS=""
    _OP_STEPS=()

    return $ret
}

_op_write_log() {
    local status="${1:-UNKNOWN}"
    local after="${2:-}"
    local end_ts
    end_ts=$(date '+%Y-%m-%d %H:%M:%S')
    local user="${SUDO_USER:-$USER}"
    {
        printf '=== %s | %s | %s | %s ===\n' "$_OP_START_TS" "$user" "$_OP_NAME" "$status"
        [[ -n "$_OP_BEFORE" ]] && printf '  BEFORE: %s\n' "$_OP_BEFORE"
        for entry in "${_OP_STEPS[@]}"; do
            local tag="${entry%%|*}"
            local rest="${entry#*|}"
            local sname="${rest%%|*}"
            local sdetail="${rest#*|}"
            printf '  [%s] %s' "$tag" "$sname"
            [[ -n "$sdetail" ]] && printf ' | %s' "$sdetail"
            printf '\n'
        done
        [[ -n "$after" ]] && printf '  AFTER: %s\n' "$after"
        printf '  ENDED: %s\n' "$end_ts"
    } >> "$OP_LOG" 2>/dev/null || true
}
