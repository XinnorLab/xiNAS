#!/usr/bin/env bash
# menu_lib.sh - Colored console menu library for xiNAS
# Replaces whiptail with native bash colored menus
# Supports arrow key navigation, number keys, and Enter/Esc

# ═══════════════════════════════════════════════════════════════════════════════
# Color Definitions
# ═══════════════════════════════════════════════════════════════════════════════

# Always define color variables (empty if not a terminal)
if [[ -t 1 ]] || [[ -t 2 ]]; then
    RED=${RED:-'\033[0;31m'}
    GREEN=${GREEN:-'\033[0;32m'}
    YELLOW=${YELLOW:-'\033[1;33m'}
    BLUE=${BLUE:-'\033[0;34m'}
    CYAN=${CYAN:-'\033[0;36m'}
    MAGENTA=${MAGENTA:-'\033[0;35m'}
    WHITE=${WHITE:-'\033[1;37m'}
    DIM=${DIM:-'\033[2m'}
    BOLD=${BOLD:-'\033[1m'}
    REVERSE=${REVERSE:-'\033[7m'}
    NC=${NC:-'\033[0m'}
else
    RED=${RED:-''}
    GREEN=${GREEN:-''}
    YELLOW=${YELLOW:-''}
    BLUE=${BLUE:-''}
    CYAN=${CYAN:-''}
    MAGENTA=${MAGENTA:-''}
    WHITE=${WHITE:-''}
    DIM=${DIM:-''}
    BOLD=${BOLD:-''}
    REVERSE=${REVERSE:-''}
    NC=${NC:-''}
fi

# Box drawing characters
BOX_TL='╔'
BOX_TR='╗'
BOX_BL='╚'
BOX_BR='╝'
BOX_H='═'
BOX_V='║'
BOX_LINE='─'

# ═══════════════════════════════════════════════════════════════════════════════
# Terminal Utilities
# ═══════════════════════════════════════════════════════════════════════════════

_menu_cursor_hide() {
    printf '\033[?25l' >/dev/tty
}

_menu_cursor_show() {
    printf '\033[?25h' >/dev/tty
}

_menu_clear_screen() {
    printf '\033[2J\033[H' >/dev/tty
}


# Read a single keypress and name it.
#
# Printable keys come back as themselves, Enter as ENTER, Backspace as
# BACKSPACE, the cursor keys as UP/DOWN/RIGHT/LEFT, a bare Escape as ESC.
#
# A cursor key arrives as an escape sequence, and the terminal picks the
# encoding per session, not per keyboard: normal mode sends CSI (`ESC [ B`
# for Down); application cursor-key mode — DECCKM, `CSI ? 1 h`, which any
# full-screen program, multiplexer or terminal may leave switched on — sends
# SS3 (`ESC O B`). Both are the same key. Reading exactly two bytes after the
# ESC and matching only the CSI form turned the SS3 form, and every longer
# sequence (Home/End `ESC [ H`, PgDn `ESC [ 6 ~`, F-keys, Ctrl-arrows), into
# "ESC" — which every dialog treats as Cancel, and which at the top-level
# setup menu is `exit 2`: one Down keypress ended the installer. So after an
# ESC the whole sequence is collected byte by byte, the cursor keys are
# decoded in either encoding, and any other complete sequence is handed back
# as UNKNOWN, which no dialog maps to anything. Only an ESC followed by
# nothing within the inter-byte window is Cancel — the window is generous
# because a false Cancel here costs the operator the whole setup session.
# Contract: docs/Installer/spec.md §2.6.
_menu_read_key() {
    local key seq c code n
    IFS= read -rsn1 key </dev/tty

    if [[ "$key" == $'\033' ]]; then
        # Nothing within the window after the ESC: a bare Escape.
        if ! IFS= read -rsn1 -t 0.25 c </dev/tty; then
            echo "ESC"
            return 0
        fi
        seq="$c"
        case "$c" in
            '[')
                # CSI: parameter and intermediate bytes (0x20-0x3F), then one
                # final byte (0x40-0x7E) closes the sequence. Bounded so a
                # garbage stream cannot spin here.
                n=0
                while [[ $n -lt 16 ]] && IFS= read -rsn1 -t 0.25 c </dev/tty; do
                    [[ -z "$c" ]] && break
                    seq+="$c"
                    n=$((n + 1))
                    printf -v code '%d' "'$c"
                    [[ $code -ge 64 && $code -le 126 ]] && break
                done
                ;;
            'O')
                # SS3: exactly one final byte.
                IFS= read -rsn1 -t 0.25 c </dev/tty && seq+="$c"
                ;;
        esac
        case "$seq" in
            '[A'|'OA') echo "UP" ;;
            '[B'|'OB') echo "DOWN" ;;
            '[C'|'OC') echo "RIGHT" ;;
            '[D'|'OD') echo "LEFT" ;;
            *)         echo "UNKNOWN" ;;
        esac
    elif [[ "$key" == '' ]]; then
        echo "ENTER"
    elif [[ "$key" == $'\177' ]] || [[ "$key" == $'\b' ]]; then
        echo "BACKSPACE"
    else
        echo "$key"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Drawing Functions
# ═══════════════════════════════════════════════════════════════════════════════

_menu_repeat_char() {
    local char="$1"
    local count="$2"
    local result=""
    local i
    for ((i=0; i<count; i++)); do
        result+="$char"
    done
    printf '%s' "$result"
}

# Return the display width of a string (handles emoji and wide chars)
_menu_display_width() {
    printf '%s' "$1" | wc -L
}

_menu_draw_box() {
    local title="$1"
    local width="${2:-60}"
    local title_len
    title_len=$(_menu_display_width "$title")
    # Account for: ╔ (1) + left padding + space (1) + title + space (1) + right padding + ╗ (1)
    local left_pad=$(( (width - title_len - 4) / 2 ))
    local right_pad=$(( width - title_len - 4 - left_pad ))
    [[ $left_pad -lt 1 ]] && left_pad=1
    [[ $right_pad -lt 1 ]] && right_pad=1

    printf "${CYAN}${BOX_TL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$left_pad" >/dev/tty
    printf " ${WHITE}${BOLD}%s${NC}${CYAN} " "$title" >/dev/tty
    _menu_repeat_char "$BOX_H" "$right_pad" >/dev/tty
    printf "${BOX_TR}${NC}\n" >/dev/tty
}

_menu_draw_separator() {
    local width="${1:-60}"
    printf "${DIM}" >/dev/tty
    _menu_repeat_char "$BOX_LINE" "$width" >/dev/tty
    printf "${NC}\n" >/dev/tty
}

# ═══════════════════════════════════════════════════════════════════════════════
# menu_select - Interactive Menu with Arrow Keys
# ═══════════════════════════════════════════════════════════════════════════════

menu_select() {
    local title="$1"
    local prompt="$2"
    shift 2

    local -a keys=()
    local -a descs=()

    while [[ $# -gt 0 ]]; do
        keys+=("$1")
        descs+=("${2:-}")
        shift 2 2>/dev/null || shift 1
    done

    local num_items=${#keys[@]}
    [[ $num_items -eq 0 ]] && return 1

    local selected=0
    local width=60
    local i _pi

    # Calculate width (account for emoji display width)
    for ((i=0; i<num_items; i++)); do
        local item_len=$((${#keys[$i]} + ${#descs[$i]} + 8))
        [[ $item_len -gt $width ]] && width=$item_len
    done
    [[ $width -gt 78 ]] && width=78

    # Pre-split prompt into lines array (safe under set -euo pipefail)
    local -a _prompt_lines=()
    if [[ -n "$prompt" ]]; then
        local _tmp="${prompt//\\n/$'\n'}"
        while [[ "$_tmp" == *$'\n'* ]]; do
            _prompt_lines+=("${_tmp%%$'\n'*}")
            _tmp="${_tmp#*$'\n'}"
        done
        _prompt_lines+=("$_tmp")
    else
        _prompt_lines+=("$prompt")
    fi
    local _num_plines=${#_prompt_lines[@]}

    _menu_cursor_hide

    _render_menu() {
        _menu_clear_screen

        local inner_width=$((width - 2))

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"

        # Prompt lines with borders
        for ((_pi=0; _pi<_num_plines; _pi++)); do
            local _pl="${_prompt_lines[$_pi]}"
            local _pl_len=${#_pl}
            local _pl_pad=$(( inner_width - _pl_len - 2 ))
            [[ $_pl_pad -lt 0 ]] && _pl_pad=0
            printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}%*s ${CYAN}${BOX_V}${NC}\n" "$_pl" "$_pl_pad" '' >/dev/tty
        done

        # Close the header box
        printf "${CYAN}${BOX_BL}" >/dev/tty
        _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
        printf "${BOX_BR}${NC}\n" >/dev/tty

        # Menu items (no side borders)
        for ((i=0; i<num_items; i++)); do
            if [[ $i -eq $selected ]]; then
                printf "${REVERSE}${GREEN} > %s  %s ${NC}\n" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            else
                printf "${DIM}   ${NC}${YELLOW}%s${NC}  ${WHITE}%s${NC}\n" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            fi
        done

        # Footer help text
        echo "" >/dev/tty
        printf "  ${DIM}↑↓ Navigate  Enter Select  Esc Cancel${NC}\n" >/dev/tty
    }

    _render_menu

    while true; do
        local key=$(_menu_read_key)

        case "$key" in
            UP)
                ((selected--))
                [[ $selected -lt 0 ]] && selected=$((num_items - 1))
                _render_menu
                ;;
            DOWN)
                ((selected++))
                [[ $selected -ge $num_items ]] && selected=0
                _render_menu
                ;;
            ENTER)
                _menu_cursor_show
                echo "${keys[$selected]}"
                return 0
                ;;
            ESC)
                _menu_cursor_show
                return 1
                ;;
            [0-9])
                for ((i=0; i<num_items; i++)); do
                    if [[ "${keys[$i]}" == "$key" ]]; then
                        _menu_cursor_show
                        echo "${keys[$i]}"
                        return 0
                    fi
                done
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# msg_box - Display Message Box with Full Border
# ═══════════════════════════════════════════════════════════════════════════════

msg_box() {
    local title="$1"
    local message="$2"
    local width=60

    # Convert literal \n to actual newlines
    local newline=$'\n'
    message="${message//\\n/$newline}"

    # Calculate width based on content
    local max_line=0
    while IFS= read -r line; do
        local _dw; _dw=$(_menu_display_width "$line")
        [[ $_dw -gt $max_line ]] && max_line=$_dw
    done <<< "$message"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))

    _menu_clear_screen
    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Content lines with side borders
    while IFS= read -r line; do
        local line_len; line_len=$(_menu_display_width "$line")
        local padding=$((inner_width - line_len - 2))
        [[ $padding -lt 0 ]] && padding=0
        printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
        printf '%*s' "$padding" '' >/dev/tty
        printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
    done <<< "$message"

    # Empty line before footer
    printf "${CYAN}${BOX_V}${NC}" >/dev/tty
    printf '%*s' "$inner_width" '' >/dev/tty
    printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

    # Bottom border
    printf "${CYAN}${BOX_BL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
    printf "${BOX_BR}${NC}\n" >/dev/tty

    echo "" >/dev/tty
    printf "  ${DIM}Press Enter to continue...${NC}" >/dev/tty
    read -r </dev/tty
    echo "" >/dev/tty
}

# ═══════════════════════════════════════════════════════════════════════════════
# yes_no - Yes/No Prompt
# ═══════════════════════════════════════════════════════════════════════════════

yes_no() {
    local title="$1"
    local question="$2"
    local default="${3:-y}"
    local width=55
    local selected=0
    [[ "$default" == "n" ]] && selected=1

    # Convert literal \n to actual newlines
    local newline=$'\n'
    question="${question//\\n/$newline}"

    # Calculate width based on longest line
    local max_line=0
    while IFS= read -r line; do
        local _dw; _dw=$(_menu_display_width "$line")
        [[ $_dw -gt $max_line ]] && max_line=$_dw
    done <<< "$question"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    _menu_cursor_hide

    _render_yesno() {
        _menu_clear_screen

        local inner_width=$((width - 2))

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"

        # Question lines with borders
        while IFS= read -r line; do
            local line_len; line_len=$(_menu_display_width "$line")
            local padding=$((inner_width - line_len - 2))
            [[ $padding -lt 0 ]] && padding=0
            printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
            printf '%*s' "$padding" '' >/dev/tty
            printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
        done <<< "$question"

        # Empty line with borders
        printf "${CYAN}${BOX_V}${NC}" >/dev/tty
        printf '%*s' "$inner_width" '' >/dev/tty
        printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

        # Yes/No buttons line with borders
        local buttons=""
        if [[ $selected -eq 0 ]]; then
            buttons="  [YES]      No  "
        else
            buttons="   Yes     [NO]  "
        fi
        local btn_pad=$((inner_width - 20))
        [[ $btn_pad -lt 0 ]] && btn_pad=0

        printf "${CYAN}${BOX_V}${NC}  " >/dev/tty
        if [[ $selected -eq 0 ]]; then
            printf "${REVERSE}${GREEN}  Yes  ${NC}" >/dev/tty
        else
            printf "${DIM}  Yes  ${NC}" >/dev/tty
        fi
        printf "    " >/dev/tty
        if [[ $selected -eq 1 ]]; then
            printf "${REVERSE}${RED}  No   ${NC}" >/dev/tty
        else
            printf "${DIM}  No   ${NC}" >/dev/tty
        fi
        printf '%*s' "$btn_pad" '' >/dev/tty
        printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

        # Empty line with borders
        printf "${CYAN}${BOX_V}${NC}" >/dev/tty
        printf '%*s' "$inner_width" '' >/dev/tty
        printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

        # Footer with help text
        local help_text="←→ Switch  Enter Confirm"
        local help_len; help_len=$(_menu_display_width "$help_text")
        local help_pad=$((inner_width - help_len - 1))
        [[ $help_pad -lt 0 ]] && help_pad=0
        printf "${CYAN}${BOX_V}${NC} ${DIM}%s${NC}" "$help_text" >/dev/tty
        printf '%*s' "$help_pad" '' >/dev/tty
        printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

        # Bottom border
        printf "${CYAN}${BOX_BL}" >/dev/tty
        _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
        printf "${BOX_BR}${NC}\n" >/dev/tty
    }

    _render_yesno

    while true; do
        local key=$(_menu_read_key)

        case "$key" in
            LEFT|UP|RIGHT|DOWN)
                selected=$((1 - selected))
                _render_yesno
                ;;
            ENTER)
                _menu_cursor_show
                return $selected
                ;;
            ESC)
                _menu_cursor_show
                return 1
                ;;
            [yY])
                _menu_cursor_show
                return 0
                ;;
            [nN])
                _menu_cursor_show
                return 1
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# input_box - Text Input with Full Border
# ═══════════════════════════════════════════════════════════════════════════════

input_box() {
    local title="$1"
    local prompt="$2"
    local default="${3:-}"
    local width=60

    # Convert literal \n to actual newlines
    local newline=$'\n'
    prompt="${prompt//\\n/$newline}"

    # Calculate width based on longest line
    local max_line=0
    while IFS= read -r line; do
        local _dw; _dw=$(_menu_display_width "$line")
        [[ $_dw -gt $max_line ]] && max_line=$_dw
    done <<< "$prompt"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Prompt lines with borders
    while IFS= read -r line; do
        local line_len; line_len=$(_menu_display_width "$line")
        local padding=$((inner_width - line_len - 2))
        [[ $padding -lt 0 ]] && padding=0
        printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
        printf '%*s' "$padding" '' >/dev/tty
        printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
    done <<< "$prompt"

    # Empty line with borders
    printf "${CYAN}${BOX_V}${NC}" >/dev/tty
    printf '%*s' "$inner_width" '' >/dev/tty
    printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

    # Bottom border
    printf "${CYAN}${BOX_BL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
    printf "${BOX_BR}${NC}\n" >/dev/tty

    echo "" >/dev/tty
    printf "  ${CYAN}>${NC} " >/dev/tty

    _menu_cursor_show

    # Char-by-char editor so Esc actually cancels (bash `read` can't detect it).
    local buffer="$default"
    [[ -n "$buffer" ]] && printf '%s' "$buffer" >/dev/tty

    local key
    while true; do
        key=$(_menu_read_key)
        case "$key" in
            ESC)
                printf '\n' >/dev/tty
                return 1
                ;;
            ENTER)
                printf '\n' >/dev/tty
                printf '%s\n' "$buffer"
                return 0
                ;;
            BACKSPACE)
                if [[ -n "$buffer" ]]; then
                    buffer="${buffer%?}"
                    printf '\b \b' >/dev/tty
                fi
                ;;
            UP|DOWN|LEFT|RIGHT)
                ;;
            *)
                if [[ ${#key} -eq 1 && "$key" =~ [[:print:]] ]]; then
                    buffer+="$key"
                    printf '%s' "$key" >/dev/tty
                fi
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# password_box - Password Input (Masked)
# ═══════════════════════════════════════════════════════════════════════════════

password_box() {
    local title="$1"
    local prompt="$2"
    local width=55

    # Convert literal \n to actual newlines
    local newline=$'\n'
    prompt="${prompt//\\n/$newline}"

    # Calculate width based on longest line
    local max_line=0
    while IFS= read -r line; do
        local _dw; _dw=$(_menu_display_width "$line")
        [[ $_dw -gt $max_line ]] && max_line=$_dw
    done <<< "$prompt"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Prompt lines with borders
    while IFS= read -r line; do
        local line_len; line_len=$(_menu_display_width "$line")
        local padding=$((inner_width - line_len - 2))
        [[ $padding -lt 0 ]] && padding=0
        printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
        printf '%*s' "$padding" '' >/dev/tty
        printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
    done <<< "$prompt"

    # Empty line with borders
    printf "${CYAN}${BOX_V}${NC}" >/dev/tty
    printf '%*s' "$inner_width" '' >/dev/tty
    printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

    # Bottom border
    printf "${CYAN}${BOX_BL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
    printf "${BOX_BR}${NC}\n" >/dev/tty

    echo "" >/dev/tty
    printf "  ${CYAN}>${NC} " >/dev/tty

    local password=""
    local char

    _menu_cursor_show

    while IFS= read -rsn1 char </dev/tty; do
        if [[ -z "$char" ]]; then
            break
        elif [[ "$char" == $'\177' ]] || [[ "$char" == $'\b' ]]; then
            if [[ -n "$password" ]]; then
                password="${password%?}"
                printf '\b \b' >/dev/tty
            fi
        elif [[ "$char" == $'\033' ]]; then
            echo "" >/dev/tty
            return 1
        else
            password+="$char"
            printf '*' >/dev/tty
        fi
    done

    echo "" >/dev/tty
    echo "$password"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# text_box - Display File/Text with Scrolling
# ═══════════════════════════════════════════════════════════════════════════════

text_box() {
    local title="$1"
    local content="$2"

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" 70
    echo "" >/dev/tty

    if [[ -f "$content" ]]; then
        less -R "$content" </dev/tty >/dev/tty 2>/dev/tty || cat "$content" >/dev/tty
    else
        echo "$content" | less -R </dev/tty >/dev/tty 2>/dev/tty || echo "$content" >/dev/tty
    fi

    echo "" >/dev/tty
}

# ═══════════════════════════════════════════════════════════════════════════════
# text_area - Multi-line Text Input
# ═══════════════════════════════════════════════════════════════════════════════

text_area() {
    local title="$1"
    local prompt="$2"
    local output_file="$3"
    local width=70

    local inner_width=$((width - 2))

    # Convert literal \n to actual newlines
    local newline=$'\n'
    prompt="${prompt//\\n/$newline}"

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Prompt lines with borders
    while IFS= read -r line; do
        local line_len; line_len=$(_menu_display_width "$line")
        local padding=$((inner_width - line_len - 2))
        [[ $padding -lt 0 ]] && padding=0
        printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
        printf '%*s' "$padding" '' >/dev/tty
        printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
    done <<< "$prompt"

    # Empty line with borders
    printf "${CYAN}${BOX_V}${NC}" >/dev/tty
    printf '%*s' "$inner_width" '' >/dev/tty
    printf "${CYAN}${BOX_V}${NC}\n" >/dev/tty

    # Bottom border
    printf "${CYAN}${BOX_BL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
    printf "${BOX_BR}${NC}\n" >/dev/tty

    echo "" >/dev/tty
    printf "  ${DIM}Paste text below. Press Ctrl-D on empty line when done, Ctrl-C to cancel.${NC}\n" >/dev/tty
    printf "  ${CYAN}────────────────────────────────────────────────────────────────${NC}\n" >/dev/tty

    _menu_cursor_show

    # Read multi-line input
    local text=""
    if [[ -n "$output_file" ]]; then
        cat </dev/tty > "$output_file" 2>/dev/null
        local status=$?
        echo "" >/dev/tty
        if [[ $status -eq 0 ]] && [[ -s "$output_file" ]]; then
            return 0
        else
            return 1
        fi
    else
        text=$(cat </dev/tty 2>/dev/null)
        local status=$?
        echo "" >/dev/tty
        if [[ $status -eq 0 ]] && [[ -n "$text" ]]; then
            echo "$text"
            return 0
        else
            return 1
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# info_box - Temporary Status Message (No Wait) with Full Border
# ═══════════════════════════════════════════════════════════════════════════════

info_box() {
    local title="$1"
    local message="$2"
    local width=50

    # Convert literal \n to actual newlines
    local newline=$'\n'
    message="${message//\\n/$newline}"

    # Calculate width based on longest line
    local max_line=0
    while IFS= read -r line; do
        local _dw; _dw=$(_menu_display_width "$line")
        [[ $_dw -gt $max_line ]] && max_line=$_dw
    done <<< "$message"
    [[ $((max_line + 8)) -gt $width ]] && width=$((max_line + 8))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))

    _menu_clear_screen
    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Content lines with borders
    local first_line=1
    while IFS= read -r line; do
        local line_len; line_len=$(_menu_display_width "$line")
        local prefix_len=2
        [[ $first_line -eq 1 ]] && prefix_len=4  # "⟳ " takes 2 extra
        local padding=$((inner_width - line_len - prefix_len))
        [[ $padding -lt 0 ]] && padding=0

        if [[ $first_line -eq 1 ]]; then
            printf "${CYAN}${BOX_V}${NC} ${YELLOW}⟳${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
            first_line=0
        else
            printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$line" >/dev/tty
        fi
        printf '%*s' "$padding" '' >/dev/tty
        printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty
    done <<< "$message"

    # Bottom border
    printf "${CYAN}${BOX_BL}" >/dev/tty
    _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
    printf "${BOX_BR}${NC}\n" >/dev/tty
    echo "" >/dev/tty
}

# ═══════════════════════════════════════════════════════════════════════════════
# check_list - Multi-Select Menu
# ═══════════════════════════════════════════════════════════════════════════════

check_list() {
    local title="$1"
    local prompt="$2"
    shift 2

    local -a keys=()
    local -a descs=()
    local -a states=()

    while [[ $# -gt 0 ]]; do
        keys+=("$1")
        descs+=("${2:-}")
        states+=("${3:-OFF}")
        shift 3 2>/dev/null || break
    done

    local num_items=${#keys[@]}
    [[ $num_items -eq 0 ]] && return 1

    local selected=0
    local width=60
    local i _pi

    # Pre-split prompt into lines array (safe under set -euo pipefail)
    local -a _prompt_lines=()
    if [[ -n "$prompt" ]]; then
        local _tmp="${prompt//\\n/$'\n'}"
        while [[ "$_tmp" == *$'\n'* ]]; do
            _prompt_lines+=("${_tmp%%$'\n'*}")
            _tmp="${_tmp#*$'\n'}"
        done
        _prompt_lines+=("$_tmp")
    else
        _prompt_lines+=("$prompt")
    fi
    local _num_plines=${#_prompt_lines[@]}

    _menu_cursor_hide

    _render_checklist() {
        _menu_clear_screen

        local inner_width=$((width - 2))

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"

        # Prompt lines with borders
        for ((_pi=0; _pi<_num_plines; _pi++)); do
            local _pl="${_prompt_lines[$_pi]}"
            local _pl_len=${#_pl}
            local _pl_pad=$(( inner_width - _pl_len - 2 ))
            [[ $_pl_pad -lt 0 ]] && _pl_pad=0
            printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}%*s ${CYAN}${BOX_V}${NC}\n" "$_pl" "$_pl_pad" '' >/dev/tty
        done

        # Close the header box
        printf "${CYAN}${BOX_BL}" >/dev/tty
        _menu_repeat_char "$BOX_H" "$inner_width" >/dev/tty
        printf "${BOX_BR}${NC}\n" >/dev/tty

        # Checklist items (no side borders)
        for ((i=0; i<num_items; i++)); do
            local checkbox_char
            if [[ "${states[$i]}" == "ON" ]]; then
                checkbox_char="[✓]"
            else
                checkbox_char="[ ]"
            fi

            if [[ $i -eq $selected ]]; then
                printf "${REVERSE}${GREEN} > %s %s %s ${NC}\n" "$checkbox_char" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            else
                if [[ "${states[$i]}" == "ON" ]]; then
                    printf "   ${GREEN}%s${NC} ${YELLOW}%s${NC} ${WHITE}%s${NC}\n" "$checkbox_char" "${keys[$i]}" "${descs[$i]}" >/dev/tty
                else
                    printf "   ${DIM}%s${NC} ${YELLOW}%s${NC} ${WHITE}%s${NC}\n" "$checkbox_char" "${keys[$i]}" "${descs[$i]}" >/dev/tty
                fi
            fi
        done

        # Footer help text
        echo "" >/dev/tty
        printf "  ${DIM}↑↓ Navigate  Space Toggle  Enter Done${NC}\n" >/dev/tty
    }

    _render_checklist

    while true; do
        local key=$(_menu_read_key)

        case "$key" in
            UP)
                ((selected--))
                [[ $selected -lt 0 ]] && selected=$((num_items - 1))
                _render_checklist
                ;;
            DOWN)
                ((selected++))
                [[ $selected -ge $num_items ]] && selected=0
                _render_checklist
                ;;
            " ")
                if [[ "${states[$selected]}" == "ON" ]]; then
                    states[$selected]="OFF"
                else
                    states[$selected]="ON"
                fi
                _render_checklist
                ;;
            ENTER)
                _menu_cursor_show
                local result=""
                for ((i=0; i<num_items; i++)); do
                    if [[ "${states[$i]}" == "ON" ]]; then
                        result+="${keys[$i]} "
                    fi
                done
                echo "${result% }"
                return 0
                ;;
            ESC)
                _menu_cursor_show
                return 1
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Utility Functions
# ═══════════════════════════════════════════════════════════════════════════════

msg_success() {
    printf "\n  ${GREEN}✓${NC} ${WHITE}%s${NC}\n\n" "$1" >/dev/tty
}

msg_error() {
    printf "\n  ${RED}✗${NC} ${WHITE}%s${NC}\n\n" "$1" >/dev/tty
}

msg_warn() {
    printf "\n  ${YELLOW}⚠${NC} ${WHITE}%s${NC}\n\n" "$1" >/dev/tty
}

msg_info() {
    printf "\n  ${CYAN}ℹ${NC} ${WHITE}%s${NC}\n\n" "$1" >/dev/tty
}

print_status() {
    local status="$1"
    local message="$2"

    case "$status" in
        ok|success|active|online|up)
            printf "${GREEN}●${NC} %s\n" "$message" >/dev/tty
            ;;
        error|failed|offline|down)
            printf "${RED}●${NC} %s\n" "$message" >/dev/tty
            ;;
        warn|warning|degraded)
            printf "${YELLOW}●${NC} %s\n" "$message" >/dev/tty
            ;;
        *)
            printf "${DIM}●${NC} %s\n" "$message" >/dev/tty
            ;;
    esac
}
