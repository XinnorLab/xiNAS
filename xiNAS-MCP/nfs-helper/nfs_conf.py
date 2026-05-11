"""
/etc/nfs.conf in-place editor.

Updates section-scoped `key = value` settings while preserving the rest of
the file (comments, Ansible blockinfile markers, other sections).

* If a key already exists in the target section, only its value is rewritten.
* If the key does not exist, it is appended at the end of the section.
* If the section itself does not exist, it is appended at end of file.

`physical_cpu_count()` mirrors the same calculation the Ansible role does
(`ansible_processor_cores * ansible_processor_count`) so callers asking for
`threads=auto` get the value `nfs_server` would have used at deploy time.
"""

import fcntl
import logging
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterable, Mapping

NFS_CONF_PATH = "/etc/nfs.conf"
LOCK_PATH = "/run/xinas-nfs-conf.lock"

log = logging.getLogger("nfs_conf")


def _normalize_bool(value) -> str:
    """Render an nfs.conf boolean value as 'y' or 'n'."""
    if isinstance(value, bool):
        return "y" if value else "n"
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("y", "yes", "true", "1", "on"):
            return "y"
        if v in ("n", "no", "false", "0", "off"):
            return "n"
        return value
    return str(value)


def physical_cpu_count() -> int:
    """Physical cores across all sockets (mirrors Ansible's ansible_processor_cores * count)."""
    pairs: set[tuple[str, str]] = set()
    try:
        with open("/proc/cpuinfo") as f:
            phys = core = None
            for line in f.read().splitlines() + [""]:
                stripped = line.strip()
                if not stripped:
                    if phys is not None and core is not None:
                        pairs.add((phys, core))
                    phys = core = None
                    continue
                key, _, val = stripped.partition(":")
                key = key.strip()
                val = val.strip()
                if key == "physical id":
                    phys = val
                elif key == "core id":
                    core = val
    except OSError:
        pass
    if pairs:
        return len(pairs)
    return os.cpu_count() or 1


def _with_lock(fn):
    with open(LOCK_PATH, "w") as lf:
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


def _key_of(line: str) -> str | None:
    """Return the key from a `key = value` line (stripped, lower-cased), else None."""
    s = line.strip()
    for cc in ("#", ";"):
        if s.startswith(cc):
            return None
    if "=" not in s:
        return None
    k, _, _ = s.partition("=")
    return k.strip().lower() or None


def _apply_updates(lines: list[str], updates: Mapping[tuple[str, str], str]) -> tuple[list[str], list[dict]]:
    """Apply (section, key) -> value updates to a copy of *lines*.

    Returns (new_lines, applied) where applied is a list of dicts with
    {section, key, old, new, action} describing what changed.
    """
    out: list[str] = list(lines)
    targets = {(s.lower(), k.lower()): (s.lower(), k.lower(), v) for (s, k), v in updates.items()}
    applied: list[dict] = []

    # First pass: in-place rewrite of existing keys.
    current_section: str | None = None
    seen: set[tuple[str, str]] = set()
    for idx, line in enumerate(out):
        sec = _section_of(line)
        if sec is not None:
            current_section = sec
            continue
        if current_section is None:
            continue
        k = _key_of(line)
        if k is None:
            continue
        target_key = (current_section, k)
        if target_key in targets and target_key not in seen:
            _, _, new_val = targets[target_key]
            old_raw = line.split("=", 1)[1].strip()
            # Preserve leading whitespace (indentation) from the original line.
            leading = line[: len(line) - len(line.lstrip())]
            out[idx] = f"{leading}{k} = {new_val}"
            seen.add(target_key)
            applied.append({
                "section": current_section,
                "key": k,
                "old": old_raw,
                "new": new_val,
                "action": "updated" if old_raw != new_val else "unchanged",
            })

    # Second pass: insert remaining keys at end of their section, or create
    # the section at EOF if it does not exist.
    remaining = [t for t in targets if t not in seen]
    if not remaining:
        return out, applied

    # Build a map of section -> last-line-index-belonging-to-section (inclusive).
    section_end: dict[str, int] = {}
    current_section = None
    for idx, line in enumerate(out):
        sec = _section_of(line)
        if sec is not None:
            current_section = sec
            section_end[current_section] = idx
            continue
        if current_section is not None:
            section_end[current_section] = idx

    # Insert section-by-section so positions stay stable per section.
    by_section: dict[str, list[tuple[str, str]]] = {}
    for sec, key in remaining:
        by_section.setdefault(sec, []).append((sec, key))

    for sec, keys in by_section.items():
        if sec in section_end:
            insert_at = section_end[sec] + 1
            new_block = [f"{k} = {targets[(sec, k)][2]}" for _, k in keys]
            out[insert_at:insert_at] = new_block
            for _, k in keys:
                applied.append({
                    "section": sec, "key": k,
                    "old": "", "new": targets[(sec, k)][2],
                    "action": "inserted",
                })
            # Shift section_end for later sections to keep ordering consistent.
            shift = len(new_block)
            for s, end in section_end.items():
                if end >= insert_at:
                    section_end[s] = end + shift
        else:
            if out and out[-1].strip() != "":
                out.append("")
            out.append(f"[{sec}]")
            for _, k in keys:
                out.append(f"{k} = {targets[(sec, k)][2]}")
                applied.append({
                    "section": sec, "key": k,
                    "old": "", "new": targets[(sec, k)][2],
                    "action": "inserted",
                })

    return out, applied


def _atomic_write(path: str, lines: Iterable[str]) -> None:
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


def set_nfs_conf(updates: Mapping[tuple[str, str], str]) -> list[dict]:
    """Apply (section, key) -> value updates to /etc/nfs.conf.

    Returns a list of change descriptors for audit/return.
    """
    def _do():
        original = _read_lines(NFS_CONF_PATH)
        new_lines, applied = _apply_updates(original, updates)
        # Skip write if nothing changed.
        if any(a["action"] in ("updated", "inserted") for a in applied):
            _atomic_write(NFS_CONF_PATH, new_lines)
        return applied

    return _with_lock(_do)


def restart_nfs_server(timeout: int = 30) -> tuple[bool, str]:
    """Restart the NFS server so updated nfs.conf settings take effect."""
    try:
        r = subprocess.run(
            ["systemctl", "restart", "nfs-server"],
            capture_output=True, text=True, timeout=timeout,
        )
        if r.returncode != 0:
            return False, (r.stderr.strip() or r.stdout.strip() or "restart failed")
        return True, ""
    except FileNotFoundError:
        return False, "systemctl not found"
    except subprocess.TimeoutExpired:
        return False, "systemctl restart timed out"


def build_nfsd_updates(
    threads: int | str | None,
    rdma: bool | str | None,
) -> dict[tuple[str, str], str]:
    """Build the (section, key) -> value map for the common 'health-fix' case.

    *threads* accepts an int, the sentinel "auto" (resolved to physical CPU
    count), or None to leave untouched. *rdma* accepts a bool, a string
    representing one (y/n/true/false), or None to leave untouched.
    """
    updates: dict[tuple[str, str], str] = {}

    if threads is not None:
        if isinstance(threads, str) and threads.strip().lower() in ("auto", "cpu_count"):
            target = physical_cpu_count()
        else:
            target = int(threads)
        if target < 1:
            raise ValueError(f"threads must be >= 1, got {target}")
        # nfsd thread pool and exportd both want the same value; the Ansible
        # role sets both, and clients sometimes set only nfsd.
        updates[("nfsd", "threads")] = str(target)
        updates[("exportd", "threads")] = str(target)

    if rdma is not None:
        updates[("nfsd", "rdma")] = _normalize_bool(rdma)

    return updates
