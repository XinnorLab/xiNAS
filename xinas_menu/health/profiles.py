"""ProfileLoader — discovers and loads health check profile YAML files."""
from __future__ import annotations

from pathlib import Path

_SEARCH_DIRS = [
    Path(__file__).parent.parent.parent / "healthcheck_profiles",
    Path("/opt/xiNAS/healthcheck_profiles"),
    Path("/home/xinnor/xiNAS/healthcheck_profiles"),
]


def find_profiles_dir() -> Path | None:
    for d in _SEARCH_DIRS:
        if d.is_dir():
            return d
    return None


def list_profiles() -> list[str]:
    """Return profile names (without extension) found in the profiles directory."""
    d = find_profiles_dir()
    if not d:
        return []
    names = []
    for p in sorted(d.iterdir()):
        if p.suffix in (".yml", ".yaml"):
            names.append(p.stem)
    return names


def find_profile(name: str) -> Path | None:
    """Locate a profile file by name (with or without extension)."""
    d = find_profiles_dir()
    if not d:
        return None
    for ext in (".yml", ".yaml"):
        p = d / f"{name}{ext}"
        if p.exists():
            return p
    return None
