# xiRAID Hardware-Key Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the opaque, stale `./hwkey` ELF binary with a source-controlled, dependency-free tool that computes the correct xiRAID 4.4 **v2** hardware key, as a drop-in at the same path.

**Architecture:** One implementation of the algorithm in a stdlib-only library (`xinas_menu/utils/hwkey.py`), consumed by two artifacts: the root `hwkey` executable (thin CLI that loads the library by file path so it never needs the TUI's third-party deps) and the Python TUI (`license.py` local-compute fallback). Installer roles and menus keep calling `./hwkey` unchanged.

**Tech Stack:** Python ≥3.10 (standard library only for the tool), pytest, ruff, pyright. Target platform Ubuntu 22.04/24.04, x86-64.

**Spec:** [docs/Installer/hwkey-spec.md](../../Installer/hwkey-spec.md)

## Global Constraints

- **Python floor:** `>=3.10`. The `hwkey` library and executable use the **standard library only** — no third-party imports (they must run during the `common` role, before TUI deps exist).
- **English only** for all committed artifacts (code, comments, docstrings, commit messages).
- **Algorithm is fixed** by xiRAID 4.4.1: `GOLDEN_RATIO_64 = 0x61C8864680B583EB`; 4096-byte zero buffer; 512 little-endian `u64` words; even word `key ^= h`, odd word `key ^= (h << 32) mod 2^64`; render `"%08X"` (uppercase, min width 8). Absent DMI field → literal bytes `(null)`. Do not "improve" it.
- **DMI source:** `/sys/class/dmi/id/{product_serial,product_uuid,board_serial}`; strip one trailing `\n`; `ENOENT` → `(null)`; `PermissionError` → fatal (never `(null)`). Root required for real values.
- **No `Requires-Rebuild:` trailer** on any commit here — code/tool + Python only, consumed at install time.
- **Commits:** this repo requires an explicit go-ahead from the user before each commit (user workflow rule). Treat every "Commit" step as *stage, then request the user's go-ahead* — do not push commits autonomously.
- **Verification before "done"** (mirrors CI, run from repo root):
  ```bash
  pytest tests/test_hwkey_algorithm.py -v
  ruff check          xinas_menu xinas_history xiNAS-MCP/nfs-helper
  ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
  pyright             xinas_menu xinas_history xiNAS-MCP/nfs-helper
  ```

## File Structure

- **Create** `xinas_menu/utils/hwkey.py` — the shared library: algorithm, DMI reading, module cross-check, `HwkeyResult`/`DmiField` dataclasses, `GOLDEN_VECTORS`, `HwkeyError`, `best_effort_v2_hwkey`.
- **Create** `tests/test_hwkey_algorithm.py` — unit tests for the library and the executable (fake `--sysfs-root`).
- **Replace** `hwkey` (repo root) — delete the ELF binary; add a `#!/usr/bin/env python3` executable (mode 0755) that loads the library by path and implements the CLI.
- **Modify** `xinas_menu/screens/license.py` — local-compute fallback when the module key is unavailable.
- **Unchanged (verified, not edited):** `collection/roles/common/tasks/main.yml`, `simple_menu.sh`, `startup_menu.sh`, `xinas_menu/screens/collect_logs.py`, `tests/test_hwkey_guard.py`.

---

### Task 1: Shared library — core algorithm (compute + format)

**Files:**
- Create: `xinas_menu/utils/hwkey.py`
- Test: `tests/test_hwkey_algorithm.py`

**Interfaces:**
- Produces:
  - `compute_hwkey(product_serial: bytes, product_uuid: bytes, board_serial: bytes, *, legacy: bool = False) -> int`
  - `format_hwkey(key: int) -> str`
  - `GOLDEN_VECTORS: list[tuple[bytes, bytes, bytes, str, str]]` — `(ps, uu, bs, v2_hex, legacy_hex)`; absent fields are represented as the literal `b"(null)"`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_hwkey_algorithm.py
"""Golden-vector + behavior tests for the xiRAID hwkey library and executable.

The expected values were produced by an independent C transcription of the
xiRAID 4.4.1 kernel functions (rdx_license_init_hwkey / rdx_license_hash_buf64
/ rdx_hash_64) and matched byte-for-byte by the Python port. See
docs/Installer/hwkey-spec.md.
"""

from xinas_menu.utils.hwkey import GOLDEN_VECTORS, compute_hwkey, format_hwkey


def test_golden_vectors_v2_and_legacy():
    assert GOLDEN_VECTORS, "vectors must be present"
    for ps, uu, bs, v2, legacy in GOLDEN_VECTORS:
        assert format_hwkey(compute_hwkey(ps, uu, bs)) == v2
        assert format_hwkey(compute_hwkey(ps, uu, bs, legacy=True)) == legacy


def test_format_min_width_8_uppercase():
    # 0x1234 -> zero-padded to 8 uppercase hex digits
    assert format_hwkey(0x1234) == "00001234"
    # a full-width value is not truncated
    assert format_hwkey(0xD5E37EE32F065F31) == "D5E37EE32F065F31"


def test_v2_ignores_uuid_but_legacy_does_not():
    ps, bs = b"SN", b"BD"
    a = compute_hwkey(ps, b"aaaaaaaa-0000-0000-0000-000000000000", bs)
    b = compute_hwkey(ps, b"bbbbbbbb-1111-1111-1111-111111111111", bs)
    assert a == b  # v2 does not read the UUID
    la = compute_hwkey(ps, b"aaaaaaaa-0000-0000-0000-000000000000", bs, legacy=True)
    lb = compute_hwkey(ps, b"bbbbbbbb-1111-1111-1111-111111111111", bs, legacy=True)
    assert la != lb  # legacy does
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'xinas_menu.utils.hwkey'`.

- [ ] **Step 3: Write minimal implementation**

```python
# xinas_menu/utils/hwkey.py
"""xiRAID (>=4.4) hardware-key computation — stdlib only.

Reproduces, in userspace and without a loaded xiRAID module, the hardware key
the kernel derives from SMBIOS/DMI identifiers. The value sent to Xinnor for a
license is the v2 key (product_serial + board_serial). A legacy key
(product_serial + lower(product_uuid) + board_serial) is kept for pre-4.4
license continuity. Algorithm source: xiRAID module/xrd_license.c,
module/xrd_hash.h. See docs/Installer/hwkey-spec.md.

No third-party imports: this module is imported by the root ``hwkey``
executable during the Ansible ``common`` role, before the TUI's dependencies
are installed.
"""

from __future__ import annotations

GOLDEN_RATIO_64 = 0x61C8864680B583EB
_MASK64 = (1 << 64) - 1
_PAGE_SIZE = 4096
_WORDS = _PAGE_SIZE // 8  # 512
_UUID_STRING_LEN = 36
NULL_SUBSTITUTE = b"(null)"  # kernel snprintf("%s", NULL)


def _rdx_hash_64(val: int) -> int:
    """rdx_hash_64(val, 64): val * GOLDEN_RATIO_64, truncated to 64 bits."""
    return (val * GOLDEN_RATIO_64) & _MASK64


def _null_terminated(data: bytes) -> bytes:
    """Emulate %s stopping at the first NUL byte."""
    nul = data.find(0)
    return data if nul < 0 else data[:nul]


def _ascii_lower(data: bytes) -> bytes:
    """Lowercase ASCII A-Z only, like the kernel's tolower() loop."""
    return bytes(c + 32 if 0x41 <= c <= 0x5A else c for c in data)


def _build_buffer(
    product_serial: bytes, product_uuid: bytes, board_serial: bytes, legacy: bool
) -> bytes:
    """Assemble the 4096-byte hash input, exactly as rdx_license_init_hwkey()."""
    buf = bytearray(_PAGE_SIZE)
    off = 0

    def put(chunk: bytes) -> None:
        nonlocal off
        chunk = _null_terminated(chunk)
        n = min(len(chunk), _PAGE_SIZE - off)  # snprintf truncates to remaining space
        buf[off : off + n] = chunk[:n]
        off += n

    put(product_serial)
    if legacy:
        put(_ascii_lower(product_uuid[:_UUID_STRING_LEN]))
    put(board_serial)
    return bytes(buf)


def _hash_buf64(buf: bytes) -> int:
    """Port of rdx_license_hash_buf64(buf64, 512)."""
    key = 0
    for i in range(_WORDS):
        word = int.from_bytes(buf[i * 8 : i * 8 + 8], "little")
        h = _rdx_hash_64(word)
        key ^= (h << 32) & _MASK64 if i & 1 else h
    return key


def compute_hwkey(
    product_serial: bytes,
    product_uuid: bytes,
    board_serial: bytes,
    *,
    legacy: bool = False,
) -> int:
    """Return the u64 hardware key for the given DMI byte strings."""
    return _hash_buf64(_build_buffer(product_serial, product_uuid, board_serial, legacy))


def format_hwkey(key: int) -> str:
    """Render like the kernel's snprintf("%08llX", key): uppercase, min width 8."""
    return "%08X" % key


# Validated against the C oracle; absent fields shown as the literal b"(null)".
GOLDEN_VECTORS: list[tuple[bytes, bytes, bytes, str, str]] = [
    (b"SN12345", b"550e8400-e29b-41d4-a716-446655440000", b"BOARDXYZ",
     "D5E37EE32F065F31", "B0D44633EF11F8F2"),
    (b"A", b"DEADBEEF-0000-1111-2222-333344445555", b"B",
     "868845157A1914AB", "48FE908EC7902EC"),
    (b"seven77", b"ABCDEF01-2345-6789-ABCD-EF0123456789", b"boardserial-longer-than-eight",
     "D3850A20BAA471F9", "6E7567410166FD4F"),
    (b"", b"00000000-0000-0000-0000-000000000000", b"",
     "00000000", "6B949A616B13CC10"),
    (NULL_SUBSTITUTE, NULL_SUBSTITUTE, NULL_SUBSTITUTE,
     "32389975897296B8", "6C21692ED7C6DC9C"),
    (b"To Be Filled By O.E.M.", b"12345678-90AB-CDEF-1234-567890ABCDEF", b"To Be Filled By O.E.M.",
     "E35A8EA7DFA8162E", "265219800E1ACCB6"),
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint/type the new module, then commit**

Run: `ruff check xinas_menu && ruff format --check xinas_menu && pyright xinas_menu/utils/hwkey.py`
Expected: clean.

```bash
git add xinas_menu/utils/hwkey.py tests/test_hwkey_algorithm.py
git commit -m "feat(hwkey): add xiRAID 4.4 v2/legacy hardware-key algorithm library"
```

---

### Task 2: Shared library — DMI reading, module cross-check, result aggregation

**Files:**
- Modify: `xinas_menu/utils/hwkey.py`
- Test: `tests/test_hwkey_algorithm.py`

**Interfaces:**
- Consumes: `compute_hwkey`, `format_hwkey`, `NULL_SUBSTITUTE` (Task 1).
- Produces:
  - `class HwkeyError(Exception)`
  - `@dataclass class DmiField` with `name: str`, `value: bytes`, `present: bool`, and `display: str` property.
  - `read_dmi_field(name: str, *, sysfs_root: str = "/") -> DmiField`
  - `read_module_hwkey(module: str = "xiraid", *, sysfs_root: str = "/") -> str | None`
  - `@dataclass class HwkeyResult` with `v2: str`, `legacy: str`, `dmi: dict[str, str]`, `present: dict[str, bool]`, `module_hwkey: str | None`, `module_matches: bool | None`.
  - `compute_result(*, sysfs_root: str = "/", module: str | None = "xiraid") -> HwkeyResult`
  - `best_effort_v2_hwkey(*, sysfs_root: str = "/") -> str | None` — v2 hex or `None`, never raises.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_hwkey_algorithm.py
import os
import stat
import pytest
from xinas_menu.utils.hwkey import (
    HwkeyError,
    best_effort_v2_hwkey,
    compute_result,
    read_dmi_field,
)


def _fake_dmi(root, *, serial="SN12345",
              uuid="550e8400-e29b-41d4-a716-446655440000",
              board="BOARDXYZ", module_key=None):
    d = os.path.join(root, "sys/class/dmi/id")
    os.makedirs(d, exist_ok=True)
    if serial is not None:
        open(os.path.join(d, "product_serial"), "w").write(serial + "\n")
    if uuid is not None:
        open(os.path.join(d, "product_uuid"), "w").write(uuid + "\n")
    if board is not None:
        open(os.path.join(d, "board_serial"), "w").write(board + "\n")
    if module_key is not None:
        m = os.path.join(root, "sys/module/xiraid/parameters")
        os.makedirs(m, exist_ok=True)
        open(os.path.join(m, "hwkey"), "w").write(module_key)


def test_dmi_strips_single_newline(tmp_path):
    _fake_dmi(tmp_path)
    f = read_dmi_field("product_serial", sysfs_root=str(tmp_path))
    assert f.present and f.value == b"SN12345"


def test_dmi_absent_maps_to_null(tmp_path):
    _fake_dmi(tmp_path, board=None)  # no board_serial file
    f = read_dmi_field("board_serial", sysfs_root=str(tmp_path))
    assert not f.present and f.value == b"(null)"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root bypasses file permissions, so chmod(0) would not raise",
)
def test_dmi_permission_denied_is_fatal(tmp_path):
    _fake_dmi(tmp_path)
    p = tmp_path / "sys/class/dmi/id/product_serial"
    p.chmod(0)  # remove all perms
    try:
        with pytest.raises(HwkeyError):
            read_dmi_field("product_serial", sysfs_root=str(tmp_path))
    finally:
        p.chmod(stat.S_IRUSR | stat.S_IWUSR)  # let tmp cleanup remove it


def test_compute_result_matches_vector_and_module(tmp_path):
    _fake_dmi(tmp_path, module_key="D5E37EE32F065F31")
    r = compute_result(sysfs_root=str(tmp_path))
    assert r.v2 == "D5E37EE32F065F31"
    assert r.legacy == "B0D44633EF11F8F2"
    assert r.module_hwkey == "D5E37EE32F065F31"
    assert r.module_matches is True


def test_best_effort_returns_none_on_missing_tree(tmp_path):
    # empty root: all fields absent -> still computes the "(null)" key,
    # so best_effort returns a value (fields absent is not an error).
    r = best_effort_v2_hwkey(sysfs_root=str(tmp_path))
    assert r == "32389975897296B8"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: FAIL — names not defined (`read_dmi_field`, `compute_result`, ...).

- [ ] **Step 3: Implement**

```python
# add near the top of xinas_menu/utils/hwkey.py
import os
from dataclasses import dataclass

# DMI field names, in the kernel's concatenation order.
DMI_PRODUCT_SERIAL = "product_serial"
DMI_PRODUCT_UUID = "product_uuid"
DMI_BOARD_SERIAL = "board_serial"
DEFAULT_MODULE = "xiraid"


class HwkeyError(Exception):
    """Fatal error that must not be silently turned into a wrong key."""


@dataclass
class DmiField:
    name: str
    value: bytes  # bytes actually fed to the hash (real value or b"(null)")
    present: bool  # True if read from DMI, False if substituted

    @property
    def display(self) -> str:
        if not self.present:
            return "<absent -> (null)>"
        return self.value.decode("utf-8", "replace")


def read_dmi_field(name: str, *, sysfs_root: str = "/") -> DmiField:
    path = os.path.join(sysfs_root, "sys/class/dmi/id", name)
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        return DmiField(name, NULL_SUBSTITUTE, present=False)
    except PermissionError as exc:
        raise HwkeyError(
            f"cannot read {path}: permission denied. Run as root -- DMI serial "
            "fields are root-readable only, and reading them as a normal user "
            "would silently produce the wrong hardware key."
        ) from exc
    except OSError as exc:
        raise HwkeyError(f"cannot read {path}: {exc}") from exc
    if data.endswith(b"\n"):
        data = data[:-1]  # strip exactly the one sysfs newline
    return DmiField(name, data, present=True)


def read_module_hwkey(module: str = DEFAULT_MODULE, *, sysfs_root: str = "/") -> str | None:
    path = os.path.join(sysfs_root, "sys/module", module, "parameters/hwkey")
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


@dataclass
class HwkeyResult:
    v2: str
    legacy: str
    dmi: dict[str, str]
    present: dict[str, bool]
    module_hwkey: str | None = None
    module_matches: bool | None = None


def compute_result(*, sysfs_root: str = "/", module: str | None = DEFAULT_MODULE) -> HwkeyResult:
    fields = {
        name: read_dmi_field(name, sysfs_root=sysfs_root)
        for name in (DMI_PRODUCT_SERIAL, DMI_PRODUCT_UUID, DMI_BOARD_SERIAL)
    }
    ps = fields[DMI_PRODUCT_SERIAL].value
    uu = fields[DMI_PRODUCT_UUID].value
    bs = fields[DMI_BOARD_SERIAL].value
    v2_key = compute_hwkey(ps, uu, bs)
    v2 = format_hwkey(v2_key)
    legacy = format_hwkey(compute_hwkey(ps, uu, bs, legacy=True))
    result = HwkeyResult(
        v2=v2,
        legacy=legacy,
        dmi={n: f.display for n, f in fields.items()},
        present={n: f.present for n, f in fields.items()},
    )
    if module is not None:
        live = read_module_hwkey(module, sysfs_root=sysfs_root)
        if live is not None:
            result.module_hwkey = live
            try:
                result.module_matches = int(live, 16) == v2_key
            except ValueError:
                result.module_matches = False
    return result


def best_effort_v2_hwkey(*, sysfs_root: str = "/") -> str | None:
    """v2 key hex, or None on any error. Never raises — for UI fallbacks."""
    try:
        return compute_result(sysfs_root=sysfs_root, module=None).v2
    except Exception:
        return None
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Lint/type, then commit**

Run: `ruff check xinas_menu && ruff format --check xinas_menu && pyright xinas_menu/utils/hwkey.py`
Expected: clean. (If `ruff format --check` flags the file, run `ruff format xinas_menu/utils/hwkey.py` and re-check.)

```bash
git add xinas_menu/utils/hwkey.py tests/test_hwkey_algorithm.py
git commit -m "feat(hwkey): read DMI from sysfs and aggregate v2/legacy/module result"
```

---

### Task 3: Root `hwkey` executable (drop-in) + remove the ELF binary

**Files:**
- Replace: `hwkey` (repo root — delete ELF, create Python executable, mode 0755)
- Test: `tests/test_hwkey_algorithm.py`

**Interfaces:**
- Consumes: the shared library, loaded **by file path** (`xinas_menu/utils/hwkey.py` relative to the executable), so the `xinas_menu` package `__init__` is never executed and no third-party import is triggered.
- Produces (CLI contract): bare v2 key by default; `--details`/`-v`, `--json`, `--legacy`, `--self-test`, `--sysfs-root DIR`, `--module NAME`.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_hwkey_algorithm.py
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
HWKEY = REPO / "hwkey"


def test_executable_default_prints_bare_v2(tmp_path):
    _fake_dmi(tmp_path)
    out = subprocess.run(
        [sys.executable, str(HWKEY), "--sysfs-root", str(tmp_path)],
        capture_output=True, text=True, check=True,
    )
    assert out.stdout.strip() == "D5E37EE32F065F31"
    assert out.stdout.endswith("\n")


def test_executable_legacy_flag(tmp_path):
    _fake_dmi(tmp_path)
    out = subprocess.run(
        [sys.executable, str(HWKEY), "--legacy", "--sysfs-root", str(tmp_path)],
        capture_output=True, text=True, check=True,
    )
    assert out.stdout.strip() == "B0D44633EF11F8F2"


def test_executable_json_flag(tmp_path):
    _fake_dmi(tmp_path, module_key="D5E37EE32F065F31")
    out = subprocess.run(
        [sys.executable, str(HWKEY), "--json", "--sysfs-root", str(tmp_path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    assert data["hwkey"] == "D5E37EE32F065F31"
    assert data["hwkey_legacy"] == "B0D44633EF11F8F2"
    assert data["module_matches"] is True


def test_executable_self_test_passes():
    out = subprocess.run(
        [sys.executable, str(HWKEY), "--self-test"],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stdout + out.stderr


def test_executable_is_not_an_elf_binary():
    # Drop-in must be a text script, not the old committed ELF.
    assert HWKEY.read_bytes()[:4] != b"\x7fELF"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_hwkey_algorithm.py -k executable -v`
Expected: FAIL — the current `hwkey` is still the ELF (`test_executable_is_not_an_elf_binary` fails; the subprocess ones error because ELF ignores `--sysfs-root`).

- [ ] **Step 3: Remove the ELF and create the executable**

```bash
git rm hwkey
```

```python
# hwkey  (repo root, mode 0755)
#!/usr/bin/env python3
"""xiRAID hardware-key generator (drop-in for the legacy ./hwkey binary).

Default output is the bare v2 key on stdout, which is what the Ansible common
role and the installer menus consume. The algorithm lives in
xinas_menu/utils/hwkey.py; this file loads it by path so it never needs the
TUI's third-party dependencies. See docs/Installer/hwkey-spec.md.
"""

import argparse
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(_HERE, "xinas_menu", "utils", "hwkey.py")


def _load_lib():
    spec = importlib.util.spec_from_file_location("_xinas_hwkey_lib", _LIB)
    if spec is None or spec.loader is None:
        sys.stderr.write(f"error: cannot load hwkey library at {_LIB}\n")
        raise SystemExit(2)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv=None):
    hk = _load_lib()
    p = argparse.ArgumentParser(
        prog="hwkey",
        description="Generate the xiRAID (>=4.4) hardware key from SMBIOS/DMI.",
    )
    p.add_argument("--details", "-v", action="store_true", help="human-readable block")
    p.add_argument("--json", action="store_true", help="emit a JSON object")
    p.add_argument("--legacy", action="store_true", help="print the legacy key instead of v2")
    p.add_argument("--self-test", action="store_true", help="verify against golden vectors")
    p.add_argument("--module", default=hk.DEFAULT_MODULE, help="module name to cross-check")
    p.add_argument("--sysfs-root", default="/", help="root under which /sys lives (testing)")
    args = p.parse_args(argv)

    if args.self_test:
        bad = 0
        for ps, uu, bs, v2, legacy in hk.GOLDEN_VECTORS:
            if hk.format_hwkey(hk.compute_hwkey(ps, uu, bs)) != v2 or \
               hk.format_hwkey(hk.compute_hwkey(ps, uu, bs, legacy=True)) != legacy:
                bad += 1
        n = len(hk.GOLDEN_VECTORS)
        print(f"self-test: {n - bad}/{n} vectors passed")
        return 1 if bad else 0

    try:
        r = hk.compute_result(sysfs_root=args.sysfs_root, module=args.module)
    except hk.HwkeyError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    if args.json:
        print(json.dumps({
            "hwkey": r.v2, "hwkey_legacy": r.legacy, "dmi": r.dmi,
            "dmi_present": r.present, "module_hwkey": r.module_hwkey,
            "module_matches": r.module_matches,
        }, indent=2, sort_keys=True))
        return 0

    if args.details:
        print("xiRAID hardware key")
        print(f"  hwkey (v2, use this for licensing) : {r.v2}")
        print(f"  hwkey_legacy (pre-4.4 / hwkey3f)   : {r.legacy}")
        print(f"  product_serial : {r.dmi['product_serial']}")
        print(f"  product_uuid   : {r.dmi['product_uuid']}")
        print(f"  board_serial   : {r.dmi['board_serial']}")
        if r.module_hwkey is not None:
            status = "MATCH" if r.module_matches else "MISMATCH"
            print(f"  live module ({args.module}) : {r.module_hwkey}  [{status}]")
        absent = [n for n, ok in r.present.items() if not ok]
        if absent:
            print(f"  WARNING: absent DMI fields hashed as \"(null)\": {', '.join(sorted(absent))}")
        return 0

    print(r.legacy if args.legacy else r.v2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

```bash
chmod 0755 hwkey
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: PASS (all tests, including the executable group).

Sanity-check the drop-in against a fake tree by hand:
Run: `mkdir -p /tmp/fk/sys/class/dmi/id && printf 'SN12345\n' >/tmp/fk/sys/class/dmi/id/product_serial && printf 'x\n' >/tmp/fk/sys/class/dmi/id/product_uuid && printf 'BOARDXYZ\n' >/tmp/fk/sys/class/dmi/id/board_serial && ./hwkey --sysfs-root /tmp/fk`
Expected: `D5E37EE32F065F31`

- [ ] **Step 5: Commit**

```bash
git add hwkey tests/test_hwkey_algorithm.py
git commit -m "feat(hwkey): replace opaque ELF with source-controlled drop-in tool"
```

---

### Task 4: TUI local-compute fallback in the license screen

**Files:**
- Modify: `xinas_menu/screens/license.py` (the hwkey-fetch block, ~lines 83–103)
- Test: `tests/test_hwkey_algorithm.py`

**Interfaces:**
- Consumes: `best_effort_v2_hwkey` (Task 2).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_hwkey_algorithm.py
def test_license_screen_imports_local_fallback():
    """license.py must wire the local-compute fallback so a pre-install
    license entry (module not loaded) still shows a hardware key instead of
    the '(unavailable)' dead-end. We assert on the source to avoid needing
    Textual installed in the unit env (the screen is CI-covered)."""
    src = (REPO / "xinas_menu" / "screens" / "license.py").read_text()
    assert "best_effort_v2_hwkey" in src, "license.py must use the local hwkey fallback"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_hwkey_algorithm.py::test_license_screen_imports_local_fallback -v`
Expected: FAIL — `best_effort_v2_hwkey` not referenced in `license.py`.

- [ ] **Step 3: Wire the fallback**

In `xinas_menu/screens/license.py`, add the import near the other utils imports:

```python
from xinas_menu.utils.hwkey import best_effort_v2_hwkey
```

Then, in the hwkey-fetch block, after the gRPC attempt (the existing
`hwkey = str(data.get("hwkey") or "").strip()` path), replace the
`if hwkey:` / `else:` prompt construction with a local fallback in between:

```python
        # gRPC gives the live module key. Before install (module not loaded)
        # it is empty; fall back to computing the key locally from DMI so the
        # operator can still copy it when requesting a license.
        computed_locally = False
        if not hwkey:
            local = best_effort_v2_hwkey()
            if local:
                hwkey = local
                computed_locally = True

        if hwkey:
            suffix = " (computed locally)" if computed_locally else ""
            prompt = (
                f"HW key: {hwkey}{suffix}\n(Press Ctrl+Y to copy HW key)\n\n"
                "Paste the license text below:"
            )
        else:
            prompt = "HW key: (unavailable)\n\nPaste the license text below:"
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_hwkey_algorithm.py -v`
Expected: PASS.

Also confirm nothing else broke and the change is import-clean:
Run: `ruff check xinas_menu && ruff format --check xinas_menu && pyright xinas_menu/screens/license.py xinas_menu/utils/hwkey.py`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add xinas_menu/screens/license.py tests/test_hwkey_algorithm.py
git commit -m "feat(hwkey): compute hwkey locally in the TUI when the module is not loaded"
```

---

### Task 5: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the targeted suite + the existing guard**

Run: `pytest tests/test_hwkey_algorithm.py tests/test_hwkey_guard.py -v`
Expected: all PASS (the guard still passes — the menus still call `./hwkey`, which now succeeds).

- [ ] **Step 2: Run the CI-mirrored lint/type/format on the exact paths**

Run:
```bash
ruff check          xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check xinas_menu xinas_history xiNAS-MCP/nfs-helper
pyright             xinas_menu xinas_history xiNAS-MCP/nfs-helper
```
Expected: clean. Fix any finding in `xinas_menu/utils/hwkey.py` or `license.py` and re-run.

- [ ] **Step 3: Confirm the drop-in contract end-to-end**

Run: `file hwkey && head -1 hwkey && test -x hwkey && echo "executable OK"`
Expected: `hwkey` is a Python script (`#!/usr/bin/env python3`), executable bit set, no longer an ELF.

- [ ] **Step 4: Report results**

Summarize: tests passing, lint/type clean, ELF removed, drop-in verified. Do not claim done until every command above has actually run and passed.

## Self-Review (author check)

- **Spec coverage:** §2 algorithm → Task 1. §2.2 DMI/sysfs → Task 2. §3.1 library surface → Tasks 1–2. §3.2 executable CLI → Task 3. §4 installer (unchanged) → verified in Task 5 (guard test). §5 TUI fallback → Task 4. §6 testing → Tasks 1–4 + Task 5. §7 non-goals → nothing to build. All covered.
- **Placeholder scan:** none — every code step carries real, validated code.
- **Type consistency:** `compute_hwkey(bytes, bytes, bytes, *, legacy)->int`, `format_hwkey(int)->str`, `compute_result(...)->HwkeyResult`, `best_effort_v2_hwkey(...)->str|None`, `read_dmi_field(...)->DmiField`, `read_module_hwkey(...)->str|None` — names/signatures identical across Tasks 1–4 and the executable.
