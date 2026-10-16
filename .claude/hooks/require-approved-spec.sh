#!/usr/bin/env bash
# PreToolUse hook for Edit|Write: block changes to code while the active
# feature's spec is not approved (docs/process/workflow.md, gate G3).
#
# Reads the hook JSON on stdin, takes tool_input.file_path, and allows the
# edit when the file is documentation or configuration of this process.
# For everything else it requires .claude/active-feature to name a feature
# card whose "Spec status:" line reads "approved", or to contain the word
# "trivial" (the code-only exemption in CLAUDE.md, Spec-first rule).
#
# Exit 0 = no decision (normal permission flow). Exit 2 = block, with the
# reason on stderr. No jq dependency: Claude Code on Windows runs hooks
# through Git Bash, where jq is usually absent.
set -u

input=$(cat)
file=$(printf '%s' "$input" \
  | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n 1 \
  | sed -e 's/^"file_path"[[:space:]]*:[[:space:]]*"//' -e 's/"$//' -e 's#\\\\#/#g')
[ -z "$file" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$PWD}"
root="${root//\\//}"
rel="${file#"$root"/}"
case "$rel" in
  /*) rel="${rel#/}" ;;
esac

# Documentation and process files are always editable.
case "$rel" in
  docs/*|*.md|*.MD|.claude/*|.github/*|LICENSE|.gitignore) exit 0 ;;
esac

ref="$root/.claude/active-feature"
if [ ! -f "$ref" ]; then
  echo "No active feature: put the path of a feature card (docs/features/FEAT-*.md) or the word 'trivial' into .claude/active-feature before changing code." >&2
  exit 2
fi

val=$(head -n 1 "$ref" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
case "$val" in
  trivial)
    exit 0 ;;
  "")
    echo ".claude/active-feature is empty: name a feature card or write 'trivial'." >&2
    exit 2 ;;
esac

card="$root/${val//\\//}"
if [ ! -f "$card" ]; then
  echo "Feature card not found: $val (from .claude/active-feature)." >&2
  exit 2
fi

if grep -qiE '^[*_ ]*Spec status[*_]*:[*_ ]*approved' "$card"; then
  exit 0
fi

echo "Spec for the active feature is not approved (gate G3): $val. Update the spec, get the review and the approval recorded in the card, then set 'Spec status: approved'. For a trivial code-only fix write 'trivial' into .claude/active-feature." >&2
exit 2
