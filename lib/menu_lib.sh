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


# Read a single keypress (handles arrow keys)
_menu_read_key() {
    local key
    IFS= read -rsn1 key </dev/tty

    if [[ "$key" == $'\033' ]]; then
        read -rsn2 -t 0.1 key </dev/tty
        case "$key" in
            '[A') echo "UP" ;;
            '[B') echo "DOWN" ;;
            '[C') echo "RIGHT" ;;
            '[D') echo "LEFT" ;;
            *)    echo "ESC" ;;
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

        # Footer: normal help text, or a transient hint on unrecognized input
        # (finding #5). A hint passed as $1 is shown in red instead of the help.
        local help_text="←→ Switch  Enter Confirm"
        local help_color="${DIM}"
        if [[ -n "${1:-}" ]]; then
            help_text="$1"
            help_color="${RED}"
        fi
        local help_len; help_len=$(_menu_display_width "$help_text")
        local help_pad=$((inner_width - help_len - 1))
        [[ $help_pad -lt 0 ]] && help_pad=0
        printf "${CYAN}${BOX_V}${NC} ${help_color}%s${NC}" "$help_text" >/dev/tty
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
            *)
                # Finding #5: don't silently swallow an unrecognized key — beep
                # and flash a red footer hint so the user knows the keystroke was
                # rejected and which keys are valid. The hint persists until the
                # next keypress re-renders the dialog.
                printf '\a' >/dev/tty 2>/dev/null || true
                _render_yesno "Unknown key — use ←→, Enter, y/n, or Esc"
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

    # Locally handle SIGINT so Ctrl-C cancels the input cleanly. The parent
    # script may have installed `trap '' INT` to ignore SIGINT globally; that
    # disposition is inherited by children, so cat would otherwise ignore
    # Ctrl-C. Installing a non-empty trap here causes bash to reset signal
    # handling to default for child processes — cat dies on Ctrl-C, and we
    # catch the signal in the shell to return cleanly.
    local _prev_int_trap
    _prev_int_trap=$(trap -p INT)
    local _sigint_caught=0
    trap '_sigint_caught=1' INT

    # Read multi-line input
    local text=""
    local status
    if [[ -n "$output_file" ]]; then
        cat </dev/tty > "$output_file" 2>/dev/null
        status=$?
    else
        text=$(cat </dev/tty 2>/dev/null)
        status=$?
    fi

    # Restore parent's previous SIGINT disposition.
    if [[ -n "$_prev_int_trap" ]]; then
        eval "$_prev_int_trap"
    else
        trap - INT
    fi

    echo "" >/dev/tty

    if (( _sigint_caught )); then
        [[ -n "$output_file" ]] && : > "$output_file" 2>/dev/null
        return 1
    fi

    if [[ -n "$output_file" ]]; then
        if [[ $status -eq 0 ]] && [[ -s "$output_file" ]]; then
            return 0
        else
            return 1
        fi
    else
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

# ═══════════════════════════════════════════════════════════════════════════════
# _semver_gt / _semver_parse - pure-bash semantic-version comparison
# ═══════════════════════════════════════════════════════════════════════════════
# Mirrors xinas_menu/utils/update_check.py's _parse_semver / _semver_key so the
# bash update paths and the Python updater agree on ordering (a final release
# outranks a prerelease of the same X.Y.Z). Accepts an optional "v" prefix and
# an optional "-prerelease" suffix; build metadata ("+...") is stripped. Used
# by check_for_updates below so "update available" is decided by semantic-
# version ordering, never string inequality (docs/Installer/update-spec.md
# "Bash-path parity", F6).

# Prints "MAJOR MINOR PATCH PRERELEASE" on success; returns 1 (and prints
# nothing) if $1 is not parseable as X.Y.Z.
#
# Component validation is `^(0|[1-9][0-9]{0,17})$`, not the looser
# `^[0-9]+$`: real SemVer forbids leading zeroes in numeric identifiers, so
# rejecting them here is a correctness fix, not just a workaround. It also
# closes two bugs in `_semver_gt`'s `((...))` arithmetic, which parses a
# leading-zero literal as octal: "010" silently read as octal 8 (< 9,
# inverting a true decimal 10 > 9), and "08" is not a valid octal digit at
# all, so bash raises `value too great for base` on that comparison — an
# error that gets swallowed as "false" because it fires as the *tested*
# condition of `if ((...))`, letting a later field (e.g. patch) silently
# decide the result instead of the real minor-version difference. Capping
# each component at 18 digits (max 999999999999999999 < 2^63-1) closes a
# third bug: an unbounded numeric literal like 26 nines overflows bash's
# signed 64-bit arithmetic and wraps negative, comparing as smaller than a
# tiny patch value. An unparseable tag already makes `_semver_gt` return
# false, which is the safe direction here — it never manufactures a false
# "update available".
_semver_parse() {
    local v="$1"
    v="${v#v}"; v="${v#V}"
    v="${v%%+*}"
    local core="${v%%-*}"
    local pre=""
    [[ "$v" == *-* ]] && pre="${v#*-}"
    local maj min pat
    IFS='.' read -r maj min pat <<< "$core"
    local -r num_re='^(0|[1-9][0-9]{0,17})$'
    [[ "$maj" =~ $num_re && "$min" =~ $num_re && "$pat" =~ $num_re ]] || return 1
    printf '%s %s %s %s\n' "$maj" "$min" "$pat" "$pre"
}

# True (exit 0) iff $1 is a strictly newer semantic version than $2. False
# (exit 1) on a tie, on $1 older than $2, or if either argument fails to
# parse — an unparseable tag must never be treated as "older" in a way that
# manufactures a false "update available".
#
# Hardening (WS3 T4, Mandate A1): every branch below returns 0/1 explicitly
# via `if (( … )); then return 0; else return 1; fi` rather than a bare
# `(( … )); return`. A bare `(( expr ))` that evaluates false exits 1, and
# under `set -euo pipefail` a failing simple command that is not itself the
# condition of an if/while/until, part of a `&&`/`||` list, or negated with
# `!` kills the shell immediately. Bash exempts the ENTIRE execution of a
# compound command / function call from -e only while that call's own
# result is being tested — every call site in this file wraps the call as
# `if _semver_gt …; then`, which is why the original bare-`((...))`-then-
# `return` form already worked, but only by accident: safe today only
# because nothing calls it unguarded. That is exactly the class of bug T3
# fixed for `var=$(failing_pipeline)`. A truly bare, unconditional call
# whose honest answer is "false" will still trip errexit no matter how this
# function is implemented internally — that is `set -e` correctly punishing
# an unguarded failing command, not something to suppress. What the
# explicit-return form buys instead: every branch is self-contained, so
# correctness no longer depends on nothing running between an arithmetic
# test and a bare `return` (which just inherits whatever $? happens to
# hold), nor on every future caller remembering to wrap the call in `if`.
#
# Divergence from xinas_menu/utils/update_check.py (Mandate A2): Python's
# _semver_key splits a prerelease suffix on "." and compares each identifier
# numerically when it looks like an integer, so "rc.2" < "rc.10" there. The
# final line below instead does a single string compare of the whole
# prerelease suffix ([[ "$a_pre" > "$b_pre" ]]), so "rc.10" < "rc.2" here —
# the reverse of Python's order for that specific case. This is a
# deliberate, documented mismatch, not a silent one: it is unreachable from
# every current bash call site. _latest_release_tag (below) always queries
# GitHub's `/releases/latest` endpoint, which GitHub defines to already
# exclude every prerelease and draft, so the "latest" argument this function
# ever receives from a bash update path can never itself carry a prerelease
# suffix — a two-prerelease comparison (the only case where the two
# implementations disagree) can never occur here. (XINAS_UPDATE_CHANNEL,
# how the Python path opts into prereleases, is not read anywhere in bash.)
# The only prerelease case bash can hit — current_tag pinned to a
# prerelease vs. a final latest release of the same X.Y.Z — is the "final
# outranks any prerelease" branch above, where both implementations agree.
_semver_gt() {
    local a b
    a=$(_semver_parse "$1") || return 1
    b=$(_semver_parse "$2") || return 1
    local a_maj a_min a_pat a_pre b_maj b_min b_pat b_pre
    read -r a_maj a_min a_pat a_pre <<< "$a"
    read -r b_maj b_min b_pat b_pre <<< "$b"
    if ((a_maj != b_maj)); then
        if ((a_maj > b_maj)); then return 0; else return 1; fi
    fi
    if ((a_min != b_min)); then
        if ((a_min > b_min)); then return 0; else return 1; fi
    fi
    if ((a_pat != b_pat)); then
        if ((a_pat > b_pat)); then return 0; else return 1; fi
    fi
    # Same X.Y.Z: a final release (empty prerelease) outranks any prerelease.
    if [[ -z "$a_pre" && -n "$b_pre" ]]; then return 0; fi
    if [[ -n "$a_pre" && -z "$b_pre" ]]; then return 1; fi
    if [[ "$a_pre" > "$b_pre" ]]; then return 0; else return 1; fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# check_for_updates / _latest_release_tag / _current_release_tag
# ═══════════════════════════════════════════════════════════════════════════════
# Shared by startup_menu.sh and simple_menu.sh (WS3 T4, Part B) — these three
# functions were byte-identical in both menus and had to be fixed twice, in
# T3 (WS3.3, F4); this is now the single canonical copy. Callers must have
# REPO_DIR and REPO_SLUG set as globals by the time check_for_updates is
# actually CALLED — both menus set REPO_DIR before their `source
# lib/menu_lib.sh` line, and REPO_SLUG/UPDATE_AVAILABLE/UPDATE_TARGET_TAG
# after it but well before the top-level `check_for_updates` call site.
# That ordering is safe: `source` only DEFINES these functions, it does not
# execute them, and bash resolves a function's global variable references
# at CALL time, not at source/definition time.
#
# do_update() itself is deliberately NOT hoisted here: startup_menu.sh's
# rebuilds the MCP server and restarts xinas-nfs-helper; simple_menu.sh's is
# a plain checkout. They genuinely differ and stay per-menu.
#
# Note: post_install_menu.sh also sources this file, but defines its OWN
# check_for_updates / _latest_release_tag / _current_release_tag / do_update
# AFTER its `source lib/menu_lib.sh` line — those later definitions shadow
# the ones below (bash: last definition wins). That is intentional, not a
# bug; post_install_menu.sh has not been migrated to the shared copy.

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

# ═══════════════════════════════════════════════════════════════════════════════
# _is_release_tag — WS3 T5c (code review hardening)
# ═══════════════════════════════════════════════════════════════════════════════
# Accept only a semver release tag (optionally v-prefixed, optional
# prerelease suffix). Reject branches, HEAD, refspecs, flag-shaped strings
# (leading `-`), and anything else — this is the single source of truth for
# the regex; four other sites carry character-identical inline copies
# because they can't source this file: the privileged root-owned helper
# (collection/roles/xinas_menu/files/xinas-update-git), install.sh and
# install_client.sh (standalone installers that run before/independently of
# the clone this file lives in), and prepare_system.sh's own initial
# bootstrap clone (runs before the repo — and this file inside it — exists
# on disk at all). That's five copies total; keep them all in sync if the
# contract ever changes. tests/test_release_tag_regex_parity.py enforces it.
#
# Every bash tag resolver (_latest_release_tag below, and both
# prepare_system.sh's and install.sh's own xinas_latest_release_tag())
# extracts tag_name via an unanchored `grep -o | sed` over the GitHub API
# response — good enough to find the field, but it does not by itself prove
# the result is a release tag rather than a branch name, HEAD, or arbitrary
# text a compromised/misconfigured feed could return. `git checkout --force`
# on an unvalidated ref is exactly the "no branch fallback, ever" policy
# violation docs/Installer/update-spec.md forbids — this predicate is the
# gate every checkout site must pass before it ever calls git.
_is_release_tag() {
    [[ "$1" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
}

# Resolve the latest PUBLISHED GitHub Release tag (vX.Y.Z). Prints nothing on
# failure. Never returns a branch name; callers must NOT fall back to main.
# Goes through xinas_gh_curl so a configured GitHub token (update-spec.md
# "GitHub rate limits and the access token") lifts the call off the anonymous
# per-IP quota that every host behind one NAT shares.
#
# $1 (optional): max seconds for the whole curl (--max-time). Default 3 — the
# passive startup check (check_for_updates, below) must not stall the menu;
# an unbounded curl could hang for the OS TCP timeout (commonly minutes) on
# an air-gapped/blackholed network. do_update (in both menus) passes a
# longer bound here: the operator explicitly asked to update and is already
# waiting on a blocking action, so failing fast after ~3s on a slow-but-live
# link is the wrong trade there — see docs/Installer/update-spec.md
# "Bash-path parity".
# $2 (optional): max seconds to establish the TCP connection
# (--connect-timeout). Default 2, matching the original passive-check bound.
# do_update passes a longer value too, to tolerate a slower handshake
# (higher-latency link, corporate proxy) it is now willing to wait out.
#
# Trailing `|| true`: under `set -e`, `var=$(this_pipeline)` aborts the
# CALLING shell if the pipeline's exit status is non-zero (e.g. curl times
# out, or `grep -o` finds nothing on empty/error output — `pipefail` makes
# that the pipeline's status). Force success; an empty result already reads
# as "no update" at the call site.
_latest_release_tag() {
    local max_time="${1:-3}"
    local connect_timeout="${2:-2}"
    xinas_gh_curl --connect-timeout "$connect_timeout" --max-time "$max_time" -fsSL \
        "https://api.github.com/repos/${REPO_SLUG:-}/releases/latest" 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/' || true
}

# Release tag the working tree at $1 is currently on (empty if none).
_current_release_tag() {
    git -C "$1" describe --tags --exact-match 2>/dev/null \
        || git -C "$1" describe --tags 2>/dev/null || true
}

check_for_updates() {
    # Guard against an unset REPO_DIR before anything else runs: this
    # function is sourced under `set -euo pipefail` by both menus, and the
    # very next line is a plain assignment that reads $REPO_DIR — a plain
    # assignment gets no errexit/nounset exemption, so an unset REPO_DIR
    # would abort the ENTIRE shell with "REPO_DIR: unbound variable" rather
    # than just this function failing. Every other missing precondition
    # below (no .git, no git binary, no network) already returns 0 quietly;
    # do the same here instead of relying on both current callers happening
    # to set REPO_DIR before sourcing this file.
    [[ -n "${REPO_DIR:-}" ]] || return 0

    # Check if running from a git repo
    local git_dir="$REPO_DIR/.git"
    [[ -d "$git_dir" ]] || return 0

    # Skip if no git command
    command -v git &>/dev/null || return 0

    # Skip if no network (quick check)
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0

    # Compare the installed release tag against the latest published
    # release, using semantic-version ordering (docs/Installer/update-spec.md
    # "Bash-path parity") — never string inequality, which reports "update
    # available" whenever the tags merely differ, including when the feed's
    # tag is OLDER, walking an install backwards. If the API is unreachable,
    # show no update — never inspect main.
    local latest_tag current_tag
    latest_tag=$(_latest_release_tag)
    [[ -n "$latest_tag" ]] || return 0
    current_tag=$(_current_release_tag "$REPO_DIR")

    if _semver_gt "$latest_tag" "$current_tag"; then
        UPDATE_AVAILABLE="true"
        UPDATE_TARGET_TAG="$latest_tag"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# _xinas_playbook_ticker — compresses PLAY/TASK headers into a single
# overwriting status line. Errors and the PLAY RECAP pass through verbatim so
# they remain visible inline. Contract: docs/Installer/spec.md §2.5.
#
# A bash `read -t` loop, deliberately not an awk filter. awk can only act when
# a line arrives, so its spinner sat on the last banner for the whole length
# of a silent task (wait_for at 30 s per NVMe controller, an apt install, a
# DOCA build) and a healthy run looked hung. `read -t 0.1` returns every
# 100 ms whether or not ansible printed anything, so the glyph turns at a
# constant rate with no background process and no signal handling — the two
# costs the 2026-04-28 status-bar design cited when it cut the constant-rate
# spinner. On a timeout bash leaves the bytes read so far in the variable and
# the next read continues the same line, so a banner split across the window
# is reassembled before it is parsed. Safe under errexit: every read failure
# is caught with `||`, and the function always returns 0.
# ═══════════════════════════════════════════════════════════════════════════════
_xinas_ticker_draw() {
    # \r = carriage return; \033[K = clear to end of line
    printf '\r\033[K %s %s\033[K' "$1" "$2"
}

_xinas_playbook_ticker() {
    local -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0 status='Starting…' partial='' line='' t='' rc=0
    local in_recap=0 emitted=0

    while :; do
        line=''
        rc=0
        IFS= read -r -t 0.1 line || rc=$?
        if (( rc > 128 )); then
            # Timer tick with no complete line yet: keep what arrived so far
            # and turn the glyph. Nothing is drawn once the recap has started.
            partial+=$line
            if (( ! in_recap )); then
                i=$(( (i + 1) % ${#frames[@]} ))
                _xinas_ticker_draw "${frames[i]}" "$status"
                emitted=1
            fi
            continue
        fi
        line=$partial$line
        partial=''
        # Any other non-zero rc is EOF. An unterminated final line still
        # arrives here with rc != 0 and is handled before the loop ends.
        if (( rc != 0 )) && [[ -z $line ]]; then
            break
        fi
        # Strip leading whitespace, the awk anchors' ^[[:space:]]*.
        t=${line#"${line%%[![:space:]]*}"}
        if (( in_recap )); then
            # Pass recap host lines through verbatim
            printf '%s\n' "$line"
            emitted=1
        elif [[ $t == 'PLAY RECAP'* ]]; then
            printf '\n%s\n' "$line"
            emitted=1
            in_recap=1
        elif [[ $t == 'PLAY ['* || $t == 'TASK ['* ]]; then
            # "PLAY [name] ****" -> "PLAY [name]"
            status=${t%%]*}]
            i=$(( (i + 1) % ${#frames[@]} ))
            _xinas_ticker_draw "${frames[i]}" "$status"
            emitted=1
        elif [[ $line == fatal:* || $line == failed:* || $line == unreachable:* || $line == *ERROR!* ]]; then
            printf '\n%s\n' "$line"
            emitted=1
        fi
        # All other lines: swallow (full content is in the install log file)
        if (( rc != 0 )); then
            break
        fi
    done
    if (( emitted )); then
        printf '\n'
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# _xinas_install_report — print the post-install role report (spec §2.9)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Renders /var/lib/xinas/install-state.json (or $XINAS_INSTALL_STATE_PATH)
# with xinas_menu/install_report.py under the SYSTEM python3: on a fresh
# install this runs before the xinas_menu role has created the management
# venv. The renderer is standard-library only for exactly that reason.
# Never fails the caller — the report must not change the install's status.
#
# Usage:  _xinas_install_report <ansible-rc> <log-path> <launch-epoch>
_xinas_install_report() {
    local rc="$1" log_path="$2" since="$3"
    local lib_dir renderer state_path
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    renderer="$lib_dir/../xinas_menu/install_report.py"
    state_path="${XINAS_INSTALL_STATE_PATH:-/var/lib/xinas/install-state.json}"
    if [ -r "$renderer" ] && command -v python3 >/dev/null 2>&1; then
        python3 "$renderer" --state "$state_path" --exit-code "$rc" \
            --log "$log_path" --since "$since" && return 0
    fi
    printf '  Install report unavailable; per-role state is in %s, full log in %s\n' \
        "$state_path" "$log_path"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# xinas_run_playbook — wraps ansible-playbook with persistent log + failure prompt
# ═══════════════════════════════════════════════════════════════════════════════
#
# Tees ansible-playbook output to /var/log/xinas/install.log (falling back to
# /tmp/xinas-install.log when the primary path is not writable). On non-zero
# exit, shows a whiptail menu offering Collect Diagnostics (runs
# collect_data.sh to write a local archive), View Log, or Continue.
#
# Usage:  xinas_run_playbook <playbook> [args...]
# Returns: ansible-playbook's exit code (not tee's).
xinas_run_playbook() {
    # Both bash menus run under `set -euo pipefail`. Without disabling errexit
    # and pipefail here, the moment ansible-playbook returns non-zero the
    # pipeline `ansible-playbook ... | tee` propagates the failure (pipefail)
    # and errexit aborts the entire script — before we can capture the exit
    # code or show the support msg_box. Save the caller's options, disable
    # ours for the run, restore on function exit.
    local log_path rc=0
    local _saved_e=0 _saved_pipefail=0
    [[ $- == *e* ]] && _saved_e=1
    shopt -qo pipefail && _saved_pipefail=1
    set +e
    set +o pipefail

    if mkdir -p /var/log/xinas 2>/dev/null && touch /var/log/xinas/install.log 2>/dev/null; then
        log_path=/var/log/xinas/install.log
    else
        log_path=/tmp/xinas-install.log
        : >>"$log_path" 2>/dev/null || true
    fi

    {
        printf '\n=== %s | argv: ansible-playbook %s | cwd: %s ===\n' \
            "$(date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z')" "$*" "$PWD"
    } >>"$log_path" 2>/dev/null || true

    # Run the ansible pipeline in the BACKGROUND and wait for it, so a SIGTERM /
    # SIGINT to the menu (e.g. `pkill -f startup_menu.sh`, Ctrl-C) interrupts the
    # wait and fires startup_menu.sh's descendant-kill trap — tearing down
    # ansible-playbook and its apt/dpkg children instead of orphaning them with
    # the dpkg lock held (finding #8). A *foreground* pipeline would defer the
    # trap until ansible exits, which is exactly that bug. The inner
    # `echo $? >"$_rc_file"` captures ansible's own exit code (not tee's).
    local _rc_file; _rc_file=$(mktemp 2>/dev/null || echo "/tmp/.xinas_rc.$$")
    # Launch time, so the post-run report can tell this run's install state
    # from a file an earlier install left behind (§2.9).
    local _run_started; _run_started=$(date +%s)
    if [ -t 1 ]; then
        # The ticker only recognizes the *default* stdout callback's
        # "PLAY [...]" / "TASK [...]" banners. ansible.cfg pins
        # stdout_callback=minimal (compact logs for the unattended path, §7),
        # whose output carries none of those tokens — the ticker would swallow
        # 100% of it and the operator would stare at a blank screen ("status is
        # not shown"). Force the default callback for the interactive run so the
        # banners exist. Do NOT also force color: ANSI codes emitted before
        # "PLAY"/"TASK" would break the ticker's `^…PLAY \[` anchors. The Python
        # TUI does the identical override in
        # xinas_menu/screens/startup/playbook_screen.py.
        { ANSIBLE_STDOUT_CALLBACK=default ansible-playbook "$@" 2>&1; echo "$?" >"$_rc_file"; } \
            | tee -a "$log_path" | _xinas_playbook_ticker &
        wait $! 2>/dev/null
    else
        # Non-TTY (CI, redirected install): preserve verbose passthrough and
        # honor ansible.cfg's stdout_callback (minimal) for compact logs.
        { ansible-playbook "$@" 2>&1; echo "$?" >"$_rc_file"; } | tee -a "$log_path" &
        wait $! 2>/dev/null
    fi
    rc=$(cat "$_rc_file" 2>/dev/null || echo 1)
    rm -f "$_rc_file"

    # Post-install role report (docs/Installer/spec.md §2.9): one line per
    # role, always — on success as well as on failure — so "everything ran"
    # is shown as a list, not implied by the banner that follows. Printed
    # before the failure dialog so the operator reads it first. Only install
    # runs (the menus export XINAS_RECORD_INSTALL_STATE=1) get a report; a
    # day-2 run recorded nothing and would only be told "No roles ran".
    if [ "${XINAS_RECORD_INSTALL_STATE:-}" = "1" ]; then
        echo ""
        _xinas_install_report "$rc" "$log_path" "$_run_started"
        echo ""
    fi

    if [ "$rc" -ne 0 ]; then
        while true; do
            local choice=""
            if command -v whiptail >/dev/null 2>&1; then
                choice=$(whiptail --title "Installation Failed" \
                    --menu "Installation failed (exit ${rc}).\n\nFull log: ${log_path}" \
                    16 70 3 \
                    "collect" "Collect Diagnostics (writes a local archive)" \
                    "view"    "View Log (opens less +G on full output)" \
                    "close"   "Continue (return to menu)" \
                    3>&1 1>&2 2>&3) || choice="close"
            else
                # No whiptail (very rare — e.g. very early bootstrap before
                # prepare_system.sh installed it). Fall back to plain prompt.
                printf '\n  Installation failed (exit %s).\n' "$rc" >&2
                printf '  [c]ollect logs / [v]iew log / [q]uit: ' >&2
                read -r ans
                case "$ans" in
                    c|C) choice="collect" ;;
                    v|V) choice="view" ;;
                    *)   choice="close" ;;
                esac
            fi

            case "$choice" in
                view)
                    if [ -r "$log_path" ] && command -v less >/dev/null 2>&1; then
                        less +G "$log_path"
                    elif [ -r "$log_path" ]; then
                        # less missing — fall back to whiptail textbox if available
                        if command -v whiptail >/dev/null 2>&1; then
                            whiptail --title "Install Log" --textbox "$log_path" 24 100
                        else
                            printf '\n  Log file: %s\n' "$log_path" >&2
                        fi
                    fi
                    # Loop back to dialog
                    ;;
                collect)
                    if [ -x ./collect_data.sh ]; then
                        ./collect_data.sh || true
                    else
                        printf '\n  collect_data.sh not found (expected at repo root).\n' >&2
                    fi
                    # Loop back to the dialog (same as view), so the operator
                    # can then View Log or Continue. Runs from the repo root,
                    # matching how both menus invoke ./collect_data.sh.
                    ;;
                close|*)
                    break
                    ;;
            esac
        done
    fi

    # Restore caller's shell options before returning.
    [[ $_saved_pipefail -eq 1 ]] && set -o pipefail
    [[ $_saved_e -eq 1 ]] && set -e
    return "$rc"
}
