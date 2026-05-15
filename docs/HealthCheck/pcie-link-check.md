# PCIe Link Speed/Width Check — Minispec

Detects ConnectX (or any `mlx5_core`-bound) NICs that have trained their PCIe
link below the card's advertised capability. The motivating case is a card
seated in a slot whose effective PCIe generation is lower than the card
supports — e.g. a Gen5-capable ConnectX-7 (`32 GT/s, x16`) running at Gen4
(`16 GT/s, x16`) because of a slot mis-population, BIOS override, riser, or
contact issue:

```
10:00.0: (mlx5_0)
  LnkCap: Speed 32GT/s, Width x16
  LnkSta: Speed 16GT/s (downgraded), Width x16   ← FAIL
b4:00.0: (mlx5_1)
  LnkCap: Speed 32GT/s, Width x16
  LnkSta: Speed 32GT/s, Width x16                ← PASS
```

Each downgraded generation roughly halves bandwidth; a width downgrade scales
linearly. On a high-throughput NAS this silently caps NFS-RDMA performance,
so the health check should flag it loudly.

## Scope

- **Surface:** Python health engine (`xinas_menu/health/engine.py`). Consumed
  by both the Textual TUI health screen and the MCP `health.run_check` tool
  (which subprocess-invokes the same engine per
  `docs/MCP/spec-tools.md`).
- **Devices covered:** Physical Functions bound to the `mlx5_core` driver
  (i.e. all ConnectX-4/5/6/7 NICs). SR-IOV Virtual Functions are skipped
  because they inherit their parent's link and would double-report.
- **Out of scope:** non-Mellanox NICs (could be added later by widening the
  enumeration), NVMe PCIe link checks (separate concern, `nvme_health`).

## Data sources

100% kernel sysfs, no `lspci` dependency:

| sysfs attribute | Example value | Source of truth |
|-----------------|---------------|-----------------|
| `/sys/bus/pci/drivers/mlx5_core/<addr>` | symlink to device dir | enumerates mlx5 NICs |
| `/sys/bus/pci/devices/<addr>/current_link_speed` | `16.0 GT/s PCIe` | live PCIe speed |
| `/sys/bus/pci/devices/<addr>/current_link_width` | `16` | live PCIe lane count |
| `/sys/bus/pci/devices/<addr>/max_link_speed` | `32.0 GT/s PCIe` | card capability |
| `/sys/bus/pci/devices/<addr>/max_link_width` | `16` | card capability |
| `/sys/bus/pci/devices/<addr>/infiniband/` | `mlx5_0`, `mlx5_1`, … | friendly label |
| `/sys/bus/pci/devices/<addr>/net/` | `enp16s0f0np0`, … | friendly label |

`current_link_speed` strings map to PCIe generations:

| GT/s | Generation |
|------|------------|
| 2.5  | Gen1 |
| 5.0  | Gen2 |
| 8.0  | Gen3 |
| 16.0 | Gen4 |
| 32.0 | Gen5 |
| 64.0 | Gen6 |

## Check semantics

For each enumerated mlx5 PCI device:

| Condition | Status | Rationale |
|-----------|--------|-----------|
| `current_width < max_width` | **FAIL** | Lane downgrade — bandwidth capped linearly. Reseat / check slot bifurcation. |
| `max_gen - current_gen >= 2` | **FAIL** | Two or more generations down — likely BIOS lane speed override or a much older slot than the card needs. |
| `max_gen - current_gen == 1` | **WARN** | One generation down — usually BIOS / slot mismatch; ~50% bandwidth loss. |
| `current == max` | **PASS** | Link trained at full capability. |
| Any sysfs attribute missing / unparseable | **SKIP** | Older kernel, virtualised host, or partial driver bind. |
| No `mlx5_core` PCI devices present | **SKIP** | Not an mlx5 host. |

The report label includes the IB device name (`mlx5_0`) and PCI bus address
(`0000:10:00.0`) so the user can correlate with their lspci output and
identify the physical card / slot.

### Example output rows

```
[FAIL] Network/pcie_link (mlx5_0 → enp16s0f0np0 @ 0000:10:00.0)
       actual:   Gen4 16.0 GT/s x16
       expected: Gen5 32.0 GT/s x16
       impact:   PCIe link trained one generation below capability …
       fix:      Check BIOS PCIe slot speed override; verify slot supports
                 the card's max generation; reseat the card and recheck.

[PASS] Network/pcie_link (mlx5_1 → enp180s0f0np0 @ 0000:b4:00.0)
       actual:   Gen5 32.0 GT/s x16
       expected: Gen5 32.0 GT/s x16
```

## Profile wiring

`pcie_link` is a new check name under the existing `network` section so it
inherits all the section-enable plumbing. Defaults:

| Profile | `pcie_link` enabled? | Reason |
|---------|----------------------|--------|
| `quick`    | yes | Cheap (sysfs reads only), and a downgraded PCIe link is exactly the kind of "silent cap on the whole box" finding the quick profile should catch. |
| `standard` | yes | |
| `deep`     | yes | |

No new `expectations:` keys are needed — the expected value is data-driven
(each card reports its own `max_link_speed` / `max_link_width`). A future
extension could add a `pcie_min_gen` override for sites that intentionally
underclock slots, but YAGNI for now.

## Implementation plan

1. `xinas_menu/health/engine.py`
   - Add `get_mlx_pci_devices()` helper that walks
     `/sys/bus/pci/drivers/mlx5_core/`, filters to PFs (those exposing an
     `infiniband/` directory), and returns `[(pci_addr, friendly_label), …]`.
   - Add `_parse_pcie_speed()` and `_PCIE_GEN_GTS` lookup.
   - Add `check_pcie_link(exp, checks)` and dispatch it inside
     `check_network()` when `"pcie_link" in checks`.
2. `healthcheck_profiles/{quick,standard,deep}.yml`
   - Append `pcie_link` to the `network` section's `checks` list.
3. `docs/healthcheck-tunables/linux-perf.md`
   - Add a "PCIe link" row to the Network table referencing this minispec.

No MCP-side TypeScript changes: `health.run_check` already subprocesses the
Python engine and returns whatever rows it produces.

## Risk / non-goals

- **Spurious WARN on ASPM-capable slots.** If a slot ever enters L1 ASPM
  with `current_link_speed` reporting the low-power speed, we could WARN
  falsely. Mitigation: NAS perf-tuning role already disables ASPM in
  practice; we accept the rare edge case.
- **Cards not bound to `mlx5_core`.** Bnxt, ice, mlx4 NICs are not covered.
  Acceptable for now (xiNAS targets ConnectX). Easy to extend.
- **No remediation action automation.** Fix requires physical reseat / BIOS
  change, so we surface a hint and leave it to the operator — no remediation
  wizard entry.
