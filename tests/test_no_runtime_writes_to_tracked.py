"""Grep-based pin against runtime writes to git-tracked configuration files.

Writing role defaults is what let an incomplete preset delete configuration,
and what made `git checkout --force` (the update path) silently reset a node
(docs/superpowers/specs/2026-08-18-preset-overlay-design.md §1). Both real
historical bugs that made that happen (configure_hostname.sh, then
configure_raid.sh) wrote through a `vars_file="collection/roles/.../
defaults/main.yml"` variable rather than a literal path at the write site
itself.

This is a textual check, not a behavioural one, and it does not prove "nothing
writes a tracked file at runtime" — only that no script in SCRIPTS repeats one
of two specific textual shapes. The WRITE regex below flags (a) a literal
tracked-path write — `cp`/`mv`/`cat >`/`yq -i`/a plain redirect whose
destination IS the tracked path — and (b) a tracked path literally assigned
to a variable (`word="collection/roles/..."` or `.../playbooks/site.yml"`),
the shape both historical bugs took at their assignment site, one line away
from the actual write. It does NOT trace dataflow: a path built by string
concatenation, read out of a config value, or split across more than the one
line the assignment happens on would not be caught, and neither would a
write reached through a variable whose assignment this file's grep never
sees (e.g. because it lives in a sourced file outside SCRIPTS). Passing this
test is evidence, not proof, that nothing writes a tracked file at runtime.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

SCRIPTS = [
    "startup_menu.sh",
    "simple_menu.sh",
    "autoinstall.sh",
    "configure_raid.sh",
    "configure_network.sh",
    "configure_nfs_exports.sh",
    "configure_hostname.sh",
    "lib/xinas_config.sh",
]

# Writers, not readers. Two exclusions matter: `yq eval` / `grep` against a role
# default is a read, and for `cp`/`mv` the tracked path only counts when it is
# the LAST argument — `cp playbooks/site.yml <preset>/playbook.yml` reads the
# tracked file, it does not write it (lib/xinas_config.sh does exactly that).
#
# The optional opening quote before the target group matters: `cp`/`mv`/`yq -i`
# swallow a leading quote for free because their own prefix (`[^\n|;]*`) is
# greedy and backtracks past it, but `cat >`/the bare `>` branch have no such
# prefix, so `cat "$tmp" > "$REPO_DIR/collection/roles/.../main.yml"` — an
# entirely idiomatic, quoted redirect — would otherwise slip past unmatched.
# Verified by construction: without this quote, that exact line passes silently.
#
# The second top-level alternative is not a write-prefix at all: it flags a
# tracked path literally assigned to a variable, e.g.
# `vars_file="collection/roles/common/defaults/main.yml"`. Neither historical
# bug wrote a tracked path at its write site (`mv "$tmp" "$vars_file"` never
# contains "collection/roles"); both assigned it one line earlier. This does
# not trace where the variable is later used - it cannot, by grep - it only
# pins the assignment line itself, which is where both real bugs originated
# and is cheap to catch directly.
#
# That alternative needs its own, narrower target check rather than reusing
# `target` above (Python's `re` also rejects a duplicate group name, even in
# a different alternative branch): the shared "contains collection/roles
# anywhere" check is deliberately broad for a write-prefixed line (§2 goal 4
# forbids writing anything under collection/roles, not just defaults/main.yml
# - templates/ counts too), but for a bare `word=` assignment that same
# breadth is a false positive - `desc_file="$REPO_DIR/collection/roles/
# ${r}/README.md"` (startup_menu.sh, a legitimate read) contains
# "collection/roles" and would otherwise match. `assigned_target` requires
# the assigned value to actually END in `defaults/main.yml` or
# `playbooks/site.yml`, which a README path does not.
WRITE = re.compile(
    r"""(?x)
    (?:
        (?: \bcp\s[^\n|;]*                       # cp <src> <tracked-dest>
          | \bmv\s[^\n|;]*                       # mv <tmp> <tracked-dest>
          | \bcat\s*>\s*                         # cat > <tracked>
          | \byq\s+(?:-i|eval\s+-i)\s[^\n|;]*    # in-place yq
          | >\s*                                 # plain redirect
        )
        ["']?                                     # optional opening quote on the dest
        (?P<target>[^\s"']*(?:collection/roles|playbooks/site\.yml)[^\s"']*)
        ["']?\s*$                                # destination = last argument
      |
        ^\s*\w+=["']?                             # var=<tracked path>: the assignment
                                                    # site of a write reached through a
                                                    # variable, not a write itself
        (?P<assigned_target>[^\s"']*(?:defaults/main\.yml|playbooks/site\.yml))
        ["']?\s*$                                # whole assigned value, not a substring
    )
    """
)


def test_no_script_writes_a_tracked_config_file():
    offenders: list[str] = []
    for name in SCRIPTS:
        text = (REPO / name).read_text()
        for lineno, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if WRITE.search(line):
                offenders.append(f"{name}:{lineno}: {line.strip()}")
    assert not offenders, "runtime writes to tracked config:\n" + "\n".join(offenders)


def test_write_regex_flags_a_tracked_path_assigned_to_a_variable():
    """Both real historical bugs (configure_hostname.sh, configure_raid.sh)
    wrote through a `vars_file=".../defaults/main.yml"` variable rather than
    a literal path at the write site itself (`mv "$tmp" "$vars_file"`) - a
    shape the write-prefix alternatives above cannot see at all, because the
    write line never contains the substring "collection/roles"; only the
    assignment line, earlier in the script, does. Constructed directly
    against the compiled regex rather than against SCRIPTS: the repo
    contains no such assignment today (that is what keeps
    test_no_script_writes_a_tracked_config_file passing), so a construction
    that could only be demonstrated against a live offending file would
    never itself go red first - the point of this test is to pin the
    regex's own capability, independent of what happens to be in the tree
    right now.
    """
    offenders = [
        'vars_file="collection/roles/common/defaults/main.yml"',
        "dest='collection/roles/net_controllers/defaults/main.yml'",
        "vars_file=collection/roles/raid_fs/defaults/main.yml",
        'pb="playbooks/site.yml"',
    ]
    for line in offenders:
        assert WRITE.search(line), f"assignment of a tracked path not flagged: {line!r}"


def test_write_regex_does_not_flag_a_read_via_variable():
    """The assignment alternative above must not turn every line that merely
    mentions a variable pointing at a tracked path into a false positive -
    only the assignment itself, whose value IS the tracked path, should
    match. A regex that dropped the `^\\s*\\w+=` anchor (matching the
    substring anywhere) would also flag these.
    """
    safe = [
        'role=$(basename "$(dirname "$(dirname "$f")")")',
        'vars_file="$XINAS_LOCAL_LAYER"',
        '    if ! has=$(yq eval "has(\\"${key}\\")" "$f"); then',
        'cp "$REPO_DIR/playbooks/site.yml" "$pdir/playbook.yml"',
    ]
    for line in safe:
        assert not WRITE.search(line), f"false positive on a read: {line!r}"
