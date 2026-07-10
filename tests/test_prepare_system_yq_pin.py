"""WS3.4 (T9, F2): prepare_system.sh must install yq pinned + checksum-
verified, selected by host architecture — never `releases/latest`, never
hardcoded amd64, never install an unverified download (docs/Installer/spec.md §8.1).

Behavioral: extracts the real install_yq() + YQ_* constants and runs them in a
sandbox with stubbed wget/sudo/uname. Test-controlled hashes (from a fake
payload) are substituted in so it never needs the real yq binary.
"""

import hashlib
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "prepare_system.sh"
SRC = SCRIPT.read_text()


def _extract_installer() -> str:
    # install_yq() sits inside the `if [ "$UPDATE_ONLY" -eq 0 ]; then` guard in
    # prepare_system.sh, so both the function header and its closing brace are
    # indented 4 spaces (not column 0).
    m = re.search(r"YQ_VERSION=.*?\n    install_yq\(\) \{.*?\n    \}", SRC, re.S)
    assert m, "YQ_VERSION / install_yq() block not found"
    return m.group(0)


def _run(tmp_path, *, arch, payload, tamper_hash):
    stub = tmp_path / "bin"
    stub.mkdir()
    (tmp_path / "download.bin").write_bytes(payload)
    real_sha = hashlib.sha256(payload).hexdigest()
    amd64_sha = "f" * 64 if arch != "x86_64" else ("0" * 64 if tamper_hash else real_sha)
    arm64_sha = (
        "f" * 64 if arch not in ("aarch64", "arm64") else ("0" * 64 if tamper_hash else real_sha)
    )

    (stub / "uname").write_text(f"#!/bin/bash\necho {arch}\n")
    # wget -qO <dest> <url>: copy the fake payload to <dest> ($3 here: -q, O=$1? )
    # NOTE: install_yq calls `wget -qO "$tmp" URL` => argv: -qO <tmp> <url>.
    (stub / "wget").write_text(f'#!/bin/bash\ncp "{tmp_path}/download.bin" "$2"\n')
    sudo_log = tmp_path / "sudo.log"
    (stub / "sudo").write_text(f'#!/bin/bash\necho "$@" >> "{sudo_log}"\nexit 0\n')
    for f in ("uname", "wget", "sudo"):
        (stub / f).chmod(0o755)

    installer = _extract_installer()
    installer = re.sub(
        r'YQ_SHA256_AMD64="[0-9a-f]{64}"', f'YQ_SHA256_AMD64="{amd64_sha}"', installer
    )
    installer = re.sub(
        r'YQ_SHA256_ARM64="[0-9a-f]{64}"', f'YQ_SHA256_ARM64="{arm64_sha}"', installer
    )

    snippet = f'set -euo pipefail\nRED=""; NC=""\n{installer}\ninstall_yq\n'
    # sha256sum lives in /sbin on macOS dev machines (vs. /usr/bin on Linux
    # CI) — include both so the stub PATH still finds the real sha256sum.
    env = {"PATH": f"{stub}:/usr/bin:/bin:/usr/sbin:/sbin"}
    return subprocess.run(
        ["bash", "-c", snippet], cwd=tmp_path, env=env, capture_output=True, text=True
    ), sudo_log


def test_matching_checksum_installs_amd64(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="x86_64", payload=b"real-yq-bytes-v1", tamper_hash=False)
    assert proc.returncode == 0, proc.stderr
    assert "install" in sudo_log.read_text() and "/usr/local/bin/yq" in sudo_log.read_text()


def test_matching_checksum_installs_arm64(tmp_path):
    proc, _ = _run(tmp_path, arch="aarch64", payload=b"real-yq-arm-bytes", tamper_hash=False)
    assert proc.returncode == 0, proc.stderr


def test_mismatched_checksum_aborts_without_installing(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="x86_64", payload=b"tampered", tamper_hash=True)
    assert proc.returncode != 0
    assert "checksum" in (proc.stdout + proc.stderr).lower()
    calls = sudo_log.read_text() if sudo_log.exists() else ""
    assert "install" not in calls, "must never install an unverified binary"


def test_unsupported_arch_aborts(tmp_path):
    proc, sudo_log = _run(tmp_path, arch="ppc64le", payload=b"x", tamper_hash=False)
    assert proc.returncode != 0
    assert "architecture" in (proc.stdout + proc.stderr).lower()
    calls = sudo_log.read_text() if sudo_log.exists() else ""
    assert "install" not in calls


def test_no_releases_latest_url():
    assert "releases/latest/download/yq_linux_amd64" not in SRC


def test_pinned_version_and_hashes_present():
    assert re.search(r'YQ_VERSION="v\d+\.\d+\.\d+"', SRC)
    assert re.search(r'YQ_SHA256_AMD64="[0-9a-f]{64}"', SRC)
    assert re.search(r'YQ_SHA256_ARM64="[0-9a-f]{64}"', SRC)
