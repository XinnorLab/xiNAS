# xiRAID Hardware-Key Tool (`hwkey`) — Specification

Status: design accepted 2026-08-14. Owns the contract for the `hwkey`
executable that xiNAS runs to obtain the machine's xiRAID hardware key, plus
the shared library the Python TUI imports for the same computation.

## 1. Why this exists

xiRAID licensing binds a license to a **hardware key** derived from the host's
SMBIOS/DMI identifiers. To request a license, the operator must read that key
off the machine. xiNAS surfaces it at install time (installer menus + the
`common` role) and during day-2 license entry (Python TUI).

Historically xiNAS shipped an **opaque, checked-in ELF binary** at repo root
(`hwkey`, uploaded 2025-06-10, no source in the tree). Two problems:

1. **No source.** Nobody can audit or fix what it computes; it cannot be
   linted, tested, or ported.
2. **Stale for xiRAID 4.4.** xiRAID 4.4 introduced a **new hardware-key scheme
   ("v2")** and the binary was never updated when xiNAS moved to xiRAID 4.4
   (commit `46399ff`). A pre-4.4 key does not match what a new 4.4 license is
   issued against.

This spec replaces that binary with a **source-controlled, dependency-free tool**
that computes the correct 4.4 key, as a **drop-in at the same path** so the
installer, menus, and their guard tests keep working unchanged.

## 2. The algorithm (reproduced from xiRAID 4.4.1)

Source of truth: xiRAID `module/xrd_license.c` (`rdx_license_init_hwkey`,
`rdx_license_hash_buf64`) and `module/xrd_hash.h` (`rdx_hash_64`). The kernel
computes **two** keys at module load and accepts a license bound to **either**
(`rdx_license_check_hwkey`):

| Key | Scheme | DMI inputs (in order, concatenated, no separator) |
|-----|--------|---------------------------------------------------|
| **v2** (`hwkey`) | `RDX_HWKEY_V2_SERIALS` | `product_serial` + `board_serial` |
| **legacy** (`hwkey3f`) | `RDX_HWKEY_LEGACY_UUID` | `product_serial` + `lower(product_uuid)` + `board_serial` |

On xiRAID 4.4, new licenses target **v2**; legacy exists only for pre-4.4
license continuity.

### 2.1 Steps

1. Zero-fill a 4096-byte buffer.
2. Write the DMI fields, in order, as bytes at the front — no separators (the
   kernel's successive `snprintf` calls overwrite each other's NUL terminator).
   The UUID (legacy only) is truncated to 36 chars and ASCII-lowercased.
3. A DMI field the firmware does not provide is substituted with the **literal
   six bytes `(null)`** — this mirrors the kernel's `snprintf("%s", NULL)`.
4. Read the buffer as **512 little-endian `u64` words** (x86-64).
5. Fold to a `u64`:

   ```
   GOLDEN = 0x61C8864680B583EB          # golden-ratio 64
   key = 0
   for i in 0..511:
       h = (word[i] * GOLDEN) mod 2^64  # rdx_hash_64(word, 64)
       key ^= h                if i even
       key ^= (h << 32) mod 2^64  if i odd
   ```

   Zero (padding) words contribute nothing, so only the DMI bytes matter.
6. Render as **uppercase hex, zero-padded to a minimum width of 8**
   (`"%08X"`, up to 16 digits) — the string the operator submits.

### 2.2 DMI ↔ sysfs equivalence

`dmi_get_system_info()` is mirrored byte-for-byte by the kernel dmi-id class at
`/sys/class/dmi/id/<field>` (the file is the DMI value plus one trailing `\n`):

| DMI field | sysfs path |
|-----------|------------|
| `DMI_PRODUCT_SERIAL` | `/sys/class/dmi/id/product_serial` |
| `DMI_PRODUCT_UUID`   | `/sys/class/dmi/id/product_uuid` |
| `DMI_BOARD_SERIAL`   | `/sys/class/dmi/id/board_serial` |

Rules the tool MUST follow to stay byte-identical to the module:

- Strip exactly one trailing `\n`; preserve everything else (trailing spaces in
  DMI strings are significant).
- **File absent ⇒ field is `NULL`** (the dmi-id driver only creates an
  attribute when the DMI value is non-NULL) ⇒ substitute `(null)`.
- These serial files are mode `0400`: the tool MUST run as **root**. A
  permission error is fatal (exit non-zero), never silently treated as `(null)`
  — that would emit a wrong key. Only `ENOENT` maps to `(null)`.
- Prefer sysfs over `dmidecode` (which can reorder the UUID / reformat
  whitespace). The v2 key does not use the UUID at all, so UUID quirks never
  affect it.

Validation: an independent C transcription of the kernel functions was used as
an oracle; the Python implementation matches it byte-for-byte on vectors
covering normal input, empty fields, `(null)` substitution, non-8-aligned
lengths, and "To Be Filled By O.E.M." whitebox strings. Those vectors ship as
the tool's `--self-test` fixtures.

## 3. Components

Two artifacts, one implementation of the algorithm:

### 3.1 Shared library — `xinas_menu/utils/hwkey.py`

Pure standard-library, Python ≥3.10, no third-party imports (so it is safe to
import at any install stage). Public surface:

- `compute_hwkey(product_serial: bytes, product_uuid: bytes, board_serial: bytes, *, legacy: bool = False) -> int`
- `format_hwkey(key: int) -> str` — `"%08X"` semantics.
- `read_dmi_field(name: str, *, sysfs_root: str = "/") -> DmiField` — raises
  `HwkeyError` on permission denied; `present=False`/`(null)` on ENOENT.
- `read_module_hwkey(module: str = "xiraid", *, sysfs_root: str = "/") -> str | None`
  — reads the live key from `/sys/module/<module>/parameters/hwkey`.
- `compute_result(*, sysfs_root: str = "/", module: str | None = "xiraid") -> HwkeyResult`
  — dataclass with `v2`, `legacy`, the DMI values used, presence flags, and (if
  available) the live-module key and a match flag.
- `HwkeyError` (exception), `GOLDEN_VECTORS` (self-test fixtures).

This module is linted (`ruff`) and type-checked (`pyright`) by CI along with the
rest of `xinas_menu`.

### 3.2 Executable — `hwkey` (repo root)

`#!/usr/bin/env python3`, mode `0755`, replaces the ELF at the same path. It
loads the shared library **directly from its file path** (not via the
`xinas_menu` package) so it never depends on the TUI's third-party packages,
which are installed later than the `common` role.

CLI contract:

| Invocation | Output |
|------------|--------|
| `./hwkey` (no args) | The **v2** key only, uppercase, one line + `\n`. **This is the drop-in contract** the `common` role and menus depend on. |
| `./hwkey --details` / `-v` | Human block: v2, legacy, DMI values used, live-module cross-check, warnings for absent fields. |
| `./hwkey --json` | JSON object (v2, legacy, dmi, presence, module match). |
| `./hwkey --legacy` | The **legacy** key only (bare), for pre-4.4 licenses. |
| `./hwkey --self-test` | Verify the algorithm against the golden vectors; exit 1 on mismatch. |
| `--sysfs-root DIR` | Treat `DIR` as `/` (testing / rescue). |
| `--module NAME` | Module name for the cross-check (default `xiraid`). |

Exit codes: `0` success; `1` self-test failure; `2` error (e.g. not root). On a
hard read failure the default path exits non-zero and prints nothing to stdout,
so the `common` role's `rc == 0` guard falls through to the cached key and the
menus render `unavailable` (see §4).

## 4. Installer integration (unchanged call sites)

The drop-in keeps every existing caller working with **no code change**:

- `collection/roles/common/tasks/main.yml` — runs `./hwkey`, caches stdout to
  `keys/hwkey` when `rc == 0` and output is non-empty, else falls back to the
  cache. Behavior preserved; the cached value is now the v2 key.
- `simple_menu.sh` / `startup_menu.sh` — `hwkey_val=$(./hwkey | tr -d '\n' | tr
  '[:lower:]' '[:upper:]')`, displayed as `HWKEY: ${hwkey_val:-unavailable}`.
  The tool already prints uppercase; the guard in `tests/test_hwkey_guard.py`
  (survives missing/failing `./hwkey`, never renders a blank) stays valid.
- Other installer/config scripts rely on the same bare-key contract. Two read
  `./hwkey` stdout directly — `configure_hostname.sh` (`hw=$(./hwkey | tr …)`)
  and `collect_data.sh` (`./hwkey > "$tmp/hwkey.txt"`). Two only ensure the
  executable bit (`[ -x ./hwkey ] || chmod +x ./hwkey`) before a downstream
  consumer reads it — `prepare_system.sh` and `autoinstall.sh`, which hand off
  to the menu scripts / the `common` role above.

No `Requires-Rebuild:` trailer: this is a code/tool + Python change consumed at
install time; it installs nothing, touches no unit/sysctl/package. (The `common`
role's hwkey step only runs on a fresh install, `xinas_hostname | length == 0`.)

## 5. TUI integration (second surface)

- `xinas_menu/screens/license.py` reads the **live** key from the loaded module
  via gRPC `license_show()["hwkey"]` (the v2 key on 4.4). When that is
  unavailable — module not loaded yet, or gRPC down, i.e. the common pre-install
  license-entry case — it now **falls back to computing the key locally** via
  `xinas_menu.utils.hwkey.best_effort_v2_hwkey()` (the never-raising wrapper
  around `compute_result()`, so a DMI read error can never crash the screen),
  labeling it so the operator knows it was computed, not read from the module.
  This removes the bare "(unavailable)" dead-end.
- `xinas_menu/screens/collect_logs.py` continues to shell out to the `hwkey`
  executable for the diagnostics bundle; it now captures a real v2 key. It MAY
  additionally capture `--details` output for support.

## 6. Testing

- `tests/test_hwkey_algorithm.py` (new) — drives the golden vectors through the
  shared library (`compute_hwkey`/`format_hwkey`), and exercises
  `read_dmi_field`/`compute_result` against a fake `--sysfs-root` tree,
  including the `(null)` (ENOENT) path and the permission-error path.
- A test that the root `hwkey` executable, run against a fake `--sysfs-root`,
  prints a bare uppercase-hex v2 key on stdout and matches the vector.
- `tests/test_hwkey_guard.py` (existing) — kept as-is; the menus still call
  `./hwkey` and must still survive its absence/failure.

## 7. Non-goals

- The tool derives the hardware-key **input** only. It does not, and cannot,
  generate or verify the RSA-signed license blob — that stays with Xinnor
  (`rdx_akcrypto_sign_ver`, `RDX_RSA_VERIFY`).
- x86-64 only, matching xiRAID's shipping target (the fold hash is
  little-endian).
- License enforcement (disk count, RAID level, expiry, per-disk size groups)
  lives entirely in the kernel module and is out of scope here.
