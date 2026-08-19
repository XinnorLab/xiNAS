"""No installer script may write a git-tracked configuration file at runtime.

Writing role defaults is what let an incomplete preset delete configuration, and
what made `git checkout --force` (the update path) silently reset a node. The
property worth pinning is "nothing writes there", which is a textual claim about
the shell sources, so this is a grep rather than a behavioural test.
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
WRITE = re.compile(
    r"""(?x)
    (?: \bcp\s[^\n|;]*                       # cp <src> <tracked-dest>
      | \bmv\s[^\n|;]*                       # mv <tmp> <tracked-dest>
      | \bcat\s*>\s*                         # cat > <tracked>
      | \byq\s+(?:-i|eval\s+-i)\s[^\n|;]*    # in-place yq
      | >\s*                                 # plain redirect
    )
    ["']?                                     # optional opening quote on the dest
    (?P<target>[^\s"']*(?:collection/roles|playbooks/site\.yml)[^\s"']*)
    ["']?\s*$                                # destination = last argument
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
