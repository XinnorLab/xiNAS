"""
/etc/idmapd.conf in-place editor.

Updates the `Domain = <fqdn>` setting under the `[General]` section while
preserving the rest of the file (comments, other keys, other sections).

* If a `Domain` key already exists under `[General]`, only its value is
  rewritten in place (the existing line's indentation and key casing are kept).
* If `[General]` exists but has no `Domain` key, the line is inserted at the
  end of that section.
* If `[General]` is absent, the section is created (at the top of the file) and
  the `Domain` line added under it.

Mirrors `nfs_conf.py`: a per-file `fcntl.LOCK_EX` lock plus an atomic write via
`mkstemp` + `os.replace`. No service restart — `nfs-idmapd` re-reads the file.

`set_idmapd_domain` accepts overridable `conf_path` / `lock_path` keyword
arguments (defaulting to the real paths) so tests can point at temp files
without touching `/etc` or `/run`.
"""

import fcntl
import logging
import os
import re
import shutil
import tempfile

IDMAPD_CONF_PATH = "/etc/idmapd.conf"
LOCK_PATH = "/run/xinas-nfs-idmap.lock"

# A `Domain = ...` assignment line (any leading whitespace, case-insensitive key).
_DOMAIN_RE = re.compile(r"^\s*Domain\s*=.*$", re.IGNORECASE)

log = logging.getLogger("nfs_idmap")


def _with_lock(lock_path: str, fn):
    with open(lock_path, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _read_lines(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return f.read().splitlines()


def _section_of(line: str) -> str | None:
    s = line.strip()
    if s.startswith("[") and s.endswith("]"):
        return s[1:-1].strip().lower()
    return None


def _set_domain(lines: list[str], domain: str) -> list[str]:
    """Return a copy of *lines* with the `[General]` Domain set to *domain*.

    Rewrites an existing Domain line under `[General]` in place (preserving its
    indentation and key spelling); otherwise inserts it at the end of
    `[General]`; creates the section at the top of the file if it is absent.
    """
    out = list(lines)

    # First pass: rewrite an existing Domain line under [General].
    current_section: str | None = None
    general_last_idx: int | None = None  # last line index belonging to [General]
    for idx, line in enumerate(out):
        sec = _section_of(line)
        if sec is not None:
            current_section = sec
            if sec == "general":
                general_last_idx = idx
            continue
        if current_section == "general":
            general_last_idx = idx
            if _DOMAIN_RE.match(line):
                leading = line[: len(line) - len(line.lstrip())]
                # Preserve the existing key spelling (e.g. `Domain` vs `domain`).
                key = line.lstrip().split("=", 1)[0].strip() or "Domain"
                out[idx] = f"{leading}{key} = {domain}"
                return out

    # No Domain line found. Insert under [General] if it exists.
    if general_last_idx is not None:
        out.insert(general_last_idx + 1, f"Domain = {domain}")
        return out

    # [General] absent: create it at the top of the file with the Domain line.
    header = ["[General]", f"Domain = {domain}"]
    if out:
        header.append("")
    return header + out


def _atomic_write(path: str, lines: list[str]) -> None:
    body = "\n".join(lines)
    if not body.endswith("\n"):
        body += "\n"
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".",
        suffix=".tmp",
        dir=directory,
    )
    try:
        with os.fdopen(fd, "w") as f:
            f.write(body)
        if os.path.exists(path):
            shutil.copymode(path, tmp)
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def set_idmapd_domain(
    domain: str,
    *,
    conf_path: str = IDMAPD_CONF_PATH,
    lock_path: str = LOCK_PATH,
) -> None:
    """Set the `[General]` `Domain = <domain>` line in /etc/idmapd.conf.

    *domain* must be a non-empty string containing at least one `.`; otherwise
    a `ValueError` (mapped to `INVALID_ARGUMENT` by the dispatch) is raised.

    Atomic + locked, mirroring `nfs_conf.set_nfs_conf`. No service restart —
    `nfs-idmapd` re-reads the file on demand.
    """
    if not isinstance(domain, str):
        raise ValueError(f"domain must be a string, got {type(domain).__name__}")
    domain = domain.strip()
    if not domain:
        raise ValueError("domain must be a non-empty string")
    if "." not in domain:
        raise ValueError(f"domain must contain a '.' (got {domain!r})")

    def _do() -> None:
        original = _read_lines(conf_path)
        new_lines = _set_domain(original, domain)
        if new_lines != original:
            _atomic_write(conf_path, new_lines)

    _with_lock(lock_path, _do)
    return None
