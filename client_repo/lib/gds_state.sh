#!/usr/bin/env bash
# gds_state.sh - Shared GDS truth parser for xiNAS client tooling
#
# Single source of truth consumed by both:
#   - client_setup.sh:verify_gds()         (menu surface)
#   - client_healthcheck.sh:check_gds()    (Python heredoc, future Task 7)
#
# Writes /tmp/.xinas-gds-state.json with the schema documented in
# docs/plans/2026-05-11-gds-verification-and-mlnx-nfsrdma-patch-design.md
# Section 5.
#
# Sourceable from any bash context — does NOT touch the environment
# beyond defining its function and its STATE_FILE constant. Has no
# top-level side effects (no `set` changes, no exec, no menu init).
# Requires `jq` to be available; emits a FAIL-state JSON envelope if
# not.

# ═══════════════════════════════════════════════════════════════════════════════
# Idempotent guard
# ═══════════════════════════════════════════════════════════════════════════════

# If already sourced, do nothing.  Prevents double-definition when both
# client_setup.sh and (later) the check_gds Python heredoc source the lib.
[[ -n "${_XINAS_GDS_STATE_LIB:-}" ]] && return 0
_XINAS_GDS_STATE_LIB=1

# ═══════════════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════════════

# Canonical path for the GDS state envelope.  Exposed as a top-level
# constant so downstream consumers (Python heredoc, etc.) can locate
# the file without re-hardcoding the path.
STATE_FILE="/tmp/.xinas-gds-state.json"

# ─────────────────────────────────────────────────────────────────────────────
# _gds_parse_state — shared GDS truth parser
#
# Writes /tmp/.xinas-gds-state.json (atomically) with a canonical
# snapshot of GDS+NFS+cufile.json health.  Schema (8 fields + cache_key):
#
#   { overall, nfs_state, compat, mount_table, mounts, errors, warns,
#     ts, cache_key }
#
# Truth table:
#   gdscheck NFS line       PASS=nvfs,compat | WARN=nvfs | FAIL=other
#   cufile.json mount_table PASS=valid       | WARN=absent / partial
#                                            | FAIL=malformed
#   NFS mount (when GDS configured) PASS=proto=rdma | FAIL=non-rdma
#   gdscheck cuFile init    FAIL on "Platform verification error" / EINVAL
#   gdscheck "Userspace RDMA" line is IGNORED.
#
# A sha256 cache key (cufile.json mtime + nvidia-fs version mtime + rpcrdma
# srcversion) short-circuits repeat calls.
# ─────────────────────────────────────────────────────────────────────────────
_gds_parse_state() {
    local STATE_FILE="/tmp/.xinas-gds-state.json"
    local TMP_FILE="${STATE_FILE}.tmp.$$"

    # ── Hard dependency: jq ──────────────────────────────────────────────────
    # jq is already required by configure_cufile and elsewhere in this script;
    # silently degrading here would drop collected errors/warnings on the
    # floor and let downstream consumers trust stale data.  Emit a definitive
    # FAIL envelope and bail.
    if ! command -v jq &>/dev/null; then
        cat > "$STATE_FILE" <<'EOF'
{
  "overall": "FAIL",
  "nfs_state": "unknown",
  "compat": "disabled",
  "mount_table": "absent",
  "mounts": [],
  "errors": ["jq is required by _gds_parse_state but is not installed"],
  "warns": [],
  "ts": "1970-01-01T00:00:00Z",
  "cache_key": "no-jq"
}
EOF
        return 0
    fi

    # ── Cache key ────────────────────────────────────────────────────────────
    local cufile_mt nvfs_mt rpcrdma_sv cache_key
    if [[ -f /etc/cufile.json ]]; then
        cufile_mt=$(stat -c '%Y' /etc/cufile.json 2>/dev/null || echo missing)
    else
        cufile_mt="missing"
    fi
    if [[ -f /proc/driver/nvidia-fs/version ]]; then
        nvfs_mt=$(stat -c '%Y' /proc/driver/nvidia-fs/version 2>/dev/null || echo missing)
    else
        nvfs_mt="missing"
    fi
    if [[ -r /sys/module/rpcrdma/srcversion ]]; then
        rpcrdma_sv=$(cat /sys/module/rpcrdma/srcversion 2>/dev/null || echo missing)
    else
        rpcrdma_sv="missing"
    fi
    if command -v sha256sum &>/dev/null; then
        cache_key=$(printf '%s|%s|%s' "$cufile_mt" "$nvfs_mt" "$rpcrdma_sv" \
                    | sha256sum | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
        cache_key=$(printf '%s|%s|%s' "$cufile_mt" "$nvfs_mt" "$rpcrdma_sv" \
                    | shasum -a 256 | awk '{print $1}')
    else
        cache_key="nohash-$cufile_mt-$nvfs_mt-$rpcrdma_sv"
    fi

    # Cache hit?  Also require the cached envelope's `.overall` to be present,
    # so a partial/corrupted prior write with the right cache_key doesn't
    # short-circuit and feed broken data to downstream consumers.
    if [[ -f "$STATE_FILE" ]] && command -v jq &>/dev/null; then
        local prev_key prev_overall
        prev_key=$(jq -r '.cache_key // empty' "$STATE_FILE" 2>/dev/null || true)
        prev_overall=$(jq -r '.overall // empty' "$STATE_FILE" 2>/dev/null || true)
        if [[ -n "$prev_key" && "$prev_key" == "$cache_key" && -n "$prev_overall" ]]; then
            return 0
        fi
    fi

    # ── Run gdscheck once ────────────────────────────────────────────────────
    # gdscheck is shipped inside the CUDA tree (gds/tools/gdscheck{,.py}); the
    # parent dir is usually NOT on PATH, so fall back to a CUDA-tree scan.
    local gdscheck_bin=""
    if command -v gdscheck &>/dev/null; then
        gdscheck_bin="gdscheck"
    else
        gdscheck_bin=$(find /usr/local/cuda*/gds/tools \
                            \( -name 'gdscheck' -o -name 'gdscheck.py' \) \
                            2>/dev/null | head -1 || true)
    fi
    local gdscheck_out=""
    local gdscheck_rc=0
    if [[ -n "$gdscheck_bin" ]]; then
        if [[ $EUID -eq 0 ]]; then
            gdscheck_out=$("$gdscheck_bin" -p 2>&1) || gdscheck_rc=$?
        elif sudo -n true 2>/dev/null; then
            gdscheck_out=$(sudo -n "$gdscheck_bin" -p 2>&1) || gdscheck_rc=$?
        else
            gdscheck_out=$("$gdscheck_bin" -p 2>&1) || gdscheck_rc=$?
        fi
    else
        gdscheck_rc=127
    fi

    # ── Parse NFS state ──────────────────────────────────────────────────────
    # Strip the "Userspace RDMA" line — per design we must NOT confuse it
    # with the kernel-NFS line.
    local nfs_line=""
    if [[ -n "$gdscheck_out" ]]; then
        nfs_line=$(printf '%s\n' "$gdscheck_out" \
                   | grep -v -i 'Userspace RDMA' \
                   | grep -E '^[[:space:]]*NFS[[:space:]]*:' \
                   | head -1 || true)
    fi

    local nfs_state="unknown"
    local compat="disabled"
    local -a errors=()
    local -a warns=()

    if [[ -z "$nfs_line" ]]; then
        if [[ $gdscheck_rc -eq 127 ]]; then
            errors+=("gdscheck not installed")
        elif [[ -z "$gdscheck_out" ]]; then
            errors+=("gdscheck produced no output")
        else
            errors+=("gdscheck did not report an NFS line")
        fi
        nfs_state="unknown"
    elif [[ "$nfs_line" =~ nvfs[[:space:]]*,[[:space:]]*compat ]]; then
        nfs_state="nvfs,compat"
        compat="enabled"
    elif [[ "$nfs_line" =~ nvfs ]]; then
        # nvfs but no compat
        nfs_state="nvfs"
        compat="disabled"
        warns+=("cuFile compat mode disabled")
    elif [[ "$nfs_line" =~ ^[^:]*:[[:space:]]*compat([[:space:]]|,|$) ]]; then
        # `NFS : compat` only — compat enabled in cufile.json but the kernel-
        # side nvfs hook is not registered.  Semantically equivalent to
        # "unsupported" (GDS unavailable), but the user needs the distinct
        # explanation to know where to look.
        nfs_state="unsupported"
        errors+=("gdscheck reports NFS : compat only — kernel-side nvfs hook not registered")
    elif [[ "$nfs_line" =~ [Uu]nsupported ]]; then
        nfs_state="unsupported"
        errors+=("gdscheck reports NFS : Unsupported")
    else
        nfs_state="unknown"
        errors+=("gdscheck NFS line not recognised")
    fi

    # cuFile init / platform errors in the output → FAIL
    if printf '%s\n' "$gdscheck_out" \
        | grep -E -q 'Platform verification error|Invalid argument'; then
        errors+=("gdscheck reports cuFile init failure")
        # demote to unknown if we hadn't already flagged a worse state
        if [[ "$nfs_state" == "nvfs" || "$nfs_state" == "nvfs,compat" ]]; then
            : # leave nfs_state; init failure is a separate signal
        fi
    fi

    # ── mount_table validation in /etc/cufile.json ───────────────────────────
    local mount_table="absent"
    if [[ ! -f /etc/cufile.json ]]; then
        mount_table="absent"
        warns+=("fs.nfs.mount_table not configured")
    elif ! command -v jq &>/dev/null; then
        mount_table="invalid"
        errors+=("jq not installed; cannot validate cufile.json")
    else
        # Sanitize NVIDIA's // comments + trailing commas before piping to jq.
        local sanitized_cufile
        sanitized_cufile=$(sed -E 's@^([^"]*("[^"]*"[^"]*)*)//.*$@\1@; s@,([[:space:]]*[]}])@\1@g' \
                           /etc/cufile.json 2>/dev/null || true)
        local mt_type
        mt_type=$(printf '%s' "$sanitized_cufile" \
                  | jq -r '.fs.nfs.mount_table | type' 2>/dev/null || echo "parse_error")
        case "$mt_type" in
            object)
                # Every value must have an array .rdma_dev_addr_list.  Return
                # the offending mount-path keys so the WARN message names
                # them — a bare count is not actionable for the user.
                local bad_keys
                bad_keys=$(printf '%s' "$sanitized_cufile" \
                           | jq -r '[.fs.nfs.mount_table
                                      | to_entries[]
                                      | select((.value.rdma_dev_addr_list | type) != "array")
                                      | .key] | join(",")' \
                             2>/dev/null || echo "__jq_error__")
                if [[ "$bad_keys" == "__jq_error__" ]]; then
                    mount_table="invalid"
                    errors+=("fs.nfs.mount_table malformed")
                elif [[ -z "$bad_keys" ]]; then
                    mount_table="valid"
                else
                    mount_table="invalid"
                    warns+=("fs.nfs.mount_table entries missing rdma_dev_addr_list: $bad_keys")
                fi
                ;;
            "null")
                mount_table="absent"
                warns+=("fs.nfs.mount_table not configured")
                ;;
            parse_error)
                mount_table="invalid"
                errors+=("fs.nfs.mount_table malformed")
                ;;
            *)
                mount_table="invalid"
                errors+=("fs.nfs.mount_table malformed")
                ;;
        esac
    fi

    # ── Enumerate NFS mounts ─────────────────────────────────────────────────
    local mounts_json="[]"
    if command -v findmnt &>/dev/null; then
        local fm_out
        fm_out=$(findmnt -J -t nfs,nfs4 2>/dev/null || true)
        if [[ -n "$fm_out" ]] && command -v jq &>/dev/null; then
            mounts_json=$(printf '%s' "$fm_out" \
                | jq '[
                        (.. | objects | select(has("target") and has("options")))
                        | { path: .target,
                            proto: (
                              (.options
                                | split(",")
                                | map(select(startswith("proto=")))
                                | (.[0] // "")
                                | sub("^proto=";"")
                              )
                              | if . == "" then "unknown" else . end
                            )
                          }
                      ]' 2>/dev/null || echo "[]")
            [[ -z "$mounts_json" ]] && mounts_json="[]"
        fi
    fi

    # ── Mount-vs-GDS gate ────────────────────────────────────────────────────
    # Only fire when GDS is *configured* (nvfs or nvfs,compat).  When
    # nfs_state is "unsupported" or "unknown" the box cannot do GDS at all,
    # so non-rdma mounts shouldn't double-count as failures here.
    if [[ "$nfs_state" == "nvfs" || "$nfs_state" == "nvfs,compat" ]] \
        && command -v jq &>/dev/null; then
        local bad_mounts
        bad_mounts=$(printf '%s' "$mounts_json" \
                     | jq -r '.[] | select(.proto != "rdma") | .path' \
                       2>/dev/null || true)
        if [[ -n "$bad_mounts" ]]; then
            local mp
            while IFS= read -r mp; do
                [[ -z "$mp" ]] && continue
                local p
                p=$(printf '%s' "$mounts_json" \
                    | jq -r --arg mp "$mp" '.[] | select(.path==$mp) | .proto' \
                      2>/dev/null || echo unknown)
                errors+=("$mp mounted with proto=$p")
            done <<< "$bad_mounts"
        fi
    fi

    # ── Roll-up ──────────────────────────────────────────────────────────────
    local overall="OK"
    if [[ ${#errors[@]} -gt 0 ]]; then
        overall="FAIL"
    elif [[ ${#warns[@]} -gt 0 ]]; then
        overall="WARN"
    fi

    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # ── Emit JSON ────────────────────────────────────────────────────────────
    # jq presence is guaranteed by the prerequisite check at function entry.
    local err_json warn_json
    err_json=$(printf '%s\n' "${errors[@]:-}" | jq -R . | jq -s 'map(select(length>0))')
    warn_json=$(printf '%s\n' "${warns[@]:-}" | jq -R . | jq -s 'map(select(length>0))')
    jq -n \
        --arg overall     "$overall"     \
        --arg nfs_state   "$nfs_state"   \
        --arg compat      "$compat"      \
        --arg mount_table "$mount_table" \
        --argjson mounts  "$mounts_json" \
        --argjson errors  "$err_json"    \
        --argjson warns   "$warn_json"   \
        --arg ts          "$ts"          \
        --arg cache_key   "$cache_key"   \
        '{overall:$overall, nfs_state:$nfs_state, compat:$compat,
          mount_table:$mount_table, mounts:$mounts, errors:$errors,
          warns:$warns, ts:$ts, cache_key:$cache_key}' \
        > "$TMP_FILE" 2>/dev/null

    if [[ -s "$TMP_FILE" ]]; then
        mv -f "$TMP_FILE" "$STATE_FILE"
    else
        rm -f "$TMP_FILE"
        return 1
    fi
    return 0
}
