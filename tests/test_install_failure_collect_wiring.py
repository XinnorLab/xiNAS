"""WS3.5 (T10, F10): the install-failure dialog's "Collect Diagnostics"
choice must actually invoke collect_data.sh instead of falling through to
the same no-op branch as Continue (docs/Installer/spec.md §8.3), and its
label must not claim an "auto-upload" behavior that does not exist.

Behavioral: sources the real lib/menu_lib.sh and drives xinas_run_playbook
with a stubbed failing ansible-playbook, a stubbed whiptail that answers
"collect" once then "close" (so the loop-back after collect terminates),
and a stubbed ./collect_data.sh that records being invoked to a marker file.
"""

import os
import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"


def test_collect_choice_invokes_collect_data_sh(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    (bin_dir / "ansible-playbook").write_text("#!/bin/bash\nexit 1\n")
    (bin_dir / "ansible-playbook").chmod(0o755)

    counter = tmp_path / "whiptail-calls"
    (bin_dir / "whiptail").write_text(
        textwrap.dedent(f"""\
        #!/bin/bash
        n=0
        [ -f "{counter}" ] && n=$(cat "{counter}")
        n=$((n + 1))
        echo "$n" > "{counter}"
        if [ "$n" -eq 1 ]; then echo collect >&2; else echo close >&2; fi
        exit 0
        """)
    )
    (bin_dir / "whiptail").chmod(0o755)

    marker = tmp_path / "collected.marker"
    (tmp_path / "collect_data.sh").write_text(f'#!/bin/bash\ntouch "{marker}"\n')
    (tmp_path / "collect_data.sh").chmod(0o755)

    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")
    script = f'set -euo pipefail\nsource "{MENU_LIB}"\nxinas_run_playbook site.yml -i inventory\n'
    proc = subprocess.run(
        ["bash", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert marker.exists(), (
        "collect_data.sh was not invoked by the install-failure dialog's "
        f"'collect' choice.\nstdout={proc.stdout}\nstderr={proc.stderr}"
    )


def test_collect_label_does_not_claim_auto_upload():
    body = MENU_LIB.read_text()
    assert "auto-uploads" not in body.lower()
    assert '"collect"' in body  # the whiptail menu tag itself is unchanged
