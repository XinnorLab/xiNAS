#!/usr/bin/env bash
# menu_lib.sh - Colored console menu library for xiNAS
# Replaces whiptail with native bash colored menus
# Supports arrow key navigation, number keys, and Enter/Esc

# ═══════════════════════════════════════════════════════════════════════════════
# Color Definitions
# ═══════════════════════════════════════════════════════════════════════════════

# Only set colors if not already defined and terminal supports them
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

# Get terminal dimensions
_menu_get_term_size() {
    TERM_LINES=$(tput lines 2>/dev/null || echo 24)
    TERM_COLS=$(tput cols 2>/dev/null || echo 80)
}

# Move cursor to position
_menu_cursor_to() {
    printf '\033[%d;%dH' "$1" "$2"
}

# Hide cursor
_menu_cursor_hide() {
    printf '\033[?25l'
}

# Show cursor
_menu_cursor_show() {
    printf '\033[?25h'
}

# Clear from cursor to end of line
_menu_clear_line() {
    printf '\033[K'
}

# Read a single keypress (handles arrow keys)
_menu_read_key() {
    local key
    IFS= read -rsn1 key

    # Handle escape sequences (arrow keys, etc.)
    if [[ "$key" == $'\033' ]]; then
        read -rsn2 -t 0.1 key
        case "$key" in
            '[A') echo "UP" ;;
            '[B') echo "DOWN" ;;
            '[C') echo "RIGHT" ;;
            '[D') echo "LEFT" ;;
            '[H') echo "HOME" ;;
            '[F') echo "END" ;;
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

# Draw a box with title
# Usage: _menu_draw_box "title" width
_menu_draw_box() {
    local title="$1"
    local width="${2:-60}"
    local title_len=${#title}
    local padding=$(( (width - title_len - 2) / 2 ))

    # Top border
    printf "${CYAN}${BOX_TL}"
    printf '%*s' "$padding" '' | tr ' ' "$BOX_H"
    printf " ${WHITE}${BOLD}%s${NC}${CYAN} " "$title"
    printf '%*s' "$((width - padding - title_len - 2))" '' | tr ' ' "$BOX_H"
    printf "${BOX_TR}${NC}\n"
}

# Draw box bottom
_menu_draw_box_bottom() {
    local width="${1:-60}"
    printf "${CYAN}${BOX_BL}"
    printf '%*s' "$width" '' | tr ' ' "$BOX_H"
    printf "${BOX_BR}${NC}\n"
}

# Draw horizontal separator
_menu_draw_separator() {
    local width="${1:-60}"
    printf "${DIM}"
    printf '%*s' "$width" '' | tr ' ' "$BOX_LINE"
    printf "${NC}\n"
}

# ═══════════════════════════════════════════════════════════════════════════════
# menu_select - Interactive Menu with Arrow Keys
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: choice=$(menu_select "Title" "Prompt" "key1" "desc1" "key2" "desc2" ...)
# Returns: selected key via stdout, exit code 0=selected, 1=cancelled

menu_select() {
    local title="$1"
    local prompt="$2"
    shift 2

    local -a keys=()
    local -a descs=()
    local i=0

    # Parse key/description pairs
    while [[ $# -gt 0 ]]; do
        keys+=("$1")
        descs+=("${2:-}")
        shift 2 2>/dev/null || shift 1
        ((i++))
    done

    local num_items=${#keys[@]}
    [[ $num_items -eq 0 ]] && return 1

    local selected=0
    local key
    local width=60
    local start_row

    # Calculate max width needed
    for ((i=0; i<num_items; i++)); do
        local item_len=$((${#keys[$i]} + ${#descs[$i]} + 8))
        [[ $item_len -gt $width ]] && width=$item_len
    done
    [[ $width -gt 78 ]] && width=78

    # Save cursor position and hide cursor
    _menu_cursor_hide
    tput sc 2>/dev/null || printf '\033[s'

    # Render function
    _render_menu() {
        # Restore cursor position
        tput rc 2>/dev/null || printf '\033[u'

        echo ""
        _menu_draw_box "$title" "$width"
        echo ""

        # Prompt
        if [[ -n "$prompt" ]]; then
            printf "  ${WHITE}%s${NC}\n" "$prompt"
            _menu_draw_separator "$width"
            echo ""
        fi

        # Menu items
        for ((i=0; i<num_items; i++)); do
            if [[ $i -eq $selected ]]; then
                # Selected item - highlight
                printf "  ${REVERSE}${GREEN} > ${keys[$i]}${NC}${REVERSE}${GREEN}"
                if [[ -n "${descs[$i]}" ]]; then
                    printf "  %s" "${descs[$i]}"
                fi
                printf "${NC}"
                _menu_clear_line
                echo ""
            else
                # Normal item
                printf "  ${DIM}   ${NC}${YELLOW}${keys[$i]}${NC}"
                if [[ -n "${descs[$i]}" ]]; then
                    printf "  ${WHITE}%s${NC}" "${descs[$i]}"
                fi
                _menu_clear_line
                echo ""
            fi
        done

        echo ""
        _menu_draw_separator "$width"
        printf "  ${DIM}↑↓ Navigate  Enter Select  Esc Cancel${NC}\n"
    }

    # Initial render
    _render_menu

    # Input loop
    while true; do
        key=$(_menu_read_key)

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
                # Quick select by number
                local num_key=$key
                if [[ $num_key =~ ^[0-9]$ ]]; then
                    for ((i=0; i<num_items; i++)); do
                        if [[ "${keys[$i]}" == "$num_key" ]]; then
                            _menu_cursor_show
                            echo "${keys[$i]}"
                            return 0
                        fi
                    done
                fi
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# msg_box - Display Message Box
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: msg_box "Title" "Message text"

msg_box() {
    local title="$1"
    local message="$2"
    local width=60

    # Calculate width based on message
    local max_line=0
    while IFS= read -r line; do
        [[ ${#line} -gt $max_line ]] && max_line=${#line}
    done <<< "$message"
    [[ $((max_line + 6)) -gt $width ]] && width=$((max_line + 6))
    [[ $width -gt 78 ]] && width=78

    echo ""
    _menu_draw_box "$title" "$width"
    echo ""

    # Display message
    while IFS= read -r line; do
        printf "  ${WHITE}%s${NC}\n" "$line"
    done <<< "$message"

    echo ""
    _menu_draw_separator "$width"
    printf "  ${DIM}Press Enter to continue...${NC}"
    read -r
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# yes_no - Yes/No Prompt with Arrow Keys
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: if yes_no "Title" "Question?"; then ... fi
# Returns: 0 for Yes, 1 for No

yes_no() {
    local title="$1"
    local question="$2"
    local default="${3:-y}"  # y or n
    local width=55

    local selected=0  # 0=Yes, 1=No
    [[ "$default" == "n" ]] && selected=1

    _menu_cursor_hide
    tput sc 2>/dev/null || printf '\033[s'

    _render_yesno() {
        tput rc 2>/dev/null || printf '\033[u'

        echo ""
        _menu_draw_box "$title" "$width"
        echo ""

        # Question
        printf "  ${WHITE}%s${NC}\n" "$question"
        echo ""

        # Yes/No buttons
        printf "  "
        if [[ $selected -eq 0 ]]; then
            printf "${REVERSE}${GREEN}  Yes  ${NC}"
        else
            printf "${DIM}  Yes  ${NC}"
        fi
        printf "    "
        if [[ $selected -eq 1 ]]; then
            printf "${REVERSE}${RED}  No   ${NC}"
        else
            printf "${DIM}  No   ${NC}"
        fi
        echo ""
        echo ""
        _menu_draw_separator "$width"
        printf "  ${DIM}←→ Switch  Enter Confirm  Esc Cancel${NC}\n"
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
                echo ""
                return $selected
                ;;
            ESC)
                _menu_cursor_show
                echo ""
                return 1
                ;;
            [yY])
                _menu_cursor_show
                echo ""
                return 0
                ;;
            [nN])
                _menu_cursor_show
                echo ""
                return 1
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# input_box - Text Input with Default Value
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: result=$(input_box "Title" "Prompt" "default_value")
# Returns: user input via stdout, exit code 1 if cancelled

input_box() {
    local title="$1"
    local prompt="$2"
    local default="${3:-}"
    local width=60

    echo ""
    _menu_draw_box "$title" "$width"
    echo ""
    printf "  ${WHITE}%s${NC}\n" "$prompt"
    echo ""
    _menu_draw_separator "$width"

    # Show input prompt with default
    printf "  ${CYAN}>${NC} "

    local input
    if [[ -n "$default" ]]; then
        read -r -e -i "$default" input
    else
        read -r input
    fi

    local status=$?
    echo ""

    if [[ $status -ne 0 ]]; then
        return 1
    fi

    echo "$input"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# password_box - Password Input (Masked)
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: password=$(password_box "Title" "Enter password:")
# Returns: password via stdout, exit code 1 if cancelled

password_box() {
    local title="$1"
    local prompt="$2"
    local width=55

    echo ""
    _menu_draw_box "$title" "$width"
    echo ""
    printf "  ${WHITE}%s${NC}\n" "$prompt"
    echo ""
    _menu_draw_separator "$width"

    printf "  ${CYAN}>${NC} "

    local password=""
    local char

    _menu_cursor_show

    while IFS= read -rsn1 char; do
        if [[ -z "$char" ]]; then
            # Enter pressed
            break
        elif [[ "$char" == $'\177' ]] || [[ "$char" == $'\b' ]]; then
            # Backspace
            if [[ -n "$password" ]]; then
                password="${password%?}"
                printf '\b \b'
            fi
        elif [[ "$char" == $'\033' ]]; then
            # Escape - cancel
            echo ""
            return 1
        else
            password+="$char"
            printf '*'
        fi
    done

    echo ""
    echo ""
    echo "$password"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# text_box - Display File/Text with Scrolling
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: text_box "Title" "/path/to/file"
#    or: text_box "Title" "$variable_content"

text_box() {
    local title="$1"
    local content="$2"

    echo ""
    _menu_draw_box "$title" 70
    echo ""

    if [[ -f "$content" ]]; then
        # It's a file - use less with colors
        less -R "$content" 2>/dev/null || cat "$content"
    else
        # It's text content
        echo "$content" | less -R 2>/dev/null || echo "$content"
    fi

    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# info_box - Temporary Status Message (No Wait)
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: info_box "Title" "Processing..."

info_box() {
    local title="$1"
    local message="$2"
    local width=50

    echo ""
    _menu_draw_box "$title" "$width"
    echo ""
    printf "  ${YELLOW}⟳${NC} ${WHITE}%s${NC}\n" "$message"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# check_list - Multi-Select Menu
# ═══════════════════════════════════════════════════════════════════════════════
# Usage: selected=$(check_list "Title" "Prompt" "key1" "desc1" "ON" "key2" "desc2" "OFF" ...)
# Returns: space-separated list of selected keys

check_list() {
    local title="$1"
    local prompt="$2"
    shift 2

    local -a keys=()
    local -a descs=()
    local -a states=()

    # Parse key/description/state triplets
    while [[ $# -gt 0 ]]; do
        keys+=("$1")
        descs+=("${2:-}")
        states+=("${3:-OFF}")
        shift 3 2>/dev/null || break
    done

    local num_items=${#keys[@]}
    [[ $num_items -eq 0 ]] && return 1

    local selected=0
    local key
    local width=60

    _menu_cursor_hide
    tput sc 2>/dev/null || printf '\033[s'

    _render_checklist() {
        tput rc 2>/dev/null || printf '\033[u'

        echo ""
        _menu_draw_box "$title" "$width"
        echo ""

        if [[ -n "$prompt" ]]; then
            printf "  ${WHITE}%s${NC}\n" "$prompt"
            _menu_draw_separator "$width"
            echo ""
        fi

        for ((i=0; i<num_items; i++)); do
            local checkbox
            if [[ "${states[$i]}" == "ON" ]]; then
                checkbox="${GREEN}[✓]${NC}"
            else
                checkbox="${DIM}[ ]${NC}"
            fi

            if [[ $i -eq $selected ]]; then
                printf "  ${REVERSE} > %s ${keys[$i]} %s ${NC}" "$checkbox" "${descs[$i]}"
                _menu_clear_line
            else
                printf "     %s ${YELLOW}%s${NC} ${WHITE}%s${NC}" "$checkbox" "${keys[$i]}" "${descs[$i]}"
                _menu_clear_line
            fi
            echo ""
        done

        echo ""
        _menu_draw_separator "$width"
        printf "  ${DIM}↑↓ Navigate  Space Toggle  Enter Done  Esc Cancel${NC}\n"
    }

    _render_checklist

    while true; do
        key=$(_menu_read_key)

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
                # Toggle selection
                if [[ "${states[$selected]}" == "ON" ]]; then
                    states[$selected]="OFF"
                else
                    states[$selected]="ON"
                fi
                _render_checklist
                ;;
            ENTER)
                _menu_cursor_show
                # Return selected items
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
# Utility Functions for Scripts
# ═══════════════════════════════════════════════════════════════════════════════

# Show a success message (green)
msg_success() {
    printf "\n  ${GREEN}✓${NC} ${WHITE}%s${NC}\n\n" "$1"
}

# Show an error message (red)
msg_error() {
    printf "\n  ${RED}✗${NC} ${WHITE}%s${NC}\n\n" "$1"
}

# Show a warning message (yellow)
msg_warn() {
    printf "\n  ${YELLOW}⚠${NC} ${WHITE}%s${NC}\n\n" "$1"
}

# Show an info message (cyan)
msg_info() {
    printf "\n  ${CYAN}ℹ${NC} ${WHITE}%s${NC}\n\n" "$1"
}

# Print colored status
print_status() {
    local status="$1"
    local message="$2"

    case "$status" in
        ok|success|active|online|up)
            printf "${GREEN}●${NC} %s\n" "$message"
            ;;
        error|failed|offline|down)
            printf "${RED}●${NC} %s\n" "$message"
            ;;
        warn|warning|degraded)
            printf "${YELLOW}●${NC} %s\n" "$message"
            ;;
        *)
            printf "${DIM}●${NC} %s\n" "$message"
            ;;
    esac
}
