"""Tests for the nfs-helper ``set_idmapd_domain`` op (S3 N2, spec §6.1).

``nfs_idmap.set_idmapd_domain`` rewrites the ``Domain =`` line under the
``[General]`` section of ``/etc/idmapd.conf`` with an atomic, locked write
(mirrors ``nfs_conf.set_nfs_conf``). These tests point ``conf_path`` /
``lock_path`` at temp files so the suite never touches ``/etc`` or ``/run``.
"""

import os
import sys

import pytest

# The nfs-helper package directory has a hyphen, so it is not importable as a
# normal module path — add it to sys.path the same way the daemon's siblings
# import each other (flat, by module name).
_HELPER_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "xiNAS-MCP",
    "nfs-helper",
)
if _HELPER_DIR not in sys.path:
    sys.path.insert(0, _HELPER_DIR)

import nfs_idmap  # noqa: E402


@pytest.fixture()
def paths(tmp_path):
    """Return (conf_path, lock_path) under a temp dir."""
    return str(tmp_path / "idmapd.conf"), str(tmp_path / "idmap.lock")


def _write(conf_path: str, text: str) -> None:
    with open(conf_path, "w") as f:
        f.write(text)


def _read(conf_path: str) -> str:
    with open(conf_path) as f:
        return f.read()


def test_rewrites_existing_domain(paths):
    conf_path, lock_path = paths
    _write(
        conf_path,
        "[General]\n"
        "Verbosity = 0\n"
        "Domain = old.com\n"
        "\n"
        "[Mapping]\n"
        "Nobody-User = nobody\n",
    )

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    assert "Domain = new.example.com" in out
    assert "old.com" not in out
    # Other keys/sections preserved verbatim.
    assert "Verbosity = 0" in out
    assert "[Mapping]" in out
    assert "Nobody-User = nobody" in out
    # Exactly one Domain line.
    assert sum(1 for ln in out.splitlines() if ln.strip().lower().startswith("domain")) == 1


def test_inserts_domain_under_existing_general(paths):
    conf_path, lock_path = paths
    _write(
        conf_path,
        "[General]\n"
        "Verbosity = 0\n"
        "\n"
        "[Mapping]\n"
        "Nobody-User = nobody\n",
    )

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    lines = out.splitlines()
    assert "Domain = new.example.com" in lines
    # Inserted under [General], before [Mapping].
    gen_idx = lines.index("[General]")
    dom_idx = lines.index("Domain = new.example.com")
    map_idx = lines.index("[Mapping]")
    assert gen_idx < dom_idx < map_idx
    assert "Verbosity = 0" in out
    assert "Nobody-User = nobody" in out


def test_creates_general_when_absent(paths):
    conf_path, lock_path = paths
    _write(conf_path, "[Mapping]\nNobody-User = nobody\n")

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    assert "[General]" in out
    assert "Domain = new.example.com" in out
    # Existing section preserved.
    assert "[Mapping]" in out
    assert "Nobody-User = nobody" in out
    # Domain belongs to [General], not [Mapping].
    lines = out.splitlines()
    assert lines.index("[General]") < lines.index("Domain = new.example.com")


def test_creates_file_when_empty(paths):
    conf_path, lock_path = paths
    _write(conf_path, "")

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    lines = out.splitlines()
    assert lines[0] == "[General]"
    assert "Domain = new.example.com" in lines


def test_creates_file_when_missing(paths):
    conf_path, lock_path = paths
    # conf_path does not exist yet.
    assert not os.path.exists(conf_path)

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    assert "[General]" in out
    assert "Domain = new.example.com" in out


def test_preserves_indented_domain_style(paths):
    """A leading-whitespace / mixed-case Domain key is matched and rewritten in place."""
    conf_path, lock_path = paths
    _write(
        conf_path,
        "[General]\n"
        "  domain = old.com\n",
    )

    nfs_idmap.set_idmapd_domain(
        "new.example.com", conf_path=conf_path, lock_path=lock_path
    )

    out = _read(conf_path)
    assert "new.example.com" in out
    assert "old.com" not in out
    assert sum(1 for ln in out.splitlines() if "=" in ln) == 1


def test_rejects_domain_without_dot(paths):
    conf_path, lock_path = paths
    _write(conf_path, "[General]\nDomain = old.com\n")

    with pytest.raises(ValueError):
        nfs_idmap.set_idmapd_domain(
            "localdomain", conf_path=conf_path, lock_path=lock_path
        )
    # File untouched on validation failure.
    assert "old.com" in _read(conf_path)


def test_rejects_empty_domain(paths):
    conf_path, lock_path = paths
    with pytest.raises(ValueError):
        nfs_idmap.set_idmapd_domain("", conf_path=conf_path, lock_path=lock_path)


def test_rejects_non_string_domain(paths):
    conf_path, lock_path = paths
    with pytest.raises((ValueError, TypeError)):
        nfs_idmap.set_idmapd_domain(None, conf_path=conf_path, lock_path=lock_path)


def test_preserves_world_readable_mode(paths):
    """The rewritten conf must stay 0644, not inherit mkstemp's 0600 — a
    root-only /etc/idmapd.conf would lock out the nfs-idmapd daemon."""
    conf_path, lock_path = paths
    # (a) an existing 0644 file stays 0644 after a rewrite.
    _write(conf_path, "[General]\nDomain = old.com\n")
    os.chmod(conf_path, 0o644)
    nfs_idmap.set_idmapd_domain("a.example.com", conf_path=conf_path, lock_path=lock_path)
    assert (os.stat(conf_path).st_mode & 0o777) == 0o644
    # (b) a freshly-created file is 0644, not 0600.
    os.unlink(conf_path)
    nfs_idmap.set_idmapd_domain("b.example.com", conf_path=conf_path, lock_path=lock_path)
    assert (os.stat(conf_path).st_mode & 0o777) == 0o644


def test_idmapd_conf_in_checksum_targets():
    """Config-history tracks /etc/idmapd.conf so the snapshot backstop is real (spec §7)."""
    from xinas_history.collector import CHECKSUM_TARGETS

    assert CHECKSUM_TARGETS.get("idmapd_conf") == "/etc/idmapd.conf"
