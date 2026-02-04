#!/usr/bin/env bash
# menu_lib.sh - Colored console menu library for xiNAS
# Replaces whiptail with native bash colored menus
# Supports arrow key navigation, number keys, and Enter/Esc

# ═══════════════════════════════════════════════════════════════════════════════
# Color Definitions
# ═══════════════════════════════════════════════════════════════════════════════

if [[ -z "${NC:-}" ]] && [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    WHITE='\033[1;37m'
    DIM='\033[2m'
    BOLD='\033[1m'
    REVERSE='\033[7m'
    NC='\033[0m'
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
    for ((i=0; i<count; i++)); do
        result+="$char"
    done
    printf '%s' "$result"
}

_menu_draw_box() {
    local title="$1"
    local width="${2:-60}"
    local title_len=${#title}
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

    # Calculate width
    for ((i=0; i<num_items; i++)); do
        local item_len=$((${#keys[$i]} + ${#descs[$i]} + 8))
        [[ $item_len -gt $width ]] && width=$item_len
    done
    [[ $width -gt 78 ]] && width=78

    _menu_cursor_hide

    _render_menu() {
        _menu_clear_screen

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"
        echo "" >/dev/tty

        if [[ -n "$prompt" ]]; then
            printf "  ${WHITE}%s${NC}\n" "$prompt" >/dev/tty
            _menu_draw_separator "$width"
            echo "" >/dev/tty
        fi

        for ((i=0; i<num_items; i++)); do
            if [[ $i -eq $selected ]]; then
                printf "  ${REVERSE}${GREEN} > %s  %s ${NC}\n" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            else
                printf "  ${DIM}   ${NC}${YELLOW}%s${NC}  ${WHITE}%s${NC}\n" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            fi
        done

        echo "" >/dev/tty
        _menu_draw_separator "$width"
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

    # Interpret \n escape sequences
    message=$(echo -e "$message")

    # Calculate width based on content
    local max_line=0
    while IFS= read -r line; do
        [[ ${#line} -gt $max_line ]] && max_line=${#line}
    done <<< "$message"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))

    _menu_clear_screen
    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Content lines with side borders
    while IFS= read -r line; do
        local line_len=${#line}
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

    _menu_cursor_hide

    _render_yesno() {
        _menu_clear_screen

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"
        echo "" >/dev/tty
        printf "  ${WHITE}%s${NC}\n" "$question" >/dev/tty
        echo "" >/dev/tty

        printf "  " >/dev/tty
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
        echo "" >/dev/tty
        echo "" >/dev/tty
        _menu_draw_separator "$width"
        printf "  ${DIM}←→ Switch  Enter Confirm${NC}\n" >/dev/tty
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

    local prompt_len=${#prompt}
    [[ $((prompt_len + 6)) -gt $width ]] && width=$((prompt_len + 6))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))
    local padding=$((inner_width - prompt_len - 2))
    [[ $padding -lt 0 ]] && padding=0

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Prompt line with borders
    printf "${CYAN}${BOX_V}${NC} ${WHITE}%s${NC}" "$prompt" >/dev/tty
    printf '%*s' "$padding" '' >/dev/tty
    printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty

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

    local input
    if [[ -n "$default" ]]; then
        read -r -e -i "$default" input </dev/tty
    else
        read -r input </dev/tty
    fi

    echo "" >/dev/tty
    echo "$input"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# password_box - Password Input (Masked)
# ═══════════════════════════════════════════════════════════════════════════════

password_box() {
    local title="$1"
    local prompt="$2"
    local width=55

    _menu_clear_screen

    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"
    echo "" >/dev/tty
    printf "  ${WHITE}%s${NC}\n" "$prompt" >/dev/tty
    echo "" >/dev/tty
    _menu_draw_separator "$width"
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
# info_box - Temporary Status Message (No Wait) with Full Border
# ═══════════════════════════════════════════════════════════════════════════════

info_box() {
    local title="$1"
    local message="$2"
    local width=50

    local msg_len=${#message}
    [[ $((msg_len + 8)) -gt $width ]] && width=$((msg_len + 8))
    [[ $width -gt 78 ]] && width=78

    local inner_width=$((width - 2))
    local content="⟳ $message"
    local content_len=$((${#message} + 2))
    local padding=$((inner_width - content_len - 2))
    [[ $padding -lt 0 ]] && padding=0

    _menu_clear_screen
    echo "" >/dev/tty
    _menu_draw_box "$title" "$width"

    # Content with borders
    printf "${CYAN}${BOX_V}${NC} ${YELLOW}⟳${NC} ${WHITE}%s${NC}" "$message" >/dev/tty
    printf '%*s' "$padding" '' >/dev/tty
    printf " ${CYAN}${BOX_V}${NC}\n" >/dev/tty

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

    _menu_cursor_hide

    _render_checklist() {
        _menu_clear_screen

        echo "" >/dev/tty
        _menu_draw_box "$title" "$width"
        echo "" >/dev/tty

        if [[ -n "$prompt" ]]; then
            printf "  ${WHITE}%s${NC}\n" "$prompt" >/dev/tty
            _menu_draw_separator "$width"
            echo "" >/dev/tty
        fi

        for ((i=0; i<num_items; i++)); do
            local checkbox
            if [[ "${states[$i]}" == "ON" ]]; then
                checkbox="${GREEN}[✓]${NC}"
            else
                checkbox="${DIM}[ ]${NC}"
            fi

            if [[ $i -eq $selected ]]; then
                printf "  ${REVERSE} > %b %s %s ${NC}\n" "$checkbox" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            else
                printf "     %b ${YELLOW}%s${NC} ${WHITE}%s${NC}\n" "$checkbox" "${keys[$i]}" "${descs[$i]}" >/dev/tty
            fi
        done

        echo "" >/dev/tty
        _menu_draw_separator "$width"
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
