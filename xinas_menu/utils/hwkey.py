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

import os
from dataclasses import dataclass

GOLDEN_RATIO_64 = 0x61C8864680B583EB
_MASK64 = (1 << 64) - 1
_PAGE_SIZE = 4096
_WORDS = _PAGE_SIZE // 8  # 512
_UUID_STRING_LEN = 36
NULL_SUBSTITUTE = b"(null)"  # kernel snprintf("%s", NULL)

# DMI field names, in the kernel's concatenation order.
DMI_PRODUCT_SERIAL = "product_serial"
DMI_PRODUCT_UUID = "product_uuid"
DMI_BOARD_SERIAL = "board_serial"
DEFAULT_MODULE = "xiraid"


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
    return f"{key:08X}"


# Validated against the C oracle; absent fields shown as the literal b"(null)".
GOLDEN_VECTORS: list[tuple[bytes, bytes, bytes, str, str]] = [
    (
        b"SN12345",
        b"550e8400-e29b-41d4-a716-446655440000",
        b"BOARDXYZ",
        "D5E37EE32F065F31",
        "B0D44633EF11F8F2",
    ),
    (b"A", b"DEADBEEF-0000-1111-2222-333344445555", b"B", "868845157A1914AB", "48FE908EC7902EC"),
    (
        b"seven77",
        b"ABCDEF01-2345-6789-ABCD-EF0123456789",
        b"boardserial-longer-than-eight",
        "D3850A20BAA471F9",
        "6E7567410166FD4F",
    ),
    (b"", b"00000000-0000-0000-0000-000000000000", b"", "00000000", "6B949A616B13CC10"),
    (NULL_SUBSTITUTE, NULL_SUBSTITUTE, NULL_SUBSTITUTE, "32389975897296B8", "6C21692ED7C6DC9C"),
    (
        b"To Be Filled By O.E.M.",
        b"12345678-90AB-CDEF-1234-567890ABCDEF",
        b"To Be Filled By O.E.M.",
        "E35A8EA7DFA8162E",
        "265219800E1ACCB6",
    ),
]


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
    except (OSError, ValueError):
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
